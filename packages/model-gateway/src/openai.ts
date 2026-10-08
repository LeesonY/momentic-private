import type { ModelMessage } from '@localqa/contracts';
import type {
  ProviderAdapter,
  ProviderResponse,
  StructuredOutputMode,
} from './adapter.js';
import { hideSecret, redactText } from './redact.js';

export const OPENAI_ADAPTER_VERSION = 'openai-compatible.2';

/** Diagnostic logs keep this prefix. It is not a parse input. */
export const OPENAI_DIAGNOSTIC_SAMPLE_CHARS = 2_000;

/**
 * Largest provider body that can be parsed as a completion.
 * A longer body fails closed. It is not sliced and then treated as success.
 */
export const OPENAI_RESPONSE_CHAR_LIMIT = 65_536;

export interface OpenAIToolSchema {
  name: string;
  parameters: Record<string, unknown>;
}

export interface OpenAICallShape {
  model: string;
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  outputSchema: Record<string, unknown>;
  tools: readonly OpenAIToolSchema[];
  responseFormat?: StructuredOutputMode;
  imageUrls?: Readonly<Record<string, string>>;
}

const IMAGE_DATA =
  /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** https or an image data URL we produced from approved bytes. */
export function legalImageUrl(url: string): boolean {
  return url.startsWith('https://') || IMAGE_DATA.test(url);
}

export function imageDataUrl(
  mediaType: string,
  bytes: Uint8Array,
): string | null {
  if (
    mediaType !== 'image/png' &&
    mediaType !== 'image/jpeg' &&
    mediaType !== 'image/gif' &&
    mediaType !== 'image/webp'
  ) {
    return null;
  }
  if (bytes.byteLength === 0) return null;
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function partToOpenAI(
  part: ModelMessage['content'][number],
  imageUrls: Readonly<Record<string, string>>,
): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text };
  const url = imageUrls[part.artifactId];
  if (!url || !legalImageUrl(url)) {
    throw Object.assign(new Error('MODEL_NOT_CONFIGURED'), {
      code: 'MODEL_NOT_CONFIGURED',
    });
  }
  return { type: 'image_url', image_url: { url } };
}

/**
 * OpenAI chat-completions field names stay in this adapter.
 * max_completion_tokens, response_format and function tools are not reused
 * as the gateway's internal request.
 */
export function toOpenAIChatRequest(
  input: OpenAICallShape,
): Record<string, unknown> {
  const mode = input.responseFormat ?? 'json_schema';
  const imageUrls = input.imageUrls ?? {};
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages.map((message) => ({
      role: message.role === 'tool' ? 'user' : message.role,
      content: message.content.map((part) => partToOpenAI(part, imageUrls)),
    })),
    max_completion_tokens: input.maxOutputTokens,
  };
  if (mode === 'json_schema') {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: {
        name: 'localqa_output',
        strict: true,
        schema: input.outputSchema,
      },
    };
  } else if (mode === 'json_object') {
    body['response_format'] = { type: 'json_object' };
  }
  if (mode !== 'json_object' && input.tools.length > 0) {
    body['tools'] = input.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, parameters: tool.parameters },
    }));
  }
  return body;
}

export function assertHttpsEndpoint(endpoint: string): void {
  if (!endpoint.startsWith('https://')) {
    throw Object.assign(new Error('MODEL_NOT_CONFIGURED'), {
      code: 'MODEL_NOT_CONFIGURED',
    });
  }
}

