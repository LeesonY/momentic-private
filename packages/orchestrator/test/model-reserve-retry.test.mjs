// A transient pool timeout while reserving a model call must be retried *before*
// the provider is called, with one reused request id, so the run budget is not
// double-charged and the request is not duplicated.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIAdapter } from '@localqa/model-gateway';
import { DatabaseUnavailableError } from '@localqa/storage';
import { BoundModel } from '../dist/index.js';

const profileId = 'c5c0c3c0-c3c0-43c0-83c0-c3c0c3c0c3c0';
const projectId = 'c5c1c3c1-c3c1-43c1-83c1-c3c1c3c1c3c1';
const taskId = 'c5c2c3c2-c3c2-43c2-83c2-c3c2c3c2c3c2';
const runId = 'c5c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';
const proof = {
  taskId,
  leaseToken: 'mo-retry-lease',
  fencingToken: 3,
  contextVersion: 1,
};

test('the reservation retries a transient database failure with the same request id', async () => {
  const document = {
    configuredModelId: 'deepseek-v4.1-flash',
    endpoint: 'https://example.test/v1',
    responseFormat: 'json_object',
    status: 'ready',
    maxOutputTokens: 32000,
  };
  const reservations = [];
  let reserveAttempts = 0;
  const job = { role: 'executor', id: taskId, case_id: null };
  const run = {
    id: runId,
    effectiveConfig: { models: { executor: { profileId, version: 4 } } },
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
    async reserve(_client, _scope, _proof, _kind, amount, requestId) {
      reserveAttempts++;
      if (reserveAttempts < 3) throw new DatabaseUnavailableError();
      reservations.push({ amount, requestId });
      return {
        requestId,
        id: 'mo-retry-reservation',
        amount,
      };
    },
    async settle() {},
  };
  let providerCalls = 0;
  const model = new BoundModel(
    coordinator,
    { workerId: 'mo-retry-worker', projectId },
    {
      adapter: createOpenAIAdapter(async () => {
        providerCalls++;
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
      profile: async () => ({
        id: profileId,
        version: 4,
        name: 'mo-retry',
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
      }),
      decryptKey: () => 'sim-key-mo-retry-0123456789abcdef',
    },
  );
  const record = await model.call(proof, 'executor', {
    purpose: 'decide',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '执行这一步。' }] },
    ],
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['done'],
      properties: { done: { type: 'boolean' } },
    },
    maxOutputTokens: 180,
  });
  assert.equal(reserveAttempts, 3, 'two transient failures are retried');
  assert.equal(providerCalls, 1, 'the provider is called exactly once');
  assert.equal(reservations.length, 1);
  assert.equal(
    reservations[0].amount.modelCalls,
    1,
    'the retry reuses one reservation instead of double-charging',
  );
  assert.ok(record.requestResult !== undefined);
});
