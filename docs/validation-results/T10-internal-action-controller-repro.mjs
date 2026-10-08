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
  task: 'T10-INTERNAL-ACTION-ROOT',
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
    `./T10-INTERNAL-ACTION-ROOT-${tag}.json`,
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

// Root actual HTTP action-result boundary checks, no browser/provider execution.
async function ownPendingAction() {
  const run = await request('/runs', { projectId: project.id, targetUrl: 'http://localhost:8080/' });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const scope = { projectId: project.id, workerId: `root-action-http-${randomUUID()}` };
  const lease = await context.coordinator.claim(scope);
  assert.ok(lease);
  // Owned fixture changes role only so navigate is permitted without a browser.
  await superuserQuery("UPDATE jobs SET role='explorer' WHERE id=$1", [lease.task.id]);
  const proof = { taskId: lease.task.id, leaseToken: lease.leaseToken, fencingToken: lease.fencingToken, contextVersion: lease.contextVersion };
  const grant = await context.coordinator.grantAction(scope, proof, { name: 'navigate', args: { url: 'http://localhost:8080/' } });
  return { scope, proof, grant };
}
async function actionState(item) {
  return (await superuserQuery(`SELECT i.outcome,i.result_hash,r.status AS reservation_status,r.charged,s.document->>'status' AS step_status,s.document->>'summary' AS step_summary
    FROM action_intents i JOIN budget_reservations r ON r.id=i.reservation_id JOIN steps s ON s.action_id=i.id WHERE i.id=$1`, [item.grant.id])).rows[0];
}
async function resultHttp(item, overrides = {}, outcome = 'succeeded', summary = 'Owned synthetic result') {
  const response = await fetch(`${url}/internal/v1/actions/${item.grant.id}/result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lease-Token': item.proof.leaseToken, 'X-Worker-Id': item.scope.workerId, 'X-Fencing-Token': String(item.proof.fencingToken), 'X-Context-Version': String(item.proof.contextVersion), ...overrides },
    body: JSON.stringify({ outcome, summary, evidenceRefs: [], resultHash: hashPayload({ outcome, summary, evidenceRefs: [] }) }),
  });
  return { status: response.status, body: await response.json() };
}
test('Root: invalid caller token and worker cannot write an action result', async () => {
  const item = await ownPendingAction();
  const before = await actionState(item);
  const response = await resultHttp(item, { 'X-Lease-Token': randomUUID(), 'X-Worker-Id': 'wrong-worker', 'X-Fencing-Token': String(item.proof.fencingToken + 1), 'X-Context-Version': String(item.proof.contextVersion + 1) });
  const after = await actionState(item);
  facts.invalidProof = { status: response.status, before, after };
  assert.notEqual(response.status, 200, 'A nonempty token is not a validated current lease');
  assert.deepEqual(after, before);
});
test('Root: a legitimate HTTP action result settles its reservation and records a hash', async () => {
  const item = await ownPendingAction();
  const response = await resultHttp(item);
  const after = await actionState(item);
  facts.validResult = { status: response.status, after };
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(after.outcome, 'succeeded');
  assert.equal(after.reservation_status, 'settled');
  assert.equal(after.charged.actions, 1);
  assert.match(after.result_hash, /^[a-f0-9]{64}$/);
});
test('Root: released proof and conflicting repeated result cannot overwrite a completed outcome', async () => {
  const item = await ownPendingAction();
  const first = await resultHttp(item);
  assert.equal(first.status, 200);
  const before = await actionState(item);
  await superuserQuery('UPDATE task_leases SET released_at=clock_timestamp() WHERE task_id=$1', [item.proof.taskId]);
  const changed = await resultHttp(item, {}, 'failed', 'Conflicting owned synthetic result');
  const after = await actionState(item);
  facts.releasedConflict = { status: changed.status, before, after };
  assert.notEqual(changed.status, 200);
  assert.deepEqual(after, before);
});
