import assert from 'node:assert/strict';
import { before, after, afterEach, test as nodeTest } from 'node:test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
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

const tag = randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'localqa-auth-state-root-'));
const facts = {
  task: 'T10-AUTH7-STATE-ROOT',
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
      `localqa-auth-state-root-${tag}`,
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
      "UPDATE jobs SET status = 'interrupted', lease_until = NULL WHERE id = $1 AND status='running'",
      [taskId],
    );
    await admin(
      'UPDATE task_leases SET released_at = clock_timestamp() WHERE task_id = $1 AND released_at IS NULL',
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
    `../../../docs/validation-results/T10-AUTH7-STATE-ROOT-${tag}.json`,
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
    redacted: true,
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

// Root counterexamples run the real Coordinator against an owned PG database.
const passedResult = {
  criterionId: 'c1',
  result: 'passed',
  reason: 'Synthetic private evaluator result',
  evidenceRefs: [],
};
const emptyState = { cookies: [], origins: [] };
const policyError = (e) =>
  [
    'LEASE_EXPIRED',
    'AUTH_FAILED',
    'POLICY_DENIED',
    'VALIDATION_ERROR',
    'VERSION_CONFLICT',
    'FORBIDDEN',
    'IDEMPOTENCY_CONFLICT',
  ].includes(e.code);
async function prepared({ action = true, started = false } = {}) {
  const x = await setupActiveSession('form');
  if (action) {
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
  }
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
    passedResult,
    snapshot.snapshotId,
  );
  const grant = await context.coordinator.issueCaptureGrant(
    x.scope,
    x.proof,
    x.session.sessionId,
    gateId,
  );
  Object.assign(x, { gateId, grant, snapshot });
  if (started) await begin(x);
  return x;
}
const begin = (x) =>
  context.coordinator.beginAuthCapture(
    x.scope,
    x.proof,
    x.session.sessionId,
    x.grant.grant.grantId,
    x.grant.captureTicket,
  );
const capture = (x, state = emptyState) =>
  context.coordinator.captureAuthState(
    x.scope,
    x.proof,
    x.session.sessionId,
    x.grant.grant.grantId,
    x.grant.captureTicket,
    state,
  );
async function assertNoState(x) {
  const row = (
    await admin(
      'SELECT status,current_state_id FROM run_auth_scopes WHERE run_id=$1',
      [x.run.id],
    )
  ).rows[0];
  assert.notEqual(row.status, 'granted');
  assert.equal(row.current_state_id, null);
  assert.equal(
    (await admin('SELECT id FROM run_auth_states WHERE run_id=$1', [x.run.id]))
      .rowCount,
    0,
  );
}
async function afterProfileWait(x, operation) {
  const blocker = new pg.Client({ connectionString: pgConnection });
  await blocker.connect();
  let settled = false;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM auth_profiles WHERE id=$1 FOR UPDATE', [
      x.profileId,
    ]);
    await admin(
      "UPDATE auth_capture_grants SET deadline=clock_timestamp()+interval '350 milliseconds' WHERE id=$1",
      [x.grant.grant.grantId],
    );
    const result = operation()
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    let waiting = false;
    for (let n = 0; n < 50; n++) {
      const w = await admin(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FOR SHARE OF p%' AND pid<>pg_backend_pid()",
      );
      if (w.rowCount) {
        waiting = true;
        break;
      }
      if (settled) break;
      await delay(10);
    }
    assert.ok(waiting, 'the real operation must block on the profile row lock');
    await delay(450);
    await blocker.query('COMMIT');
    const outcome = await result;
    assert.equal(
      outcome.error?.code,
      'LEASE_EXPIRED',
      'capture deadline must be checked after the last lock',
    );
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    await blocker.end();
  }
}

