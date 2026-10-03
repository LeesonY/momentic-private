import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseContract } from '@localqa/contracts';
import {
  Database,
  AccountsRepository,
  ProjectRepository,
  ConfigurationRepository,
  ModelRepository,
  SecretRepository,
  RunRepository,
  LeaseRepository,
  SecretVault,
  hashPassword,
  verifyPassword,
  hashToken,
  hashPayload,
  StorageError,
  CAPABILITIES,
  claimTask,
  authorize,
  criteriaHash,
  attemptDTO,
} from '../dist/index.js';

const connection = process.env.LOCALQA_TEST_DATABASE_URL;
if (!connection)
  throw new Error(
    'Real PostgreSQL URL required; run pnpm --filter @localqa/storage test',
  );
const pool = new pg.Pool({ connectionString: connection, max: 8 });
const db = new Database(connection),
  accounts = new AccountsRepository(db),
  projects = new ProjectRepository(db),
  leases = new LeaseRepository(db);
let vault,
  nextVault,
  config,
  models,
  secrets,
  runs,
  admin,
  owner,
  operator,
  viewer,
  outsider,
  p1,
  p2,
  model,
  run,
  task,
  lease,
  definition,
  environment,
  auth;
const actor = (user) => ({ userId: user.id });
const worker = {
  workerId: 't02-worker-a',
  get projectId() {
    return p1.id;
  },
};
const scopeB = {
  workerId: 't02-worker-b',
  get projectId() {
    return p1.id;
  },
};
const proof = () => ({
  taskId: lease.task.id,
  fencingToken: lease.fencingToken,
  leaseToken: lease.leaseToken,
  contextVersion: lease.contextVersion,
});
const expectCode = (promise, code) =>
  assert.rejects(
    promise,
    (error) => error instanceof StorageError && error.code === code,
  );
const sqlReject = (sql, params, code) =>
  assert.rejects(pool.query(sql, params), (error) => error.code === code);
const hash = hashPayload;
function newRun(projectId = p1.id, extra = {}) {
  const example = JSON.parse(
    readFileSync(
      new URL('../../../docs/examples/report.sample.json', import.meta.url),
      'utf8',
    ),
  ).run;
  return parseContract('Run', {
    ...example,
    id: randomUUID(),
    projectId,
    creatorId: operator.id,
    status: 'queued',
    phase: 'preflight',
    completion: 'none',
    terminationReason: null,
    version: 1,
    contextVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budgetUsed: {
      activeSeconds: 0,
      actions: 0,
      modelCalls: 0,
      reproductions: 0,
      totalTokens: 0,
    },
    effectiveConfig: {
      ...example.effectiveConfig,
      models: Object.fromEntries(
        Object.keys(example.effectiveConfig.models).map((role) => [
          role,
          { profileId: model.id, version: 1 },
        ]),
      ),
      environmentVersion: null,
      authProfileVersion: null,
    },
    ...extra,
  });
}
before(async () => {
  vault = await SecretVault.fromProtectedFile(process.env.LOCALQA_TEST_KEK);
  nextVault = await SecretVault.fromProtectedFile(
    process.env.LOCALQA_TEST_NEXT_KEK,
  );
  config = new ConfigurationRepository(db, vault);
  models = new ModelRepository(db, vault);
  secrets = new SecretRepository(db, vault);
  runs = new RunRepository(db, vault);
  admin = await accounts.bootstrap({
    email: 'admin@t02.test',
    displayName: 'Admin',
    password: 'Test-only-admin-password',
  });
  owner = await accounts.create(actor(admin), {
    email: 'owner@t02.test',
    displayName: 'Owner',
    password: 'Test-only-owner-password',
  });
  operator = await accounts.create(actor(admin), {
    email: 'operator@t02.test',
    displayName: 'Operator',
    password: 'Test-only-operator-password',
  });
  viewer = await accounts.create(actor(admin), {
    email: 'viewer@t02.test',
    displayName: 'Viewer',
    password: 'Test-only-viewer-password',
  });
  outsider = await accounts.create(actor(admin), {
    email: 'outside@t02.test',
    displayName: 'Outside',
    password: 'Test-only-outside-password',
  });
  p1 = await projects.create(actor(admin), { name: 'T02 first' });
  p2 = await projects.create(actor(admin), { name: 'T02 isolated' });
  await projects.replaceMembers(actor(admin), p1.id, {
    expectedVersion: 1,
    members: [
      { userId: owner.id, role: 'owner' },
      { userId: operator.id, role: 'operator' },
      { userId: viewer.id, role: 'viewer' },
    ],
  });
  model = await models.create(actor(admin), {
    name: 'T02 model',
    endpoint: 'https://model.example.test/v1',
    configuredModelId: 'test-only-model',
    adapter: 'openai_compatible',
    dataBoundary: 'external',
    apiKey: 'model-key-test-only',
  });
  await models.grant(actor(admin), p1.id, model.id);
  await models.grant(actor(admin), p2.id, model.id);
  run = newRun();
  task = parseContract('Task', {
    id: randomUUID(),
    runId: run.id,
    role: 'coordinator',
    status: 'queued',
    caseId: null,
    attempt: 1,
    summary: 'T02 prepare',
    elapsedSeconds: 0,
  });
  await runs.create(actor(operator), run, [task]);
  run = await runs.transition(actor(operator), p1.id, run.id, 1, 'running');
});
after(async () => {
  vault?.dispose();
  nextVault?.dispose();
  await db.close();
  await pool.end();
});

