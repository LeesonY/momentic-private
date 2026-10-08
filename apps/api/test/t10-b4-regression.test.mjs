import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import {
  Database,
  migrate,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
  hashPayload,
} from '../../../packages/storage/dist/index.js';
import { createApiContext, createApiServer } from '../dist/index.js';
import { createRegressionPlan } from '../../../packages/orchestrator/dist/regression-plan.js';
const tag = randomUUID().slice(0, 8),
  name = `localqa-b4-${tag}`,
  dir = mkdtempSync(join(tmpdir(), 'localqa-b4-'));
let db, context, server, project, actor, cookie, url, pgConnection;
async function adminQuery(sql, values) {
  const client = new pg.Client({ connectionString: pgConnection });
  await client.connect();
  try {
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}
const document = (
  id,
  steps = [
    { kind: 'navigate', url: 'http://localhost:8080/' },
    { kind: 'assert', criterionId: 'visible' },
  ],
) => ({
  schemaVersion: 1,
  kind: 'localqa/test',
  id,
  name: id,
  variables: { VALUE: 'hello' },
  criteria: [
    {
      id: 'visible',
      kind: 'element_visible',
      description: 'Body visible',
      sourceKind: 'generic_smoke',
      sourceRef: 'fixture',
      locator: { by: 'css', value: 'body' },
    },
  ],
  steps,
});
async function request(path, body, key) {
  const response = await fetch(`${url}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
async function saved(doc, approved = true, pid = project.id) {
  const created = await request(`/projects/${pid}/saved-cases`, {
    slug: `s-${randomUUID()}`,
    name: doc.name,
    document: doc,
  });
  assert.equal(created.status, 201, JSON.stringify(created));
  const version = (await request(`/saved-cases/${created.body.id}/versions`))
    .body.items[0];
  if (approved) {
    const input = {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'B4 fixture approval',
    };
    const preview = await request(
      `/saved-case-versions/${version.id}/review-preview`,
      input,
    );
    assert.equal(preview.status, 200, JSON.stringify(preview));
    const result = await request(`/saved-case-versions/${version.id}/review`, {
      ...input,
      confirmationToken: preview.body.confirmationToken,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
  }
  return version;
}
before(async () => {
  const password = randomBytes(24).toString('hex');
  const env = join(dir, 'pg.env');
  writeFileSync(
    env,
    `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  const launch = spawnSync(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      name,
      '--env-file',
      env,
      '--publish',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(launch.status, 0, launch.stderr);
  const port = spawnSync('docker', ['port', name, '5432/tcp'], {
    encoding: 'utf8',
  })
    .stdout.trim()
    .split(':')
    .at(-1);
  const connection = `postgres://localqa:${password}@127.0.0.1:${port}/localqa`;
  pgConnection = connection;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    const client = new pg.Client({ connectionString: connection });
    try {
      await client.connect();
      await migrate(
        connection,
        new URL('../../../packages/storage/migrations/', import.meta.url),
      );
      ready = true;
      break;
    } catch {
      await delay(100);
    } finally {
      await client.end().catch(() => {});
    }
  }
  assert.ok(ready, 'migrations ready');
  const kek = join(dir, 'kek.json');
  writeFileSync(
    kek,
    JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    }),
    { mode: 0o600 },
  );
  const vault = await SecretVault.fromProtectedFile(kek);
  db = new Database(connection);
  const user = await new AccountsRepository(db).bootstrap({
    email: `b4-${tag}@localqa.test`,
    displayName: 'B4',
    password: 'B4Password123!',
  });
  actor = { userId: user.id };
  project = await new ProjectRepository(db).create(actor, {
    name: `B4 ${tag}`,
  });
  const model = await new ModelRepository(db, vault).create(actor, {
    name: 'B4 unused model',
    endpoint: 'https://stub.example.test/v1',
    configuredModelId: 'stub-normal',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
  });
  await new ProjectRepository(db).update(actor, project.id, {
    expectedVersion: 1,
    defaultModelProfileId: model.id,
  });
  context = createApiContext({
    connectionString: connection,
    vault,
    artifactsDir: join(dir, 'artifacts'),
    serviceActor: actor,
    publicOrigin: 'http://localhost',
  });
  server = createApiServer(context);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'B4Password123!' }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await context?.db.close();
  await db?.close();
  spawnSync('docker', ['rm', '--force', '--volumes', name]);
  rmSync(dir, { recursive: true, force: true });
});

