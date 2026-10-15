import assert from 'node:assert/strict';
import { before, after, afterEach, test as nodeTest } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';
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
import { createApiContext, createApiServer } from '../dist/index.js';
import { RuntimeClient } from '../../../packages/orchestrator/dist/index.js';
import { createTestServiceIdentity } from './support/internal-auth.mjs';

// The internal boundary is a peer-only surface. The suite signs its internal
// requests with this ring instead of being exempted from the gate.
const testServiceIdentity = createTestServiceIdentity();

const tag = randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'localqa-auth-import-'));
const facts = {
  task: 'T10-AUTH-9A-STATE-CAPTURE',
  tag,
  evidenceDir: dir,
  tests: [],
  postgres: null,
  modelTransportCalls: 0,
  ownership: { containerId: null, volumes: [] },
  limitations: [
    'Real PG18 protected state importer/CAS/private receipt/budget/Step only; synthetic captured browser state',
    'No browser, Worker.once, worker-entry or paid model',
    'P0=false; AUTH flow not fully unfrozen',
  ],
};

let db,
  context,
  server,
  actor,
  project,
  url,
  cookie,
  apiPort,
  pgConnection,
  pgPort,
  pgPassword;
const envFile = join(dir, 'pg.env');
const kekFile = join(dir, 'kek.json');
const claimedTasks = [];

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
  console.log(`[T10 AUTH-9A evidence] ${dir}`);
  saveOwnership();
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
      `localqa-auth-import-${tag}`,
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
    email: `auth-import-${tag}@localqa.test`,
    displayName: 'Auth State Owner',
    password: 'StateOwner123!',
  });
  actor = { userId: owner.id };

  const projects = new ProjectRepository(db);
  project = await projects.create(actor, { name: `Auth State Project ${tag}` });

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
    serviceIdentity: testServiceIdentity.verifier,
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

  const loginRes = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: owner.email,
      password: 'StateOwner123!',
    }),
  });
  assert.equal(loginRes.status, 200);
  cookie = loginRes.headers.get('set-cookie').split(';')[0];
});

afterEach(async () => {
  for (const taskId of claimedTasks.splice(0)) {
    await admin(
      "UPDATE jobs SET status = 'interrupted', lease_until = NULL WHERE id = $1 AND status IN ('running','queued')",
      [taskId],
    );
    await admin(
      'UPDATE task_leases SET released_at = clock_timestamp() WHERE task_id = $1',
      [taskId],
    );
    await admin(
      "UPDATE budget_reservations SET status = 'released', charged = '{}' WHERE task_id = $1 AND kind = 'concurrency' AND status = 'reserved'",
      [taskId],
    );
  }
  if (project)
    await admin(
      "UPDATE runs SET status='cancelled',version=version+1 WHERE project_id=$1 AND status IN ('queued','running')",
      [project.id],
    );
});