test('PostgreSQL 18 and all explicit migrations applied; no ORM schema sync', async () => {
  const version = (await pool.query('SHOW server_version')).rows[0]
    .server_version;
  assert(version.startsWith('18.'));
  const migrations = (
    await pool.query('SELECT name,sha256 FROM storage_migrations ORDER BY name')
  ).rows;
  assert.equal(migrations.length, 5);
  console.log(JSON.stringify({ postgresVersion: version, migrations }));
  const required = [
    'users',
    'login_sessions',
    'projects',
    'project_members',
    'environments',
    'environment_versions',
    'auth_profiles',
    'auth_profile_versions',
    'secrets',
    'secret_versions',
    'knowledge',
    'knowledge_versions',
    'model_profiles',
    'model_profile_versions',
    'runs',
    'run_budgets',
    'budget_reservations',
    'jobs',
    'task_leases',
    'run_cases',
    'case_attempts',
    'verdicts',
    'steps',
    'action_intents',
    'findings',
    'reproductions',
    'artifacts',
    'exports',
    'input_requests',
    'run_messages',
    'audit_log',
    'run_events',
  ];
  const tables = (
    await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    )
  ).rows.map((row) => row.tablename);
  for (const table of required) assert(tables.includes(table), table);
});
test('AES-256-GCM roundtrip, random nonce, AAD/auth tag tamper rejection and keyVersion rotation', () => {
  const binding = { projectId: p1.id, secretId: randomUUID(), purpose: 'test' },
    plaintext = 'T02-secret-not-in-dto';
  const encrypted = vault.encrypt(plaintext, binding),
    second = vault.encrypt(plaintext, binding);
  assert.equal(vault.decrypt(encrypted, binding), plaintext);
  assert.notDeepEqual(encrypted.nonce, second.nonce);
  assert(!encrypted.ciphertext.includes(Buffer.from(plaintext)));
  assert.throws(() =>
    vault.decrypt(encrypted, { ...binding, projectId: p2.id }),
  );
  const corrupted = { ...encrypted, authTag: Buffer.from(encrypted.authTag) };
  corrupted.authTag[0] ^= 1;
  assert.throws(() => vault.decrypt(corrupted, binding));
  const rotated = nextVault.rotate(encrypted, binding);
  assert.equal(rotated.keyVersion, 2);
  assert.equal(nextVault.decrypt(rotated, binding), plaintext);
  assert.throws(() => vault.decrypt(rotated, binding));
  console.log(
    JSON.stringify({
      vaultAlgorithm: 'AES-256-GCM',
      nonceBytes: encrypted.nonce.length,
      authTagBytes: encrypted.authTag.length,
      rotation: [encrypted.keyVersion, rotated.keyVersion],
    }),
  );
});
test('protected KEK permissions and symlink rejection', async () => {
  const dir = new URL('../.evidence/', import.meta.url),
    unsafe = new URL('unsafe-kek.json', dir),
    link = new URL('symlink-kek.json', dir);
  writeFileSync(unsafe, readFileSync(process.env.LOCALQA_TEST_KEK), {
    mode: 0o644,
  });
  chmodSync(unsafe, 0o644);
  await assert.rejects(SecretVault.fromProtectedFile(fileURLToPath(unsafe)));
  symlinkSync(process.env.LOCALQA_TEST_KEK, link);
  await assert.rejects(SecretVault.fromProtectedFile(fileURLToPath(link)));
});
test('strong scrypt hash uses random salt and no plaintext', async () => {
  const a = await hashPassword('test-only-password'),
    b = await hashPassword('test-only-password');
  assert(a.startsWith('scrypt$131072$8$1$'));
  assert.notEqual(a, b);
  assert(!a.includes('test-only-password'));
  assert(await verifyPassword('test-only-password', a));
  assert.equal(await verifyPassword('wrong', a), false);
  assert.equal(
    await verifyPassword('wrong', 'scrypt$999999999$8$1$x$y'),
    false,
  );
});
test('bootstrap is one-shot; email uniqueness and non-admin account management', async () => {
  await expectCode(
    accounts.bootstrap({
      email: 'another@t02.test',
      displayName: 'Other',
      password: 'Test-only-admin-password',
    }),
    'VERSION_CONFLICT',
  );
  await expectCode(
    accounts.create(actor(admin), {
      email: 'OWNER@t02.test',
      displayName: 'Duplicate',
      password: 'Test-only-owner-password',
    }),
    'IDEMPOTENCY_CONFLICT',
  );
  await expectCode(
    accounts.create(actor(operator), {
      email: 'blocked@t02.test',
      displayName: 'Blocked',
      password: 'Test-only-owner-password',
    }),
    'FORBIDDEN',
  );
  assert.equal((await accounts.list(actor(admin))).length, 5);
  assert(
    !JSON.stringify(await accounts.list(actor(admin))).includes('password'),
  );
});
test('sessions store only token hash; logout, expiry, wrong password and disabled account', async () => {
  const login = await accounts.login({
    email: 'viewer@t02.test',
    password: 'Test-only-viewer-password',
  });
  assert.equal((await accounts.authenticate(login.token)).id, viewer.id);
  const stored = (
    await pool.query('SELECT token_hash FROM login_sessions WHERE user_id=$1', [
      viewer.id,
    ])
  ).rows[0];
  assert.equal(stored.token_hash, hashToken(login.token));
  assert.notEqual(stored.token_hash, login.token);
  await accounts.logout(login.token);
  await expectCode(accounts.authenticate(login.token), 'UNAUTHENTICATED');
  const expired = await accounts.login({
    email: 'viewer@t02.test',
    password: 'Test-only-viewer-password',
  });
  await pool.query(
    "UPDATE login_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
    [hashToken(expired.token)],
  );
  await expectCode(accounts.authenticate(expired.token), 'UNAUTHENTICATED');
  await expectCode(
    accounts.login({
      email: 'viewer@t02.test',
      password: 'incorrect-password',
    }),
    'UNAUTHENTICATED',
  );
  const active = await accounts.login({
    email: 'outside@t02.test',
    password: 'Test-only-outside-password',
  });
  outsider = await accounts.update(actor(admin), outsider.id, {
    expectedVersion: 1,
    disabled: true,
  });
  await expectCode(accounts.authenticate(active.token), 'UNAUTHENTICATED');
});
test('permissions matrix, forced RLS and cross-project NOT_FOUND', async () => {
  assert.deepEqual(CAPABILITIES.viewer, ['read']);
  assert(CAPABILITIES.operator.includes('run'));
  assert(CAPABILITIES.owner.includes('config.write'));
  assert(CAPABILITIES.admin.includes('admin'));
  for (const user of [owner, operator, viewer])
    assert.equal((await projects.get(actor(user), p1.id)).id, p1.id);
  await expectCode(projects.get(actor(viewer), p2.id), 'NOT_FOUND');
  await expectCode(runs.get(actor(viewer), p2.id, run.id), 'NOT_FOUND');
  const all = await db.actor(
    actor(viewer),
    async (client) => (await client.query('SELECT id FROM projects')).rows,
  );
  assert.deepEqual(
    all.map((row) => row.id),
    [p1.id],
  );
  await expectCode(
    db.actor(actor(viewer), (client) => authorize(client, p1.id, 'run')),
    'FORBIDDEN',
  );
  await expectCode(
    db.actor(actor(viewer), (client) => authorize(client, p2.id, 'run')),
    'NOT_FOUND',
  );
  const forced = (
    await pool.query(
      "SELECT relname FROM pg_class WHERE relname IN ('runs','jobs','secrets','run_events') AND relrowsecurity AND relforcerowsecurity",
    )
  ).rows;
  assert.equal(forced.length, 4);
});
test('environment immutable version snapshots, expectedVersion conflict and composite default-auth FK', async () => {
  environment = await config.createEnvironment(actor(owner), p1.id, {
    name: 'Fixture reference only',
    baseUrl: 'https://fixture.example.test/',
    allowedOrigins: ['https://fixture.example.test'],
    tlsPolicy: 'strict',
  });
  const updated = await config.updateEnvironment(
    actor(owner),
    p1.id,
    environment.id,
    { expectedVersion: 1, name: 'Version 2' },
  );
  assert.equal(updated.version, 2);
  await expectCode(
    config.updateEnvironment(actor(owner), p1.id, environment.id, {
      expectedVersion: 1,
      name: 'Lost update',
    }),
    'VERSION_CONFLICT',
  );
  await expectCode(
    config.updateEnvironment(actor(viewer), p1.id, environment.id, {
      expectedVersion: 2,
      name: 'Blocked',
    }),
    'FORBIDDEN',
  );
  await expectCode(
    config.updateEnvironment(actor(viewer), p1.id, randomUUID(), {
      expectedVersion: 1,
      name: 'Hidden',
    }),
    'NOT_FOUND',
  );
  const original = (
    await pool.query(
      'SELECT document FROM environment_versions WHERE environment_id=$1 AND version=1',
      [environment.id],
    )
  ).rows[0].document;
  assert.equal(original.name, environment.name);
  await sqlReject(
    'UPDATE environment_versions SET document=document WHERE environment_id=$1',
    [environment.id],
    '23514',
  );
  await sqlReject(
    'INSERT INTO environment_versions(project_id,environment_id,version,document) VALUES($1,$2,9,$3)',
    [p2.id, environment.id, { ...environment, projectId: p2.id, version: 9 }],
    '23503',
  );
});
test('auth write-only materials encrypted; origin validation, rotation and metadata-only DTO', async () => {
  auth = await config.createAuthProfile(actor(owner), p1.id, {
    name: 'Test storage state',
    mode: 'storage_state',
    allowedOrigins: ['https://fixture.example.test'],
    secretInput: { storageState: JSON.stringify({ cookies: [], origins: [] }) },
  });
  assert(auth.hasSecret);
  assert(!JSON.stringify(auth).includes('secretInput'));
  assert(!JSON.stringify(auth).includes('storageState'));
  const snapshot = (
    await pool.query(
      'SELECT document FROM auth_profile_versions WHERE auth_profile_id=$1',
      [auth.id],
    )
  ).rows[0].document;
  assert.deepEqual(snapshot, auth);
  await expectCode(
    config.createAuthProfile(actor(owner), p1.id, {
      name: 'Bad origin',
      mode: 'storage_state',
      allowedOrigins: ['https://fixture.example.test'],
      secretInput: {
        storageState: JSON.stringify({
          cookies: [],
          origins: [{ origin: 'https://evil.example.test' }],
        }),
      },
    }),
    'TARGET_NOT_ALLOWED',
  );
  const secret = await secrets.create(
    actor(owner),
    p1.id,
    'T02 key',
    'auth',
    'plaintext-only-in-vault',
  );
  assert(!JSON.stringify(secret).includes('plaintext'));
  const encrypted = (
    await pool.query(
      'SELECT ciphertext,key_version FROM secret_versions WHERE secret_id=$1',
      [secret.id],
    )
  ).rows[0];
  assert(
    !encrypted.ciphertext.includes(Buffer.from('plaintext-only-in-vault')),
  );
  const rotated = await secrets.rotate(
    actor(owner),
    p1.id,
    secret.id,
    1,
    nextVault,
  );
  assert.equal(rotated.version, 2);
  assert.equal(
    (
      await pool.query(
        'SELECT key_version FROM secret_versions WHERE secret_id=$1 AND version=2',
        [secret.id],
      )
    ).rows[0].key_version,
    2,
  );
  assert.deepEqual(
    await secrets.metadata(actor(viewer), p1.id, secret.id),
    rotated,
  );
  await expectCode(
    secrets.metadata(actor(viewer), p2.id, secret.id),
    'NOT_FOUND',
  );
  const noCipher = await db.actor(
    actor(viewer),
    async (client) =>
      (await client.query('SELECT * FROM secret_versions')).rowCount,
  );
  assert.equal(noCipher, 0);
  await expectCode(
    secrets.rotate(actor(owner), p1.id, secret.id, 1, nextVault),
    'VERSION_CONFLICT',
  );
});
test('knowledge versions and owner-only approval', async () => {
  const knowledge = await config.createKnowledge(actor(operator), p1.id, {
    title: 'Rule',
    kind: 'rule',
    text: 'User-supplied rule',
  });
  assert.equal(knowledge.approved, false);
  await expectCode(
    config.updateKnowledge(actor(operator), p1.id, knowledge.id, {
      expectedVersion: 1,
      approved: true,
    }),
    'FORBIDDEN',
  );
  const approved = await config.updateKnowledge(
    actor(owner),
    p1.id,
    knowledge.id,
    { expectedVersion: 1, approved: true },
  );
  assert(approved.approved);
  assert.equal(approved.version, 2);
  const changed = await config.updateKnowledge(
    actor(operator),
    p1.id,
    knowledge.id,
    { expectedVersion: 2, text: 'Changed rule' },
  );
  assert.equal(changed.approved, false);
  await expectCode(
    config.get(actor(viewer), 'Knowledge', p2.id, knowledge.id),
    'NOT_FOUND',
  );
});
test('global model descriptor access is granted per project; API key never returned', async () => {
  assert(!JSON.stringify(model).includes('model-key-test-only'));
  assert.equal((await models.get(actor(viewer), model.id)).id, model.id);
  const updated = await models.update(actor(admin), model.id, {
    expectedVersion: 1,
    name: 'V2',
  });
  assert.equal(updated.version, 2);
  await expectCode(
    models.update(actor(admin), model.id, {
      expectedVersion: 1,
      name: 'Stale',
    }),
    'VERSION_CONFLICT',
  );
  await expectCode(
    models.update(actor(viewer), model.id, { expectedVersion: 2, name: 'Bad' }),
    'FORBIDDEN',
  );
  await expectCode(
    models.create(actor(admin), {
      name: 'Bad',
      endpoint: 'http://external.example.test',
      configuredModelId: 'test',
      adapter: 'openai_compatible',
      dataBoundary: 'external',
    }),
    'TARGET_NOT_ALLOWED',
  );
  assert.equal(
    (
      await pool.query(
        'SELECT document FROM model_profile_versions WHERE profile_id=$1 AND version=1',
        [model.id],
      )
    ).rows[0].document.name,
    'T02 model',
  );
});
test('Run+Job+initial event transaction; raw URL query is encrypted and absent from DTO/events', async () => {
  const secretRun = newRun(p1.id, {
    targetUrl: 'https://fixture.example.test/path?token=test-sensitive-url',
  });
  const returned = await runs.create(actor(operator), secretRun);
  assert(!returned.targetUrl.includes('?'));
  assert(
    !JSON.stringify(
      await runs.events(actor(viewer), p1.id, secretRun.id),
    ).includes('test-sensitive-url'),
  );
  const row = (
    await pool.query(
      'SELECT raw_url_secret_id,display_url FROM runs WHERE id=$1',
      [secretRun.id],
    )
  ).rows[0];
  assert(row.raw_url_secret_id);
  assert(!row.display_url.includes('test-sensitive-url'));
  const before = (await pool.query('SELECT count(*) FROM runs')).rows[0].count;
  const badTask = { ...task, id: randomUUID(), runId: randomUUID() };
  await expectCode(
    runs.create(actor(operator), newRun(), [badTask]),
    'VALIDATION_ERROR',
  );
  assert.equal(
    (await pool.query('SELECT count(*) FROM runs')).rows[0].count,
    before,
  );
});
test('duplicate jobs unique_key and cross-project composite FK are rejected by PostgreSQL', async () => {
  await sqlReject(
    "INSERT INTO jobs(id,project_id,run_id,unique_key,role,document) VALUES($1,$2,$3,$4,'coordinator',$5)",
    [randomUUID(), p1.id, run.id, `${run.id}:coordinator:prepare:1`, task],
    '23505',
  );
  await sqlReject(
    "INSERT INTO jobs(id,project_id,run_id,unique_key,role,document) VALUES($1,$2,$3,$4,'coordinator',$5)",
    [randomUUID(), p2.id, run.id, randomUUID(), task],
    '23503',
  );
});
test('SKIP LOCKED: two simultaneous workers, only one claims same task', async () => {
  let unlock, signal;
  const barrier = new Promise((resolve) => (signal = resolve)),
    hold = new Promise((resolve) => (unlock = resolve));
  const a = db.worker(worker, async (client) => {
    const result = await claimTask(client, worker);
    signal();
    await hold;
    return result;
  });
  await barrier;
  const b = await leases.claim(scopeB);
  assert.equal(b, null);
  unlock();
  lease = await a;
  assert(lease);
  assert.equal(lease.task.id, task.id);
  assert.equal(lease.fencingToken, 1);
  const stored = (
    await pool.query('SELECT worker_id,fencing_token FROM jobs WHERE id=$1', [
      task.id,
    ])
  ).rows[0];
  assert.equal(stored.worker_id, worker.workerId);
  assert.equal(Number(stored.fencing_token), 1);
  console.log(
    JSON.stringify({
      scenario: 'two concurrent transactions with held row lock',
      workerAClaimed: 1,
      workerBClaimed: 0,
      fencingToken: lease.fencingToken,
    }),
  );
});
test('heartbeat checks token, worker, project and fencing; worker scope cannot see other projects', async () => {
  const response = await leases.heartbeat(worker, proof());
  assert.equal(response.cancelRequested, false);
  await expectCode(leases.heartbeat(scopeB, proof()), 'LEASE_EXPIRED');
  await expectCode(
    leases.heartbeat(worker, { ...proof(), leaseToken: 'invalid' }),
    'LEASE_EXPIRED',
  );
  await expectCode(
    leases.heartbeat(worker, { ...proof(), fencingToken: 0 }),
    'LEASE_EXPIRED',
  );
  const rows = await db.worker(
    worker,
    async (client) =>
      (await client.query('SELECT id FROM runs WHERE project_id=$1', [p2.id]))
        .rows,
  );
  assert.equal(rows.length, 0);
});
test('immutable case and config snapshots; context history retains old versions', async () => {
  definition = parseContract('CaseDefinition', {
    id: randomUUID(),
    runId: run.id,
    projectId: p1.id,
    version: 1,
    title: 'T02 immutable criterion',
    summary: 'Contract sample',
    preconditions: [],
    outline: ['Observe'],
    criteria: [
      {
        id: 'main',
        kind: 'semantic',
        description: 'Fixture visible',
        sourceKind: 'generic_smoke',
        sourceRef: 'smoke:v1',
      },
    ],
  });
  await runs.addCase(actor(operator), definition);
  await sqlReject(
    'UPDATE run_cases SET document=$2 WHERE id=$1',
    [definition.id, { ...definition, title: 'Mutation' }],
    '23514',
  );
  await sqlReject(
    'UPDATE runs SET effective_config=$2,version=version+1 WHERE id=$1',
    [run.id, { ...run.effectiveConfig, actionPolicy: 'approved_workflows' }],
    '23514',
  );
  await pool.query(
    'UPDATE runs SET effective_config=$2,context_version=context_version+1,version=version+1 WHERE id=$1',
    [run.id, { ...run.effectiveConfig, actionPolicy: 'approved_workflows' }],
  );
  const contexts = (
    await pool.query(
      'SELECT context_version,config FROM run_context_versions WHERE run_id=$1 ORDER BY context_version',
      [run.id],
    )
  ).rows;
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].config.actionPolicy, 'non_submitting');
  await expectCode(
    leases.complete(worker, proof(), {
      fencingToken: 1,
      status: 'succeeded',
      result: {},
      resultHash: 'a'.repeat(64),
    }),
    'SCOPE_CHANGED',
  );
  lease = { ...lease, contextVersion: 2 };
});
test('verdict unique attempt, stale fencing rejection and immutable history', async () => {
  const attemptId = randomUUID();
  await pool.query(
    "INSERT INTO case_attempts(id,project_id,run_id,case_id,task_id,attempt_number,status,context_id) VALUES($1,$2,$3,$4,$5,1,'running',$6)",
    [attemptId, p1.id, run.id, definition.id, task.id, randomUUID()],
  );
  const verdict = parseContract('Verdict', {
    id: randomUUID(),
    caseId: definition.id,
    attemptId,
    status: 'blocked',
    reasonCode: 'AUTH_REQUIRED',
    summary: 'T02 storage test',
    criterionResults: [
      {
        criterionId: 'main',
        result: 'not_evaluated',
        reason: 'Auth needed',
        evidenceRefs: [],
      },
    ],
    gaps: [],
    createdAt: new Date().toISOString(),
  });
  await sqlReject(
    'INSERT INTO verdicts(id,project_id,case_id,attempt_id,document,payload_hash,fencing_token) VALUES($1,$2,$3,$4,$5,$6,0)',
    [verdict.id, p1.id, definition.id, attemptId, verdict, hash(verdict)],
    'P0001',
  );
  await expectCode(
    leases.submitVerdict(worker, proof(), {
      ...verdict,
      status: 'passed',
      criterionResults: [
        {
          criterionId: 'main',
          result: 'unknown',
          reason: 'No evidence',
          evidenceRefs: [],
        },
      ],
    }),
    'VALIDATION_ERROR',
  );
  await leases.submitVerdict(worker, proof(), verdict, hash(verdict));
  assert.deepEqual(
    await leases.submitVerdict(worker, proof(), { ...verdict }),
    verdict,
  );
  const duplicate = { ...verdict, id: randomUUID() };
  await assert.rejects(
    pool.query(
      'INSERT INTO verdicts(id,project_id,case_id,attempt_id,document,payload_hash,fencing_token) VALUES($1,$2,$3,$4,$5,$6,1)',
      [
        duplicate.id,
        p1.id,
        definition.id,
        attemptId,
        duplicate,
        hash(duplicate),
      ],
    ),
    (error) =>
      error.code === '23505' && error.constraint === 'verdicts_attempt_id_key',
  );
  await sqlReject(
    'UPDATE verdicts SET valid=false WHERE id=$1',
    [verdict.id],
    '23514',
  );
  const summary = await runs.summary(actor(viewer), p1.id, run.id);
  assert.equal(summary.planned, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.passRate, null);
  assert.equal(summary.attemptRate, 1);
});
test('completion idempotency and terminal task guard', async () => {
  const input = {
    fencingToken: 1,
    status: 'succeeded',
    result: { ok: true },
    resultHash: hash({ ok: true }),
  };
  const completed = await leases.complete(worker, proof(), input);
  assert.equal(completed.status, 'succeeded');
  assert.equal((await leases.complete(worker, proof(), input)).id, task.id);
  await expectCode(
    leases.complete(worker, proof(), { ...input, resultHash: 'b'.repeat(64) }),
    'IDEMPOTENCY_CONFLICT',
  );
  await sqlReject(
    "UPDATE jobs SET status='running' WHERE id=$1",
    [task.id],
    '23514',
  );
});
test('a live lease whose run is no longer running is SCOPE_CHANGED', async () => {
  const r = newRun();
  const t = { ...task, id: randomUUID(), runId: r.id };
  await runs.create(actor(operator), r, [t]);
  await runs.transition(actor(operator), p1.id, r.id, 1, 'running');
  const claimed = await leases.claim(worker);
  assert.equal(claimed.task.id, t.id);
  const base = {
    taskId: t.id,
    fencingToken: claimed.fencingToken,
    leaseToken: claimed.leaseToken,
    contextVersion: claimed.contextVersion,
  };
  await pool.query(
    "UPDATE runs SET status='cancelled',version=version+1 WHERE id=$1",
    [r.id],
  );
  await expectCode(
    leases.complete(worker, base, {
      fencingToken: claimed.fencingToken,
      status: 'succeeded',
      result: {},
      resultHash: 'a'.repeat(64),
    }),
    'SCOPE_CHANGED',
  );
  const beat = await leases.heartbeat(worker, base);
  assert.equal(beat.cancelRequested, true);
  await pool.query(
    "UPDATE jobs SET status='interrupted',worker_id=NULL,lease_until=NULL WHERE id=$1",
    [t.id],
  );
});
test('expired lease_until stays LEASE_EXPIRED when the run context also changed', async () => {
  const r = newRun();
  const t = { ...task, id: randomUUID(), runId: r.id };
  await runs.create(actor(operator), r, [t]);
  await runs.transition(actor(operator), p1.id, r.id, 1, 'running');
  const claimed = await leases.claim(worker);
  assert.equal(claimed.task.id, t.id);
  const base = {
    taskId: t.id,
    fencingToken: claimed.fencingToken,
    leaseToken: claimed.leaseToken,
    contextVersion: claimed.contextVersion,
  };
  await pool.query(
    'UPDATE runs SET context_version=context_version+1,version=version+1 WHERE id=$1',
    [r.id],
  );
  await pool.query(
    "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [t.id],
  );
  await pool.query(
    "UPDATE task_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1 AND fencing_token=$2",
    [t.id, claimed.fencingToken],
  );
  await expectCode(leases.heartbeat(worker, base), 'LEASE_EXPIRED');
  await expectCode(
    leases.complete(worker, base, {
      fencingToken: claimed.fencingToken,
      status: 'succeeded',
      result: {},
      resultHash: 'a'.repeat(64),
    }),
    'LEASE_EXPIRED',
  );
  await pool.query(
    "UPDATE jobs SET status='interrupted',worker_id=NULL,lease_until=NULL WHERE id=$1",
    [t.id],
  );
});
test('expired actionless task requeues with fencing increment; old proof cannot heartbeat', async () => {
  const r = newRun();
  const t = { ...task, id: randomUUID(), runId: r.id };
  await runs.create(actor(operator), r, [t]);
  await runs.transition(actor(operator), p1.id, r.id, 1, 'running');
  const first = await leases.claim(worker);
  assert.equal(first.task.id, t.id);
  await pool.query(
    "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [t.id],
  );
  const recovered = await leases.recoverExpired(worker);
  assert.equal(recovered.requeued, 1);
  const second = await leases.claim(scopeB);
  assert.equal(second.fencingToken, 2);
  await expectCode(
    leases.heartbeat(worker, {
      taskId: t.id,
      fencingToken: 1,
      leaseToken: first.leaseToken,
      contextVersion: first.contextVersion,
    }),
    'LEASE_EXPIRED',
  );
});
test('unknown action is interrupted, not replayed; reservations conservatively charged', async () => {
  const r = newRun();
  const t = { ...task, id: randomUUID(), runId: r.id };
  await runs.create(actor(operator), r, [t]);
  await runs.transition(actor(operator), p1.id, r.id, 1, 'running');
  const claimed = await leases.claim(worker);
  assert.equal(claimed.task.id, t.id);
  const reservation = randomUUID();
  await pool.query(
    "INSERT INTO budget_reservations(id,project_id,run_id,task_id,request_id,fencing_token,kind,reserved,status) VALUES($1,$2,$3,$4,$5,1,'action','{\"actions\":1}','reserved')",
    [reservation, p1.id, r.id, t.id, randomUUID()],
  );
  await pool.query(
    'UPDATE run_budgets SET reserved=\'{"actions":1}\' WHERE run_id=$1',
    [r.id],
  );
  const action = randomUUID();
  await pool.query(
    'INSERT INTO action_intents(id,project_id,run_id,task_id,fencing_token,context_version,reservation_id,tool_call) VALUES($1,$2,$3,$4,1,1,$5,$6)',
    [action, p1.id, r.id, t.id, reservation, { name: 'observe', args: {} }],
  );
  await pool.query(
    "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [t.id],
  );
  const recovery = await leases.recoverExpired(worker);
  assert.equal(recovery.interrupted, 1);
  assert.equal(
    (
      await pool.query('SELECT outcome FROM action_intents WHERE id=$1', [
        action,
      ])
    ).rows[0].outcome,
    'unknown',
  );
  assert.equal(
    (await pool.query('SELECT status FROM jobs WHERE id=$1', [t.id])).rows[0]
      .status,
    'interrupted',
  );
  assert.equal(
    (
      await pool.query(
        'SELECT used,reserved FROM run_budgets WHERE run_id=$1',
        [r.id],
      )
    ).rows[0].used.actions,
    1,
  );
});
test('strict sequential events, same-project FK, rollback and sensitive payload keys', async () => {
  const counter = Number(
    (await pool.query('SELECT event_seq FROM runs WHERE id=$1', [run.id]))
      .rows[0].event_seq,
  );
  await sqlReject(
    "INSERT INTO run_events(project_id,run_id,seq,type,payload) VALUES($1,$2,$3,'x','{}')",
    [p1.id, run.id, counter + 2],
    '23514',
  );
  await sqlReject(
    'INSERT INTO run_events(project_id,run_id,seq,type,payload) VALUES($1,$2,$3,\'x\',\'{"password":"nope"}\')',
    [p1.id, run.id, counter + 1],
    '23514',
  );
  assert.equal(
    Number(
      (await pool.query('SELECT event_seq FROM runs WHERE id=$1', [run.id]))
        .rows[0].event_seq,
    ),
    counter,
  );
  const events = await runs.events(actor(viewer), p1.id, run.id);
  assert(events.every((event) => event.id === String(event.seq)));
  await expectCode(runs.events(actor(viewer), p2.id, run.id), 'NOT_FOUND');
});
test('terminal run regression and direct lost-update version mutation are rejected', async () => {
  const current = await runs.get(actor(operator), p1.id, run.id);
  await runs.transition(
    actor(operator),
    p1.id,
    run.id,
    current.version,
    'completed',
  );
  await sqlReject(
    "UPDATE runs SET status='running',version=version+1 WHERE id=$1",
    [run.id],
    '23514',
  );
  await sqlReject(
    "UPDATE projects SET name='bad' WHERE id=$1",
    [p1.id],
    'P0001',
  );
});
test('functional confirmation without independent reproduced evidence is rejected', async () => {
  const attempt = (
    await pool.query('SELECT id FROM case_attempts WHERE task_id=$1', [task.id])
  ).rows[0].id;
  const finding = parseContract('Finding', {
    id: randomUUID(),
    runId: run.id,
    caseIds: [definition.id],
    kind: 'functional',
    status: 'confirmed',
    title: 'T02 suspected sample',
    severity: 'low',
    expected: 'Main',
    actual: 'Absent',
    expectedSource: 'generic_smoke',
    reproSteps: ['Observe'],
    evidenceRefs: [randomUUID()],
    reproductionRef: randomUUID(),
    triageDisposition: 'open',
    version: 1,
  });
  await sqlReject(
    "INSERT INTO findings(id,project_id,run_id,case_id,original_attempt_id,criteria_hash,fingerprint,kind,status,expected_source,reproduction_id,document) VALUES($1,$2,$3,$4,$5,$6,'t02','functional','confirmed','generic_smoke',$7,$8)",
    [
      finding.id,
      p1.id,
      run.id,
      definition.id,
      attempt,
      criteriaHash(definition),
      finding.reproductionRef,
      finding,
    ],
    '23514',
  );
});
test('artifact retention, active run, held materials and references block GC; eligible delete succeeds', async () => {
  const sample = JSON.parse(
    readFileSync(
      new URL('../../../docs/examples/report.sample.json', import.meta.url),
      'utf8',
    ),
  ).artifacts[0];
  const insert = async (runId, held, retain) => {
    const artifact = {
      ...sample,
      id: randomUUID(),
      projectId: p1.id,
      runId,
      taskId: null,
      stepId: null,
      caseId: null,
      snapshotId: null,
    };
    await pool.query(
      'INSERT INTO artifacts(id,project_id,run_id,document,retain_until,held) VALUES($1,$2,$3,$4,$5,$6)',
      [artifact.id, p1.id, runId, artifact, retain, held],
    );
    return artifact.id;
  };
  const past = new Date(Date.now() - 1000),
    future = new Date(Date.now() + 86400000);
  const held = await insert(run.id, true, past),
    retained = await insert(run.id, false, future);
  await sqlReject('DELETE FROM artifacts WHERE id=$1', [held], '23514');
  await sqlReject('DELETE FROM artifacts WHERE id=$1', [retained], '23514');
  const activeRun = newRun();
  await runs.create(actor(operator), activeRun);
  const active = await insert(activeRun.id, false, past);
  await sqlReject('DELETE FROM artifacts WHERE id=$1', [active], '23514');
  const referenced = await insert(run.id, false, past);
  await pool.query(
    "INSERT INTO artifact_references(project_id,artifact_id,ref_kind,ref_id) VALUES($1,$2,'report',$3)",
    [p1.id, referenced, randomUUID()],
  );
  await sqlReject('DELETE FROM artifacts WHERE id=$1', [referenced], '23514');
  const eligible = await insert(run.id, false, past);
  assert.equal(
    (await pool.query('DELETE FROM artifacts WHERE id=$1', [eligible]))
      .rowCount,
    1,
  );
});
test('independent same-criteria reproduction with fresh context and owned evidence can confirm; weakened source cannot', async () => {
  const r = newRun();
  await runs.create(actor(operator), r);
  await runs.transition(actor(operator), p1.id, r.id, 1, 'running');
  const c = { ...definition, id: randomUUID(), runId: r.id };
  await runs.addCase(actor(operator), c);
  const insertJob = async (role) => {
    const t = { ...task, id: randomUUID(), runId: r.id, role, caseId: c.id };
    await pool.query(
      'INSERT INTO jobs(id,project_id,run_id,case_id,unique_key,role,document) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [t.id, p1.id, r.id, c.id, randomUUID(), role, t],
    );
    return t;
  };
  const execute = await insertJob('executor'),
    l1 = await leases.claim(worker);
  assert.equal(l1.task.id, execute.id);
  const ctx = randomUUID(),
    a1 = randomUUID();
  await pool.query(
    "INSERT INTO case_attempts(id,project_id,run_id,case_id,task_id,attempt_number,status,context_id) VALUES($1,$2,$3,$4,$5,1,'running',$6)",
    [a1, p1.id, r.id, c.id, execute.id, ctx],
  );
  const v1 = {
    id: randomUUID(),
    caseId: c.id,
    attemptId: a1,
    status: 'issue_found',
    reasonCode: 'CRITERION_FAILED',
    summary: 'Synthetic storage evidence',
    criterionResults: [
      {
        criterionId: 'main',
        result: 'failed',
        reason: 'Synthetic',
        evidenceRefs: [],
      },
    ],
    gaps: [],
    createdAt: new Date().toISOString(),
  };
  const p1proof = {
    taskId: execute.id,
    fencingToken: l1.fencingToken,
    leaseToken: l1.leaseToken,
    contextVersion: l1.contextVersion,
  };
  await leases.submitVerdict(worker, p1proof, v1);
  await leases.complete(worker, p1proof, {
    fencingToken: 1,
    status: 'succeeded',
    result: {},
    resultHash: hash({}),
  });
  const originalArtifact = randomUUID(),
    repeatedArtifact = randomUUID(),
    findingId = randomUUID(),
    reproductionId = randomUUID();
  const f = parseContract('Finding', {
    id: findingId,
    runId: r.id,
    caseIds: [c.id],
    kind: 'functional',
    status: 'suspected',
    title: 'Synthetic T02 finding',
    severity: 'low',
    expected: 'Main',
    actual: 'Absent',
    expectedSource: 'generic_smoke',
    reproSteps: ['Observe'],
    evidenceRefs: [originalArtifact],
    reproductionRef: null,
    triageDisposition: 'open',
    version: 1,
  });
  await pool.query(
    "INSERT INTO findings(id,project_id,run_id,case_id,original_attempt_id,criteria_hash,fingerprint,kind,status,expected_source,document) VALUES($1,$2,$3,$4,$5,$6,'t02-positive','functional','suspected','generic_smoke',$7)",
    [findingId, p1.id, r.id, c.id, a1, criteriaHash(c), f],
  );
  const reproduce = await insertJob('reproducer'),
    l2 = await leases.claim(worker);
  assert.equal(l2.task.id, reproduce.id);
  const wrong = randomUUID();
  await pool.query(
    "INSERT INTO case_attempts(id,project_id,run_id,case_id,task_id,attempt_number,status,context_id) VALUES($1,$2,$3,$4,$5,2,'running',$6)",
    [wrong, p1.id, r.id, c.id, reproduce.id, ctx],
  );
  const rep = {
    id: reproductionId,
    findingId,
    taskId: reproduce.id,
    outcome: 'reproduced',
    freshContext: true,
    summary: 'Synthetic fresh-context record',
    evidenceRefs: [repeatedArtifact],
    createdAt: new Date().toISOString(),
  };
  await sqlReject(
    "INSERT INTO reproductions(id,project_id,run_id,finding_id,task_id,attempt_id,criteria_hash,fresh_context,outcome,document) VALUES($1,$2,$3,$4,$5,$6,$7,true,'reproduced',$8)",
    [
      reproductionId,
      p1.id,
      r.id,
      findingId,
      reproduce.id,
      wrong,
      criteriaHash(c),
      rep,
    ],
    '23514',
  );
  const a2 = randomUUID();
  await pool.query(
    "INSERT INTO case_attempts(id,project_id,run_id,case_id,task_id,attempt_number,status,context_id) VALUES($1,$2,$3,$4,$5,3,'running',$6)",
    [a2, p1.id, r.id, c.id, reproduce.id, randomUUID()],
  );
  const p2proof = {
    taskId: reproduce.id,
    fencingToken: l2.fencingToken,
    leaseToken: l2.leaseToken,
    contextVersion: l2.contextVersion,
  };
  await leases.submitVerdict(worker, p2proof, {
    ...v1,
    id: randomUUID(),
    attemptId: a2,
  });
  await pool.query(
    "INSERT INTO reproductions(id,project_id,run_id,finding_id,task_id,attempt_id,criteria_hash,fresh_context,outcome,document) VALUES($1,$2,$3,$4,$5,$6,$7,true,'reproduced',$8)",
    [
      reproductionId,
      p1.id,
      r.id,
      findingId,
      reproduce.id,
      a2,
      criteriaHash(c),
      rep,
    ],
  );
  const example = JSON.parse(
    readFileSync(
      new URL('../../../docs/examples/report.sample.json', import.meta.url),
      'utf8',
    ),
  ).artifacts[0];
  for (const [id, taskId] of [
    [originalArtifact, execute.id],
    [repeatedArtifact, reproduce.id],
  ]) {
    const dto = {
      ...example,
      id,
      projectId: p1.id,
      runId: r.id,
      taskId,
      stepId: null,
      caseId: c.id,
      snapshotId: null,
    };
    await pool.query(
      "INSERT INTO artifacts(id,project_id,run_id,task_id,case_id,document,retain_until) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 day')",
      [id, p1.id, r.id, taskId, c.id, dto],
    );
  }
  await pool.query(
    'INSERT INTO finding_evidence(project_id,finding_id,artifact_id) VALUES($1,$2,$3)',
    [p1.id, findingId, originalArtifact],
  );
  await pool.query(
    'INSERT INTO reproduction_evidence(project_id,reproduction_id,artifact_id) VALUES($1,$2,$3)',
    [p1.id, reproductionId, repeatedArtifact],
  );
  const confirmed = {
    ...f,
    status: 'confirmed',
    reproductionRef: reproductionId,
    version: 2,
  };
  await pool.query(
    "UPDATE findings SET status='confirmed',reproduction_id=$2,version=version+1,document=$3 WHERE id=$1",
    [findingId, reproductionId, confirmed],
  );
  assert.equal(
    (await runs.resource(actor(viewer), 'Finding', p1.id, findingId)).status,
    'confirmed',
  );
  await sqlReject(
    "UPDATE findings SET expected_source='inferred',version=version+1,document=$2 WHERE id=$1",
    [findingId, { ...confirmed, expectedSource: 'inferred', version: 3 }],
    '23514',
  );
  await sqlReject(
    'DELETE FROM reproduction_evidence WHERE reproduction_id=$1',
    [reproductionId],
    '23514',
  );
  console.log(
    JSON.stringify({
      confirmation: 'passed storage relationship checks',
      evidence: 'synthetic metadata only, no browser truth claimed',
      freshContextsDistinct: true,
      sameCriteriaHash: true,
    }),
  );
});
test('CredentialBroker storage primitive is lease/config scoped and honors revocation', async () => {
  const r = newRun();
  r.effectiveConfig.authProfileVersion = 1;
  const t = { ...task, id: randomUUID(), runId: r.id };
  await runs.create(actor(operator), r, [t], { authProfileId: auth.id });
  await runs.transition(actor(operator), p1.id, r.id, 1, 'running');
  const l = await leases.claim(worker);
  assert.equal(l.task.id, t.id);
  const p = {
    taskId: t.id,
    fencingToken: l.fencingToken,
    leaseToken: l.leaseToken,
    contextVersion: l.contextVersion,
  };
  const material = await leases.resolveAuth(worker, p, auth.id, 1, vault);
  assert.equal(material.mode, 'storage_state');
  assert.deepEqual(JSON.parse(material.material.storageState), {
    cookies: [],
    origins: [],
  });
  await expectCode(
    leases.resolveAuth(worker, p, auth.id, 99, vault),
    'NOT_FOUND',
  );
  await expectCode(
    leases.resolveAuth(scopeB, p, auth.id, 1, vault),
    'LEASE_EXPIRED',
  );
  const revoked = await config.updateAuthProfile(actor(owner), p1.id, auth.id, {
    expectedVersion: 1,
    revoke: true,
  });
  assert.equal(revoked.version, 2);
  assert.equal(revoked.status, 'revoked');
  await expectCode(
    leases.resolveAuth(worker, p, auth.id, 1, vault),
    'NOT_FOUND',
  );
});
test('owner can transfer ownership atomically without losing RLS mid-transaction', async () => {
  const p = await projects.create(actor(admin), {
    name: 'T02 ownership transfer',
  });
  await projects.replaceMembers(actor(admin), p.id, {
    expectedVersion: 1,
    members: [{ userId: owner.id, role: 'owner' }],
  });
  await projects.replaceMembers(actor(owner), p.id, {
    expectedVersion: 2,
    members: [{ userId: operator.id, role: 'owner' }],
  });
  await expectCode(projects.get(actor(owner), p.id), 'NOT_FOUND');
  assert.equal((await projects.get(actor(operator), p.id)).version, 3);
});
test('invalidated verdict is excluded without erasing history or claiming not-run', async () => {
  const id = (
    await pool.query('SELECT id FROM verdicts WHERE case_id=$1', [
      definition.id,
    ])
  ).rows[0].id;
  await pool.query(
    "INSERT INTO verdict_invalidations(project_id,verdict_id,reason) VALUES($1,$2,'invalid observer')",
    [p1.id, id],
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::integer n FROM verdicts WHERE id=$1', [
        id,
      ])
    ).rows[0].n,
    1,
  );
  const summary = await runs.summary(actor(viewer), p1.id, run.id);
  assert.equal(summary.inconclusive, 1);
  assert.equal(summary.notRun, 0);
  await sqlReject(
    'DELETE FROM verdict_invalidations WHERE verdict_id=$1',
    [id],
    '23514',
  );
});
test('attempt timestamps are UTC RFC3339 with a Z suffix', async () => {
  const stamped = randomUUID();
  const empty = randomUUID();
  await pool.query(
    "INSERT INTO case_attempts(id,project_id,run_id,case_id,task_id,attempt_number,status,context_id,started_at,finished_at) VALUES($1,$2,$3,$4,$5,2,'completed',$6,'2026-03-15 09:02:03.004+08','2026-03-15 09:02:04.005+08')",
    [stamped, p1.id, run.id, definition.id, task.id, randomUUID()],
  );
  await pool.query(
    "INSERT INTO case_attempts(id,project_id,run_id,case_id,task_id,attempt_number,status,context_id) VALUES($1,$2,$3,$4,$5,3,'running',$6)",
    [empty, p1.id, run.id, definition.id, task.id, randomUUID()],
  );
  const dated = await db.actor(actor(viewer), (client) =>
    attemptDTO(client, p1.id, stamped),
  );
  assert.equal(dated.startedAt, '2026-03-15T01:02:03.004Z');
  assert.equal(dated.finishedAt, '2026-03-15T01:02:04.005Z');
  const missing = await db.actor(actor(viewer), (client) =>
    attemptDTO(client, p1.id, empty),
  );
  assert.equal(missing.startedAt, null);
  assert.equal(missing.finishedAt, null);
});
test('last-owner invariant and archived project run prohibition', async () => {
  await sqlReject(
    "DELETE FROM project_members WHERE project_id=$1 AND role='owner'",
    [p1.id],
    '23514',
  );
  const project = await projects.get(actor(owner), p1.id);
  await projects.update(actor(owner), p1.id, {
    expectedVersion: project.version,
    status: 'archived',
  });
  await expectCode(runs.create(actor(operator), newRun()), 'PROJECT_ARCHIVED');
});
