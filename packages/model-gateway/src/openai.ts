import type { ModelMessage } from '@localqa/contracts';
import type { ProviderAdapter, ProviderResponse } from './adapter.js';

export const OPENAI_ADAPTER_VERSION = 'openai-compatible.1';

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
}

function partToOpenAI(part: ModelMessage['content'][number]): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text };
  return {
    type: 'image_url',
    image_url: { url: `artifact://${part.artifactId}` },
  };
}

/**
 * OpenAI chat-completions field names stay in this adapter.
 * max_completion_tokens, response_format and function tools are not reused
 * as the gateway's internal request.
 */
export function toOpenAIChatRequest(input: OpenAICallShape): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages.map((message) => ({
      role: message.role === 'tool' ? 'user' : message.role,
      content: message.content.map(partToOpenAI),
    })),
    max_completion_tokens: input.maxOutputTokens,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'localqa_output',
        strict: true,
        schema: input.outputSchema,
      },
    },
  };
  if (input.tools.length > 0) {
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
        endpoint: base.endsWith('/chat/completions') ? base : `${base}/chat/completions`,
        body: toOpenAIChatRequest(input),
      };
    },
    async send(input, signal): Promise<ProviderResponse> {
      let response: Response;
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
      } catch (error) {
        const aborted = signal.aborted || (error instanceof Error && error.name === 'AbortError');
        throw Object.assign(new Error(aborted ? 'MODEL_TIMEOUT' : 'SERVICE_UNAVAILABLE'), {
          code: aborted ? 'MODEL_TIMEOUT' : 'SERVICE_UNAVAILABLE',
        });
      }
      const raw = (await response.text()).slice(0, 2000);
      const errorCode = httpStatusError(response.status);
      if (errorCode) {
        return { raw, httpStatus: response.status, reportedModelId: null, usage: null, errorCode };
      }
      let reportedModelId: string | null = null;
      let usage: ProviderResponse['usage'] = null;
      try {
        const parsed = JSON.parse(raw) as {
          model?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        reportedModelId = typeof parsed.model === 'string' ? parsed.model : null;
        if (parsed.usage && typeof parsed.usage.prompt_tokens === 'number' && typeof parsed.usage.completion_tokens === 'number') {
          usage = {
            inputTokens: parsed.usage.prompt_tokens,
            outputTokens: parsed.usage.completion_tokens,
          };
        }
      } catch {
        usage = null;
      }
      return { raw, httpStatus: response.status, reportedModelId, usage, errorCode: null };
    },
  };
}
