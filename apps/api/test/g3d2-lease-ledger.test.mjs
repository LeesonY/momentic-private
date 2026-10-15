import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import {
  AccountsRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  SecretVault,
  StorageError,
  migrate,
} from '@localqa/storage';
import {
  BoundModel,
  createWorkerModelOptions,
} from '../../../packages/orchestrator/dist/index.js';
import { createApiContext, createApiServer } from '../dist/index.js';
import { createTestServiceIdentity } from './support/internal-auth.mjs';

// The internal boundary is a peer-only surface. The suite signs its internal
// requests with this ring instead of being exempted from the gate.
const testServiceIdentity = createTestServiceIdentity();

const tag = randomUUID().slice(0, 8);
const container = `localqa-g3d4-pg-${tag}`;
const dir = `/tmp/localqa-g3d4-${tag}`;
const ownedRef = '33333333-3333-4333-8333-333333333333';
const unknownRef = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const password = randomBytes(24).toString('hex');
const keyV1 = `g3d2-v1-${randomUUID()}`;
const keyV2 = `g3d2-v2-${randomUUID()}`;
const workerId = 'g3d2-worker';

mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(
  `${dir}/pg.env`,
  `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
  { mode: 0o600 },
);
writeFileSync(
  `${dir}/kek.json`,
  JSON.stringify({
    activeVersion: 1,
    keys: { 1: randomBytes(32).toString('base64') },
  }),
  { mode: 0o600 },
);

const calls = [];
let raceHold = Promise.resolve();
let raceFetches = 0;
let connection;
let raw;
let db;
let vault;
let models;
let api;
let server;
let port = 0;
let created = false;
let admin;
let project;
let frozenVersion = 0;
let latestModelId = '';
const runs = {};
const criterionIds = {
  current: 'g3d3.current.semantic',
  other: 'g3d3.other.semantic',
  foreign: 'g3d3.foreign.semantic',
  unknown: 'g3d3.unknown.semantic',
  decoy: 'g3d3.message.decoy',
};

function limits(extra = {}) {
  return {
    maxCases: 8,
    maxPages: 6,
    maxDepth: 2,
    maxActiveSeconds: 600,
    maxActionsPerCase: 12,
    maxActions: 120,
    maxModelCalls: 20,
    maxReproductions: 3,
    concurrency: 2,
    maxTotalTokens: 300000,
    ...extra,
  };
}

function used(extra = {}) {
  return {
    activeSeconds: 0,
    actions: 0,
    modelCalls: 0,
    reproductions: 0,
    totalTokens: 0,
    ...extra,
  };
}

function configFor(profileId, version, budget) {
  const binding = { profileId, version };
  return {
    allowedOrigins: ['https://fixture.g3d2.test'],
    actionPolicy: 'non_submitting',
    budget,
    environmentVersion: null,
    authProfileVersion: null,
    knowledgeVersionIds: [],
    models: {
      coordinator: binding,
      explorer: binding,
      executor: binding,
      assertion: binding,
      reproducer: binding,
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

function criterionRow(id, extra = {}) {
  return {
    id,
    kind: 'semantic',
    description: 'Frozen criterion checked against the current lease case.',
    sourceKind: 'user_spec',
    sourceRef: 'g3d3-fixture',
    ...extra,
  };
}

function judgmentSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['criterionId', 'result', 'evidenceRefs'],
    properties: {
      criterionId: { type: 'string' },
      result: { type: 'string' },
      reason: { type: 'string' },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
    },
  };
}

function caseDocument(id, runId, criteria, regression) {
  return {
    id,
    runId,
    projectId: project.id,
    version: 1,
    title: 'g3d3 criterion',
    summary: 'frozen criterion check',
    preconditions: [],
    outline: ['observe the current case'],
    criteria,
    ...(regression ? { regression } : {}),
  };
}

function regressionDocument(id) {
  return {
    schemaVersion: 1,
    kind: 'localqa/test',
    id,
    name: 'g3d3 regression',
    criteria: [criterionRow(criterionIds.current)],
    steps: [{ kind: 'navigate', url: 'https://fixture.g3d3.test/' }],
  };
}

function regressionBinding() {
  const sha = 'ab'.repeat(32);
  return {
    sourceVersionId: randomUUID(),
    sourceDocumentSha256: sha,
    document: regressionDocument('g3d3.regression'),
    moduleSnapshots: [
      {
        projectId: project.id,
        name: 'g3d3/module',
        version: 1,
        sha256: sha,
        document: regressionDocument('g3d3.module'),
        reviewStatus: 'approved',
      },
    ],
  };
}

function withCurrentCase(extra = {}) {
  const current = randomUUID();
  const other = randomUUID();
  return {
    role: 'executor',
    caseId: current,
    cases: [
      { id: current, frozen: true, criteria: [criterionIds.current] },
      { id: other, frozen: true, criteria: [criterionIds.other] },
    ],
    ...extra,
  };
}

function withStoredCriterion(criterionExtra) {
  const spec = withCurrentCase();
  spec.cases[0].criterionExtra = criterionExtra;
  return spec;
}

function judgmentCompletion(modelId, payload) {
  return JSON.stringify({
    model: modelId,
    choices: [
      {
        message: {
          role: 'assistant',
          content: JSON.stringify(payload),
        },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 4 },
  });
}

function judgmentFor(text, modelId) {
  const claim = {
    criterionId: criterionIds.current,
    result: 'passed',
    reason: 'provider claims pass',
    evidenceRefs: [],
  };
  if (text.includes('G3D4-MISS') || text.includes('G3D4-VALUE'))
    return judgmentCompletion(modelId, claim);
  if (text.includes('G3D4-FAKE'))
    return judgmentCompletion(modelId, {
      ...claim,
      evidenceRefs: [unknownRef],
    });
  if (text.includes('G3D4-OWNED'))
    return judgmentCompletion(modelId, { ...claim, evidenceRefs: [ownedRef] });
  return null;
}

function outboundText(body) {
  const parts = [];
  for (const message of body?.messages ?? []) {
    const content = message.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === 'string') parts.push(part.text);
      }
    }
  }
  return parts.join('\n');
}

function completion(modelId) {
  return JSON.stringify({
    model: modelId,
    choices: [
      {
        message: { role: 'assistant', content: JSON.stringify({ ok: true }) },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 4 },
  });
}

function callsFor(marker) {
  return calls.filter((call) => JSON.stringify(call.body).includes(marker));
}

function same(left, right) {
  return (
    typeof left === 'string' && left.length === right.length && left === right
  );
}

async function seedRun(spec) {
  const runId = randomUUID();
  const taskId = randomUUID();
  const token = `g3d2-${randomUUID()}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const budget = spec.budget ?? limits();
  const profileId = spec.profileId;
  const version = spec.version;
  const until = new Date(Date.now() + (spec.expired ? -120_000 : 600_000));
  const role = spec.role ?? 'coordinator';
  const caseId = spec.caseId ?? null;
  const task = {
    id: taskId,
    runId,
    role,
    status: spec.jobStatus ?? 'running',
    caseId,
    attempt: 1,
    summary: spec.summary ?? 'decide',
    elapsedSeconds: 0,
  };
  await raw.query(
    `INSERT INTO runs(id,project_id,creator_id,display_url,status,phase,completion,context_version,version,effective_config,budget_used)
     VALUES($1,$2,$3,'https://fixture.g3d2.test/',$4,'execute','none',$5,1,$6,$7)`,
    [
      runId,
      project.id,
      admin.id,
      spec.runStatus ?? 'running',
      spec.contextVersion ?? 1,
      configFor(profileId, version, budget),
      used(),
    ],
  );
  await raw.query(
    'INSERT INTO run_budgets(project_id,run_id,limits,used,reserved) VALUES($1,$2,$3,$4,$5)',
    [project.id, runId, spec.rowLimits ?? budget, spec.rowUsed ?? used(), {}],
  );
  for (const item of spec.cases ?? []) {
    const criteria = item.criteria.map((id) =>
      criterionRow(id, item.criterionExtra),
    );
    await raw.query(
      `INSERT INTO run_cases(id,project_id,run_id,document,criteria_hash,frozen)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        item.id,
        project.id,
        runId,
        caseDocument(item.id, runId, criteria, item.regression),
        createHash('sha256')
          .update(`${item.id}:${item.criteria.join(',')}`)
          .digest('hex'),
        item.frozen,
      ],
    );
  }
  await raw.query(
    `INSERT INTO jobs(id,project_id,run_id,case_id,unique_key,role,status,attempt,document,worker_id,lease_until,fencing_token)
     VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,1)`,
    [
      taskId,
      project.id,
      runId,
      caseId,
      `g3d2-${taskId}`,
      role,
      spec.jobStatus ?? 'running',
      task,
      workerId,
      until,
    ],
  );
  await raw.query(
    `INSERT INTO task_leases(id,project_id,task_id,worker_id,fencing_token,token_hash,lease_until,released_at)
     VALUES($1,$2,$3,$4,1,$5,$6,$7)`,
    [
      randomUUID(),
      project.id,
      taskId,
      workerId,
      hash,
      until,
      spec.released ? new Date() : null,
    ],
  );
  return { runId, taskId, token, caseId };
}

async function post(run, marker, token = run.token, extra = {}) {
  // Serialise once so the service-identity signature covers the exact bytes sent.
  const rawBody = JSON.stringify({
    taskId: run.taskId,
    profileId: extra.profileId ?? run.profileId,
    contextVersion: extra.contextVersion ?? 1,
    purpose: extra.purpose ?? 'decide',
    messages: extra.messages ?? [
      { role: 'user', content: [{ type: 'text', text: marker }] },
    ],
    maxOutputTokens: 100,
    outputSchema: extra.outputSchema ?? outputSchema(),
    ...(extra.criterionId ? { criterionId: extra.criterionId } : {}),
    ...(extra.fields ?? {}),
  });
  const response = await fetch(
    `http://127.0.0.1:${port}/internal/v1/model/complete`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lease-token': token,
        ...testServiceIdentity.sign('worker', {
          method: 'POST',
          path: '/internal/v1/model/complete',
          body: rawBody,
        }),
      },
      body: rawBody,
    },
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function ledger(taskId) {
  const reservations = (
    await raw.query(
      'SELECT kind,status,reserved,charged FROM budget_reservations WHERE task_id=$1 ORDER BY status',
      [taskId],
    )
  ).rows;
  const requests = (
    await raw.query(
      'SELECT status,fencing_token,redacted_diagnostic FROM model_requests WHERE task_id=$1',
      [taskId],
    )
  ).rows;
  const budget = (
    await raw.query('SELECT used,reserved FROM run_budgets WHERE run_id=$1', [
      (await raw.query('SELECT run_id FROM jobs WHERE id=$1', [taskId])).rows[0]
        .run_id,
    ])
  ).rows[0];
  return { reservations, requests, budget };
}