test('Root material rejects importer purpose before decrypting', async () => {
  const x = await setupActiveSession('form');
  await admin(
    "UPDATE auth_execution_sessions SET purpose='importer' WHERE id=$1",
    [x.session.sessionId],
  );
  const v = context.coordinator.vault;
  const original = v.decrypt;
  let calls = 0;
  v.decrypt = function (...args) {
    calls++;
    return original.apply(this, args);
  };
  try {
    await assert.rejects(
      () =>
        context.coordinator.authMaterial(x.scope, x.proof, x.session.sessionId),
      policyError,
    );
    assert.equal(calls, 0);
  } finally {
    v.decrypt = original;
  }
});
test('Root material rejects scope context mismatch before decrypting', async () => {
  const x = await setupActiveSession('form');
  await admin(
    'UPDATE run_auth_scopes SET context_version=context_version+1 WHERE run_id=$1',
    [x.run.id],
  );
  const v = context.coordinator.vault;
  const original = v.decrypt;
  let calls = 0;
  v.decrypt = function (...args) {
    calls++;
    return original.apply(this, args);
  };
  try {
    await assert.rejects(
      () =>
        context.coordinator.authMaterial(x.scope, x.proof, x.session.sessionId),
      policyError,
    );
    assert.equal(calls, 0);
  } finally {
    v.decrypt = original;
  }
});
test('Root begin rejects session fencing mismatch', async () => {
  const x = await prepared();
  await admin(
    'UPDATE auth_execution_sessions SET fencing_token=fencing_token+1 WHERE id=$1',
    [x.session.sessionId],
  );
  await assert.rejects(() => begin(x), policyError);
  await assertNoState(x);
});
test('Root capture rejects session worker mismatch', async () => {
  const x = await prepared({ started: true });
  await admin(
    "UPDATE auth_execution_sessions SET worker_id='another-worker' WHERE id=$1",
    [x.session.sessionId],
  );
  await assert.rejects(() => capture(x), policyError);
  await assertNoState(x);
});
test('Root begin rejects a capture deadline expired while waiting on a profile lock', async () => {
  const x = await prepared();
  await afterProfileWait(x, () => begin(x));
  assert.equal(
    (
      await admin('SELECT status FROM auth_capture_grants WHERE id=$1', [
        x.grant.grant.grantId,
      ])
    ).rows[0].status,
    'issued',
  );
  await assertNoState(x);
});
test('Root capture rejects a capture deadline expired while waiting on a profile lock', async () => {
  const x = await prepared({ started: true });
  await afterProfileWait(x, () => capture(x));
  await assertNoState(x);
});
test('Root old success gate cannot authorize capture after another pending action', async () => {
  const x = await prepared();
  await context.coordinator.grantAuth(x.scope, x.proof, {
    requestId: randomUUID(),
    sessionId: x.session.sessionId,
    action: 'navigate_auth',
    slot: 'login_url',
  });
  await assert.rejects(
    () =>
      context.coordinator.issueCaptureGrant(
        x.scope,
        x.proof,
        x.session.sessionId,
        x.gateId,
      ),
    policyError,
  );
});
test('Root capture refuses an action pending after capture begin', async () => {
  const x = await prepared({ started: true });
  await context.coordinator.grantAuth(x.scope, x.proof, {
    requestId: randomUUID(),
    sessionId: x.session.sessionId,
    action: 'navigate_auth',
    slot: 'login_url',
  });
  await assert.rejects(() => capture(x), policyError);
  await assertNoState(x);
});
test('Root another capture ticket cannot return a prior ticket state', async () => {
  const x = await prepared({ started: true });
  await capture(x);
  await assert.rejects(async () => {
    const second = await context.coordinator.issueCaptureGrant(
      x.scope,
      x.proof,
      x.session.sessionId,
      x.gateId,
    );
    await begin({ ...x, grant: second });
    await capture({ ...x, grant: second });
  }, policyError);
});
test('Root same-ticket replay refuses a revoked stored state', async () => {
  const x = await prepared({ started: true });
  const ref = await capture(x);
  await admin(
    "UPDATE run_auth_states SET status='revoked',revoked_at=clock_timestamp() WHERE id=$1",
    [ref.authStateId],
  );
  await assert.rejects(() => capture(x), policyError);
});
test('Root same-ticket replay verifies stored historical binding', async () => {
  const x = await prepared({ started: true });
  const ref = await capture(x);
  await admin(
    'UPDATE run_auth_states SET capturing_fencing_token=capturing_fencing_token+1 WHERE id=$1',
    [ref.authStateId],
  );
  await assert.rejects(() => capture(x), policyError);
});
test('Root same state is idempotent across a Vault key rotation with the historical key retained', async () => {
  const x = await prepared({ started: true });
  const ref = await capture(x);
  const oldVault = context.coordinator.vault;
  const keys = JSON.parse(readFileSync(kekFile, 'utf8'));
  const rotatedFile = join(dir, 'root-rotated-kek.json');
  writeFileSync(
    rotatedFile,
    JSON.stringify({
      activeVersion: 2,
      keys: { ...keys.keys, 2: randomBytes(32).toString('base64') },
    }),
    { mode: 0o600 },
  );
  const rotated = await SecretVault.fromProtectedFile(rotatedFile);
  context.coordinator.vault = rotated;
  try {
    assert.equal((await capture(x)).authStateId, ref.authStateId);
  } finally {
    context.coordinator.vault = oldVault;
    rotated.dispose();
    rmSync(rotatedFile, { force: true });
    assert.equal(existsSync(rotatedFile), false);
  }
});
test('Root encryption failure rolls capture back without a granted scope', async () => {
  const x = await prepared({ started: true });
  const v = context.coordinator.vault;
  const original = v.encrypt;
  v.encrypt = () => {
    const e = new Error('SERVICE_UNAVAILABLE');
    e.code = 'SERVICE_UNAVAILABLE';
    throw e;
  };
  try {
    await assert.rejects(
      () => capture(x),
      (e) => e.code === 'SERVICE_UNAVAILABLE',
    );
    await assertNoState(x);
    assert.equal(
      (
        await admin('SELECT status FROM auth_capture_grants WHERE id=$1', [
          x.grant.grant.grantId,
        ])
      ).rows[0].status,
      'started',
    );
  } finally {
    v.encrypt = original;
  }
});
test('Root failed PG state insertion rolls the whole capture transaction back', async () => {
  const x = await prepared({ started: true });
  await admin(
    'ALTER TABLE run_auth_states ADD CONSTRAINT root_force_capture_failure CHECK (false) NOT VALID',
  );
  try {
    await assert.rejects(() => capture(x));
    await assertNoState(x);
    assert.equal(
      (
        await admin('SELECT status FROM auth_capture_grants WHERE id=$1', [
          x.grant.grant.grantId,
        ])
      ).rows[0].status,
      'started',
    );
  } finally {
    await admin(
      'ALTER TABLE run_auth_states DROP CONSTRAINT root_force_capture_failure',
    );
  }
});
test('Root exclusive capture cannot grant a state without a held profile lock', async () => {
  const x = await prepared({ action: false, started: true });
  const result = await capture(x).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  if (result.error) {
    assert.ok(policyError(result.error));
    await assertNoState(x);
  } else {
    const lock = (
      await admin(
        "SELECT * FROM auth_profile_run_locks WHERE run_id=$1 AND status='held' AND phase='granted'",
        [x.run.id],
      )
    ).rows[0];
    assert.ok(
      lock,
      'an exclusive granted state must hold a granted profile lock',
    );
  }
});

