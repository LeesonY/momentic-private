import { randomBytes } from 'node:crypto';
import type {
  CapabilityProbeInput,
  CapabilityProbeResponse,
  ProviderAdapter,
} from './adapter.js';
import {
  assertHttpsEndpoint,
  httpStatusError,
  readBoundedBody,
} from './openai.js';
import { createProbeImage } from './probe-image.js';
import { estimateTokens } from './usage.js';

const toolName = 'localqa_probe_echo';

/** No dispatcher, tool handler, artifact resolver, or business data is used. */
export async function probeProviderCapability(
  fetchImpl: typeof fetch,
  kind: Exclude<ProviderAdapter['kind'], 'stub'>,
  input: CapabilityProbeInput,
  signal: AbortSignal,
  imageFactory: typeof createProbeImage = createProbeImage,
): Promise<CapabilityProbeResponse> {
  const native = input.capability === 'nativeTools';
  const label = native ? '原生工具调用' : '图片输入';
  const result: CapabilityProbeResponse = {
    supported: false,
    note: `${label}探测未通过。`,
    errorCode: null,
    usage: null,
    reportedModelId: null,
    providerCalls: 0,
    estimatedInputTokens: 0,
  };
  try {
    assertHttpsEndpoint(input.endpoint, input.dataBoundary);
    const token = randomBytes(8).toString('hex');
    const image = native ? null : imageFactory();
    const prompt = native
      ? `请仅调用一次 ${toolName}，参数 token 必须是 "${token}"。不要文本回答。`
      : '读取图片中的 8 位数字（保留开头的零），仅返回 JSON {"code":"读到的数字"}。不能读取则返回 {"code":null}，不要猜测或解释。';
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['token'],
      properties: { token: { type: 'string' } },
    };
    const anthropic = kind === 'anthropic_messages';
    const base = input.endpoint.replace(/\/+$/, '');
    const endpoint = anthropic
      ? base.endsWith('/v1/messages')
        ? base
        : base.endsWith('/v1')
          ? `${base}/messages`
          : `${base}/v1/messages`
      : base.endsWith('/chat/completions')
        ? base
        : `${base}/chat/completions`;
    const content: unknown[] = [{ type: 'text', text: prompt }];
    if (image) {
      content.push(
        anthropic
          ? {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: image.dataUrl.split(',')[1],
              },
            }
          : { type: 'image_url', image_url: { url: image.dataUrl } },
      );
    }
    const body = {
      model: input.model,
      ...(anthropic
        ? { max_tokens: input.maxOutputTokens }
        : { max_completion_tokens: input.maxOutputTokens }),
      messages: [{ role: 'user', content }],
      ...(native
        ? anthropic
          ? {
              tools: [
                {
                  name: toolName,
                  description: 'Echo a probe token. Never executed.',
                  input_schema: schema,
                },
              ],
              tool_choice: { type: 'auto' },
            }
          : {
              tools: [
                {
                  type: 'function',
                  function: {
                    name: toolName,
                    description: 'Echo a probe token. Never executed.',
                    parameters: schema,
                  },
                },
              ],
              tool_choice: 'auto',
            }
        : anthropic
          ? {}
          : { response_format: { type: 'json_object' } }),
    };
    result.estimatedInputTokens = estimateTokens(JSON.stringify(body)) ?? 1;
    if (
      input.maxInputTokens !== undefined &&
      result.estimatedInputTokens > input.maxInputTokens
    ) {
      result.errorCode = 'BUDGET_EXCEEDED';
      result.note = `${label}探测的输入与输出预算超过模型上下文窗口。`;
      return result;
    }
    result.providerCalls = 1;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      signal,
      headers: anthropic
        ? {
            'x-api-key': input.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          }
        : {
            authorization: `Bearer ${input.apiKey}`,
            'content-type': 'application/json',
          },
      body: JSON.stringify(body),
    });
    const bounded = await readBoundedBody(response);
    const statusError = httpStatusError(response.status);
    if (statusError) {
      result.note = `${label}探测请求被拒绝（HTTP ${response.status}）。`;
      // A capability-specific 400 is a failed capability test; auth,
      // billing, rate limits and service failures must not overwrite caps.
      result.errorCode =
        statusError === 'VALIDATION_ERROR' ? null : statusError;
      return result;
    }
    if (bounded.overLimit) {
      result.errorCode = 'BUDGET_EXCEEDED';
      return result;
    }
    const envelope = JSON.parse(bounded.text);
    result.reportedModelId =
      typeof envelope.model === 'string' ? envelope.model : null;
    const usage = envelope.usage;
    const inTokens = anthropic ? usage?.input_tokens : usage?.prompt_tokens;
    const outTokens = anthropic
      ? usage?.output_tokens
      : usage?.completion_tokens;
    if (
      Number.isSafeInteger(inTokens) &&
      inTokens >= 0 &&
      Number.isSafeInteger(outTokens) &&
      outTokens >= 0
    )
      result.usage = { inputTokens: inTokens, outputTokens: outTokens };
    const choice = envelope.choices?.[0];
    if (
      anthropic
        ? envelope.stop_reason === 'max_tokens'
        : choice?.finish_reason === 'length'
    ) {
      result.errorCode = 'MODEL_OUTPUT_TRUNCATED';
      return result;
    }
    if (native) {
      const calls = anthropic
        ? Array.isArray(envelope.content)
          ? envelope.content.filter(
              (part: { type?: string }) => part.type === 'tool_use',
            )
          : []
        : (choice?.message?.tool_calls ?? []);
      const call = calls[0];
      const args = anthropic
        ? call?.input
        : JSON.parse(call?.function?.arguments ?? 'null');
      result.supported =
        (anthropic
          ? envelope.type === 'message' && envelope.stop_reason === 'tool_use'
          : choice?.finish_reason === 'tool_calls') &&
        Array.isArray(calls) &&
        calls.length === 1 &&
        typeof call?.id === 'string' &&
        call.id.length > 0 &&
        (anthropic
          ? call.name === toolName
          : call.type === 'function' && call.function?.name === toolName) &&
        args !== null &&
        typeof args === 'object' &&
        !Array.isArray(args) &&
        Object.keys(args).length === 1 &&
        args.token === token;
      result.note = result.supported
        ? '原生工具调用探测通过：返回的工具名称与随机参数匹配，未执行任何工具。'
        : '原生工具调用探测未通过：未返回匹配的原生工具调用。';
    } else {
      const parts = envelope.content;
      const complete = anthropic
        ? envelope.type === 'message' &&
          envelope.stop_reason === 'end_turn' &&
          Array.isArray(parts) &&
          parts.every(
            (part: { type?: string; text?: unknown }) =>
              part.type === 'text' && typeof part.text === 'string',
          )
        : choice?.finish_reason === 'stop';
      const text = anthropic
        ? Array.isArray(parts)
          ? parts.map((part: { text?: string }) => part.text ?? '').join('\n')
          : ''
        : choice?.message?.content;
      const answer = JSON.parse(text ?? 'null');
      result.supported =
        complete &&
        answer !== null &&
        typeof answer === 'object' &&
        !Array.isArray(answer) &&
        Object.keys(answer).length === 1 &&
        answer.code === image!.code;
      result.note = result.supported
        ? '图片输入探测通过：读图结果与图片内的随机数字匹配。'
        : '图片输入探测未通过：读图结果未匹配图片内的随机数字。';
    }
  } catch (error) {
    result.errorCode =
      signal.aborted || (error instanceof Error && error.name === 'AbortError')
        ? 'MODEL_TIMEOUT'
        : error instanceof SyntaxError
          ? null
          : error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'MODEL_NOT_CONFIGURED'
            ? 'MODEL_NOT_CONFIGURED'
            : 'SERVICE_UNAVAILABLE';
  }
  return result;
}
