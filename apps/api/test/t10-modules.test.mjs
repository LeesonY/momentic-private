import assert from 'node:assert/strict';
import { before, after, test as nodeTest } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  Database,
  migrate,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
  hashPayload,
} from '@localqa/storage';
import { compileRegression } from '@localqa/orchestrator';
import { createApiContext, createApiServer } from '../dist/index.js';

const tag = randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'localqa-t10-mod-'));
const facts = {
  task: 'T10-MODULES',
  tag,
  postgres: null,
  evidenceDir: dir,
  tests: [],
  modelTransportCalls: 0,
  ownership: { containerId: null, volumes: [] },
  limitations: [
    'PG/API admission only; no browser, Worker.once, worker-entry or real model',
    'Full compiler integration verified statically and via regression binding',
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
  operatorActor,
  project,
  otherProject,
  cookie,
  secondOwnerCookie,
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

function validModuleDoc(id = 'mod-1', name = 'Test Module', steps = null) {
  return {
    schemaVersion: 1,
    kind: 'localqa/test',
    id,
    name,
    variables: { RETRIES: 3 },
    criteria: [
      {
        id: 'crit-main',
        kind: 'element_visible',
        description: 'Main button visible',
        sourceKind: 'user_spec',
        sourceRef: 'mod-spec',
        locator: { by: 'test_id', value: 'btn-main' },
      },
    ],
    steps: steps ?? [
      { kind: 'navigate', url: 'http://localhost:8080/mod' },
      { kind: 'assert', criterionId: 'crit-main' },
    ],
  };
}

before(async () => {
  console.log(`[T10-MODULES evidence] ${dir}`);
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
      `localqa-t10-mod-${tag}`,
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
  assert.ok(ready, 'migrations 001-010 ready');

  // Query and record PostgreSQL server version
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
    email: `mod-owner1-${tag}@localqa.test`,
    displayName: 'Module Owner 1',
    password: 'ModPassword123!',
  });
  actor = { userId: adminUser.id };

  const secondOwner = await accounts.create(actor, {
    email: `mod-owner2-${tag}@localqa.test`,
    displayName: 'Module Owner 2',
    password: 'Owner2Password123!',
    globalRole: 'member',
  });

  const opUser = await accounts.create(actor, {
    email: `mod-op-${tag}@localqa.test`,
    displayName: 'Module Operator',
    password: 'OperatorPassword123!',
    globalRole: 'member',
  });
  operatorActor = { userId: opUser.id };

  const viewerUser = await accounts.create(actor, {
    email: `mod-view-${tag}@localqa.test`,
    displayName: 'Module Viewer',
    password: 'ViewerPassword123!',
    globalRole: 'member',
  });

  const projects = new ProjectRepository(db);
  project = await projects.create(actor, { name: `Module Project ${tag}` });
  otherProject = await projects.create(actor, {
    name: `Other Project ${tag}`,
  });

  // Assign roles in main project
  await db.actor(actor, async (client) => {
    await client.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'owner')",
      [project.id, secondOwner.id],
    );
    await client.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'operator')",
      [project.id, opUser.id],
    );
    await client.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'viewer')",
      [project.id, viewerUser.id],
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

  // Login cookies
  const l1 = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: adminUser.email,
      password: 'ModPassword123!',
    }),
  });
  cookie = l1.headers.get('set-cookie').split(';')[0];

  const l2 = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: secondOwner.email,
      password: 'Owner2Password123!',
    }),
  });
  secondOwnerCookie = l2.headers.get('set-cookie').split(';')[0];

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
      email: viewerUser.email,
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
    `../../../docs/validation-results/T10-MODULES-1-${tag}.json`,
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
  console.log(`[T10-MODULES results] ${results.pathname}`);

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

