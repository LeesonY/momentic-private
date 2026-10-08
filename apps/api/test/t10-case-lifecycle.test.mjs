import assert from 'node:assert/strict';
import { before, after, test as nodeTest } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';
import pg from 'pg';
import { parseContract } from '@localqa/contracts';
import {
  Database,
  migrate,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
  hashPayload,
} from '@localqa/storage';
import { createApiContext, createApiServer } from '../dist/index.js';

const tag = randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'localqa-t10-life-'));
const facts = {
  task: 'T10-LIFECYCLE',
  tag,
  postgres: null,
  evidenceDir: dir,
  tests: [],
  modelTransportCalls: 0,
  ownership: { containerId: null, volumes: [] },
  limitations: [
    'PG/API admission only; no browser, Worker.once, worker-entry or real model',
    'Case lifecycle verified with real database locks and immutable audit',
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
        new URL('../../../packages/storage/migrations/', import.meta.url),
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
    `../../../docs/validation-results/T10-LIFECYCLE-1-${tag}.json`,
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

test('sequential archive admission rejection (not concurrency): archived case rejected with 422; frozen run remains immune', async () => {
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
  // Test the actual stored int boundary, not only an out-of-range input.
  await superuserQuery(
    'UPDATE saved_cases SET version=2147483647 WHERE id=$1',
    [caseId],
  );
  assert.equal(
    (
      await request(`/saved-cases/${caseId}/archive`, {
        expectedVersion: 2147483647,
      })
    ).status,
    422,
  );
  await superuserQuery("UPDATE saved_cases SET status='archived' WHERE id=$1", [
    caseId,
  ]);
  assert.equal(
    (
      await request(`/saved-cases/${caseId}/restore`, {
        expectedVersion: 2147483647,
      })
    ).status,
    422,
  );
  assert.deepEqual(
    (
      await superuserQuery(
        'SELECT version,status FROM saved_cases WHERE id=$1',
        [caseId],
      )
    ).rows[0],
    { version: 2147483647, status: 'archived' },
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
  assert.equal(typeof summary, 'object');
  assert.ok(summary && !Array.isArray(summary));
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

test('visible viewer gets 403 before write-RLS locking; hidden case gets 404; invalid UUID gets 422', async () => {
  const c = await request(`/projects/${project.id}/saved-cases`, {
    slug: `viewer-boundary-${tag}`,
    name: 'Viewer boundary',
    document: sampleCaseDoc('viewer-boundary', 'Viewer boundary'),
  });
  assert.equal(c.status, 201);
  for (const operation of ['archive', 'restore']) {
    const denied = await request(
      `/saved-cases/${c.body.id}/${operation}`,
      { expectedVersion: 1 },
      viewerCookie,
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.code, 'FORBIDDEN');
    assert.equal(
      (
        await request(
          `/saved-cases/not-a-uuid/${operation}`,
          { expectedVersion: 1 },
          viewerCookie,
        )
      ).status,
      422,
    );
  }
  const hidden = await request(`/projects/${otherProject.id}/saved-cases`, {
    slug: `hidden-boundary-${tag}`,
    name: 'Hidden boundary',
    document: sampleCaseDoc('hidden-boundary', 'Hidden boundary'),
  });
  assert.equal(hidden.status, 201);
  for (const operation of ['archive', 'restore']) {
    assert.equal(
      (
        await request(
          `/saved-cases/${hidden.body.id}/${operation}`,
          { expectedVersion: 1 },
          viewerCookie,
        )
      ).status,
      404,
    );
  }
  assert.deepEqual(
    (
      await superuserQuery(
        'SELECT status,version FROM saved_cases WHERE id=$1',
        [c.body.id],
      )
    ).rows[0],
    { status: 'active', version: 1 },
  );
  const v = (await request(`/saved-cases/${c.body.id}/versions`)).body.items[0];
  assert.equal(
    (
      await request(
        `/saved-cases/${c.body.id}/duplicate`,
        {
          newSlug: `viewer-denied-${tag}`,
          newName: 'Denied',
          sourceVersionId: v.id,
        },
        viewerCookie,
      )
    ).status,
    403,
  );
});

async function approvedCase(label) {
  const created = await request(`/projects/${project.id}/saved-cases`, {
    slug: `${label}-${tag}`,
    name: label,
    document: sampleCaseDoc(label, label),
  });
  assert.equal(created.status, 201);
  const v = (await request(`/saved-cases/${created.body.id}/versions`)).body
    .items[0];
  const preview = await request(`/saved-case-versions/${v.id}/review-preview`, {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'lock test',
  });
  const review = await request(`/saved-case-versions/${v.id}/review`, {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'lock test',
    confirmationToken: preview.body.confirmationToken,
  });
  assert.equal(review.status, 200);
  return { caseId: created.body.id, version: v };
}

async function observeBlocked(blockerPid, settled) {
  for (let i = 0; i < 100; i++) {
    const rows = (
      await superuserQuery(
        `SELECT pid, state, wait_event_type, wait_event,
              pg_blocking_pids(pid) AS blockers, query
       FROM pg_stat_activity
       WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [blockerPid],
      )
    ).rows;
    if (rows.length) {
      assert.equal(settled(), false, 'HTTP response must still be pending');
      assert.ok(rows.every((r) => r.wait_event_type === 'Lock'));
      facts.lockObservations ??= [];
      facts.lockObservations.push({ blockerPid, pending: true, rows });
      return;
    }
    await delay(20);
  }
  assert.fail('Expected pg_stat_activity blocker was not observed');
}

test('real interleaving: paused archive blocks admission; commit rejects without run insertion', async () => {
  const { caseId, version } = await approvedCase('paused-archive');
  const blocker = new pg.Client({ connectionString: pgConnection });
  await blocker.connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0]
      .pid;
    await blocker.query(
      "UPDATE saved_cases SET status='archived', version=version+1 WHERE id=$1",
      [caseId],
    );
    const before = (await superuserQuery('SELECT count(*)::int AS n FROM runs'))
      .rows[0].n;
    let settled = false;
    pending = request('/regression-runs', {
      projectId: project.id,
      caseVersionIds: [version.id],
    }).finally(() => {
      settled = true;
    });
    await observeBlocked(pid, () => settled);
    await blocker.query('COMMIT');
    const result = await pending;
    assert.equal(result.status, 422);
    assert.equal(
      (await superuserQuery('SELECT count(*)::int AS n FROM runs')).rows[0].n,
      before,
    );
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
    if (pending) await pending;
  }
});

test('real interleaving: paused admission SHARE lock blocks archive; frozen run survives; double archive has one success', async () => {
  const { caseId, version } = await approvedCase('paused-admission');
  const blocker = new pg.Client({ connectionString: pgConnection });
  await blocker.connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0]
      .pid;
    await blocker.query('SELECT id FROM saved_cases WHERE id=$1 FOR SHARE', [
      caseId,
    ]);
    const run = await request('/regression-runs', {
      projectId: project.id,
      caseVersionIds: [version.id],
    });
    assert.equal(run.status, 202);
    const before = (
      await superuserQuery(
        'SELECT binding FROM run_case_regression_bindings WHERE run_id=$1',
        [run.body.id],
      )
    ).rows;
    let settled = false;
    pending = request(`/saved-cases/${caseId}/archive`, {
      expectedVersion: 2,
    }).finally(() => {
      settled = true;
    });
    await observeBlocked(pid, () => settled);
    await blocker.query('COMMIT');
    assert.equal((await pending).status, 200);
    const after = (
      await superuserQuery(
        'SELECT binding FROM run_case_regression_bindings WHERE run_id=$1',
        [run.body.id],
      )
    ).rows;
    assert.deepEqual(after, before);
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
    if (pending) await pending;
  }
  const pairCase = await approvedCase('double-archive');
  const pair = await Promise.all([
    request(`/saved-cases/${pairCase.caseId}/archive`, { expectedVersion: 2 }),
    request(`/saved-cases/${pairCase.caseId}/archive`, { expectedVersion: 2 }),
  ]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 409]);
  const row = (
    await superuserQuery(
      'SELECT version, status FROM saved_cases WHERE id=$1',
      [pairCase.caseId],
    )
  ).rows[0];
  assert.deepEqual(row, { version: 3, status: 'archived' });
});

async function seedModule(
  projectId,
  name,
  document,
  sha = hashPayload(document),
) {
  await superuserQuery(
    "INSERT INTO regression_module_versions(project_id,name,version,sha256,document,review_status) VALUES($1,$2,1,$3,$4,'approved')",
    [projectId, name, sha, document],
  );
}

async function duplicateProbe(
  label,
  steps,
  expectedStatus = 422,
  expectedModuleQueries,
  fixtureMode = 'api',
) {
  assert.ok(['api', 'historical-source-missing'].includes(fixtureMode));
  let c;
  let v;
  if (fixtureMode === 'historical-source-missing') {
    assert.equal(
      label,
      'source',
      'Historical bypass is restricted to the missing source module fixture',
    );
    const caseId = randomUUID();
    const versionId = randomUUID();
    const auditId = randomUUID();
    const sourceSlug = `historical-source-missing-${tag}`;
    const document = parseContract(
      'RegressionDocument',
      sampleCaseDoc(sourceSlug, label, steps),
    );
    const marker = {
      fixture: 'T10-LIFECYCLE historical source-missing draft',
      tag,
      caseId,
      versionId,
      sourceSlug,
      documentSha256: hashPayload(document),
    };
    // Owned isolated superuser only: simulate a schema-valid historical draft
    // whose approved dependency disappeared. New API creation correctly rejects
    // this state; the application admission check must not be weakened.
    await superuserQuery(
      `WITH seeded_case AS (
         INSERT INTO saved_cases(id,project_id,slug,name,status,current_approved_version_id,version)
         VALUES($1,$2,$3,$4,'active',NULL,1) RETURNING id
       ), seeded_version AS (
         INSERT INTO saved_case_versions(id,case_id,project_id,version,document,sha256,review_status,created_by)
         SELECT $5,id,$2,1,$6,$7,'draft',$8 FROM seeded_case RETURNING id
       )
       INSERT INTO audit_log(id,project_id,actor_id,action,object_id,result,redacted_summary)
       SELECT $9,$2,$8,'test.fixture.saved_case.seeded',$1,'ok',$10 FROM seeded_version`,
      [
        caseId,
        project.id,
        sourceSlug,
        label,
        versionId,
        document,
        marker.documentSha256,
        actor.userId,
        auditId,
        marker,
      ],
    );
    facts.fixtureSeeds ??= [];
    facts.fixtureSeeds.push({ ...marker, auditId, mode: fixtureMode });
    c = { body: { id: caseId } };
    // Read the seeded historical draft through the real API under caller RLS.
    const versions = await request(`/saved-cases/${caseId}/versions`);
    assert.equal(versions.status, 200);
    assert.equal(versions.body.items.length, 1);
    v = versions.body.items[0];
    assert.equal(v.id, versionId);
    assert.equal(v.reviewStatus, 'draft');
  } else {
    c = await request(`/projects/${project.id}/saved-cases`, {
      slug: `probe-${label}-${tag}`,
      name: label,
      document: sampleCaseDoc(label, label, steps),
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    v = (await request(`/saved-cases/${c.body.id}/versions`)).body.items[0];
  }
  const slug = `copy-${label}-${tag}`;
  const before = (
    await superuserQuery(
      'SELECT (SELECT count(*) FROM saved_cases) AS cases, (SELECT count(*) FROM saved_case_versions) AS versions, (SELECT count(*) FROM audit_log) AS audits',
    )
  ).rows[0];
  // Count actual queries forwarded to PG, without replacing their results.
  // Top-level node:test cases run sequentially; restore the instance hook even
  // when the HTTP request fails. No production instrumentation or schema change.
  const originalActor = context.db.actor;
  let moduleQueries = 0;
  context.db.actor = function (currentActor, work) {
    return originalActor.call(this, currentActor, async (client) => {
      const originalQuery = client.query;
      client.query = function (...args) {
        const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        if (
          /SELECT project_id, document, sha256 FROM regression_module_versions/.test(
            text ?? '',
          )
        )
          moduleQueries++;
        return originalQuery.apply(this, args);
      };
      try {
        return await work(client);
      } finally {
        client.query = originalQuery;
      }
    });
  };
  let result;
  try {
    result = await request(`/saved-cases/${c.body.id}/duplicate`, {
      targetProjectId: otherProject.id,
      newSlug: slug,
      newName: label,
      sourceVersionId: v.id,
    });
  } finally {
    context.db.actor = originalActor;
  }
  facts.dependencyQueries ??= [];
  facts.dependencyQueries.push({
    label,
    moduleQueries,
    expectedModuleQueries,
    status: result.status,
  });
  if (expectedModuleQueries !== undefined)
    assert.equal(
      moduleQueries,
      expectedModuleQueries,
      'One query per unique approved module, not per invocation',
    );
  assert.ok(
    moduleQueries <= 8 * (100 + 1),
    'Queries bounded by eight module layers and the 100 executable-step cap',
  );
  assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
  if (expectedStatus === 422) {
    const after = (
      await superuserQuery(
        'SELECT (SELECT count(*) FROM saved_cases) AS cases, (SELECT count(*) FROM saved_case_versions) AS versions, (SELECT count(*) FROM audit_log) AS audits',
      )
    ).rows[0];
    assert.deepEqual(
      after,
      before,
      'Rejected dependency must leave zero writes',
    );
  }
  return result;
}

test('recursive duplicate rejects missing source/target, stored SHA forgery, child mismatch/missing and cycles without writes', async () => {
  const leaf = sampleCaseDoc('leaf', 'Leaf');
  const moduleStep = (name) => ({ kind: 'module', ref: `${name}@1` });
  for (const side of ['source', 'target']) {
    const name = `life-${side}-missing`;
    await seedModule(
      side === 'source' ? otherProject.id : project.id,
      name,
      leaf,
    );
    await duplicateProbe(
      side,
      [moduleStep(name)],
      422,
      undefined,
      side === 'source' ? 'historical-source-missing' : 'api',
    );
  }
  const forged = 'life-forged';
  await seedModule(project.id, forged, leaf);
  await seedModule(
    otherProject.id,
    forged,
    { ...leaf, name: 'Different body' },
    hashPayload(leaf),
  );
  await duplicateProbe('forged', [moduleStep(forged)]);

  for (const mode of ['different', 'missing-source', 'missing-target']) {
    const child = `life-child-${mode}`;
    const parent = `life-parent-${mode}`;
    const parentDoc = sampleCaseDoc(parent, parent, [moduleStep(child)]);
    for (const p of [project.id, otherProject.id])
      await seedModule(p, parent, parentDoc);
    if (mode !== 'missing-source') await seedModule(project.id, child, leaf);
    if (mode !== 'missing-target')
      await seedModule(
        otherProject.id,
        child,
        mode === 'different' ? { ...leaf, name: 'Changed child' } : leaf,
      );
    await duplicateProbe(mode, [moduleStep(parent)]);
  }
  const cycleDoc = sampleCaseDoc('cycle', 'Cycle', [moduleStep('life-cycle')]);
  for (const p of [project.id, otherProject.id])
    await seedModule(p, 'life-cycle', cycleDoc);
  await duplicateProbe('cycle', [moduleStep('life-cycle')]);
  const validParent = sampleCaseDoc('valid-parent', 'Valid', [
    moduleStep('life-valid-leaf'),
  ]);
  // Missing environment values must not be evaluated during duplication.
  const templateLeaf = {
    ...leaf,
    steps: [
      { kind: 'navigate', url: '{{env.BASE_URL}}' },
      { kind: 'assert', criterionId: 'crit-life' },
    ],
  };
  for (const p of [project.id, otherProject.id]) {
    await seedModule(p, 'life-valid-leaf', templateLeaf);
    await seedModule(p, 'life-valid-parent', validParent);
  }
  await duplicateProbe(
    'valid-recursive',
    [moduleStep('life-valid-parent')],
    201,
  );
});

test('PG copy depth boundary: case plus eight module calls succeeds; ninth call is 422 with zero writes', async () => {
  const ref = (i) => ({ kind: 'module', ref: `life-depth-boundary-${i}@1` });
  for (let i = 1; i <= 9; i++) {
    const doc =
      i === 9
        ? sampleCaseDoc('depth-leaf', 'Depth leaf')
        : sampleCaseDoc(`depth-${i}`, `Depth ${i}`, [ref(i + 1)]);
    for (const p of [project.id, otherProject.id])
      await seedModule(p, `life-depth-boundary-${i}`, doc);
  }
  // Root case -> modules 2..9: exactly eight invocations, not nine layers
  // counting the case itself. A full helper traversal must accept this.
  const accepted = await duplicateProbe('depth-eight', [ref(2)], 201, 8);
  const copies = await request(`/saved-cases/${accepted.body.id}/versions`);
  assert.equal(copies.status, 200);
  assert.equal(copies.body.items.length, 1);
  assert.equal(copies.body.items[0].reviewStatus, 'draft');
  assert.equal(accepted.body.currentApprovedVersionId, null);
  // Root case -> modules 1..9: reject before querying the ninth invocation.
  await duplicateProbe('depth-nine', [ref(1)], 422, 8);
});

test('bounded dependency traversal: repeated DAG passes, exact 100-step budget and document shape reject with cached queries and zero writes', async () => {
  const ref = (name) => ({ kind: 'module', ref: `${name}@1` });
  const leaf = sampleCaseDoc('budget-leaf', 'Budget leaf');
  const parent = sampleCaseDoc('budget-parent', 'Budget parent', [
    ref('life-budget-leaf'),
    ref('life-budget-leaf'),
  ]);
  for (const p of [project.id, otherProject.id]) {
    await seedModule(p, 'life-budget-leaf', leaf);
    await seedModule(p, 'life-budget-parent', parent);
  }
  // Four invocations of the same leaf through two parent paths: eight
  // executable steps, but only two distinct module queries (both projects).
  await duplicateProbe(
    'repeated-dag',
    [ref('life-budget-parent'), ref('life-budget-parent')],
    201,
    2,
  );
  // Exactly 100 executable steps are legal, including repeated refs.
  await duplicateProbe(
    'expanded-at-limit',
    Array.from({ length: 50 }, () => ref('life-budget-leaf')),
    201,
    1,
  );
  // The 101st executable step is rejected during traversal, not after loading
  // the complete tree; 51 repeated refs must still use only one query.
  await duplicateProbe(
    'expanded-over-limit',
    Array.from({ length: 51 }, () => ref('life-budget-leaf')),
    422,
    1,
  );

  // Deliberately corrupt historical fixture inserted with the owned superuser.
  // Empty steps must be rejected at the first visit, before fanout traversal;
  // this prevents a leafless DAG from evading the non-module expansion budget.
  const empty = { ...leaf, steps: [] };
  const fanout = sampleCaseDoc(
    'work-fanout',
    'Work fanout',
    Array.from({ length: 100 }, () => ref('life-work-empty')),
  );
  for (const p of [project.id, otherProject.id]) {
    await seedModule(p, 'life-work-empty', empty);
    await seedModule(p, 'life-work-fanout', fanout);
  }
  await duplicateProbe(
    'empty-child-before-fanout',
    Array.from({ length: 100 }, () => ref('life-work-fanout')),
    422,
    2,
  );
  // A historical document with 101 steps must fail before following any child
  // reference (even when all references resolve to approved identical modules).
  const oversized = sampleCaseDoc(
    'oversized',
    'Oversized',
    Array.from({ length: 101 }, () => ref('life-budget-leaf')),
  );
  for (const p of [project.id, otherProject.id])
    await seedModule(p, 'life-oversized', oversized);
  await duplicateProbe('document-over-limit', [ref('life-oversized')], 422, 1);
});
