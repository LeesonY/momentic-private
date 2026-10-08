import assert from 'node:assert/strict';
import { before, after, afterEach, test as nodeTest } from 'node:test';
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
const dir = mkdtempSync(join(tmpdir(), 'localqa-action-result-'));
const facts = {
  task: 'T10-INTERNAL-ACTION-RESULT',
  tag,
  evidenceDir: dir,
  tests: [],
  postgres: null,
  modelTransportCalls: 0,
  ownership: { containerId: null, volumes: [] },
  limitations: [
    'Real PG18 and HTTP result boundary only; no browser, worker-entry, Worker.once or provider',
    'Owned role-only task fixture permits a synthetic navigate intent; no page action executed',
    'P0=false; AUTH4C not implemented',
  ],
};
let db,
  context,
  server,
  actor,
  project,
  otherProject,
  cookie,
  url,
  pgConnection,
  pgPort,
  apiPort;
const envFile = join(dir, 'pg.env');
const kekFile = join(dir, 'kek.json');
const items = [];
const saveOwnership = () =>
  writeFileSync(
    join(dir, 'ownership.json'),
    JSON.stringify(facts.ownership, null, 2) + '\n',
    { mode: 0o600 },
  );
const test = (name, fn) =>
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
async function admin(sql, params = []) {
  const client = new pg.Client({ connectionString: pgConnection });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}
async function post(path, body, headers = {}) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
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
      reject(new Error('Port recheck timed out'));
    });
  });
}

before(async () => {
  console.log(`[T10 action result evidence] ${dir}`);
  saveOwnership();
  const password = randomBytes(24).toString('hex');
  writeFileSync(
    envFile,
    `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  const launched = spawnSync(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      `localqa-action-result-${tag}`,
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
  saveOwnership();
  const inspected = spawnSync(
    'docker',
    ['inspect', facts.ownership.containerId],
    { encoding: 'utf8' },
  );
  assert.equal(inspected.status, 0);
  const container = JSON.parse(inspected.stdout)[0];
  facts.ownership.volumes = container.Mounts.filter(
    (m) => m.Type === 'volume',
  ).map((m) => m.Name);
  pgPort = Number(container.NetworkSettings.Ports['5432/tcp'][0].HostPort);
  facts.ownership.pgPort = pgPort;
  saveOwnership();
  pgConnection = `postgres://localqa:${password}@127.0.0.1:${pgPort}/localqa`;
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
  assert.ok(ready, 'Owned PG migrations ready');
  facts.postgres = (await admin('SELECT version()')).rows[0].version;
  assert.match(facts.postgres, /PostgreSQL 18\./);
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
  const owner = await accounts.bootstrap({
    email: `action-${tag}@localqa.test`,
    displayName: 'Action result owner',
    password: 'ActionOwner123!',
  });
  actor = { userId: owner.id };
  const projects = new ProjectRepository(db);
  project = await projects.create(actor, { name: `Action project ${tag}` });
  otherProject = await projects.create(actor, {
    name: `Foreign action project ${tag}`,
  });
  const model = await new ModelRepository(db, vault).create(actor, {
    name: 'Never called',
    endpoint: 'https://unused.example.test/v1',
    configuredModelId: 'unused',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
  });
  for (const p of [project, otherProject])
    await projects.update(actor, p.id, {
      expectedVersion: p.version,
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
      throw new Error('Provider forbidden');
    },
  });
  server = createApiServer(context);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiPort = server.address().port;
  url = `http://127.0.0.1:${apiPort}`;
  facts.ownership.apiPort = apiPort;
  facts.ownership.apiPid = process.pid;
  saveOwnership();
  const login = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: owner.email, password: 'ActionOwner123!' }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});

