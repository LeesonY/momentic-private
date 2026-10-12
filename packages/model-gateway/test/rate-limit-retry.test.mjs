import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGateway, createOpenAIAdapter } from '../dist/index.js';
const profile = {
  id: 'b3111111-1111-4111-8111-111111111111',
  version: 1,
  name: 'Retry fixture',
  endpoint: 'https://provider.fixture.test/v1',
  configuredModelId: 'fixture',
  kind: 'openai_compatible',
  dataBoundary: 'external',
  capabilities: {
    structuredOutput: true,
    nativeTools: false,
    imageInput: false,
  },
  responseFormat: 'json_object',
  status: 'ready',
  encryptedApiKey: 'fixture',
  approvedFallbackIds: [],
};
const input = {
  taskId: 'b3111111-1111-4111-8111-111111111112',
  profileId: profile.id,
  role: 'executor',
  purpose: 'decide',
  contextVersion: 1,
  promptVersion: 'fixture',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Return done JSON' }] },
  ],
  outputSchema: {
    type: 'object',
    properties: { done: { type: 'boolean' } },
    required: ['done'],
    additionalProperties: false,
  },
  approvedImageIds: [],
  toolSchemas: [],
  timeoutMs: 1000,
};
const response = (status) =>
  status === 200
    ? new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"done":true}' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
        { status },
      )
    : new Response(
        JSON.stringify({ error: { code: 'sticky_key_busy', message: 'busy' } }),
        { status },
      );
function fixture(statuses, retry = { delaysMs: [0, 0] }) {
  let calls = 0;
  const gateway = createGateway({
    profiles: [profile],
    decryptKey: () => 'fixture-key',
    rateLimitRetry: retry,
    adapter: createOpenAIAdapter(async () =>
      response(statuses[Math.min(calls++, statuses.length - 1)]),
    ),
  });
  return { gateway, calls: () => calls };
}
test('429 retry succeeds and counts every provider attempt', async () => {
  const f = fixture([429, 200]);
  const record = await f.gateway.generateDecision(input);
  assert.equal(record.requestResult, 'ok');
  assert.equal(f.calls(), 2);
  assert.equal(record.providerCalls, 2);
  assert.equal(record.requests, 2);
  assert.equal(record.usageSource, 'mixed');
});
test('persistent 429 stops after two retries', async () => {
  const f = fixture([429]);
  const record = await f.gateway.generateDecision(input);
  assert.equal(record.errorCode, 'RATE_LIMITED');
  assert.equal(f.calls(), 3);
  assert.equal(record.requests, 3);
});
test('authentication rejection is not retried', async () => {
  const f = fixture([401, 200]);
  assert.equal(
    (await f.gateway.generateDecision(input)).errorCode,
    'MODEL_NOT_CONFIGURED',
  );
  assert.equal(f.calls(), 1);
});
test('cancellation during backoff prevents another provider request', async () => {
  const controller = new AbortController();
  const f = fixture([429, 200], {
    delaysMs: [500, 500],
    signal: controller.signal,
  });
  const pending = f.gateway.generateDecision(input);
  setTimeout(() => controller.abort(), 10);
  assert.notEqual((await pending).requestResult, 'ok');
  assert.equal(f.calls(), 1);
});
