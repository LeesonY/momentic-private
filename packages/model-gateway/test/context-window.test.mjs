import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  modelContextTokenLimit,
  validModelTokenBudget,
  validateContract,
} from '@localqa/contracts';
import {
  createGateway,
  createOpenAIAdapter,
  createAnthropicAdapter,
  estimateTokens,
} from '../dist/index.js';
import { createFrozenGateway } from '../../../apps/api/dist/frozen-model.js';
import { createWorkerModelOptions } from '../../orchestrator/dist/process-model.js';

const profile = {
  id: 'c3111111-1111-4111-8111-111111111111',
  version: 1,
  name: 'Owned context wire',
  endpoint: 'https://context.fixture.test/v1',
  configuredModelId: 'context-wire',
  kind: 'openai_compatible',
  dataBoundary: 'internal',
  status: 'ready',
  responseFormat: 'json_schema',
  capabilities: {
    structuredOutput: true,
    nativeTools: false,
    imageInput: false,
  },
  encryptedApiKey: 'owned-key-marker',
  approvedFallbackIds: [],
};
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['done'],
  properties: { done: { type: 'boolean' } },
};
const text = (role, content) => ({
  role,
  content: [{ type: 'text', text: content }],
});
const input = (messages) => ({
  taskId: 'c3222222-2222-4222-8222-222222222222',
  profileId: profile.id,
  contextVersion: 1,
  role: 'executor',
  promptVersion: 'context-test',
  purpose: 'decide',
  messages,
  approvedImageIds: [],
  toolSchemas: [],
  outputSchema: schema,
  timeoutMs: 1000,
});
const response = (content = '{"done":true}') =>
  new Response(
    JSON.stringify({
      model: profile.configuredModelId,
      choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }),
    { status: 200 },
  );
const wire = (config, transport) =>
  createGateway({
    profiles: [{ ...profile, ...config }],
    decryptKey: () => 'owned-wire-key',
    adapter: createOpenAIAdapter(transport),
  });

test('default preserves the old 12k input budget; context validation covers the shared relationship', () => {
  assert.equal(modelContextTokenLimit(), 16000);
  assert.equal(modelContextTokenLimit({ maxOutputTokens: 32000 }), 44000);
  assert.equal(validModelTokenBudget({ contextWindowTokens: 4000 }), false);
  assert.equal(
    validModelTokenBudget({ contextWindowTokens: 8192, maxOutputTokens: 1024 }),
    true,
  );
  for (const value of [0, 1023, 2000001, 8000.5])
    assert.equal(
      validateContract('ModelProfilePatch', {
        expectedVersion: 1,
        contextWindowTokens: value,
      }).success,
      false,
    );
  assert.equal(
    validateContract('ModelProfilePatch', {
      expectedVersion: 1,
      contextWindowTokens: null,
    }).success,
    true,
  );
});

test('configured large window preserves a newest task above the former 12k cap', async () => {
  const latest = 'LATEST ' + 'x'.repeat(60000);
  let body;
  const result = await wire(
    { contextWindowTokens: 128000 },
    async (_url, init) => {
      body = JSON.parse(init.body);
      return response();
    },
  ).generateDecision(input([text('system', 'SYSTEM'), text('user', latest)]));
  assert.equal(result.requestResult, 'ok');
  assert.ok(JSON.stringify(body).includes(latest));
  assert.ok(
    estimateTokens(JSON.stringify(body)) + body.max_completion_tokens <= 128000,
  );
});

test('small window trims old messages while retaining instructions and newest task', async () => {
  for (const responseFormat of ['json_schema', 'json_object']) {
    let body;
    const result = await wire(
      { contextWindowTokens: 8192, maxOutputTokens: 2048, responseFormat },
      async (_url, init) => {
        body = JSON.parse(init.body);
        return response();
      },
    ).generateDecision({
      ...input([
        text('system', 'SYSTEM'),
        text('user', 'OLD ' + 'x'.repeat(13000)),
        text('user', 'LATEST'),
      ]),
      outputSchema: { ...schema, description: 'x'.repeat(12000) },
    });
    assert.equal(result.requestResult, 'ok');
    assert.ok(JSON.stringify(body).includes('SYSTEM'));
    assert.ok(JSON.stringify(body).includes('LATEST'));
    assert.equal(JSON.stringify(body).includes('OLD'), false);
    assert.ok(
      estimateTokens(JSON.stringify(body)) + body.max_completion_tokens <= 8192,
    );
  }
});

