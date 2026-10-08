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
import {
  Database,
  migrate,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
} from '@localqa/storage';
import { createApiContext, createApiServer } from '../dist/index.js';
import { createPrivateAuthPort } from '../../../packages/browser/dist/private-auth.js';

const tag = randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'localqa-auth-actions-'));
const facts = {
  task: 'T10-AUTH-6-ACTIONS-LEDGER',
  tag,
  evidenceDir: dir,
  tests: [],
  postgres: null,
  modelTransportCalls: 0,
  ownership: { containerId: null, volumes: [] },
  limitations: [
    'Real PG18 private auth actions ledger, provenance, CAS begin, and exclusive run lock only',
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
  console.log(`[T10 AUTH-6 evidence] ${dir}`);
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
      `localqa-auth-actions-${tag}`,
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
    email: `auth-actions-${tag}@localqa.test`,
    displayName: 'Auth Actions Owner',
    password: 'ActionsOwner123!',
  });
  actor = { userId: owner.id };

  const projects = new ProjectRepository(db);
  project = await projects.create(actor, { name: `Auth Project ${tag}` });

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
      password: 'ActionsOwner123!',
    }),
  });
  assert.equal(loginRes.status, 200);
  cookie = loginRes.headers.get('set-cookie').split(';')[0];
});

