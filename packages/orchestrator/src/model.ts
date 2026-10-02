import { randomUUID } from 'node:crypto';
import { validateContract } from '@localqa/contracts';
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
} from '@localqa/agents';
import {
  StorageError,
  type WorkerScope,
  type LeaseProof,
} from '@localqa/storage';
import type { Coordinator } from './core.js';

export type AgentRoleName = CallInput['role'];
export interface ModelOptions {
  adapter: ProviderAdapter;
  allowTestStub?: boolean;
  profile: (id: string, version: number) => Promise<GatewayProfile>;
  decryptKey: (id: string, ciphertext: string) => string;
}
export type DecisionPayload = Pick<
  CallInput,
  'purpose' | 'messages' | 'outputSchema' | 'maxOutputTokens'
>;
const ALLOWED: Record<string, readonly AgentRoleName[]> = {
  coordinator: ['coordinator', 'planner'],
  explorer: ['explorer'],
  executor: ['executor', 'assertion'],
  reproducer: ['reproducer', 'assertion'],
  finalizer: ['finalizer'],
};
export class BoundModel {
  constructor(
    private coordinator: Coordinator,
    private scope: WorkerScope,
    private options: ModelOptions,
  ) {}
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
    const bound = await this.coordinator.tx(async (client) => {
      const { job, run } = await this.coordinator.validateLease(
        client,
        this.scope,
        proof,
      );
      if (!ALLOWED[job.role]?.includes(role))
        throw new StorageError('FORBIDDEN');
      const binding =
        run.effectiveConfig.models[
          role === 'planner' || role === 'finalizer'
            ? 'coordinator'
            : (role as keyof typeof run.effectiveConfig.models)
        ];
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
      if (
        profile.configuredModelId !== row.document.configuredModelId ||
        profile.endpoint !== row.document.endpoint ||
        (profile.kind === 'stub' && !this.options.allowTestStub) ||
        (profile.kind !== 'stub' &&
          !['ready', 'degraded'].includes(row.document.status))
      )
        throw new StorageError('MODEL_NOT_CONFIGURED');
      const definition = job.case_id
        ? (
            await client.query(
              'SELECT document FROM run_cases WHERE project_id=$1 AND id=$2',
              [this.scope.projectId, job.case_id],
            )
          ).rows[0]?.document
        : null;
      const criterion = criterionId
        ? definition?.criteria.find((c: { id: string }) => c.id === criterionId)
        : null;
      if (criterionId && !criterion) throw new StorageError('NOT_FOUND');
      const evidence = (
        await client.query(
          'SELECT id FROM artifacts WHERE project_id=$1 AND task_id=$2',
          [this.scope.projectId, job.id],
        )
      ).rows.map((row) => row.id as string);
      return { profile, evidence, criterion };
    });
    let budgetDenied = false;
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
    const metadata = new WeakMap<
      object,
      { inputTokens: number; maxOutputTokens: number }
    >();
    const delegate = this.options.adapter;
    const coordinator = this.coordinator;
    const scope = this.scope;
    const budgeted: ProviderAdapter = {
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
                  profileId: bound.profile.id,
                  profileVersion: bound.profile.version,
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
              budgetDenied = true;
            throw error;
          });
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
                }),
                scope.projectId,
                alreadyUnknown ? 'unknown' : 'settled',
              ],
            );
          });
          return response;
        } catch (error) {
          await coordinator.settle(
            scope,
            proof,
            reservation.id,
            reservation.amount,
            'unknown',
          );
          throw error;
        }
      },
    };
    const gateway = createGateway({
      profiles: [bound.profile],
      decryptKey: this.options.decryptKey,
      adapter: budgeted,
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
      approvedImageIds: [],
      toolSchemas:
        role === 'assertion'
          ? []
          : renderPrompt(role).allowedTools.map((name) => ({
              name,
              parameters: { type: 'object' },
            })),
      timeoutMs: 1000,
      maxInputTokens: 4000,
      knownEvidenceIds: bound.evidence,
      ...(bound.criterion
        ? { criterion: { id: bound.criterion.id, kind: bound.criterion.kind } }
        : {}),
    };
    const record =
      role === 'assertion'
        ? await gateway.evaluateCriterion(input)
        : await gateway.generateDecision(input);
    if (budgetDenied) throw new StorageError('BUDGET_EXCEEDED');
    // Model output cannot dispatch itself; authority is rechecked after the awaited provider.
    await this.coordinator.tx((client) =>
      this.coordinator.validateLease(client, this.scope, proof),
    );
    return record;
  }
}
export { DECISION_SCHEMA };
