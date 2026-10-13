import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIAdapter } from '@localqa/model-gateway';
import { StorageError } from '@localqa/storage';
import { BoundModel, modelCallTimeoutMs } from '../dist/index.js';

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

function coordinator(row, role = 'executor') {
  const job = { role, id: taskId, case_id: null };
  const run = {
    id: runId,
    effectiveConfig: {
      models: {
        [role === 'coordinator' || role === 'finalizer' ? 'coordinator' : role]:
          { profileId, version: 4 },
      },
    },
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

const success = () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: '{"done":true,"toolCalls":[]}' },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 8 },
    }),
    { status: 200 },
  );
function fixture(role, transport) {
  const diagnostics = [];
  const settled = [];
  const state = coordinator(document(), role);
  const original = state.tx;
  state.tx = (fn) =>
    original((client) =>
      fn({
        query: async (sql, args) => {
          if (sql.includes('INSERT INTO model_requests'))
            diagnostics.push(args[6]);
          if (
            sql.includes('UPDATE model_requests') &&
            sql.includes('$2::jsonb')
          )
            diagnostics.push(JSON.parse(args[1]));
          return client.query(sql, args);
        },
      }),
    );
  state.settle = async (...args) => settled.push(args.at(-1));
  const model = new BoundModel(
    state,
    { workerId: 'timeout-fixture', projectId },
    {
      adapter: createOpenAIAdapter(transport),
      profile: async () => gatewayProfile(),
      decryptKey: () => 'owned-timeout-fixture-key',
    },
  );
  return { model, state, diagnostics, settled };
}
function hanging() {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const transport = (_url, init) =>
    new Promise((_resolve, reject) => {
      started();
      const abort = () =>
        reject(
          Object.assign(new Error('transport aborted'), { name: 'AbortError' }),
        );
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    });
  return { ready, transport };
}
test('planning can complete after 30 seconds; planning and summaries use the 120 second deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = fixture(
    'coordinator',
    (_url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
        setTimeout(() => resolve(success()), 45000);
        started();
      }),
  );
  const pending = f.model.call(proof, 'planner', {
    ...payload(),
    purpose: 'plan',
  });
  await ready;
  t.mock.timers.tick(45000);
  const record = await pending;
  assert.equal(record.requestResult, 'ok');
  assert.equal(f.diagnostics[0].timeoutMs, 120000);
  assert.equal(modelCallTimeoutMs('summarize'), 120000);
});
test('a 60 second ordinary call timeout retains its error and unknown usage', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const transport = hanging();
  const f = fixture('executor', transport.transport);
  const pending = f.model.call(proof, 'executor', payload());
  await transport.ready;
  t.mock.timers.tick(60001);
  const record = await pending;
  assert.equal(record.errorCode, 'MODEL_TIMEOUT');
  assert.equal(record.requestResult, 'timeout');
  assert.ok(
    f.diagnostics.some(
      (d) => d.errorCode === 'MODEL_TIMEOUT' && d.timeoutMs === 60000,
    ),
  );
  assert.ok(f.settled.includes('unknown'));
});
test('user cancellation stops a planning call immediately, without mislabeling it as a timeout', async () => {
  const transport = hanging();
  const f = fixture('coordinator', transport.transport);
  const controller = new AbortController();
  const pending = f.model.call(
    proof,
    'planner',
    { ...payload(), purpose: 'plan' },
    undefined,
    controller.signal,
  );
  await transport.ready;
  controller.abort();
  await pending;
  assert.ok(f.diagnostics.some((d) => d.errorCode === 'CANCELLED'));
  assert.equal(
    f.diagnostics.some((d) => d.errorCode === 'MODEL_TIMEOUT'),
    false,
  );
});
test('longer deadlines do not bypass exhausted run budgets', async () => {
  let calls = 0;
  const f = fixture('coordinator', async () => {
    calls++;
    return success();
  });
  f.state.reserve = async () => {
    throw new StorageError('BUDGET_EXCEEDED');
  };
  await assert.rejects(
    () => f.model.call(proof, 'planner', { ...payload(), purpose: 'plan' }),
    (e) => e.code === 'BUDGET_EXCEEDED',
  );
  assert.equal(calls, 0);
});
