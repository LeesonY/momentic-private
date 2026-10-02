import type { ModelMessage } from '@localqa/contracts';
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
  | 'IMAGE_UNSUPPORTED'
  | null;

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  raw: string;
  httpStatus: number;
  reportedModelId: string | null;
  usage: ProviderUsage | null;
  errorCode: ProviderErrorCode;
}

export interface NormalizedCall {
  endpoint: string;
  model: string;
  purpose: string;
  messages: readonly ModelMessage[];
  outputSchema: Record<string, unknown>;
  tools: readonly OpenAIToolSchema[];
  maxOutputTokens: number;
}

export interface ProviderAdapter {
  readonly kind: 'stub' | 'openai_compatible';
  readonly version: string;
  build(input: NormalizedCall): { endpoint: string; body: unknown };
  send(
    input: { model: string; endpoint: string; body: unknown; apiKey: string },
    signal: AbortSignal,
  ): Promise<ProviderResponse>;
}

export const DEFAULT_INPUT_TOKENS = 12_000;
export const DEFAULT_OUTPUT_TOKENS = 2_000;
export const REPAIR_MARK = '格式修复';