test('Root generic finish cannot bypass the dedicated auth finish after capture', async () => {
  const x = await prepared({ started: true });
  await capture(x);
  await admin(
    "UPDATE jobs SET role='executor',document=jsonb_set(document,'{role}','\"executor\"'),result='{\"stage\":\"auth\"}'::jsonb WHERE id=$1",
    [x.proof.taskId],
  );
  const originalTx = context.coordinator.tx;
  context.coordinator.tx = function (work) {
    return originalTx.call(this, async (client) => {
      try {
        return await work(client);
      } catch (e) {
        facts.genericFinishDiagnostic = {
          errorClass: e.constructor?.name,
          code: e.code,
          permissionDenied: String(e.message).includes('permission denied'),
          validationError: String(e.message).includes('validation'),
          dbConstraint: e.constraint,
        };
        throw e;
      }
    });
  };
  try {
    await assert.rejects(
      () => context.coordinator.finish(x.scope, x.proof, { stage: 'auth' }),
      policyError,
    );
  } finally {
    context.coordinator.tx = originalTx;
  }

  assert.equal(
    (await admin('SELECT status FROM jobs WHERE id=$1', [x.proof.taskId]))
      .rows[0].status,
    'running',
  );
});
test('Root completed actions after the success gate invalidate that gate', async () => {
  const x = await prepared();
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
  await assert.rejects(
    () =>
      context.coordinator.issueCaptureGrant(
        x.scope,
        x.proof,
        x.session.sessionId,
        x.gateId,
      ),
    policyError,
  );
});
test('Root a newer observation makes the older capture success snapshot stale', async () => {
  const x = await prepared();
  const snapshot = sampleSnapshot(randomUUID());
  snapshot.stateVersion = 2;
  await context.coordinator.recordAuthObservation(
    x.scope,
    x.proof,
    x.session.sessionId,
    snapshot,
  );
  await assert.rejects(
    () =>
      context.coordinator.issueCaptureGrant(
        x.scope,
        x.proof,
        x.session.sessionId,
        x.gateId,
      ),
    policyError,
  );
});
test('Root concurrent capture begins execute the real CAS once', async () => {
  const x = await prepared();
  const outcomes = await Promise.allSettled([begin(x), begin(x)]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    outcomes.filter(
      (r) => r.status === 'rejected' && r.reason.code === 'VERSION_CONFLICT',
    ).length,
    1,
  );
  assert.equal(
    (
      await admin('SELECT status FROM auth_capture_grants WHERE id=$1', [
        x.grant.grant.grantId,
      ])
    ).rows[0].status,
    'started',
  );
});