afterEach(async () => {
  for (const taskId of claimedTasks.splice(0)) {
    await admin(
      "UPDATE jobs SET status = 'interrupted', lease_until = NULL WHERE id = $1",
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
    `../../../docs/validation-results/T10-AUTH-ACTIONS-${tag}.json`,
    import.meta.url,
  );
  writeFileSync(report, JSON.stringify(facts, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(`[T10 AUTH-6 report] ${report.pathname}`);

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
    redacted: false,
  };
}

test('recordAuthObservation: registers sanitized snapshot bound to auth session and epoch', async () => {
  const { scope, proof, session } = await setupActiveSession('form');
  const snapId = randomUUID();
  const rawSnap = sampleSnapshot(snapId);

  const recorded = await context.coordinator.recordAuthObservation(
    scope,
    proof,
    session.sessionId,
    rawSnap,
  );
  assert.equal(recorded.snapshotId, snapId);

  // Verify in page_snapshots
  const row = (
    await admin('SELECT * FROM page_snapshots WHERE id = $1', [snapId])
  ).rows[0];
  assert.ok(row);
  assert.equal(row.auth_session_id, session.sessionId);
  assert.equal(row.auth_epoch, session.authEpoch);
});

test('grantAuth: generates AuthPermit, reserves budget, enforces action/slot pairing, snapshot provenance and requestId idempotency', async () => {
  const { scope, proof, session } = await setupActiveSession('form');
  const snapId = randomUUID();
  const snap = sampleSnapshot(snapId);
  await context.coordinator.recordAuthObservation(
    scope,
    proof,
    session.sessionId,
    snap,
  );

  // 1. Invalid action/slot pairing -> VALIDATION_ERROR
  await assert.rejects(
    () =>
      context.coordinator.grantAuth(scope, proof, {
        requestId: 'req-bad-pairing',
        sessionId: session.sessionId,
        action: 'fill_credential',
        slot: 'login_url', // wrong slot for fill_credential
        target: {
          snapshotId: snapId,
          pageId: snap.pageId,
          nodeId: 'user-input-1',
        },
      }),
    (err) => err.code === 'VALIDATION_ERROR',
  );

  // 2. Missing target provenance (snapshot not recorded for this session) -> NOT_FOUND
  await assert.rejects(
    () =>
      context.coordinator.grantAuth(scope, proof, {
        requestId: 'req-unowned-target',
        sessionId: session.sessionId,
        action: 'fill_credential',
        slot: 'username',
        target: {
          snapshotId: randomUUID(), // unrecorded snapshot ID
          pageId: snap.pageId,
          nodeId: 'user-input-1',
        },
      }),
    (err) => err.code === 'NOT_FOUND',
  );

  // 3. Legitimate grantAuth -> returns AuthPermit
  const permit = await context.coordinator.grantAuth(scope, proof, {
    requestId: 'req-legit-username',
    sessionId: session.sessionId,
    action: 'fill_credential',
    slot: 'username',
    target: {
      snapshotId: snapId,
      pageId: snap.pageId,
      nodeId: 'user-input-1',
    },
  });
  assert.ok(permit.grantId);
  assert.equal(permit.sessionId, session.sessionId);
  assert.equal(permit.action, 'fill_credential');
  assert.equal(permit.slot, 'username');
  assert.equal(permit.target.nodeId, 'user-input-1');

  // Verify action intent in DB
  const intent = (
    await admin('SELECT * FROM action_intents WHERE id = $1', [permit.grantId])
  ).rows[0];
  assert.ok(intent);
  assert.equal(intent.auth_session_id, session.sessionId);
  assert.equal(intent.execution_state, 'issued');

  // Verify reservation was created
  const res = (
    await admin('SELECT * FROM budget_reservations WHERE id = $1', [
      intent.reservation_id,
    ])
  ).rows[0];
  assert.equal(res.status, 'reserved');

  // 4. Idempotency: same requestId returns identical permit
  const samePermit = await context.coordinator.grantAuth(scope, proof, {
    requestId: 'req-legit-username',
    sessionId: session.sessionId,
    action: 'fill_credential',
    slot: 'username',
    target: {
      snapshotId: snapId,
      pageId: snap.pageId,
      nodeId: 'user-input-1',
    },
  });
  assert.equal(samePermit.grantId, permit.grantId);

  // Conflicting request body with same requestId -> IDEMPOTENCY_CONFLICT
  await assert.rejects(
    () =>
      context.coordinator.grantAuth(scope, proof, {
        requestId: 'req-legit-username',
        sessionId: session.sessionId,
        action: 'fill_credential',
        slot: 'password', // changed slot
        target: {
          snapshotId: snapId,
          pageId: snap.pageId,
          nodeId: 'user-input-1',
        },
      }),
    (err) => err.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('beginAuthExecution CAS state (issued -> started), single-execution, and exclusive run lock', async () => {
  const { scope, proof, session, profileId, run } =
    await setupActiveSession('form');

  const permit = await context.coordinator.grantAuth(scope, proof, {
    requestId: 'req-begin-test',
    sessionId: session.sessionId,
    action: 'navigate_auth',
    slot: 'login_url',
  });

  // 1. First beginAuthExecution succeeds
  const receipt = await context.coordinator.beginAuthExecution(
    scope,
    proof,
    session.sessionId,
    permit.grantId,
  );
  assert.equal(receipt.grantId, permit.grantId);
  assert.ok(receipt.executionId);
  assert.ok(receipt.startedAt);

  // Verify DB state
  const intent = (
    await admin('SELECT * FROM action_intents WHERE id = $1', [permit.grantId])
  ).rows[0];
  assert.equal(intent.execution_state, 'started');
  assert.equal(intent.execution_id, receipt.executionId);

  // Verify exclusive lock acquired
  const lock = (
    await admin(
      'SELECT * FROM auth_profile_run_locks WHERE auth_profile_id = $1 AND status = $2',
      [profileId, 'held'],
    )
  ).rows[0];
  assert.ok(lock);
  assert.equal(lock.run_id, run.id);
  assert.equal(lock.phase, 'initializing');

  // 2. Second beginAuthExecution on same grant fails (VERSION_CONFLICT)
  await assert.rejects(
    () =>
      context.coordinator.beginAuthExecution(
        scope,
        proof,
        session.sessionId,
        permit.grantId,
      ),
    (err) => err.code === 'VERSION_CONFLICT',
  );

  // 3. Second concurrent run on same exclusive profile gets RATE_LIMITED (429)
  const otherScope = {
    projectId: project.id,
    workerId: `worker-second-${randomUUID()}`,
  };
  const otherRunRes = await request('/runs', {
    projectId: project.id,
    targetUrl: `${url}/`,
    authProfileId: profileId,
  });
  assert.equal(otherRunRes.status, 202);
  const otherLease = await context.coordinator.claim(otherScope);
  assert.ok(otherLease);
  await admin(
    "UPDATE jobs SET document = jsonb_set(document, '{summary}', '\"auth\"') WHERE id = $1",
    [otherLease.task.id],
  );
  const otherProof = {
    taskId: otherLease.task.id,
    leaseToken: otherLease.leaseToken,
    fencingToken: otherLease.fencingToken,
    contextVersion: otherLease.contextVersion,
  };
  claimedTasks.push(otherLease.task.id);

  const otherBinding = await context.coordinator.allocateAuthSession(
    otherScope,
    otherProof,
  );
  const otherTicket = await context.coordinator.issueAuthActivationTicket(
    otherScope,
    otherProof,
    otherBinding.sessionId,
  );
  const otherSession = await context.coordinator.activateAuthSession(
    otherScope,
    otherProof,
    otherBinding.sessionId,
    otherTicket.activationTicket,
  );

  const otherPermit = await context.coordinator.grantAuth(
    otherScope,
    otherProof,
    {
      requestId: 'req-second-run',
      sessionId: otherSession.sessionId,
      action: 'navigate_auth',
      slot: 'login_url',
    },
  );

  // Other run's beginAuthExecution is RATE_LIMITED because lock is held by first run
  await assert.rejects(
    () =>
      context.coordinator.beginAuthExecution(
        otherScope,
        otherProof,
        otherSession.sessionId,
        otherPermit.grantId,
      ),
    (err) => err.code === 'RATE_LIMITED',
  );
});

test('recordAuth: requires started grant and receipt match, settles budget, updates Step, and rejects ordinary channels', async () => {
  const { scope, proof, session } = await setupActiveSession('form');

  const permit = await context.coordinator.grantAuth(scope, proof, {
    requestId: 'req-record-test',
    sessionId: session.sessionId,
    action: 'navigate_auth',
    slot: 'login_url',
  });

  // 1. Unstarted grant calling recordAuth directly fails (VALIDATION_ERROR)
  const fakeReceipt = {
    grantId: permit.grantId,
    executionId: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  await assert.rejects(
    () =>
      context.coordinator.recordAuth(
        scope,
        proof,
        session.sessionId,
        permit.grantId,
        fakeReceipt,
        { status: 'succeeded' },
      ),
    (err) => err.code === 'VALIDATION_ERROR',
  );

  // Begin execution
  const receipt = await context.coordinator.beginAuthExecution(
    scope,
    proof,
    session.sessionId,
    permit.grantId,
  );

  // 2. Wrong executionId in receipt fails (VERSION_CONFLICT)
  await assert.rejects(
    () =>
      context.coordinator.recordAuth(
        scope,
        proof,
        session.sessionId,
        permit.grantId,
        { ...receipt, executionId: randomUUID() },
        { status: 'succeeded' },
      ),
    (err) => err.code === 'VERSION_CONFLICT',
  );

  // 3. Legitimate recordAuth succeeds
  await context.coordinator.recordAuth(
    scope,
    proof,
    session.sessionId,
    permit.grantId,
    receipt,
    { status: 'succeeded' },
  );

  // Verify intent updated to completed
  const intent = (
    await admin('SELECT * FROM action_intents WHERE id = $1', [permit.grantId])
  ).rows[0];
  assert.equal(intent.execution_state, 'completed');
  assert.equal(intent.outcome, 'succeeded');
  assert.ok(intent.result_hash);

  // Verify reservation settled
  const res = (
    await admin('SELECT * FROM budget_reservations WHERE id = $1', [
      intent.reservation_id,
    ])
  ).rows[0];
  assert.equal(res.status, 'settled');

  // Verify Step document updated
  const step = (
    await admin('SELECT document FROM steps WHERE action_id = $1', [
      permit.grantId,
    ])
  ).rows[0].document;
  assert.equal(step.status, 'succeeded');
  assert.equal(step.summary, 'Auth succeeded');

  // 4. Calling ordinary recordAction on private auth intent must be REJECTED (POLICY_DENIED)
  await assert.rejects(
    () =>
      context.coordinator.recordAction(
        scope,
        proof,
        { id: permit.grantId, step },
        'succeeded',
        null,
        [],
      ),
    (err) => err.code === 'POLICY_DENIED',
    'Ordinary Runtime recordAction must reject private auth intents',
  );

  // Calling ordinary recordHttpAction on private auth intent must be REJECTED (POLICY_DENIED)
  await assert.rejects(
    () =>
      context.coordinator.recordHttpAction(scope, proof, permit.grantId, {
        outcome: 'succeeded',
        summary: 'Navigated',
        evidenceRefs: [],
        resultHash:
          '0000000000000000000000000000000000000000000000000000000000000000',
      }),
    (err) => err.code === 'POLICY_DENIED',
    'Ordinary recordHttpAction must reject private auth intents',
  );
});

test('Failed outcome in recordAuth charges actions:1 and releases initializing exclusive lock', async () => {
  const { scope, proof, session, profileId, run } =
    await setupActiveSession('form');

  const permit = await context.coordinator.grantAuth(scope, proof, {
    requestId: 'req-fail-test',
    sessionId: session.sessionId,
    action: 'navigate_auth',
    slot: 'login_url',
  });

  const receipt = await context.coordinator.beginAuthExecution(
    scope,
    proof,
    session.sessionId,
    permit.grantId,
  );

  // Record failed outcome
  await context.coordinator.recordAuth(
    scope,
    proof,
    session.sessionId,
    permit.grantId,
    receipt,
    { status: 'failed' },
  );

  // Verify reservation settled (charged actions: 1)
  const intent = (
    await admin('SELECT * FROM action_intents WHERE id = $1', [permit.grantId])
  ).rows[0];
  assert.equal(intent.outcome, 'failed');
  const res = (
    await admin('SELECT * FROM budget_reservations WHERE id = $1', [
      intent.reservation_id,
    ])
  ).rows[0];
  assert.equal(res.status, 'settled');
  assert.deepEqual(res.charged, { actions: 1 });

  // Verify exclusive initializing lock was released
  const lock = (
    await admin(
      'SELECT * FROM auth_profile_run_locks WHERE auth_profile_id = $1 AND run_id = $2',
      [profileId, run.id],
    )
  ).rows[0];
  assert.ok(lock);
  assert.equal(lock.status, 'released');
  assert.equal(lock.release_reason, 'auth_failed');
});

async function startedAuth(sharing = 'exclusive_run') {
  const item = await setupActiveSession('form', sharing);
  item.permit = await context.coordinator.grantAuth(item.scope, item.proof, {
    requestId: randomUUID(),
    sessionId: item.session.sessionId,
    action: 'navigate_auth',
    slot: 'login_url',
  });
  item.receipt = await context.coordinator.beginAuthExecution(
    item.scope,
    item.proof,
    item.session.sessionId,
    item.permit.grantId,
  );
  return item;
}

async function record(item, outcome) {
  return context.coordinator.recordAuth(
    item.scope,
    item.proof,
    item.session.sessionId,
    item.permit.grantId,
    item.receipt,
    outcome,
  );
}

test('Root: authoritative server permit is directly usable by the actual private port', async () => {
  const item = await setupActiveSession();
  const permit = await context.coordinator.grantAuth(item.scope, item.proof, {
    requestId: randomUUID(),
    sessionId: item.session.sessionId,
    action: 'navigate_auth',
    slot: 'login_url',
  });
  let navigations = 0;
  const port = createPrivateAuthPort({
    binding: item.session,
    allowedOrigins: [url],
    gate: {
      authorize: async ({ permit: p }) => {
        await context.coordinator.beginAuthExecution(
          item.scope,
          item.proof,
          item.session.sessionId,
          p.grantId,
        );
      },
      authorizeExport: async () => {
        throw new Error('Export not wired');
      },
    },
    primitives: {
      navigate: async () => {
        navigations++;
        return sampleSnapshot(randomUUID());
      },
      fill: async () => {
        throw new Error('Unused');
      },
      submit: async () => {
        throw new Error('Unused');
      },
      prepareState: async () => {},
      exportState: async () => ({}),
    },
  });
  try {
    await port.executeAuth(
      permit,
      { kind: 'navigate' },
      new AbortController().signal,
    );
    assert.equal(navigations, 1);
  } finally {
    await port.close();
  }
});

test('Root: same private result retry is idempotent and charges only once', async () => {
  const item = await startedAuth();
  await record(item, { status: 'succeeded' });
  await record(item, { status: 'succeeded' });
  const row = (
    await admin(
      'SELECT r.charged FROM budget_reservations r JOIN action_intents i ON i.reservation_id=r.id WHERE i.id=$1',
      [item.permit.grantId],
    )
  ).rows[0];
  assert.deepEqual(row.charged, { actions: 1 });
});

test('Root: changed snapshot on a private result retry conflicts', async () => {
  const item = await startedAuth();
  const snapshot = sampleSnapshot(randomUUID());
  snapshot.redacted = true;
  await record(item, { status: 'succeeded', snapshot });
  await assert.rejects(
    record(item, {
      status: 'succeeded',
      snapshot: { ...snapshot, title: 'Changed observation' },
    }),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('Root: expired auth session cannot record under a still-live task lease', async () => {
  const item = await startedAuth();
  await admin(
    "UPDATE auth_execution_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [item.session.sessionId],
  );
  await assert.rejects(
    record(item, { status: 'succeeded' }),
    (e) => e.code === 'LEASE_EXPIRED',
  );
  assert.equal(
    (
      await admin('SELECT outcome FROM action_intents WHERE id=$1', [
        item.permit.grantId,
      ])
    ).rows[0].outcome,
    'pending',
  );
});

test('Root: observation UUID cannot be rebound to another session or run', async () => {
  const a = await setupActiveSession();
  const b = await setupActiveSession();
  const snap = sampleSnapshot(randomUUID());
  snap.redacted = true;
  await context.coordinator.recordAuthObservation(
    a.scope,
    a.proof,
    a.session.sessionId,
    snap,
  );
  const baseline = (
    await admin('SELECT * FROM page_snapshots WHERE id=$1', [snap.snapshotId])
  ).rows[0];
  await assert.rejects(
    context.coordinator.recordAuthObservation(
      b.scope,
      b.proof,
      b.session.sessionId,
      snap,
    ),
  );
  assert.deepEqual(
    (await admin('SELECT * FROM page_snapshots WHERE id=$1', [snap.snapshotId]))
      .rows[0],
    baseline,
  );
});

test('Root: foreign or missing evidence cannot be charged as a successful auth report', async () => {
  const item = await startedAuth();
  await assert.rejects(
    record(item, { status: 'succeeded', evidence: [randomUUID()] }),
  );
  assert.equal(
    (
      await admin('SELECT outcome FROM action_intents WHERE id=$1', [
        item.permit.grantId,
      ])
    ).rows[0].outcome,
    'pending',
  );
});

test('Root: task interruption releases the initializing exclusive lock and ends the private attempt', async () => {
  const item = await startedAuth();
  await context.coordinator.stopTask(item.scope, item.proof, 'setup_failure');
  assert.equal(
    (
      await admin(
        "SELECT count(*)::integer n FROM auth_profile_run_locks WHERE run_id=$1 AND status='held'",
        [item.run.id],
      )
    ).rows[0].n,
    0,
  );
  const intent = (
    await admin(
      'SELECT outcome,execution_state FROM action_intents WHERE id=$1',
      [item.permit.grantId],
    )
  ).rows[0];
  assert.equal(intent.outcome, 'unknown');
  assert.equal(intent.execution_state, 'completed');
});

test('Root: ordinary finish cannot approve auth stage without a committed auth state', async () => {
  const item = await startedAuth();
  await record(item, { status: 'succeeded' });
  const stage = (
    await admin("SELECT result->>'stage' AS stage FROM jobs WHERE id=$1", [
      item.proof.taskId,
    ])
  ).rows[0].stage;
  await assert.rejects(
    context.coordinator.finish(item.scope, item.proof, { stage }),
  );
});

test('Root: viewer cannot read private execution receipts from action_intents', async () => {
  const item = await startedAuth();
  const accounts = new AccountsRepository(db);
  const viewer = await accounts.create(actor, {
    email: `auth-viewer-${randomUUID()}@localqa.test`,
    displayName: 'Owned viewer',
    password: 'OwnedViewerPassword123!',
    globalRole: 'member',
  });
  await db.actor(actor, (client) =>
    client.query(
      "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')",
      [project.id, viewer.id],
    ),
  );
  let rows = [];
  try {
    rows = (
      await db.actor({ userId: viewer.id }, (client) =>
        client.query('SELECT execution_id FROM action_intents WHERE id=$1', [
          item.permit.grantId,
        ]),
      )
    ).rows;
  } catch (e) {
    assert.equal(e.code, 'NOT_FOUND');
  }
  assert.equal(rows.length, 0);
});

test('Root: shared policy begins actions without exclusive lock rows', async () => {
  const item = await startedAuth('shared_state');
  assert.equal(
    (
      await admin(
        'SELECT count(*)::integer n FROM auth_profile_run_locks WHERE run_id=$1',
        [item.run.id],
      )
    ).rows[0].n,
    0,
  );
  await record(item, { status: 'succeeded' });
});

test('Root: real lease recovery ends expired private attempts and releases initializing locks', async () => {
  const item = await startedAuth();
  await admin(
    "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [item.proof.taskId],
  );
  await admin(
    "UPDATE task_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",
    [item.proof.taskId],
  );
  await context.coordinator.leases.recoverExpired(item.scope);
  const intent = (
    await admin(
      'SELECT outcome,execution_state FROM action_intents WHERE id=$1',
      [item.permit.grantId],
    )
  ).rows[0];
  assert.equal(intent.outcome, 'unknown');
  assert.equal(intent.execution_state, 'completed');
  assert.equal(
    (
      await admin(
        "SELECT count(*)::integer n FROM auth_profile_run_locks WHERE run_id=$1 AND status='held'",
        [item.run.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await admin('SELECT status FROM auth_execution_sessions WHERE id=$1', [
        item.session.sessionId,
      ])
    ).rows[0].status,
    'ended',
  );
});

test('Root: ordinary expired lease recovery keeps working after private-table migration', async () => {
  const run = await request('/runs', {
    projectId: project.id,
    targetUrl: url + '/',
  });
  assert.equal(run.status, 202);
  const scope = {
    projectId: project.id,
    workerId: 'owned-recovery-' + randomUUID(),
  };
  const lease = await context.coordinator.claim(scope);
  assert.ok(lease);
  claimedTasks.push(lease.task.id);
  await admin(
    "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [lease.task.id],
  );
  await admin(
    "UPDATE task_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1",
    [lease.task.id],
  );
  await context.coordinator.leases.recoverExpired(scope);
  assert.equal(
    (await admin('SELECT status FROM jobs WHERE id=$1', [lease.task.id]))
      .rows[0].status,
    'queued',
  );
});

test('Root: storage_state navigation permit derives the frozen run target URL', async () => {
  const target = url + '/landing?ownedFixture=1';
  const auth = await context.configRepo.createAuthProfile(actor, project.id, {
    name: 'Owned storage profile ' + randomUUID(),
    environmentId: null,
    mode: 'storage_state',
    sharingPolicy: 'shared_state',
    allowedOrigins: [url],
    secretInput: {
      storageState: JSON.stringify({ cookies: [], origins: [] }),
    },
  });
  const made = await request('/runs', {
    projectId: project.id,
    targetUrl: target,
    authProfileId: auth.id,
  });
  assert.equal(made.status, 202);
  const scope = {
    projectId: project.id,
    workerId: 'owned-storage-' + randomUUID(),
  };
  const lease = await context.coordinator.claim(scope);
  assert.ok(lease);
  claimedTasks.push(lease.task.id);
  await admin(
    "UPDATE jobs SET document=jsonb_set(document,'{summary}','\"auth\"') WHERE id=$1",
    [lease.task.id],
  );
  const proof = {
    taskId: lease.task.id,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    contextVersion: lease.contextVersion,
  };
  const binding = await context.coordinator.allocateAuthSession(scope, proof);
  const ticket = await context.coordinator.issueAuthActivationTicket(
    scope,
    proof,
    binding.sessionId,
  );
  await context.coordinator.activateAuthSession(
    scope,
    proof,
    binding.sessionId,
    ticket.activationTicket,
  );
  const permit = await context.coordinator.grantAuth(scope, proof, {
    sessionId: binding.sessionId,
    requestId: randomUUID(),
    action: 'navigate_auth',
    slot: 'login_url',
  });
  assert.equal(
    permit.url,
    target,
    'Storage profile has no formConfig; navigation comes from the server frozen run, including its private raw target',
  );
});