function expectDenied(result, marker, status, code) {
  const problems = [];
  const seen = callsFor(marker).length;
  if (seen !== 0) problems.push(`fetches ${seen}`);
  if (result.status !== status) problems.push(`status ${result.status}`);
  if (result.body?.code !== code)
    problems.push(`code ${result.body?.code ?? 'none'}`);
  assert.deepEqual(problems, [], marker);
}

async function expectQuiet(run, marker, status, code, extra) {
  const result = await post(run, marker, run.token, extra);
  expectDenied(result, marker, status, code);
  const book = await ledger(run.taskId);
  assert.equal(book.reservations.length, 0, marker);
  assert.equal(book.requests.length, 0, marker);
}

before(async () => {
  const run = spawnSync('docker', [
    'run',
    '--detach',
    '--name',
    container,
    '--publish',
    '127.0.0.1::5432',
    '--env-file',
    `${dir}/pg.env`,
    'postgres:18-alpine',
  ]);
  assert.equal(run.status, 0, 'docker run failed');
  created = true;
  const mapped = spawnSync('docker', ['port', container, '5432/tcp'], {
    encoding: 'utf8',
  });
  const mappedPort = mapped.stdout.trim().split(':').at(-1);
  assert.equal(mappedPort === '5432', false);
  assert.equal(mappedPort === '8085', false);
  connection = `postgresql://localqa:${password}@127.0.0.1:${mappedPort}/localqa`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = spawnSync('docker', [
      'exec',
      container,
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-U',
      'localqa',
      '-d',
      'localqa',
    ]);
    if (probe.status === 0) {
      try {
        const client = new pg.Client({ connectionString: connection });
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        ready = true;
        break;
      } catch {
        /* TCP not ready yet */
      }
    }
    await delay(250);
  }
  assert.equal(ready, true);
  const applied = await migrate(
    connection,
    new URL('../../../packages/storage/migrations/', import.meta.url),
  );
  assert.equal(applied.includes('001_core.sql'), true);
  vault = await SecretVault.fromProtectedFile(`${dir}/kek.json`);
  db = new Database(connection);
  const accounts = new AccountsRepository(db);
  const projects = new ProjectRepository(db);
  models = new ModelRepository(db, vault);
  admin = await accounts.bootstrap({
    email: `g3d2-admin-${tag}@localqa.test`,
    displayName: 'G3D2 Admin',
    password: 'G3d2-admin-password',
  });
  project = await projects.create(
    { userId: admin.id },
    { name: `g3d2-${tag}` },
  );
  const createdProfile = await models.create(
    { userId: admin.id },
    {
      name: `g3d2-${tag}`,
      endpoint: 'https://model.g3d2.test/v1',
      configuredModelId: 'g3d2-model-v1',
      adapter: 'openai_compatible',
      dataBoundary: 'external',
      responseFormat: 'json_schema',
      apiKey: keyV1,
    },
  );
  const probed = await models.recordProbe(
    { userId: admin.id },
    createdProfile.id,
    1,
    {
      capabilities: {
        structuredOutput: true,
        nativeTools: false,
        imageInput: false,
      },
      status: 'degraded',
    },
  );
  const latest = await models.update({ userId: admin.id }, createdProfile.id, {
    expectedVersion: probed.version,
    configuredModelId: 'g3d2-model-v2',
    responseFormat: 'json_object',
    apiKey: keyV2,
  });
  frozenVersion = probed.version;
  latestModelId = latest.configuredModelId;
  assert.equal(frozenVersion, 2);
  assert.equal(latest.version, 3);
  assert.equal(latest.status, 'untested');
  await models.grant({ userId: admin.id }, project.id, createdProfile.id);
  const ungranted = await models.create(
    { userId: admin.id },
    {
      name: `g3d2-open-${tag}`,
      endpoint: 'https://model.g3d2.test/v1',
      configuredModelId: 'g3d2-model-open',
      adapter: 'openai_compatible',
      dataBoundary: 'external',
      responseFormat: 'json_schema',
      apiKey: keyV1,
    },
  );
  raw = new pg.Client({ connectionString: connection });
  await raw.connect();
  const specs = {
    wrong: {},
    expired: { expired: true },
    released: { released: true },
    context: { contextVersion: 2 },
    cancelled: { runStatus: 'cancelled' },
    calls: {
      rowUsed: used({ modelCalls: 1 }),
      rowLimits: limits({ maxModelCalls: 1 }),
    },
    tokens: {
      rowUsed: used({ totalTokens: 1000 }),
      rowLimits: limits({ maxTotalTokens: 1000 }),
    },
    valid: {},
    failure: {},
    race: {
      budget: limits({ maxModelCalls: 1 }),
      rowLimits: limits({ maxModelCalls: 1 }),
    },
    bound: {},
    open: { profileId: ungranted.id, version: 1 },
    assertOk: withCurrentCase(),
    missing: withCurrentCase(),
    unknown: withCurrentCase(),
    other: withCurrentCase(),
    foreign: withCurrentCase(),
    unfrozen: (() => {
      const id = randomUUID();
      return {
        role: 'executor',
        caseId: id,
        cases: [{ id, frozen: false, criteria: [criterionIds.current] }],
      };
    })(),
    decideCriterion: withCurrentCase(),
    roleAssert: withCurrentCase({ role: 'coordinator' }),
    profileAssert: withCurrentCase(),
    smuggle: {},
    boundRegression: (() => {
      const spec = withCurrentCase();
      spec.cases[0].regression = regressionBinding();
      return spec;
    })(),
    missRefs: withCurrentCase(),
    fakeRefs: withCurrentCase(),
    owned: withCurrentCase(),
    valueConflict: withStoredCriterion({
      expectedValue: 'stored-green',
      locator: { by: 'css', value: '#stored-criterion' },
    }),
    visualGap: withStoredCriterion({ kind: 'visual' }),
  };
  for (const [name, spec] of Object.entries(specs)) {
    runs[name] = await seedRun({
      profileId: createdProfile.id,
      version: frozenVersion,
      ...spec,
    });
    runs[name].profileId = spec.profileId ?? createdProfile.id;
  }
  const foreignProject = randomUUID();
  const foreignRun = randomUUID();
  const foreignCase = randomUUID();
  const foreignCriteria = [criterionRow(criterionIds.foreign)];
  await raw.query('INSERT INTO projects(id,name) VALUES($1,$2)', [
    foreignProject,
    `g3d3-foreign-${tag}`,
  ]);
  await raw.query(
    `INSERT INTO runs(id,project_id,creator_id,display_url,status,phase,completion,context_version,version,effective_config,budget_used)
     VALUES($1,$2,$3,'https://fixture.g3d3.test/','running','execute','none',1,1,$4,$5)`,
    [
      foreignRun,
      foreignProject,
      admin.id,
      configFor(createdProfile.id, frozenVersion, limits()),
      used(),
    ],
  );
  await raw.query(
    `INSERT INTO run_cases(id,project_id,run_id,document,criteria_hash,frozen)
     VALUES($1,$2,$3,$4,$5,true)`,
    [
      foreignCase,
      foreignProject,
      foreignRun,
      {
        id: foreignCase,
        runId: foreignRun,
        projectId: foreignProject,
        version: 1,
        title: 'g3d3 foreign',
        summary: 'criterion owned by another project',
        preconditions: [],
        outline: ['observe'],
        criteria: foreignCriteria,
      },
      createHash('sha256').update(foreignCase).digest('hex'),
    ],
  );
  await raw.query(
    `INSERT INTO artifacts(id,project_id,run_id,task_id,case_id,document,retain_until)
     VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 day')`,
    [
      ownedRef,
      project.id,
      runs.owned.runId,
      runs.owned.taskId,
      runs.owned.caseId,
      {
        id: ownedRef,
        projectId: project.id,
        runId: runs.owned.runId,
        taskId: runs.owned.taskId,
        stepId: null,
        caseId: runs.owned.caseId,
        snapshotId: null,
        kind: 'console',
        status: 'available',
        bytes: null,
        sha256: null,
        contentUrl: null,
        redaction: 'not_needed',
        error: null,
      },
    ],
  );
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    const authorization = init.headers?.authorization ?? '';
    calls.push({
      body,
      v1: same(authorization, `Bearer ${keyV1}`),
      v2: same(authorization, `Bearer ${keyV2}`),
    });
    if (JSON.stringify(body).includes('G3D2-RACE')) {
      raceFetches += 1;
      if (raceFetches === 1) {
        await Promise.race([
          raceHold,
          delay(8000).then(() => {
            throw new Error('G3D2 race gate expired');
          }),
        ]);
      }
    }
    if (JSON.stringify(body).includes('G3D2-FAIL')) {
      return new Response(JSON.stringify({ error: { message: 'rejected' } }), {
        status: 400,
      });
    }
    const judgment = judgmentFor(JSON.stringify(body), body.model);
    if (judgment) return new Response(judgment, { status: 200 });
    return new Response(completion(body.model), { status: 200 });
  };
  api = createApiContext({
    connectionString: connection,
    vault,
    artifactsDir: `${dir}/artifacts`,
    serviceActor: { userId: admin.id },
    serviceIdentity: testServiceIdentity.verifier,
    modelTransport: transport,
  });
  server = createApiServer(api);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  assert.equal(port === 8085, false);
  console.log(
    `[g3d4] postgres ${container} port ${mappedPort} frozenVersion ${frozenVersion} latest ${latest.configuredModelId}`,
  );
});