test('valid module with slash in name: encoded route %2F roundtrip, review approval and list pagination', async () => {
  const moduleName = 'auth/login-flow';
  const encodedName = encodeURIComponent(moduleName);
  const doc = validModuleDoc('auth-mod', 'Auth Flow');

  // 1. Operator creates draft version 1
  const created = await request(
    `/projects/${project.id}/regression-modules`,
    { name: moduleName, document: doc },
    operatorCookie,
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.name, moduleName);
  assert.equal(created.body.version, 1);
  assert.equal(created.body.reviewStatus, 'draft');
  assert.equal(created.body.createdBy, operatorActor.userId);
  assert.ok(created.body.createdAt);
  assert.equal(created.body.reviewedBy, null);
  assert.equal(created.body.reviewedAt, null);

  // 2. Query versions via encoded path: %2F
  const listRes = await request(
    `/projects/${project.id}/regression-modules/${encodedName}/versions`,
  );
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.items.length, 1);
  assert.equal(listRes.body.items[0].name, moduleName);

  // 3. Owner review preview
  const previewRes = await request(
    `/projects/${project.id}/regression-modules/${encodedName}/versions/1/review-preview`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Approved slash-named module',
    },
    cookie,
  );
  assert.equal(previewRes.status, 200, JSON.stringify(previewRes.body));
  assert.equal(previewRes.body.moduleName, moduleName);
  assert.equal(previewRes.body.version, 1);
  assert.equal(previewRes.body.documentSha256, hashPayload(doc));
  assert.ok(previewRes.body.confirmationToken);

  // 4. Commit review
  const reviewRes = await request(
    `/projects/${project.id}/regression-modules/${encodedName}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Approved slash-named module',
      confirmationToken: previewRes.body.confirmationToken,
    },
    cookie,
  );
  assert.equal(reviewRes.status, 200, JSON.stringify(reviewRes.body));
  assert.equal(reviewRes.body.reviewStatus, 'approved');
  assert.equal(reviewRes.body.reviewedBy, actor.userId);
  assert.ok(reviewRes.body.reviewedAt);

  // 5. Query all project modules pagination
  const allRes = await request(`/projects/${project.id}/regression-modules`);
  assert.equal(allRes.status, 200);
  assert.ok(
    allRes.body.items.some((m) => m.name === moduleName && m.version === 1),
  );
});

test('RBAC matrix across all 5 endpoints: operator creates draft, owner reviews, viewer read-only, cross-project 404 zero existence leaks', async () => {
  const modName = 'rbac/test-mod';
  const encoded = encodeURIComponent(modName);
  const doc = validModuleDoc('rbac-doc', 'RBAC Module');

  // 1. Viewer cannot create module -> 403
  const vCreate = await request(
    `/projects/${project.id}/regression-modules`,
    { name: modName, document: doc },
    viewerCookie,
  );
  assert.equal(vCreate.status, 403);

  // 2. Operator can create draft module -> 201
  const opCreate = await request(
    `/projects/${project.id}/regression-modules`,
    { name: modName, document: doc },
    operatorCookie,
  );
  assert.equal(opCreate.status, 201);

  // 3. Viewer and Operator cannot preview review -> 403
  const vPrev = await request(
    `/projects/${project.id}/regression-modules/${encoded}/versions/1/review-preview`,
    { expectedVersion: 1, decision: 'approve', reason: 'v' },
    viewerCookie,
  );
  assert.equal(vPrev.status, 403);

  const opPrev = await request(
    `/projects/${project.id}/regression-modules/${encoded}/versions/1/review-preview`,
    { expectedVersion: 1, decision: 'approve', reason: 'op' },
    operatorCookie,
  );
  assert.equal(opPrev.status, 403);

  // 4. Viewer can read module list and version list -> 200
  const vList = await request(
    `/projects/${project.id}/regression-modules`,
    null,
    viewerCookie,
  );
  assert.equal(vList.status, 200);

  const vVers = await request(
    `/projects/${project.id}/regression-modules/${encoded}/versions`,
    null,
    viewerCookie,
  );
  assert.equal(vVers.status, 200);

  // 5. Owner can preview and commit review -> 200
  const ownerPrev = await request(
    `/projects/${project.id}/regression-modules/${encoded}/versions/1/review-preview`,
    { expectedVersion: 1, decision: 'approve', reason: 'owner preview' },
    cookie,
  );
  assert.equal(ownerPrev.status, 200);

  // Operator cannot commit review even with valid token -> 403
  const opCommit = await request(
    `/projects/${project.id}/regression-modules/${encoded}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'owner preview',
      confirmationToken: ownerPrev.body.confirmationToken,
    },
    operatorCookie,
  );
  assert.equal(opCommit.status, 403);

  const ownerCommit = await request(
    `/projects/${project.id}/regression-modules/${encoded}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'owner preview',
      confirmationToken: ownerPrev.body.confirmationToken,
    },
    cookie,
  );
  assert.equal(ownerCommit.status, 200);

  // 6. Cross-project non-member across all 5 endpoints -> MUST return 404 (zero existence leak)
  // (using viewerCookie who is NOT a member of otherProject)
  const x1 = await request(
    `/projects/${otherProject.id}/regression-modules`,
    { name: 'cross-mod', document: doc },
    viewerCookie,
  );
  assert.equal(x1.status, 404, 'Cross-project create must return 404');

  const x2 = await request(
    `/projects/${otherProject.id}/regression-modules`,
    null,
    viewerCookie,
  );
  assert.equal(x2.status, 404, 'Cross-project list modules must return 404');

  const x3 = await request(
    `/projects/${otherProject.id}/regression-modules/test/versions`,
    null,
    viewerCookie,
  );
  assert.equal(x3.status, 404, 'Cross-project list versions must return 404');

  const x4 = await request(
    `/projects/${otherProject.id}/regression-modules/test/versions/1/review-preview`,
    { expectedVersion: 1, decision: 'approve', reason: 'x' },
    viewerCookie,
  );
  assert.equal(x4.status, 404, 'Cross-project review-preview must return 404');

  const x5 = await request(
    `/projects/${otherProject.id}/regression-modules/test/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'x',
      confirmationToken: randomUUID(),
    },
    viewerCookie,
  );
  assert.equal(x5.status, 404, 'Cross-project review must return 404');
});

test('invalid UUID, numbers, and templates return 422 without SQL 503 error; dot/dot-dot segment prohibited', async () => {
  // Invalid UUID
  const badUuid = await request('/projects/not-a-uuid/regression-modules', {
    name: 'valid-name',
    document: validModuleDoc(),
  });
  assert.equal(badUuid.status, 422);

  // Dot segment prohibition in module name
  for (const badName of [
    '.',
    '..',
    'a/./b',
    'a/../b',
    '/leading',
    'trailing/',
    'a//b',
  ]) {
    const res = await request(`/projects/${project.id}/regression-modules`, {
      name: badName,
      document: validModuleDoc(),
    });
    assert.equal(res.status, 422, `Expected 422 for name "${badName}"`);
  }

  // Invalid version numbers in URL path (0, negative, float, overflow > 2147483647)
  for (const badVer of ['0', '-1', '1.5', 'v1', '2147483648']) {
    const res = await request(
      `/projects/${project.id}/regression-modules/test-mod/versions/${badVer}/review-preview`,
      { expectedVersion: 1, decision: 'approve', reason: 'test' },
    );
    assert.equal(res.status, 422, `Expected 422 for version "${badVer}"`);
  }

  // Version upper bound boundary check: 2147483647 parses, 2147483648 fails with 422
  const maxIntRes = await request(
    `/projects/${project.id}/regression-modules/test-mod/versions/2147483647/review-preview`,
    { expectedVersion: 2147483647, decision: 'approve', reason: 'test' },
  );
  // Not found (404), NOT validation error or 503!
  assert.equal(maxIntRes.status, 404);
});

