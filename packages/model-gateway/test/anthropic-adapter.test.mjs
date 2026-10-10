import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnthropicAdapter } from '../dist/index.js';

const base = {
  endpoint: 'https://anthropic.test',
  model: 'mofree-m1',
  responseFormat: 'json_object',
  purpose: 'decide',
  outputSchema: { type: 'object' },
  tools: [],
  maxOutputTokens: 128,
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'Return JSON only' }] },
    { role: 'user', content: [{ type: 'text', text: 'Return done=true' }] },
  ],
};
const message = (content, stop_reason = 'end_turn') => ({
  type: 'message',
  model: 'MiniMax-M3',
  stop_reason,
  content,
  usage: { input_tokens: 49, output_tokens: 10 },
});

test('Anthropic Messages request binds secret header and reports actual provider model', async () => {
  let called = 0;
  const adapter = createAnthropicAdapter(async (url, init) => {
    called++;
    assert.equal(url, 'https://anthropic.test/v1/messages');
    assert.equal(init.headers['x-api-key'], 'test-secret-never-log');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    assert.equal(init.headers.authorization, undefined);
    const body = JSON.parse(init.body);
    assert.equal(body.system, 'Return JSON only');
    assert.equal(body.model, 'mofree-m1');
    assert.equal(body.max_tokens, 128);
    assert.equal(body.messages[0].role, 'user');
    return new Response(
      JSON.stringify(
        message([{ type: 'text', text: '{"done":true,"toolCalls":[]}' }]),
      ),
      { status: 200 },
    );
  });
  const built = adapter.build(base);
  const output = await adapter.send(
    { ...built, apiKey: 'test-secret-never-log', model: base.model },
    AbortSignal.timeout(3000),
  );
  assert.equal(called, 1);
  assert.equal(output.errorCode, null);
  assert.deepEqual(JSON.parse(output.raw), { done: true, toolCalls: [] });
  assert.equal(output.reportedModelId, 'MiniMax-M3');
  assert.deepEqual(output.usage, { inputTokens: 49, outputTokens: 10 });
  assert.ok(!JSON.stringify(output).includes('test-secret-never-log'));
});

test('truncated and tool_use responses cannot be considered valid JSON decisions; consumed provider usage is not erased', async () => {
  for (const [body, expectedCode] of [
    [
      message(
        [{ type: 'text', text: '{"done":true,"toolCalls":[]}' }],
        'max_tokens',
      ),
      'MODEL_OUTPUT_TRUNCATED',
    ],
    [
      message([{ type: 'tool_use', name: 'click', input: {} }]),
      'VALIDATION_ERROR',
    ],
  ]) {
    const adapter = createAnthropicAdapter(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    );
    const out = await adapter.send(
      {
        ...adapter.build(base),
        apiKey: 'short',
        model: base.model,
      },
      AbortSignal.timeout(3000),
    );
    assert.equal(out.errorCode, expectedCode);
    assert.deepEqual(out.usage, { inputTokens: 49, outputTokens: 10 });
    assert.equal(
      out.raw,
      '',
      'no partial or non-text model actions must be retained',
    );
    assert.equal(
      out.logSample,
      '',
      'no untrusted body in invalid output diagnostics',
    );
  }
});

test('HTTP errors map conservatively, credentials never enter diagnostics', async () => {
  const adapter = createAnthropicAdapter(
    async () =>
      new Response('{"error":{"message":"invalid key secret"}}', {
        status: 401,
      }),
  );
  const out = await adapter.send(
    {
      ...adapter.build(base),
      model: base.model,
      apiKey: 'secret',
    },
    AbortSignal.timeout(3000),
  );
  assert.equal(out.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.ok(!out.logSample.includes('secret'));
  assert.throws(
    () => adapter.build({ ...base, responseFormat: 'native_tools' }),
    (e) => e.code === 'MODEL_NOT_CONFIGURED',
  );
});