// Release only this test's fixtures so the next test cannot hit platform slots.
// This does not run Worker/recovery and happens after all zero-write assertions.
afterEach(async () => {
  for (const item of items.splice(0)) {
    await admin(
      "UPDATE jobs SET status='interrupted',lease_until=NULL WHERE id=$1",
      [item.proof.taskId],
    );
    await admin(
      'UPDATE task_leases SET released_at=clock_timestamp() WHERE task_id=$1',
      [item.proof.taskId],
    );
    await admin(
      "UPDATE budget_reservations SET status='released',charged='{}' WHERE task_id=$1 AND kind='concurrency' AND status='reserved'",
      [item.proof.taskId],
    );
  }
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
      const check = spawnSync('docker', ['volume', 'inspect', id], {
        encoding: 'utf8',
      });
      return {
        id,
        absent: check.status !== 0 && /no such volume/i.test(check.stderr),
      };
    });
  }
  rmSync(envFile, { force: true });
  rmSync(kekFile, { force: true });
  cleanup.credentialsAbsent = !existsSync(envFile) && !existsSync(kekFile);
  if (pgPort) cleanup.pgPortClosed = await portClosed(pgPort);
  if (apiPort) cleanup.apiPortClosed = await portClosed(apiPort);
  facts.ownership.cleanup = cleanup;
  facts.summary = {
    passed: facts.tests.filter((t) => t.passed).length,
    failed: facts.tests.filter((t) => !t.passed).length,
  };
  saveOwnership();
  const report = new URL(
    `../../../docs/validation-results/T10-INTERNAL-ACTION-RESULT-${tag}.json`,
    import.meta.url,
  );
  writeFileSync(report, JSON.stringify(facts, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    join(dir, 'results.json'),
    JSON.stringify(facts, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(`[T10 action result report] ${report.pathname}`);
  assert.equal(facts.modelTransportCalls, 0);
  assert.equal(cleanup.credentialsAbsent, true);
  if (facts.ownership.containerId) {
    assert.equal(cleanup.removeStatus, 0);
    assert.equal(cleanup.containerAbsent, true);
    assert.ok(cleanup.volumes.every((v) => v.absent));
  }
  if (pgPort) assert.equal(cleanup.pgPortClosed, true);
  if (apiPort) assert.equal(cleanup.apiPortClosed, true);
});

async function ownAction(p = project) {
  const run = await post(
    '/api/v1/runs',
    { projectId: p.id, targetUrl: 'http://localhost:8080/' },
    { Cookie: cookie, 'Idempotency-Key': randomUUID() },
  );
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const scope = { projectId: p.id, workerId: `action-http-${randomUUID()}` };
  const lease = await context.coordinator.claim(scope);
  assert.ok(lease);
  assert.equal(lease.task.runId, run.body.id);
  const proof = {
    taskId: lease.task.id,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    contextVersion: lease.contextVersion,
  };
  const item = { scope, proof, runId: run.body.id };
  items.push(item);
  await admin("UPDATE jobs SET role='explorer' WHERE id=$1", [proof.taskId]);
  item.grant = await context.coordinator.grantAction(scope, proof, {
    name: 'navigate',
    args: { url: 'http://localhost:8080/' },
  });
  return item;
}
const payload = (changes = {}) => ({
  outcome: 'succeeded',
  summary: 'UNTRUSTED-SUMMARY-SENTINEL',
  evidenceRefs: [],
  resultHash: hashPayload('opaque-client-receipt'),
  ...changes,
});
const headers = (item) => ({
  'X-Lease-Token': item.proof.leaseToken,
  'X-Worker-Id': item.scope.workerId,
  'X-Fencing-Token': String(item.proof.fencingToken),
  'X-Context-Version': String(item.proof.contextVersion),
});
const result = (
  item,
  body = payload(),
  h = headers(item),
  id = item.grant.id,
) => post(`/internal/v1/actions/${id}/result`, body, h);
async function state(item) {
  return (
    await admin(
      `SELECT jsonb_build_object('intent',to_jsonb(i),'step',s.document,'reservation',to_jsonb(r),'budget',to_jsonb(b),
    'events',(SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.seq),'[]'::jsonb) FROM run_events e WHERE e.run_id=i.run_id),
    'snapshots',(SELECT count(*) FROM page_snapshots p WHERE p.run_id=i.run_id)) AS state
    FROM action_intents i JOIN steps s ON s.action_id=i.id JOIN budget_reservations r ON r.id=i.reservation_id JOIN run_budgets b ON b.run_id=i.run_id WHERE i.id=$1`,
      [item.grant.id],
    )
  ).rows[0].state;
}
async function rejectedUnchanged(item, send, status) {
  const before = await state(item);
  const response = await send();
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.deepEqual(
    await state(item),
    before,
    'Rejected result must make zero ledger/budget/event/snapshot writes',
  );
  return response;
}
async function artifact(item) {
  const id = randomUUID();
  await context.coordinator.saveArtifact(
    item.scope,
    item.proof,
    parseContract('Artifact', {
      id,
      projectId: item.scope.projectId,
      runId: item.runId,
      taskId: item.proof.taskId,
      stepId: item.grant.step.id,
      caseId: null,
      snapshotId: null,
      kind: 'other',
      status: 'missing',
      bytes: null,
      sha256: null,
      contentUrl: null,
      redaction: 'not_needed',
      error: 'Synthetic owned metadata only',
      createdAt: new Date().toISOString(),
    }),
  );
  return id;
}

test('Root counterexample: forged combined proof and individual wrong token/worker/fencing/context make zero writes', async () => {
  const item = await ownAction();
  const bad = {
    ...headers(item),
    'X-Lease-Token': randomUUID(),
    'X-Worker-Id': 'wrong-worker',
    'X-Fencing-Token': String(item.proof.fencingToken + 1),
    'X-Context-Version': String(item.proof.contextVersion + 1),
  };
  await rejectedUnchanged(item, () => result(item, payload(), bad), 409);
  for (const [key, value] of Object.entries(bad)) {
    await rejectedUnchanged(
      item,
      () => result(item, payload(), { ...headers(item), [key]: value }),
      409,
    );
  }
});

test('strict mandatory headers and integer syntax; invalid UUID/unknown ID; cookie and snapshot body cannot bypass', async () => {
  const item = await ownAction();
  for (const key of Object.keys(headers(item))) {
    const h = headers(item);
    delete h[key];
    await rejectedUnchanged(
      item,
      () => result(item, payload(), h),
      key === 'X-Lease-Token' || key === 'X-Worker-Id' ? 403 : 422,
    );
  }
  for (const key of ['X-Fencing-Token', 'X-Context-Version'])
    for (const value of ['0', '-1', '1.5', 'abc', '9007199254740992', '1, 2'])
      await rejectedUnchanged(
        item,
        () => result(item, payload(), { ...headers(item), [key]: value }),
        422,
      );
  await rejectedUnchanged(
    item,
    () => result(item, payload(), headers(item), 'not-a-uuid'),
    422,
  );
  await rejectedUnchanged(
    item,
    () => result(item, payload(), headers(item), randomUUID()),
    404,
  );
  await rejectedUnchanged(
    item,
    () => result(item, payload(), { ...headers(item), Cookie: cookie }),
    403,
  );
  await rejectedUnchanged(
    item,
    () =>
      result(item, {
        ...payload(),
        snapshot: { displayUrl: 'http://localhost:8080/' },
      }),
    422,
  );
});

test('legitimate result settles once, computes server hash, fixes summary, preserves Step metadata; same retry/step alias do not charge twice', async () => {
  const item = await ownAction();
  const before = await state(item);
  const body = payload();
  const first = await result(item, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.actionId, item.grant.id);
  const saved = await state(item);
  assert.equal(saved.intent.outcome, 'succeeded');
  assert.equal(
    saved.intent.result_hash,
    hashPayload({
      status: 'succeeded',
      snapshot: null,
      evidence: [],
      transportFingerprint: hashPayload(body),
    }),
  );
  assert.equal(saved.reservation.status, 'settled');
  assert.deepEqual(saved.reservation.charged, { actions: 1 });
  assert.equal(saved.budget.used.actions, before.budget.used.actions + 1);
  assert.equal(saved.step.summary, 'Browser succeeded');
  assert.equal(saved.snapshots, before.snapshots);
  for (const key of [
    'id',
    'runId',
    'taskId',
    'caseId',
    'seq',
    'toolName',
    'targetDescription',
    'createdAt',
    'regressionSource',
  ])
    assert.deepEqual(saved.step[key], before.step[key]);
  assert.ok(!JSON.stringify(saved).includes(body.summary));
  assert.equal((await result(item, body)).status, 200);
  const alias = await result(
    item,
    body,
    headers(item),
    item.grant.step.id.toUpperCase(),
  );
  assert.equal(alias.status, 200);
  assert.equal(alias.body.actionId, item.grant.id);
  assert.deepEqual(await state(item), saved);
});

test('full payload differs: opaque resultHash, summary, outcome, evidence and order cannot masquerade as retry', async () => {
  const item = await ownAction();
  const a = await artifact(item),
    b = await artifact(item);
  const body = payload({ evidenceRefs: [a, b] });
  assert.equal((await result(item, body)).status, 200);
  for (const change of [
    { resultHash: hashPayload('different-client-hash') },
    { summary: 'Different summary' },
    { outcome: 'failed' },
    { evidenceRefs: [] },
    { evidenceRefs: [b, a] },
  ]) {
    const response = await rejectedUnchanged(
      item,
      () => result(item, { ...body, ...change }),
      409,
    );
    assert.equal(response.body.code, 'IDEMPOTENCY_CONFLICT');
  }
});

for (const scenario of [
  'expired',
  'released',
  'old-fencing',
  'context-changed',
  'cancelled',
])
  test(`current proof required: ${scenario} rejects with zero writes`, async () => {
    const item = await ownAction();
    if (scenario === 'expired') {
      await admin(
        "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [item.proof.taskId],
      );
      await admin(
        "UPDATE task_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",
        [item.proof.taskId],
      );
    } else if (scenario === 'released')
      await admin(
        'UPDATE task_leases SET released_at=clock_timestamp() WHERE task_id=$1',
        [item.proof.taskId],
      );
    else if (scenario === 'old-fencing')
      await admin('UPDATE jobs SET fencing_token=fencing_token+1 WHERE id=$1', [
        item.proof.taskId,
      ]);
    else if (scenario === 'context-changed') {
      const updated = await post(
        `/api/v1/runs/${item.runId}/messages`,
        {
          text: 'Owned context advancement',
          expectedContextVersion: item.proof.contextVersion,
        },
        { Cookie: cookie },
      );
      assert.equal(updated.status, 202, JSON.stringify(updated.body));
      assert.equal(updated.body.contextVersion, item.proof.contextVersion + 1);
    } else await context.coordinator.cancel(actor, project.id, item.runId);
    await rejectedUnchanged(item, () => result(item), 409);
  });

test('Root counterexample: released lease cannot overwrite or repeat a recorded result', async () => {
  const item = await ownAction();
  assert.equal((await result(item)).status, 200);
  await admin(
    'UPDATE task_leases SET released_at=clock_timestamp() WHERE task_id=$1',
    [item.proof.taskId],
  );
  await rejectedUnchanged(
    item,
    () => result(item, payload({ outcome: 'failed', summary: 'conflicting' })),
    409,
  );
  await rejectedUnchanged(item, () => result(item), 409);
});

test('missing/foreign artifact and cross-task proof reject; own evidence accepted; alias resolves actual intent', async () => {
  const item = await ownAction();
  const sibling = await ownAction();
  const foreign = await ownAction(otherProject);
  const otherTaskEvidence = await artifact(sibling),
    foreignEvidence = await artifact(foreign);
  for (const id of [randomUUID(), otherTaskEvidence, foreignEvidence])
    await rejectedUnchanged(
      item,
      () => result(item, payload({ evidenceRefs: [id] })),
      404,
    );
  await rejectedUnchanged(
    item,
    () => result(item, payload(), headers(sibling)),
    409,
  );
  const own = await artifact(item);
  const response = await result(
    item,
    payload({ evidenceRefs: [own] }),
    headers(item),
    item.grant.step.id,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.actionId, item.grant.id);
  assert.deepEqual((await state(item)).step.evidenceRefs, [own]);
});

for (const outcome of ['cancelled', 'unknown', 'failed'])
  test(`HTTP ${outcome} preserves status and conservatively charges one action, not success`, async () => {
    const item = await ownAction();
    const before = await state(item);
    const body = payload({ outcome });
    assert.equal((await result(item, body)).status, 200);
    const saved = await state(item);
    assert.equal(saved.intent.outcome, outcome);
    assert.equal(saved.step.status, outcome);
    assert.equal(saved.step.summary, `Browser ${outcome}`);
    assert.equal(
      saved.reservation.status,
      outcome === 'unknown' ? 'unknown' : 'settled',
    );
    assert.deepEqual(saved.reservation.charged, { actions: 1 });
    assert.equal(saved.budget.used.actions, before.budget.used.actions + 1);
    assert.equal((await result(item, body)).status, 200);
    assert.deepEqual(await state(item), saved);
  });

test('ordinary Runtime record keeps its original canonical hash and retry semantics', async () => {
  const item = await ownAction();
  await context.coordinator.recordAction(
    item.scope,
    item.proof,
    item.grant,
    'succeeded',
    null,
    [],
  );
  const saved = await state(item);
  assert.equal(
    saved.intent.result_hash,
    hashPayload({ status: 'succeeded', snapshot: null, evidence: [] }),
  );
  await context.coordinator.recordAction(
    item.scope,
    item.proof,
    item.grant,
    'succeeded',
    null,
    [],
  );
  assert.deepEqual(await state(item), saved);
  await rejectedUnchanged(item, () => result(item), 409); // HTTP fingerprint cannot impersonate Runtime receipt.
});
