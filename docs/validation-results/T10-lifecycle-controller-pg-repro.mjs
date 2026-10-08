import assert from 'node:assert/strict';
import { before, after, test as nodeTest } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';
import pg from '../../apps/api/node_modules/pg/lib/index.js';
import {
  Database,
  migrate,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
  hashPayload,
} from '../../packages/storage/dist/index.js';
import { createApiContext, createApiServer } from '../../apps/api/dist/index.js';

const tag = randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'localqa-t10-life-'));
const facts = {
  task: 'T10-LIFECYCLE-ROOT',
  tag,
  postgres: null,
  evidenceDir: dir,
  tests: [],
  modelTransportCalls: 0,
  ownership: { containerId: null, volumes: [] },
  limitations: [
    'PG/API admission only; no browser, Worker.once, worker-entry or real model',
    'Independent counterexamples and isolated concurrency checks; conclusions only reflect assertions in this run',
    'P0=false; FakeBrowser/real model acceptance remains unverified',
  ],
};
const ownershipPath = join(dir, 'ownership.json');
function saveEvidence() {
  writeFileSync(
    ownershipPath,
    JSON.stringify(facts.ownership, null, 2) + '\n',
    {
      mode: 0o600,
    },
  );
}
function test(name, fn) {
  nodeTest(name, async () => {
    try {
      await fn();
      facts.tests.push({ name, passed: true });
    } catch (error) {
      facts.tests.push({
        name,
        passed: false,
        code: error.code ?? 'TEST_FAILED',
        message: error.message,
      });
      throw error;
    }
  });
}

let db,
  context,
  server,
  actor,
  project,
  otherProject,
  cookie,
  operatorCookie,
  viewerCookie,
  url,
  pgPort,
  apiPort,
  pgPassword,
  pgConnection;
const envFile = join(dir, 'pg.env');
const kekFile = join(dir, 'kek.json');

