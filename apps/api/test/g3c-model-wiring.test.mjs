import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiServer } from '../dist/index.js';
import { createTestServiceIdentity } from './support/internal-auth.mjs';

// The internal boundary is a peer-only surface. The suite signs its internal
// requests with this ring instead of being exempted from the gate.
const testServiceIdentity = createTestServiceIdentity();

const profileId = 'd3c0d3c0-d3c0-43c0-83d0-d3c0d3c0d3c0';
const projectId = 'd3c1d3c1-d3c1-43c1-83d1-d3c1d3c1d3c1';
const taskId = 'd3c2d3c2-d3c2-43c2-83d2-d3c2d3c2d3c2';
const adminId = 'd3c3d3c3-d3c3-43c3-83d3-d3c3d3c3d3c3';
const wiringKey = 'sim-key-g3c-wiring-abcdef0123456789';

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

function binding(version = 3) {
  return { profileId, version };
}

function runConfig(version = 3) {
  const model = binding(version);
  return {
    allowedOrigins: ['https://fixture.g3c.test'],
    actionPolicy: 'non_submitting',
    budget: budget(),
    environmentVersion: null,
    authProfileVersion: null,
    knowledgeVersionIds: [],
    models: {
      coordinator: model,
      explorer: model,
      executor: model,
      assertion: model,
      reproducer: model,
    },
  };
}

function profileDocument(extra = {}) {
  return {
    id: profileId,
    name: 'g3c-frozen',
    endpoint: 'https://example.test/v1',
    configuredModelId: 'deepseek-chat',
    adapter: 'openai_compatible',
    dataBoundary: 'external',
    capabilities: {
      structuredOutput: true,
      nativeTools: true,
      imageInput: false,
    },
    status: 'ready',
    version: 3,
    ...extra,
  };
}

function decisionEnvelope(content) {
  return JSON.stringify({
    model: 'deepseek-chat',
    choices: [
      { message: { role: 'assistant', content: JSON.stringify(content) } },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 5 },
  });
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

async function request(
  port,
  path,
  { method = 'POST', headers = {}, body } = {},
) {
  // Serialise once so the service-identity signature covers the exact bytes sent.
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  const requestHeaders = { ...headers };
  if (path.startsWith('/internal/')) {
    Object.assign(
      requestHeaders,
      testServiceIdentity.sign('worker', {
        method,
        path,
        body: rawBody,
      }),
    );
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: requestHeaders,
    body: rawBody,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function leaseCoordinator(jobRole, document) {
  const runId = 'd3c6d3c6-d3c6-43c6-83d6-d3c6d3c6d3c6';
  return {
    async tx(fn) {
      return fn({
        query: async (sql, params) => {
          if (sql.includes('model_profile_versions')) {
            if (params?.[1] !== undefined && document.version !== params[1])
              return { rows: [] };
            return { rows: [{ document }] };
          }
          if (sql.includes('FROM artifacts')) return { rows: [] };
          if (sql.includes('budget_reservations'))
            return { rows: [{ status: 'reserved' }] };
          return { rows: [], rowCount: 1 };
        },
      });
    },
    async validateLease() {
      return {
        job: {
          id: taskId,
          role: jobRole,
          case_id: null,
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
          effectiveConfig: runConfig(document.version),
        },
      };
    },
    async reserve() {
      return {
        id: 'd3c7d3c7-d3c7-43c7-83d7-d3c7d3c7d3c7',
        requestId: 'd3c8d3c8-d3c8-43c8-83d8-d3c8d3c8d3c8',
        amount: { modelCalls: 1, totalTokens: 8 },
      };
    },
    async settle() {},
  };
}

function context({
  document,
  transport,
  recordProbe,
  reads,
  jobRole = 'coordinator',
}) {
  const seen = [];
  const modelTransport =
    transport ??
    (async (url, init) => {
      seen.push({
        url: String(url),
        body: JSON.parse(init.body),
        authorization: init.headers.authorization,
      });
      return new Response(decisionEnvelope({ ok: true }), { status: 200 });
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
                    worker_id: 'g3c-worker',
                    fencing_token: '7',
                    context_version: 1,
                  },
                ],
              };
            }
            if (sql.includes('effective_config')) {
              return {
                rows: [
                  {
                    role: jobRole,
                    effective_config: runConfig(document.version),
                  },
                ],
              };
            }
            return { rows: [] };
          },
        }),
    },
    vault: {},
    coordinator: leaseCoordinator(jobRole, document),
    gateway: {
      capabilityProbe() {
        throw new Error('fixed test-stub gateway must not probe');
      },
      complete() {
        throw new Error('fixed test-stub gateway must not complete');
      },
    },
    artifacts: {},
    accountsRepo: {
      authenticate: async () => ({ id: adminId, globalRole: 'admin' }),
    },
    projectRepo: {},
    configRepo: {},
    modelRepo: {
      async get() {
        return document;
      },
      async readVersion(actor, id, version, grantedProject) {
        reads.push({ actor, id, version, grantedProject });
        return { document, apiKey: wiringKey };
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
  return { ctx, seen, reads: reads ?? [] };
}

test('internal complete sends the frozen format and does not switch on HTTP 400', async () => {
  const reads = [];
  const document = profileDocument({
    responseFormat: 'json_object',
    version: 3,
  });
  const seen = [];
  const { ctx } = context({
    document,
    reads,
    transport: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      assert.equal(init.headers.authorization, `Bearer ${wiringKey}`);
      return new Response(
        JSON.stringify({
          error: { message: 'This response_format type is unavailable now' },
        }),
        { status: 400 },
      );
    },
  });
  const result = await withServer(ctx, (port) =>
    request(port, '/internal/v1/model/complete', {
      headers: {
        'content-type': 'application/json',
        'x-lease-token': 'g3c-lease',
      },
      body: {
        taskId,
        profileId,
        contextVersion: 1,
        purpose: 'decide',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '决定下一步。' }],
          },
        ],
        maxOutputTokens: 200,
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
      },
    }),
  );
  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'VALIDATION_ERROR');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, 'deepseek-chat');
  assert.equal(seen[0].response_format.type, 'json_object');
  assert.equal(Object.hasOwn(seen[0], 'tools'), false);
  const serialized = JSON.stringify(seen[0]);
  assert.equal(serialized.includes('image_url'), false);
  assert.equal(serialized.includes('artifact://'), false);
  assert.equal(serialized.includes('submit_case'), true);
  assert.equal(
    serialized.includes('snapshotId') || serialized.includes('submit_case'),
    true,
  );
  assert.equal(reads.length, 1);
  assert.equal(reads[0].version, 3);
  assert.equal(reads[0].grantedProject, projectId);
  assert.equal(serialized.includes(wiringKey), false);
});

