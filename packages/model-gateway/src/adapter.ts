import type { ModelMessage } from '@localqa/contracts';
import {
  MODEL_DEFAULT_INPUT_TOKENS,
  MODEL_DEFAULT_OUTPUT_TOKENS,
  MODEL_MIN_OUTPUT_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
} from '@localqa/contracts';
import type { OpenAIToolSchema } from './openai.js';

export const FIXTURE = Object.freeze({
  profileId: '11111111-1111-4111-8111-111111111111',
  fallbackProfileId: '66666666-6666-4666-8666-666666666666',
  missingProfileId: '77777777-7777-4777-8777-777777777777',
  taskId: '22222222-2222-4222-8222-222222222222',
  pageId: '33333333-3333-4333-8333-333333333333',
  snapshotId: '44444444-4444-4444-8444-444444444444',
  evidenceId: '55555555-5555-4555-8555-555555555555',
  fakeEvidenceId: '99999999-9999-4999-8999-999999999999',
  criterionId: 'smoke.visible',
  imageId: '88888888-8888-4888-8888-888888888888',
});

export type ProviderErrorCode =
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'MODEL_TIMEOUT'
  | 'IMAGE_UNSUPPORTED'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_BILLING_REQUIRED'
  | 'MODEL_OUTPUT_TRUNCATED'
  | 'VALIDATION_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'SERVICE_UNAVAILABLE'
  | null;

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  /** Complete body used for parsing. Empty when the body is refused. */
  raw: string;
  /** Log prefix only. Parsing must not use this instead of raw. */
  logSample?: string;
  httpStatus: number;
  reportedModelId: string | null;
  usage: ProviderUsage | null;
  errorCode: ProviderErrorCode;
}

export type StructuredOutputMode =
  'json_schema' | 'json_object' | 'native_tools';

export interface NormalizedCall {
  endpoint: string;
  model: string;
  purpose: string;
  messages: readonly ModelMessage[];
  outputSchema: Record<string, unknown>;
  tools: readonly OpenAIToolSchema[];
  maxOutputTokens: number;
  /** Declared on the profile. Omitted means the adapter keeps json_schema. */
  responseFormat?: StructuredOutputMode;
  /** Approved artifact id → https or data:image URL. Never artifact://. */
  imageUrls?: Readonly<Record<string, string>>;
}

export interface ProviderAdapter {
  readonly kind: 'stub' | 'openai_compatible' | 'anthropic_messages';
  readonly version: string;
  build(input: NormalizedCall): { endpoint: string; body: unknown };
  send(
    input: { model: string; endpoint: string; body: unknown; apiKey: string },
    signal: AbortSignal,
  ): Promise<ProviderResponse>;
  /** Isolated wire probes. Returned tool calls are validated, never executed. */
  probeCapability?(
    input: CapabilityProbeInput,
    signal: AbortSignal,
  ): Promise<CapabilityProbeResponse>;
}

export interface CapabilityProbeInput {
  endpoint: string;
  model: string;
  apiKey: string;
  capability: 'nativeTools' | 'imageInput';
  maxOutputTokens: number;
  maxInputTokens?: number;
}

export interface CapabilityProbeResponse {
  supported: boolean;
  note: string;
  errorCode: ProviderErrorCode;
  usage: ProviderUsage | null;
  reportedModelId: string | null;
  providerCalls: number;
  estimatedInputTokens: number;
}

export const DEFAULT_INPUT_TOKENS = MODEL_DEFAULT_INPUT_TOKENS;
/**
 * Output cap for one call when a model profile sets none. Models that reason
 * before answering (MoreSec DeepSeek counts reasoning against max_tokens)
 * exhausted the former 200-400 token caller caps; non-reasoning models stop
 * early, so a larger ceiling costs only budget reservation, which is settled
 * to actual usage.
 */
export const DEFAULT_OUTPUT_TOKENS = MODEL_DEFAULT_OUTPUT_TOKENS;
/** Bounds for a profile's configured maxOutputTokens (contract-enforced). */
export const MIN_OUTPUT_TOKENS = MODEL_MIN_OUTPUT_TOKENS;
export const MAX_OUTPUT_TOKENS = MODEL_MAX_OUTPUT_TOKENS;
export const REPAIR_MARK = '格式修复';
