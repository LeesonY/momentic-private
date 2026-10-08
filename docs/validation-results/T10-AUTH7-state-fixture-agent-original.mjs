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
  hashPayload,
} from '@localqa/storage';
import { createApiContext, createApiServer } from '../dist/index.js';

const tag = randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'localqa-auth-state-'));
const facts = {
  task: 'T10-AUTH-7A-STATE-CAPTURE',
  tag,
  evidenceDir: dir,
  tests: [],
  postgres: null,
  modelTransportCalls: 0,
  ownership: { containerId: null, volumes: [] },
  limitations: [
    'Real PG18 auth material, success gates, capture grants, canonical keyed HMAC and encrypted run auth state only',
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
  console.log(`[T10 AUTH-7A evidence] ${dir}`);
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
      `localqa-auth-state-${tag}`,
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
    email: `auth-state-${tag}@localqa.test`,
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
    `../../../docs/validation-results/T10-AUTH-STATE-CAPTURE-${tag}.json`,
    import.meta.url,
  );
  writeFileSync(report, JSON.stringify(facts, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(`[T10 AUTH-7A report] ${report.pathname}`);

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
    redacted: false,
  };
}

test('013 Migration RLS protection: non-admin roles and workers cannot query capture tables', async () => {
  const workerClient = new pg.Client({ connectionString: pgConnection });
  await workerClient.connect();
  try {
    await workerClient.query('SET ROLE localqa_worker');
    await workerClient.query(
      "SELECT set_config('localqa.worker_project', $1, false)",
      [project.id],
    );

    await assert.rejects(
      () => workerClient.query('SELECT * FROM auth_success_gates'),
      /permission denied/,
    );
    await assert.rejects(
      () => workerClient.query('SELECT * FROM auth_capture_grants'),
      /permission denied/,
    );
    await assert.rejects(
      () => workerClient.query('SELECT * FROM run_auth_states'),
      /permission denied/,
    );
  } finally {
    await workerClient.end();
  }
});

test('SecretVault keyedHmac domain separation and verification', async () => {
  const payload = hashPayload({ user: 'alice', token: 'secret' });
  const hmacA = context.coordinator.vault.keyedHmac(
    payload,
    'auth_state_capture',
  );
  const hmacB = context.coordinator.vault.keyedHmac(
    payload,
    'different_domain',
  );

  assert.notEqual(
    hmacA.hmac,
    hmacB.hmac,
    'Different domains must produce different HMACs',
  );

  const verified = context.coordinator.vault.verifyKeyedHmac(
    payload,
    'auth_state_capture',
    hmacA.hmac,
    hmacA.keyVersion,
  );
  assert.equal(verified, true);

  const tampered = context.coordinator.vault.verifyKeyedHmac(
    hashPayload({ user: 'alice', token: 'tampered' }),
    'auth_state_capture',
    hmacA.hmac,
    hmacA.keyVersion,
  );
  assert.equal(tampered, false);
});

test('authMaterial: returns decrypted material in private memory; mode=none is rejected', async () => {
  const { scope, proof, session } = await setupActiveSession('form');
  const material = await context.coordinator.authMaterial(
    scope,
    proof,
    session.sessionId,
  );
  assert.equal(material.mode, 'form');
  assert.equal(material.material.username, 'owned-test-user');
  assert.equal(material.material.password, 'owned-test-secret');

  // Verify storage_state material
  const storage = await setupActiveSession('storage_state');
  const storageMat = await context.coordinator.authMaterial(
    storage.scope,
    storage.proof,
    storage.session.sessionId,
  );
  assert.equal(storageMat.mode, 'storage_state');
  assert.ok(storageMat.material.storageState);
});

test('Full capture flow: recordAuthCriterion (gate) -> issueCaptureGrant -> beginAuthCapture CAS -> captureAuthState atomic commit', async () => {
  const { scope, proof, session, run, profileId } =
    await setupActiveSession('form');

  // 1. Record observation snapshot
  const snapId = randomUUID();
  const snap = sampleSnapshot(snapId);
  await context.coordinator.recordAuthObservation(
    scope,
    proof,
    session.sessionId,
    snap,
  );

  // 2. Perform and complete an action so no intents are pending
  const permit = await context.coordinator.grantAuth(scope, proof, {
    requestId: 'req-action-1',
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
  await context.coordinator.recordAuth(
    scope,
    proof,
    session.sessionId,
    permit.grantId,
    receipt,
    { status: 'succeeded' },
  );

  // 3. Record success criterion gate (passed)
  const gateRes = await context.coordinator.recordAuthCriterion(
    scope,
    proof,
    session.sessionId,
    {
      criterionId: 'c1',
      result: 'passed',
      reason: 'Observed dashboard',
      evidenceRefs: [],
    },
    snapId,
  );
  assert.ok(gateRes.gateId);

  // 4. Issue capture grant
  const grantRes = await context.coordinator.issueCaptureGrant(
    scope,
    proof,
    session.sessionId,
    gateRes.gateId,
  );
  assert.ok(grantRes.grant.grantId);
  assert.ok(grantRes.captureTicket);

  // 5. Begin auth capture CAS (issued -> started)
  await context.coordinator.beginAuthCapture(
    scope,
    proof,
    session.sessionId,
    grantRes.grant.grantId,
    grantRes.captureTicket,
  );

  // Calling beginAuthCapture again fails (VERSION_CONFLICT)
  await assert.rejects(
    () =>
      context.coordinator.beginAuthCapture(
        scope,
        proof,
        session.sessionId,
        grantRes.grant.grantId,
        grantRes.captureTicket,
      ),
    (err) => err.code === 'VERSION_CONFLICT',
  );

  // 6. Capture approved auth state
  const statePayload = {
    cookies: [
      {
        name: 'sid',
        value: 'sess-123',
        domain: new URL(url).hostname,
        path: '/',
      },
    ],
    origins: [],
  };

  const stateRef = await context.coordinator.captureAuthState(
    scope,
    proof,
    session.sessionId,
    grantRes.grant.grantId,
    grantRes.captureTicket,
    statePayload,
  );
  assert.ok(stateRef.authStateId);
  assert.equal(stateRef.runId, run.id);
  assert.equal(stateRef.authEpoch, session.authEpoch);

  // Verify database: run_auth_scopes is now 'granted'
  const scopeRow = (
    await admin('SELECT * FROM run_auth_scopes WHERE run_id = $1', [run.id])
  ).rows[0];
  assert.equal(scopeRow.status, 'granted');
  assert.equal(scopeRow.current_state_id, stateRef.authStateId);

  // Verify exclusive lock was promoted from 'initializing' to 'granted'
  const lockRow = (
    await admin(
      'SELECT * FROM auth_profile_run_locks WHERE auth_profile_id = $1 AND run_id = $2',
      [profileId, run.id],
    )
  ).rows[0];
  assert.ok(lockRow);
  assert.equal(lockRow.phase, 'granted');

  // Verify run_auth_states row
  const stateRow = (
    await admin('SELECT * FROM run_auth_states WHERE id = $1', [
      stateRef.authStateId,
    ])
  ).rows[0];
  assert.ok(stateRow);
  assert.equal(stateRow.status, 'granted');
  assert.ok(stateRow.ciphertext);
  assert.ok(stateRow.state_hmac);

  // 7. Idempotent retry with same state returns identical stateRef
  const retryRef = await context.coordinator.captureAuthState(
    scope,
    proof,
    session.sessionId,
    grantRes.grant.grantId,
    grantRes.captureTicket,
    statePayload,
  );
  assert.equal(retryRef.authStateId, stateRef.authStateId);

  // 8. Conflicting state (same cookie structure, different value) throws IDEMPOTENCY_CONFLICT
  const conflictingState = {
    cookies: [
      {
        name: 'sid',
        value: 'different-cookie-value',
        domain: new URL(url).hostname,
        path: '/',
      },
    ],
    origins: [],
  };
  await assert.rejects(
    () =>
      context.coordinator.captureAuthState(
        scope,
        proof,
        session.sessionId,
        grantRes.grant.grantId,
        grantRes.captureTicket,
        conflictingState,
      ),
    (err) => err.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('recordAuthCriterion rejects unpassed results and pending intents', async () => {
  const { scope, proof, session } = await setupActiveSession('form');
  const snapId = randomUUID();
  await context.coordinator.recordAuthObservation(
    scope,
    proof,
    session.sessionId,
    sampleSnapshot(snapId),
  );

  // 1. Unpassed criterion result throws POLICY_DENIED
  await assert.rejects(
    () =>
      context.coordinator.recordAuthCriterion(
        scope,
        proof,
        session.sessionId,
        {
          criterionId: 'c1',
          result: 'failed',
          reason: 'Failed',
          evidenceRefs: [],
        },
        snapId,
      ),
    (err) => err.code === 'POLICY_DENIED',
  );

  // 2. Pending intent blocks recordAuthCriterion (VALIDATION_ERROR)
  await context.coordinator.grantAuth(scope, proof, {
    requestId: 'req-pending',
    sessionId: session.sessionId,
    action: 'navigate_auth',
    slot: 'login_url',
  });

  await assert.rejects(
    () =>
      context.coordinator.recordAuthCriterion(
        scope,
        proof,
        session.sessionId,
        {
          criterionId: 'c1',
          result: 'passed',
          reason: 'Passed',
          evidenceRefs: [],
        },
        snapId,
      ),
    (err) => err.code === 'VALIDATION_ERROR',
  );
});

test('recordAuthCriterion rejects storage_state without frozen criterion and foreign snapshots', async () => {
  const storage = await setupActiveSession('storage_state');
  const snapId = randomUUID();
  await context.coordinator.recordAuthObservation(
    storage.scope,
    storage.proof,
    storage.session.sessionId,
    sampleSnapshot(snapId),
  );

  // Storage profile without frozen criterion -> POLICY_DENIED
  await assert.rejects(
    () =>
      context.coordinator.recordAuthCriterion(
        storage.scope,
        storage.proof,
        storage.session.sessionId,
        {
          criterionId: 'storage-crit',
          result: 'passed',
          reason: 'Passed',
          evidenceRefs: [],
        },
        snapId,
      ),
    (err) => err.code === 'POLICY_DENIED',
  );

  // Foreign/unregistered snapshot -> NOT_FOUND
  const form = await setupActiveSession('form');
  await assert.rejects(
    () =>
      context.coordinator.recordAuthCriterion(
        form.scope,
        form.proof,
        form.session.sessionId,
        {
          criterionId: 'c1',
          result: 'passed',
          reason: 'Passed',
          evidenceRefs: [],
        },
        randomUUID(), // unregistered snapshot ID
      ),
    (err) => err.code === 'NOT_FOUND',
  );
});

test('captureAuthState rejects un-started grants and wrong tickets', async () => {
  const { scope, proof, session } = await setupActiveSession('form');
  const snapId = randomUUID();
  await context.coordinator.recordAuthObservation(
    scope,
    proof,
    session.sessionId,
    sampleSnapshot(snapId),
  );

  const gateRes = await context.coordinator.recordAuthCriterion(
    scope,
    proof,
    session.sessionId,
    { criterionId: 'c1', result: 'passed', reason: 'Passed', evidenceRefs: [] },
    snapId,
  );

  const grantRes = await context.coordinator.issueCaptureGrant(
    scope,
    proof,
    session.sessionId,
    gateRes.gateId,
  );

  // 1. Calling captureAuthState directly while grant is still 'issued' (un-started) -> VALIDATION_ERROR
  await assert.rejects(
    () =>
      context.coordinator.captureAuthState(
        scope,
        proof,
        session.sessionId,
        grantRes.grant.grantId,
        grantRes.captureTicket,
        { cookies: [], origins: [] },
      ),
    (err) => err.code === 'VALIDATION_ERROR',
  );

  // 2. Wrong ticket on beginAuthCapture -> FORBIDDEN
  await assert.rejects(
    () =>
      context.coordinator.beginAuthCapture(
        scope,
        proof,
        session.sessionId,
        grantRes.grant.grantId,
        '0000000000000000000000000000000000000000000000000000000000000000',
      ),
    (err) => err.code === 'FORBIDDEN',
  );
});

test('Session past expires_at fails captureAuthState with LEASE_EXPIRED', async () => {
  const { scope, proof, session } = await setupActiveSession('form');
  const snapId = randomUUID();
  await context.coordinator.recordAuthObservation(
    scope,
    proof,
    session.sessionId,
    sampleSnapshot(snapId),
  );

  const gateRes = await context.coordinator.recordAuthCriterion(
    scope,
    proof,
    session.sessionId,
    { criterionId: 'c1', result: 'passed', reason: 'Passed', evidenceRefs: [] },
    snapId,
  );

  const grantRes = await context.coordinator.issueCaptureGrant(
    scope,
    proof,
    session.sessionId,
    gateRes.gateId,
  );

  await context.coordinator.beginAuthCapture(
    scope,
    proof,
    session.sessionId,
    grantRes.grant.grantId,
    grantRes.captureTicket,
  );

  // Expire session in DB
  await admin(
    "UPDATE auth_execution_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
    [session.sessionId],
  );

  await assert.rejects(
    () =>
      context.coordinator.captureAuthState(
        scope,
        proof,
        session.sessionId,
        grantRes.grant.grantId,
        grantRes.captureTicket,
        { cookies: [], origins: [] },
      ),
    (err) => err.code === 'LEASE_EXPIRED',
  );
});
