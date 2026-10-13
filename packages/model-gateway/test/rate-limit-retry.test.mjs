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

test('format repair shares the original deadline rather than resetting it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let readyFirst,
    readySecond,
    calls = 0;
  const first = new Promise((resolve) => {
    readyFirst = resolve;
  });
  const second = new Promise((resolve) => {
    readySecond = resolve;
  });
  const gateway = createGateway({
    profiles: [profile],
    decryptKey: () => 'fixture-key',
    adapter: createOpenAIAdapter(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const call = ++calls;
          init.signal.addEventListener(
            'abort',
            () =>
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              ),
            { once: true },
          );
          setTimeout(
            () =>
              resolve(
                call === 1
                  ? new Response(
                      JSON.stringify({
                        choices: [
                          {
                            finish_reason: 'stop',
                            message: { content: 'invalid JSON' },
                          },
                        ],
                      }),
                      { status: 200 },
                    )
                  : response(200),
              ),
            700,
          );
          if (call === 1) readyFirst();
          else readySecond();
        }),
    ),
  });
  const pending = gateway.generateDecision(input);
  await first;
  t.mock.timers.tick(700);
  await second;
  t.mock.timers.tick(300);
  const record = await pending;
  assert.equal(record.errorCode, 'MODEL_TIMEOUT');
  assert.equal(record.repairCount, 1);
  assert.equal(calls, 2);
});