test('cross-actor token hidden (409), replay protection, TTL expiry and content tampering', async () => {
  const modName = `sec-mod-${tag}`;
  const doc = validModuleDoc('sec-doc', 'Security Test');
  const created = await request(`/projects/${project.id}/regression-modules`, {
    name: modName,
    document: doc,
  });
  assert.equal(created.status, 201);

  // Owner 1 creates review preview
  const prev = await request(
    `/projects/${project.id}/regression-modules/${modName}/versions/1/review-preview`,
    { expectedVersion: 1, decision: 'approve', reason: 'Owner 1 Preview' },
    cookie,
  );
  assert.equal(prev.status, 200);
  const token = prev.body.confirmationToken;

  // 1. Cross-actor token submission: Owner 2 submits Owner 1's token -> 409 VERSION_CONFLICT (hidden, not 403)
  const crossSubmit = await request(
    `/projects/${project.id}/regression-modules/${modName}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Owner 1 Preview',
      confirmationToken: token,
    },
    secondOwnerCookie,
  );
  assert.equal(crossSubmit.status, 409, JSON.stringify(crossSubmit.body));
  assert.equal(crossSubmit.body.code, 'VERSION_CONFLICT');

  // 2. Content tampering: modify reason or expectedVersion -> 409
  const tamper = await request(
    `/projects/${project.id}/regression-modules/${modName}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Tampered reason',
      confirmationToken: token,
    },
    cookie,
  );
  assert.equal(tamper.status, 409);

  // 3. Legitimate approval by Owner 1
  const legit = await request(
    `/projects/${project.id}/regression-modules/${modName}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Owner 1 Preview',
      confirmationToken: token,
    },
    cookie,
  );
  assert.equal(legit.status, 200);

  // 4. Replay attack: re-submitting same consumed token -> 409 VERSION_CONFLICT
  const replay = await request(
    `/projects/${project.id}/regression-modules/${modName}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Owner 1 Preview',
      confirmationToken: token,
    },
    cookie,
  );
  assert.equal(replay.status, 409);
});

