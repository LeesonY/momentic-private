import { Ajv } from 'ajv';
import { setTimeout as retryDelay } from 'node:timers/promises';
import formatsPlugin from 'ajv-formats';
import {
  parseContract,
  validateContract,
  modelOutputTokenLimit,
  modelContextTokenLimit,
  validModelTokenBudget,
  type ModelMessage,
  type ModelProbeResult,
  type Criterion,
  type ModelRequest,
  type ModelResult,
} from '@localqa/contracts';
import {
  DEFAULT_INPUT_TOKENS,
  FIXTURE,
  REPAIR_MARK,
  type NormalizedCall,
  type ProviderAdapter,
  type ProviderResponse,
  type StructuredOutputMode,
} from './adapter.js';
import {
  assertHttpsEndpoint,
  imageDataUrl,
  legalImageUrl,
  redactThenSample,
} from './openai.js';
import {
  hideSecret,
  messageText,
  redactMessages,
  redactText,
} from './redact.js';
import { combineUsage, estimateTokens, type UsageAttempt } from './usage.js';

// Draft-07 is Ajv 8's default. Existing output schemas and DECISION_SCHEMA's
// $ref/$defs compile here; draft 2020-only keywords are not interpreted.
// Formats are ajv-formats 3.0.1 full, the same locked package contracts uses.
// An unknown format name is rejected before any provider send.
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
formatsPlugin.default(ajv, { mode: 'full' });

const schemaLists = ['allOf', 'anyOf', 'oneOf'] as const;
const schemaMaps = [
  '$defs',
  'definitions',
  'properties',
  'patternProperties',
] as const;
const schemaChildren = [
  'additionalProperties',
  'additionalItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
] as const;

/** Format on a schema node only. const/default/examples/enum values are instances. */
function unsupportedFormat(schema: unknown): string | null {
  const pending: unknown[] = [schema];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    const format = record['format'];
    if (typeof format === 'string' && !Object.hasOwn(ajv.formats, format)) {
      return format;
    }
    for (const key of schemaLists) {
      const list = record[key];
      if (Array.isArray(list)) pending.push(...list);
    }
    const items = record['items'];
    if (Array.isArray(items)) pending.push(...items);
    else if (items && typeof items === 'object') pending.push(items);
    for (const key of schemaChildren) {
      const child = record[key];
      if (child && typeof child === 'object') pending.push(child);
    }
    for (const key of schemaMaps) {
      const map = record[key];
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      pending.push(...Object.values(map as Record<string, unknown>));
    }
    const dependencies = record['dependencies'];
    if (
      dependencies &&
      typeof dependencies === 'object' &&
      !Array.isArray(dependencies)
    ) {
      for (const child of Object.values(
        dependencies as Record<string, unknown>,
      )) {
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          pending.push(child);
        }
      }
    }
  }
  return null;
}

/** Thrown and returned provider codes stay on the §7 vocabulary. Unknown failures are unavailable, not timeouts. */
function mapProviderCode(code: string): {
  requestResult: string;
  errorCode: string;
} {
  switch (code) {
    case 'TIMEOUT':
    case 'MODEL_TIMEOUT':
      return { requestResult: 'timeout', errorCode: 'MODEL_TIMEOUT' };
    case 'RATE_LIMITED':
      return { requestResult: 'rate_limited', errorCode: 'RATE_LIMITED' };
    case 'MODEL_NOT_CONFIGURED':
      return {
        requestResult: 'not_configured',
        errorCode: 'MODEL_NOT_CONFIGURED',
      };
    case 'MODEL_BILLING_REQUIRED':
      return {
        requestResult: 'not_configured',
        errorCode: 'MODEL_BILLING_REQUIRED',
      };
    case 'MODEL_OUTPUT_TRUNCATED':
      return {
        requestResult: 'malformed',
        errorCode: 'MODEL_OUTPUT_TRUNCATED',
      };
    case 'VALIDATION_ERROR':
      return { requestResult: 'malformed', errorCode: 'VALIDATION_ERROR' };
    case 'BUDGET_EXCEEDED':
      return { requestResult: 'budget_exceeded', errorCode: 'BUDGET_EXCEEDED' };
    default:
      return { requestResult: 'unavailable', errorCode: 'SERVICE_UNAVAILABLE' };
  }
}

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
  kind: 'stub' | 'openai_compatible' | 'anthropic_messages';
  dataBoundary: 'internal' | 'external';
  capabilities: {
    structuredOutput: boolean;
    nativeTools: boolean;
    imageInput: boolean;
  };
  /**
   * How this provider accepts structured output. The shared ModelCapabilities
   * object has no format field; callers that build this profile must set it.
   * Omitted keeps json_schema and does not silently switch formats.
   */
  responseFormat?: StructuredOutputMode;
  /**
   * Persisted probe state. disabled is an admin close and is not probed.
   * Anything else, including omitted or untested, can be probed again.
   */
  status?: 'untested' | 'ready' | 'degraded' | 'disabled';
  /** Per-call output cap from the model profile; omitted uses the default. */
  maxOutputTokens?: number;
  /** Total input + reserved output tokens for this frozen model version. */
  contextWindowTokens?: number;
  encryptedApiKey: string | null;
  approvedFallbackIds: readonly string[];
}

/**
 * The bound model's output cap for every call, probes included. A caller may
 * ask for less (an explicit request ceiling), never for more.
 */
export function outputTokenLimit(profile: GatewayProfile | undefined): number {
  return modelOutputTokenLimit(profile);
}