async function superuserQuery(sql, params = [], conn = pgConnection) {
  const client = new pg.Client({ connectionString: conn });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function request(path, body, userCookie = cookie, key = randomUUID()) {
  const response = await fetch(`${url}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Cookie: userCookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function portClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error('port recheck timed out'));
    });
  });
}

function sampleCaseDoc(id = 'case-doc-1', name = 'Sample Case', steps = null) {
  return {
    schemaVersion: 1,
    kind: 'localqa/test',
    id,
    name,
    variables: {},
    criteria: [
      {
        id: 'crit-life',
        kind: 'element_visible',
        description: 'Main visible',
        sourceKind: 'user_spec',
        sourceRef: 'smoke',
        locator: { by: 'css', value: 'body' },
      },
    ],
    steps: steps ?? [
      { kind: 'navigate', url: 'http://localhost:8080/' },
      { kind: 'assert', criterionId: 'crit-life' },
    ],
  };
}

before(async () => {
  console.log(`[T10-LIFECYCLE evidence] ${dir}`);
  saveEvidence();
  pgPassword = randomBytes(24).toString('hex');
  writeFileSync(
    envFile,
    `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${pgPassword}\n`,
    { mode: 0o600 },
  );
  const launched = spawnSync(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      `localqa-t10-life-${tag}`,
      '--publish',
      '127.0.0.1::5432',
      '--env-file',
      envFile,
      'postgres:18-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(launched.status, 0, launched.stderr);
  facts.ownership.containerId = launched.stdout.trim();
  assert.match(facts.ownership.containerId, /^[a-f0-9]{64}$/);
  saveEvidence();

  const inspect = spawnSync(
    'docker',
    ['inspect', facts.ownership.containerId],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(inspect.status, 0);
  facts.ownership.volumes = JSON.parse(inspect.stdout)[0]
    .Mounts.filter((mount) => mount.Type === 'volume')
    .map((mount) => mount.Name);

  const portResult = spawnSync(
    'docker',
    ['port', facts.ownership.containerId, '5432/tcp'],
    { encoding: 'utf8' },
  );
  assert.equal(portResult.status, 0);
  pgPort = Number(portResult.stdout.trim().split(':').at(-1));
  assert.ok(pgPort > 0);
  facts.ownership.pgPort = pgPort;
  saveEvidence();

  pgConnection = `postgres://localqa:${pgPassword}@127.0.0.1:${pgPort}/localqa`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      await migrate(
        pgConnection,
        new URL('../../packages/storage/migrations/', import.meta.url),
      );
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, 'migrations ready');

  const vRow = await superuserQuery('SELECT version()');
  facts.postgres = vRow.rows[0].version;

  writeFileSync(
    kekFile,
    JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    }),
    { mode: 0o600 },
  );
  const vault = await SecretVault.fromProtectedFile(kekFile);
  db = new Database(pgConnection);

  const accounts = new AccountsRepository(db);
  const adminUser = await accounts.bootstrap({
    email: `life-owner-${tag}@localqa.test`,
    displayName: 'Lifecycle Owner',
    password: 'OwnerPassword123!',
  });
  actor = { userId: adminUser.id };

  const opUser = await accounts.create(actor, {
    email: `life-op-${tag}@localqa.test`,
    displayName: 'Lifecycle Operator',
    password: 'OperatorPassword123!',
    globalRole: 'member',
  });

  const viewUser = await accounts.create(actor, {
    email: `life-view-${tag}@localqa.test`,
    displayName: 'Lifecycle Viewer',
    password: 'ViewerPassword123!',
    globalRole: 'member',
  });

  const projects = new ProjectRepository(db);
  project = await projects.create(actor, { name: `Project A ${tag}` });
  otherProject = await projects.create(actor, { name: `Project B ${tag}` });

  // Membership setup:
  // Project A: adminUser (owner), opUser (operator), viewUser (viewer)
  // Project B: adminUser (owner), opUser (operator), viewUser (NO membership)
  await db.actor(actor, async (client) => {
    await client.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'operator')",
      [project.id, opUser.id],
    );
    await client.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'viewer')",
      [project.id, viewUser.id],
    );
    await client.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'operator')",
      [otherProject.id, opUser.id],
    );
  });

  const model = await new ModelRepository(db, vault).create(actor, {
    name: 'Never called',
    endpoint: 'https://unused.example.test/v1',
    configuredModelId: 'unused',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
  });
  project = await projects.update(actor, project.id, {
    expectedVersion: project.version,
    defaultModelProfileId: model.id,
  });
  otherProject = await projects.update(actor, otherProject.id, {
    expectedVersion: otherProject.version,
    defaultModelProfileId: model.id,
  });

  context = createApiContext({
    connectionString: pgConnection,
    vault,
    serviceActor: actor,
    artifactsDir: join(dir, 'artifacts'),
    publicOrigin: 'http://localhost',
    modelTransport: async () => {
      facts.modelTransportCalls++;
      throw new Error('External model calls forbidden');
    },
  });

  server = createApiServer(context);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiPort = server.address().port;
  url = `http://127.0.0.1:${apiPort}`;
  facts.ownership.apiPort = apiPort;
  facts.ownership.apiPid = process.pid;
  saveEvidence();

  const l1 = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: adminUser.email,
      password: 'OwnerPassword123!',
    }),
  });
  cookie = l1.headers.get('set-cookie').split(';')[0];

  const lo = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: opUser.email,
      password: 'OperatorPassword123!',
    }),
  });
  operatorCookie = lo.headers.get('set-cookie').split(';')[0];

  const lv = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: viewUser.email,
      password: 'ViewerPassword123!',
    }),
  });
  viewerCookie = lv.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  if (server)
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  await context?.db.close();
  await db?.close();

  const cleanup = { apiClosed: !server?.listening };
  if (facts.ownership.containerId) {
    const removed = spawnSync(
      'docker',
      ['rm', '--force', '--volumes', facts.ownership.containerId],
      { encoding: 'utf8' },
    );
    cleanup.removeStatus = removed.status;
    const checked = spawnSync(
      'docker',
      ['container', 'inspect', facts.ownership.containerId],
      { encoding: 'utf8' },
    );
    cleanup.containerAbsent =
      checked.status !== 0 && /no such container/i.test(checked.stderr);
    cleanup.volumes = facts.ownership.volumes.map((id) => {
      const result = spawnSync('docker', ['volume', 'inspect', id], {
        encoding: 'utf8',
      });
      return {
        id,
        absent: result.status !== 0 && /no such volume/i.test(result.stderr),
      };
    });
  }

  rmSync(envFile, { force: true });
  rmSync(kekFile, { force: true });
  cleanup.credentialsAbsent = !existsSync(envFile) && !existsSync(kekFile);
  if (pgPort) cleanup.pgPortClosed = await portClosed(pgPort);
  if (apiPort) cleanup.apiPortClosed = await portClosed(apiPort);
  facts.ownership.cleanup = cleanup;
  saveEvidence();

  facts.summary = {
    passed: facts.tests.filter((item) => item.passed).length,
    failed: facts.tests.filter((item) => !item.passed).length,
  };
  const results = new URL(
    `./T10-LIFECYCLE-ROOT-${tag}.json`,
    import.meta.url,
  );
  writeFileSync(results, JSON.stringify(facts, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    join(dir, 'results.json'),
    JSON.stringify(facts, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(`[T10-LIFECYCLE results] ${results.pathname}`);

  assert.equal(cleanup.credentialsAbsent, true);
  if (facts.ownership.containerId) {
    assert.equal(cleanup.removeStatus, 0);
    assert.equal(cleanup.containerAbsent, true);
    assert.ok(cleanup.volumes.every((item) => item.absent));
  }
  if (pgPort) assert.equal(cleanup.pgPortClosed, true);
  if (apiPort) assert.equal(cleanup.apiPortClosed, true);
  assert.equal(facts.modelTransportCalls, 0);
});

test('lifecycle roundtrip: create -> approve v1 (head version=2) -> archive (version=3) -> list status filter -> restore (version=4, baseline preserved) -> regression run', async () => {
  const caseSlug = `cycle-${tag}`;
  const doc = sampleCaseDoc('cycle-doc', 'Lifecycle Case');

  // 1. Create saved case: initial version=1, status=active, currentApprovedVersionId=null
  const created = await request(`/projects/${project.id}/saved-cases`, {
    slug: caseSlug,
    name: 'Lifecycle Case',
    document: doc,
  });
  assert.equal(created.status, 201);
  const caseId = created.body.id;
  assert.equal(created.body.version, 1);
  assert.equal(created.body.status, 'active');
  assert.equal(created.body.currentApprovedVersionId, null);

  const versionsRes = await request(`/saved-cases/${caseId}/versions`);
  const version1 = versionsRes.body.items[0];

  // 2. Approve version 1: review increments case head version from 1 to 2!
  const prev = await request(
    `/saved-case-versions/${version1.id}/review-preview`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Approved v1',
    },
  );
  assert.equal(prev.status, 200);

  const rev = await request(`/saved-case-versions/${version1.id}/review`, {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'Approved v1',
    confirmationToken: prev.body.confirmationToken,
  });
  assert.equal(rev.status, 200);

  // Read actual head case from database / list
  const headCase = await db.actor(
    actor,
    async (c) =>
      (
        await c.query(
          'SELECT version, status, current_approved_version_id FROM saved_cases WHERE id = $1',
          [caseId],
        )
      ).rows[0],
  );
  assert.equal(
    headCase.version,
    2,
    'Review approval incremented case head version to 2',
  );
  assert.equal(headCase.current_approved_version_id, version1.id);

  // 3. Archive: requires actual head expectedVersion: 2 -> version becomes 3, status='archived'
  const archiveRes = await request(`/saved-cases/${caseId}/archive`, {
    expectedVersion: 2,
  });
  assert.equal(archiveRes.status, 200, JSON.stringify(archiveRes.body));
  assert.equal(archiveRes.body.status, 'archived');
  assert.equal(archiveRes.body.version, 3);
  assert.equal(archiveRes.body.currentApprovedVersionId, version1.id);

  // 4. Verify list query with status filters:
  // Default (status=active): archived case is excluded
  const listActive = await request(`/projects/${project.id}/saved-cases`);
  assert.equal(listActive.status, 200);
  assert.ok(!listActive.body.items.some((c) => c.id === caseId));

  // status=archived: archived case is included
  const listArchived = await request(
    `/projects/${project.id}/saved-cases?status=archived`,
  );
  assert.equal(listArchived.status, 200);
  assert.ok(listArchived.body.items.some((c) => c.id === caseId));

  // status=all: archived case is included
  const listAll = await request(
    `/projects/${project.id}/saved-cases?status=all`,
  );
  assert.equal(listAll.status, 200);
  assert.ok(listAll.body.items.some((c) => c.id === caseId));

  // Invalid status query param -> 422
  const listInvalid = await request(
    `/projects/${project.id}/saved-cases?status=invalid_status`,
  );
  assert.equal(listInvalid.status, 422);

  // 5. Restore: requires actual head expectedVersion: 3 -> version becomes 4, status='active'
  const restoreRes = await request(`/saved-cases/${caseId}/restore`, {
    expectedVersion: 3,
  });
  assert.equal(restoreRes.status, 200, JSON.stringify(restoreRes.body));
  assert.equal(restoreRes.body.status, 'active');
  assert.equal(restoreRes.body.version, 4);
  assert.equal(
    restoreRes.body.currentApprovedVersionId,
    version1.id,
    'Approval baseline strictly preserved',
  );

  // Verify no new document versions were created in saved_case_versions
  const versAfterRestore = await request(`/saved-cases/${caseId}/versions`);
  assert.equal(versAfterRestore.body.items.length, 1);

  // 6. Now create regression run with restored case -> 202 ACCEPTED
  const regRun = await request('/regression-runs', {
    projectId: project.id,
    caseVersionIds: [version1.id],
  });
  assert.equal(regRun.status, 202, JSON.stringify(regRun.body));
});