test('two approved versions freeze full ordered source binding; idempotency and execute-only scheduling', async () => {
  const a = await saved(document('first'));
  const b = await saved(document('second'));
  const key = randomUUID();
  const body = { projectId: project.id, caseVersionIds: [b.id, a.id] };
  const created = await request('/regression-runs', body, key);
  assert.equal(created.status, 202, JSON.stringify(created));
  assert.equal(created.body.executionMode, 'regression');
  const cases = await db.actor(actor, async (client) =>
    (
      await client.query(
        "SELECT document FROM run_cases WHERE run_id=$1 ORDER BY document->>'title'",
        [created.body.id],
      )
    ).rows.map((row) => row.document),
  );
  assert.equal(cases.length, 2);
  const ordered = await db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          "SELECT payload FROM run_events WHERE run_id=$1 AND type='case.created' ORDER BY seq",
          [created.body.id],
        )
      ).rows,
  );
  assert.deepEqual(
    ordered.map((row) => row.payload.regression.sourceVersionId),
    [b.id, a.id],
  );
  for (const c of cases) {
    const source = c.title === 'first' ? a : b;
    assert.equal(c.runId, created.body.id);
    assert.equal(c.regression.sourceVersionId, source.id);
    assert.equal(c.regression.sourceDocumentSha256, source.sha256);
    assert.deepEqual(c.regression.document, source.document);
    assert.equal(hashPayload(c.regression.document), source.sha256);
    assert.ok(c.criteria.every((v) => v.sourceKind === 'saved_case'));
  }
  const forgedCriterion = structuredClone(cases[0]);
  forgedCriterion.id = randomUUID();
  forgedCriterion.runId = randomUUID();
  forgedCriterion.criteria[0].description = 'not sourced from approval';
  await assert.rejects(
    () =>
      context.coordinator.start(
        actor,
        { projectId: project.id, targetUrl: created.body.targetUrl },
        created.body.effectiveConfig,
        randomUUID(),
        [forgedCriterion],
      ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.equal(
    (await request('/regression-runs', body, key)).body.id,
    created.body.id,
  );
  assert.equal(
    (
      await request(
        '/regression-runs',
        { ...body, caseVersionIds: [a.id, b.id] },
        key,
      )
    ).status,
    409,
  );
  await assert.rejects(() =>
    db.actor(actor, (client) =>
      client.query(
        "UPDATE run_cases SET document=jsonb_set(document,'{title}','\"tampered\"') WHERE id=$1",
        [cases[0].id],
      ),
    ),
  );
  await assert.rejects(() =>
    db.actor(actor, (client) =>
      client.query("UPDATE runs SET execution_mode='smoke' WHERE id=$1", [
        created.body.id,
      ]),
    ),
  );
  await db.actor(actor, (client) =>
    client.query(
      "UPDATE jobs SET status='succeeded',result=$2 WHERE run_id=$1",
      [created.body.id, { stage: 'preflight' }],
    ),
  );
  await context.coordinator.tick(project.id);
  const jobs = await db.actor(
    actor,
    async (client) =>
      (
        await client.query('SELECT role,status FROM jobs WHERE run_id=$1', [
          created.body.id,
        ])
      ).rows,
  );
  assert.equal(jobs.filter((j) => j.role === 'executor').length, 2);
  assert.ok(!jobs.some((j) => ['explorer', 'planner'].includes(j.role)));
  const scope = { projectId: project.id, workerId: `b4-fake-lease-${tag}` };
  const lease = await context.coordinator.claim(scope);
  assert.equal(lease.task.role, 'executor');
  const work = await context.coordinator.work(scope, {
    taskId: lease.task.id,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    contextVersion: lease.contextVersion,
  });
  assert.equal(work.stage, 'execute');
  assert.equal(work.regressionPlan.steps.length, 2);
  assert.deepEqual(work.regressionPlan.criteria, work.definition.criteria);
  assert.equal(
    work.regressionPlan.steps[1].step.criterionId,
    work.definition.criteria[0].id,
  );
  const forged = structuredClone(cases[0]);
  forged.id = randomUUID();
  forged.regression.sourceDocumentSha256 = '0'.repeat(64);
  await assert.rejects(
    () =>
      db.actor(actor, async (client) => {
        await client.query(
          'INSERT INTO run_cases(id,project_id,run_id,document,criteria_hash) VALUES($1,$2,$3,$4,$5)',
          [
            forged.id,
            project.id,
            created.body.id,
            forged,
            hashPayload(forged.criteria),
          ],
        );
        await client.query(
          'INSERT INTO run_case_regression_bindings(project_id,run_id,case_id,source_version_id,source_sha256,binding) VALUES($1,$2,$3,$4,$5,$6)',
          [
            project.id,
            created.body.id,
            forged.id,
            forged.regression.sourceVersionId,
            forged.regression.sourceDocumentSha256,
            forged.regression,
          ],
        );
      }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});

test('draft and cross-project sources are rejected; smoke still schedules exploration', async () => {
  const draft = await saved(document('draft'), false);
  assert.equal(
    (
      await request(
        '/regression-runs',
        { projectId: project.id, caseVersionIds: [draft.id] },
        randomUUID(),
      )
    ).status,
    422,
  );
  const other = await new ProjectRepository(db).create(actor, {
    name: `Other ${tag}`,
  });
  const foreign = await saved(document('foreign'), true, other.id);
  assert.equal(
    (
      await request(
        '/regression-runs',
        { projectId: project.id, caseVersionIds: [foreign.id] },
        randomUUID(),
      )
    ).status,
    404,
  );
  const smoke = await request(
    '/runs',
    { projectId: project.id, targetUrl: 'http://localhost:8080/' },
    randomUUID(),
  );
  assert.equal(smoke.status, 202, JSON.stringify(smoke));
  assert.equal(smoke.body.executionMode, 'smoke');
  await db.actor(actor, (client) =>
    client.query(
      "UPDATE jobs SET status='succeeded',result=$2 WHERE run_id=$1",
      [smoke.body.id, { stage: 'preflight' }],
    ),
  );
  await context.coordinator.tick(project.id);
  const jobs = await db.actor(
    actor,
    async (client) =>
      (
        await client.query('SELECT role FROM jobs WHERE run_id=$1', [
          smoke.body.id,
        ])
      ).rows,
  );
  assert.ok(jobs.some((j) => j.role === 'explorer'));
});

test('historical serialization SHA is preserved with canonical snapshot; foreign and wrong-hash modules are not trusted', async () => {
  const oldCase = randomUUID(),
    oldVersion = randomUUID();
  const oldDocument = document('historical');
  const oldSha = createHash('sha256')
    .update(JSON.stringify(oldDocument))
    .digest('hex');
  assert.notEqual(oldSha, hashPayload(oldDocument));
  await adminQuery(
    'INSERT INTO saved_cases(id,project_id,slug,name) VALUES($1,$2,$3,$4)',
    [oldCase, project.id, `old-${tag}`, 'Historical'],
  );
  await adminQuery(
    "INSERT INTO saved_case_versions(id,case_id,project_id,version,document,sha256,review_status,created_by) VALUES($1,$2,$3,1,$4,$5,'approved',$6)",
    [oldVersion, oldCase, project.id, oldDocument, oldSha, actor.userId],
  );
  const admission = await request(
    '/regression-runs',
    { projectId: project.id, caseVersionIds: [oldVersion] },
    randomUUID(),
  );
  assert.equal(admission.status, 202, JSON.stringify(admission));
  const bound = (
    await adminQuery('SELECT document FROM run_cases WHERE run_id=$1', [
      admission.body.id,
    ])
  ).rows[0].document;
  assert.equal(bound.regression.sourceDocumentSha256, oldSha);
  assert.equal(
    bound.regression.snapshotDocumentSha256,
    hashPayload(oldDocument),
  );
  assert.deepEqual(bound.regression.document, oldDocument);
  assert.notEqual(
    createHash('sha256')
      .update(JSON.stringify(bound.regression.document))
      .digest('hex'),
    oldSha,
  );
  const oldBindingWithoutSnapshot = structuredClone(bound.regression);
  delete oldBindingWithoutSnapshot.snapshotDocumentSha256;
  assert.throws(
    () =>
      createRegressionPlan(oldBindingWithoutSnapshot, {
        projectId: project.id,
        allowedOrigins: ['http://localhost:8080'],
        env: { BASE_URL: 'http://localhost:8080/' },
        maxExpandedSteps: 20,
      }),
    /SOURCE_SHA_MISMATCH/,
  );
  for (const field of [
    'sourceDocumentSha256',
    'snapshotDocumentSha256',
    'document',
  ]) {
    const forged = structuredClone(bound);
    forged.id = randomUUID();
    forged.runId = randomUUID();
    if (field === 'document') forged.regression.document.name = 'forged';
    else forged.regression[field] = '0'.repeat(64);
    await assert.rejects(
      () =>
        context.coordinator.start(
          actor,
          { projectId: project.id, targetUrl: admission.body.targetUrl },
          admission.body.effectiveConfig,
          randomUUID(),
          [forged],
        ),
      (error) => error.code === 'VALIDATION_ERROR',
    );
  }
  assert.equal(
    (
      await adminQuery('SELECT sha256 FROM saved_case_versions WHERE id=$1', [
        oldVersion,
      ])
    ).rows[0].sha256,
    oldSha,
  );
  const other = await new ProjectRepository(db).create(actor, {
    name: `Foreign modules ${tag}`,
  });
  await adminQuery(
    "INSERT INTO regression_module_versions(project_id,name,version,sha256,document,review_status) VALUES($1,'foreignOnly',1,$2,$3,'approved')",
    [other.id, hashPayload(oldDocument), oldDocument],
  );
  assert.equal(
    (
      await request(`/projects/${project.id}/saved-cases`, {
        slug: `foreign-module-${tag}`,
        name: 'Foreign module',
        document: document('foreign-ref', [
          { kind: 'module', ref: 'foreignOnly@1' },
        ]),
      })
    ).status,
    422,
  );
  await adminQuery(
    "INSERT INTO regression_module_versions(project_id,name,version,sha256,document,review_status) VALUES($1,'wrongHash',1,$2,$3,'approved')",
    [project.id, '0'.repeat(64), oldDocument],
  );
  const source = await saved(
    document('wrong-hash-ref', [{ kind: 'module', ref: 'wrongHash@1' }]),
  );
  assert.equal(
    (
      await request(
        '/regression-runs',
        { projectId: project.id, caseVersionIds: [source.id] },
        randomUUID(),
      )
    ).status,
    422,
  );
});

test('64-character criterion IDs use deterministic bounded aliases and unused criteria remain unverified', async () => {
  const longId = 'c'.repeat(64);
  const original = document('long-criterion');
  original.criteria[0].id = longId;
  original.steps[1].criterionId = longId;
  original.criteria.push({
    ...original.criteria[0],
    id: 'unused',
    description: 'Never asserted',
  });
  const source = await saved(original);
  const admission = await request(
    '/regression-runs',
    { projectId: project.id, caseVersionIds: [source.id] },
    randomUUID(),
  );
  assert.equal(admission.status, 202, JSON.stringify(admission));
  const c = (
    await adminQuery('SELECT document FROM run_cases WHERE run_id=$1', [
      admission.body.id,
    ])
  ).rows[0].document;
  assert.ok(c.criteria.every((criterion) => criterion.id.length === 64));
  const options = {
    projectId: project.id,
    allowedOrigins: ['http://localhost:8080'],
    env: { BASE_URL: 'http://localhost:8080/' },
    maxExpandedSteps: 20,
  };
  const plan = createRegressionPlan(c.regression, options);
  assert.deepEqual(createRegressionPlan(c.regression, options), plan);
  assert.equal(plan.unevaluatedCriterionIds.length, 1);
  assert.equal(c.regression.document.criteria[0].id, longId);
  const forged = structuredClone(c.regression);
  forged.snapshotDocumentSha256 = '0'.repeat(64);
  assert.throws(
    () => createRegressionPlan(forged, options),
    /SOURCE_SHA_MISMATCH/,
  );
  const compatible = structuredClone(c.regression);
  delete compatible.snapshotDocumentSha256;
  assert.deepEqual(createRegressionPlan(compatible, options), plan);
  const invalid = structuredClone(original);
  invalid.criteria[0].id += 'c';
  invalid.steps[1].criterionId += 'c';
  assert.equal(
    (
      await request(`/projects/${project.id}/saved-cases`, {
        slug: `too-long-${tag}`,
        name: 'Too long',
        document: invalid,
      })
    ).status,
    422,
  );
});

async function register(name, doc, status = 'approved') {
  await adminQuery(
    'INSERT INTO regression_module_versions(project_id,name,version,sha256,document,review_status) VALUES($1,$2,1,$3,$4,$5)',
    [project.id, name, hashPayload(doc), doc, status],
  );
}

test('PG/API module cycles, depth eight/nine, unapproved/unknown refs and global expansion limit', async () => {
  const A = document('cycle-A', [{ kind: 'module', ref: 'cycleB@1' }]);
  const B = document('cycle-B', [{ kind: 'module', ref: 'cycleA@1' }]);
  await register('cycleA', A);
  await register('cycleB', B);
  const cyclic = await saved(
    document('cycle-root', [{ kind: 'module', ref: 'cycleA@1' }]),
  );
  assert.equal(
    (
      await request(
        '/regression-runs',
        { projectId: project.id, caseVersionIds: [cyclic.id] },
        randomUUID(),
      )
    ).status,
    422,
  );
  for (let i = 1; i <= 9; i++)
    await register(
      `depth${i}`,
      document(
        `depth-${i}`,
        i === 9
          ? [{ kind: 'navigate', url: 'http://localhost:8080/' }]
          : [{ kind: 'module', ref: `depth${i + 1}@1` }],
      ),
    );
  const eight = await saved(
    document('depth-eight', [{ kind: 'module', ref: 'depth2@1' }]),
  );
  assert.equal(
    (
      await request(
        '/regression-runs',
        { projectId: project.id, caseVersionIds: [eight.id] },
        randomUUID(),
      )
    ).status,
    202,
  );
  const nine = await saved(
    document('depth-nine', [{ kind: 'module', ref: 'depth1@1' }]),
  );
  assert.equal(
    (
      await request(
        '/regression-runs',
        { projectId: project.id, caseVersionIds: [nine.id] },
        randomUUID(),
      )
    ).status,
    422,
  );
  await register('notApproved', document('not-approved'), 'draft');
  for (const ref of ['notApproved@1', 'missing@1'])
    assert.equal(
      (
        await request(`/projects/${project.id}/saved-cases`, {
          slug: `bad-${randomUUID()}`,
          name: 'Bad ref',
          document: document('bad-ref', [{ kind: 'module', ref }]),
        })
      ).status,
      422,
    );
  await register('budgetChild', document('budget-child'));
  const repeated = await saved(
    document('budget-root', [
      { kind: 'module', ref: 'budgetChild@1' },
      { kind: 'module', ref: 'budgetChild@1' },
    ]),
  );
  assert.equal(
    (
      await request(
        '/regression-runs',
        {
          projectId: project.id,
          caseVersionIds: [repeated.id],
          budget: { maxActionsPerCase: 3 },
        },
        randomUUID(),
      )
    ).status,
    422,
  );
});

test('frozen BASE_URL environment version; missing variable, disallowed resolved origin and fixture reject', async () => {
  const environment = await request(`/projects/${project.id}/environments`, {
    name: 'B4 frozen env',
    baseUrl: 'http://localhost:8080/base',
    allowedOrigins: ['http://localhost:8080'],
    excludedPaths: [],
    tlsPolicy: 'strict',
    defaultAuthProfileId: null,
  });
  assert.equal(environment.status, 201, JSON.stringify(environment));
  const source = await saved(
    document('env-doc', [
      { kind: 'navigate', url: '{{env.BASE_URL}}/{{vars.VALUE}}' },
      { kind: 'assert', criterionId: 'visible' },
    ]),
  );
  const envKey = randomUUID();
  const envRequest = {
    projectId: project.id,
    caseVersionIds: [source.id],
    environmentId: environment.body.id,
  };
  const created = await request('/regression-runs', envRequest, envKey);
  assert.equal(created.status, 202, JSON.stringify(created));
  assert.equal(created.body.effectiveConfig.environmentVersion, 1);
  const c = await db.actor(
    actor,
    async (client) =>
      (
        await client.query('SELECT document FROM run_cases WHERE run_id=$1', [
          created.body.id,
        ])
      ).rows[0].document,
  );
  const env = { BASE_URL: environment.body.baseUrl };
  const plan = createRegressionPlan(c.regression, {
    projectId: project.id,
    allowedOrigins: ['http://localhost:8080'],
    env,
    maxExpandedSteps: 20,
  });
  assert.equal(plan.steps[0].step.url, 'http://localhost:8080/base/hello');
  assert.equal(
    c.regression.document.steps[0].url,
    '{{env.BASE_URL}}/{{vars.VALUE}}',
  );
  const changed = await fetch(
    `${url}/api/v1/environments/${environment.body.id}`,
    {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        baseUrl: 'http://localhost:8080/changed',
      }),
    },
  );
  assert.equal(changed.status, 200);
  const frozenEnv = await db.actor(actor, (client) =>
    context.coordinator.regressionEnvironment(client, created.body),
  );
  assert.equal(frozenEnv.BASE_URL, 'http://localhost:8080/base');
  assert.equal(
    (await request('/regression-runs', envRequest, envKey)).status,
    409,
  );
  const missing = await saved(
    document('missing-env', [{ kind: 'navigate', url: '{{env.MISSING}}' }]),
  );
  assert.equal(
    (
      await request(
        '/regression-runs',
        {
          projectId: project.id,
          caseVersionIds: [missing.id],
          environmentId: environment.body.id,
        },
        randomUUID(),
      )
    ).status,
    422,
  );
  const outside = await saved(
    document('outside-env', [
      { kind: 'navigate', url: 'https://outside.test/{{vars.VALUE}}' },
    ]),
  );
  assert.equal(
    (
      await request(
        '/regression-runs',
        {
          projectId: project.id,
          caseVersionIds: [outside.id],
          environmentId: environment.body.id,
        },
        randomUUID(),
      )
    ).status,
    422,
  );
  const fixtureDoc = {
    ...document('fixture'),
    fixtureRefs: [{ id: randomUUID(), version: 1 }],
  };
  const fixture = await saved(fixtureDoc);
  assert.equal(
    (
      await request(
        '/regression-runs',
        { projectId: project.id, caseVersionIds: [fixture.id] },
        randomUUID(),
      )
    ).status,
    422,
  );
});

