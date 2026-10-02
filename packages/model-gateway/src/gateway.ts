import { Ajv } from 'ajv';
import {
  parseContract,
  type ModelMessage,
  type ModelProbeResult,
  type ModelRequest,
  type ModelResult,
} from '@localqa/contracts';
import {
  DEFAULT_INPUT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  FIXTURE,
  REPAIR_MARK,
  type NormalizedCall,
  type ProviderAdapter,
  type ProviderResponse,
} from './adapter.js';
import { assertHttpsEndpoint, toOpenAIChatRequest } from './openai.js';
import { hideSecret, messageText, redactMessages, redactText } from './redact.js';
import { combineUsage, estimateTokens, type UsageAttempt } from './usage.js';

const ajv = new Ajv({ allErrors: true, strict: false });

export type AgentRoleName =
  | 'coordinator'
  | 'explorer'
  | 'planner'
  | 'executor'
  | 'reproducer'
  | 'finalizer'
  | 'assertion';

export type Purpose = ModelRequest['purpose'] | 'probe';

export interface GatewayProfile {
  id: string;
  version: number;
  name: string;
  endpoint: string;
  configuredModelId: string;
  kind: 'stub' | 'openai_compatible';
  dataBoundary: 'internal' | 'external';
  capabilities: { structuredOutput: boolean; nativeTools: boolean; imageInput: boolean };
  encryptedApiKey: string | null;
  approvedFallbackIds: readonly string[];
}

export interface CallInput {
  taskId: string;
  profileId: string;
  contextVersion: number;
  role: AgentRoleName;
  promptVersion: string;
  purpose: Purpose;
  messages: readonly ModelMessage[];
  approvedImageIds: readonly string[];
  toolSchemas: readonly { name: string; parameters: Record<string, unknown> }[];
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
  maxOutputTokens: number;
  maxInputTokens?: number;
  fallbackProfileId?: string;
  knownEvidenceIds?: readonly string[];
  criterion?: { id: string; kind: string };
}

export interface Assessment {
  verdictStatus: 'passed' | 'issue_found' | 'blocked' | 'inconclusive';
  reasonCode: string;
  criterionId: string | null;
  acceptedEvidenceRefs: string[];
  criterionResult: 'passed' | 'failed' | 'not_evaluated' | 'unknown' | null;
}

export interface CallRecord {
  method: 'capabilityProbe' | 'generateDecision' | 'evaluateCriterion' | 'complete';
  profileId: string;
  profileVersion: number | null;
  modelId: string | null;
  reportedModelId: string | null;
  adapterVersion: string;
  promptVersion: string;
  role: string;
  purpose: string;
  latencyMs: number;
  requestResult: string;
  usageSource: 'reported' | 'estimated' | 'mixed' | 'unknown';
  inputTokens: number | null;
  outputTokens: number | null;
  requests: number;
  fallbackUsed: boolean;
  fallbackDenied: boolean;
  repairCount: number;
  providerCalls: number;
  authorization: 'set' | 'unset';
  rawOutput: string;
  outboundRedacted: string;
  data: unknown;
  errorCode: string | null;
  assessment: Assessment | null;
  attemptedModelIds: string[];
}

export interface Gateway {
  capabilityProbe(profileId: string, timeoutMs?: number): Promise<CallRecord>;
  generateDecision(input: CallInput): Promise<CallRecord>;
  evaluateCriterion(input: CallInput): Promise<CallRecord>;
  complete(body: unknown, input: Omit<CallInput, 'purpose' | 'outputSchema' | 'messages' | 'maxOutputTokens' | 'taskId' | 'profileId' | 'contextVersion'> & {
    taskId?: string;
  }): Promise<CallRecord>;
}

