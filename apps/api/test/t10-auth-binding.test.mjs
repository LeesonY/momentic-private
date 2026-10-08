import assert from 'node:assert/strict';
import { before, after, test as nodeTest } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';
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
const dir = mkdtempSync(join(tmpdir(), 'localqa-t10-auth-'));
const facts = {
  task: 'T10-AUTH-1',
  setup: 'not_started',
  modelTransportCalls: 0,
  tag,
  evidenceDir: dir,
  tests: [],
  ownership: { containerId: null, volumes: [] },
  limitations: [
    'PG/API admission only; no browser, Worker.once, worker-entry or real model',
    'Frozen none metadata checked by SQL; RuntimeClient execution is Root-owned and not tested here',
    'Form/storage_state regression remains unsupported; P0/T10 not accepted',
  ],
};
const ownershipPath = join(dir, 'ownership.json');
function evidence() {
  writeFileSync(
    ownershipPath,
    JSON.stringify(facts.ownership, null, 2) + '\n',
    { mode: 0o600 },
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
  url,
  versionId,
  pgPort,
  apiPort;
const envFile = join(dir, 'pg.env');
const kekFile = join(dir, 'kek.json');
const target = () => `${url}/`;
async function request(path, body, key = randomUUID()) {
  const response = await fetch(`${url}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
async function makeEnvironment(origins = [url]) {
  return context.configRepo.createEnvironment(actor, project.id, {
    name: `env-${randomUUID()}`,
    baseUrl: url,
    allowedOrigins: origins,
    tlsPolicy: 'strict',
  });
}
const formConfig = () => ({
  loginUrl: `${url}/login`,
  usernameTarget: { by: 'test_id', value: 'username' },
  passwordTarget: { by: 'test_id', value: 'password' },
  submitTarget: { by: 'test_id', value: 'login' },
  successCriterion: {
    id: 'auth-success',
    kind: 'element_visible',
    description: 'Approved login success',
    sourceKind: 'user_spec',
    sourceRef: 'auth-fixture',
    locator: { by: 'test_id', value: 'logged-in' },
  },
});
async function makeAuth(
  environmentId = null,
  mode = 'none',
  origins = [url],
  pid = project.id,
) {
  return context.configRepo.createAuthProfile(actor, pid, {
    name: `auth-${randomUUID()}`,
    environmentId,
    mode,
    allowedOrigins: origins,
    ...(mode === 'form'
      ? {
          formConfig: formConfig(),
          secretInput: {
            username: 'owned-test-user',
            password: 'owned-test-secret',
          },
        }
      : {}),
    ...(mode === 'storage_state'
      ? {
          secretInput: {
            storageState: JSON.stringify({ cookies: [], origins: [] }),
          },
        }
      : {}),
  });
}
async function withDefault(environment, profile) {
  return context.configRepo.updateEnvironment(
    actor,
    project.id,
    environment.id,
    { expectedVersion: environment.version, defaultAuthProfileId: profile.id },
  );
}
async function run(kind, extra, key) {
  return request(
    kind === 'regression' ? '/regression-runs' : '/runs',
    {
      projectId: project.id,
      ...(kind === 'regression'
        ? { caseVersionIds: [versionId] }
        : { targetUrl: target() }),
      ...extra,
    },
    key,
  );
}
async function binding(id) {
  return db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          'SELECT r.auth_profile_id,r.auth_profile_version,r.effective_config,v.document FROM runs r LEFT JOIN auth_profile_versions v ON v.project_id=r.project_id AND v.auth_profile_id=r.auth_profile_id AND v.version=r.auth_profile_version WHERE r.id=$1',
          [id],
        )
      ).rows[0],
  );
}
async function expectBinding(kind, extra, profile) {
  const result = await run(kind, extra);
  assert.equal(result.status, 202, JSON.stringify(result.body));
  const row = await binding(result.body.id);
  assert.equal(row.auth_profile_id, profile.id);
  assert.equal(row.auth_profile_version, profile.version);
  assert.equal(row.effective_config.authProfileVersion, profile.version);
  assert.equal(row.document.mode, profile.mode);
  return result;
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
before(async () => {
  facts.setup = 'started';
  console.log(`[T10-AUTH evidence] ${dir}`);
  evidence();
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
      `localqa-t10-auth-${tag}`,
      '--publish',
      '127.0.0.1::5432',
      '--env-file',
      envFile,
      'postgres:16-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(launched.status, 0, launched.stderr);
  facts.ownership.containerId = launched.stdout.trim();
  assert.match(facts.ownership.containerId, /^[a-f0-9]{64}$/);
  evidence();
  const inspect = spawnSync(
    'docker',
    ['inspect', facts.ownership.containerId],
    { encoding: 'utf8' },
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
  evidence();
  const connection = `postgres://localqa:${password}@127.0.0.1:${pgPort}/localqa`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      await migrate(
        connection,
        new URL('../../../packages/storage/migrations/', import.meta.url),
      );
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, 'migrations ready');
  writeFileSync(
    kekFile,
    JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    }),
    { mode: 0o600 },
  );
  const vault = await SecretVault.fromProtectedFile(kekFile);
  db = new Database(connection);
  const user = await new AccountsRepository(db).bootstrap({
    email: `auth-${tag}@localqa.test`,
    displayName: 'AUTH-1',
    password: 'AuthBindingPassword123!',
  });
  actor = { userId: user.id };
  const projects = new ProjectRepository(db);
  project = await projects.create(actor, { name: `AUTH-1 ${tag}` });
  otherProject = await projects.create(actor, { name: `Other AUTH-1 ${tag}` });
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
    connectionString: connection,
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
  evidence();
  const loginResponse = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: user.email,
      password: 'AuthBindingPassword123!',
    }),
  });
  assert.equal(loginResponse.status, 200);
  cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  await loginResponse.arrayBuffer();
  const saved = await request(`/projects/${project.id}/saved-cases`, {
    slug: `auth-${tag}`,
    name: 'AUTH-1 approved source',
    document: {
      kind: 'localqa/test',
      schemaVersion: 1,
      id: 'auth-source',
      name: 'AUTH source',
      variables: {},
      criteria: [
        {
          id: 'visible',
          kind: 'element_visible',
          description: 'Visible body',
          sourceKind: 'user_spec',
          sourceRef: 'auth-fixture',
          locator: { by: 'css', value: 'body' },
        },
      ],
      steps: [
        { kind: 'navigate', url: target() },
        { kind: 'assert', criterionId: 'visible' },
      ],
    },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const versions = await request(`/saved-cases/${saved.body.id}/versions`);
  versionId = versions.body.items[0].id;
  const review = {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'Owned AUTH-1 test source',
  };
  const preview = await request(
    `/saved-case-versions/${versionId}/review-preview`,
    review,
  );
  assert.equal(preview.status, 200);
  const approved = await request(`/saved-case-versions/${versionId}/review`, {
    ...review,
    confirmationToken: preview.body.confirmationToken,
  });
  assert.equal(approved.status, 200);
  facts.setup = 'ready';
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
  evidence();
  facts.summary = {
    passed: facts.tests.filter((item) => item.passed).length,
    failed: facts.tests.filter((item) => !item.passed).length,
  };
  const results = new URL(
    `../../../docs/validation-results/T10-AUTH-1-${tag}.json`,
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
  console.log(`[T10-AUTH results] ${results.pathname}`);
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

test('default none ID and version are both frozen for smoke and regression', async () => {
  const env = await makeEnvironment();
  const auth = await makeAuth(env.id);
  await withDefault(env, auth);
  for (const kind of ['smoke', 'regression'])
    for (const extra of [
      { environmentId: env.id },
      { environmentId: env.id, authProfileId: auth.id },
    ])
      await expectBinding(kind, extra, auth);
});
test('explicit project-wide none overrides environment default for both routes', async () => {
  const env = await makeEnvironment();
  const defaultAuth = await makeAuth(env.id, 'form');
  await withDefault(env, defaultAuth);
  const explicit = await makeAuth();
  for (const kind of ['smoke', 'regression'])
    await expectBinding(
      kind,
      { environmentId: env.id, authProfileId: explicit.id },
      explicit,
    );
});
test('frozen none version survives a synthetic new form head; new regression refuses form', async () => {
  const auth = await makeAuth();
  const oldRuns = [];
  for (const kind of ['smoke', 'regression'])
    oldRuns.push(await expectBinding(kind, { authProfileId: auth.id }, auth));
  const next = { ...auth, version: 2, mode: 'form', formConfig: formConfig() };
  // AuthProfilePatch does not allow mode changes. Seed a new owned historical head
  // to verify the frozen-version boundary, without modifying an immutable row.
  await db.actor(actor, async (client) => {
    await client.query(
      'INSERT INTO auth_profile_versions(project_id,auth_profile_id,version,document,environment_id) VALUES($1,$2,2,$3,NULL)',
      [project.id, auth.id, next],
    );
    await client.query(
      'UPDATE auth_profiles SET version=2 WHERE project_id=$1 AND id=$2',
      [project.id, auth.id],
    );
  });
  for (const previous of oldRuns) {
    const row = await binding(previous.body.id);
    assert.equal(row.auth_profile_version, 1);
    assert.equal(row.document.mode, 'none');
  }
  await expectBinding('smoke', { authProfileId: auth.id }, next);
  const rejected = await run('regression', { authProfileId: auth.id });
  assert.equal(rejected.status, 422);
  assert.match(rejected.body.message, /not connected yet/);
});
test('unknown, cross-project and revoked profiles reject for both routes', async () => {
  const foreign = await makeAuth(null, 'none', [url], otherProject.id);
  const revoked = await makeAuth();
  const defaultEnv = await makeEnvironment();
  await withDefault(defaultEnv, revoked);
  await context.configRepo.updateAuthProfile(actor, project.id, revoked.id, {
    expectedVersion: revoked.version,
    revoke: true,
  });
  for (const kind of ['smoke', 'regression'])
    for (const [id, status] of [
      [randomUUID(), 404],
      [foreign.id, 404],
      [revoked.id, 422],
    ]) {
      const result = await run(kind, { authProfileId: id });
      assert.equal(result.status, status, JSON.stringify(result.body));
    }
  for (const kind of ['smoke', 'regression']) {
    const result = await run(kind, { environmentId: defaultEnv.id });
    assert.equal(result.status, 422);
  }
});
test('environment-bound profile rejects wrong or omitted environment for both routes', async () => {
  const boundEnv = await makeEnvironment();
  const otherEnv = await makeEnvironment();
  const auth = await makeAuth(boundEnv.id);
  for (const kind of ['smoke', 'regression'])
    for (const environmentId of [undefined, otherEnv.id]) {
      const result = await run(kind, {
        authProfileId: auth.id,
        ...(environmentId ? { environmentId } : {}),
      });
      assert.equal(result.status, 422);
    }
});
test('every run allowed origin must be approved, including environment extra origins', async () => {
  const env = await makeEnvironment([url, 'http://127.0.0.1:1']);
  const auth = await makeAuth();
  await withDefault(env, auth);
  const wrongOrigin = await makeAuth(null, 'none', ['http://127.0.0.1:1']);
  for (const kind of ['smoke', 'regression'])
    for (const extra of [
      { environmentId: env.id },
      { authProfileId: wrongOrigin.id },
    ]) {
      const result = await run(kind, extra);
      assert.equal(result.status, 422);
      assert.equal(result.body.code, 'TARGET_NOT_ALLOWED');
    }
});
test('form/storage_state bind legally in smoke but explicit/default regression remains 422', async () => {
  for (const mode of ['form', 'storage_state']) {
    const env = await makeEnvironment();
    const auth = await makeAuth(env.id, mode);
    await withDefault(env, auth);
    for (const extra of [
      { environmentId: env.id },
      { environmentId: env.id, authProfileId: auth.id },
    ]) {
      await expectBinding('smoke', extra, auth);
      const result = await run('regression', extra);
      assert.equal(result.status, 422);
      assert.match(result.body.message, /not connected yet/);
    }
  }
});
test('identical retry reuses each run; profile/default configuration changes conflict', async () => {
  for (const kind of ['smoke', 'regression']) {
    const env = await makeEnvironment();
    const auth = await makeAuth(env.id);
    const currentEnv = await withDefault(env, auth);
    const key = randomUUID();
    const first = await run(kind, { environmentId: env.id }, key);
    assert.equal(first.status, 202);
    const retry = await run(kind, { environmentId: env.id }, key);
    assert.equal(retry.status, 202);
    assert.equal(retry.body.id, first.body.id);
    await context.configRepo.updateAuthProfile(actor, project.id, auth.id, {
      expectedVersion: auth.version,
      name: 'New metadata version',
    });
    const changedProfile = await run(kind, { environmentId: env.id }, key);
    assert.equal(changedProfile.status, 409);
    assert.equal(changedProfile.body.code, 'IDEMPOTENCY_CONFLICT');
    const replacement = await makeAuth(env.id);
    await withDefault(currentEnv, replacement);
    const changedDefault = await run(kind, { environmentId: env.id }, key);
    assert.equal(changedDefault.status, 409);
    assert.equal(changedDefault.body.code, 'IDEMPOTENCY_CONFLICT');
    const original = await binding(first.body.id);
    assert.equal(original.auth_profile_id, auth.id);
    assert.equal(original.auth_profile_version, 1);
  }
});