test('PG module snapshots support sibling reuse with scoped criteria; unknown/unapproved and budget fail closed', async () => {
  const child = document('module-child');
  child.criteria[0].description = '{{vars.VALUE}}';
  await adminQuery(
    'INSERT INTO regression_module_versions(project_id,name,version,sha256,document,review_status) VALUES($1,$2,1,$3,$4,$5)',
    [project.id, 'child', hashPayload(child), child, 'approved'],
  );
  const rootDoc = document('module-root', [
    {
      kind: 'module',
      ref: 'child@1',
      arguments: { VALUE: 'first invocation' },
    },
    {
      kind: 'module',
      ref: 'child@1',
      arguments: { VALUE: 'second invocation' },
    },
  ]);
  const source = await saved(rootDoc);
  const admission = await request(
    '/regression-runs',
    { projectId: project.id, caseVersionIds: [source.id] },
    randomUUID(),
  );
  assert.equal(admission.status, 202, JSON.stringify(admission));
  const binding = {
    sourceVersionId: source.id,
    sourceDocumentSha256: hashPayload(rootDoc),
    document: rootDoc,
    moduleSnapshots: [
      {
        projectId: project.id,
        name: 'child',
        version: 1,
        sha256: hashPayload(child),
        document: child,
        reviewStatus: 'approved',
      },
    ],
  };
  const plan = createRegressionPlan(binding, {
    projectId: project.id,
    allowedOrigins: ['http://localhost:8080'],
    env: { BASE_URL: 'http://localhost:8080/' },
    maxExpandedSteps: 4,
  });
  assert.equal(plan.steps.length, 4);
  assert.equal(plan.unevaluatedCriterionIds.length, 1);
  assert.ok(
    plan.criteria.some(
      (criterion) => criterion.id === plan.unevaluatedCriterionIds[0],
    ),
  );
  assert.equal(plan.steps[1].criteria[0].description, 'first invocation');
  assert.equal(plan.steps[3].criteria[0].description, 'second invocation');
  assert.notEqual(
    plan.steps[1].step.criterionId,
    plan.steps[3].step.criterionId,
  );
  assert.throws(() =>
    createRegressionPlan(binding, {
      projectId: project.id,
      allowedOrigins: ['http://localhost:8080'],
      env: {},
      maxExpandedSteps: 3,
    }),
  );
  await assert.rejects(
    () =>
      adminQuery(
        "UPDATE regression_module_versions SET review_status='draft' WHERE project_id=$1 AND name='child'",
        [project.id],
      ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    () =>
      adminQuery(
        "UPDATE run_case_regression_bindings SET binding=jsonb_set(binding,'{sourceDocumentSha256}','\"tamper\"') WHERE run_id=$1",
        [admission.body.id],
      ),
    (error) => error.code === '23514',
  );
});
