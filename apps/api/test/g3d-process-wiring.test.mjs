import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { roleToolSchemas } from '../../../packages/orchestrator/dist/index.js';
import {
  createApiContext,
  createApiServer,
  resolveModelTransport,
} from '../dist/index.js';
import { createTestServiceIdentity } from './support/internal-auth.mjs';

// The internal boundary is a peer-only surface. The suite signs its internal
// requests with this ring instead of being exempted from the gate.
const testServiceIdentity = createTestServiceIdentity();

const root = fileURLToPath(new URL('../../../', import.meta.url));
const stubProfileId = '00000000-0000-0000-0000-000000000002';
const coordId = 'd3d0d3d0-d3d0-43d0-83d0-d3d0d3d0d3d0';
const explId = 'd3d1d3d1-d3d1-43d1-83d1-d3d1d3d1d3d1';
const execId = 'd3d2d3d2-d3d2-43d2-83d2-d3d2d3d2d3d2';
const assertId = 'd3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3';
const reproId = 'd3d7d3d7-d3d7-43d7-83d7-d3d7d3d7d3d7';
const projectId = 'd3d4d3d4-d3d4-43d4-83d4-d3d4d3d4d3d4';
const taskId = 'd3d5d3d5-d3d5-43d5-83d5-d3d5d3d5d3d5';
const adminId = 'd3d6d3d6-d3d6-43d6-83d6-d3d6d3d6d3d6';
const caseId = 'd3dbd3db-d3db-43db-83db-d3dbd3dbd3db';
const frozenCriterionId = 'g3d.frozen.semantic';

function budget() {
  return {
    maxCases: 8,
    maxPages: 6,
    maxDepth: 2,
    maxActiveSeconds: 600,
    maxActionsPerCase: 12,
    maxActions: 120,
    maxModelCalls: 100,
    maxReproductions: 3,
    concurrency: 2,
    maxTotalTokens: 300000,
  };
}

function document(id, extra) {
  return {
    id,
    name: extra.name,
    endpoint: 'https://example.test/v1',
    configuredModelId: extra.configuredModelId,
    adapter: 'openai_compatible',
    dataBoundary: 'external',
    capabilities: extra.capabilities ?? {
      structuredOutput: true,
      nativeTools: true,
      imageInput: false,
    },
    status: extra.status ?? 'ready',
    version: extra.version,
    responseFormat: extra.responseFormat,
  };
}

const profiles = {
  [coordId]: document(coordId, {
    name: 'coord',
    configuredModelId: 'coord-model',
    version: 3,
    responseFormat: 'json_schema',
  }),
  [explId]: document(explId, {
    name: 'explorer',
    configuredModelId: 'explore-model',
    version: 7,
    responseFormat: 'json_schema',
    capabilities: {
      structuredOutput: true,
      nativeTools: false,
      imageInput: false,
    },
    status: 'degraded',
  }),
  [execId]: document(execId, {
    name: 'executor',
    configuredModelId: 'exec-model',
    version: 2,
    responseFormat: 'json_schema',
  }),
  [assertId]: document(assertId, {
    name: 'assertion',
    configuredModelId: 'assert-model',
    version: 9,
    responseFormat: 'json_object',
    capabilities: {
      structuredOutput: true,
      nativeTools: false,
      imageInput: false,
    },
    status: 'degraded',
  }),
  [reproId]: document(reproId, {
    name: 'reproducer',
    configuredModelId: 'repro-model',
    version: 4,
    responseFormat: 'json_schema',
  }),
};

function runConfig() {
  return {
    allowedOrigins: ['https://fixture.g3d.test'],
    actionPolicy: 'non_submitting',
    budget: budget(),
    environmentVersion: null,
    authProfileVersion: null,
    knowledgeVersionIds: [],
    models: {
      coordinator: { profileId: coordId, version: 3 },
      explorer: { profileId: explId, version: 7 },
      executor: { profileId: execId, version: 2 },
      assertion: { profileId: assertId, version: 9 },
      reproducer: { profileId: reproId, version: 4 },
    },
  };
}

function outputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  };
}