after(async () => {
  if (server) {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
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
    `../../../docs/validation-results/T10-AUTH-IMPORT-${tag}.json`,
    import.meta.url,
  );
  writeFileSync(report, JSON.stringify(facts, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(`[T10 AUTH-9A report] ${report.pathname}`);

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

async function createRunWithProfile(
  mode = 'form',
  sharingPolicy = 'exclusive_run',
) {
  const auth = await context.configRepo.createAuthProfile(actor, project.id, {
    name: `auth-${randomUUID()}`,
    environmentId: null,
    mode,
    allowedOrigins: [url],
    sharingPolicy,
    ...(mode === 'form'
      ? {
          formConfig: {
            loginUrl: `${url}/login`,
            usernameTarget: { by: 'test_id', value: 'username' },
            passwordTarget: { by: 'test_id', value: 'password' },
            submitTarget: { by: 'test_id', value: 'login' },
            successCriterion: {
              id: 'c1',
              kind: 'element_visible',
              description: 'Dashboard',
              sourceKind: 'user_spec',
              sourceRef: 'smoke',
              locator: { by: 'test_id', value: 'dash' },
            },
          },
          secretInput: {
            username: 'owned-test-user',
            password: 'owned-test-secret',
          },
        }
      : {}),
    ...(mode === 'storage_state'
      ? {
          secretInput: {
            storageState: JSON.stringify({
              cookies: [
                {
                  name: 'storage_sess',
                  value: 'storage_val',
                  domain: new URL(url).hostname,
                  path: '/',
                },
              ],
              origins: [],
            }),
          },
        }
      : {}),
  });

  const runRes = await request('/runs', {
    projectId: project.id,
    targetUrl: `${url}/`,
    authProfileId: auth.id,
  });
  assert.equal(runRes.status, 202, JSON.stringify(runRes.body));
  return { run: runRes.body, profileId: auth.id, auth };
}

async function setupActiveSession(
  mode = 'form',
  sharingPolicy = 'exclusive_run',
) {
  const { run, profileId, auth } = await createRunWithProfile(
    mode,
    sharingPolicy,
  );
  const scope = {
    projectId: project.id,
    workerId: `worker-${randomUUID()}`,
  };
  const lease = await context.coordinator.claim(scope);
  assert.ok(lease);

  await admin(
    "UPDATE jobs SET document = jsonb_set(document, '{summary}', '\"auth\"') WHERE id = $1",
    [lease.task.id],
  );

  const proof = {
    taskId: lease.task.id,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    contextVersion: lease.contextVersion,
  };
  claimedTasks.push(lease.task.id);

  const binding = await context.coordinator.allocateAuthSession(scope, proof);
  const ticketRes = await context.coordinator.issueAuthActivationTicket(
    scope,
    proof,
    binding.sessionId,
  );
  const activeSession = await context.coordinator.activateAuthSession(
    scope,
    proof,
    binding.sessionId,
    ticketRes.activationTicket,
  );

  return { run, profileId, auth, scope, proof, session: activeSession };
}

function sampleSnapshot(snapshotId, pageId = randomUUID()) {
  return {
    snapshotId,
    pageId,
    frameIds: ['main'],
    displayUrl: `${url}/login`,
    title: 'Login Page',
    responseStatus: 200,
    capturedAt: new Date().toISOString(),
    stateVersion: 1,
    viewport: { width: 1280, height: 720 },
    nodes: [
      {
        nodeId: 'user-input-1',
        frameId: 'main',
        role: 'textbox',
        name: 'username',
        text: 'username-field',
        visible: true,
        enabled: true,
        bounds: { left: 10, top: 10, width: 100, height: 30 },
      },
      {
        nodeId: 'submit-btn-1',
        frameId: 'main',
        role: 'button',
        name: 'submit',
        text: 'Login Button',
        visible: true,
        enabled: true,
        bounds: { left: 10, top: 50, width: 100, height: 30 },
      },
    ],
    screenshotRef: null,
    networkSummary: [],
    consoleSummary: [],
    truncated: false,
    redacted: true,
  };
}

const denied = (e) =>
  [
    'AUTH_FAILED',
    'POLICY_DENIED',
    'LEASE_EXPIRED',
    'SCOPE_CHANGED',
    'VERSION_CONFLICT',
    'FORBIDDEN',
    'IDEMPOTENCY_CONFLICT',
    'VALIDATION_ERROR',
    'NOT_FOUND',
  ].includes(e.code);
async function captured(policy = 'exclusive_run', finish = true) {
  const x = await setupActiveSession('form', policy);
  await admin(
    "UPDATE jobs SET role='executor',document=jsonb_set(document,'{role}','\"executor\"'),result='{\"stage\":\"auth\"}' WHERE id=$1",
    [x.proof.taskId],
  );
  const permit = await context.coordinator.grantAuth(x.scope, x.proof, {
    requestId: randomUUID(),
    sessionId: x.session.sessionId,
    action: 'navigate_auth',
    slot: 'login_url',
  });
  const receipt = await context.coordinator.beginAuthExecution(
    x.scope,
    x.proof,
    x.session.sessionId,
    permit.grantId,
  );
  await context.coordinator.recordAuth(
    x.scope,
    x.proof,
    x.session.sessionId,
    permit.grantId,
    receipt,
    { status: 'succeeded' },
  );
  const snapshot = sampleSnapshot(randomUUID());
  await context.coordinator.recordAuthObservation(
    x.scope,
    x.proof,
    x.session.sessionId,
    snapshot,
  );
  const { gateId } = await context.coordinator.recordAuthCriterion(
    x.scope,
    x.proof,
    x.session.sessionId,
    {
      criterionId: 'c1',
      result: 'passed',
      reason: 'Synthetic success',
      evidenceRefs: [],
    },
    snapshot.snapshotId,
  );
  const grant = await context.coordinator.issueCaptureGrant(
    x.scope,
    x.proof,
    x.session.sessionId,
    gateId,
  );
  await context.coordinator.beginAuthCapture(
    x.scope,
    x.proof,
    x.session.sessionId,
    grant.grant.grantId,
    grant.captureTicket,
  );
  const state = {
    cookies: [
      {
        name: 'import_session',
        value: 'private-import-cookie-value',
        domain: new URL(url).hostname,
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  };
  const ref = await context.coordinator.captureAuthState(
    x.scope,
    x.proof,
    x.session.sessionId,
    grant.grant.grantId,
    grant.captureTicket,
    state,
  );
  const currentRun = await context.coordinator.tx(
    async (c) =>
      (await context.coordinator.validateLease(c, x.scope, x.proof)).run,
  );
  if (finish)
    await context.coordinator.finishAuth(
      x.scope,
      x.proof,
      x.session.sessionId,
      ref.authStateId,
    );
  return { ...x, ref, state, currentRun };
}
async function child(x, stage = 'explore', activate = true, reclaim = false) {
  const role = {
    explore: 'explorer',
    execute: 'executor',
    reproduce: 'reproducer',
  }[stage];
  const id = await context.coordinator.tx((c) =>
    context.coordinator.enqueue(
      c,
      x.currentRun,
      role,
      stage,
      randomUUID(),
      null,
    ),
  );
  claimedTasks.push(id);
  const scope = { projectId: project.id, workerId: `importer-${randomUUID()}` };
  let lease = await context.coordinator.claim(scope);
  assert.equal(lease?.task.id, id);
  claimedTasks.push(id);
  if (reclaim) {
    await admin(
      "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id],
    );
    await admin(
      "UPDATE task_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",
      [id],
    );
    assert.equal(
      (await context.coordinator.leases.recoverExpired(scope)).requeued,
      1,
    );
    lease = await context.coordinator.claim(scope);
    assert.equal(lease?.task.id, id);
    assert.equal(lease.fencingToken, 2);
  }
  const proof = {
    taskId: id,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    contextVersion: lease.contextVersion,
  };
  const session = await context.coordinator.allocateAuthImporterSession(
    scope,
    proof,
    x.ref.authStateId,
  );
  if (activate) {
    const ticket = await context.coordinator.issueAuthActivationTicket(
      scope,
      proof,
      session.sessionId,
    );
    const active = await context.coordinator.activateAuthSession(
      scope,
      proof,
      session.sessionId,
      ticket.activationTicket,
    );
    return { scope, proof, session: active };
  }
  return { scope, proof, session };
}
async function granted(x, reclaim = false) {
  const y = await child(x, 'explore', true, reclaim);
  const grant = await context.coordinator.grantAuthImport(
    y.scope,
    y.proof,
    y.session.sessionId,
  );
  return { ...y, grant };
}
const prep = (y) =>
  context.coordinator.prepareAuthImport(
    y.scope,
    y.proof,
    y.session.sessionId,
    y.grant.grantId,
  );
const begin = (y) =>
  context.coordinator.beginAuthImport(
    y.scope,
    y.proof,
    y.session.sessionId,
    y.grant.grantId,
  );
const record = (y, r, status = 'succeeded') =>
  context.coordinator.recordAuthImport(
    y.scope,
    y.proof,
    y.session.sessionId,
    y.grant.grantId,
    r,
    { status },
  );
async function stateFacts(x) {
  const a = (
    await admin(
      'SELECT status,current_state_id,auth_epoch FROM run_auth_scopes WHERE run_id=$1',
      [x.run.id],
    )
  ).rows[0];
  const locks = (
    await admin(
      'SELECT run_id,auth_session_id,auth_epoch,status,phase FROM auth_profile_run_locks WHERE run_id=$1',
      [x.run.id],
    )
  ).rows;
  return { a, locks };
}

test('exclusive and shared: normally finished capture feeds independent importer sessions and ends only one child', async () => {
  for (const policy of ['exclusive_run', 'shared_state']) {
    const x = await captured(policy);
    const before = await stateFacts(x);
    const a = await granted(x),
      b = await granted(x, true);
    assert.notEqual(a.proof.fencingToken, b.proof.fencingToken);
    const repeatedGrant = await context.coordinator.grantAuthImport(
      a.scope,
      a.proof,
      a.session.sessionId,
    );
    assert.equal(repeatedGrant.grantId, a.grant.grantId);
    assert.notEqual(a.session.sessionId, b.session.sessionId);
    assert.notEqual(a.session.contextId, b.session.contextId);
    assert.notEqual(a.session.contextId, x.session.contextId);
    assert.equal(
      (await prep(a)).state.cookies[0].value,
      x.state.cookies[0].value,
    );
    assert.equal(
      (await prep(b)).state.cookies[0].value,
      x.state.cookies[0].value,
    );
    const ra = await begin(a),
      rb = await begin(b);
    await record(a, ra);
    await record(b, rb);
    await record(a, ra);
    const publicRows = await admin(
      'SELECT document FROM steps WHERE run_id=$1',
      [x.run.id],
    );
    const publicEvents = await admin(
      'SELECT payload FROM run_events WHERE run_id=$1',
      [x.run.id],
    );
    const serialized = JSON.stringify([publicRows.rows, publicEvents.rows]);
    for (const privateValue of [
      x.state.cookies[0].value,
      ra.executionId,
      rb.executionId,
    ])
      assert.ok(
        !serialized.includes(privateValue),
        'Private material or receipt must not enter public records',
      );
    for (const task of [a, b])
      assert.equal(
        (
          await admin(
            "SELECT 1 FROM budget_reservations WHERE task_id=$1 AND kind='action'",
            [task.proof.taskId],
          )
        ).rowCount,
        1,
      );
    await assert.rejects(
      () => record(a, ra, 'failed'),
      (e) => e.code === 'IDEMPOTENCY_CONFLICT',
    );
    await context.coordinator.finish(a.scope, a.proof, { stage: 'explore' });
    assert.equal(
      (
        await admin('SELECT status FROM auth_execution_sessions WHERE id=$1', [
          a.session.sessionId,
        ])
      ).rows[0].status,
      'ended',
    );
    assert.equal(
      (
        await context.coordinator.authSession(
          b.scope,
          b.proof,
          b.session.sessionId,
        )
      ).status,
      'active',
    );
    assert.deepEqual(await stateFacts(x), before);
    assert.equal(
      (
        await admin('SELECT status FROM auth_import_grants WHERE id=$1', [
          a.grant.grantId,
        ])
      ).rows[0].status,
      'ended',
    );
    await context.coordinator.endAuthSession(
      b.scope,
      b.proof,
      b.session.sessionId,
    );
    assert.deepEqual(await stateFacts(x), before);
  }
});

test('prepare and begin concurrent CAS each grant one capability; lost replies cannot replay decryption or effect', async () => {
  const x = await captured(),
    y = await granted(x);
  let decrypts = 0;
  const vault = context.coordinator.vault,
    original = vault.decrypt;
  vault.decrypt = function (...args) {
    decrypts++;
    return original.apply(this, args);
  };
  try {
    const results = await Promise.allSettled([prep(y), prep(y)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      results.filter(
        (r) => r.status === 'rejected' && r.reason.code === 'VERSION_CONFLICT',
      ).length,
      1,
    );
    assert.equal(decrypts, 1);
    await assert.rejects(
      () => prep(y),
      (e) => e.code === 'VERSION_CONFLICT',
    );
    assert.equal(decrypts, 1);
    const starts = await Promise.allSettled([begin(y), begin(y)]);
    assert.equal(starts.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      starts.filter(
        (r) => r.status === 'rejected' && r.reason.code === 'VERSION_CONFLICT',
      ).length,
      1,
    );
    await assert.rejects(
      () => begin(y),
      (e) => e.code === 'VERSION_CONFLICT',
    );
  } finally {
    vault.decrypt = original;
  }
  await assert.rejects(
    () => context.coordinator.finish(y.scope, y.proof, { stage: 'explore' }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  await context.coordinator.endAuthSession(
    y.scope,
    y.proof,
    y.session.sessionId,
    'lost_reply',
  );
  const intent = (
    await admin(
      'SELECT outcome,reservation_id FROM action_intents WHERE id=$1',
      [y.grant.grantId],
    )
  ).rows[0];
  assert.equal(intent.outcome, 'unknown');
  const budget = (
    await admin('SELECT charged,status FROM budget_reservations WHERE id=$1', [
      intent.reservation_id,
    ])
  ).rows[0];
  assert.deepEqual(budget.charged, { actions: 1 });
  assert.equal(budget.status, 'unknown');
});

test('private importer rejects initializer-only methods and ordinary result/HTTP channels', async () => {
  const x = await captured(),
    y = await granted(x);
  await assert.rejects(
    () =>
      context.coordinator.authMaterial(y.scope, y.proof, y.session.sessionId),
    denied,
  );
  await assert.rejects(
    () =>
      context.coordinator.grantAuth(y.scope, y.proof, {
        requestId: randomUUID(),
        sessionId: y.session.sessionId,
        action: 'navigate_auth',
        slot: 'login_url',
      }),
    denied,
  );
  await assert.rejects(
    () =>
      context.coordinator.finishAuth(
        y.scope,
        y.proof,
        y.session.sessionId,
        x.ref.authStateId,
      ),
    denied,
  );
  await assert.rejects(
    () =>
      context.coordinator.recordAction(
        y.scope,
        y.proof,
        { id: y.grant.grantId, step: {} },
        'succeeded',
        null,
      ),
    (e) => e.code === 'POLICY_DENIED',
  );
  const internalPath = `/internal/v1/actions/${y.grant.grantId}/result`;
  // Serialise once so the service-identity signature covers the exact bytes sent.
  const httpBody = JSON.stringify({
    outcome: 'succeeded',
    summary: 'No private state',
    evidenceRefs: [],
    resultHash: hashPayload('opaque'),
  });
  const http = await fetch(`${url}${internalPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lease-Token': y.proof.leaseToken,
      'X-Worker-Id': y.scope.workerId,
      'X-Fencing-Token': String(y.proof.fencingToken),
      'X-Context-Version': String(y.proof.contextVersion),
      ...testServiceIdentity.sign('worker', {
        method: 'POST',
        path: internalPath,
        body: httpBody,
      }),
    },
    body: httpBody,
  });
  const parsed = await http.json();
  // The API translates the private service reason into its standard HTTP error.
  assert.equal(http.status, 403, JSON.stringify(parsed));
  assert.equal(parsed.code, 'FORBIDDEN');
  assert.equal(
    (
      await admin('SELECT outcome FROM action_intents WHERE id=$1', [
        y.grant.grantId,
      ])
    ).rows[0].outcome,
    'pending',
  );
  await assert.rejects(
    () =>
      context.coordinator.recordAuth(
        y.scope,
        y.proof,
        y.session.sessionId,
        y.grant.grantId,
        {
          grantId: y.grant.grantId,
          executionId: randomUUID(),
          startedAt: new Date().toISOString(),
        },
        { status: 'succeeded' },
      ),
    denied,
  );
});

test('allocation/activation rejects wrong state or current authority before any state decryption', async () => {
  for (const mutation of [
    'fence',
    'worker',
    'context',
    'epoch',
    'profile',
    'scope',
    'expired',
  ]) {
    const x = await captured();
    const y = await child(x, 'execute', false);
    let calls = 0;
    const v = context.coordinator.vault,
      old = v.decrypt;
    v.decrypt = function (...args) {
      calls++;
      return old.apply(this, args);
    };
    let restore;
    try {
      if (mutation === 'epoch') {
        await admin(
          'UPDATE run_auth_scopes SET auth_epoch=auth_epoch+1 WHERE run_id=$1',
          [x.run.id],
        );
        restore = () =>
          admin(
            'UPDATE run_auth_scopes SET auth_epoch=auth_epoch-1 WHERE run_id=$1',
            [x.run.id],
          );
      }
      if (mutation === 'profile') {
        await context.configRepo.updateAuthProfile(
          actor,
          project.id,
          x.profileId,
          { expectedVersion: x.auth.version, revoke: true },
        );
      }
      if (mutation === 'scope') {
        await admin(
          "UPDATE run_auth_scopes SET status='revoked' WHERE run_id=$1",
          [x.run.id],
        );
        restore = () =>
          admin("UPDATE run_auth_scopes SET status='granted' WHERE run_id=$1", [
            x.run.id,
          ]);
      }
      if (mutation === 'expired')
        await admin(
          "UPDATE auth_execution_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [y.session.sessionId],
        );
      const p = {
        ...y.proof,
        ...(mutation === 'fence'
          ? { fencingToken: y.proof.fencingToken + 1 }
          : {}),
        ...(mutation === 'context'
          ? { contextVersion: y.proof.contextVersion + 1 }
          : {}),
      };
      const s = {
        ...y.scope,
        ...(mutation === 'worker' ? { workerId: 'foreign-worker' } : {}),
      };
      await assert.rejects(
        () =>
          context.coordinator.issueAuthActivationTicket(
            s,
            p,
            y.session.sessionId,
          ),
        denied,
      );
      assert.equal(calls, 0);
      assert.equal(
        (
          await admin(
            'SELECT activation_ticket_hash FROM auth_execution_sessions WHERE id=$1',
            [y.session.sessionId],
          )
        ).rows[0].activation_ticket_hash,
        null,
      );
    } finally {
      v.decrypt = old;
      if (restore) await restore();
      await admin(
        "UPDATE jobs SET status='interrupted' WHERE id=$1 AND status='running'",
        [y.proof.taskId],
      );
      await admin(
        "UPDATE budget_reservations SET status='released',charged='{}' WHERE task_id=$1 AND kind='concurrency' AND status='reserved'",
        [y.proof.taskId],
      );
      await admin(
        "UPDATE runs SET status='cancelled',version=version+1 WHERE id=$1 AND status='running'",
        [x.run.id],
      );
    }
  }
});

test('historical tuple, revoked state, consumed grant and ciphertext/HMAC tampering fail closed', async () => {
  for (const mutation of [
    'worker',
    'context',
    'capture_grant',
    'revoked',
    'ciphertext',
    'hmac',
    'hmac_version',
  ]) {
    const x = await captured(),
      y = await granted(x);
    if (mutation === 'worker')
      await admin(
        "UPDATE run_auth_states SET capturing_worker_id='foreign' WHERE id=$1",
        [x.ref.authStateId],
      );
    if (mutation === 'context')
      await admin(
        'UPDATE run_auth_states SET capturing_context_id=$2 WHERE id=$1',
        [x.ref.authStateId, randomUUID()],
      );
    if (mutation === 'capture_grant')
      await admin(
        "UPDATE auth_capture_grants SET status='revoked' WHERE auth_session_id=$1",
        [x.session.sessionId],
      );
    if (mutation === 'revoked')
      await admin("UPDATE run_auth_states SET status='revoked' WHERE id=$1", [
        x.ref.authStateId,
      ]);
    if (mutation === 'ciphertext')
      await admin(
        'UPDATE run_auth_states SET ciphertext=set_byte(ciphertext,0,(get_byte(ciphertext,0)+1)%256) WHERE id=$1',
        [x.ref.authStateId],
      );
    if (mutation === 'hmac')
      await admin(
        "UPDATE run_auth_states SET state_hmac=repeat('0',64) WHERE id=$1",
        [x.ref.authStateId],
      );
    if (mutation === 'hmac_version')
      await admin(
        'UPDATE run_auth_states SET hmac_key_version=999 WHERE id=$1',
        [x.ref.authStateId],
      );
    await assert.rejects(() => prep(y), denied);
    assert.equal(
      (
        await admin('SELECT status FROM auth_import_grants WHERE id=$1', [
          y.grant.grantId,
        ])
      ).rows[0].status,
      'issued',
    );
    assert.equal(
      (
        await admin('SELECT outcome FROM action_intents WHERE id=$1', [
          y.grant.grantId,
        ])
      ).rows[0].outcome,
      'pending',
    );
    await admin(
      "UPDATE jobs SET status='interrupted' WHERE id=$1 AND status='running'",
      [y.proof.taskId],
    );
    await admin(
      "UPDATE budget_reservations SET status='released',charged='{}' WHERE task_id=$1 AND kind='concurrency' AND status='reserved'",
      [y.proof.taskId],
    );
    await admin(
      "UPDATE runs SET status='cancelled',version=version+1 WHERE id=$1 AND status='running'",
      [x.run.id],
    );
  }
});

test('historical encryption and HMAC key survive rotation, wrong receipt and changed outcome cannot charge twice', async () => {
  const x = await captured(),
    y = await granted(x);
  const oldVault = context.coordinator.vault;
  const keys = JSON.parse(readFileSync(kekFile, 'utf8'));
  const path = join(dir, 'rotated-kek.json');
  writeFileSync(
    path,
    JSON.stringify({
      activeVersion: 2,
      keys: { ...keys.keys, 2: randomBytes(32).toString('base64') },
    }),
    { mode: 0o600 },
  );
  const rotated = await SecretVault.fromProtectedFile(path);
  context.coordinator.vault = rotated;
  try {
    assert.equal(
      (await prep(y)).state.cookies[0].value,
      x.state.cookies[0].value,
    );
    const r = await begin(y);
    await assert.rejects(
      () => record(y, { ...r, executionId: 'wrong' }),
      (e) => e.code === 'FORBIDDEN',
    );
    await record(y, r);
    await record(y, r);
    await assert.rejects(
      () => record(y, r, 'unknown'),
      (e) => e.code === 'IDEMPOTENCY_CONFLICT',
    );
    const row = (
      await admin(
        'SELECT charged FROM budget_reservations WHERE id=(SELECT reservation_id FROM action_intents WHERE id=$1)',
        [y.grant.grantId],
      )
    ).rows[0];
    assert.deepEqual(row.charged, { actions: 1 });
  } finally {
    context.coordinator.vault = oldVault;
    rotated.dispose();
    rmSync(path, { force: true });
    assert.equal(existsSync(path), false);
  }
});

test('RLS denies workers and project non-admin actors private importer metadata', async () => {
  const x = await captured(),
    y = await granted(x);
  const c = new pg.Client({ connectionString: pgConnection });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE localqa_worker');
    await c.query("SELECT set_config('app.project_id',$1,true)", [project.id]);
    await assert.rejects(
      () => c.query('SELECT * FROM auth_import_grants'),
      (e) => e.code === '42501',
    );
    await c.query('ROLLBACK');
    const viewer = await new AccountsRepository(db).create(actor, {
      email: `import-viewer-${randomUUID()}@localqa.test`,
      displayName: 'Owned Import Viewer',
      password: 'OwnedViewer123!',
      globalRole: 'member',
    });
    await admin(
      "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')",
      [project.id, viewer.id],
    );
    await db.actor({ userId: viewer.id }, async (client) => {
      assert.equal(
        (
          await client.query('SELECT id FROM projects WHERE id=$1', [
            project.id,
          ])
        ).rowCount,
        1,
      );
      for (const table of [
        'auth_import_grants',
        'auth_execution_sessions',
        'run_auth_states',
      ])
        assert.equal(
          (await client.query(`SELECT * FROM ${table}`)).rowCount,
          0,
        );
      assert.equal(
        (
          await client.query('SELECT * FROM action_intents WHERE id=$1', [
            y.grant.grantId,
          ])
        ).rowCount,
        0,
      );
    });
  } finally {
    await c.end();
  }
  const rows = await admin('SELECT document FROM steps WHERE action_id=$1', [
    y.grant.grantId,
  ]);
  const events = await admin('SELECT payload FROM run_events WHERE run_id=$1', [
    x.run.id,
  ]);
  const serialized = JSON.stringify([rows.rows, events.rows]);
  assert.equal(serialized.includes(x.state.cookies[0].value), false);
});

test('shared action budget denial reserves no import row and DB insertion failure rolls everything back', async () => {
  for (const cause of ['budget', 'insert']) {
    const x = await captured(),
      y = await child(x);
    const before = (
      await admin('SELECT used,reserved FROM run_budgets WHERE run_id=$1', [
        x.run.id,
      ])
    ).rows[0];
    if (cause === 'budget')
      await admin(
        "UPDATE run_budgets SET used=jsonb_set(used,'{actions}',limits->'maxActions') WHERE run_id=$1",
        [x.run.id],
      );
    if (cause === 'insert')
      await admin(
        'ALTER TABLE auth_import_grants ADD CONSTRAINT own_import_failure CHECK(false) NOT VALID',
      );
    try {
      await assert.rejects(
        () =>
          context.coordinator.grantAuthImport(
            y.scope,
            y.proof,
            y.session.sessionId,
          ),
        cause === 'budget' ? (e) => e.code === 'BUDGET_EXCEEDED' : undefined,
      );
      assert.equal(
        (
          await admin(
            'SELECT 1 FROM auth_import_grants WHERE auth_session_id=$1',
            [y.session.sessionId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin('SELECT 1 FROM action_intents WHERE task_id=$1', [
            y.proof.taskId,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin(
            "SELECT 1 FROM budget_reservations WHERE task_id=$1 AND kind='action'",
            [y.proof.taskId],
          )
        ).rowCount,
        0,
      );
      if (cause === 'insert')
        assert.deepEqual(
          (
            await admin(
              'SELECT used,reserved FROM run_budgets WHERE run_id=$1',
              [x.run.id],
            )
          ).rows[0],
          before,
        );
    } finally {
      if (cause === 'insert')
        await admin(
          'ALTER TABLE auth_import_grants DROP CONSTRAINT own_import_failure',
        );
    }
  }
});

async function heldProfileExpiry(x, y, operation) {
  const c = new pg.Client({ connectionString: pgConnection });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM auth_profiles WHERE id=$1 FOR UPDATE', [
      x.profileId,
    ]);
    await admin(
      "UPDATE auth_import_grants SET deadline=clock_timestamp()+interval '350 milliseconds' WHERE id=$1",
      [y.grant.grantId],
    );
    let settled = false;
    const result = operation()
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    let waiting = false;
    for (let i = 0; i < 50; i++) {
      if (
        (
          await admin(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FOR SHARE OF p%' AND pid<>pg_backend_pid()",
          )
        ).rowCount
      ) {
        waiting = true;
        break;
      }
      if (settled) break;
      await delay(10);
    }
    assert.ok(waiting, 'real profile-row lock wait required');
    await delay(450);
    await c.query('COMMIT');
    assert.equal((await result).error?.code, 'LEASE_EXPIRED');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}
test('real lock waits expiring prepare and begin deadlines roll the CAS back with zero decryption', async () => {
  for (const phase of ['prepare', 'begin']) {
    const x = await captured(),
      y = await granted(x);
    if (phase === 'begin') await prep(y);
    let calls = 0;
    const v = context.coordinator.vault,
      old = v.decrypt;
    v.decrypt = function (...args) {
      calls++;
      return old.apply(this, args);
    };
    try {
      await heldProfileExpiry(x, y, () =>
        phase === 'prepare' ? prep(y) : begin(y),
      );
      assert.equal(calls, 0);
    } finally {
      v.decrypt = old;
    }
    assert.equal(
      (
        await admin('SELECT status FROM auth_import_grants WHERE id=$1', [
          y.grant.grantId,
        ])
      ).rows[0].status,
      phase === 'prepare' ? 'issued' : 'prepared',
    );
  }
});

test('failure/unknown/cancelled import outcomes remain truthful and charge one action', async () => {
  for (const status of ['failed', 'unknown', 'cancelled']) {
    const x = await captured(),
      y = await granted(x);
    await prep(y);
    const r = await begin(y);
    await record(y, r, status);
    await record(y, r, status);
    const row = (
      await admin('SELECT outcome FROM action_intents WHERE id=$1', [
        y.grant.grantId,
      ])
    ).rows[0];
    assert.equal(row.outcome, status);
    assert.equal(
      (
        await admin('SELECT document FROM steps WHERE action_id=$1', [
          y.grant.grantId,
        ])
      ).rows[0].document.status,
      status,
    );
    assert.deepEqual(
      (
        await admin(
          'SELECT charged FROM budget_reservations WHERE id=(SELECT reservation_id FROM action_intents WHERE id=$1)',
          [y.grant.grantId],
        )
      ).rows[0].charged,
      { actions: 1 },
    );
    await context.coordinator.endAuthSession(
      y.scope,
      y.proof,
      y.session.sessionId,
    );
    assert.equal((await stateFacts(x)).a.status, 'granted');
  }
});

test('service recovery ends one expired importer without touching active sibling/state/granted lock', async () => {
  const x = await captured(),
    a = await granted(x),
    b = await granted(x),
    before = await stateFacts(x);
  await prep(a);
  await begin(a);
  await admin(
    "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [a.proof.taskId],
  );
  await admin(
    "UPDATE task_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",
    [a.proof.taskId],
  );
  const r = await context.coordinator.leases.recoverExpired(a.scope);
  assert.equal(r.interrupted, 1);
  assert.equal(
    (
      await admin('SELECT status FROM auth_import_grants WHERE id=$1', [
        a.grant.grantId,
      ])
    ).rows[0].status,
    'ended',
  );
  assert.equal(
    (
      await context.coordinator.authSession(
        b.scope,
        b.proof,
        b.session.sessionId,
      )
    ).status,
    'active',
  );
  assert.deepEqual(await stateFacts(x), before);
  await assert.rejects(() => prep(a), denied);
});

test('RuntimeClient minimal facade carries the independent importer proof through grant/prepare/begin/record', async () => {
  const x = await captured(),
    y = await child(x);
  const runtime = new RuntimeClient(
    context.coordinator,
    y.scope,
    context.artifacts,
    {},
  );
  const grant = await runtime.grantAuthImport(y.proof, y.session.sessionId);
  const prepared = await runtime.prepareAuthImport(
    y.proof,
    y.session.sessionId,
    grant.grantId,
  );
  assert.equal(prepared.state.cookies[0].value, x.state.cookies[0].value);
  const receipt = await runtime.beginAuthImport(
    y.proof,
    y.session.sessionId,
    grant.grantId,
  );
  await runtime.recordAuthImport(
    y.proof,
    y.session.sessionId,
    grant.grantId,
    receipt,
    { status: 'succeeded' },
  );
  assert.equal(facts.modelTransportCalls, 0);
});

test('ciphertext changes after prepare invalidate the pinned state before begin without another decrypt', async () => {
  const x = await captured(),
    y = await granted(x);
  await prep(y);
  await admin(
    'UPDATE run_auth_states SET ciphertext=set_byte(ciphertext,0,(get_byte(ciphertext,0)+1)%256) WHERE id=$1',
    [x.ref.authStateId],
  );
  let calls = 0;
  const v = context.coordinator.vault,
    old = v.decrypt;
  v.decrypt = function (...args) {
    calls++;
    return old.apply(this, args);
  };
  try {
    await assert.rejects(
      () => begin(y),
      (e) => e.code === 'AUTH_FAILED',
    );
    assert.equal(calls, 0);
  } finally {
    v.decrypt = old;
  }
  assert.equal(
    (
      await admin('SELECT status FROM auth_import_grants WHERE id=$1', [
        y.grant.grantId,
      ])
    ).rows[0].status,
    'prepared',
  );
});

test('record PG Step-write failure atomically preserves started receipt, pending action and reserved budget', async () => {
  const x = await captured(),
    y = await granted(x);
  await prep(y);
  const r = await begin(y);
  await admin(
    "ALTER TABLE steps ADD CONSTRAINT own_import_step_failure CHECK (document->>'status'='running') NOT VALID",
  );
  try {
    await assert.rejects(() => record(y, r));
    assert.equal(
      (
        await admin('SELECT status FROM auth_import_grants WHERE id=$1', [
          y.grant.grantId,
        ])
      ).rows[0].status,
      'started',
    );
    assert.equal(
      (
        await admin('SELECT outcome FROM action_intents WHERE id=$1', [
          y.grant.grantId,
        ])
      ).rows[0].outcome,
      'pending',
    );
    assert.equal(
      (
        await admin(
          'SELECT status FROM budget_reservations WHERE id=(SELECT reservation_id FROM action_intents WHERE id=$1)',
          [y.grant.grantId],
        )
      ).rows[0].status,
      'reserved',
    );
  } finally {
    await admin('ALTER TABLE steps DROP CONSTRAINT own_import_step_failure');
  }
  await record(y, r);
});

test('foreign state/initializer capability cannot allocate a new importer and grants pin current session proof', async () => {
  const x = await captured(),
    y = await child(x, 'reproduce', false);
  await assert.rejects(
    () =>
      context.coordinator.allocateAuthImporterSession(
        y.scope,
        y.proof,
        randomUUID(),
      ),
    (e) => e.code === 'AUTH_FAILED',
  );
  assert.equal(
    (
      await admin('SELECT 1 FROM auth_execution_sessions WHERE task_id=$1', [
        y.proof.taskId,
      ])
    ).rowCount,
    1,
  );
  const ticket = await context.coordinator.issueAuthActivationTicket(
    y.scope,
    y.proof,
    y.session.sessionId,
  );
  await context.coordinator.activateAuthSession(
    y.scope,
    y.proof,
    y.session.sessionId,
    ticket.activationTicket,
  );
  const grant = await context.coordinator.grantAuthImport(
    y.scope,
    y.proof,
    y.session.sessionId,
  );
  await admin(
    'UPDATE auth_import_grants SET fencing_token=fencing_token+1 WHERE id=$1',
    [grant.grantId],
  );
  await assert.rejects(
    () =>
      context.coordinator.prepareAuthImport(
        y.scope,
        y.proof,
        y.session.sessionId,
        grant.grantId,
      ),
    (e) => e.code === 'AUTH_FAILED',
  );
});

test('capture followed by real initializer lease recovery remains importable with historical ended authority', async () => {
  const x = await captured('exclusive_run', false),
    before = await stateFacts(x);
  await admin(
    "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [x.proof.taskId],
  );
  await admin(
    "UPDATE task_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",
    [x.proof.taskId],
  );
  assert.equal(
    (await context.coordinator.leases.recoverExpired(x.scope)).interrupted,
    1,
  );
  assert.deepEqual(await stateFacts(x), before);
  const y = await granted(x);
  assert.equal(
    (await prep(y)).state.cookies[0].value,
    x.state.cookies[0].value,
  );
});

test('active importer stale proof, session binding, scope epoch/pointer and profile revocation never decrypt', async () => {
  for (const mutation of [
    'new_fence',
    'session_worker',
    'session_context',
    'epoch',
    'state_pointer',
    'profile',
  ]) {
    const x = await captured(),
      y = await granted(x);
    if (mutation === 'new_fence')
      await admin('UPDATE jobs SET fencing_token=fencing_token+1 WHERE id=$1', [
        y.proof.taskId,
      ]);
    if (mutation === 'session_worker')
      await admin(
        "UPDATE auth_execution_sessions SET worker_id='foreign' WHERE id=$1",
        [y.session.sessionId],
      );
    if (mutation === 'session_context')
      await admin(
        'UPDATE auth_execution_sessions SET context_version=context_version+1 WHERE id=$1',
        [y.session.sessionId],
      );
    if (mutation === 'epoch')
      await admin(
        'UPDATE run_auth_scopes SET auth_epoch=auth_epoch+1 WHERE run_id=$1',
        [x.run.id],
      );
    if (mutation === 'state_pointer')
      await admin(
        'UPDATE run_auth_scopes SET current_state_id=NULL WHERE run_id=$1',
        [x.run.id],
      );
    if (mutation === 'profile')
      await context.configRepo.updateAuthProfile(
        actor,
        project.id,
        x.profileId,
        { expectedVersion: x.auth.version, revoke: true },
      );
    let calls = 0;
    const v = context.coordinator.vault,
      old = v.decrypt;
    v.decrypt = function (...args) {
      calls++;
      return old.apply(this, args);
    };
    try {
      await assert.rejects(() => prep(y), denied);
      assert.equal(calls, 0);
    } finally {
      v.decrypt = old;
    }
    assert.equal(
      (
        await admin('SELECT status FROM auth_import_grants WHERE id=$1', [
          y.grant.grantId,
        ])
      ).rows[0].status,
      'issued',
    );
    await admin(
      "UPDATE jobs SET status='interrupted' WHERE id=$1 AND status='running'",
      [y.proof.taskId],
    );
    await admin(
      "UPDATE budget_reservations SET status='released',charged='{}' WHERE task_id=$1 AND kind='concurrency' AND status='reserved'",
      [y.proof.taskId],
    );
    await admin(
      "UPDATE runs SET status='cancelled',version=version+1 WHERE id=$1 AND status='running'",
      [x.run.id],
    );
  }
});

test('prepare/begin write failures roll back both private CAS and ordinary private intent state', async () => {
  for (const phase of ['prepare', 'begin']) {
    const x = await captured(),
      y = await granted(x);
    if (phase === 'begin') await prep(y);
    const sql =
      phase === 'prepare'
        ? "ALTER TABLE auth_import_grants ADD CONSTRAINT own_prepare_fail CHECK(status<>'prepared') NOT VALID"
        : "ALTER TABLE action_intents ADD CONSTRAINT own_begin_fail CHECK(execution_state<>'started') NOT VALID";
    await admin(sql);
    try {
      await assert.rejects(() => (phase === 'prepare' ? prep(y) : begin(y)));
      assert.equal(
        (
          await admin('SELECT status FROM auth_import_grants WHERE id=$1', [
            y.grant.grantId,
          ])
        ).rows[0].status,
        phase === 'prepare' ? 'issued' : 'prepared',
      );
      assert.equal(
        (
          await admin(
            'SELECT execution_state FROM action_intents WHERE id=$1',
            [y.grant.grantId],
          )
        ).rows[0].execution_state,
        'issued',
      );
    } finally {
      await admin(
        phase === 'prepare'
          ? 'ALTER TABLE auth_import_grants DROP CONSTRAINT own_prepare_fail'
          : 'ALTER TABLE action_intents DROP CONSTRAINT own_begin_fail',
      );
    }
  }
});

test('record deadline expiring on the actual budget row lock rolls back charge, Step and completion', async () => {
  const x = await captured(),
    y = await granted(x);
  await prep(y);
  const receipt = await begin(y);
  const blocker = new pg.Client({ connectionString: pgConnection });
  await blocker.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT run_id FROM run_budgets WHERE run_id=$1 FOR UPDATE',
      [x.run.id],
    );
    await admin(
      "UPDATE auth_import_grants SET deadline=clock_timestamp()+interval '350 milliseconds' WHERE id=$1",
      [y.grant.grantId],
    );
    let settled = false;
    const attempt = record(y, receipt)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    let waiting = false;
    for (let i = 0; i < 50; i++) {
      if (
        (
          await admin(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM run_budgets%FOR UPDATE%' AND pid<>pg_backend_pid()",
          )
        ).rowCount
      ) {
        waiting = true;
        break;
      }
      if (settled) break;
      await delay(10);
    }
    assert.ok(waiting, 'real budget row lock wait required');
    await delay(450);
    await blocker.query('COMMIT');
    assert.equal((await attempt).error?.code, 'LEASE_EXPIRED');
    assert.equal(
      (
        await admin('SELECT status FROM auth_import_grants WHERE id=$1', [
          y.grant.grantId,
        ])
      ).rows[0].status,
      'started',
    );
    assert.equal(
      (
        await admin('SELECT outcome FROM action_intents WHERE id=$1', [
          y.grant.grantId,
        ])
      ).rows[0].outcome,
      'pending',
    );
    assert.equal(
      (
        await admin(
          'SELECT status FROM budget_reservations WHERE id=(SELECT reservation_id FROM action_intents WHERE id=$1)',
          [y.grant.grantId],
        )
      ).rows[0].status,
      'reserved',
    );
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    await blocker.end();
  }
});

test('none cannot allocate importer authority: zero state decryption/session/scope/grants', async () => {
  const { run } = await createRunWithProfile('none');
  const scope = { projectId: project.id, workerId: `none-${randomUUID()}` },
    lease = await context.coordinator.claim(scope);
  claimedTasks.push(lease.task.id);
  await admin(
    "UPDATE jobs SET role='explorer',document=jsonb_set(jsonb_set(document,'{role}','\"explorer\"'),'{summary}','\"explore\"') WHERE id=$1",
    [lease.task.id],
  );
  const proof = {
    taskId: lease.task.id,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    contextVersion: lease.contextVersion,
  };
  let calls = 0;
  const v = context.coordinator.vault,
    old = v.decrypt;
  v.decrypt = function (...args) {
    calls++;
    return old.apply(this, args);
  };
  try {
    await assert.rejects(
      () =>
        context.coordinator.allocateAuthImporterSession(
          scope,
          proof,
          randomUUID(),
        ),
      (e) => e.code === 'POLICY_DENIED',
    );
    assert.equal(calls, 0);
    for (const table of [
      'auth_execution_sessions',
      'run_auth_scopes',
      'auth_import_grants',
    ])
      assert.equal(
        (await admin(`SELECT 1 FROM ${table} WHERE run_id=$1`, [run.id]))
          .rowCount,
        0,
      );
  } finally {
    v.decrypt = old;
  }
});
