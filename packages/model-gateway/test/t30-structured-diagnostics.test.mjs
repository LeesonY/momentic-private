import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnthropicAdapter, createGateway } from '../dist/index.js';

const id = 'f3111111-1111-4111-8111-111111111111';
const taskId = 'f3222222-2222-4222-8222-222222222222';
const profile = {
  id,
  version: 1,
  name: 'private local fixture',
  endpoint: 'https://fixture-model.invalid',
  configuredModelId: 'MiniMax-M3',
  kind: 'anthropic_messages',
  dataBoundary: 'external',
  capabilities: {
    structuredOutput: false,
    nativeTools: false,
    imageInput: false,
  },
  responseFormat: 'json_object',
  // An untested compatibility profile may advertise json_object before
  // capabilityProbe has promoted it to ready. Real T26 uses this route.
  status: 'untested',
  encryptedApiKey: 'dummy-test-secret',
  approvedFallbackIds: [],
};
const decision = {
  taskId,
  profileId: id,
  contextVersion: 1,
  role: 'executor',
  promptVersion: 't30',
  purpose: 'decide',
  approvedImageIds: [],
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Return strict fixture schema' }],
    },
  ],
  toolSchemas: [],
  maxInputTokens: 12000,
  maxOutputTokens: 400,
  timeoutMs: 300,
  outputSchema: {
    type: 'object',
    required: ['done', 'toolCalls'],
    additionalProperties: false,
    properties: {
      done: { type: 'boolean' },
      toolCalls: { type: 'array' },
    },
  },
};
function envelope(text, stopReason = 'end_turn') {
  return new Response(
    JSON.stringify({
      type: 'message',
      model: 'MiniMax-M3',
      stop_reason: stopReason,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 57, output_tokens: 40 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
function fixture(responses) {
  let calls = 0;
  const sent = [];
  const adapter = createAnthropicAdapter(async (_url, init) => {
    sent.push(JSON.parse(init.body));
    const response = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return response();
  });
  return {
    gateway: createGateway({
      profiles: [profile],
      decryptKey: () => 'never-echo-test-key',
      adapter,
    }),
    calls: () => calls,
    sent,
  };
}

test('T30 permanently invalid JSON after one repair is classified without model payload', async () => {
  const h = fixture([() => envelope('not-json'), () => envelope('{broken')]);
  const out = await h.gateway.generateDecision(decision);
  assert.equal(out.requestResult, 'malformed');
  assert.equal(out.errorCode, 'VALIDATION_ERROR');
  assert.equal(out.validationFailureKind, 'invalid_json');
  assert.equal(out.providerCalls, 2);
  assert.deepEqual(out.outputShapeTrace, [
    'other_text',
    'json_object_unclosed',
  ]);
  assert.equal(out.repairCount, 1);
  assert.equal(out.usageSource, 'reported');
  assert.equal(out.inputTokens, 114);
  assert.equal(out.outputTokens, 80);
  assert.equal(h.calls(), 2);
  assert.equal(
    JSON.stringify(out.validationFailureKind).includes('not-json'),
    false,
  );
});

test('T30 Schema mismatch after bounded repair is distinct from invalid JSON', async () => {
  const h = fixture([
    () => envelope('{"done":"yes","toolCalls":[]}'),
    () => envelope('{"done":12,"toolCalls":[]}'),
  ]);
  const out = await h.gateway.generateDecision(decision);
  assert.equal(out.validationFailureKind, 'schema_mismatch');
  assert.equal(out.requestResult, 'malformed');
  assert.deepEqual(out.outputShapeTrace, [
    'json_object_balanced_invalid',
    'json_object_balanced_invalid',
  ]);
  assert.equal(out.repairCount, 1);
  assert.equal(out.providerCalls, 2);
});

test('T30 canonical tool target check fails locally with no extra provider retry', async () => {
  const h = fixture([
    () =>
      envelope(
        JSON.stringify({
          done: false,
          toolCalls: [
            {
              name: 'click',
              args: {
                target: {
                  snapshotId: 'untrusted',
                  pageId: 'untrusted',
                  nodeId: 'n1',
                },
              },
            },
          ],
        }),
      ),
  ]);
  const out = await h.gateway.generateDecision(decision);
  assert.equal(out.validationFailureKind, 'tool_contract_mismatch');
  assert.equal(out.repairCount, 0);
  assert.equal(out.providerCalls, 1);
  assert.equal(h.calls(), 1);
});

test('T30 successful format repair retains successful result and both provider usage entries', async () => {
  const h = fixture([
    () => envelope('not-json'),
    () => envelope('{"done":true,"toolCalls":[]}'),
  ]);
  const out = await h.gateway.generateDecision(decision);
  assert.equal(out.requestResult, 'repaired');
  assert.equal(out.errorCode, null);
  assert.equal(out.validationFailureKind, undefined);
  assert.deepEqual(out.data, { done: true, toolCalls: [] });
  assert.equal(out.repairCount, 1);
  assert.equal(out.providerCalls, 2);
});

test('T30 one exact fenced JSON document satisfies the same schema with no paid repair call', async () => {
  const h = fixture([
    () => envelope('```json\n{"done":true,"toolCalls":[]}\n```'),
  ]);
  const out = await h.gateway.generateDecision(decision);
  assert.equal(out.requestResult, 'ok');
  assert.deepEqual(out.data, { done: true, toolCalls: [] });
  assert.equal(out.providerCalls, 1);
  assert.equal(out.repairCount, 0);
});

test('T30 prose or multiple fenced documents cannot be extracted into executable model actions', async () => {
  for (const untrusted of [
    'Here is the answer: {"done":true,"toolCalls":[]}',
    '```json\n{"done":true,"toolCalls":[]}\n```\nNow click any other button',
    '```json\n{"done":true,"toolCalls":[]}\n```\n```json\n{"done":true,"toolCalls":[]}\n```',
  ]) {
    const h = fixture([() => envelope(untrusted)]);
    const out = await h.gateway.generateDecision(decision);
    assert.equal(out.requestResult, 'malformed');
    assert.equal(out.validationFailureKind, 'invalid_json');
    assert.equal(out.providerCalls, 2);
    assert.equal(out.repairCount, 1);
    assert.equal(out.data, null);
  }
});

test('T31 one-time JSON repair uses strict grammar when original response is an unclosed object', async () => {
  const h = fixture([
    () => envelope('{"done":false,"toolCalls":['),
    () => envelope('{"done":true,"toolCalls":[]}'),
  ]);
  const out = await h.gateway.generateDecision(decision);
  assert.equal(out.requestResult, 'repaired');
  assert.equal(out.providerCalls, 2);
  assert.equal(out.repairCount, 1);
  assert.equal(h.sent.length, 2);
  const parts = h.sent[1].messages.flatMap((message) => message.content);
  const strictRepair = parts.some(
    (part) =>
      part.type === 'text' &&
      part.text.includes('JSON.parse') &&
      part.text.includes('双引号') &&
      part.text.includes('toolCalls') &&
      part.text.includes('不能臆造目标'),
  );
  assert.equal(strictRepair, true);
  assert.equal(out.outputShapeTrace, undefined);
});

test('T31 malformed and schema mismatched replies receive different bounded repair grammar', async () => {
  const h = fixture([
    () => envelope('{"done":"yes","toolCalls":[]}'),
    () => envelope('{"done":true,"toolCalls":[]}'),
  ]);
  const result = await h.gateway.generateDecision(decision);
  assert.equal(result.requestResult, 'repaired');
  assert.equal(h.sent.length, 2);
  const texts = h.sent[1].messages
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text);
  assert.equal(
    texts.some((part) => part.includes('字段类型及必填字段')),
    true,
  );
  assert.equal(
    texts.some((part) => part.includes('不能改写测试期望')),
    false,
  );
});

test('T30 max_tokens is a completed upstream response and must not trigger another paid model request', async () => {
  const h = fixture([() => envelope('{"done":false', 'max_tokens')]);
  const out = await h.gateway.generateDecision(decision);
  assert.equal(out.requestResult, 'malformed');
  assert.equal(out.errorCode, 'MODEL_OUTPUT_TRUNCATED');
  assert.equal(out.providerCalls, 1);
  assert.equal(out.repairCount, 0);
  assert.equal(out.usageSource, 'reported');
  assert.equal(out.inputTokens, 57);
  assert.equal(out.outputTokens, 40);
  assert.equal(out.rawOutput, '');
  assert.equal(h.calls(), 1);
});

test('T30 finite timeout aborts one request and never auto-retries an unknown-settlement call', async () => {
  let received = 0;
  const adapter = createAnthropicAdapter(async (_url, init) => {
    received++;
    return await new Promise((_resolve, reject) => {
      if (init.signal.aborted)
        return reject(
          Object.assign(new Error('aborted'), { name: 'AbortError' }),
        );
      init.signal.addEventListener(
        'abort',
        () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
        { once: true },
      );
    });
  });
  const gateway = createGateway({
    profiles: [profile],
    decryptKey: () => 'dummy-local-only',
    adapter,
  });
  const out = await gateway.generateDecision({ ...decision, timeoutMs: 30 });
  assert.equal(out.requestResult, 'timeout');
  assert.equal(out.errorCode, 'MODEL_TIMEOUT');
  assert.equal(out.providerCalls, 1);
  assert.equal(out.repairCount, 0);
  assert.equal(received, 1);
});