export function diagnosticSample(text: string): string {
  return text.slice(0, OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
}

/**
 * hideSecret only removes a complete secret. A body cut on the parse cap can
 * end with a prefix of that secret; drop the prefix before the log is sampled.
 */
export function stripTrailingSecretPrefix(
  text: string,
  secret: string,
): string {
  if (!secret || secret.length < 2 || !text) return text;
  const max = Math.min(secret.length - 1, text.length);
  for (let size = max; size > 0; size -= 1) {
    if (text.endsWith(secret.slice(0, size))) {
      return `${text.slice(0, text.length - size)}[redacted]`;
    }
  }
  return text;
}

/** Redact the retained body, then keep the diagnostic prefix. */
export function redactThenSample(
  text: string,
  apiKey: string,
  overLimit = false,
): string {
  const retained = overLimit ? stripTrailingSecretPrefix(text, apiKey) : text;
  return diagnosticSample(hideSecret(redactText(retained), apiKey));
}

function boundedText(text: string): { text: string; overLimit: boolean } {
  if (text.length > OPENAI_RESPONSE_CHAR_LIMIT) {
    return {
      text: text.slice(0, OPENAI_RESPONSE_CHAR_LIMIT),
      overLimit: true,
    };
  }
  return { text, overLimit: false };
}

/**
 * Read the provider body until the parse bound.
 * Over-limit text is the retained bound, not a log sample. Callers redact it
 * before sampling. The extra streamed chunk is not kept.
 */
export async function readBoundedBody(
  response: Response,
): Promise<{ text: string; overLimit: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return boundedText(await response.text());
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > OPENAI_RESPONSE_CHAR_LIMIT) {
        await reader.cancel().catch(() => undefined);
        return boundedText(text);
      }
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return boundedText(text);
}

function completionFields(text: string): {
  reportedModelId: string | null;
  usage: ProviderResponse['usage'];
} {
  const parsed = JSON.parse(text) as {
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const reportedModelId =
    typeof parsed.model === 'string' ? parsed.model : null;
  const usage =
    parsed.usage &&
    typeof parsed.usage.prompt_tokens === 'number' &&
    typeof parsed.usage.completion_tokens === 'number'
      ? {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
        }
      : null;
  return { reportedModelId, usage };
}

/** Map an HTTP status onto a §7 code. 2xx is a completion and returns null. */
export function httpStatusError(status: number): ProviderResponse['errorCode'] {
  if (status >= 200 && status < 300) return null;
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'MODEL_NOT_CONFIGURED';
  if (status >= 400 && status < 500) return 'VALIDATION_ERROR';
  return 'SERVICE_UNAVAILABLE';
}

export function createOpenAIAdapter(fetchImpl: typeof fetch): ProviderAdapter {
  return {
    kind: 'openai_compatible',
    version: OPENAI_ADAPTER_VERSION,
    build(input) {
      assertHttpsEndpoint(input.endpoint);
      const base = input.endpoint.replace(/\/$/, '');
      return {
        endpoint: base.endsWith('/chat/completions')
          ? base
          : `${base}/chat/completions`,
        body: toOpenAIChatRequest(input),
      };
    },
    async send(input, signal): Promise<ProviderResponse> {
      const transportError = (error: unknown): Error => {
        const aborted =
          signal.aborted ||
          (error instanceof Error && error.name === 'AbortError');
        return Object.assign(
          new Error(aborted ? 'MODEL_TIMEOUT' : 'SERVICE_UNAVAILABLE'),
          { code: aborted ? 'MODEL_TIMEOUT' : 'SERVICE_UNAVAILABLE' },
        );
      };
      let response: Response;
      let bounded: { text: string; overLimit: boolean };
      try {
        response = await fetchImpl(input.endpoint, {
          method: 'POST',
          signal,
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(input.body),
        });
        bounded = await readBoundedBody(response);
      } catch (error) {
        throw transportError(error);
      }
      const statusError = httpStatusError(response.status);
      const logSample = redactThenSample(
        bounded.text,
        input.apiKey,
        bounded.overLimit,
      );
      if (bounded.overLimit) {
        return {
          raw: '',
          logSample,
          httpStatus: response.status,
          reportedModelId: null,
          usage: null,
          errorCode: statusError ?? 'BUDGET_EXCEEDED',
        };
      }
      if (statusError) {
        return {
          raw: bounded.text,
          logSample,
          httpStatus: response.status,
          reportedModelId: null,
          usage: null,
          errorCode: statusError,
        };
      }
      let reportedModelId: string | null = null;
      let usage: ProviderResponse['usage'];
      try {
        const fields = completionFields(bounded.text);
        reportedModelId = fields.reportedModelId;
        usage = fields.usage;
      } catch {
        usage = null;
      }
      return {
        raw: bounded.text,
        logSample,
        httpStatus: response.status,
        reportedModelId,
        usage,
        errorCode: null,
      };
    },
  };
}
