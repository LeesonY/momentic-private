import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAnthropicAdapter,
  createGateway,
  createOpenAIAdapter,
} from '../dist/index.js';

const profile = {
  id: 'c3111111-1111-4111-8111-111111111111',
  version: 1,
  name: 'MoreSec reasoning probe',
  endpoint: 'https://motoken.moresec.cn:3443',
  configuredModelId: 'deepseek-v4.1-flash',
  kind: 'anthropic_messages',
  dataBoundary: 'external',
  capabilities: {
    structuredOutput: false,
    nativeTools: false,
    imageInput: false,
  },
  responseFormat: 'json_object',
  status: 'untested',
  encryptedApiKey: 'fixture-ciphertext',
  approvedFallbackIds: [],
};
const probeText = JSON.stringify({
  structuredOutput: true,
  nativeTools: true,
  imageInput: true,
});

function anthropicResponse(text, stopReason, outputTokens) {
  return new Response(
    JSON.stringify({
      type: 'message',
      model: profile.configuredModelId,
      stop_reason: stopReason,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 126, output_tokens: outputTokens },
    }),
    { status: 200 },
  );
}

test('probe uses a fixed JSON round trip instead of open-ended capability reasoning', async () => {
  let calls = 0;
  const payload =
    '{"structuredOutput":true,"nativeTools":false,"imageInput":false}';
  const gateway = createGateway({
    profiles: [profile],
    decryptKey: () => 'fixture-key',
    adapter: createAnthropicAdapter(async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      if (
        body.tools ||
        body.messages[0].content.some((part) => part.type === 'image')
      ) {
        return anthropicResponse('{"code":null}', 'end_turn', 8);
      }
      const texts = body.messages
        .flatMap((message) => message.content)
        .map((part) => part.text);
      // The original vague self-assessment can spend the whole budget on
      // reasoning. The measured fixed round trip needs only 52 tokens.
      return texts.length === 1 && texts[0].includes(payload)
        ? anthropicResponse(payload, 'end_turn', 52)
        : anthropicResponse('', 'max_tokens', body.max_tokens);
    }),
  });
  const result = await gateway.capabilityProbe(profile.id, 1000);
  assert.equal(result.requestResult, 'ok');
  assert.equal(result.errorCode, null);
  assert.equal(result.outputTokens, 68);
  assert.equal(calls, 3);
  assert.equal(result.data.capabilities.nativeTools, false);
  assert.equal(result.data.capabilities.imageInput, false);
});

for (const endpoint of [
  'https://motoken.moresec.cn:3443',
  'https://motoken.moresec.cn/v1',
]) {
  test(`MoreSec probe leaves room for reasoning at ${endpoint}`, async () => {
    let calls = 0;
    const gateway = createGateway({
      profiles: [{ ...profile, endpoint }],
      decryptKey: () => 'fixture-key',
      adapter: createAnthropicAdapter(async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        // Reproduce the observed provider: 1495 reasoning tokens and 16
        // answer tokens share max_tokens, even though the JSON is short.
        return body.max_tokens >= 1511
          ? anthropicResponse(probeText, 'end_turn', 1511)
          : anthropicResponse('', 'max_tokens', body.max_tokens);
      }),
    });
    const result = await gateway.capabilityProbe(profile.id, 1000);
    assert.equal(result.requestResult, 'ok');
    assert.equal(result.errorCode, null);
    assert.equal(calls, 3);
    assert.equal(result.outputTokens, 4533);
    // The default per-profile cap leaves room for reasoning tokens.
    assert.equal(JSON.parse(result.outboundRedacted).max_tokens, 4000);
    assert.deepEqual(result.data.capabilities, {
      structuredOutput: true,
      nativeTools: false,
      imageInput: false,
    });
    assert.equal(result.data.status, 'degraded');
  });
}