test('an old frozen profile stays on json_schema and a mismatched id is not sent', async () => {
  const reads = [];
  const document = profileDocument({ version: 2 });
  delete document.responseFormat;
  const seen = [];
  const { ctx } = context({
    document,
    reads,
    transport: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return new Response(decisionEnvelope({ ok: true }), { status: 200 });
    },
  });
  const ok = await withServer(ctx, (port) =>
    request(port, '/internal/v1/model/complete', {
      headers: {
        'content-type': 'application/json',
        'x-lease-token': 'g3c-lease',
      },
      body: {
        taskId,
        profileId,
        contextVersion: 1,
        purpose: 'decide',
        messages: [
          { role: 'user', content: [{ type: 'text', text: '决定。' }] },
        ],
        maxOutputTokens: 100,
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
      },
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.ok, true);
  assert.equal(ok.body.configuredModelId, 'deepseek-chat');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].response_format.type, 'json_schema');
  assert.equal(seen[0].response_format.json_schema.strict, true);
  assert.equal(seen[0].model, 'deepseek-chat');

  seen.length = 0;
  const mismatch = await withServer(ctx, (port) =>
    request(port, '/internal/v1/model/complete', {
      headers: {
        'content-type': 'application/json',
        'x-lease-token': 'g3c-lease',
      },
      body: {
        taskId,
        profileId: 'd3c5d3c5-d3c5-43c5-83d5-d3c5d3c5d3c5',
        contextVersion: 1,
        purpose: 'decide',
        messages: [
          { role: 'user', content: [{ type: 'text', text: '决定。' }] },
        ],
        maxOutputTokens: 100,
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
      },
    }),
  );
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(seen.length, 0);
});

test('untested, disabled, and missing transport do not call out', async () => {
  const seen = [];
  const transport = async () => {
    seen.push('called');
    throw new Error('network is closed for this test');
  };
  for (const status of ['untested', 'disabled']) {
    const { ctx } = context({
      document: profileDocument({ status, responseFormat: 'json_object' }),
      transport,
      reads: [],
    });
    const result = await withServer(ctx, (port) =>
      request(port, '/internal/v1/model/complete', {
        headers: {
          'content-type': 'application/json',
          'x-lease-token': 'g3c-lease',
        },
        body: {
          taskId,
          profileId,
          contextVersion: 1,
          purpose: 'decide',
          messages: [
            { role: 'user', content: [{ type: 'text', text: '决定。' }] },
          ],
          maxOutputTokens: 50,
          outputSchema: { type: 'object', additionalProperties: false },
        },
      }),
    );
    assert.equal(result.status, 409, status);
    assert.equal(result.body.code, 'MODEL_NOT_CONFIGURED');
  }
  const quietReads = [];
  const quiet = context({
    document: profileDocument({ responseFormat: 'json_schema' }),
    reads: quietReads,
  });
  delete quiet.ctx.modelTransport;
  const missing = await withServer(quiet.ctx, (port) =>
    request(port, '/internal/v1/model/complete', {
      headers: {
        'content-type': 'application/json',
        'x-lease-token': 'g3c-lease',
      },
      body: {
        taskId,
        profileId,
        contextVersion: 1,
        purpose: 'decide',
        messages: [
          { role: 'user', content: [{ type: 'text', text: '决定。' }] },
        ],
        maxOutputTokens: 50,
        outputSchema: { type: 'object', additionalProperties: false },
      },
    }),
  );
  assert.equal(missing.status, 409);
  assert.equal(seen.length, 0);
  assert.equal(quietReads.length, 0);
});

