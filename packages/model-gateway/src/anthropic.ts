import type { ModelMessage } from '@localqa/contracts';
import type { ProviderAdapter, ProviderResponse } from './adapter.js';
import { probeProviderCapability } from './capability-probe.js';
import {
  assertHttpsEndpoint,
  httpStatusError,
  legalImageUrl,
  readBoundedBody,
  redactThenSample,
} from './openai.js';

export const ANTHROPIC_ADAPTER_VERSION = 'anthropic-messages.1';

/**
 * Anthropic Messages and proxies implementing that wire protocol.
 * The gateway still supplies bounded, redacted, schema-checked model input;
 * this adapter never dispatches tools or grants browser authority.
 */
export function createAnthropicAdapter(
  fetchImpl: typeof fetch,
): ProviderAdapter {
  return {
    kind: 'anthropic_messages',
    version: ANTHROPIC_ADAPTER_VERSION,
    probeCapability(input, signal) {
      return probeProviderCapability(
        fetchImpl,
        'anthropic_messages',
        input,
        signal,
      );
    },
    build(input) {
      assertHttpsEndpoint(input.endpoint, input.dataBoundary);
      // Tool/response shape is instructed in the prompt. This adapter does
      // not claim JSON-Schema or native-tools capability on behalf of a proxy.
      if (input.responseFormat !== 'json_object') {
        throw Object.assign(new Error('MODEL_NOT_CONFIGURED'), {
          code: 'MODEL_NOT_CONFIGURED',
        });
      }
      const systems: string[] = [];
      const messages: Array<{
        role: 'user' | 'assistant';
        content: unknown[];
      }> = [];
      for (const message of input.messages) {
        const parts = message.content.map(
          (part: ModelMessage['content'][number]) => {
            if (part.type === 'text') return { type: 'text', text: part.text };
            const url = input.imageUrls?.[part.artifactId];
            if (!url || !legalImageUrl(url))
              throw Object.assign(new Error('MODEL_NOT_CONFIGURED'), {
                code: 'MODEL_NOT_CONFIGURED',
              });
            const data =
              /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
                url,
              );
            return {
              type: 'image',
              source: data
                ? { type: 'base64', media_type: data[1], data: data[2] }
                : { type: 'url', url },
            };
          },
        );
        if (message.role === 'system') {
          // System messages cannot be nested inside Anthropic Messages.
          if (parts.some((part) => part.type !== 'text'))
            throw Object.assign(new Error('VALIDATION_ERROR'), {
              code: 'VALIDATION_ERROR',
            });
          systems.push(
            parts.map((part) => (part as { text: string }).text).join('\n'),
          );
          continue;
        }
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        // An internal tool receipt is *not* an Anthropic tool_result. It is
        // untrusted context text from our own audited dispatcher.
        const previous = messages.at(-1);
        if (previous?.role === role) previous.content.push(...parts);
        else messages.push({ role, content: [...parts] });
      }
      if (!messages.length) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: '仅输出 JSON。' }],
        });
      }
      const endpoint = input.endpoint.replace(/\/+$/, '');
      return {
        endpoint: endpoint.endsWith('/v1/messages')
          ? endpoint
          : endpoint.endsWith('/v1')
            ? `${endpoint}/messages`
            : `${endpoint}/v1/messages`,
        body: {
          model: input.model,
          max_tokens: input.maxOutputTokens,
          ...(systems.length ? { system: systems.join('\n') } : {}),
          messages,
        },
      };
    },
    async send(input, signal): Promise<ProviderResponse> {
      let response: Response;
      let bounded: Awaited<ReturnType<typeof readBoundedBody>>;
      try {
        response = await fetchImpl(input.endpoint, {
          method: 'POST',
          signal,
          headers: {
            'x-api-key': input.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify(input.body),
        });
        bounded = await readBoundedBody(response);
      } catch (error) {
        const aborted =
          signal.aborted ||
          (error instanceof Error && error.name === 'AbortError');
        throw Object.assign(
          new Error(aborted ? 'MODEL_TIMEOUT' : 'SERVICE_UNAVAILABLE'),
          {
            code: aborted ? 'MODEL_TIMEOUT' : 'SERVICE_UNAVAILABLE',
          },
        );
      }
      const statusError = httpStatusError(response.status);
      const logSample = redactThenSample(
        bounded.text,
        input.apiKey,
        bounded.overLimit,
      );
      if (statusError || bounded.overLimit) {
        return {
          raw: bounded.overLimit ? '' : bounded.text,
          logSample,
          httpStatus: response.status,
          reportedModelId: null,
          usage: null,
          errorCode: statusError ?? 'BUDGET_EXCEEDED',
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bounded.text);
      } catch {
        parsed = null;
      }
      const body = parsed as {
        type?: unknown;
        model?: unknown;
        stop_reason?: unknown;
        content?: unknown;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      } | null;
      const content = body && Array.isArray(body.content) ? body.content : [];
      const complete =
        body?.type === 'message' &&
        body.stop_reason === 'end_turn' &&
        content.length > 0 &&
        content.every(
          (part) =>
            part &&
            typeof part === 'object' &&
            (part as { type?: unknown; text?: unknown }).type === 'text' &&
            typeof (part as { text?: unknown }).text === 'string',
        );
      const usage = body?.usage;
      const validUsage =
        Number.isSafeInteger(usage?.input_tokens) &&
        Number(usage?.input_tokens) >= 0 &&
        Number.isSafeInteger(usage?.output_tokens) &&
        Number(usage?.output_tokens) >= 0;
      const reportedUsage = validUsage
        ? {
            inputTokens: Number(usage!.input_tokens),
            outputTokens: Number(usage!.output_tokens),
          }
        : null;
      if (body?.type === 'message' && body.stop_reason === 'max_tokens') {
        // The provider has definitively returned and may have charged
        // tokens. This is NOT invalid user JSON or a transport timeout.
        // Do not accept any possibly truncated actions and do not retry.
        return {
          raw: '',
          logSample: '',
          httpStatus: response.status,
          reportedModelId: typeof body.model === 'string' ? body.model : null,
          usage: reportedUsage,
          errorCode: 'MODEL_OUTPUT_TRUNCATED',
        };
      }
      if (!complete) {
        return {
          raw: '',
          logSample: '',
          httpStatus: response.status,
          reportedModelId: typeof body?.model === 'string' ? body.model : null,
          usage: reportedUsage,
          errorCode: 'VALIDATION_ERROR',
        };
      }
      const raw = content
        .map((part) => (part as { text: string }).text)
        .join('\n');
      // A successful response must not introduce executable tool_use blocks.
      return {
        raw,
        logSample: redactThenSample(raw, input.apiKey),
        httpStatus: response.status,
        reportedModelId: typeof body?.model === 'string' ? body.model : null,
        usage: reportedUsage,
        errorCode: null,
      };
    },
  };
}