test('every provider and protocol probes with the profile output cap', async () => {
  for (const [endpoint, kind, configured, expected] of [
    ['https://anthropic-probe.test/v1', 'anthropic_messages', undefined, 4000],
    [
      'https://motoken.moresec.cn:3443/v1',
      'openai_compatible',
      undefined,
      4000,
    ],
    ['https://anthropic-probe.test/v1', 'anthropic_messages', 1024, 1024],
    ['https://motoken.moresec.cn:3443/v1', 'openai_compatible', 8192, 8192],
  ]) {
    let calls = 0;
    const transport = async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      if (kind === 'anthropic_messages') {
        assert.equal(body.max_tokens, expected);
        return anthropicResponse(probeText, 'end_turn', 16);
      }
      assert.equal(body.max_completion_tokens, expected);
      return new Response(
        JSON.stringify({
          model: profile.configuredModelId,
          choices: [{ message: { content: probeText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 126, completion_tokens: 16 },
        }),
        { status: 200 },
      );
    };
    const gateway = createGateway({
      profiles: [
        {
          ...profile,
          endpoint,
          kind,
          ...(configured ? { maxOutputTokens: configured } : {}),
        },
      ],
      decryptKey: () => 'fixture-key',
      adapter:
        kind === 'anthropic_messages'
          ? createAnthropicAdapter(transport)
          : createOpenAIAdapter(transport),
    });
    const result = await gateway.capabilityProbe(profile.id, 1000);
    assert.equal(result.requestResult, 'ok');
    assert.equal(calls, 3);
  }
});

test('MoreSec truncation still fails without retry or accepting partial JSON', async () => {
  let calls = 0;
  const gateway = createGateway({
    profiles: [profile],
    decryptKey: () => 'fixture-key',
    adapter: createAnthropicAdapter(async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      return anthropicResponse(probeText, 'max_tokens', body.max_tokens);
    }),
  });
  const result = await gateway.capabilityProbe(profile.id, 1000);
  assert.equal(result.errorCode, 'MODEL_OUTPUT_TRUNCATED');
  assert.equal(calls, 1);
  assert.equal(result.providerCalls, 1);
  assert.equal(result.repairCount, 0);
  assert.equal(result.outputTokens, 4000);
  assert.equal(result.data, null);
});

test('MoreSec business requests retain the caller output budget', async () => {
  let calls = 0;
  const gateway = createGateway({
    profiles: [profile],
    decryptKey: () => 'fixture-key',
    adapter: createAnthropicAdapter(async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).max_tokens, 400);
      return anthropicResponse('{"done":true,"toolCalls":[]}', 'end_turn', 16);
    }),
  });
  const result = await gateway.generateDecision({
    taskId: 'c3222222-2222-4222-8222-222222222222',
    profileId: profile.id,
    contextVersion: 1,
    role: 'executor',
    promptVersion: 'probe-budget-test',
    purpose: 'decide',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Return JSON' }] },
    ],
    approvedImageIds: [],
    toolSchemas: [],
    outputSchema: {
      type: 'object',
      required: ['done', 'toolCalls'],
      additionalProperties: false,
      properties: {
        done: { type: 'boolean' },
        toolCalls: { type: 'array' },
      },
    },
    timeoutMs: 1000,
    maxOutputTokens: 400,
  });
  assert.equal(result.requestResult, 'ok');
  assert.equal(calls, 1);
});

test('malformed MoreSec endpoint fails during preflight', async () => {
  let calls = 0;
  const gateway = createGateway({
    profiles: [{ ...profile, endpoint: 'not-a-url' }],
    decryptKey: () => 'fixture-key',
    adapter: createAnthropicAdapter(async () => {
      calls++;
      throw new Error('invalid endpoint must not reach transport');
    }),
  });
  const result = await gateway.capabilityProbe(profile.id, 1000);
  assert.equal(result.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('business requests use the profile cap; a caller may only lower it', async () => {
  const seen = [];
  const decide = (configured, maxOutputTokens) =>
    createGateway({
      profiles: [
        { ...profile, ...(configured ? { maxOutputTokens: configured } : {}) },
      ],
      decryptKey: () => 'fixture-key',
      adapter: createAnthropicAdapter(async (_url, init) => {
        seen.push(JSON.parse(init.body).max_tokens);
        return anthropicResponse(
          '{"done":true,"toolCalls":[]}',
          'end_turn',
          16,
        );
      }),
    }).generateDecision({
      taskId: 'c3222222-2222-4222-8222-222222222222',
      profileId: profile.id,
      contextVersion: 1,
      role: 'executor',
      promptVersion: 'probe-budget-test',
      purpose: 'decide',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Return JSON' }] },
      ],
      approvedImageIds: [],
      toolSchemas: [],
      outputSchema: {
        type: 'object',
        required: ['done', 'toolCalls'],
        additionalProperties: false,
        properties: {
          done: { type: 'boolean' },
          toolCalls: { type: 'array' },
        },
      },
      timeoutMs: 1000,
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    });
  for (const [configured, caller] of [
    [undefined, undefined],
    [8192, undefined],
    [1024, 8000],
    [8192, 600],
  ])
    assert.equal((await decide(configured, caller)).requestResult, 'ok');
  assert.deepEqual(seen, [4000, 8192, 1024, 600]);
});