function leaseCoordinator(jobRole, documents) {
  const runId = 'd3d8d3d8-d3d8-43d8-83d8-d3d8d3d8d3d8';
  return {
    async tx(fn) {
      return fn({
        query: async (sql, params) => {
          if (sql.includes('model_profile_versions')) {
            const current = documents[params?.[0]];
            if (!current || current.version !== params?.[1])
              return { rows: [] };
            return { rows: [{ document: current }] };
          }
          if (sql.includes('FROM artifacts')) return { rows: [] };
          if (sql.includes('budget_reservations'))
            return { rows: [{ status: 'reserved' }] };
          if (sql.includes('run_cases')) {
            const current =
              sql.includes('frozen') &&
              params?.[0] === projectId &&
              params?.[1] === caseId;
            if (!current) return { rows: [] };
            return {
              rows: [
                {
                  document: {
                    criteria: [
                      {
                        id: frozenCriterionId,
                        kind: 'semantic',
                        description:
                          'Frozen criterion checked against the current lease case.',
                        sourceKind: 'user_spec',
                        sourceRef: 'g3d-fixture',
                      },
                    ],
                  },
                },
              ],
            };
          }
          return { rows: [], rowCount: 1 };
        },
      });
    },
    async validateLease() {
      return {
        job: {
          id: taskId,
          role: jobRole,
          case_id: jobRole === 'executor' ? caseId : null,
          run_id: runId,
          document: { summary: 'decide' },
          result: null,
        },
        run: {
          id: runId,
          status: 'running',
          contextVersion: 1,
          terminationReason: null,
          budgetUsed: {
            activeSeconds: 0,
            actions: 0,
            modelCalls: 0,
            reproductions: 0,
            totalTokens: 0,
          },
          effectiveConfig: runConfig(),
        },
      };
    },
    async reserve() {
      return {
        id: 'd3d9d3d9-d3d9-43d9-83d9-d3d9d3d9d3d9',
        requestId: 'd3dad3da-d3da-43da-83da-d3dad3dad3da',
        amount: { modelCalls: 1, totalTokens: 8 },
      };
    },
    async settle() {},
  };
}

function context({
  jobRole,
  transport,
  documents = profiles,
  apiKey = 'present',
  recordProbe,
}) {
  const seen = [];
  const reads = [];
  const modelTransport =
    transport ??
    (async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ error: { message: 'rejected' } }), {
        status: 400,
      });
    });
  const ctx = {
    db: {
      actor: async (_actor, fn) =>
        fn({
          query: async (sql) => {
            if (sql.includes('fencing_token')) {
              return {
                rows: [
                  {
                    id: taskId,
                    project_id: projectId,
                    worker_id: 'g3d-worker',
                    fencing_token: '7',
                    context_version: 1,
                  },
                ],
              };
            }
            if (sql.includes('effective_config')) {
              return {
                rows: [{ role: jobRole, effective_config: runConfig() }],
              };
            }
            return { rows: [] };
          },
        }),
    },
    vault: {},
    coordinator: leaseCoordinator(jobRole, documents),
    gateway: {
      capabilityProbe() {
        throw new Error('context gateway must not probe');
      },
      complete() {
        throw new Error('context gateway must not complete');
      },
    },
    artifacts: {},
    accountsRepo: {
      authenticate: async () => ({ id: adminId, globalRole: 'admin' }),
    },
    projectRepo: {},
    configRepo: {},
    modelRepo: {
      async get(_actor, id) {
        const current = documents[id];
        if (!current) throw new Error('missing profile');
        return current;
      },
      async readVersion(_actor, id, version, grantedProject) {
        reads.push({ id, version, grantedProject });
        const current = documents[id];
        if (!current || current.version !== version)
          throw new Error('missing version');
        return { document: current, apiKey };
      },
      recordProbe:
        recordProbe ??
        (async () => {
          throw new Error('recordProbe was not expected');
        }),
    },
    runRepo: {},
    adminActor: { userId: adminId },
    serviceIdentity: testServiceIdentity.verifier,
    modelTransport,
  };
  return { ctx, seen, reads };
}