test('Root real RuntimeClient and auth-services complete the actual private flow, PG capture and dedicated finish', async () => {
  const [
    { RuntimeClient },
    { createAuthServices },
    { createAuthRuntimeBridge },
    { runAuthFlow },
    { createPrivateAuthPort },
    { evaluateTechnical },
  ] = await Promise.all([
    import('@localqa/orchestrator'),
    import('../../worker/dist/auth-services.js'),
    import('../../worker/dist/auth-runtime.js'),
    import('../../worker/dist/auth-flow.js'),
    import('../../../packages/browser/dist/index.js'),
    import('../../../packages/domain/dist/index.js'),
  ]);
  const x = await authExecutor(await setupActiveSession('form'));
  const runtimeClient = new RuntimeClient(
    context.coordinator,
    x.scope,
    context.artifacts,
    {},
  );
  let ordinaryCalls = 0;
  for (const method of ['model', 'grant', 'record', 'finish'])
    runtimeClient[method] = async () => {
      ordinaryCalls++;
      throw new Error('Ordinary channel forbidden in private auth flow');
    };
  const services = createAuthServices({
    client: runtimeClient,
    proof: x.proof,
    binding: x.session,
  });
  const bridge = createAuthRuntimeBridge({
    client: runtimeClient,
    proof: x.proof,
    binding: x.session,
    services,
  });
  let step = 0,
    submitted = false,
    exportCalls = 0;
  const pageId = randomUUID();
  function observed() {
    const snapshot = sampleSnapshot(randomUUID(), pageId);
    snapshot.stateVersion = ++step;
    snapshot.nodes = [
      'username',
      'password',
      'login',
      ...(submitted ? ['dash'] : []),
    ].map((value, index) => ({
      nodeId: `testid_${value}`,
      frameId: 'main',
      role: index < 2 ? 'textbox' : index === 2 ? 'button' : 'main',
      name: value,
      text:
        index === 0
          ? 'owned-test-user'
          : index === 1
            ? 'owned-test-secret'
            : value,
      visible: true,
      enabled: true,
      bounds: { left: 0, top: index * 40, width: 100, height: 30 },
    }));
    return snapshot;
  }
  const privateState = {
    cookies: [
      {
        name: 'root_owned_cookie',
        value: `root-capture-${tag}`,
        domain: new URL(url).hostname,
        path: '/',
      },
    ],
    origins: [],
  };
  const port = createPrivateAuthPort({
    binding: x.session,
    gate: bridge.gate,
    allowedOrigins: x.auth.allowedOrigins,
    primitives: {
      async navigate(target) {
        assert.equal(target, x.auth.formConfig.loginUrl);
        return observed();
      },
      async fill(target, secret) {
        assert.ok(['owned-test-user', 'owned-test-secret'].includes(secret));
        assert.ok(target.nodeId.startsWith('testid_'));
        return observed();
      },
      async submit() {
        submitted = true;
        return observed();
      },
      async prepareState() {
        assert.fail('Form auth does not import profile storage state');
      },
      async exportState() {
        exportCalls++;
        return privateState;
      },
    },
  });
  const outcome = await runAuthFlow(
    {
      profile: x.auth,
      binding: x.session,
      runtime: bridge.runtime,
      port,
      adapters: {
        async locate(snapshot, locator) {
          const node = snapshot.nodes.find(
            (n) => n.nodeId === `testid_${locator.value}`,
          );
          return node
            ? {
                snapshotId: snapshot.snapshotId,
                pageId: snapshot.pageId,
                nodeId: node.nodeId,
                frameId: 'main',
              }
            : null;
        },
        async evaluate(snapshot, criterion) {
          const bytes = Buffer.from(JSON.stringify(snapshot));
          const artifact = await runtimeClient.upload(
            x.proof,
            {
              id: randomUUID(),
              projectId: project.id,
              runId: x.run.id,
              taskId: x.proof.taskId,
              kind: 'other',
              status: 'available',
              bytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              contentUrl: null,
              redaction: 'applied',
              error: null,
              createdAt: new Date().toISOString(),
              stepId: null,
              caseId: null,
              snapshotId: snapshot.snapshotId,
            },
            bytes,
          );
          return evaluateTechnical(
            { criteria: [criterion] },
            snapshot,
            snapshot.responseStatus,
            [artifact.id],
          )[0];
        },
      },
    },
    new AbortController().signal,
  );
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.reasonCode, 'AUTH_SUCCEEDED');
  assert.equal(exportCalls, 1);
  assert.equal(ordinaryCalls, 0);
  const state = (
    await admin('SELECT id,status FROM run_auth_states WHERE run_id=$1', [
      x.run.id,
    ])
  ).rows[0];
  assert.ok(state);
  assert.equal(state.status, 'granted');
  const scope = (
    await admin(
      'SELECT status,current_state_id FROM run_auth_scopes WHERE run_id=$1',
      [x.run.id],
    )
  ).rows[0];
  assert.equal(scope.status, 'granted');
  assert.equal(scope.current_state_id, state.id);
  const acts = (
    await admin(
      'SELECT outcome,execution_state FROM action_intents WHERE task_id=$1',
      [x.proof.taskId],
    )
  ).rows;
  assert.equal(acts.length, 4);
  assert.ok(
    acts.every(
      (a) => a.outcome === 'succeeded' && a.execution_state === 'completed',
    ),
  );
  assert.equal(
    (
      await admin('SELECT status FROM auth_capture_grants WHERE task_id=$1', [
        x.proof.taskId,
      ])
    ).rows[0].status,
    'consumed',
  );
  assert.equal(
    (await admin('SELECT status FROM jobs WHERE id=$1', [x.proof.taskId]))
      .rows[0].status,
    'succeeded',
  );
  const publicData = await admin(
    'SELECT document FROM steps WHERE task_id=$1 UNION ALL SELECT document FROM page_snapshots WHERE task_id=$1',
    [x.proof.taskId],
  );
  const text = JSON.stringify({
    outcome,
    publicData: publicData.rows,
    services,
    bridge,
  });
  for (const secret of [
    'owned-test-user',
    'owned-test-secret',
    privateState.cookies[0].value,
    x.proof.leaseToken,
  ])
    assert.equal(
      text.includes(secret),
      false,
      'private material cannot appear in public data or outcome',
    );
});

