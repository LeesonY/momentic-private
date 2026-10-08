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

const tag = randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'localqa-auth-session-'));
const facts = {
  task: 'T10-AUTH-5-SESSION-AUTHORITY',
  tag,
  evidenceDir: dir,
  tests: [],
  postgres: null,
  modelTransportCalls: 0,
  ownership: { containerId: null, volumes: [] },
  limitations: [
    'Real PG18 session authority ledger and private Runtime/Coordinator facade only',
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

const claimedTasks = [];
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
  console.log(`[T10 AUTH-5 evidence] ${dir}`);
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
      `localqa-auth-session-${tag}`,
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
    email: `auth-session-${tag}@localqa.test`,
    displayName: 'Auth Session Owner',
    password: 'SessionOwner123!',
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
      password: 'SessionOwner123!',
    }),
  });
  assert.equal(loginRes.status, 200);
  cookie = loginRes.headers.get('set-cookie').split(';')[0];
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
    `../../../docs/validation-results/T10-AUTH-SESSION-AUTHORITY-${tag}.json`,
    import.meta.url,
  );
  writeFileSync(report, JSON.stringify(facts, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(`[T10 AUTH-5 report] ${report.pathname}`);

  assert.equal(facts.modelTransportCalls, 0);
  assert.equal(cleanup.credentialsAbsent, true);
  if (facts.ownership.containerId) {
    assert.equal(cleanup.removeStatus, 0);
    assert.equal(cleanup.containerAbsent, true);
    assert.ok(cleanup.volumes.every((v) => v.absent));
  }
  if (pgPort) assert.equal(cleanup.pgPortClosed, true);
});

// Helper to make API requests with cookie
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