test('archive vs regression-runs admission race defense: archived case rejected with 422 in FOR SHARE transaction; frozen run remains immune', async () => {
  const caseSlug = `race-case-${tag}`;
  const doc = sampleCaseDoc('race-doc', 'Admission Race Case');

  const created = await request(`/projects/${project.id}/saved-cases`, {
    slug: caseSlug,
    name: 'Admission Race Case',
    document: doc,
  });
  assert.equal(created.status, 201);
  const caseId = created.body.id;

  const versionsRes = await request(`/saved-cases/${caseId}/versions`);
  const v1 = versionsRes.body.items[0];

  const prev = await request(`/saved-case-versions/${v1.id}/review-preview`, {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'ok',
  });
  await request(`/saved-case-versions/${v1.id}/review`, {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'ok',
    confirmationToken: prev.body.confirmationToken,
  });

  // 1. Create regression run BEFORE archive -> Run freezes binding
  const frozenRun = await request('/regression-runs', {
    projectId: project.id,
    caseVersionIds: [v1.id],
  });
  assert.equal(frozenRun.status, 202);

  // 2. Archive the case
  const arc = await request(`/saved-cases/${caseId}/archive`, {
    expectedVersion: 2,
  });
  assert.equal(arc.status, 200);

  // 3. Attempt to schedule NEW regression run with archived case -> Rejected with 422!
  const blockedRun = await request('/regression-runs', {
    projectId: project.id,
    caseVersionIds: [v1.id],
  });
  assert.equal(
    blockedRun.status,
    422,
    'Archived case must be rejected at regression admission',
  );
  assert.match(blockedRun.body.message, /Archived case cannot be scheduled/);

  // 4. Verify existing frozen run binding in database remains completely immune and intact
  const bindingRow = await db.actor(
    actor,
    async (c) =>
      (
        await c.query(
          'SELECT binding, source_sha256 FROM run_case_regression_bindings WHERE project_id = $1 AND run_id = $2',
          [project.id, frozenRun.body.id],
        )
      ).rows[0],
  );
  assert.ok(bindingRow);
  assert.equal(bindingRow.source_sha256, v1.sha256);
  assert.equal(bindingRow.binding.sourceDocumentSha256, v1.sha256);
});