export type ResolvedArtifact =
  | { readonly mediaType: string; readonly bytes: Uint8Array }
  | { readonly url: string };

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
  /** Optional caller ceiling; the profile's outputTokenLimit always applies. */
  maxOutputTokens?: number;
  maxInputTokens?: number;
  fallbackProfileId?: string;
  knownEvidenceIds?: readonly string[];
  /**
   * Concrete credential values the caller already holds. The gateway removes
   * them verbatim, in addition to the syntax and token layers, so no path can
   * forward an auth secret to a provider.
   */
  sensitiveValues?: readonly string[];
  /**
   * Stored criterion for purpose assert. Only a canonical Criterion is sent.
   * Free-form messages are not an expectedValue source.
   */
  criterion?: {
    id: string;
    kind: string;
    description?: string;
    sourceKind?: Criterion['sourceKind'];
    sourceRef?: string;
    locator?: Criterion['locator'];
    expectedValue?: Criterion['expectedValue'];
  };
}

export interface Assessment {
  verdictStatus: 'passed' | 'issue_found' | 'blocked' | 'inconclusive';
  reasonCode: string;
  criterionId: string | null;
  acceptedEvidenceRefs: string[];
  criterionResult: 'passed' | 'failed' | 'not_evaluated' | 'unknown' | null;
}

export interface CallRecord {
  method:
    'capabilityProbe' | 'generateDecision' | 'evaluateCriterion' | 'complete';
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
  /** Allowlisted classification only. No schema field/value or response text. */
  validationFailureKind?:
    'invalid_json' | 'schema_mismatch' | 'tool_contract_mismatch';
  /** Fixed response categories only; never model text or private data. */
  outputShapeTrace?: Array<
    | 'empty'
    | 'json_object_start'
    | 'json_object_unclosed'
    | 'json_object_balanced_invalid'
    | 'json_array_start'
    | 'code_fence_start'
    | 'markup_start'
    | 'other_text'
  >;
  /** Where a malformed output broke the frozen schema: schema-derived paths
   * (array indexes as `*`), AJV keyword and the missing/extra property name.
   * Never values or response text. At most six entries per call. */
  schemaErrorTrace?: string[];
  assessment: Assessment | null;
  attemptedModelIds: string[];
}

export interface Gateway {
  capabilityProbe(profileId: string, timeoutMs?: number): Promise<CallRecord>;
  generateDecision(input: CallInput): Promise<CallRecord>;
  evaluateCriterion(input: CallInput): Promise<CallRecord>;
  complete(
    body: unknown,
    input: Omit<
      CallInput,
      | 'purpose'
      | 'outputSchema'
      | 'messages'
      | 'maxOutputTokens'
      | 'taskId'
      | 'profileId'
      | 'contextVersion'
    > & {
      taskId?: string;
    },
  ): Promise<CallRecord>;
}

/** Canonical Criterion only. Missing required parts are not filled from messages. */
function canonicalCriterion(value: CallInput['criterion']): Criterion | null {
  if (!value) return null;
  const candidate: Record<string, unknown> = {
    id: value.id,
    kind: value.kind,
    description: value.description,
    sourceKind: value.sourceKind,
    sourceRef: value.sourceRef,
  };
  if (value.locator !== undefined) candidate['locator'] = value.locator;
  if (value.expectedValue !== undefined)
    candidate['expectedValue'] = value.expectedValue;
  const checked = validateContract('Criterion', candidate);
  return checked.success ? checked.data : null;
}

/** Caller-facing assert judgment. Provider JSON is not this object. */
function publishedCriterionResult(assessment: Assessment): unknown | null {
  if (!assessment.criterionId || !assessment.criterionResult) return null;
  const checked = validateContract('CriterionResult', {
    criterionId: assessment.criterionId,
    result: assessment.criterionResult,
    reason: assessment.reasonCode.slice(0, 2000),
    evidenceRefs: assessment.acceptedEvidenceRefs,
  });
  return checked.success ? checked.data : null;
}

export function assessCriterionOutput(input: {
  data: unknown;
  expectedCriterionId: string;
  knownEvidenceIds: readonly string[];
  criterionKind: string;
  imageInput: boolean;
  /** Visual pass requires an image URL in the provider body, not a capability flag. */
  imageTransmitted?: boolean;
}): Assessment {
  const known = new Set(input.knownEvidenceIds);
  const blank = (
    reasonCode: string,
    verdictStatus: Assessment['verdictStatus'],
  ): Assessment => ({
    verdictStatus,
    reasonCode,
    criterionId: input.expectedCriterionId,
    acceptedEvidenceRefs: [],
    criterionResult: 'not_evaluated',
  });
  if (input.criterionKind === 'visual' && !input.imageInput) {
    return blank('MODEL_CAPABILITY_MISSING', 'blocked');
  }
  if (input.criterionKind === 'visual' && input.imageTransmitted === false) {
    return blank('NO_OBSERVATION_REF', 'inconclusive');
  }
  if (
    !input.data ||
    typeof input.data !== 'object' ||
    Array.isArray(input.data)
  ) {
    return blank('NO_OBSERVATION_REF', 'inconclusive');
  }
  const row = input.data as Record<string, unknown>;
  if (row['criterionId'] !== input.expectedCriterionId) {
    return blank('CRITERION_MISMATCH', 'inconclusive');
  }
  const refs = Array.isArray(row['evidenceRefs'])
    ? row['evidenceRefs'].filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  if (refs.length === 0) return blank('NO_OBSERVATION_REF', 'inconclusive');
  if (refs.some((id) => !known.has(id)))
    return blank('FAKE_EVIDENCE', 'inconclusive');
  const result = row['result'];
  if (
    result !== 'passed' &&
    result !== 'failed' &&
    result !== 'not_evaluated' &&
    result !== 'unknown'
  ) {
    return blank('MALFORMED_JUDGMENT', 'inconclusive');
  }
  const verdictStatus =
    result === 'passed'
      ? 'passed'
      : result === 'failed'
        ? 'issue_found'
        : 'inconclusive';
  return {
    verdictStatus,
    reasonCode: verdictStatus === 'inconclusive' ? 'NO_DECISION' : 'OBSERVED',
    criterionId: input.expectedCriterionId,
    acceptedEvidenceRefs: refs,
    criterionResult: result,
  };
}

