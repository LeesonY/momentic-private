// A run with real usage far below its token limit must not be denied because
// every reservation asked for the profile's whole 32k reasoning ceiling.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIAdapter } from '@localqa/model-gateway';
import {
  BoundModel,
  OUTPUT_TOKEN_RESERVE,
  reservedOutputTokens,
} from '../dist/index.js';

const profileId = 'c4c0c3c0-c3c0-43c0-83c0-c3c0c3c0c3c0';
const projectId = 'c4c1c3c1-c3c1-43c1-83c1-c3c1c3c1c3c1';
const taskId = 'c4c2c3c2-c3c2-43c2-83c2-c3c2c3c2c3c2';
const runId = 'c4c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';

const document = {
  configuredModelId: 'deepseek-v4.1-flash',
  endpoint: 'https://example.test/v1',
  responseFormat: 'json_object',
  status: 'ready',
  maxOutputTokens: 32000,
};
const gatewayProfile = {
  id: profileId,
  version: 4,
  name: 'mo-budget',
  endpoint: 'https://example.test/v1',
  configuredModelId: 'deepseek-v4.1-flash',
  kind: 'openai_compatible',
  dataBoundary: 'internal',
  capabilities: {
    structuredOutput: true,
    nativeTools: true,
    imageInput: false,
  },
  responseFormat: 'json_object',
  status: 'ready',
  maxOutputTokens: 32000,
  encryptedApiKey: 'cipher',
  approvedFallbackIds: [],
};
const proof = {
  taskId,
  leaseToken: 'mo-budget-lease',
  fencingToken: 3,
  contextVersion: 1,
};

function harness(jobRole = 'executor', bindingKey = jobRole) {
  const reservations = [];
  const job = { role: jobRole, id: taskId, case_id: null };
  const run = {
    id: runId,
    effectiveConfig: { models: { [bindingKey]: { profileId, version: 4 } } },
  };
  const coordinator = {
    async tx(fn) {
      return fn({
        query: async (sql) => {
          if (sql.includes('model_profile_versions'))
            return { rows: [{ document }] };
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
    async reserve(_client, _scope, _proof, _kind, amount) {
      reservations.push(amount);
      return {
        requestId: 'mo-budget-request',
        id: 'mo-budget-reservation',
        amount,
      };
    },
    async settle() {},
  };
  return { coordinator, reservations };
}

const body = (text = '执行这一步。') => ({
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['done'],
    properties: { done: { type: 'boolean' } },
  },
});

test('per-purpose reservation caps keep the profile ceiling only as a bound', () => {
  assert.deepEqual(OUTPUT_TOKEN_RESERVE, {
    plan: 16384,
    summarize: 8192,
    decide: 8192,
    assert: 4096,
    probe: 1024,
  });
  for (const [purpose, cap] of Object.entries(OUTPUT_TOKEN_RESERVE)) {
    assert.equal(reservedOutputTokens(purpose), cap);
    assert.equal(reservedOutputTokens(purpose, cap * 4), cap);
    assert.equal(reservedOutputTokens(purpose, 100), 100);
  }
  // Unknown purposes still get a bounded default rather than the profile cap.
  assert.equal(reservedOutputTokens('unexpected'), 8192);
});

test('a 32k-output profile reserves only the purpose cap and sends it to the provider', async () => {
  const { coordinator, reservations } = harness();
  const bodies = [];
  const adapter = createOpenAIAdapter(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        choices: [
          { finish_reason: 'stop', message: { content: '{"done":true}' } },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 6 },
      }),
      { status: 200 },
    );
  });
  const model = new BoundModel(
    coordinator,
    { workerId: 'mo-budget-worker', projectId },
    {
      adapter,
      profile: async () => gatewayProfile,
      decryptKey: () => 'sim-key-mo-budget-0123456789abcdef',
    },
  );
  // No caller ceiling: the purpose cap bounds both the reservation and request.
  await model.call(proof, 'executor', { purpose: 'decide', ...body() });
  assert.equal(
    bodies.at(-1).max_completion_tokens,
    OUTPUT_TOKEN_RESERVE.decide,
  );
  assert.ok(reservations.at(-1).totalTokens < 32000 + 32000);
  // A caller asking for less keeps its lower ceiling.
  await model.call(proof, 'executor', {
    purpose: 'decide',
    ...body(),
    maxOutputTokens: 180,
  });
  assert.equal(bodies.at(-1).max_completion_tokens, 180);
  assert.ok(reservations.at(-1).totalTokens <= 32000 + 180);

  // A planning call keeps the larger reasoning allowance without the profile cap.
  const planning = harness('coordinator');
  const planBodies = [];
  const planModel = new BoundModel(
    planning.coordinator,
    { workerId: 'mo-budget-worker', projectId },
    {
      adapter: createOpenAIAdapter(async (_url, init) => {
        planBodies.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({
            choices: [
              { finish_reason: 'stop', message: { content: '{"done":true}' } },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 6 },
          }),
          { status: 200 },
        );
      }),
      profile: async () => gatewayProfile,
      decryptKey: () => 'sim-key-mo-budget-0123456789abcdef',
    },
  );
  await planModel.call(proof, 'planner', { purpose: 'plan', ...body() });
  assert.equal(
    planBodies.at(-1).max_completion_tokens,
    OUTPUT_TOKEN_RESERVE.plan,
  );
  assert.ok(planning.reservations.at(-1).totalTokens < 32000 + 32000);
});