test('concurrency: race on initial creation and expectedVersion optimistic lock', async () => {
  const modName = `race-mod-${tag}`;
  const doc = validModuleDoc('race-doc', 'Race Test');

  // Concurrent initial creations without expectedVersion: one wins (201), other gets 409
  const [resA, resB] = await Promise.all([
    request(`/projects/${project.id}/regression-modules`, {
      name: modName,
      document: doc,
    }),
    request(`/projects/${project.id}/regression-modules`, {
      name: modName,
      document: doc,
    }),
  ]);
  const statuses = [resA.status, resB.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  // Concurrent version increment on v1: both specify expectedVersion: 1
  const doc2 = validModuleDoc('race-doc-2', 'Race Test V2');
  const [resV2A, resV2B] = await Promise.all([
    request(`/projects/${project.id}/regression-modules`, {
      name: modName,
      document: doc2,
      expectedVersion: 1,
    }),
    request(`/projects/${project.id}/regression-modules`, {
      name: modName,
      document: doc2,
      expectedVersion: 1,
    }),
  ]);
  const v2Statuses = [resV2A.status, resV2B.status].sort();
  assert.deepEqual(v2Statuses, [201, 409]);
});

test('real migration 001-009 -> seed approved -> migration 010 verifies null audit metadata without backfilling timestamps', async () => {
  // In the same PostgreSQL container, create a dedicated database
  const migDbName = `migtest_${tag.replace(/-/g, '_')}`;
  await superuserQuery(`CREATE DATABASE ${migDbName}`);

  const migConn = `postgres://localqa:${pgPassword}@127.0.0.1:${pgPort}/${migDbName}`;
  const migDir = join(dir, 'mig-steps');
  mkdirSync(migDir, { recursive: true });

  const migrationsSrc = fileURLToPath(
    new URL('../../../packages/storage/migrations/', import.meta.url),
  );
  const files = readdirSync(migrationsSrc).sort();

  // 1. Copy only 001 through 009
  for (const f of files) {
    if (f.startsWith('010')) continue;
    copyFileSync(join(migrationsSrc, f), join(migDir, f));
  }
  const migUrl = pathToFileURL(migDir + '/');
  await migrate(migConn, migUrl);

  // 2. In this 001-009 database, seed project and approved module
  const pId = randomUUID();
  const histDoc = validModuleDoc('hist-009-doc', 'Pre-010 Historical Module');
  const histSha = hashPayload(histDoc);

  await superuserQuery(
    `INSERT INTO projects(id, name, status, version) VALUES($1, 'Mig Test Project', 'active', 1)`,
    [pId],
    migConn,
  );
  await superuserQuery(
    `INSERT INTO regression_module_versions(project_id, name, version, sha256, document, review_status)
     VALUES($1, 'hist/mod', 1, $2, $3, 'approved')`,
    [pId, histSha, histDoc],
    migConn,
  );

  // Verify before 010: columns created_by, created_at do not exist yet
  const colCheckBefore = await superuserQuery(
    `SELECT column_name FROM information_schema.columns WHERE table_name='regression_module_versions' AND column_name='created_at'`,
    [],
    migConn,
  );
  assert.equal(colCheckBefore.rows.length, 0);

  // 3. Now apply migration 010
  copyFileSync(
    join(migrationsSrc, '010_regression_module_reviews.sql'),
    join(migDir, '010_regression_module_reviews.sql'),
  );
  await migrate(migConn, migUrl);

  // 4. Query the historical row after migration 010:
  // All 4 new audit metadata fields MUST BE STRICTLY NULL!
  // No timestamps were backfilled! Historical document, sha256, and status are 100% intact!
  const rowAfter = (
    await superuserQuery(
      `SELECT project_id, name, version, sha256, document, review_status,
              created_by, created_at, reviewed_by, reviewed_at
       FROM regression_module_versions
       WHERE project_id = $1 AND name = 'hist/mod' AND version = 1`,
      [pId],
      migConn,
    )
  ).rows[0];

  assert.ok(rowAfter);
  assert.equal(
    rowAfter.created_by,
    null,
    'Historical created_by must remain NULL',
  );
  assert.equal(
    rowAfter.created_at,
    null,
    'Historical created_at must remain NULL (no backfill)',
  );
  assert.equal(
    rowAfter.reviewed_by,
    null,
    'Historical reviewed_by must remain NULL',
  );
  assert.equal(
    rowAfter.reviewed_at,
    null,
    'Historical reviewed_at must remain NULL',
  );
  assert.equal(rowAfter.sha256, histSha);
  assert.equal(rowAfter.review_status, 'approved');
  assert.deepEqual(rowAfter.document, histDoc);

  await superuserQuery(`DROP DATABASE ${migDbName}`);
});

test('module recursion depth: 8 invocations legal with real compileRegression, 9th rejected; static step limit 100', async () => {
  // Build a chain of approved modules: M1 -> M2 -> M3 -> ... -> M8
  // Register M8 first (leaf), then M7 calling M8, ..., up to M1 calling M2.
  // M8: Leaf
  const m8Doc = validModuleDoc('m8-doc', 'M8 Leaf');
  const m8Create = await request(`/projects/${project.id}/regression-modules`, {
    name: 'mod-chain-8',
    document: m8Doc,
  });
  assert.equal(m8Create.status, 201);
  const m8Prev = await request(
    `/projects/${project.id}/regression-modules/mod-chain-8/versions/1/review-preview`,
    { expectedVersion: 1, decision: 'approve', reason: 'ok' },
  );
  await request(
    `/projects/${project.id}/regression-modules/mod-chain-8/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'ok',
      confirmationToken: m8Prev.body.confirmationToken,
    },
  );

  // M7 through M1
  for (let i = 7; i >= 1; i--) {
    const childName = `mod-chain-${i + 1}`;
    const doc = validModuleDoc(`m${i}-doc`, `M${i}`, [
      { kind: 'module', ref: `${childName}@1` },
      { kind: 'assert', criterionId: 'crit-main' },
    ]);
    const res = await request(`/projects/${project.id}/regression-modules`, {
      name: `mod-chain-${i}`,
      document: doc,
    });
    assert.equal(res.status, 201);
    const prev = await request(
      `/projects/${project.id}/regression-modules/mod-chain-${i}/versions/1/review-preview`,
      { expectedVersion: 1, decision: 'approve', reason: 'ok' },
    );
    await request(
      `/projects/${project.id}/regression-modules/mod-chain-${i}/versions/1/review`,
      {
        expectedVersion: 1,
        decision: 'approve',
        reason: 'ok',
        confirmationToken: prev.body.confirmationToken,
      },
    );
  }

  // Now verify that a root test case invoking mod-chain-1@1 results in a total module depth of 8:
  // Root case invokes M1 (depth 0 in compileRegression path), M1 invokes M2, ..., M7 invokes M8 (path length 7).
  // Total 8 module layers: 100% LEGAL!
  const rootDoc = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: 'root-depth-8',
    name: 'Root invoking 8 module layers',
    variables: {},
    criteria: [
      {
        id: 'root-c1',
        kind: 'element_visible',
        description: 'Root visible',
        sourceKind: 'user_spec',
        sourceRef: 'smoke',
        locator: { by: 'css', value: 'body' },
      },
    ],
    steps: [
      { kind: 'module', ref: 'mod-chain-1@1' },
      { kind: 'assert', criterionId: 'root-c1' },
    ],
  };

  // Compile with real compileRegression:
  const allModules = await db.actor(
    actor,
    async (c) =>
      (
        await c.query(
          'SELECT name, version, sha256, document, review_status FROM regression_module_versions WHERE project_id=$1',
          [project.id],
        )
      ).rows,
  );
  const modMap = new Map(
    allModules.map((m) => [
      `${m.name}@${m.version}`,
      {
        projectId: project.id,
        name: m.name,
        version: m.version,
        sha256: m.sha256,
        document: m.document,
        reviewStatus: m.review_status,
      },
    ]),
  );

  const compiled = compileRegression(rootDoc, {
    projectId: project.id,
    allowedOrigins: ['http://localhost:8080'],
    env: { BASE_URL: 'http://localhost:8080' },
    maxExpandedSteps: 50,
    resolveModule: (name, ver) => modMap.get(`${name}@${ver}`),
  });
  assert.ok(
    compiled.length > 0,
    'Real compileRegression confirms 8 module layers is legal',
  );

  // Now test 9th depth layer rejection:
  // In registration static check, template root is at depth 1, so calling 8 layers results in depth 9 -> 422!
  const m0Doc = validModuleDoc('m0-doc', 'M0', [
    { kind: 'module', ref: 'mod-chain-1@1' },
  ]);
  const m0Res = await request(`/projects/${project.id}/regression-modules`, {
    name: 'mod-chain-0',
    document: m0Doc,
  });
  assert.equal(m0Res.status, 422);

  // Static step limit 100 check: template expanding to >100 static steps is rejected with 422
  const bigSteps = Array.from({ length: 101 }, (_, i) => ({
    kind: 'navigate',
    url: `http://localhost:8080/${i}`,
  }));
  const bigDoc = validModuleDoc('big-doc', 'Big Steps', bigSteps);
  const bigRes = await request(`/projects/${project.id}/regression-modules`, {
    name: 'big-step-mod',
    document: bigDoc,
  });
  assert.equal(bigRes.status, 422);
});