// Helper to set up a run with an active form auth profile
async function createRunWithProfile(mode = 'form') {
  const auth = await context.configRepo.createAuthProfile(actor, project.id, {
    name: `auth-${randomUUID()}`,
    environmentId: null,
    mode,
    allowedOrigins: [url],
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

async function claimAuthTask(run) {
  const scope = {
    projectId: project.id,
    workerId: `worker-${randomUUID()}`,
  };
  const lease = await context.coordinator.claim(scope);
  assert.ok(lease);
  assert.equal(lease.task.runId, run.id);

  // Mark task summary as 'auth' (the server-side smoke task definition)
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

  return { scope, proof, lease };
}

test('011 Migration RLS protection: non-admin roles and workers cannot query protected tables', async () => {
  // Test direct query via worker actor
  const workerClient = new pg.Client({ connectionString: pgConnection });
  await workerClient.connect();
  try {
    await workerClient.query('SET ROLE localqa_worker');
    await workerClient.query(
      "SELECT set_config('localqa.worker_project', $1, false)",
      [project.id],
    );

    await assert.rejects(
      () => workerClient.query('SELECT * FROM run_auth_scopes'),
      /permission denied/,
      'Worker role must be denied access to run_auth_scopes',
    );

    await assert.rejects(
      () => workerClient.query('SELECT * FROM auth_execution_sessions'),
      /permission denied/,
      'Worker role must be denied access to auth_execution_sessions',
    );
  } finally {
    await workerClient.end();
  }
});

test('Full lifecycle: allocate session (authEpoch=1, allocated) -> re-allocate idempotent -> issue ticket -> activate CAS -> query -> end', async () => {
  const { run, profileId } = await createRunWithProfile('form');
  const { scope, proof } = await claimAuthTask(run);

  // 1. Allocate session
  const binding1 = await context.coordinator.allocateAuthSession(scope, proof);
  assert.ok(binding1.sessionId);
  assert.equal(binding1.projectId, project.id);
  assert.equal(binding1.runId, run.id);
  assert.equal(binding1.taskId, proof.taskId);
  assert.equal(binding1.workerId, scope.workerId);
  assert.equal(binding1.fencingToken, proof.fencingToken);
  assert.equal(binding1.contextVersion, proof.contextVersion);
  assert.equal(binding1.profileId, profileId);
  assert.equal(binding1.profileVersion, 1);
  assert.equal(binding1.authEpoch, 1);
  assert.equal(binding1.purpose, 'initializer');
  assert.equal(binding1.status, 'allocated');

  // Verify run_auth_scopes in DB
  const scopeRow = (
    await admin(
      'SELECT * FROM run_auth_scopes WHERE project_id = $1 AND run_id = $2',
      [project.id, run.id],
    )
  ).rows[0];
  assert.ok(scopeRow);
  assert.equal(scopeRow.auth_epoch, 1);
  assert.equal(scopeRow.status, 'initializing');
  assert.equal(scopeRow.auth_profile_id, profileId);
  assert.equal(scopeRow.auth_profile_version, 1);

  // 2. Re-allocate on allocated session returns identical binding idempotently
  const binding2 = await context.coordinator.allocateAuthSession(scope, proof);
  assert.deepEqual(binding2, binding1);

  // 3. Issue activation ticket
  const ticketRes1 = await context.coordinator.issueAuthActivationTicket(
    scope,
    proof,
    binding1.sessionId,
  );
  assert.ok(ticketRes1.activationTicket);

  // Verify database stores hash only, never cleartext
  const dbSession = (
    await admin('SELECT * FROM auth_execution_sessions WHERE id = $1', [
      binding1.sessionId,
    ])
  ).rows[0];
  assert.ok(dbSession.activation_ticket_hash);
  assert.notEqual(
    dbSession.activation_ticket_hash,
    ticketRes1.activationTicket,
  );
  assert.match(dbSession.activation_ticket_hash, /^[0-9a-f]{64}$/);

  // 4. Re-issue ticket invalidates previous ticket
  const ticketRes2 = await context.coordinator.issueAuthActivationTicket(
    scope,
    proof,
    binding1.sessionId,
  );
  assert.notEqual(ticketRes2.activationTicket, ticketRes1.activationTicket);

  // Activating with old ticket fails
  await assert.rejects(
    () =>
      context.coordinator.activateAuthSession(
        scope,
        proof,
        binding1.sessionId,
        ticketRes1.activationTicket,
      ),
    (err) => err.code === 'FORBIDDEN',
  );

  // 5. Activate with new ticket succeeds
  const activated = await context.coordinator.activateAuthSession(
    scope,
    proof,
    binding1.sessionId,
    ticketRes2.activationTicket,
  );
  assert.equal(activated.status, 'active');

  const activeInDb = (
    await admin('SELECT * FROM auth_execution_sessions WHERE id = $1', [
      binding1.sessionId,
    ])
  ).rows[0];
  assert.equal(activeInDb.status, 'active');
  assert.equal(activeInDb.activation_ticket_hash, null);
  assert.ok(activeInDb.activated_at);

  // 6. Activating again on already active session fails (VERSION_CONFLICT)
  await assert.rejects(
    () =>
      context.coordinator.activateAuthSession(
        scope,
        proof,
        binding1.sessionId,
        ticketRes2.activationTicket,
      ),
    (err) => err.code === 'VERSION_CONFLICT',
  );

  // Allocating again on already active session fails (VERSION_CONFLICT)
  await assert.rejects(
    () => context.coordinator.allocateAuthSession(scope, proof),
    (err) => err.code === 'VERSION_CONFLICT',
  );

  // Re-issuing ticket on active session fails (VERSION_CONFLICT)
  await assert.rejects(
    () =>
      context.coordinator.issueAuthActivationTicket(
        scope,
        proof,
        binding1.sessionId,
      ),
    (err) => err.code === 'VERSION_CONFLICT',
  );

  // 7. Query active session
  const queried = await context.coordinator.authSession(
    scope,
    proof,
    binding1.sessionId,
  );
  assert.equal(queried.status, 'active');
  assert.equal(queried.sessionId, binding1.sessionId);

  // 8. End session
  const ended = await context.coordinator.endAuthSession(
    scope,
    proof,
    binding1.sessionId,
    'test_ended',
  );
  assert.equal(ended.status, 'ended');

  // Verify DB state
  const endedInDb = (
    await admin('SELECT * FROM auth_execution_sessions WHERE id = $1', [
      binding1.sessionId,
    ])
  ).rows[0];
  assert.equal(endedInDb.status, 'ended');
  assert.equal(endedInDb.end_reason, 'test_ended');
  assert.ok(endedInDb.ended_at);

  // Ending again is idempotent
  const endedAgain = await context.coordinator.endAuthSession(
    scope,
    proof,
    binding1.sessionId,
    'test_ended',
  );
  assert.equal(endedAgain.status, 'ended');
});

test('Task summary check: non-auth tasks cannot allocate auth session (POLICY_DENIED)', async () => {
  const { run } = await createRunWithProfile('form');
  const { scope, proof } = await claimAuthTask(run);

  // Set task summary to 'explore'
  await admin(
    "UPDATE jobs SET document = jsonb_set(document, '{summary}', '\"explore\"') WHERE id = $1",
    [proof.taskId],
  );

  await assert.rejects(
    () => context.coordinator.allocateAuthSession(scope, proof),
    (err) => err.code === 'POLICY_DENIED',
  );
});

test('Anonymous mode=none policy produces zero rows and zero allocation (POLICY_DENIED)', async () => {
  const { run } = await createRunWithProfile('none');
  const { scope, proof } = await claimAuthTask(run);

  await assert.rejects(
    () => context.coordinator.allocateAuthSession(scope, proof),
    (err) => err.code === 'POLICY_DENIED',
  );

  // Verify zero rows in run_auth_scopes and auth_execution_sessions
  const scopesCount = (
    await admin(
      'SELECT count(*)::int AS n FROM run_auth_scopes WHERE run_id = $1',
      [run.id],
    )
  ).rows[0].n;
  const sessionsCount = (
    await admin(
      'SELECT count(*)::int AS n FROM auth_execution_sessions WHERE run_id = $1',
      [run.id],
    )
  ).rows[0].n;
  assert.equal(scopesCount, 0);
  assert.equal(sessionsCount, 0);
});

test('Revoked auth profile blocks allocation and all session operations (AUTH_FAILED)', async () => {
  const { run, profileId } = await createRunWithProfile('form');
  const { scope, proof } = await claimAuthTask(run);

  // Allocate first while active
  const binding = await context.coordinator.allocateAuthSession(scope, proof);
  const ticket = (
    await context.coordinator.issueAuthActivationTicket(
      scope,
      proof,
      binding.sessionId,
    )
  ).activationTicket;

  // Revoke profile in database using official ConfigurationRepository
  await context.configRepo.updateAuthProfile(actor, project.id, profileId, {
    expectedVersion: 1,
    revoke: true,
  });

  // Activation fails
  await assert.rejects(
    () =>
      context.coordinator.activateAuthSession(
        scope,
        proof,
        binding.sessionId,
        ticket,
      ),
    (err) => err.code === 'AUTH_FAILED',
  );

  // Query fails
  await assert.rejects(
    () => context.coordinator.authSession(scope, proof, binding.sessionId),
    (err) => err.code === 'AUTH_FAILED',
  );

  // Re-allocating on same task fails
  await assert.rejects(
    () => context.coordinator.allocateAuthSession(scope, proof),
    (err) => err.code === 'AUTH_FAILED',
  );
});

test('Revoked auth scope blocks all session operations (AUTH_FAILED)', async () => {
  const { run } = await createRunWithProfile('form');
  const { scope, proof } = await claimAuthTask(run);

  const binding = await context.coordinator.allocateAuthSession(scope, proof);
  const ticket = (
    await context.coordinator.issueAuthActivationTicket(
      scope,
      proof,
      binding.sessionId,
    )
  ).activationTicket;

  // Revoke run auth scope
  await admin(
    "UPDATE run_auth_scopes SET status = 'revoked' WHERE run_id = $1",
    [run.id],
  );

  await assert.rejects(
    () =>
      context.coordinator.activateAuthSession(
        scope,
        proof,
        binding.sessionId,
        ticket,
      ),
    (err) => err.code === 'AUTH_FAILED',
  );

  await assert.rejects(
    () => context.coordinator.authSession(scope, proof, binding.sessionId),
    (err) => err.code === 'AUTH_FAILED',
  );
});

test('Strict proof verification: wrong workerId, fencingToken, contextVersion, or expired lease reject (LEASE_EXPIRED)', async () => {
  const { run } = await createRunWithProfile('form');
  const { scope, proof } = await claimAuthTask(run);

  const binding = await context.coordinator.allocateAuthSession(scope, proof);

  // Wrong workerId
  const wrongScope = { ...scope, workerId: 'imposter-worker' };
  await assert.rejects(
    () => context.coordinator.authSession(wrongScope, proof, binding.sessionId),
    (err) => err.code === 'LEASE_EXPIRED',
  );

  // Wrong fencingToken
  const wrongProofFence = { ...proof, fencingToken: proof.fencingToken + 1 };
  await assert.rejects(
    () =>
      context.coordinator.authSession(
        scope,
        wrongProofFence,
        binding.sessionId,
      ),
    (err) => err.code === 'LEASE_EXPIRED',
  );

  // Wrong contextVersion
  const wrongProofContext = {
    ...proof,
    contextVersion: proof.contextVersion + 1,
  };
  await assert.rejects(
    () =>
      context.coordinator.authSession(
        scope,
        wrongProofContext,
        binding.sessionId,
      ),
    (err) => err.code === 'LEASE_EXPIRED',
  );

  // Expired lease
  await admin(
    "UPDATE jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1",
    [proof.taskId],
  );
  await admin(
    "UPDATE task_leases SET lease_until = clock_timestamp() - interval '1 second' WHERE task_id = $1",
    [proof.taskId],
  );

  await assert.rejects(
    () => context.coordinator.authSession(scope, proof, binding.sessionId),
    (err) => err.code === 'LEASE_EXPIRED',
  );
});

test('Concurrent allocateAuthSession on the same task+fencing yields exactly one session row', async () => {
  const { run } = await createRunWithProfile('form');
  const { scope, proof } = await claimAuthTask(run);

  // Run 5 concurrent allocations
  const results = await Promise.all([
    context.coordinator.allocateAuthSession(scope, proof),
    context.coordinator.allocateAuthSession(scope, proof),
    context.coordinator.allocateAuthSession(scope, proof),
    context.coordinator.allocateAuthSession(scope, proof),
    context.coordinator.allocateAuthSession(scope, proof),
  ]);

  // All 5 returned the exact same session ID
  const sessionIds = new Set(results.map((r) => r.sessionId));
  assert.equal(sessionIds.size, 1);

  // Exactly 1 row in auth_execution_sessions
  const count = (
    await admin(
      'SELECT count(*)::int AS n FROM auth_execution_sessions WHERE task_id = $1',
      [proof.taskId],
    )
  ).rows[0].n;
  assert.equal(count, 1);
});

test('Root: wrong lease token cannot allocate an authority row', async () => {
  const { run } = await createRunWithProfile();
  const { scope, proof } = await claimAuthTask(run);
  await assert.rejects(
    context.coordinator.allocateAuthSession(scope, {
      ...proof,
      leaseToken: 'OwnedInvalidToken',
    }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.equal(
    (
      await admin(
        'SELECT count(*)::integer AS n FROM auth_execution_sessions WHERE run_id=$1',
        [run.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await admin(
        'SELECT count(*)::integer AS n FROM run_auth_scopes WHERE run_id=$1',
        [run.id],
      )
    ).rows[0].n,
    0,
  );
});

test('Root: expired session cannot return an active authority binding under a still-live lease', async () => {
  const { run } = await createRunWithProfile();
  const { scope, proof } = await claimAuthTask(run);
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
  await admin(
    "UPDATE auth_execution_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [binding.sessionId],
  );
  await assert.rejects(
    context.coordinator.authSession(scope, proof, binding.sessionId),
    (error) => error.code === 'LEASE_EXPIRED',
  );
});

test('Root: lease expiring while profile lock is held cannot commit a new session', async () => {
  const { run, profileId } = await createRunWithProfile();
  const { scope, proof } = await claimAuthTask(run);
  await admin(
    "UPDATE jobs SET lease_until=clock_timestamp()+interval '600 milliseconds' WHERE id=$1",
    [proof.taskId],
  );
  await admin(
    'UPDATE task_leases SET lease_until=(SELECT lease_until FROM jobs WHERE id=$1) WHERE task_id=$1 AND fencing_token=$2',
    [proof.taskId, proof.fencingToken],
  );
  const blocker = new pg.Client({ connectionString: pgConnection });
  await blocker.connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM auth_profiles WHERE id=$1 FOR UPDATE', [
      profileId,
    ]);
    pending = context.coordinator.allocateAuthSession(scope, proof).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let observed = false;
    for (let i = 0; i < 10; i++) {
      const locks = await admin(
        "SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR SHARE OF p%'",
      );
      if (locks.rows[0].n > 0) {
        observed = true;
        break;
      }
      await delay(20);
    }
    assert.equal(
      observed,
      true,
      'Owned concurrency fixture reached the actual profile row lock',
    );
    await delay(750);
    await blocker.query('COMMIT');
    const result = await pending;
    assert.equal(
      result.error?.code,
      'LEASE_EXPIRED',
      'No successful binding after expiry while waiting on a PG lock',
    );
    assert.equal(
      (
        await admin(
          'SELECT count(*)::integer n FROM auth_execution_sessions WHERE run_id=$1',
          [run.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await admin(
          'SELECT count(*)::integer n FROM run_auth_scopes WHERE run_id=$1',
          [run.id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    await blocker.end();
    if (pending) await pending;
  }
});