after(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  if (api) await api.db.close().catch(() => {});
  vault?.dispose?.();
  if (db) await db.close().catch(() => {});
  if (raw) await raw.end().catch(() => {});
  if (created) spawnSync('docker', ['rm', '--force', '--volumes', container]);
  rmSync(dir, { recursive: true, force: true });
});

test('wrong lease token makes no provider call', async () => {
  const result = await post(runs.wrong, 'G3D2-WRONG', `other-${randomUUID()}`);
  expectDenied(result, 'G3D2-WRONG', 409, 'LEASE_EXPIRED');
  const book = await ledger(runs.wrong.taskId);
  assert.equal(book.reservations.length, 0);
  assert.equal(book.requests.length, 0);
});

test('expired lease makes no provider call', async () => {
  const result = await post(runs.expired, 'G3D2-EXPIRED');
  expectDenied(result, 'G3D2-EXPIRED', 409, 'LEASE_EXPIRED');
  const book = await ledger(runs.expired.taskId);
  assert.equal(book.reservations.length, 0);
  assert.equal(book.requests.length, 0);
});

test('released lease makes no provider call', async () => {
  const result = await post(runs.released, 'G3D2-RELEASED');
  expectDenied(result, 'G3D2-RELEASED', 409, 'LEASE_EXPIRED');
  const book = await ledger(runs.released.taskId);
  assert.equal(book.reservations.length, 0);
  assert.equal(book.requests.length, 0);
});