test('legal unbound vars and env template registers and approves; execution without variable rejects; illegal expressions in locator/criteria/arguments return 422 zero persistence', async () => {
  const negativeSlugs = [];

  // 1. Legal template with unbound {{vars.DYNAMIC_ARG}} and {{env.BASE_URL}}
  const paramDoc = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: 'param-doc',
    name: 'Parameterized Module Template',
    variables: { DEFAULT_VAL: 'initial' },
    criteria: [
      {
        id: 'crit-param',
        kind: 'element_visible',
        description: 'Check param',
        sourceKind: 'user_spec',
        sourceRef: 'smoke',
        locator: { by: 'test_id', value: 'input-target' },
      },
    ],
    steps: [
      { kind: 'navigate', url: '{{env.BASE_URL}}/login' },
      {
        kind: 'type_text',
        locator: { by: 'test_id', value: 'input-target' },
        text: '{{vars.DYNAMIC_ARG}}',
      },
      { kind: 'assert', criterionId: 'crit-param' },
    ],
  };

  const regParam = await request(`/projects/${project.id}/regression-modules`, {
    name: 'param-mod',
    document: paramDoc,
  });
  assert.equal(
    regParam.status,
    201,
    'Legal unbound template must pass registration',
  );

  const prevParam = await request(
    `/projects/${project.id}/regression-modules/param-mod/versions/1/review-preview`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Approved unbound template',
    },
  );
  assert.equal(prevParam.status, 200);

  const appParam = await request(
    `/projects/${project.id}/regression-modules/param-mod/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Approved unbound template',
      confirmationToken: prevParam.body.confirmationToken,
    },
  );
  assert.equal(appParam.status, 200);

  // 2. Illegal expression in locator: e.g. {{invalid}} -> 422
  const badLocDoc = validModuleDoc('bad-loc', 'Bad Locator', [
    { kind: 'click', locator: { by: 'test_id', value: '{{invalid_expr}}' } },
  ]);
  const slugBadLoc = `bad-loc-${randomUUID()}`;
  negativeSlugs.push(slugBadLoc);
  const resBadLoc = await request(
    `/projects/${project.id}/regression-modules`,
    { name: slugBadLoc, document: badLocDoc },
  );
  assert.equal(resBadLoc.status, 422);

  // 3. Illegal expression in criterion description -> 422
  const badCritDoc = validModuleDoc('bad-crit', 'Bad Criterion');
  badCritDoc.criteria[0].description = 'Check {{eval(x)}}';
  const slugBadCrit = `bad-crit-${randomUUID()}`;
  negativeSlugs.push(slugBadCrit);
  const resBadCrit = await request(
    `/projects/${project.id}/regression-modules`,
    { name: slugBadCrit, document: badCritDoc },
  );
  assert.equal(resBadCrit.status, 422);

  // 4. Illegal expression in step.arguments -> 422
  const badArgDoc = validModuleDoc('bad-arg', 'Bad Argument', [
    {
      kind: 'module',
      ref: 'auth/login-flow@1',
      arguments: { RETRIES: '{{bad_syntax}}' },
    },
  ]);
  const slugBadArg = `bad-arg-${randomUUID()}`;
  negativeSlugs.push(slugBadArg);
  const resBadArg = await request(
    `/projects/${project.id}/regression-modules`,
    { name: slugBadArg, document: badArgDoc },
  );
  assert.equal(resBadArg.status, 422);

  // 5. Unclosed template expression (e.g. {{env.BASE_URL) -> 422
  const unclosedDoc = validModuleDoc('unclosed-doc', 'Unclosed Expression', [
    { kind: 'navigate', url: '{{env.BASE_URL' },
  ]);
  const slugUnclosed = `unclosed-${randomUUID()}`;
  negativeSlugs.push(slugUnclosed);
  const resUnclosed = await request(
    `/projects/${project.id}/regression-modules`,
    { name: slugUnclosed, document: unclosedDoc },
  );
  assert.equal(resUnclosed.status, 422, 'Unclosed expression must be rejected');

  // 6. Unmatched closing expression (e.g. stray }}) -> 422
  const strayDoc = validModuleDoc('stray-doc', 'Stray Closing Brackets', [
    { kind: 'navigate', url: 'http://localhost:8080/path}}' },
  ]);
  const slugStray = `stray-${randomUUID()}`;
  negativeSlugs.push(slugStray);
  const resStray = await request(`/projects/${project.id}/regression-modules`, {
    name: slugStray,
    document: strayDoc,
  });
  assert.equal(resStray.status, 422, 'Stray closing brackets must be rejected');

  // 7. Illegal expression inside nested expectedValue JSON -> 422
  const nestedBadCritDoc = validModuleDoc(
    'nested-bad-crit',
    'Nested Bad ExpectedValue',
  );
  nestedBadCritDoc.criteria = [
    {
      id: 'crit-nested-bad',
      kind: 'semantic',
      description: 'Check semantic nested',
      sourceKind: 'user_spec',
      sourceRef: 'smoke',
      expectedValue: { deep: { bad: '{{javascript.exec}}' } },
    },
  ];
  nestedBadCritDoc.steps = [
    { kind: 'navigate', url: 'http://localhost:8080/' },
    { kind: 'assert', criterionId: 'crit-nested-bad' },
  ];
  const slugNestedBad = `nested-bad-${randomUUID()}`;
  negativeSlugs.push(slugNestedBad);
  const resNestedBad = await request(
    `/projects/${project.id}/regression-modules`,
    { name: slugNestedBad, document: nestedBadCritDoc },
  );
  assert.equal(
    resNestedBad.status,
    422,
    'Illegal expression in nested expectedValue must be rejected',
  );

  // 8. Approved legacy child with invalid criterion reference rejected -> 422
  // Seed via superuser query (not db.actor) so actor_id() is NULL, maintaining valid hash
  const corruptChildDoc = validModuleDoc('corrupt-child-doc', 'Corrupt Child', [
    { kind: 'navigate', url: 'http://localhost:8080/corrupt' },
    { kind: 'assert', criterionId: 'undeclared-crit-id' },
  ]);
  const corruptChildSha = hashPayload(corruptChildDoc);
  const corruptChildName = `corrupt-child-${randomUUID()}`;
  await superuserQuery(
    `INSERT INTO regression_module_versions(
       project_id, name, version, sha256, document, review_status
     ) VALUES($1, $2, 1, $3, $4, 'approved')`,
    [project.id, corruptChildName, corruptChildSha, corruptChildDoc],
  );

  const parentCallingCorrupt = validModuleDoc(
    'parent-calling-corrupt',
    'Parent Calling Corrupt Child',
    [{ kind: 'module', ref: `${corruptChildName}@1` }],
  );
  const slugParentCorrupt = `parent-corrupt-${randomUUID()}`;
  negativeSlugs.push(slugParentCorrupt);
  const resParentCorrupt = await request(
    `/projects/${project.id}/regression-modules`,
    { name: slugParentCorrupt, document: parentCallingCorrupt },
  );
  assert.equal(
    resParentCorrupt.status,
    422,
    'Parent calling corrupt approved child must be rejected',
  );

  // Verify ZERO rows were persisted for all negative slugs (零落库)
  const persistedCount = await db.actor(actor, async (client) => {
    const q = await client.query(
      'SELECT count(*)::integer AS n FROM regression_module_versions WHERE project_id = $1 AND name = ANY($2::text[])',
      [project.id, negativeSlugs],
    );
    return q.rows[0].n;
  });
  assert.equal(
    persistedCount,
    0,
    'Negative templates must not persist in database',
  );
});

test('direct operator INSERT approved rejected by RLS/trigger; owner mutation of approved document/metadata rejected by immutable guard', async () => {
  const modDoc = validModuleDoc('guard-doc', 'Guard Test');
  const sha = hashPayload(modDoc);

  // 1. Direct operator SQL attempt to insert review_status = 'approved' -> MUST fail with check_violation
  await assert.rejects(
    async () => {
      await db.actor(operatorActor, async (client) => {
        await client.query(
          `INSERT INTO regression_module_versions(
             project_id, name, version, sha256, document, review_status, created_by, created_at
           ) VALUES($1, 'op-hack-approved', 1, $2, $3, 'approved', $4, clock_timestamp())`,
          [project.id, sha, modDoc, operatorActor.userId],
        );
      });
    },
    (err) =>
      err.code === 'VALIDATION_ERROR' ||
      err.message.includes('check_violation'),
  );

  // 2. Register and approve a legitimate module
  const legitName = `guard-approved-${tag}`;
  const c = await request(`/projects/${project.id}/regression-modules`, {
    name: legitName,
    document: modDoc,
  });
  assert.equal(c.status, 201);
  const p = await request(
    `/projects/${project.id}/regression-modules/${legitName}/versions/1/review-preview`,
    { expectedVersion: 1, decision: 'approve', reason: 'ok' },
  );
  assert.equal(p.status, 200);
  const a = await request(
    `/projects/${project.id}/regression-modules/${legitName}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'ok',
      confirmationToken: p.body.confirmationToken,
    },
  );
  assert.equal(a.status, 200);

  // 3. Direct SQL attempt to modify document on the approved row -> check_violation
  await assert.rejects(
    async () => {
      await db.actor(actor, async (client) => {
        await client.query(
          `UPDATE regression_module_versions SET document = '{"tampered":true}'::jsonb WHERE project_id = $1 AND name = $2 AND version = 1`,
          [project.id, legitName],
        );
      });
    },
    (err) =>
      err.message.includes('check_violation') ||
      err.code === 'VALIDATION_ERROR',
  );

  // 4. Direct SQL attempt to modify creation metadata -> check_violation
  await assert.rejects(
    async () => {
      await db.actor(actor, async (client) => {
        await client.query(
          `UPDATE regression_module_versions SET created_at = clock_timestamp() WHERE project_id = $1 AND name = $2 AND version = 1`,
          [project.id, legitName],
        );
      });
    },
    (err) =>
      err.message.includes('check_violation') ||
      err.code === 'VALIDATION_ERROR',
  );

  // 5. Direct SQL attempt to delete approved module version:
  // a) From localqa_app (db.actor): rejected with NOT_FOUND (due to 42501 permission denied mapped by storage)
  await assert.rejects(
    async () => {
      await db.actor(actor, async (client) => {
        await client.query(
          `DELETE FROM regression_module_versions WHERE project_id = $1 AND name = $2 AND version = 1`,
          [project.id, legitName],
        );
      });
    },
    (err) => err.code === 'NOT_FOUND',
  );

  // b) From superuser (which has table privileges): rejected by trigger check_violation
  await assert.rejects(
    async () => {
      await superuserQuery(
        `DELETE FROM regression_module_versions WHERE project_id = $1 AND name = $2 AND version = 1`,
        [project.id, legitName],
      );
    },
    (err) => err.message.includes('check_violation') || err.code === '23514',
  );

  // c) Verify row is completely intact
  const rowCheck = await superuserQuery(
    `SELECT review_status FROM regression_module_versions WHERE project_id = $1 AND name = $2 AND version = 1`,
    [project.id, legitName],
  );
  assert.equal(rowCheck.rows[0]?.review_status, 'approved');
});

