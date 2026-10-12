import { randomUUID } from 'node:crypto';
import { validateContract, isErrorCode } from '@localqa/contracts';
import {
  createGateway,
  estimateTokens,
  type ProviderAdapter,
  type GatewayProfile,
  type CallInput,
  type CallRecord,
} from '@localqa/model-gateway';
import {
  renderPrompt,
  renderAssertionPrompt,
  DECISION_SCHEMA,
  toolSchemasForRole,
  type AgentRole,
} from '@localqa/agents';
import type { Criterion, ModelRequest, RoleModels } from '@localqa/contracts';
import {
  StorageError,
  type WorkerScope,
  type LeaseProof,
} from '@localqa/storage';
import type { Coordinator } from './core.js';

export type AgentRoleName = CallInput['role'];
export interface ModelOptions {
  adapter: ProviderAdapter;
  /** Selects a wire protocol from the persisted, frozen model profile. */
  adapterForKind?: (kind: GatewayProfile['kind']) => ProviderAdapter;
  allowTestStub?: boolean;
  profile: (id: string, version: number) => Promise<GatewayProfile>;
  decryptKey: (id: string, ciphertext: string) => string;
  /**
   * Reads one image whose row was already limited to this project, run, and task.
   * Absent means an image cannot be approved.
   */
  readApprovedImage?: (input: {
    projectId: string;
    runId: string;
    artifactId: string;
    sha256: string;
    byteLength: number;
  }) => Promise<{ mediaType: 'image/png' | 'image/jpeg'; bytes: Uint8Array }>;
}
export type DecisionPayload = Pick<
  CallInput,
  'purpose' | 'messages' | 'outputSchema' | 'maxOutputTokens'
>;

export function modelCallTimeoutMs(
  purpose: DecisionPayload['purpose'],
): number {
  return purpose === 'plan' || purpose === 'summarize' ? 120000 : 60000;
}
export function roleToolSchemas(
  role: AgentRoleName,
): { name: string; parameters: Record<string, unknown> }[] {
  if (role === 'assertion') return [];
  return toolSchemasForRole(role as AgentRole);
}

const ALLOWED: Record<string, readonly AgentRoleName[]> = {
  coordinator: ['coordinator', 'planner'],
  explorer: ['explorer'],
  executor: ['executor', 'assertion'],
  reproducer: ['reproducer', 'assertion'],
  finalizer: ['finalizer'],
};

/** Lease job role plus purpose selects one frozen binding. Assertion is its own binding. */
export function frozenModelSelection(
  jobRole: string,
  purpose: DecisionPayload['purpose'],
): { role: AgentRoleName; binding: keyof RoleModels } {
  if (purpose === 'assert') {
    if (jobRole !== 'executor' && jobRole !== 'reproducer')
      throw new StorageError('FORBIDDEN');
    return { role: 'assertion', binding: 'assertion' };
  }
  if (purpose === 'plan') {
    if (jobRole !== 'coordinator') throw new StorageError('FORBIDDEN');
    return { role: 'planner', binding: 'coordinator' };
  }
  if (purpose === 'summarize') {
    if (jobRole !== 'finalizer') throw new StorageError('FORBIDDEN');
    return { role: 'finalizer', binding: 'coordinator' };
  }
  if (purpose !== 'decide') throw new StorageError('VALIDATION_ERROR');
  if (jobRole === 'coordinator')
    return { role: 'coordinator', binding: 'coordinator' };
  if (jobRole === 'explorer') return { role: 'explorer', binding: 'explorer' };
  if (jobRole === 'executor') return { role: 'executor', binding: 'executor' };
  if (jobRole === 'reproducer')
    return { role: 'reproducer', binding: 'reproducer' };
  throw new StorageError('FORBIDDEN');
}
/** Stored fields only. Extra document keys are dropped; messages are not a source. */
function canonicalCriterion(value: unknown): Criterion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const candidate: Record<string, unknown> = {
    id: row['id'],
    kind: row['kind'],
    description: row['description'],
    sourceKind: row['sourceKind'],
    sourceRef: row['sourceRef'],
  };
  if (row['locator'] !== undefined) candidate['locator'] = row['locator'];
  if (row['expectedValue'] !== undefined)
    candidate['expectedValue'] = row['expectedValue'];
  const checked = validateContract('Criterion', candidate);
  return checked.success ? checked.data : null;
}