export function assessCriterionOutput(input: {
  data: unknown;
  expectedCriterionId: string;
  knownEvidenceIds: readonly string[];
  criterionKind: string;
  imageInput: boolean;
}): Assessment {
  const known = new Set(input.knownEvidenceIds);
  const blank = (reasonCode: string, verdictStatus: Assessment['verdictStatus']): Assessment => ({
    verdictStatus,
    reasonCode,
    criterionId: input.expectedCriterionId,
    acceptedEvidenceRefs: [],
    criterionResult: 'not_evaluated',
  });
  if (input.criterionKind === 'visual' && !input.imageInput) {
    return blank('MODEL_CAPABILITY_MISSING', 'blocked');
  }
  if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) {
    return blank('NO_OBSERVATION_REF', 'inconclusive');
  }
  const row = input.data as Record<string, unknown>;
  if (row['criterionId'] !== input.expectedCriterionId) {
    return blank('CRITERION_MISMATCH', 'inconclusive');
  }
  const refs = Array.isArray(row['evidenceRefs'])
    ? row['evidenceRefs'].filter((item): item is string => typeof item === 'string')
    : [];
  if (refs.length === 0) return blank('NO_OBSERVATION_REF', 'inconclusive');
  if (refs.some((id) => !known.has(id))) return blank('FAKE_EVIDENCE', 'inconclusive');
  const result = row['result'];
  if (result !== 'passed' && result !== 'failed' && result !== 'not_evaluated' && result !== 'unknown') {
    return blank('MALFORMED_JUDGMENT', 'inconclusive');
  }
  const verdictStatus =
    result === 'passed' ? 'passed' : result === 'failed' ? 'issue_found' : 'inconclusive';
  return {
    verdictStatus,
    reasonCode: verdictStatus === 'inconclusive' ? 'NO_DECISION' : 'OBSERVED',
    criterionId: input.expectedCriterionId,
    acceptedEvidenceRefs: refs,
    criterionResult: result,
  };
}

function failure(partial: Partial<CallRecord> & Pick<CallRecord, 'method' | 'requestResult' | 'errorCode'>): CallRecord {
  return {
    profileId: partial.profileId ?? '',
    profileVersion: partial.profileVersion ?? null,
    modelId: partial.modelId ?? null,
    reportedModelId: null,
    adapterVersion: partial.adapterVersion ?? '',
    promptVersion: partial.promptVersion ?? '',
    role: partial.role ?? '',
    purpose: partial.purpose ?? '',
    latencyMs: partial.latencyMs ?? 0,
    usageSource: partial.usageSource ?? 'unknown',
    inputTokens: partial.inputTokens === undefined ? null : partial.inputTokens,
    outputTokens: partial.outputTokens === undefined ? null : partial.outputTokens,
    requests: partial.requests ?? 0,
    fallbackUsed: false,
    fallbackDenied: partial.fallbackDenied ?? false,
    repairCount: 0,
    providerCalls: partial.providerCalls ?? 0,
    authorization: 'unset',
    rawOutput: partial.rawOutput ?? '',
    outboundRedacted: partial.outboundRedacted ?? '',
    data: null,
    assessment: partial.assessment ?? null,
    attemptedModelIds: partial.attemptedModelIds ?? [],
    method: partial.method,
    requestResult: partial.requestResult,
    errorCode: partial.errorCode,
  };
}