test('full vertical workflow: module draft -> review approve -> saved case references module -> regression run freezes binding', async () => {
  const modName = 'checkout/cart-summary';
  const modDoc = validModuleDoc('cart-mod', 'Cart Summary Module', [
    { kind: 'navigate', url: 'http://localhost:8080/cart' },
    { kind: 'assert', criterionId: 'crit-main' },
  ]);

  // 1. Module registration
  const mCreated = await request(`/projects/${project.id}/regression-modules`, {
    name: modName,
    document: modDoc,
  });
  assert.equal(mCreated.status, 201);

  // 2. Module review
  const mPreview = await request(
    `/projects/${project.id}/regression-modules/${encodeURIComponent(modName)}/versions/1/review-preview`,
    { expectedVersion: 1, decision: 'approve', reason: 'Approved Cart Module' },
  );
  assert.equal(mPreview.status, 200);

  const mReview = await request(
    `/projects/${project.id}/regression-modules/${encodeURIComponent(modName)}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Approved Cart Module',
      confirmationToken: mPreview.body.confirmationToken,
    },
  );
  assert.equal(mReview.status, 200);
  assert.equal(mReview.body.reviewStatus, 'approved');

  // 3. Create saved case referencing checkout/cart-summary@1
  const caseDoc = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: 'case-using-module',
    name: 'Saved Case Using Module',
    variables: {},
    criteria: [
      {
        id: 'case-c1',
        kind: 'element_visible',
        description: 'Case check',
        sourceKind: 'user_spec',
        sourceRef: 'smoke',
        locator: { by: 'css', value: 'body' },
      },
    ],
    steps: [
      { kind: 'module', ref: `${modName}@1` },
      { kind: 'assert', criterionId: 'case-c1' },
    ],
  };

  const caseCreated = await request(`/projects/${project.id}/saved-cases`, {
    slug: `case-mod-${tag}`,
    name: 'Saved Case with Module',
    document: caseDoc,
  });
  assert.equal(caseCreated.status, 201, JSON.stringify(caseCreated.body));

  const versions = await request(
    `/saved-cases/${caseCreated.body.id}/versions`,
  );
  const version = versions.body.items[0];

  // 4. Approve saved case
  const cPreview = await request(
    `/saved-case-versions/${version.id}/review-preview`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Approve case with module',
    },
  );
  assert.equal(cPreview.status, 200);

  const cReview = await request(`/saved-case-versions/${version.id}/review`, {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'Approve case with module',
    confirmationToken: cPreview.body.confirmationToken,
  });
  assert.equal(cReview.status, 200);

  // 5. Trigger regression run
  const regRun = await request('/regression-runs', {
    projectId: project.id,
    caseVersionIds: [version.id],
  });
  assert.equal(regRun.status, 202, JSON.stringify(regRun.body));
  assert.equal(regRun.body.executionMode, 'regression');

  // 6. Verify frozen binding in database contains the module snapshot
  const bindingRow = await db.actor(actor, async (client) => {
    const r = await client.query(
      'SELECT binding FROM run_case_regression_bindings WHERE project_id = $1 AND run_id = $2',
      [project.id, regRun.body.id],
    );
    return r.rows[0];
  });
  assert.ok(bindingRow);
  const binding = bindingRow.binding;
  assert.ok(Array.isArray(binding.moduleSnapshots));
  const snap = binding.moduleSnapshots.find(
    (m) => m.name === modName && m.version === 1,
  );
  assert.ok(snap, 'Binding must freeze the exact approved module snapshot');
  assert.equal(snap.sha256, hashPayload(modDoc));
  assert.equal(snap.reviewStatus, 'approved');
});

test('11th regression: uppercase and mixed-case projectId URL paths normalize canonically and do not falsely trigger 409 VERSION_CONFLICT on review', async () => {
  const upperProjectId = project.id.toUpperCase();
  const mixedProjectId =
    project.id.slice(0, 18).toUpperCase() + project.id.slice(18).toLowerCase();
  const modName = `case-fold-${tag}`;
  const doc = validModuleDoc('case-fold-doc', 'Case Folding Module');

  // 1. Create module draft with uppercase projectId path -> 201 Created
  const created = await request(
    `/projects/${upperProjectId}/regression-modules`,
    { name: modName, document: doc },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.projectId, project.id.toLowerCase());
  assert.equal(created.body.name, modName);

  // 2. Generate review preview with mixed-case projectId path -> 200 OK
  const preview = await request(
    `/projects/${mixedProjectId}/regression-modules/${modName}/versions/1/review-preview`,
    { expectedVersion: 1, decision: 'approve', reason: 'Case folding review' },
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.projectId, project.id.toLowerCase());
  assert.ok(preview.body.confirmationToken);

  // 3. Commit review with uppercase projectId path -> 200 OK (no false 409 VERSION_CONFLICT)
  const reviewed = await request(
    `/projects/${upperProjectId}/regression-modules/${modName}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Case folding review',
      confirmationToken: preview.body.confirmationToken,
    },
  );
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.reviewStatus, 'approved');
  assert.equal(reviewed.body.projectId, project.id.toLowerCase());

  // 4. List versions with uppercase projectId path -> 200 OK
  const list = await request(
    `/projects/${upperProjectId}/regression-modules/${modName}/versions`,
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].projectId, project.id.toLowerCase());
});