test('concurrency & optimistic locks: stale expectedVersion, repeat same state (409), upper bound 2147483647 (422)', async () => {
  const caseSlug = `lock-case-${tag}`;
  const created = await request(`/projects/${project.id}/saved-cases`, {
    slug: caseSlug,
    name: 'Lock Case',
    document: sampleCaseDoc('lock-doc', 'Lock Case'),
  });
  assert.equal(created.status, 201);
  const caseId = created.body.id;

  // Stale expectedVersion on archive -> 409
  const staleArc = await request(`/saved-cases/${caseId}/archive`, {
    expectedVersion: 99,
  });
  assert.equal(staleArc.status, 409);
  assert.equal(staleArc.body.code, 'VERSION_CONFLICT');

  // Legitimate archive with version 1 -> 200 (version becomes 2)
  const legitArc = await request(`/saved-cases/${caseId}/archive`, {
    expectedVersion: 1,
  });
  assert.equal(legitArc.status, 200);
  assert.equal(legitArc.body.version, 2);

  // Repeated archive on already archived case -> 409
  const repeatArc = await request(`/saved-cases/${caseId}/archive`, {
    expectedVersion: 2,
  });
  assert.equal(repeatArc.status, 409);

  // Repeated restore on already active case (restore first, then restore again)
  const legitRes = await request(`/saved-cases/${caseId}/restore`, {
    expectedVersion: 2,
  });
  assert.equal(legitRes.status, 200);
  assert.equal(legitRes.body.version, 3);

  const repeatRes = await request(`/saved-cases/${caseId}/restore`, {
    expectedVersion: 3,
  });
  assert.equal(repeatRes.status, 409);

  // Version upper bound check: 2147483647 parses, 2147483648 rejected with 422
  const overflow = await request(`/saved-cases/${caseId}/archive`, {
    expectedVersion: 2147483648,
  });
  assert.equal(
    overflow.status,
    422,
    'Overflow version must be rejected with 422 without SQL 500',
  );
});