export function createGateway(options: {
  profiles: readonly GatewayProfile[];
  decryptKey: (profileId: string, ciphertext: string) => string;
  adapter: ProviderAdapter;
}): Gateway {
  const profiles = new Map(options.profiles.map((profile) => [profile.id, profile]));

  async function run(method: CallRecord['method'], input: CallInput): Promise<CallRecord> {
    const started = Date.now();
    const primary = profiles.get(input.profileId);
    if (!primary) {
      return failure({
        method,
        profileId: input.profileId,
        promptVersion: input.promptVersion,
        role: input.role,
        purpose: input.purpose,
        requestResult: 'not_configured',
        errorCode: 'MODEL_NOT_CONFIGURED',
        latencyMs: Date.now() - started,
      });
    }
    const fallbackId = input.fallbackProfileId;
    const fallback = fallbackId ? profiles.get(fallbackId) : undefined;
    const fallbackAllowed = Boolean(
      fallbackId && primary.approvedFallbackIds.includes(fallbackId) && fallback,
    );
    const fallbackDenied = Boolean(fallbackId) && !fallbackAllowed;
    const queue = [primary];
    if (fallbackAllowed && fallback) queue.push(fallback);

    let usedFallback = false;
    let last: CallRecord | null = null;
    for (const [index, profile] of queue.entries()) {
      if (index > 0) usedFallback = true;
      const record = await callProfile(method, input, profile, started);
      record.fallbackUsed = usedFallback;
      record.fallbackDenied = fallbackDenied;
      record.attemptedModelIds = queue.slice(0, index + 1).map((item) => item.configuredModelId);
      last = record;
      const retryable = record.requestResult === 'rate_limited' || record.requestResult === 'timeout';
      if (!retryable || index === queue.length - 1) break;
    }
    return last ?? failure({ method, requestResult: 'not_configured', errorCode: 'MODEL_NOT_CONFIGURED' });
  }

  async function callProfile(
    method: CallRecord['method'],
    input: CallInput,
    profile: GatewayProfile,
    started: number,
  ): Promise<CallRecord> {
    if (profile.kind !== options.adapter.kind) {
      return failure({
        method,
        profileId: profile.id,
        profileVersion: profile.version,
        modelId: profile.configuredModelId,
        adapterVersion: options.adapter.version,
        promptVersion: input.promptVersion,
        role: input.role,
        purpose: input.purpose,
        requestResult: 'not_configured',
        errorCode: 'MODEL_NOT_CONFIGURED',
        latencyMs: Date.now() - started,
      });
    }
    if (profile.kind === 'openai_compatible') {
      try {
        assertHttpsEndpoint(profile.endpoint);
      } catch {
        return failure({
          method,
          profileId: profile.id,
          profileVersion: profile.version,
          modelId: profile.configuredModelId,
          adapterVersion: options.adapter.version,
          promptVersion: input.promptVersion,
          role: input.role,
          purpose: input.purpose,
          requestResult: 'not_configured',
          errorCode: 'MODEL_NOT_CONFIGURED',
          latencyMs: Date.now() - started,
        });
      }
    }
    let apiKey = '';
    if (profile.encryptedApiKey === null) {
      if (profile.kind !== 'stub') {
        return failure({
          method,
          profileId: profile.id,
          profileVersion: profile.version,
          modelId: profile.configuredModelId,
          adapterVersion: options.adapter.version,
          promptVersion: input.promptVersion,
          role: input.role,
          purpose: input.purpose,
          requestResult: 'not_configured',
          errorCode: 'MODEL_NOT_CONFIGURED',
          latencyMs: Date.now() - started,
        });
      }
    } else {
      apiKey = options.decryptKey(profile.id, profile.encryptedApiKey);
      if (!apiKey) {
        return failure({
          method,
          profileId: profile.id,
          profileVersion: profile.version,
          modelId: profile.configuredModelId,
          adapterVersion: options.adapter.version,
          promptVersion: input.promptVersion,
          role: input.role,
          purpose: input.purpose,
          requestResult: 'not_configured',
          errorCode: 'MODEL_NOT_CONFIGURED',
          latencyMs: Date.now() - started,
        });
      }
    }

    const redacted = redactMessages(input.messages, input.approvedImageIds);
    let messages = redacted.messages;
    const maxInput = input.maxInputTokens ?? DEFAULT_INPUT_TOKENS;
    let inputEstimate = estimateTokens(JSON.stringify(messages)) ?? 1;
    while (inputEstimate > maxInput && messages.length > 1) {
      const system = messages[0];
      messages = [system!, ...messages.slice(2)];
      inputEstimate = estimateTokens(JSON.stringify(messages)) ?? 1;
    }
    if (inputEstimate > maxInput || messages.length === 0) {
      return failure({
        method,
        profileId: profile.id,
        profileVersion: profile.version,
        modelId: profile.configuredModelId,
        adapterVersion: options.adapter.version,
        promptVersion: input.promptVersion,
        role: input.role,
        purpose: input.purpose,
        requestResult: 'budget_exceeded',
        errorCode: 'BUDGET_EXCEEDED',
        usageSource: 'estimated',
        inputTokens: inputEstimate,
        outputTokens: null,
        requests: 0,
        latencyMs: Date.now() - started,
      });
    }

    let validator: ReturnType<typeof ajv.compile> | null = null;
    if (input.purpose !== 'probe') {
      try {
        validator = ajv.compile(input.outputSchema);
      } catch {
        return failure({
          method,
          profileId: profile.id,
          profileVersion: profile.version,
          modelId: profile.configuredModelId,
          requestResult: 'malformed',
          errorCode: 'VALIDATION_ERROR',
          adapterVersion: options.adapter.version,
          promptVersion: input.promptVersion,
          role: input.role,
          purpose: input.purpose,
          latencyMs: Date.now() - started,
        });
      }
    }

    const attempts: UsageAttempt[] = [];
    const raws: string[] = [];
    const outbound: string[] = [];
    let providerCalls = 0;
    let repairCount = 0;
    let reportedModelId: string | null = null;
    const maxOutput = Math.min(input.maxOutputTokens, DEFAULT_OUTPUT_TOKENS);

    const sendOnce = async (current: readonly ModelMessage[]): Promise<ProviderResponse> => {
      const normalized: NormalizedCall = {
        endpoint: profile.endpoint,
        model: profile.configuredModelId,
        purpose: input.purpose,
        messages: current,
        outputSchema: input.outputSchema,
        tools: input.toolSchemas,
        maxOutputTokens: maxOutput,
      };
      const built = options.adapter.build(normalized);
      const outboundText = hideSecret(redactText(JSON.stringify(built.body)), apiKey);
      outbound.push(outboundText);
      providerCalls += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        return await options.adapter.send(
          {
            model: profile.configuredModelId,
            endpoint: built.endpoint,
            body: built.body,
            apiKey,
          },
          controller.signal,
        );
      } finally {
        clearTimeout(timer);
      }
    };

    const finish = (
      requestResult: string,
      errorCode: string | null,
      data: unknown,
      assessment: Assessment | null,
    ): CallRecord => {
      const usage = combineUsage(attempts);
      const rawOutput = hideSecret(raws.join('\n'), apiKey);
      return {
        method,
        profileId: profile.id,
        profileVersion: profile.version,
        modelId: profile.configuredModelId,
        reportedModelId,
        adapterVersion: options.adapter.version,
        promptVersion: input.promptVersion,
        role: input.role,
        purpose: input.purpose,
        latencyMs: Date.now() - started,
        requestResult,
        usageSource: usage.usageSource,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        requests: usage.requests,
        fallbackUsed: false,
        fallbackDenied: false,
        repairCount,
        providerCalls,
        authorization: apiKey ? 'set' : 'unset',
        rawOutput,
        outboundRedacted: outbound.join('\n'),
        data,
        errorCode,
        assessment,
        attemptedModelIds: [profile.configuredModelId],
      };
    };

    const noteUsage = (response: ProviderResponse, requestText: string) => {
      const raw = hideSecret(response.raw, apiKey);
      raws.push(raw);
      reportedModelId = response.reportedModelId;
      if (response.usage) {
        attempts.push({
          source: 'reported',
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        });
        return;
      }
      attempts.push({
        source: 'estimated',
        inputTokens: estimateTokens(requestText) ?? inputEstimate,
        outputTokens: estimateTokens(raw),
      });
    };

    try {
      let response = await sendOnce(messages);
      noteUsage(response, JSON.stringify(messages));
      if (response.errorCode === 'RATE_LIMITED') {
        return finish('rate_limited', 'RATE_LIMITED', null, null);
      }
      if (response.errorCode === 'IMAGE_UNSUPPORTED') {
        const assessment =
          input.purpose === 'assert'
            ? assessCriterionOutput({
                data: null,
                expectedCriterionId: input.criterion?.id ?? FIXTURE.criterionId,
                knownEvidenceIds: input.knownEvidenceIds ?? [],
                criterionKind: input.criterion?.kind ?? 'visual',
                imageInput: false,
              })
            : null;
        return finish('capability_missing', 'MODEL_CAPABILITY_MISSING', null, assessment);
      }
      if (input.purpose === 'probe') {
        const parsed = parseJson(response.raw);
        return finish('ok', null, parsed, null);
      }
      let parsed = parseWithSchema(response.raw, validator);
      if (!parsed.ok && repairCount < 1) {
        repairCount += 1;
        const repair = messageFromText(
          'user',
          `${REPAIR_MARK}：只输出一个符合 outputSchema 的 JSON 对象，不要解释。`,
        );
        messages = [...messages, repair];
        response = await sendOnce(messages);
        noteUsage(response, JSON.stringify(messages));
        if (response.errorCode === 'RATE_LIMITED') return finish('rate_limited', 'RATE_LIMITED', null, null);
        if (response.errorCode === 'IMAGE_UNSUPPORTED') {
          return finish('capability_missing', 'MODEL_CAPABILITY_MISSING', null, null);
        }
        parsed = parseWithSchema(response.raw, validator);
      }
      if (!parsed.ok) return finish('malformed', 'VALIDATION_ERROR', null, null);
      if (input.purpose === 'assert') {
        const assessment = assessCriterionOutput({
          data: parsed.value,
          expectedCriterionId: input.criterion?.id ?? FIXTURE.criterionId,
          knownEvidenceIds: input.knownEvidenceIds ?? [],
          criterionKind: input.criterion?.kind ?? 'semantic',
          imageInput: profile.capabilities.imageInput,
        });
        const requestResult =
          assessment.reasonCode === 'FAKE_EVIDENCE' ? 'fake_evidence' : assessment.verdictStatus;
        return finish(requestResult, assessment.verdictStatus === 'blocked' ? assessment.reasonCode : null, parsed.value, assessment);
      }
      return finish(repairCount > 0 ? 'repaired' : 'ok', null, parsed.value, null);
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
      const requestResult = code === 'TIMEOUT' ? 'timeout' : 'timeout';
      const requestText = JSON.stringify(messages);
      attempts.push({
        source: 'estimated',
        inputTokens: estimateTokens(requestText) ?? inputEstimate,
        outputTokens: null,
      });
      return finish(requestResult, 'MODEL_TIMEOUT', null, null);
    }
  }

  return {
    capabilityProbe(profileId, timeoutMs = 1000) {
      const profile = profiles.get(profileId);
      return run('capabilityProbe', {
        taskId: FIXTURE.taskId,
        profileId,
        contextVersion: 1,
        role: 'coordinator',
        promptVersion: 'probe.1',
        purpose: 'probe',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '能力探测：只返回 JSON。' }],
          },
        ],
        approvedImageIds: [],
        toolSchemas: [],
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['structuredOutput', 'nativeTools', 'imageInput'],
          properties: {
            structuredOutput: { type: 'boolean' },
            nativeTools: { type: 'boolean' },
            imageInput: { type: 'boolean' },
          },
        },
        timeoutMs,
        maxOutputTokens: 200,
        ...(profile ? {} : {}),
      }).then((record) => {
        if (record.requestResult !== 'ok' || !record.data || typeof record.data !== 'object') {
          if (record.errorCode === 'MODEL_CAPABILITY_MISSING') {
            record.data = probeResult(profileId, {
              structuredOutput: true,
              nativeTools: true,
              imageInput: false,
            }, 'degraded', ['图片不受支持。视觉验收不能改成文本验收。']);
          }
          return record;
        }
        const data = record.data as Record<string, unknown>;
        const capabilities = {
          structuredOutput: data['structuredOutput'] === true,
          nativeTools: data['nativeTools'] === true,
          imageInput: data['imageInput'] === true,
        };
        const status = !capabilities.structuredOutput || !capabilities.nativeTools
          ? 'disabled'
          : capabilities.imageInput
            ? 'ready'
            : 'degraded';
        const notes = capabilities.imageInput
          ? []
          : ['图片不受支持。视觉验收不能改成文本验收。'];
        record.data = probeResult(profileId, capabilities, status, notes);
        return record;
      });
    },
    generateDecision(input) {
      return run('generateDecision', input);
    },
    evaluateCriterion(input) {
      return run('evaluateCriterion', { ...input, purpose: 'assert' });
    },
    async complete(body, extra) {
      let request: ModelRequest;
      try {
        request = parseContract('ModelRequest', body);
      } catch {
        return failure({
          method: 'complete',
          requestResult: 'malformed',
          errorCode: 'VALIDATION_ERROR',
          promptVersion: extra.promptVersion,
          role: extra.role,
        });
      }
      const input: CallInput = {
        taskId: request.taskId,
        profileId: request.profileId,
        contextVersion: request.contextVersion,
        purpose: request.purpose,
        messages: request.messages,
        outputSchema: request.outputSchema as Record<string, unknown>,
        maxOutputTokens: request.maxOutputTokens,
        role: extra.role,
        promptVersion: extra.promptVersion,
        approvedImageIds: extra.approvedImageIds,
        toolSchemas: extra.toolSchemas,
        timeoutMs: extra.timeoutMs,
        ...(extra.maxInputTokens !== undefined ? { maxInputTokens: extra.maxInputTokens } : {}),
        ...(extra.fallbackProfileId !== undefined ? { fallbackProfileId: extra.fallbackProfileId } : {}),
        ...(extra.knownEvidenceIds !== undefined ? { knownEvidenceIds: extra.knownEvidenceIds } : {}),
        ...(extra.criterion !== undefined ? { criterion: extra.criterion } : {}),
      };
      const record = request.purpose === 'assert'
        ? await run('complete', input)
        : await run('complete', input);
      if (record.data === null || record.errorCode) return record;
      const result: ModelResult = {
        data: record.data as ModelResult['data'],
        configuredModelId: record.modelId ?? '',
        reportedModelId: record.reportedModelId,
        usage: {
          profileId: record.profileId,
          configuredModelId: record.modelId ?? '',
          reportedModelId: record.reportedModelId,
          requests: record.requests,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          usageSource: record.usageSource,
        },
      };
      record.data = parseContract('ModelResult', result);
      return record;
    },
  };
}

function probeResult(
  profileId: string,
  capabilities: ModelProbeResult['capabilities'],
  status: ModelProbeResult['status'],
  notes: string[],
): ModelProbeResult {
  return parseContract('ModelProbeResult', { profileId, capabilities, status, notes });
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseWithSchema(
  raw: string,
  validator: ReturnType<typeof ajv.compile> | null,
): { ok: true; value: unknown } | { ok: false } {
  const value = parseJson(raw);
  if (value === null || !validator) return { ok: false };
  return validator(value) ? { ok: true, value } : { ok: false };
}

export function messageFromText(role: ModelMessage['role'], text: string): ModelMessage {
  return { role, content: [{ type: 'text', text }] };
}

export { FIXTURE, messageText };