test('Root unredacted auth observations are rejected before public persistence', async () => {
  const x = await setupActiveSession('form');
  const snapshot = sampleSnapshot(randomUUID());
  snapshot.redacted = false;
  await assert.rejects(
    () =>
      context.coordinator.recordAuthObservation(
        x.scope,
        x.proof,
        x.session.sessionId,
        snapshot,
      ),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  assert.equal(
    (
      await admin('SELECT id FROM page_snapshots WHERE id=$1', [
        snapshot.snapshotId,
      ])
    ).rowCount,
    0,
  );
});

async function authExecutor(x) {
  await admin(
    "UPDATE jobs SET role='executor',document=jsonb_set(document,'{role}','\"executor\"'),result='{\"stage\":\"auth\"}'::jsonb WHERE id=$1",
    [x.proof.taskId],
  );
  return x;
}
const finishPrivate = (x, stateId) =>
  context.coordinator.finishAuth(
    x.scope,
    x.proof,
    x.session.sessionId,
    stateId,
  );
async function grantedExecutor() {
  const x = await authExecutor(await prepared({ started: true }));
  const ref = await capture(x);
  return { ...x, ref };
}
async function stillGrantedRunning(x) {
  assert.equal(
    (await admin('SELECT status FROM jobs WHERE id=$1', [x.proof.taskId]))
      .rows[0].status,
    'running',
  );
  assert.equal(
    (
      await admin('SELECT status FROM auth_execution_sessions WHERE id=$1', [
        x.session.sessionId,
      ])
    ).rows[0].status,
    'active',
  );
  assert.equal(
    (
      await admin(
        'SELECT status,current_state_id FROM run_auth_scopes WHERE run_id=$1',
        [x.run.id],
      )
    ).rows[0].current_state_id,
    x.ref.authStateId,
  );
  assert.equal(
    (
      await admin(
        "SELECT count(*)::integer n FROM budget_reservations WHERE task_id=$1 AND kind='concurrency' AND status='reserved'",
        [x.proof.taskId],
      )
    ).rows[0].n,
    1,
  );
}
test('Root dedicated finish uses the captured proof, ends only its task session/lease/slots and preserves granted run authority', async () => {
  const x = await grantedExecutor();
  await finishPrivate(x, x.ref.authStateId);
  const job = (
    await admin('SELECT status,result FROM jobs WHERE id=$1', [x.proof.taskId])
  ).rows[0];
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.result, {
    stage: 'auth',
    granted: true,
    authStateId: x.ref.authStateId,
  });
  assert.equal(
    (
      await admin(
        'SELECT status,end_reason FROM auth_execution_sessions WHERE id=$1',
        [x.session.sessionId],
      )
    ).rows[0].end_reason,
    'auth_finished',
  );
  assert.ok(
    (
      await admin('SELECT released_at FROM task_leases WHERE task_id=$1', [
        x.proof.taskId,
      ])
    ).rows[0].released_at,
  );
  assert.equal(
    (
      await admin(
        "SELECT count(*)::integer n FROM budget_reservations WHERE task_id=$1 AND kind='concurrency' AND status='reserved'",
        [x.proof.taskId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await admin(
        'SELECT status,current_state_id FROM run_auth_scopes WHERE run_id=$1',
        [x.run.id],
      )
    ).rows[0].current_state_id,
    x.ref.authStateId,
  );
  assert.equal(
    (
      await admin(
        "SELECT phase FROM auth_profile_run_locks WHERE run_id=$1 AND status='held'",
        [x.run.id],
      )
    ).rows[0].phase,
    'granted',
  );
});
test('Root dedicated finish retry is inert and changed state/proof/context is refused', async () => {
  const x = await grantedExecutor();
  await finishPrivate(x, x.ref.authStateId);
  const before = await admin('SELECT * FROM jobs WHERE id=$1', [
    x.proof.taskId,
  ]);
  await finishPrivate(x, x.ref.authStateId);
  assert.deepEqual(
    (await admin('SELECT * FROM jobs WHERE id=$1', [x.proof.taskId])).rows,
    before.rows,
  );
  await assert.rejects(
    () => finishPrivate(x, randomUUID()),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  for (const patch of [
    { fencingToken: x.proof.fencingToken + 1 },
    { leaseToken: 'wrong-private-token' },
    { contextVersion: x.proof.contextVersion + 1 },
  ]) {
    await assert.rejects(
      () =>
        finishPrivate(
          { ...x, proof: { ...x.proof, ...patch } },
          x.ref.authStateId,
        ),
      policyError,
    );
  }
  await assert.rejects(
    () =>
      finishPrivate(
        { ...x, session: { ...x.session, sessionId: randomUUID() } },
        x.ref.authStateId,
      ),
    policyError,
  );
});
test('Root dedicated finish refuses a stale capture success gate and preserves the committed state', async () => {
  const x = await grantedExecutor();
  await context.coordinator.recordAuthObservation(
    x.scope,
    x.proof,
    x.session.sessionId,
    sampleSnapshot(randomUUID()),
  );
  await assert.rejects(() => finishPrivate(x, x.ref.authStateId), policyError);
  await stillGrantedRunning(x);
});
test('Root dedicated finish rechecks the capture deadline after a real profile lock wait', async () => {
  const x = await grantedExecutor();
  await afterProfileWait(x, () => finishPrivate(x, x.ref.authStateId));
  await stillGrantedRunning(x);
});
test('Root a failed finish job update rolls back the session, lease and concurrency release', async () => {
  const x = await grantedExecutor();
  await admin(
    "ALTER TABLE jobs ADD CONSTRAINT root_force_finish_failure CHECK (status<>'succeeded') NOT VALID",
  );
  try {
    await assert.rejects(() => finishPrivate(x, x.ref.authStateId));
    await stillGrantedRunning(x);
    assert.equal(
      (
        await admin('SELECT released_at FROM task_leases WHERE task_id=$1', [
          x.proof.taskId,
        ])
      ).rows[0].released_at,
      null,
    );
  } finally {
    await admin('ALTER TABLE jobs DROP CONSTRAINT root_force_finish_failure');
  }
});
test('Root finish verifies encrypted historical metadata even when the state columns still match', async () => {
  const x = await grantedExecutor();
  const row = (
    await admin('SELECT * FROM run_auth_states WHERE id=$1', [
      x.ref.authStateId,
    ])
  ).rows[0];
  const binding = {
    projectId: project.id,
    secretId: row.id,
    purpose: 'run_auth_state',
  };
  const envelope = JSON.parse(
    context.coordinator.vault.decrypt(
      {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.auth_tag,
        keyVersion: row.key_version,
      },
      binding,
    ),
  );
  envelope.capturingWorkerId = 'foreign-historical-worker';
  const cipher = context.coordinator.vault.encrypt(
    JSON.stringify(envelope),
    binding,
  );
  await admin(
    'UPDATE run_auth_states SET ciphertext=$2,nonce=$3,auth_tag=$4,key_version=$5 WHERE id=$1',
    [
      row.id,
      cipher.ciphertext,
      cipher.nonce,
      cipher.authTag,
      cipher.keyVersion,
    ],
  );
  await assert.rejects(
    () => finishPrivate(x, x.ref.authStateId),
    (e) => e.code === 'AUTH_FAILED',
  );
  await stillGrantedRunning(x);
});
test('Root project viewer can read its project but no capture tickets, HMAC or state ciphertext', async () => {
  await grantedExecutor();
  const user = await new AccountsRepository(db).create(actor, {
    email: `viewer-${randomUUID()}@localqa.test`,
    displayName: 'Owned Viewer',
    password: 'OwnedViewer123!',
    globalRole: 'member',
  });
  await admin(
    "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')",
    [project.id, user.id],
  );
  await db.actor({ userId: user.id }, async (client) => {
    assert.equal(
      (await client.query('SELECT id FROM projects WHERE id=$1', [project.id]))
        .rowCount,
      1,
    );
    for (const table of [
      'auth_success_gates',
      'auth_capture_grants',
      'run_auth_states',
    ])
      assert.equal((await client.query(`SELECT * FROM ${table}`)).rowCount, 0);
  });
});
test('Root none creates no auth sessions/scopes and private material decryption remains zero', async () => {
  const { run } = await createRunWithProfile('none');
  const scope = { projectId: project.id, workerId: `none-${randomUUID()}` };
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
  let decrypts = 0;
  const vault = context.coordinator.vault,
    original = vault.decrypt;
  vault.decrypt = function (...args) {
    decrypts++;
    return original.apply(this, args);
  };
  try {
    await assert.rejects(
      () => context.coordinator.allocateAuthSession(scope, proof),
      (e) => e.code === 'POLICY_DENIED',
    );
    await assert.rejects(
      () => context.coordinator.authMaterial(scope, proof, randomUUID()),
      policyError,
    );
    assert.equal(decrypts, 0);
    assert.equal(
      (
        await admin('SELECT id FROM auth_execution_sessions WHERE task_id=$1', [
          proof.taskId,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin('SELECT run_id FROM run_auth_scopes WHERE run_id=$1', [
          run.id,
        ])
      ).rowCount,
      0,
    );
  } finally {
    vault.decrypt = original;
  }
});

test('Root production auth adapters register the actual fresh snapshot IDs and complete the real PG private flow', async () => {
  const [
    { RuntimeClient },
    { createAuthServices },
    { createAuthRuntimeBridge },
    { runAuthFlow },
    { createAuthAdapters },
    { createPrivateAuthPort },
  ] = await Promise.all([
    import('@localqa/orchestrator'),
    import('../../worker/dist/auth-services.js'),
    import('../../worker/dist/auth-runtime.js'),
    import('../../worker/dist/auth-flow.js'),
    import('../../worker/dist/auth-adapters.js'),
    import('../../../packages/browser/dist/index.js'),
  ]);
  const x = await authExecutor(await setupActiveSession('form'));
  const client = new RuntimeClient(
    context.coordinator,
    x.scope,
    context.artifacts,
    {},
  );
  let ordinary = 0;
  for (const method of ['model', 'grant', 'record', 'finish'])
    client[method] = async () => {
      ordinary++;
      throw Error('Ordinary channel forbidden');
    };
  const services = createAuthServices({
    client,
    proof: x.proof,
    binding: x.session,
  });
  const bridge = createAuthRuntimeBridge({
    client,
    proof: x.proof,
    binding: x.session,
    services,
  });
  const evidence = new Map();
  const seen = [];
  const rawWitnessIds = [];
  const record = bridge.runtime.recordAuthObservation.bind(bridge.runtime);
  bridge.runtime.recordAuthObservation = async (snapshot) => {
    await record(snapshot);
    seen.push(snapshot);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const artifact = await client.upload(
      x.proof,
      {
        id: randomUUID(),
        projectId: project.id,
        runId: x.run.id,
        taskId: x.proof.taskId,
        kind: 'other',
        status: 'available',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentUrl: null,
        redaction: 'applied',
        error: null,
        createdAt: new Date().toISOString(),
        stepId: null,
        caseId: null,
        snapshotId: snapshot.snapshotId,
      },
      bytes,
    );
    evidence.set(snapshot.snapshotId, [artifact.id]);
  };
  let cached,
    step = 0,
    submitted = false,
    effects = 0,
    exports = 0;
  const pageId = randomUUID();
  function observe() {
    const snapshot = sampleSnapshot(randomUUID(), pageId);
    snapshot.stateVersion = ++step;
    snapshot.title = 'owned-test-secret';
    snapshot.displayUrl = `${url}/login?secret=owned-test-secret`;
    snapshot.nodes = [
      'username',
      'password',
      'login',
      ...(submitted ? ['dash'] : []),
    ].map((value, index) => ({
      nodeId: `testid_${value}`,
      frameId: 'main',
      role: index < 2 ? 'textbox' : index === 2 ? 'button' : 'main',
      name: value,
      text: index < 2 ? 'owned-test-secret' : value,
      visible: true,
      enabled: true,
      bounds: { left: 0, top: index * 40, width: 100, height: 30 },
    }));
    cached = snapshot;
    return snapshot;
  }
  const session = {
    async resolveRegressionLocator(locator) {
      const fresh = observe();
      rawWitnessIds.push(fresh.snapshotId);
      const node = fresh.nodes.find(
        (n) => n.nodeId === `testid_${locator.value}`,
      );
      if (!node) {
        const e = Error('LOCATOR_NOT_FOUND');
        e.code = 'LOCATOR_NOT_FOUND';
        throw e;
      }
      return {
        snapshotId: fresh.snapshotId,
        pageId: fresh.pageId,
        nodeId: node.nodeId,
        frameId: 'main',
      };
    },
    async getSnapshot(options) {
      assert.notEqual(
        options?.forceFresh,
        true,
        'read the actual cached resolver observation',
      );
      return cached;
    },
  };
  const adapters = createAuthAdapters({
    session,
    binding: x.session,
    criterion: x.auth.formConfig.successCriterion,
    ownedEvidence: (snapshot) => evidence.get(snapshot.snapshotId) ?? [],
  });
  const port = createPrivateAuthPort({
    binding: x.session,
    gate: bridge.gate,
    allowedOrigins: x.auth.allowedOrigins,
    primitives: {
      async navigate() {
        effects++;
        return observe();
      },
      async fill() {
        effects++;
        return observe();
      },
      async submit() {
        effects++;
        submitted = true;
        return observe();
      },
      async prepareState() {
        assert.fail('Form auth does not import profile state');
      },
      async exportState() {
        exports++;
        return { cookies: [], origins: [] };
      },
    },
  });
  const outcome = await runAuthFlow(
    {
      profile: x.auth,
      binding: x.session,
      runtime: bridge.runtime,
      port,
      adapters,
    },
    new AbortController().signal,
  );
  assert.equal(outcome.status, 'succeeded');
  assert.equal(effects, 4);
  assert.equal(exports, 1);
  assert.equal(ordinary, 0);
  assert.equal(rawWitnessIds.length, 3);
  for (const id of rawWitnessIds) {
    assert.ok(
      seen.some((s) => s.snapshotId === id),
      'persist exactly the locator witness ID',
    );
    assert.equal(
      (
        await admin(
          'SELECT id FROM page_snapshots WHERE id=$1 AND task_id=$2',
          [id, x.proof.taskId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await admin(
          "SELECT id FROM action_intents WHERE task_id=$1 AND tool_call->'args'->'target'->>'snapshotId'=$2",
          [x.proof.taskId, id],
        )
      ).rowCount,
      1,
    );
  }
  assert.equal(
    JSON.stringify({ outcome, seen }).includes('owned-test-secret'),
    false,
  );
  assert.equal(
    JSON.stringify({ outcome, seen }).includes(x.proof.leaseToken),
    false,
  );
  assert.equal(
    (await admin('SELECT status FROM jobs WHERE id=$1', [x.proof.taskId]))
      .rows[0].status,
    'succeeded',
  );
  assert.equal(
    (
      await admin('SELECT status FROM auth_execution_sessions WHERE id=$1', [
        x.session.sessionId,
      ])
    ).rows[0].status,
    'ended',
  );
});