test('context change makes no provider call', async () => {
  const result = await post(runs.context, 'G3D2-CONTEXT');
  expectDenied(result, 'G3D2-CONTEXT', 409, 'LEASE_EXPIRED');
  const book = await ledger(runs.context.taskId);
  assert.equal(book.reservations.length, 0);
  assert.equal(book.requests.length, 0);
});

test('cancelled run makes no provider call', async () => {
  const result = await post(runs.cancelled, 'G3D2-CANCEL');
  expectDenied(result, 'G3D2-CANCEL', 409, 'LEASE_EXPIRED');
  const book = await ledger(runs.cancelled.taskId);
  assert.equal(book.reservations.length, 0);
  assert.equal(book.requests.length, 0);
});

test('exhausted shared model calls make no provider call', async () => {
  const result = await post(runs.calls, 'G3D2-CALLS');
  expectDenied(result, 'G3D2-CALLS', 500, 'BUDGET_EXCEEDED');
  const book = await ledger(runs.calls.taskId);
  assert.equal(book.reservations.length, 0);
  assert.equal(book.requests.length, 0);
});

test('exhausted shared tokens make no provider call', async () => {
  const result = await post(runs.tokens, 'G3D2-TOKENS');
  expectDenied(result, 'G3D2-TOKENS', 500, 'BUDGET_EXCEEDED');
  const book = await ledger(runs.tokens.taskId);
  assert.equal(book.reservations.length, 0);
  assert.equal(book.requests.length, 0);
});