test('caller cannot bypass a profile window or silently discard the newest task', async () => {
  let calls = 0;
  const result = await wire({ contextWindowTokens: 8192 }, async () => {
    calls++;
    return response();
  }).generateDecision({
    ...input([text('system', 'SYSTEM'), text('user', 'x'.repeat(50000))]),
    maxInputTokens: 200000,
  });
  assert.equal(result.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(result.providerCalls, 0);
  assert.equal(result.requests, 0);
  assert.equal(calls, 0);
});

test('schema overhead and repair requests obey the total context window', async () => {
  let calls = 0;
  const messages = [text('system', 'SYSTEM'), text('user', 'Return JSON')];
  const largeSchema = { ...schema, description: 'schema ' + 'x'.repeat(6000) };
  const adapter = createOpenAIAdapter(async () => {
    calls++;
    return response('invalid');
  });
  const first = adapter.build({
    endpoint: profile.endpoint,
    model: profile.configuredModelId,
    purpose: 'decide',
    messages,
    outputSchema: largeSchema,
    tools: [],
    maxOutputTokens: 1024,
    responseFormat: 'json_schema',
    imageUrls: {},
  });
  const window = estimateTokens(JSON.stringify(first.body)) + 1024 + 32;
  const result = await createGateway({
    profiles: [
      { ...profile, contextWindowTokens: window, maxOutputTokens: 1024 },
    ],
    decryptKey: () => 'owned-wire-key',
    adapter,
  }).generateDecision({ ...input(messages), outputSchema: largeSchema });
  assert.equal(result.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(
    calls,
    1,
    'a repair that no longer fits must not reach the provider',
  );
  assert.equal(result.providerCalls, 1);
  assert.equal(result.requests, 1);
});

test('API and Worker bindings carry the frozen context value and previous versions remain independent', async () => {
  const document = {
    ...profile,
    adapter: 'openai_compatible',
    contextWindowTokens: 128000,
  };
  delete document.kind;
  delete document.encryptedApiKey;
  delete document.approvedFallbackIds;
  let body;
  const frozen = createFrozenGateway(
    { document, apiKey: 'owned-wire-key' },
    async (_url, init) => {
      body = JSON.parse(init.body);
      return response();
    },
  );
  const result = await frozen.generateDecision(
    input([text('system', 'SYSTEM'), text('user', 'x'.repeat(60000))]),
  );
  assert.equal(result.requestResult, 'ok');
  assert.ok(JSON.stringify(body).length > 60000);
  const options = createWorkerModelOptions({
    load: async (_id, version) => ({
      document: {
        ...document,
        version,
        contextWindowTokens: version === 1 ? 128000 : 32000,
      },
      apiKey: 'owned-wire-key',
    }),
  });
  assert.equal(
    (await options.profile(profile.id, 1)).contextWindowTokens,
    128000,
  );
  assert.equal(
    (await options.profile(profile.id, 2)).contextWindowTokens,
    32000,
  );
});

test('native and image capability probes check the configured input/output sum', async () => {
  const seen = [];
  const small = {
    ...profile,
    kind: 'anthropic_messages',
    responseFormat: 'json_object',
    contextWindowTokens: 1024,
    maxOutputTokens: 256,
  };
  const gateway = createGateway({
    profiles: [small],
    decryptKey: () => 'owned-wire-key',
    adapter: createAnthropicAdapter(async (_url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      const content = body.tools
        ? '{"code":null}'
        : '{"structuredOutput":true,"nativeTools":false,"imageInput":false}';
      return new Response(
        JSON.stringify({
          type: 'message',
          model: profile.configuredModelId,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: content }],
          usage: { input_tokens: 20, output_tokens: 10 },
        }),
        { status: 200 },
      );
    }),
  });
  const result = await gateway.capabilityProbe(profile.id, 1000);
  assert.equal(result.errorCode, null);
  assert.equal(seen.length, 3);
  assert.ok(
    seen.every(
      (body) => estimateTokens(JSON.stringify(body)) + body.max_tokens <= 1024,
    ),
  );
  const adapter = createAnthropicAdapter(async () => {
    assert.fail(
      'a capability probe above its input budget must not be transmitted',
    );
  });
  for (const capability of ['nativeTools', 'imageInput']) {
    const blocked = await adapter.probeCapability(
      {
        endpoint: profile.endpoint,
        model: profile.configuredModelId,
        apiKey: 'owned-wire-key',
        capability,
        maxOutputTokens: 256,
        maxInputTokens: 1,
      },
      new AbortController().signal,
    );
    assert.equal(blocked.errorCode, 'BUDGET_EXCEEDED');
    assert.equal(blocked.providerCalls, 0);
  }
});