test('duplicate in same project: explicit sourceVersionId, active case with draft v1 (never inherits approved), slug conflict (409)', async () => {
  const caseSlug = `orig-case-${tag}`;
  const doc = sampleCaseDoc('orig-doc', 'Original Case');
  const created = await request(`/projects/${project.id}/saved-cases`, {
    slug: caseSlug,
    name: 'Original Case',
    document: doc,
  });
  assert.equal(created.status, 201);
  const caseId = created.body.id;

  const versions = await request(`/saved-cases/${caseId}/versions`);
  const v1 = versions.body.items[0];

  // Approve v1
  const prev = await request(`/saved-case-versions/${v1.id}/review-preview`, {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'ok',
  });
  await request(`/saved-case-versions/${v1.id}/review`, {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'ok',
    confirmationToken: prev.body.confirmationToken,
  });

  // 1. Duplicate in same project (omitting targetProjectId)
  const newSlug = `dup-same-${tag}`;
  const dupRes = await request(`/saved-cases/${caseId}/duplicate`, {
    newSlug,
    newName: 'Duplicated Case',
    sourceVersionId: v1.id,
  });
  assert.equal(dupRes.status, 201, JSON.stringify(dupRes.body));
  const newCaseId = dupRes.body.id;
  assert.notEqual(newCaseId, caseId);
  assert.equal(dupRes.body.projectId, project.id);
  assert.equal(dupRes.body.slug, newSlug);
  assert.equal(dupRes.body.name, 'Duplicated Case');
  assert.equal(dupRes.body.status, 'active');
  assert.equal(dupRes.body.version, 1);
  assert.equal(
    dupRes.body.currentApprovedVersionId,
    null,
    'Duplicate must not inherit approved baseline',
  );

  // Verify new case has only Version 1 and it is strictly draft
  const newVers = await request(`/saved-cases/${newCaseId}/versions`);
  assert.equal(newVers.body.items.length, 1);
  assert.equal(newVers.body.items[0].reviewStatus, 'draft');
  assert.equal(newVers.body.items[0].version, 1);

  // Verify audit log has recorded sourceCaseId, sourceVersionId, and sourceDocumentSha256
  const auditRow = await db.actor(
    actor,
    async (c) =>
      (
        await c.query(
          "SELECT redacted_summary FROM audit_log WHERE action = 'saved_case.duplicated' AND object_id = $1",
          [newCaseId],
        )
      ).rows[0],
  );
  assert.ok(auditRow);
  const summary = auditRow.redacted_summary;
  assert.equal(summary.sourceCaseId, caseId);
  assert.equal(summary.sourceVersionId, v1.id);
  assert.equal(summary.sourceDocumentSha256, v1.sha256);

  // 2. Slug conflict in same project -> 409 IDEMPOTENCY_CONFLICT
  const conflict = await request(`/saved-cases/${caseId}/duplicate`, {
    newSlug,
    newName: 'Another Dup',
    sourceVersionId: v1.id,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
});

test('cross-project duplicate: RBAC ladder (404/403/201), source version mismatch (404), and module SHA mismatch defense (422)', async () => {
  // 1. Module setup in Project A and Project B:
  // Approved module in Project A: sha = hashPayload(modDocA)
  const modDocA = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: 'shared-mod-id',
    name: 'Shared Module',
    variables: {},
    criteria: [
      {
        id: 'c1',
        kind: 'element_visible',
        description: 'c1',
        sourceKind: 'user_spec',
        sourceRef: 'm',
        locator: { by: 'css', value: 'body' },
      },
    ],
    steps: [
      { kind: 'navigate', url: 'http://localhost:8080/' },
      { kind: 'assert', criterionId: 'c1' },
    ],
  };
  const shaA = hashPayload(modDocA);
  await superuserQuery(
    "INSERT INTO regression_module_versions(project_id, name, version, sha256, document, review_status) VALUES($1, 'cross/dep', 1, $2, $3, 'approved')",
    [project.id, shaA, modDocA],
  );

  // In Project B: same module name 'cross/dep@1', but DIFFERENT document and SHA (shaB != shaA)
  const modDocB = {
    ...modDocA,
    name: 'Shared Module with Divergent Content',
  };
  const shaB = hashPayload(modDocB);
  assert.notEqual(shaA, shaB);
  await superuserQuery(
    "INSERT INTO regression_module_versions(project_id, name, version, sha256, document, review_status) VALUES($1, 'cross/dep', 1, $2, $3, 'approved')",
    [otherProject.id, shaB, modDocB],
  );

  // Create case in Project A referencing cross/dep@1
  const caseWithMod = sampleCaseDoc('case-with-mod', 'Case with Module', [
    { kind: 'module', ref: 'cross/dep@1' },
    { kind: 'assert', criterionId: 'crit-life' },
  ]);
  const cRes = await request(`/projects/${project.id}/saved-cases`, {
    slug: `src-case-${tag}`,
    name: 'Source Case with Module',
    document: caseWithMod,
  });
  assert.equal(cRes.status, 201);
  const srcCaseId = cRes.body.id;
  const srcVersions = await request(`/saved-cases/${srcCaseId}/versions`);
  const srcV1 = srcVersions.body.items[0];

  // 2. Cross-project duplicate attempt where target has differing module SHA -> 422 VALIDATION_ERROR!
  const shaMismatchRes = await request(`/saved-cases/${srcCaseId}/duplicate`, {
    targetProjectId: otherProject.id,
    newSlug: `target-mismatch-${tag}`,
    newName: 'Mismatch Target Case',
    sourceVersionId: srcV1.id,
  });
  assert.equal(
    shaMismatchRes.status,
    422,
    'Differing module SHA in target project must be rejected',
  );
  assert.match(shaMismatchRes.body.message, /mismatch/i);

  // 3. Target project lacks the module entirely -> 422 VALIDATION_ERROR
  // Create another project C with no modules
  const pC = await new ProjectRepository(db).create(actor, {
    name: `Project C ${tag}`,
  });
  const missingModRes = await request(`/saved-cases/${srcCaseId}/duplicate`, {
    targetProjectId: pC.id,
    newSlug: `target-missing-${tag}`,
    newName: 'Missing Module Target Case',
    sourceVersionId: srcV1.id,
  });
  assert.equal(missingModRes.status, 422);

  // 4. Source version ID mismatch (sourceVersionId belongs to a different case) -> 404 NOT_FOUND
  const randomVerRes = await request(`/saved-cases/${srcCaseId}/duplicate`, {
    targetProjectId: otherProject.id,
    newSlug: `target-badver-${tag}`,
    newName: 'Bad Ver Case',
    sourceVersionId: randomUUID(),
  });
  assert.equal(randomVerRes.status, 404);

  // 5. Cross-project RBAC ladder:
  // Simple case without module
  const simpleCase = await request(`/projects/${project.id}/saved-cases`, {
    slug: `simple-src-${tag}`,
    name: 'Simple Source',
    document: sampleCaseDoc('simple-doc', 'Simple'),
  });
  assert.equal(simpleCase.status, 201);
  const simpleCaseId = simpleCase.body.id;
  const simpleV1 = (await request(`/saved-cases/${simpleCaseId}/versions`)).body
    .items[0];

  // Viewer on Project A, but NOT a member of target otherProject -> 404 NOT_FOUND (no target leak)
  const noMemberTarget = await request(
    `/saved-cases/${simpleCaseId}/duplicate`,
    {
      targetProjectId: otherProject.id,
      newSlug: `leak-test-${tag}`,
      newName: 'Leak',
      sourceVersionId: simpleV1.id,
    },
    viewerCookie,
  );
  assert.equal(noMemberTarget.status, 404);

  // Operator on both Project A and otherProject -> 201 CREATED
  const opCross = await request(
    `/saved-cases/${simpleCaseId}/duplicate`,
    {
      targetProjectId: otherProject.id,
      newSlug: `op-cross-${tag}`,
      newName: 'Op Cross',
      sourceVersionId: simpleV1.id,
    },
    operatorCookie,
  );
  assert.equal(opCross.status, 201);
  assert.equal(opCross.body.projectId, otherProject.id);
});

// Root independent additions to the delivered isolated PG/API harness.
async function createOwnedCaseWithVersion(slug, document = sampleCaseDoc(slug, slug)) {
  const created = await request(`/projects/${project.id}/saved-cases`, { slug, name: slug, document });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const version = (await request(`/saved-cases/${created.body.id}/versions`)).body.items[0];
  return { record: created.body, version };
}
async function approveOwned(version) {
  const preview = await request(`/saved-case-versions/${version.id}/review-preview`, { expectedVersion: version.version, decision: 'approve', reason: 'Root isolated acceptance' });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const approved = await request(`/saved-case-versions/${version.id}/review`, { expectedVersion: version.version, decision: 'approve', reason: 'Root isolated acceptance', confirmationToken: preview.body.confirmationToken });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
}
async function seedOwnedModule(projectId, name, document, sha = hashPayload(document)) {
  await superuserQuery("INSERT INTO regression_module_versions(project_id,name,version,sha256,document,review_status) VALUES($1,$2,1,$3,$4,'approved')", [projectId, name, sha, document]);
}
test('Root: recursive child dependency divergence refuses copying with zero destination writes', async () => {
  const parentName = `root/parent-${tag}`;
  const childName = `root/child-${tag}`;
  const parentDoc = sampleCaseDoc('root-parent', 'Root parent', [{ kind: 'module', ref: `${childName}@1` }, { kind: 'assert', criterionId: 'crit-life' }]);
  const childA = sampleCaseDoc('root-child', 'Root child source', [{ kind: 'navigate', url: 'http://localhost:8080/source' }, { kind: 'assert', criterionId: 'crit-life' }]);
  const childB = sampleCaseDoc('root-child', 'Root child destination', [{ kind: 'navigate', url: 'http://localhost:8080/destination' }, { kind: 'assert', criterionId: 'crit-life' }]);
  await seedOwnedModule(project.id, parentName, parentDoc);
  await seedOwnedModule(otherProject.id, parentName, parentDoc);
  await seedOwnedModule(project.id, childName, childA);
  await seedOwnedModule(otherProject.id, childName, childB);
  const source = await createOwnedCaseWithVersion(`root-recursive-src-${tag}`, sampleCaseDoc('root-recursive', 'Root recursive', [{ kind: 'module', ref: `${parentName}@1` }, { kind: 'assert', criterionId: 'crit-life' }]));
  const slug = `root-recursive-copy-${tag}`;
  const response = await request(`/saved-cases/${source.record.id}/duplicate`, { targetProjectId: otherProject.id, sourceVersionId: source.version.id, newSlug: slug, newName: 'Root recursive copy' });
  facts.recursiveCopy = { status: response.status, topShaEqual: true, childShaEqual: false };
  const count = (await superuserQuery('SELECT count(*)::int AS count FROM saved_cases WHERE project_id=$1 AND slug=$2', [otherProject.id, slug])).rows[0].count;
  facts.recursiveCopy.destinationRows = count;
  assert.equal(response.status, 422, 'Equal top module hashes must not mask divergent approved child modules');
  assert.equal(count, 0);
});
test('Root: equal stored module SHA with divergent canonical document refuses copying', async () => {
  const name = `root/canonical-${tag}`;
  const a = sampleCaseDoc('root-canonical', 'Root canonical source');
  const b = { ...a, steps: [{ kind: 'navigate', url: 'http://localhost:8080/different' }, { kind: 'assert', criterionId: 'crit-life' }] };
  assert.notEqual(hashPayload(a), hashPayload(b));
  await seedOwnedModule(project.id, name, a);
  await seedOwnedModule(otherProject.id, name, b, hashPayload(a));
  const source = await createOwnedCaseWithVersion(`root-canonical-src-${tag}`, sampleCaseDoc('root-canonical-case', 'Root canonical case', [{ kind: 'module', ref: `${name}@1` }, { kind: 'assert', criterionId: 'crit-life' }]));
  const slug = `root-canonical-copy-${tag}`;
  const response = await request(`/saved-cases/${source.record.id}/duplicate`, { targetProjectId: otherProject.id, sourceVersionId: source.version.id, newSlug: slug, newName: 'Root canonical copy' });
  const count = (await superuserQuery('SELECT count(*)::int AS count FROM saved_cases WHERE project_id=$1 AND slug=$2', [otherProject.id, slug])).rows[0].count;
  facts.canonicalCopy = { status: response.status, storedShaEqual: true, canonicalDocEqual: false, destinationRows: count };
  assert.equal(response.status, 422);
  assert.equal(count, 0);
});
test('Root: actual concurrent archive requests yield one success and one VERSION_CONFLICT', async () => {
  const source = await createOwnedCaseWithVersion(`root-concurrent-${tag}`);
  const results = await Promise.all([request(`/saved-cases/${source.record.id}/archive`, { expectedVersion: 1 }), request(`/saved-cases/${source.record.id}/archive`, { expectedVersion: 1 })]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  assert.equal(results.find(item => item.status === 409).body.code, 'VERSION_CONFLICT');
  const head = (await superuserQuery('SELECT version,status FROM saved_cases WHERE id=$1', [source.record.id])).rows[0];
  assert.equal(head.version, 2);
  assert.equal(head.status, 'archived');
});
test('Root: viewer cannot mutate a visible head and invalid UUID is 422', async () => {
  const source = await createOwnedCaseWithVersion(`root-viewer-${tag}`);
  for (const action of ['archive', 'restore']) {
    assert.equal((await request(`/saved-cases/${source.record.id}/${action}`, { expectedVersion: 1 }, viewerCookie)).status, 403);
    assert.equal((await request(`/saved-cases/not-a-uuid/${action}`, { expectedVersion: 1 })).status, 422);
  }
  const head = (await superuserQuery('SELECT version,status FROM saved_cases WHERE id=$1', [source.record.id])).rows[0];
  assert.equal(head.version, 1);
  assert.equal(head.status, 'active');
});
test('Root: real FOR SHARE admission blocks concurrent archive until frozen run commit', async () => {
  const source = await createOwnedCaseWithVersion(`root-admission-lock-${tag}`);
  await approveOwned(source.version);
  const originalActor = context.db.actor.bind(context.db);
  let unlockAdmission;
  const gate = new Promise(resolve => { unlockAdmission = resolve; });
  let signalLocked;
  const locked = new Promise(resolve => { signalLocked = resolve; });
  let intercepted = false;
  context.db.actor = (actorInput, work) => originalActor(actorInput, async client => {
    const originalQuery = client.query.bind(client);
    client.query = async (...args) => {
      const result = await originalQuery(...args);
      if (!intercepted && typeof args[0] === 'string' && args[0].includes('ORDER BY id ASC FOR SHARE')) {
        intercepted = true;
        signalLocked();
        await gate;
      }
      return result;
    };
    try { return await work(client); }
    finally { client.query = originalQuery; }
  });
  let admission, archive, archiveSettled = false;
  try {
    admission = request('/regression-runs', { projectId: project.id, caseVersionIds: [source.version.id] });
    await Promise.race([locked, delay(5000).then(() => { throw new Error('admission FOR SHARE interception timeout'); })]);
    archive = request(`/saved-cases/${source.record.id}/archive`, { expectedVersion: 2 }).finally(() => { archiveSettled = true; });
    let waiting = [];
    for (let i = 0; i < 60; i++) {
      waiting = (await superuserQuery("SELECT wait_event_type,wait_event,query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id, project_id, slug, name, status%FOR UPDATE'")).rows;
      if (waiting.length) break;
      await delay(20);
    }
    assert.ok(waiting.length > 0, 'Observe actual archive row-lock wait in PostgreSQL');
    assert.equal(archiveSettled, false);
    facts.admissionLock = { observedPgLockWait: true, archivePendingBeforeCommit: true, waitingCount: waiting.length };
    unlockAdmission();
    const run = await admission;
    const archived = await archive;
    assert.equal(run.status, 202, JSON.stringify(run.body));
    assert.equal(archived.status, 200);
    const rows = (await superuserQuery('SELECT source_version_id,source_sha256 FROM run_case_regression_bindings WHERE source_version_id=$1', [source.version.id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_sha256, source.version.sha256);
  } finally {
    unlockAdmission();
    context.db.actor = originalActor;
    await Promise.allSettled([admission, archive].filter(Boolean));
  }
});
test('Root: copying permits eight module invocations and refuses the ninth with zero writes', async () => {
  const names = Array.from({ length: 9 }, (_, i) => `root/depth-${i + 1}-${tag}`);
  for (let i = 8; i >= 0; i--) {
    const steps = i === 8 ? [{ kind: 'assert', criterionId: 'crit-life' }] : [{ kind: 'module', ref: `${names[i + 1]}@1` }];
    const document = sampleCaseDoc(`depth-${i + 1}`, `Depth ${i + 1}`, steps);
    for (const pid of [project.id, otherProject.id]) await seedOwnedModule(pid, names[i], document);
  }
  for (const [start, expected] of [[1, 201], [0, 422]]) {
    const source = await createOwnedCaseWithVersion(`root-depth-source-${start}-${tag}`, sampleCaseDoc(`depth-case-${start}`, `Depth case ${start}`, [{ kind: 'module', ref: `${names[start]}@1` }]));
    const slug = `root-depth-copy-${start}-${tag}`;
    const response = await request(`/saved-cases/${source.record.id.toUpperCase()}/duplicate`, { sourceVersionId: source.version.id.toUpperCase(), targetProjectId: otherProject.id.toUpperCase(), newSlug: slug, newName: `Root depth copy ${start}` });
    assert.equal(response.status, expected, JSON.stringify(response.body));
    const count = (await superuserQuery('SELECT count(*)::int AS count FROM saved_cases WHERE project_id=$1 AND slug=$2', [otherProject.id, slug])).rows[0].count;
    assert.equal(count, expected === 201 ? 1 : 0);
  }
});
test('Root: explicit historical source stays fixed and fixture copy rejects before writes', async () => {
  const source = await createOwnedCaseWithVersion(`root-explicit-source-${tag}`);
  const newer = await request(`/saved-cases/${source.record.id}/versions`, { document: sampleCaseDoc('newer-document', 'Newer document'), expectedVersion: 1 });
  assert.equal(newer.status, 201, JSON.stringify(newer.body));
  const copy = await request(`/saved-cases/${source.record.id}/duplicate`, { sourceVersionId: source.version.id, newSlug: `root-explicit-copy-${tag}`, newName: 'Explicit old version' });
  assert.equal(copy.status, 201);
  const versions = (await request(`/saved-cases/${copy.body.id}/versions`)).body.items;
  assert.equal(versions.length, 1);
  assert.deepEqual(versions[0].document.steps, source.version.document.steps);
  assert.notDeepEqual(versions[0].document, newer.body.document);
  const withFixture = await createOwnedCaseWithVersion(`root-fixture-source-${tag}`, { ...sampleCaseDoc('root-fixture-source', 'Root fixture source'), fixtureRefs: [{ id: 'd1111111-d111-4111-8111-d11111111111', version: 1 }] });
  const slug = `root-fixture-copy-${tag}`;
  const response = await request(`/saved-cases/${withFixture.record.id}/duplicate`, { sourceVersionId: withFixture.version.id, newSlug: slug, newName: 'Fixture copy' });
  assert.equal(response.status, 422);
  const count = (await superuserQuery('SELECT count(*)::int AS count FROM saved_cases WHERE slug=$1', [slug])).rows[0].count;
  assert.equal(count, 0);
});
test('Root: source viewer can duplicate into a project where the same user is operator', async () => {
  const user = await new AccountsRepository(db).create(actor, { email: `root-viewer-operator-${tag}@localqa.test`, displayName: 'Root source viewer target operator', password: 'OwnedFixtureOnly123!', globalRole: 'member' });
  await db.actor(actor, async client => {
    await client.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [project.id, user.id]);
    await client.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'operator')", [otherProject.id, user.id]);
  });
  const login = await fetch(`${url}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'OwnedFixtureOnly123!' }) });
  assert.equal(login.status, 200);
  const memberCookie = login.headers.get('set-cookie').split(';')[0];
  const source = await createOwnedCaseWithVersion(`root-viewer-op-src-${tag}`);
  const cross = await request(`/saved-cases/${source.record.id}/duplicate`, { sourceVersionId: source.version.id, targetProjectId: otherProject.id, newSlug: `root-viewer-op-copy-${tag}`, newName: 'Viewer to operator copy' }, memberCookie);
  assert.equal(cross.status, 201, JSON.stringify(cross.body));
  assert.equal(cross.body.projectId, otherProject.id);
  assert.equal(cross.body.currentApprovedVersionId, null);
  assert.equal(cross.body.version, 1);
  const same = await request(`/saved-cases/${source.record.id}/duplicate`, { sourceVersionId: source.version.id, newSlug: `root-viewer-no-write-${tag}`, newName: 'Viewer no source write' }, memberCookie);
  assert.equal(same.status, 403);
  const archive = await request(`/saved-cases/${source.record.id}/archive`, { expectedVersion: 1 }, memberCookie);
  assert.equal(archive.status, 403);
});