test('a valid complete writes the reservation, model request, and settlement', async () => {
  const result = await post(runs.valid, 'G3D2-VALID');
  const seen = callsFor('G3D2-VALID');
  assert.equal(result.status, 200);
  assert.equal(result.body?.data?.ok, true);
  assert.equal(result.body?.configuredModelId, 'g3d2-model-v1');
  assert.equal(result.body?.usage?.usageSource, 'reported');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.model, 'g3d2-model-v1');
  assert.equal(seen[0].body.response_format.type, 'json_schema');
  assert.equal(seen[0].body.model === latestModelId, false);
  assert.equal(seen[0].v1, true);
  assert.equal(seen[0].v2, false);
  const book = await ledger(runs.valid.taskId);
  assert.equal(book.reservations.length, 1);
  assert.equal(book.reservations[0].kind, 'model');
  assert.equal(book.reservations[0].status, 'settled');
  assert.equal(book.reservations[0].charged.modelCalls, 1);
  assert.equal(book.reservations[0].charged.totalTokens, 15);
  assert.equal(book.requests.length, 1);
  assert.equal(book.requests[0].status, 'settled');
  assert.equal(Number(book.requests[0].fencing_token), 1);
  assert.equal(
    book.requests[0].redacted_diagnostic.profileVersion,
    frozenVersion,
  );
  assert.equal(book.requests[0].redacted_diagnostic.usageSource, 'reported');
  assert.equal(
    book.requests[0].redacted_diagnostic.configuredModelId,
    'g3d2-model-v1',
  );
  assert.equal(book.requests[0].redacted_diagnostic.inputTokens, 11);
  assert.equal(book.requests[0].redacted_diagnostic.outputTokens, 4);
  assert.equal(book.budget.used.modelCalls, 1);
  assert.equal(book.budget.used.totalTokens, 15);
  assert.equal(book.budget.reserved.modelCalls ?? 0, 0);
  assert.equal(JSON.stringify(book).includes(keyV1), false);
  assert.equal(JSON.stringify(book).includes(keyV2), false);
});

test('provider failure is not a completion and still enters the ledger', async () => {
  const result = await post(runs.failure, 'G3D2-FAIL');
  assert.equal(callsFor('G3D2-FAIL').length, 1);
  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'VALIDATION_ERROR');
  assert.equal(result.body.data, undefined);
  assert.notEqual(result.status, 200);
  const book = await ledger(runs.failure.taskId);
  assert.equal(book.requests.length, 1);
  assert.equal(book.reservations.length, 1);
  assert.equal(book.reservations[0].kind, 'model');
  assert.equal(book.reservations[0].status, 'settled');
  assert.equal(book.requests[0].status, 'settled');
  assert.equal(book.requests[0].redacted_diagnostic.usageSource, 'estimated');
  assert.equal(JSON.stringify(book).includes(keyV1), false);
  assert.equal(JSON.stringify(book).includes(keyV2), false);
});

test('two concurrent requests send only the last model call once', async () => {
  let release;
  raceFetches = 0;
  raceHold = new Promise((resolve) => {
    release = resolve;
  });
  const finish = async () => {
    try {
      return await post(runs.race, 'G3D2-RACE');
    } finally {
      release();
    }
  };
  const [left, right] = await Promise.all([finish(), finish()]);
  const statuses = [left.status, right.status].sort((a, b) => a - b);
  const codes = [left.body?.code ?? 'ok', right.body?.code ?? 'ok'].sort();
  assert.deepEqual(statuses, [200, 500]);
  assert.deepEqual(codes, ['BUDGET_EXCEEDED', 'ok']);
  assert.equal(callsFor('G3D2-RACE').length, 1);
  assert.equal(raceFetches, 1);
  const book = await ledger(runs.race.taskId);
  assert.equal(book.reservations.length, 1);
  assert.equal(book.reservations[0].status, 'settled');
  assert.equal(book.requests.length, 1);
  assert.equal(book.budget.used.modelCalls, 1);
});