function failure(
  partial: Partial<CallRecord> &
    Pick<CallRecord, 'method' | 'requestResult' | 'errorCode'>,
): CallRecord {
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
    outputTokens:
      partial.outputTokens === undefined ? null : partial.outputTokens,
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

export function selectStructuredOutput(
  profile: GatewayProfile,
): StructuredOutputMode | 'unsupported' {
  // Stored caps start false. That is unverified, not a completed negative probe.
  if (profile.status === 'untested') {
    return profile.responseFormat ?? 'json_schema';
  }
  const mode = profile.responseFormat;
  if (mode === 'json_schema' || mode === 'json_object') {
    return profile.capabilities.structuredOutput ? mode : 'unsupported';
  }
  if (mode === 'native_tools') {
    return profile.capabilities.nativeTools ? mode : 'unsupported';
  }
  if (profile.capabilities.structuredOutput) return 'json_schema';
  if (profile.capabilities.nativeTools) return 'native_tools';
  return 'unsupported';
}

/** Chat-completion envelopes are not the decision. Bare JSON is left as-is. */
export function unwrapProviderOutput(raw: string): string {
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return raw;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return raw;
  const message = (
    choices[0] as {
      message?: { content?: unknown; tool_calls?: unknown };
    }
  ).message;
  if (!message || typeof message !== 'object') return raw;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const toolCalls = [];
    for (const call of message.tool_calls) {
      const fn = (
        call as { function?: { name?: unknown; arguments?: unknown } }
      ).function;
      if (
        !fn ||
        typeof fn.name !== 'string' ||
        typeof fn.arguments !== 'string'
      ) {
        return raw;
      }
      try {
        toolCalls.push({
          name: fn.name,
          args: JSON.parse(fn.arguments) as unknown,
        });
      } catch {
        return raw;
      }
    }
    return JSON.stringify({ toolCalls, done: false });
  }
  return typeof message.content === 'string' ? message.content : raw;
}

function toolCallsOf(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const row = value as { toolCalls?: unknown };
  return Array.isArray(row.toolCalls) ? row.toolCalls : [];
}

function toolCallsMatchContract(value: unknown): boolean {
  return toolCallsOf(value).every(
    (call) => validateContract('ToolCall', call).success,
  );
}

/** The provider body must contain each resolved image URL. Artifact ids are not images. */
function transmittedImage(
  body: unknown,
  imageUrls: Readonly<Record<string, string>>,
): boolean {
  const urls = Object.values(imageUrls).filter((url) => legalImageUrl(url));
  if (urls.length === 0) return false;
  let serialized = '';
  try {
    serialized = JSON.stringify(body);
  } catch {
    return false;
  }
  return urls.every((url) => serialized.includes(url));
}

function redactTransport(text: string): string {
  return text.replace(
    /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,
    'data:image;base64,[redacted]',
  );
}