const IMAGE_BYTE_LIMIT = 25 * 1024 * 1024;

interface ApprovedImageClaim {
  id: string;
  sha256: string;
  byteLength: number;
}

interface FrozenCall {
  profile: GatewayProfile;
  evidence: string[];
  criterion: Criterion | null;
  role: AgentRoleName;
  runId: string;
  images: ApprovedImageClaim[];
}

function imageArtifactIds(
  messages: readonly {
    content: readonly { type: string; artifactId?: string }[];
  }[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== 'image' || typeof part.artifactId !== 'string')
        continue;
      if (seen.has(part.artifactId)) continue;
      seen.add(part.artifactId);
      ids.push(part.artifactId);
    }
  }
  return ids;
}

export class BoundModel {
  constructor(
    private coordinator: Coordinator,
    private scope: WorkerScope,
    private options: ModelOptions,
  ) {}

  /**
   * Lease, grant, and model_requests wrapper shared by worker decisions and HTTP complete.
   * criterionId is legal only for purpose assert. It must match a criterion on the current
   * lease job's frozen RunCase in this project. Messages are not an id source.
   */
  private async loadFrozen(
    proof: LeaseProof,
    purpose: DecisionPayload['purpose'],
    expectedRole?: AgentRoleName,
    criterionId?: string,
    requestedProfileId?: string,
    messages: readonly {
      content: readonly { type: string; artifactId?: string }[];
    }[] = [],
  ): Promise<FrozenCall> {
    return this.coordinator.tx(async (client) => {
      const { job, run } = await this.coordinator.validateLease(
        client,
        this.scope,
        proof,
      );
      if (expectedRole && !ALLOWED[job.role]?.includes(expectedRole))
        throw new StorageError('FORBIDDEN');
      const selected = frozenModelSelection(job.role, purpose);
      if (expectedRole && selected.role !== expectedRole)
        throw new StorageError('FORBIDDEN');
      if (!expectedRole && !ALLOWED[job.role]?.includes(selected.role))
        throw new StorageError('FORBIDDEN');
      const binding = run.effectiveConfig.models[selected.binding];
      if (requestedProfileId && requestedProfileId !== binding.profileId)
        throw new StorageError('MODEL_NOT_CONFIGURED');
      // A requested profile mismatch stays MODEL_NOT_CONFIGURED. After that,
      // criterionId is rejected unless this call is an assert.
      if (purpose !== 'assert' && criterionId !== undefined)
        throw new StorageError('VALIDATION_ERROR');
      if (purpose === 'assert' && !criterionId)
        throw new StorageError('VALIDATION_ERROR');
      const profile = await this.options.profile(
        binding.profileId,
        binding.version,
      );
      if (
        profile.id !== binding.profileId ||
        profile.version !== binding.version
      )
        throw new StorageError('VERSION_CONFLICT');
      const row = (
        await client.query(
          'SELECT v.document FROM model_profile_versions v JOIN model_profile_grants g ON g.profile_id=v.profile_id WHERE v.profile_id=$1 AND v.version=$2 AND g.project_id=$3',
          [binding.profileId, binding.version, this.scope.projectId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      const frozenFormat = row.document.responseFormat ?? 'json_schema';
      if (
        profile.configuredModelId !== row.document.configuredModelId ||
        profile.endpoint !== row.document.endpoint ||
        (profile.responseFormat ?? 'json_schema') !== frozenFormat ||
        (profile.kind === 'stub' && !this.options.allowTestStub) ||
        (profile.kind !== 'stub' &&
          !['ready', 'degraded'].includes(row.document.status))
      )
        throw new StorageError('MODEL_NOT_CONFIGURED');
      let found: Criterion | null = null;
      if (purpose === 'assert') {
        const definition = job.case_id
          ? (
              await client.query(
                'SELECT document FROM run_cases WHERE project_id=$1 AND id=$2 AND frozen',
                [this.scope.projectId, job.case_id],
              )
            ).rows[0]?.document
          : null;
        const criteria = Array.isArray(definition?.criteria)
          ? definition.criteria
          : [];
        const match = criteria.find(
          (item: { id?: string }) => item?.id === criterionId,
        );
        found = canonicalCriterion(match);
        if (!found) throw new StorageError('NOT_FOUND');
      }
      const evidence = (
        await client.query(
          'SELECT id FROM artifacts WHERE project_id=$1 AND task_id=$2',
          [this.scope.projectId, job.id],
        )
      ).rows.map((item: { id: string }) => item.id);
      const imageIds = imageArtifactIds(messages);
      const images: ApprovedImageClaim[] = [];
      if (imageIds.length > 0) {
        if (profile.capabilities.imageInput !== true)
          throw new StorageError('MODEL_CAPABILITY_MISSING');
        if (!this.options.readApprovedImage)
          throw new StorageError('MODEL_NOT_CONFIGURED');
        for (const artifactId of imageIds) {
          const document = (
            await client.query(
              'SELECT document FROM artifacts WHERE project_id=$1 AND run_id=$2 AND task_id=$3 AND id=$4',
              [this.scope.projectId, job.run_id, job.id, artifactId],
            )
          ).rows[0]?.document as Record<string, unknown> | undefined;
          if (!document || document['status'] !== 'available')
            throw new StorageError('NOT_FOUND');
          // The row columns already select this project, run, and task. The
          // stored metadata must name that same scope before hash or disk.
          if (
            document['id'] !== artifactId ||
            document['projectId'] !== this.scope.projectId ||
            document['runId'] !== job.run_id ||
            document['taskId'] !== job.id
          )
            throw new StorageError('NOT_FOUND');
          const redaction = document['redaction'];
          if (redaction !== 'applied' && redaction !== 'not_needed')
            throw new StorageError('VALIDATION_ERROR');
          const byteLength = document['bytes'];
          const sha256 = document['sha256'];
          if (
            typeof byteLength !== 'number' ||
            !Number.isInteger(byteLength) ||
            byteLength < 1 ||
            typeof sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(sha256)
          )
            throw new StorageError('VALIDATION_ERROR');
          if (byteLength > IMAGE_BYTE_LIMIT)
            throw new StorageError('ARTIFACT_TOO_LARGE');
          images.push({
            id: artifactId,
            sha256: sha256.toLowerCase(),
            byteLength,
          });
        }
      }
      return {
        profile,
        evidence,
        criterion: found,
        role: selected.role,
        runId: job.run_id,
        images,
      };
    });
  }

  private async materializeImages(
    bound: FrozenCall,
  ): Promise<
    Map<string, { mediaType: 'image/png' | 'image/jpeg'; bytes: Uint8Array }>
  > {
    const ready = new Map<
      string,
      { mediaType: 'image/png' | 'image/jpeg'; bytes: Uint8Array }
    >();
    if (bound.images.length === 0) return ready;
    const reader = this.options.readApprovedImage;
    if (!reader) throw new StorageError('MODEL_NOT_CONFIGURED');
    for (const image of bound.images) {
      ready.set(
        image.id,
        await reader({
          projectId: this.scope.projectId,
          runId: bound.runId,
          artifactId: image.id,
          sha256: image.sha256,
          byteLength: image.byteLength,
        }),
      );
    }
    return ready;
  }

  private budgetAdapter(
    proof: LeaseProof,
    role: AgentRoleName,
    profile: GatewayProfile,
    budgetDenied: { current: boolean },
    signal?: AbortSignal,
    timeoutMs = modelCallTimeoutMs('decide'),
  ): ProviderAdapter {
    const metadata = new WeakMap<
      object,
      { inputTokens: number; maxOutputTokens: number }
    >();
    const delegate =
      this.options.adapterForKind?.(profile.kind) ?? this.options.adapter;
    const coordinator = this.coordinator;
    const scope = this.scope;
    return {
      kind: delegate.kind,
      version: delegate.version,
      build(input) {
        const built = delegate.build(input);
        if (!built.body || typeof built.body !== 'object')
          throw new StorageError('VALIDATION_ERROR');
        metadata.set(built.body, {
          inputTokens: (estimateTokens(JSON.stringify(input)) ?? 1) + 128,
          maxOutputTokens: input.maxOutputTokens,
        });
        return built;
      },
      async send(input, providerSignal) {
        const meta = metadata.get(input.body as object);
        if (!meta) throw new StorageError('VALIDATION_ERROR');
        const reservation = await coordinator
          .tx(async (client) => {
            const r = await coordinator.reserve(
              client,
              scope,
              proof,
              'model',
              {
                modelCalls: 1,
                totalTokens: meta.inputTokens + meta.maxOutputTokens,
              },
              randomUUID(),
            );
            const { job, run } = await coordinator.validateLease(
              client,
              scope,
              proof,
            );
            await client.query(
              "INSERT INTO model_requests(request_id,project_id,run_id,task_id,fencing_token,reservation_id,status,redacted_diagnostic) VALUES($1,$2,$3,$4,$5,$6,'reserved',$7)",
              [
                r.requestId,
                scope.projectId,
                run.id,
                job.id,
                proof.fencingToken,
                r.id,
                {
                  role,
                  profileId: profile.id,
                  profileVersion: profile.version,
                  configuredModelId: profile.configuredModelId,
                  timeoutMs,
                  usageSource: 'unknown',
                },
              ],
            );
            return r;
          })
          .catch((error) => {
            if (
              error instanceof StorageError &&
              error.code === 'BUDGET_EXCEEDED'
            )
              budgetDenied.current = true;
            throw error;
          });
        const started = Date.now();
        try {
          const response = await delegate.send(
            input,
            signal ? AbortSignal.any([providerSignal, signal]) : providerSignal,
          );
          const validUsage =
            response.usage &&
            Number.isSafeInteger(response.usage.inputTokens) &&
            response.usage.inputTokens >= 0 &&
            Number.isSafeInteger(response.usage.outputTokens) &&
            response.usage.outputTokens >= 0;
          const source = validUsage ? 'reported' : 'estimated';
          const tokens = validUsage
            ? response.usage!.inputTokens + response.usage!.outputTokens
            : meta.inputTokens +
              (estimateTokens(response.raw) ?? meta.maxOutputTokens);
          await coordinator.settle(
            scope,
            proof,
            reservation.id,
            { modelCalls: 1, totalTokens: tokens },
            source,
          );
          await coordinator.tx(async (client) => {
            const alreadyUnknown =
              (
                await client.query(
                  'SELECT status FROM budget_reservations WHERE id=$1 AND project_id=$2',
                  [reservation.id, scope.projectId],
                )
              ).rows[0]?.status === 'unknown';
            await client.query(
              'UPDATE model_requests SET status=$4,redacted_diagnostic=redacted_diagnostic||$2::jsonb WHERE request_id=$1 AND project_id=$3',
              [
                reservation.requestId,
                JSON.stringify({
                  usageSource: alreadyUnknown ? 'unknown' : source,
                  ...(alreadyUnknown ? { lateUsageSource: source } : {}),
                  inputTokens: validUsage
                    ? response.usage!.inputTokens
                    : meta.inputTokens,
                  outputTokens: validUsage
                    ? response.usage!.outputTokens
                    : tokens - meta.inputTokens,
                  configuredModelId: input.model,
                  reportedModelId: response.reportedModelId,
                  httpStatus: response.httpStatus,
                  errorCode: response.errorCode,
                }),
                scope.projectId,
                alreadyUnknown ? 'unknown' : 'settled',
              ],
            );
          });
          return response;
        } catch (error) {
          const errorCode = signal?.aborted
            ? 'CANCELLED'
            : providerSignal.aborted
              ? 'MODEL_TIMEOUT'
              : typeof error === 'object' &&
                  error !== null &&
                  'code' in error &&
                  isErrorCode(error.code)
                ? error.code
                : 'SERVICE_UNAVAILABLE';
          await coordinator
            .settle(scope, proof, reservation.id, reservation.amount, 'unknown')
            .catch(() => {});
          await coordinator
            .tx((client) =>
              client.query(
                "UPDATE model_requests SET status='unknown',redacted_diagnostic=redacted_diagnostic||$2::jsonb WHERE request_id=$1 AND project_id=$3",
                [
                  reservation.requestId,
                  JSON.stringify({
                    errorCode,
                    timeoutMs,
                    latencyMs: Date.now() - started,
                    usageSource: 'unknown',
                  }),
                  scope.projectId,
                ],
              ),
            )
            .catch(() => {});
          throw Object.assign(new Error(errorCode), { code: errorCode });
        }
      },
    };
  }

  private async finish(
    proof: LeaseProof,
    budgetDenied: { current: boolean },
    record: CallRecord,
  ): Promise<CallRecord> {
    if (budgetDenied.current) throw new StorageError('BUDGET_EXCEEDED');
    // Model output cannot dispatch itself; authority is rechecked after the awaited provider.
    await this.coordinator.tx((client) =>
      this.coordinator.validateLease(client, this.scope, proof),
    );
    return record;
  }

  async call(
    proof: LeaseProof,
    role: AgentRoleName,
    payload: DecisionPayload,
    criterionId?: string,
    signal?: AbortSignal,
  ): Promise<CallRecord> {
    const allowed = new Set([
      'purpose',
      'messages',
      'outputSchema',
      'maxOutputTokens',
    ]);
    if (Object.keys(payload).some((key) => !allowed.has(key)))
      throw new StorageError('VALIDATION_ERROR');
    const bound = await this.loadFrozen(
      proof,
      payload.purpose,
      role,
      criterionId,
      undefined,
      payload.messages,
    );
    if (
      !validateContract('ModelRequest', {
        ...payload,
        taskId: proof.taskId,
        profileId: bound.profile.id,
        contextVersion: proof.contextVersion,
      }).success
    )
      throw new StorageError('VALIDATION_ERROR');
    if (
      payload.purpose !==
      (role === 'assertion'
        ? 'assert'
        : role === 'planner'
          ? 'plan'
          : role === 'finalizer'
            ? 'summarize'
            : 'decide')
    )
      throw new StorageError('VALIDATION_ERROR');
    const images = await this.materializeImages(bound);
    const budgetDenied = { current: false };
    const gateway = createGateway({
      rateLimitRetry: { delaysMs: [2000, 4000], ...(signal ? { signal } : {}) },
      profiles: [bound.profile],
      decryptKey: this.options.decryptKey,
      resolveArtifact: (artifactId) => images.get(artifactId) ?? null,
      adapter: this.budgetAdapter(
        proof,
        role,
        bound.profile,
        budgetDenied,
        signal,
        modelCallTimeoutMs(payload.purpose),
      ),
    });
    const prompt =
      role === 'assertion' ? renderAssertionPrompt() : renderPrompt(role);
    const input: CallInput = {
      ...payload,
      taskId: proof.taskId,
      profileId: bound.profile.id,
      contextVersion: proof.contextVersion,
      role,
      promptVersion: prompt.version,
      approvedImageIds: bound.images.map((image) => image.id),
      toolSchemas: roleToolSchemas(role),
      // Longer planning/summaries share one bounded deadline across retries.
      // Lease heartbeats, cancellation and run budgets remain authoritative.
      timeoutMs: modelCallTimeoutMs(payload.purpose),
      // json_object mode appends the *canonical* output schema to the prompt;
      // 4k truncated otherwise valid coordinator/planner inputs before any
      // provider call. Use the gateway's still-bounded 12k input allowance.
      maxInputTokens: 12000,
      knownEvidenceIds: bound.evidence,
      ...(bound.criterion ? { criterion: bound.criterion } : {}),
    };
    const record =
      role === 'assertion'
        ? await gateway.evaluateCriterion(input)
        : await gateway.generateDecision(input);
    return this.finish(proof, budgetDenied, record);
  }

  /** Auth recognition is a read-only schema call, with no model tools. */
  async callAuthRecognition(
    proof: LeaseProof,
    payload: DecisionPayload,
    signal?: AbortSignal,
  ): Promise<CallRecord> {
    await this.coordinator.tx(async (client) => {
      const { job } = await this.coordinator.validateLease(
        client,
        this.scope,
        proof,
      );
      if (job.document.summary !== 'auth' || job.role !== 'executor')
        throw new StorageError('POLICY_DENIED');
    });
    if (
      payload.purpose !== 'decide' ||
      payload.messages.some((message) =>
        message.content.some((part) => part.type !== 'text'),
      )
    )
      throw new StorageError('VALIDATION_ERROR');
    const bound = await this.loadFrozen(
      proof,
      'decide',
      'executor',
      undefined,
      undefined,
      payload.messages,
    );
    if (
      !validateContract('ModelRequest', {
        ...payload,
        taskId: proof.taskId,
        profileId: bound.profile.id,
        contextVersion: proof.contextVersion,
      }).success
    )
      throw new StorageError('VALIDATION_ERROR');
    const budgetDenied = { current: false };
    const gateway = createGateway({
      rateLimitRetry: { delaysMs: [2000, 4000], ...(signal ? { signal } : {}) },
      profiles: [bound.profile],
      decryptKey: this.options.decryptKey,
      adapter: this.budgetAdapter(
        proof,
        'executor',
        bound.profile,
        budgetDenied,
        signal,
      ),
    });
    const record = await gateway.generateDecision({
      ...payload,
      taskId: proof.taskId,
      profileId: bound.profile.id,
      contextVersion: proof.contextVersion,
      role: 'executor',
      promptVersion: 'auth.ai.1',
      approvedImageIds: [],
      toolSchemas: [],
      timeoutMs: modelCallTimeoutMs(payload.purpose),
      maxInputTokens: 12000,
    });
    return this.finish(proof, budgetDenied, record);
  }

  async complete(
    proof: LeaseProof,
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<CallRecord> {
    if (
      request.taskId !== proof.taskId ||
      request.contextVersion !== proof.contextVersion
    )
      throw new StorageError('VALIDATION_ERROR');
    const bound = await this.loadFrozen(
      proof,
      request.purpose,
      undefined,
      request.criterionId,
      request.profileId,
      request.messages,
    );
    const images = await this.materializeImages(bound);
    const budgetDenied = { current: false };
    const gateway = createGateway({
      rateLimitRetry: { delaysMs: [2000, 4000], ...(signal ? { signal } : {}) },
      profiles: [bound.profile],
      decryptKey: this.options.decryptKey,
      resolveArtifact: (artifactId) => images.get(artifactId) ?? null,
      adapter: this.budgetAdapter(
        proof,
        bound.role,
        bound.profile,
        budgetDenied,
        signal,
        modelCallTimeoutMs(request.purpose),
      ),
    });
    const record = await gateway.complete(request, {
      role: bound.role,
      promptVersion: '1.0',
      approvedImageIds: bound.images.map((image) => image.id),
      toolSchemas: roleToolSchemas(bound.role),
      timeoutMs: modelCallTimeoutMs(request.purpose),
      knownEvidenceIds: bound.evidence,
      ...(bound.criterion ? { criterion: bound.criterion } : {}),
    });
    return this.finish(proof, budgetDenied, record);
  }
}
export { DECISION_SCHEMA };