test('BoundModel grant query freezes the bound version on postgres', async () => {
  const loaded = await models.readVersion(
    { userId: admin.id },
    runs.bound.profileId,
    frozenVersion,
  );
  assert.equal(loaded.document.configuredModelId, 'g3d2-model-v1');
  assert.equal(loaded.document.version, frozenVersion);
  const options = createWorkerModelOptions({
    transport: api.modelTransport,
    load: (id, version) =>
      models.readVersion({ userId: admin.id }, id, version),
  });
  const bound = new BoundModel(
    api.coordinator,
    { workerId, projectId: project.id },
    options,
  );
  const record = await bound.call(
    {
      taskId: runs.bound.taskId,
      leaseToken: runs.bound.token,
      fencingToken: 1,
      contextVersion: 1,
    },
    'coordinator',
    {
      purpose: 'decide',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'G3D2-BOUND' }] },
      ],
      outputSchema: outputSchema(),
      maxOutputTokens: 100,
    },
  );
  const seen = callsFor('G3D2-BOUND');
  assert.equal(record.errorCode, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.model, 'g3d2-model-v1');
  assert.equal(seen[0].body.response_format.type, 'json_schema');
  assert.equal(seen[0].v1, true);
  assert.equal(seen[0].v2, false);
  const book = await ledger(runs.bound.taskId);
  assert.equal(book.requests.length, 1);
  assert.equal(book.requests[0].status, 'settled');
  assert.equal(
    book.requests[0].redacted_diagnostic.profileVersion,
    frozenVersion,
  );
  assert.equal(
    book.requests[0].redacted_diagnostic.profileId,
    runs.bound.profileId,
  );
  const openLoaded = await models.readVersion(
    { userId: admin.id },
    runs.open.profileId,
    1,
  );
  assert.equal(openLoaded.document.configuredModelId, 'g3d2-model-open');
  const openOptions = createWorkerModelOptions({
    transport: api.modelTransport,
    load: (id, version) =>
      models.readVersion({ userId: admin.id }, id, version),
  });
  const openBound = new BoundModel(
    api.coordinator,
    { workerId, projectId: project.id },
    openOptions,
  );
  await assert.rejects(
    () =>
      openBound.call(
        {
          taskId: runs.open.taskId,
          leaseToken: runs.open.token,
          fencingToken: 1,
          contextVersion: 1,
        },
        'coordinator',
        {
          purpose: 'decide',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'G3D2-NOGRANT' }] },
          ],
          outputSchema: outputSchema(),
          maxOutputTokens: 100,
        },
      ),
    (error) => error instanceof StorageError && error.code === 'NOT_FOUND',
  );
  assert.equal(callsFor('G3D2-NOGRANT').length, 0);
  const openBook = await ledger(runs.open.taskId);
  assert.equal(openBook.reservations.length, 0);
  assert.equal(openBook.requests.length, 0);
});