test('probe uses the frozen untested profile and does not invent ready', async () => {
  const writes = [];
  const seen = [];
  const document = profileDocument({
    status: 'untested',
    version: 1,
    responseFormat: 'json_object',
    capabilities: {
      structuredOutput: false,
      nativeTools: false,
      imageInput: false,
    },
  });
  const { ctx } = context({
    document,
    reads: [],
    transport: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return new Response(
        decisionEnvelope({
          structuredOutput: false,
          nativeTools: true,
          imageInput: true,
        }),
        { status: 200 },
      );
    },
    recordProbe: async (_actor, id, version, next) => {
      writes.push({ id, version, next });
      return { ...document, ...next, version: version + 1 };
    },
  });
  const ok = await withServer(ctx, (port) =>
    request(port, `/api/v1/model-profiles/${profileId}/probe`, {
      headers: {
        'content-type': 'application/json',
        cookie: 'session=g3c-admin',
      },
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'degraded');
  assert.notEqual(ok.body.status, 'ready');
  assert.notEqual(ok.body.status, 'disabled');
  assert.equal(ok.body.capabilities.structuredOutput, true);
  assert.equal(ok.body.capabilities.nativeTools, false);
  assert.equal(ok.body.capabilities.imageInput, false);
  assert.match(ok.body.notes.join(''), /未实测/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].response_format.type, 'json_object');
  assert.equal(seen[0].model, 'deepseek-chat');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].version, 1);
  assert.equal(writes[0].next.status, 'degraded');
  assert.equal(writes[0].next.capabilities.structuredOutput, true);
  assert.equal(writes[0].next.capabilities.nativeTools, false);
  assert.equal(writes[0].next.capabilities.imageInput, false);

  seen.length = 0;
  writes.length = 0;
  const failed = context({
    document,
    reads: [],
    transport: async () =>
      new Response(JSON.stringify({ error: { message: 'rejected' } }), {
        status: 400,
      }),
    recordProbe: async () => {
      writes.push('written');
      throw new Error('failed probe must not write');
    },
  });
  const bad = await withServer(failed.ctx, (port) =>
    request(port, `/api/v1/model-profiles/${profileId}/probe`, {
      headers: {
        'content-type': 'application/json',
        cookie: 'session=g3c-admin',
      },
    }),
  );
  assert.notEqual(bad.status, 200);
  assert.notEqual(bad.body.status, 'ready');
  assert.equal(writes.length, 0);

  const closed = context({
    document: profileDocument({ status: 'disabled', version: 4 }),
    reads: [],
    transport: async () => {
      seen.push('disabled-fetch');
      throw new Error('disabled must not fetch');
    },
    recordProbe: async () => {
      writes.push('disabled-write');
      return null;
    },
  });
  const disabled = await withServer(closed.ctx, (port) =>
    request(port, `/api/v1/model-profiles/${profileId}/probe`, {
      headers: {
        'content-type': 'application/json',
        cookie: 'session=g3c-admin',
      },
    }),
  );
  assert.equal(disabled.status, 409);
  assert.equal(disabled.body.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(seen.includes('disabled-fetch'), false);
  assert.equal(writes.includes('disabled-write'), false);

  const bareReads = [];
  const bare = context({
    document,
    reads: bareReads,
    recordProbe: async () => {
      writes.push('bare-write');
      return document;
    },
  });
  delete bare.ctx.modelTransport;
  const noTransport = await withServer(bare.ctx, (port) =>
    request(port, `/api/v1/model-profiles/${profileId}/probe`, {
      headers: {
        'content-type': 'application/json',
        cookie: 'session=g3c-admin',
      },
    }),
  );
  assert.equal(noTransport.status, 409);
  assert.equal(writes.includes('bare-write'), false);
  assert.equal(bareReads.length, 0);
});