async function withServer(ctx, fn) {
  const server = createApiServer(ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    return await fn(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function request(port, path, body) {
  // Serialise once so the service-identity signature covers the exact bytes sent.
  const rawBody = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json',
    'x-lease-token': 'g3d-lease',
  };
  if (path.startsWith('/internal/')) {
    Object.assign(
      headers,
      testServiceIdentity.sign('worker', {
        method: 'POST',
        path,
        body: rawBody,
      }),
    );
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function completeBody(profileId, purpose, messages, criterionId) {
  return {
    taskId,
    profileId,
    contextVersion: 1,
    purpose,
    messages: messages ?? [
      { role: 'user', content: [{ type: 'text', text: '按角色选择。' }] },
    ],
    maxOutputTokens: 100,
    outputSchema: outputSchema(),
    ...(criterionId ? { criterionId } : {}),
  };
}

function toolNames(body) {
  return (body.tools ?? []).map((tool) => tool.function.name).sort();
}

test('process entries use the real transport builder and stub is opt-in', async () => {
  assert.equal(resolveModelTransport(), globalThis.fetch);
  const injected = async () => new Response('no');
  assert.equal(resolveModelTransport(injected), injected);

  const plain = createApiContext({
    connectionString: 'postgresql://localqa:unused@127.0.0.1:1/none',
    vault: {},
  });
  try {
    assert.equal(plain.modelTransport, globalThis.fetch);
    assert.equal(plain.gateway === undefined, false);
    const missing = await plain.gateway.capabilityProbe(stubProfileId);
    assert.equal(missing.errorCode, 'MODEL_NOT_CONFIGURED');
    assert.notEqual(missing.data?.status, 'ready');
  } finally {
    await plain.db.close();
  }

  let stubFetches = 0;
  const transport = async () => {
    stubFetches += 1;
    throw new Error('test stub must not fetch');
  };
  const stubbed = createApiContext({
    connectionString: 'postgresql://localqa:unused@127.0.0.1:1/none',
    vault: {},
    allowTestStub: true,
    modelTransport: transport,
  });
  try {
    assert.equal(stubbed.modelTransport, transport);
    const ready = await stubbed.gateway.capabilityProbe(stubProfileId);
    assert.equal(ready.requestResult, 'ok');
    assert.equal(ready.data.status, 'ready');
    assert.equal(stubFetches, 0);
  } finally {
    await stubbed.db.close();
  }

  const apiEntry = readFileSync(`${root}deploy/images/api-entry.mjs`, 'utf8');
  const apiCall = apiEntry.slice(
    apiEntry.indexOf('const context = createApiContext'),
  );
  assert.equal(apiCall.includes('createApiContext'), true);
  assert.equal(apiCall.includes('allowTestStub'), false);
  assert.equal(apiCall.includes('modelTransport'), false);

  const workerEntry = readFileSync(
    `${root}deploy/images/worker-entry.mjs`,
    'utf8',
  );
  assert.equal(workerEntry.includes('createWorkerModelOptions('), true);
  assert.equal(workerEntry.includes('transport: globalThis.fetch'), true);
  assert.equal(
    workerEntry.includes('modelRepo.readVersion(actor, id, version)'),
    true,
  );
  assert.equal(workerEntry.includes("LOCALQA_ALLOW_TEST_STUB !== '1'"), false);
  assert.equal(workerEntry.includes('new Worker('), true);
});

test('complete selects the lease role binding instead of coordinator', async () => {
  const explorer = context({ jobRole: 'explorer' });
  const wrong = await withServer(explorer.ctx, (port) =>
    request(
      port,
      '/internal/v1/model/complete',
      completeBody(coordId, 'decide'),
    ),
  );
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(explorer.seen.length, 0);
  assert.equal(explorer.reads.length, 0);

  const chosen = await withServer(explorer.ctx, (port) =>
    request(
      port,
      '/internal/v1/model/complete',
      completeBody(explId, 'decide'),
    ),
  );
  assert.equal(chosen.status, 422);
  assert.equal(chosen.body.code, 'VALIDATION_ERROR');
  assert.equal(explorer.seen.length, 1);
  assert.equal(explorer.seen[0].model, 'explore-model');
  assert.equal(explorer.seen[0].response_format.type, 'json_schema');
  assert.deepEqual(
    toolNames(explorer.seen[0]),
    roleToolSchemas('explorer')
      .map((tool) => tool.name)
      .sort(),
  );
  assert.equal(explorer.reads.length, 1);
  assert.equal(explorer.reads[0].id, explId);
  assert.equal(explorer.reads[0].version, 7);
  assert.notEqual(explorer.seen[0].model, 'coord-model');

  const assertion = context({ jobRole: 'executor' });
  const assertWrong = await withServer(assertion.ctx, (port) =>
    request(
      port,
      '/internal/v1/model/complete',
      completeBody(execId, 'assert'),
    ),
  );
  assert.equal(assertWrong.status, 409);
  assert.equal(assertWrong.body.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(assertion.seen.length, 0);

  const assertOk = await withServer(assertion.ctx, (port) =>
    request(
      port,
      '/internal/v1/model/complete',
      completeBody(assertId, 'assert', undefined, frozenCriterionId),
    ),
  );
  assert.equal(assertOk.status, 422);
  assert.equal(assertion.seen.length, 1);
  assert.equal(assertion.seen[0].model, 'assert-model');
  assert.equal(assertion.seen[0].response_format.type, 'json_object');
  assert.equal(Object.hasOwn(assertion.seen[0], 'tools'), false);
  const assertSent = JSON.stringify(assertion.seen[0]);
  assert.equal(assertSent.includes(frozenCriterionId), true);
  assert.equal(assertSent.includes('g3d-fixture'), true);
  assert.equal(assertSent.includes('user_spec'), true);
  assert.equal(
    assertSent.includes(
      'Frozen criterion checked against the current lease case.',
    ),
    true,
  );
  assert.equal(assertSent.includes('smoke.visible'), false);
  assert.equal(assertion.reads[0].version, 9);
  assert.equal(assertion.reads[0].id, assertId);

  const coordinator = context({ jobRole: 'coordinator' });
  const coord = await withServer(coordinator.ctx, (port) =>
    request(
      port,
      '/internal/v1/model/complete',
      completeBody(coordId, 'decide'),
    ),
  );
  assert.equal(coord.status, 422);
  assert.equal(coordinator.seen.length, 1);
  assert.equal(coordinator.seen[0].model, 'coord-model');
  assert.equal(coordinator.seen[0].response_format.json_schema.strict, true);
  assert.deepEqual(
    toolNames(coordinator.seen[0]),
    roleToolSchemas('coordinator')
      .map((tool) => tool.name)
      .sort(),
  );
  assert.equal(coordinator.reads[0].version, 3);
});

test('provider errors keep their registered codes and do not complete', async () => {
  const rate = context({
    jobRole: 'coordinator',
    transport: async (_url, init) => {
      rate.seen.push(JSON.parse(init.body));
      return new Response('{"error":"slow down"}', { status: 429 });
    },
  });
  const limited = await withServer(rate.ctx, (port) =>
    request(
      port,
      '/internal/v1/model/complete',
      completeBody(coordId, 'decide'),
    ),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.equal(rate.seen.length, 1);
  assert.equal(limited.body.data, undefined);

  const timed = context({
    jobRole: 'coordinator',
    transport: async () => {
      timed.seen.push('called');
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  const timeout = await withServer(timed.ctx, (port) =>
    request(
      port,
      '/internal/v1/model/complete',
      completeBody(coordId, 'decide'),
    ),
  );
  assert.equal(timeout.status, 500);
  assert.equal(timeout.body.code, 'MODEL_TIMEOUT');
  assert.equal(timed.seen.length, 1);
  assert.notEqual(timeout.status, 200);

  const huge = context({ jobRole: 'coordinator' });
  const budgetHit = await withServer(huge.ctx, (port) =>
    request(
      port,
      '/internal/v1/model/complete',
      completeBody(coordId, 'decide', [
        { role: 'user', content: [{ type: 'text', text: 'x'.repeat(60000) }] },
      ]),
    ),
  );
  assert.equal(budgetHit.status, 500);
  assert.equal(budgetHit.body.code, 'BUDGET_EXCEEDED');
  assert.equal(huge.seen.length, 0);

  const quiet = context({ jobRole: 'coordinator', apiKey: null });
  const missing = await withServer(quiet.ctx, (port) =>
    request(
      port,
      '/internal/v1/model/complete',
      completeBody(coordId, 'decide'),
    ),
  );
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(quiet.seen.length, 0);
});

test('json_object stays strict and a failed probe can be retried', async () => {
  const calls = [];
  const invalid = context({
    jobRole: 'executor',
    transport: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          model: 'assert-model',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({ ok: 'nope' }),
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
        { status: 200 },
      );
    },
  });
  const bad = await withServer(invalid.ctx, (port) =>
    request(
      port,
      '/internal/v1/model/complete',
      completeBody(assertId, 'assert', undefined, frozenCriterionId),
    ),
  );
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, 'VALIDATION_ERROR');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].response_format.type, 'json_object');
  assert.equal(calls[1].response_format.type, 'json_object');
  assert.equal(calls[0].model, 'assert-model');
  assert.equal(calls[1].model, 'assert-model');
  assert.equal(bad.body.data, undefined);

  const writes = [];
  const probes = [];
  const untested = document(coordId, {
    name: 'coord',
    configuredModelId: 'coord-model',
    version: 3,
    responseFormat: 'json_schema',
    status: 'untested',
    capabilities: {
      structuredOutput: false,
      nativeTools: false,
      imageInput: false,
    },
  });
  const retry = context({
    jobRole: 'coordinator',
    documents: { ...profiles, [coordId]: untested },
    transport: async () => {
      probes.push('fetch');
      return new Response(JSON.stringify({ error: { message: 'rejected' } }), {
        status: 400,
      });
    },
    recordProbe: async () => {
      writes.push('written');
      return untested;
    },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await withServer(retry.ctx, (port) =>
      fetch(`http://127.0.0.1:${port}/api/v1/model-profiles/${coordId}/probe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'session=g3d-admin',
        },
      }).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    );
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'VALIDATION_ERROR');
    assert.notEqual(result.body.status, 'ready');
    assert.notEqual(result.body.status, 'disabled');
  }
  assert.equal(probes.length, 2);
  assert.equal(writes.length, 0);
});