test('assert sends the current frozen criterion and settles the ledger', async () => {
  const marker = 'G3D3-ASSERT';
  const result = await post(runs.assertOk, marker, runs.assertOk.token, {
    purpose: 'assert',
    criterionId: criterionIds.current,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${marker} mentions ${criterionIds.decoy}` },
        ],
      },
    ],
  });
  const seen = callsFor(marker);
  assert.equal(result.status, 200);
  assert.equal(result.body?.data?.criterionId, criterionIds.current);
  assert.equal(result.body?.data?.result, 'not_evaluated');
  assert.equal(result.body?.data?.reason, 'CRITERION_MISMATCH');
  assert.deepEqual(result.body?.data?.evidenceRefs, []);
  assert.equal(result.body?.data?.ok, undefined);
  assert.equal(result.body?.configuredModelId, 'g3d2-model-v1');
  assert.equal(result.body?.usage?.usageSource, 'reported');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.model, 'g3d2-model-v1');
  assert.equal(seen[0].body.model === latestModelId, false);
  assert.equal(seen[0].body.response_format.type, 'json_schema');
  assert.equal(Object.hasOwn(seen[0].body, 'tools'), false);
  assert.equal(seen[0].v1, true);
  assert.equal(seen[0].v2, false);
  const sent = outboundText(seen[0].body);
  assert.equal(sent.includes(`"id":"${criterionIds.current}"`), true);
  assert.equal(sent.includes('"kind":"semantic"'), true);
  assert.equal(sent.includes('"sourceKind":"user_spec"'), true);
  assert.equal(sent.includes('"sourceRef":"g3d3-fixture"'), true);
  assert.equal(
    sent.includes('Frozen criterion checked against the current lease case.'),
    true,
  );
  assert.equal(sent.includes(criterionIds.other), false);
  assert.equal(sent.includes(criterionIds.foreign), false);
  assert.equal(sent.includes('smoke.visible'), false);
  assert.equal(sent.includes(criterionIds.decoy), true);
  const book = await ledger(runs.assertOk.taskId);
  assert.equal(book.reservations.length, 1);
  assert.equal(book.reservations[0].kind, 'model');
  assert.equal(book.reservations[0].status, 'settled');
  assert.equal(book.reservations[0].charged.modelCalls, 1);
  assert.equal(book.reservations[0].charged.totalTokens, 15);
  assert.equal(book.requests.length, 1);
  assert.equal(book.requests[0].status, 'settled');
  assert.equal(book.requests[0].redacted_diagnostic.role, 'assertion');
  assert.equal(
    book.requests[0].redacted_diagnostic.profileVersion,
    frozenVersion,
  );
  assert.equal(book.requests[0].redacted_diagnostic.usageSource, 'reported');
  assert.equal(
    book.requests[0].redacted_diagnostic.configuredModelId,
    'g3d2-model-v1',
  );
  assert.equal(book.requests[0].redacted_diagnostic.inputTokens, 11);
  assert.equal(book.requests[0].redacted_diagnostic.outputTokens, 4);
  assert.equal(book.budget.used.modelCalls, 1);
  assert.equal(book.budget.used.totalTokens, 15);
  assert.equal(book.budget.reserved.modelCalls ?? 0, 0);
  assert.equal(JSON.stringify(book).includes(keyV1), false);
  assert.equal(JSON.stringify(book).includes(keyV2), false);
  assert.equal(sent.includes(keyV1), false);
  assert.equal(sent.includes(keyV2), false);
});

test('assert without criterionId makes no provider call', async () => {
  await expectQuiet(runs.missing, 'G3D3-MISSING', 422, 'VALIDATION_ERROR', {
    purpose: 'assert',
  });
});

test('unknown criterion makes no provider call', async () => {
  await expectQuiet(runs.unknown, 'G3D3-UNKNOWN', 404, 'NOT_FOUND', {
    purpose: 'assert',
    criterionId: criterionIds.unknown,
  });
});

test('another case criterion makes no provider call', async () => {
  await expectQuiet(runs.other, 'G3D3-OTHER', 404, 'NOT_FOUND', {
    purpose: 'assert',
    criterionId: criterionIds.other,
  });
});

test('another project criterion makes no provider call', async () => {
  await expectQuiet(runs.foreign, 'G3D3-FOREIGN', 404, 'NOT_FOUND', {
    purpose: 'assert',
    criterionId: criterionIds.foreign,
  });
});

test('an unfrozen case criterion makes no provider call', async () => {
  await expectQuiet(runs.unfrozen, 'G3D3-UNFROZEN', 404, 'NOT_FOUND', {
    purpose: 'assert',
    criterionId: criterionIds.current,
  });
});

test('a non-assert purpose rejects criterionId before the provider', async () => {
  await expectQuiet(
    runs.decideCriterion,
    'G3D3-PURPOSE',
    422,
    'VALIDATION_ERROR',
    {
      purpose: 'decide',
      criterionId: criterionIds.current,
    },
  );
});

test('assert on a non-executor role makes no provider call', async () => {
  await expectQuiet(runs.roleAssert, 'G3D3-ROLE', 403, 'FORBIDDEN', {
    purpose: 'assert',
    criterionId: criterionIds.current,
  });
});

test('assert with the wrong profile makes no provider call', async () => {
  await expectQuiet(
    runs.profileAssert,
    'G3D3-PROFILE',
    409,
    'MODEL_NOT_CONFIGURED',
    {
      purpose: 'assert',
      criterionId: criterionIds.current,
      profileId: runs.open.profileId,
    },
  );
});

test('B4 fields on the model request do not bypass the lease or the budget', async () => {
  await expectQuiet(runs.smuggle, 'G3D3-B4-FIELDS', 422, 'VALIDATION_ERROR', {
    fields: {
      executionMode: 'regression',
      regression: {
        sourceVersionId: '00000000-0000-4000-8000-0000000000b4',
        sourceDocumentSha256: 'ab'.repeat(32),
        document: regressionDocument('g3d3.smuggle'),
        moduleSnapshots: [],
      },
      regressionSource: {
        documentId: 'g3d3.smuggle',
        stepIndex: 0,
        modulePath: [],
      },
    },
  });
});

test('a stored regression binding still freezes the criterion and settles the budget', async () => {
  const marker = 'G3D3-B4-BIND';
  const stored = (
    await raw.query(
      "SELECT document ? 'regression' AS present FROM run_cases WHERE id=$1 AND project_id=$2 AND frozen",
      [runs.boundRegression.caseId, project.id],
    )
  ).rows[0];
  assert.equal(stored.present, true);
  const result = await post(
    runs.boundRegression,
    marker,
    runs.boundRegression.token,
    {
      purpose: 'assert',
      criterionId: criterionIds.current,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${marker} mentions ${criterionIds.decoy}` },
          ],
        },
      ],
    },
  );
  const seen = callsFor(marker);
  const sent = outboundText(seen[0]?.body);
  assert.equal(result.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(sent.includes(`"id":"${criterionIds.current}"`), true);
  assert.equal(sent.includes('"kind":"semantic"'), true);
  assert.equal(sent.includes('"sourceRef":"g3d3-fixture"'), true);
  assert.equal(sent.includes('g3d3.regression'), false);
  assert.equal(sent.includes('executionMode'), false);
  assert.equal(JSON.stringify(seen[0].body).includes('g3d3.regression'), false);
  assert.equal(JSON.stringify(seen[0].body).includes('executionMode'), false);
  const book = await ledger(runs.boundRegression.taskId);
  assert.equal(book.reservations.length, 1);
  assert.equal(book.reservations[0].kind, 'model');
  assert.equal(book.reservations[0].status, 'settled');
  assert.equal(book.reservations[0].charged.modelCalls, 1);
  assert.equal(book.requests.length, 1);
  assert.equal(book.requests[0].status, 'settled');
  assert.equal(book.requests[0].redacted_diagnostic.role, 'assertion');
  assert.equal(book.budget.used.modelCalls, 1);
  assert.equal(book.budget.reserved.modelCalls ?? 0, 0);
});