test('12th regression: 120-character module name registers, reviews and survives saved-case reference and frozen regression run binding', async () => {
  // Exact 120-character module name with segment path
  const longName = 'm'.repeat(59) + '/' + 'n'.repeat(60);
  assert.equal(longName.length, 120);
  const modDoc = validModuleDoc('long-mod-doc', 'Long Module Name');

  // 1. Module registration
  const mCreated = await request(`/projects/${project.id}/regression-modules`, {
    name: longName,
    document: modDoc,
  });
  assert.equal(mCreated.status, 201, JSON.stringify(mCreated.body));
  assert.equal(mCreated.body.name, longName);

  // 2. Module review preview & commit via encoded path (%2F)
  const encodedLongName = encodeURIComponent(longName);
  const mPreview = await request(
    `/projects/${project.id}/regression-modules/${encodedLongName}/versions/1/review-preview`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Approve 120-char module',
    },
  );
  assert.equal(mPreview.status, 200, JSON.stringify(mPreview.body));

  const mReview = await request(
    `/projects/${project.id}/regression-modules/${encodedLongName}/versions/1/review`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Approve 120-char module',
      confirmationToken: mPreview.body.confirmationToken,
    },
  );
  assert.equal(mReview.status, 200);
  assert.equal(mReview.body.reviewStatus, 'approved');

  // 3. Create saved case referencing this 120-char module (step.ref is 122 chars: 120 + '@1')
  const refString = `${longName}@1`;
  assert.equal(refString.length, 122);
  const caseDoc = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: 'case-using-long-module',
    name: 'Saved Case with 120-char Module',
    variables: {},
    criteria: [
      {
        id: 'long-case-c1',
        kind: 'element_visible',
        description: 'Long case check',
        sourceKind: 'user_spec',
        sourceRef: 'smoke',
        locator: { by: 'css', value: 'body' },
      },
    ],
    steps: [
      { kind: 'module', ref: refString },
      { kind: 'assert', criterionId: 'long-case-c1' },
    ],
  };

  const caseCreated = await request(`/projects/${project.id}/saved-cases`, {
    slug: `case-long-${tag}`,
    name: 'Case with Long Module',
    document: caseDoc,
  });
  assert.equal(caseCreated.status, 201, JSON.stringify(caseCreated.body));

  const versions = await request(
    `/saved-cases/${caseCreated.body.id}/versions`,
  );
  const version = versions.body.items[0];

  // 4. Approve saved case
  const cPreview = await request(
    `/saved-case-versions/${version.id}/review-preview`,
    {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Approve case with 120-char module',
    },
  );
  assert.equal(cPreview.status, 200);

  const cReview = await request(`/saved-case-versions/${version.id}/review`, {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'Approve case with 120-char module',
    confirmationToken: cPreview.body.confirmationToken,
  });
  assert.equal(cReview.status, 200);

  // 5. Trigger regression run
  const regRun = await request('/regression-runs', {
    projectId: project.id,
    caseVersionIds: [version.id],
  });
  assert.equal(regRun.status, 202, JSON.stringify(regRun.body));
  assert.equal(regRun.body.executionMode, 'regression');

  // 6. Verify frozen binding contains the exact 120-character module snapshot
  const bindingRow = await db.actor(actor, async (client) => {
    const r = await client.query(
      'SELECT binding FROM run_case_regression_bindings WHERE project_id = $1 AND run_id = $2',
      [project.id, regRun.body.id],
    );
    return r.rows[0];
  });
  assert.ok(bindingRow);
  const binding = bindingRow.binding;
  assert.ok(Array.isArray(binding.moduleSnapshots));
  const snap = binding.moduleSnapshots.find(
    (m) => m.name === longName && m.version === 1,
  );
  assert.ok(snap, 'Binding must freeze the exact 120-char module snapshot');
  assert.equal(snap.sha256, hashPayload(modDoc));
  assert.equal(snap.reviewStatus, 'approved');
});
