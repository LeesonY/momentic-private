import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIAdapter } from '@localqa/model-gateway';
import { StorageError } from '@localqa/storage';
import { BoundModel, roleToolSchemas } from '../dist/index.js';

const profileId = 'c3c0c3c0-c3c0-43c0-83c0-c3c0c3c0c3c0';
const projectId = 'c3c1c3c1-c3c1-43c1-83c1-c3c1c3c1c3c1';
const taskId = 'c3c2c3c2-c3c2-43c2-83c2-c3c2c3c2c3c2';
const runId = 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';

function document(extra = {}) {
  return {
    configuredModelId: 'deepseek-chat',
    endpoint: 'https://example.test/v1',
    responseFormat: 'json_object',
    status: 'ready',
    ...extra,
  };
}

function gatewayProfile(extra = {}) {
  return {
    id: profileId,
    version: 4,
    name: 'g3c-bound',
    endpoint: 'https://example.test/v1',
    configuredModelId: 'deepseek-chat',
    kind: 'openai_compatible',
    dataBoundary: 'external',
    capabilities: {
      structuredOutput: true,
      nativeTools: true,
      imageInput: false,
    },
    responseFormat: 'json_object',
    status: 'ready',
    encryptedApiKey: 'cipher',
    approvedFallbackIds: [],
    ...extra,
  };
}

function coordinator(row) {
  const job = { role: 'executor', id: taskId, case_id: null };
  const run = {
    id: runId,
    effectiveConfig: { models: { executor: { profileId, version: 4 } } },
  };
  return {
    async tx(fn) {
      return fn({
        query: async (sql) => {
          if (sql.includes('model_profile_versions'))
            return { rows: [{ document: row }] };
          if (sql.includes('FROM artifacts')) return { rows: [] };
          if (sql.includes('budget_reservations'))
            return { rows: [{ status: 'settled' }] };
          return { rowCount: 1, rows: [] };
        },
      });
    },
    async validateLease() {
      return { job, run };
    },
    async reserve() {
      return {
        requestId: 'g3c-request',
        id: 'g3c-reservation',
        amount: { modelCalls: 1, totalTokens: 8 },
      };
    },
    async settle() {},
  };
}

function payload() {
  return {
    purpose: 'decide',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '执行这一步。' }] },
    ],
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['toolCalls', 'done'],
      properties: {
        done: { type: 'boolean' },
        toolCalls: { type: 'array' },
      },
    },
    maxOutputTokens: 200,
  };
}

const proof = {
  taskId,
  leaseToken: 'g3c-lease',
  fencingToken: 3,
  contextVersion: 1,
};

test('BoundModel sends the frozen format and real ToolCall parameters', async () => {
  const click = roleToolSchemas('executor').find(
    (tool) => tool.name === 'click',
  );
  assert.ok(click);
  assert.equal(JSON.stringify(click.parameters).includes('"$ref"'), false);
  assert.equal(
    click.parameters.properties.target.properties.snapshotId.format,
    'uuid',
  );
  assert.deepEqual(roleToolSchemas('planner'), []);
  assert.deepEqual(roleToolSchemas('assertion'), []);

  const bodies = [];
  const adapter = createOpenAIAdapter(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        error: { message: 'This response_format type is unavailable now' },
      }),
      { status: 400 },
    );
  });
  const model = new BoundModel(
    coordinator(document()),
    { workerId: 'g3c-worker', projectId },
    {
      adapter,
      profile: async () => gatewayProfile(),
      decryptKey: () => 'sim-key-g3c-bound-0123456789abcdef',
    },
  );
  const record = await model.call(proof, 'executor', payload());
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, 'deepseek-chat');
  assert.equal(bodies[0].response_format.type, 'json_object');
  assert.equal(Object.hasOwn(bodies[0], 'tools'), false);
  const hinted = bodies[0].messages
    .flatMap((message) => message.content)
    .map((part) => part.text ?? '')
    .join('\n');
  assert.equal(hinted.includes('"format":"uuid"'), true);
  assert.equal(hinted.includes('snapshotId'), true);
  assert.equal(record.errorCode, 'VALIDATION_ERROR');
  assert.equal(record.providerCalls, 1);
  assert.equal(record.fallbackUsed, false);
  assert.equal(hinted.includes('sim-key-g3c-bound-0123456789abcdef'), false);
});

test('BoundModel refuses a format, status, or model that is not the frozen row', async () => {
  let calls = 0;
  const adapter = createOpenAIAdapter(async () => {
    calls += 1;
    throw new Error('mismatched profile must not send');
  });
  const scope = { workerId: 'g3c-worker', projectId };
  const options = {
    adapter,
    profile: async () => gatewayProfile({ responseFormat: 'json_schema' }),
    decryptKey: () => 'sim-key-g3c-bound-0123456789abcdef',
  };
  await assert.rejects(
    () =>
      new BoundModel(
        coordinator(document({ responseFormat: 'json_object' })),
        scope,
        options,
      ).call(proof, 'executor', payload()),
    (error) =>
      error instanceof StorageError && error.code === 'MODEL_NOT_CONFIGURED',
  );
  await assert.rejects(
    () =>
      new BoundModel(coordinator(document({ status: 'untested' })), scope, {
        ...options,
        profile: async () => gatewayProfile(),
      }).call(proof, 'executor', payload()),
    (error) =>
      error instanceof StorageError && error.code === 'MODEL_NOT_CONFIGURED',
  );
  await assert.rejects(
    () =>
      new BoundModel(coordinator(document({ status: 'disabled' })), scope, {
        ...options,
        profile: async () => gatewayProfile(),
      }).call(proof, 'executor', payload()),
    (error) =>
      error instanceof StorageError && error.code === 'MODEL_NOT_CONFIGURED',
  );
  assert.equal(calls, 0);
});