function assertJudged(result, marker, reason) {
  assert.equal(result.status, 200, marker);
  assert.equal(result.body?.data?.criterionId, criterionIds.current, marker);
  assert.equal(result.body?.data?.result, 'not_evaluated', marker);
  assert.equal(result.body?.data?.reason, reason, marker);
  assert.deepEqual(result.body?.data?.evidenceRefs, [], marker);
  assert.equal(
    JSON.stringify(result.body?.data).includes('provider claims pass'),
    false,
    marker,
  );
  assert.equal(
    JSON.stringify(result.body?.data).includes(unknownRef),
    false,
    marker,
  );
}

async function expectSettledAssert(run, marker) {
  const book = await ledger(run.taskId);
  assert.equal(book.reservations.length, 1, marker);
  assert.equal(book.reservations[0].kind, 'model', marker);
  assert.equal(book.reservations[0].status, 'settled', marker);
  assert.equal(book.reservations[0].charged.modelCalls, 1, marker);
  assert.equal(book.requests.length, 1, marker);
  assert.equal(book.requests[0].status, 'settled', marker);
  assert.equal(book.requests[0].redacted_diagnostic.role, 'assertion', marker);
  assert.equal(JSON.stringify(book).includes(keyV1), false, marker);
  assert.equal(JSON.stringify(book).includes(keyV2), false, marker);
}

test('missing evidence refs are not an external pass', async () => {
  const marker = 'G3D4-MISS';
  const result = await post(runs.missRefs, marker, runs.missRefs.token, {
    purpose: 'assert',
    criterionId: criterionIds.current,
    outputSchema: judgmentSchema(),
  });
  assert.equal(callsFor(marker).length, 1);
  assertJudged(result, marker, 'NO_OBSERVATION_REF');
  await expectSettledAssert(runs.missRefs, marker);
});

test('an unknown evidence ref is not an external pass', async () => {
  const marker = 'G3D4-FAKE';
  const result = await post(runs.fakeRefs, marker, runs.fakeRefs.token, {
    purpose: 'assert',
    criterionId: criterionIds.current,
    outputSchema: judgmentSchema(),
  });
  assert.equal(callsFor(marker).length, 1);
  assertJudged(result, marker, 'FAKE_EVIDENCE');
  await expectSettledAssert(runs.fakeRefs, marker);
});

test('an owned evidence ref can be judged', async () => {
  const marker = 'G3D4-OWNED';
  const result = await post(runs.owned, marker, runs.owned.token, {
    purpose: 'assert',
    criterionId: criterionIds.current,
    outputSchema: judgmentSchema(),
  });
  const sent = outboundText(callsFor(marker)[0]?.body);
  assert.equal(callsFor(marker).length, 1);
  assert.equal(result.status, 200);
  assert.equal(result.body?.data?.criterionId, criterionIds.current);
  assert.equal(result.body?.data?.result, 'passed');
  assert.equal(result.body?.data?.reason, 'OBSERVED');
  assert.deepEqual(result.body?.data?.evidenceRefs, [ownedRef]);
  assert.equal(
    JSON.stringify(result.body?.data).includes('provider claims pass'),
    false,
  );
  assert.equal(JSON.stringify(result.body?.data).includes(unknownRef), false);
  assert.equal(sent.includes(`"id":"${criterionIds.current}"`), true);
  assert.equal(sent.includes('"sourceRef":"g3d3-fixture"'), true);
  await expectSettledAssert(runs.owned, marker);
});

test('a conflicting message still sends the stored criterion', async () => {
  const marker = 'G3D4-VALUE';
  const result = await post(
    runs.valueConflict,
    marker,
    runs.valueConflict.token,
    {
      purpose: 'assert',
      criterionId: criterionIds.current,
      outputSchema: judgmentSchema(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${marker} expectedValue=message-blue` },
          ],
        },
      ],
    },
  );
  const sent = outboundText(callsFor(marker)[0]?.body);
  assert.equal(callsFor(marker).length, 1);
  assert.equal(sent.includes('"expectedValue":"stored-green"'), true);
  assert.equal(sent.includes('"sourceKind":"user_spec"'), true);
  assert.equal(sent.includes('"sourceRef":"g3d3-fixture"'), true);
  assert.equal(
    sent.includes('Frozen criterion checked against the current lease case.'),
    true,
  );
  assert.equal(
    sent.includes('"#stored-criterion"') || sent.includes('#stored-criterion'),
    true,
  );
  assert.equal(sent.includes(`"id":"${criterionIds.current}"`), true);
  assert.equal(sent.includes('"kind":"semantic"'), true);
  assert.equal(sent.includes('"expectedValue":"message-blue"'), false);
  assert.equal(sent.includes(criterionIds.decoy), false);
  assertJudged(result, marker, 'NO_OBSERVATION_REF');
  await expectSettledAssert(runs.valueConflict, marker);
});

test('visual without image capability does not call the provider or pass as text', async () => {
  const marker = 'G3D4-VISUAL';
  const result = await post(runs.visualGap, marker, runs.visualGap.token, {
    purpose: 'assert',
    criterionId: criterionIds.current,
    outputSchema: judgmentSchema(),
  });
  assert.equal(callsFor(marker).length, 0);
  assert.equal(result.status, 500);
  assert.equal(result.body?.code, 'MODEL_CAPABILITY_MISSING');
  assert.notEqual(result.body?.data?.result, 'passed');
  const book = await ledger(runs.visualGap.taskId);
  assert.equal(book.reservations.length, 0);
  assert.equal(book.requests.length, 0);
});