export function createGateway(options: {
  profiles: readonly GatewayProfile[];
  decryptKey: (profileId: string, ciphertext: string) => string;
  adapter: ProviderAdapter;
  /** Opt-in for runtime calls; probes keep their existing single-attempt behavior. */
  rateLimitRetry?: { delaysMs: readonly number[]; signal?: AbortSignal };
  /**
   * Turns an approved artifact id into bytes or an https URL.
   * Absent means an approved image cannot be sent.
   */
  resolveArtifact?: (
    artifactId: string,
  ) => Promise<ResolvedArtifact | null> | ResolvedArtifact | null;
}): Gateway {
  const profiles = new Map(
    options.profiles.map((profile) => [profile.id, profile]),
  );

  async function run(
    method: CallRecord['method'],
    input: CallInput,
  ): Promise<CallRecord> {
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
      fallbackId &&
      primary.approvedFallbackIds.includes(fallbackId) &&
      fallback,
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
      record.attemptedModelIds = queue
        .slice(0, index + 1)
        .map((item) => item.configuredModelId);
      last = record;
      const retryable =
        record.requestResult === 'rate_limited' ||
        record.requestResult === 'timeout';
      if (!retryable || index === queue.length - 1) break;
    }
    return (
      last ??
      failure({
        method,
        requestResult: 'not_configured',
        errorCode: 'MODEL_NOT_CONFIGURED',
      })
    );
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
    if (
      profile.kind === 'openai_compatible' ||
      profile.kind === 'anthropic_messages'
    ) {
      try {
        assertHttpsEndpoint(profile.endpoint, profile.dataBoundary);
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

    // Concrete credentials the caller already holds (registered auth material)
    // are removed verbatim as well, so a secret that appears with no key cannot
    // pass the syntax layers.
    const redacted = redactMessages(
      input.messages,
      input.approvedImageIds,
      input.sensitiveValues ?? [],
    );
    if (redacted.droppedImageIds.length > 0) {
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
        providerCalls: 0,
      });
    }
    if (!validModelTokenBudget(profile))
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
        errorCode: 'VALIDATION_ERROR',
        providerCalls: 0,
        latencyMs: Date.now() - started,
      });
    const limit = outputTokenLimit(profile);
    const maxOutput =
      input.maxOutputTokens === undefined
        ? limit
        : Math.min(input.maxOutputTokens, limit);
    const contextInput = modelContextTokenLimit(profile) - maxOutput;
    const maxInput =
      profile.contextWindowTokens === undefined
        ? (input.maxInputTokens ?? DEFAULT_INPUT_TOKENS)
        : Math.min(input.maxInputTokens ?? contextInput, contextInput);
    let messages = redacted.messages;
    // Preserve the instruction and newest task. A small configured window must
    // fail explicitly instead of silently removing the request being tested.
    const pinned = new Set([messages[0], messages.at(-1)]);
    const dropHistory = (current: typeof messages) => {
      const index = current.findIndex((message) => !pinned.has(message));
      return index < 0 ? null : current.filter((_, i) => i !== index);
    };
    let inputEstimate = estimateTokens(JSON.stringify(messages)) ?? 1;
    const trimConfiguredHistory = () => {
      if (profile.contextWindowTokens === undefined) return;
      while (inputEstimate > maxInput) {
        const next = dropHistory(messages);
        if (!next) break;
        messages = next;
        inputEstimate = estimateTokens(JSON.stringify(messages)) ?? 1;
      }
    };
    while (inputEstimate > maxInput && messages.length > 1) {
      if (profile.contextWindowTokens !== undefined) {
        const next = dropHistory(messages);
        if (!next) break;
        messages = next;
      } else {
        const system = messages[0];
        messages = [system!, ...messages.slice(2)];
      }
      inputEstimate = estimateTokens(JSON.stringify(messages)) ?? 1;
    }
    if (input.purpose === 'assert') {
      const frozen = canonicalCriterion(input.criterion);
      if (frozen) {
        const message = messageFromText(
          'user',
          `frozenCriterion ${JSON.stringify(frozen)}`,
        );
        pinned.add(message);
        messages = [...messages, message];
        inputEstimate = estimateTokens(JSON.stringify(messages)) ?? 1;
        trimConfiguredHistory();
      }
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

    const outputMode =
      input.purpose === 'probe' && profile.status !== 'disabled'
        ? (profile.responseFormat ?? 'json_schema')
        : selectStructuredOutput(profile);
    if (outputMode === 'json_object' && input.purpose !== 'probe') {
      const message = messageFromText('user', jsonObjectConstraint(input));
      pinned.add(message);
      messages = [...messages, message];
      inputEstimate = estimateTokens(JSON.stringify(messages)) ?? 1;
      trimConfiguredHistory();
      if (inputEstimate > maxInput) {
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
    }

    let validator: ReturnType<typeof ajv.compile> | null = null;
    if (input.purpose !== 'probe') {
      try {
        const missing = unsupportedFormat(input.outputSchema);
        if (missing) throw new Error(`unsupported format ${missing}`);
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

    const imageIds: string[] = [];
    for (const message of messages) {
      for (const part of message.content) {
        if (part.type === 'image') imageIds.push(part.artifactId);
      }
    }
    const visual =
      input.purpose === 'assert' && input.criterion?.kind === 'visual';
    const preflight = (
      requestResult: string,
      errorCode: string,
      extra: Partial<CallRecord> = {},
    ): CallRecord =>
      failure({
        method,
        profileId: profile.id,
        profileVersion: profile.version,
        modelId: profile.configuredModelId,
        adapterVersion: options.adapter.version,
        promptVersion: input.promptVersion,
        role: input.role,
        purpose: input.purpose,
        requestResult,
        errorCode,
        latencyMs: Date.now() - started,
        providerCalls: 0,
        ...extra,
      });
    if (
      outputMode === 'unsupported' &&
      (input.purpose === 'decide' || input.purpose === 'assert')
    ) {
      return preflight('capability_missing', 'MODEL_CAPABILITY_MISSING', {
        assessment: visual
          ? assessCriterionOutput({
              data: null,
              expectedCriterionId: input.criterion?.id ?? FIXTURE.criterionId,
              knownEvidenceIds: input.knownEvidenceIds ?? [],
              criterionKind: 'visual',
              imageInput: false,
            })
          : null,
      });
    }
    if (visual && (!profile.capabilities.imageInput || imageIds.length === 0)) {
      return preflight('capability_missing', 'MODEL_CAPABILITY_MISSING', {
        assessment: assessCriterionOutput({
          data: null,
          expectedCriterionId: input.criterion?.id ?? FIXTURE.criterionId,
          knownEvidenceIds: input.knownEvidenceIds ?? [],
          criterionKind: 'visual',
          imageInput: false,
        }),
      });
    }
    const imageUrls: Record<string, string> = {};
    if (imageIds.length > 0) {
      if (!profile.capabilities.imageInput) {
        return preflight('capability_missing', 'MODEL_CAPABILITY_MISSING');
      }
      if (!options.resolveArtifact) {
        return preflight('not_configured', 'MODEL_NOT_CONFIGURED');
      }
      for (const artifactId of imageIds) {
        let asset: ResolvedArtifact | null;
        try {
          asset = await options.resolveArtifact(artifactId);
        } catch {
          return preflight('unavailable', 'SERVICE_UNAVAILABLE');
        }
        const url =
          asset && 'bytes' in asset
            ? (imageDataUrl(asset.mediaType, asset.bytes) ?? '')
            : (asset?.url ?? '');
        if (!legalImageUrl(url)) {
          return preflight('not_configured', 'MODEL_NOT_CONFIGURED');
        }
        imageUrls[artifactId] = url;
      }
      const imageTokens =
        estimateTokens(Object.values(imageUrls).join('')) ?? 0;
      if (inputEstimate + imageTokens > maxInput) {
        return preflight('budget_exceeded', 'BUDGET_EXCEEDED', {
          usageSource: 'estimated',
          inputTokens: inputEstimate + imageTokens,
          outputTokens: null,
        });
      }
    }

    const attempts: UsageAttempt[] = [];
    const raws: string[] = [];
    const outbound: string[] = [];
    let providerCalls = 0;
    let repairCount = 0;
    let rateLimitRetries = 0;
    const outputShapeTrace: NonNullable<CallRecord['outputShapeTrace']> = [];
    const schemaErrorTrace: string[] = [];
    let visualTransmitted = false;
    let reportedModelId: string | null = null;

    const sendOnce = async (
      current: readonly ModelMessage[],
    ): Promise<ProviderResponse> => {
      let normalized: NormalizedCall = {
        endpoint: profile.endpoint,
        dataBoundary: profile.dataBoundary,
        model: profile.configuredModelId,
        purpose: input.purpose,
        messages: current,
        outputSchema: input.outputSchema,
        tools: input.toolSchemas,
        maxOutputTokens: maxOutput,
        ...(outputMode === 'unsupported' ? {} : { responseFormat: outputMode }),
        imageUrls,
      };
      let built = options.adapter.build(normalized);
      if (profile.contextWindowTokens !== undefined) {
        let currentMessages = [...current];
        // The wire payload includes schema/tool definitions and resolved images.
        // Check every provider request, including repair and rate-limit retries.
        while ((estimateTokens(JSON.stringify(built.body)) ?? 1) > maxInput) {
          const next = dropHistory(currentMessages);
          if (!next)
            throw Object.assign(new Error('MODEL_CONTEXT_EXCEEDED'), {
              code: 'BUDGET_EXCEEDED',
            });
          currentMessages = next;
          normalized = { ...normalized, messages: currentMessages };
          built = options.adapter.build(normalized);
        }
      }
      if (visual && !transmittedImage(built.body, imageUrls)) {
        throw Object.assign(new Error('VISUAL_IMAGE_ABSENT'), {
          code: 'VISUAL_IMAGE_ABSENT',
        });
      }
      if (visual) visualTransmitted = true;
      const outboundText = hideSecret(
        redactTransport(redactText(JSON.stringify(built.body))),
        apiKey,
      );
      outbound.push(outboundText);
      providerCalls += 1;
      const controller = new AbortController();
      const timeout = input.timeoutMs - (Date.now() - started);
      if (timeout <= 0)
        throw Object.assign(new Error('MODEL_TIMEOUT'), {
          code: 'MODEL_TIMEOUT',
        });
      const timer = setTimeout(() => controller.abort(), timeout);
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
      } catch (error) {
        if (controller.signal.aborted)
          throw Object.assign(new Error('MODEL_TIMEOUT'), {
            code: 'MODEL_TIMEOUT',
          });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };

    const finish = (
      requestResult: string,
      errorCode: string | null,
      data: unknown,
      assessment: Assessment | null,
      validationFailureKind?: CallRecord['validationFailureKind'],
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
        ...(validationFailureKind ? { validationFailureKind } : {}),
        ...(requestResult === 'malformed' && outputShapeTrace.length > 0
          ? { outputShapeTrace: [...outputShapeTrace] }
          : {}),
        ...(requestResult === 'malformed' && schemaErrorTrace.length > 0
          ? { schemaErrorTrace: schemaErrorTrace.slice(0, 6) }
          : {}),
        assessment,
        attemptedModelIds: [profile.configuredModelId],
      };
    };

    const noteUsage = (response: ProviderResponse, requestText: string) => {
      // Errors still have the complete body in raw. Redact that body before
      // sampling. A pre-cut logSample cannot match a secret that crosses it.
      // Over-limit leaves raw empty; its logSample was already redacted from
      // the retained bound. Success logs that same redacted envelope sample.
      const logged =
        response.errorCode && response.raw
          ? redactThenSample(response.raw, apiKey)
          : (response.logSample ?? redactThenSample(response.raw, apiKey));
      raws.push(hideSecret(redactText(logged), apiKey));
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
        outputTokens: estimateTokens(hideSecret(response.raw, apiKey)),
      });
    };

    const stopForProvider = (response: ProviderResponse): CallRecord | null => {
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
        return finish(
          'capability_missing',
          'MODEL_CAPABILITY_MISSING',
          null,
          assessment,
        );
      }
      if (!response.errorCode) return null;
      const outcome = mapProviderCode(response.errorCode);
      return finish(outcome.requestResult, outcome.errorCode, null, null);
    };

    const present = (response: ProviderResponse): ProviderResponse =>
      response.errorCode
        ? response
        : { ...response, raw: unwrapProviderOutput(response.raw) };
    const sendWithUsage = async (current: readonly ModelMessage[]) => {
      const delays = (options.rateLimitRetry?.delaysMs ?? []).slice(0, 2);
      let response = present(await sendOnce(current));
      noteUsage(response, JSON.stringify(current));
      while (
        response.httpStatus === 429 &&
        response.errorCode === 'RATE_LIMITED' &&
        rateLimitRetries < delays.length
      ) {
        const wait = delays[rateLimitRetries]!;
        if (
          !Number.isSafeInteger(wait) ||
          wait < 0 ||
          wait > 10000 ||
          Date.now() - started + wait >= input.timeoutMs
        )
          break;
        rateLimitRetries++;
        await retryDelay(wait, undefined, {
          signal: options.rateLimitRetry?.signal,
        });
        response = present(await sendOnce(current));
        noteUsage(response, JSON.stringify(current));
      }
      return response;
    };

    try {
      let response: ProviderResponse;
      try {
        response = await sendWithUsage(messages);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'VISUAL_IMAGE_ABSENT'
        ) {
          return preflight('capability_missing', 'MODEL_CAPABILITY_MISSING', {
            assessment: assessCriterionOutput({
              data: null,
              expectedCriterionId: input.criterion?.id ?? FIXTURE.criterionId,
              knownEvidenceIds: input.knownEvidenceIds ?? [],
              criterionKind: 'visual',
              imageInput: false,
            }),
          });
        }
        throw error;
      }
      const stopped = stopForProvider(response);
      if (stopped) return stopped;
      if (input.purpose === 'probe') {
        const parsed = parseJson(response.raw);
        return finish('ok', null, parsed, null);
      }
      let parsed = parseWithSchema(response.raw, validator);
      if (!parsed.ok) {
        outputShapeTrace.push(classifyOutputShape(response.raw));
        schemaErrorTrace.push(...parsed.errors);
      }
      if (!parsed.ok && repairCount < 1) {
        repairCount += 1;
        const repair = messageFromText(
          'user',
          formatRepairInstruction(input, parsed.kind),
        );
        pinned.add(repair);
        messages = [...messages, repair];
        response = await sendWithUsage(messages);
        const repairedStop = stopForProvider(response);
        if (repairedStop) return repairedStop;
        parsed = parseWithSchema(response.raw, validator);
        if (!parsed.ok) {
          outputShapeTrace.push(classifyOutputShape(response.raw));
          schemaErrorTrace.push(...parsed.errors);
        }
      }
      if (!parsed.ok)
        return finish('malformed', 'VALIDATION_ERROR', null, null, parsed.kind);
      if (!toolCallsMatchContract(parsed.value))
        return finish(
          'malformed',
          'VALIDATION_ERROR',
          null,
          null,
          'tool_contract_mismatch',
        );
      if (input.purpose === 'assert') {
        const assessment = assessCriterionOutput({
          data: parsed.value,
          expectedCriterionId: input.criterion?.id ?? FIXTURE.criterionId,
          knownEvidenceIds: input.knownEvidenceIds ?? [],
          criterionKind: input.criterion?.kind ?? 'semantic',
          imageInput: profile.capabilities.imageInput,
          ...(visual ? { imageTransmitted: visualTransmitted } : {}),
        });
        const requestResult =
          assessment.reasonCode === 'FAKE_EVIDENCE'
            ? 'fake_evidence'
            : assessment.verdictStatus;
        const published = publishedCriterionResult(assessment);
        if (!published)
          return finish('malformed', 'VALIDATION_ERROR', null, assessment);
        return finish(
          requestResult,
          assessment.verdictStatus === 'blocked' ? assessment.reasonCode : null,
          published,
          assessment,
        );
      }
      return finish(
        repairCount > 0 ? 'repaired' : 'ok',
        null,
        parsed.value,
        null,
      );
    } catch (error) {
      const code =
        typeof error === 'object' && error && 'code' in error
          ? String(error.code)
          : '';
      const outcome = mapProviderCode(code);
      const requestText = JSON.stringify(messages);
      if (providerCalls > attempts.length)
        attempts.push({
          source: 'estimated',
          inputTokens: estimateTokens(requestText) ?? inputEstimate,
          outputTokens: null,
        });
      return finish(outcome.requestResult, outcome.errorCode, null, null);
    }
  }

  return {
    capabilityProbe(profileId, timeoutMs = 1000) {
      const probeStarted = Date.now();
      const profile = profiles.get(profileId);
      if (profile && profile.status === 'disabled') {
        const record = failure({
          method: 'capabilityProbe',
          profileId,
          profileVersion: profile.version,
          modelId: profile.configuredModelId,
          adapterVersion: options.adapter.version,
          promptVersion: 'probe.3',
          role: 'coordinator',
          purpose: 'probe',
          requestResult: 'capability_missing',
          errorCode: 'MODEL_CAPABILITY_MISSING',
          providerCalls: 0,
        });
        record.data = probeResult(
          profileId,
          {
            structuredOutput: profile.capabilities.structuredOutput,
            nativeTools: profile.capabilities.nativeTools,
            imageInput: profile.capabilities.imageInput,
          },
          'disabled',
          ['剖面已禁用'],
        );
        return Promise.resolve(record);
      }
      return run('capabilityProbe', {
        taskId: FIXTURE.taskId,
        profileId,
        contextVersion: 1,
        role: 'coordinator',
        promptVersion: 'probe.3',
        purpose: 'probe',
        messages: [
          {
            role: 'user',
            // A deterministic JSON round trip tests formatting without
            // asking a reasoning model to introspect unmeasured abilities.
            content: [
              {
                type: 'text',
                text: '能力探测：这是 JSON 格式连通性检查，请原样返回 {"structuredOutput":true,"nativeTools":false,"imageInput":false}。不要自评能力，不要解释。',
              },
            ],
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
        maxOutputTokens: outputTokenLimit(profile),
      }).then(async (record) => {
        if (
          record.requestResult !== 'ok' ||
          !record.data ||
          typeof record.data !== 'object'
        ) {
          if (record.errorCode === 'MODEL_CAPABILITY_MISSING') {
            record.data = probeResult(
              profileId,
              {
                structuredOutput: false,
                nativeTools: false,
                imageInput: false,
              },
              'degraded',
              [
                '图片不受支持。视觉验收不能改成文本验收。',
                '失败结果不把未实测能力写成可用。',
              ],
            );
          }
          return record;
        }
        try {
          parseContract('ModelCapabilities', record.data);
        } catch {
          record.requestResult = 'malformed';
          record.errorCode = 'VALIDATION_ERROR';
          record.data = null;
          return record;
        }
        if (profile?.kind === 'stub') {
          const data = record.data as Record<string, unknown>;
          const capabilities = {
            structuredOutput: data['structuredOutput'] === true,
            nativeTools: data['nativeTools'] === true,
            imageInput: data['imageInput'] === true,
          };
          const status =
            !capabilities.structuredOutput || !capabilities.nativeTools
              ? 'degraded'
              : capabilities.imageInput
                ? 'ready'
                : 'degraded';
          const notes = capabilities.imageInput
            ? ['stub 脚本结果，不是供应商实测。']
            : ['图片不受支持。视觉验收不能改成文本验收。'];
          record.data = probeResult(profileId, capabilities, status, notes);
          return record;
        }
        if (!profile || !options.adapter.probeCapability) {
          record.data = probeResult(
            profileId,
            { structuredOutput: true, nativeTools: false, imageInput: false },
            'degraded',
            [
              '结构化输出探测通过。',
              '适配器未提供工具与图片探测，不采用模型自报。',
            ],
          );
          return record;
        }
        const capabilities = {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        };
        const notes = ['结构化输出已由本次探测的合法 JSON 验证。'];
        let apiKey: string;
        try {
          apiKey = options.decryptKey(profile.id, profile.encryptedApiKey!);
        } catch {
          apiKey = '';
        }
        if (!apiKey) {
          record.requestResult = 'not_configured';
          record.errorCode = 'MODEL_NOT_CONFIGURED';
          record.data = null;
          return record;
        }
        for (const capability of ['nativeTools', 'imageInput'] as const) {
          const remaining = timeoutMs - (Date.now() - probeStarted);
          if (remaining <= 0) {
            record.requestResult = 'timeout';
            record.errorCode = 'MODEL_TIMEOUT';
            record.data = null;
            record.latencyMs = Date.now() - probeStarted;
            return record;
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), remaining);
          try {
            const tested = await options.adapter.probeCapability(
              {
                endpoint: profile.endpoint,
                dataBoundary: profile.dataBoundary,
                model: profile.configuredModelId,
                apiKey,
                capability,
                maxOutputTokens: outputTokenLimit(profile),
                ...(profile.contextWindowTokens === undefined
                  ? {}
                  : {
                      maxInputTokens:
                        modelContextTokenLimit(profile) -
                        outputTokenLimit(profile),
                    }),
              },
              controller.signal,
            );
            record.providerCalls += tested.providerCalls;
            record.requests += tested.providerCalls;
            if (tested.providerCalls > 0) {
              record.inputTokens =
                record.inputTokens === null
                  ? null
                  : record.inputTokens +
                    (tested.usage?.inputTokens ?? tested.estimatedInputTokens);
              record.outputTokens =
                record.outputTokens === null || !tested.usage
                  ? null
                  : record.outputTokens + tested.usage.outputTokens;
              const source = tested.usage ? 'reported' : 'estimated';
              if (record.usageSource !== source) record.usageSource = 'mixed';
            }
            record.latencyMs = Date.now() - probeStarted;
            if (tested.errorCode) {
              const outcome = mapProviderCode(tested.errorCode);
              record.requestResult = outcome.requestResult;
              record.errorCode = outcome.errorCode;
              record.data = null;
              return record;
            }
            const modelChanged =
              record.reportedModelId !== null &&
              tested.reportedModelId !== null &&
              record.reportedModelId !== tested.reportedModelId;
            capabilities[capability] = tested.supported && !modelChanged;
            notes.push(
              modelChanged
                ? `${capability === 'nativeTools' ? '原生工具调用' : '图片输入'}探测返回的模型标识与 JSON 探测不一致，未采纳本项能力结果。`
                : tested.note,
            );
          } finally {
            clearTimeout(timer);
          }
        }
        record.data = probeResult(
          profileId,
          capabilities,
          capabilities.nativeTools && capabilities.imageInput
            ? 'ready'
            : 'degraded',
          notes,
        );
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
        ...(request.maxOutputTokens !== undefined
          ? { maxOutputTokens: request.maxOutputTokens }
          : {}),
        role: extra.role,
        promptVersion: extra.promptVersion,
        approvedImageIds: extra.approvedImageIds,
        toolSchemas: extra.toolSchemas,
        timeoutMs: extra.timeoutMs,
        ...(extra.maxInputTokens !== undefined
          ? { maxInputTokens: extra.maxInputTokens }
          : {}),
        ...(extra.fallbackProfileId !== undefined
          ? { fallbackProfileId: extra.fallbackProfileId }
          : {}),
        ...(extra.knownEvidenceIds !== undefined
          ? { knownEvidenceIds: extra.knownEvidenceIds }
          : {}),
        ...(extra.criterion !== undefined
          ? { criterion: extra.criterion }
          : {}),
      };
      const record =
        request.purpose === 'assert'
          ? await run('complete', input)
          : await run('complete', input);
      if (
        request.purpose === 'assert' &&
        record.data !== null &&
        !record.errorCode
      ) {
        const assessment = record.assessment;
        const candidate =
          assessment?.criterionId && assessment.criterionResult
            ? {
                criterionId: assessment.criterionId,
                result: assessment.criterionResult,
                reason: assessment.reasonCode.slice(0, 2000),
                evidenceRefs: assessment.acceptedEvidenceRefs,
              }
            : null;
        const checked = candidate
          ? validateContract('CriterionResult', candidate)
          : null;
        if (!checked?.success) {
          record.data = null;
          record.errorCode = 'VALIDATION_ERROR';
          record.requestResult = 'malformed';
          return record;
        }
        // Provider JSON stays in rawOutput. It does not become the judgment.
        record.data = checked.data;
      }
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
  return parseContract('ModelProbeResult', {
    profileId,
    capabilities,
    status,
    notes,
  });
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function classifyOutputShape(
  raw: string,
): NonNullable<CallRecord['outputShapeTrace']>[number] {
  const text = raw.trimStart();
  if (!text) return 'empty';
  if (text.startsWith('{')) {
    // This scanner does not repair JSON. It emits one safe category only:
    // incomplete container/string vs syntactically broken but closed object.
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    let mismatched = false;
    for (const char of text) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const opening = stack.pop();
        if (
          (char === '}' && opening !== '{') ||
          (char === ']' && opening !== '[')
        )
          mismatched = true;
      }
    }
    if (quoted || stack.length > 0) return 'json_object_unclosed';
    if (mismatched) return 'json_object_balanced_invalid';
    return 'json_object_balanced_invalid';
  }
  if (text.startsWith('[')) return 'json_array_start';
  if (text.startsWith('```')) return 'code_fence_start';
  if (text.startsWith('<')) return 'markup_start';
  return 'other_text';
}

function formatRepairInstruction(
  input: CallInput,
  kind: 'invalid_json' | 'schema_mismatch',
): string {
  const syntax =
    kind === 'invalid_json'
      ? '上一条不是合法的完整 JSON。重新生成，不要续写上一条不完整的字符串或括号；所有属性名及字符串值使用双引号，禁止尾逗号。'
      : '上一条虽然是 JSON，但不符合批准的 outputSchema。只按原冻结 Schema 重新生成，字段类型及必填字段不得更改。';
  const decision =
    input.purpose === 'decide' &&
    Array.isArray(input.outputSchema['required']) &&
    (input.outputSchema['required'] as unknown[]).includes('toolCalls') &&
    (input.outputSchema['required'] as unknown[]).includes('done');
  return [
    REPAIR_MARK,
    syntax,
    '必须输出一个完整且可直接 JSON.parse 的 JSON 对象；不要 Markdown、代码块、解释、前后缀或推理文本。',
    decision
      ? '严格只用两个顶层字段：{"done":boolean,"toolCalls":[{"name":"工具名","args":{}}]}。如无工具调用则 toolCalls=[]；工具名称和参数必须来自原请求批准的 tools，不能臆造目标、参数或权限。'
      : '必须完全满足原请求已经批准的 outputSchema，不能改写测试期望。',
    '这是原授权请求最多一次的结构化重写，不允许增加工具执行或自行修改断言。',
  ].join('\n');
}

function parseWithSchema(
  raw: string,
  validator: ReturnType<typeof ajv.compile> | null,
):
  | { ok: true; value: unknown }
  | {
      ok: false;
      kind: 'invalid_json' | 'schema_mismatch';
      errors: string[];
    } {
  let value = parseJson(raw);
  if (value === null) {
    // Only the entire output being one fenced JSON document qualifies.
    // Never scan prose for JSON or synthesize a tool. The existing strict
    // AJV and canonical tool checks remain mandatory after parsing.
    const fence = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(
      raw,
    );
    if (fence) value = parseJson(fence[1]!);
  }
  if (value === null) return { ok: false, kind: 'invalid_json', errors: [] };
  if (!validator || !validator(value))
    return {
      ok: false,
      kind: 'schema_mismatch',
      errors: schemaErrorPaths(validator?.errors ?? []),
    };
  return { ok: true, value };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Schema-side locations only: indexes collapse to `*`; a property name is
 * kept only when it looks like an identifier (an extra key is model text). */
function schemaErrorPaths(
  errors: readonly {
    instancePath: string;
    keyword: string;
    params: Record<string, unknown>;
  }[],
): string[] {
  const seen = new Set<string>();
  for (const error of errors) {
    const path =
      error.instancePath
        .split('/')
        .map((part) => (/^\d+$/.test(part) ? '*' : part))
        .filter((part) => part === '' || part === '*' || IDENTIFIER.test(part))
        .join('/')
        .slice(0, 160) || '/';
    const name =
      error.params['missingProperty'] ?? error.params['additionalProperty'];
    const property =
      typeof name === 'string' && IDENTIFIER.test(name) ? `:${name}` : '';
    seen.add(`${path}:${error.keyword}${property}`);
    if (seen.size >= 6) break;
  }
  return [...seen];
}

function jsonObjectConstraint(input: CallInput): string {
  const tools = input.toolSchemas.map((tool) => ({
    name: tool.name,
    parameters: tool.parameters,
  }));
  // The canonical decision schema contains the complete ToolCall $defs tree
  // (~21 KB), even for coordinator's two allowed tools. Repeating it in a
  // json_object prompt can exceed the 4k-token request limit *before* a
  // provider call. Keep the full schema in the local AJV validator and the
  // tool-contract/permission checks; only compact the prompt's description.
  const decisionShape =
    input.purpose !== 'assert' &&
    input.outputSchema['type'] === 'object' &&
    Array.isArray(input.outputSchema['required']) &&
    (input.outputSchema['required'] as unknown[]).includes('toolCalls') &&
    (input.outputSchema['required'] as unknown[]).includes('done');
  return [
    '输出一个 JSON 对象，不要 Markdown，不要解释。',
    decisionShape
      ? '必须返回 {"done":boolean,"toolCalls":[{"name":工具名,"args":参数对象}]}；无工具调用时 toolCalls=[]。仅使用列出的工具名称及其参数，禁止增加其他字段。'
      : '该对象必须满足 outputSchema。',
    '若调用工具，toolCalls 的参数必须满足同名 parameters。',
    `outputSchema=${JSON.stringify(
      decisionShape
        ? {
            type: 'object',
            required: ['done', 'toolCalls'],
            additionalProperties: false,
            properties: {
              done: { type: 'boolean' },
              toolCalls: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['name', 'args'],
                  properties: {
                    name: { type: 'string' },
                    args: { type: 'object' },
                  },
                },
              },
            },
          }
        : input.outputSchema,
    )}`,
    `tools=${JSON.stringify(tools)}`,
  ].join('\n');
}

export function messageFromText(
  role: ModelMessage['role'],
  text: string,
): ModelMessage {
  return { role, content: [{ type: 'text', text }] };
}

export { FIXTURE, messageText };
