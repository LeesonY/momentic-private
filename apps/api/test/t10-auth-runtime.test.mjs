// Own PostgreSQL/API only. No browser, worker-entry, credentials from users or providers.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test as nodeTest } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AccountsRepository,
  ConfigurationRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  SecretVault,
  migrate,
} from '@localqa/storage';
import { RuntimeClient, createWorkerModelOptions } from '@localqa/orchestrator';
import { DEFAULT_LIMITS } from '@localqa/domain';
import { createApiContext, createApiServer } from '../dist/index.js';
import { createTestServiceIdentity } from './support/internal-auth.mjs';

// The internal boundary is a peer-only surface. The suite signs its internal
// requests with this ring instead of being exempted from the gate.
const testServiceIdentity = createTestServiceIdentity();

const tag = randomUUID().slice(0, 8);
const dir = mkdtempSync(join(tmpdir(), 'localqa-auth-runtime-'));
const containerName = `localqa-auth-runtime-${tag}`;
const evidence = {
  tag,
  execution: 'Own PG/API/RuntimeClient, no browser or provider',
  tests: [],
  ownership: { directory: dir },
  P0Passed: false,
};
let containerId,
  db,
  vault,
  context,
  server,
  origin,
  actor,
  configs,
  models,
  model;
function test(name, fn) {
  nodeTest(name, async () => {
    const fact = { name, passed: false };
    evidence.tests.push(fact);
    await fn(fact);
    fact.passed = true;
  });
}
before(async () => {
  const password = randomBytes(24).toString('hex');
  const pgEnv = join(dir, 'pg.env');
  writeFileSync(
    pgEnv,
    `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  const launch = spawnSync(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      containerName,
      '--env-file',
      pgEnv,
      '--publish',
      '127.0.0.1::5432',
      'postgres:18-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(launch.status, 0, launch.stderr);
  containerId = launch.stdout.trim();
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const owned = JSON.parse(
    spawnSync('docker', ['inspect', containerId], { encoding: 'utf8' }).stdout,
  )[0];
  evidence.ownership.containerId = containerId;
  evidence.ownership.volumes = owned.Mounts.filter(
    (x) => x.Type === 'volume',
  ).map((x) => x.Name);
  const port = Number(
    spawnSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' })
      .stdout.trim()
      .split(':')
      .at(-1),
  );
  const connection = `postgresql://localqa:${password}@127.0.0.1:${port}/localqa`;
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
  assert.ok(ready, 'Own PG migrations ready');
  const kek = join(dir, 'kek.json');
  writeFileSync(
    kek,
    JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    }),
    { mode: 0o600 },
  );
  vault = await SecretVault.fromProtectedFile(kek);
  db = new Database(connection);
  const user = await new AccountsRepository(db).bootstrap({
    email: `auth-${tag}@localqa.test`,
    displayName: 'Auth runtime fixture',
    password: 'OwnAuthFixturePassword123!',
  });
  actor = { userId: user.id };
  configs = new ConfigurationRepository(db, vault);
  models = new ModelRepository(db, vault);
  model = await models.create(actor, {
    name: 'Never called',
    endpoint: 'https://unused.invalid/v1',
    configuredModelId: 'local-only',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
  });
  context = createApiContext({
    connectionString: connection,
    vault,
    artifactsDir: join(dir, 'artifacts'),
    serviceActor: actor,
    serviceIdentity: testServiceIdentity.verifier,
    modelTransport: async () => {
      throw new Error('External provider is forbidden in this fixture');
    },
  });
  server = createApiServer(context);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  evidence.ownership.apiOrigin = origin;
  evidence.ownership.pgPort = port;
});
after(async () => {
  if (server)
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  await context?.db.close();
  await db?.close();
  const cleanup = {};
  if (containerId) {
    cleanup.removeStatus = spawnSync(
      'docker',
      ['rm', '--force', '--volumes', containerId],
      { encoding: 'utf8' },
    ).status;
    const check = spawnSync('docker', ['container', 'inspect', containerId], {
      encoding: 'utf8',
    });
    cleanup.containerAbsent =
      check.status !== 0 && /no such container/i.test(check.stderr);
    cleanup.volumesAbsent = evidence.ownership.volumes.map((id) => {
      const c = spawnSync('docker', ['volume', 'inspect', id], {
        encoding: 'utf8',
      });
      return { id, absent: c.status !== 0 && /no such volume/i.test(c.stderr) };
    });
  }
  rmSync(dir, { recursive: true, force: true });
  cleanup.secretDirectoryRemoved = true;
  evidence.cleanup = cleanup;
  const path = new URL(
    `../../../docs/validation-results/T10-auth-runtime-${tag}.json`,
    import.meta.url,
  );
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(`[Auth runtime evidence] ${path.pathname}`);
  if (containerId) {
    assert.equal(cleanup.removeStatus, 0);
    assert.equal(cleanup.containerAbsent, true);
    assert.ok(cleanup.volumesAbsent.every((x) => x.absent));
  }
});

async function fixture(mode = 'none', unusedNoneSecret = false) {
  const project = await new ProjectRepository(db).create(actor, {
    name: `Auth ${tag} ${randomUUID()}`,
  });
  await models.grant(actor, project.id, model.id);
  const secret = `OWN_AUTH_SENTINEL_${randomUUID()}`;
  const profile = await configs.createAuthProfile(actor, project.id, {
    name: 'Bound synthetic profile',
    mode,
    allowedOrigins: ['http://localhost:8080'],
    sharingPolicy: 'shared_state',
    ...(mode === 'storage_state'
      ? {
          secretInput: {
            storageState: JSON.stringify({
              cookies: [
                {
                  name: 'auth',
                  value: secret,
                  domain: 'localhost',
                  path: '/',
                  expires: -1,
                  httpOnly: true,
                  secure: false,
                  sameSite: 'Lax',
                },
              ],
              origins: [],
            }),
          },
        }
      : unusedNoneSecret
        ? { secretInput: { password: secret } }
        : {}),
  });
  const binding = { profileId: model.id, version: model.version };
  const run = await context.coordinator.start(
    actor,
    {
      projectId: project.id,
      targetUrl: 'http://localhost:8080/',
      authProfileId: profile.id,
    },
    {
      allowedOrigins: ['http://localhost:8080'],
      actionPolicy: 'non_submitting',
      environmentVersion: null,
      authProfileVersion: profile.version,
      models: Object.fromEntries(
        ['coordinator', 'explorer', 'executor', 'assertion', 'reproducer'].map(
          (role) => [role, binding],
        ),
      ),
      knowledgeVersionIds: [],
      budget: { ...DEFAULT_LIMITS },
    },
    randomUUID(),
  );
  const scope = {
    projectId: project.id,
    workerId: `auth-worker-${randomUUID()}`,
  };
  const runtime = new RuntimeClient(
    context.coordinator,
    scope,
    context.artifacts,
    createWorkerModelOptions({
      transport: async () => {
        throw new Error('No provider calls allowed');
      },
    }),
  );
  const lease = await runtime.claim();
  assert.ok(lease);
  const proof = {
    taskId: lease.task.id,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    contextVersion: lease.contextVersion,
  };
  return {
    project,
    profile,
    run,
    runtime,
    scope,
    proof,
    secret,
    close: async () => {
      await context.coordinator.cancel(actor, project.id, run.id);
      await context.coordinator.tick(project.id);
    },
  };
}
async function resolveAuth(f, headers = {}) {
  // Serialise once so the service-identity signature covers the exact bytes sent.
  const rawBody = JSON.stringify({
    taskId: f.proof.taskId,
    authProfileId: f.profile.id,
    authProfileVersion: f.profile.version,
  });
  const response = await fetch(`${origin}/internal/v1/auth/resolve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lease-token': f.proof.leaseToken,
      'x-worker-id': f.scope.workerId,
      'x-fencing-token': String(f.proof.fencingToken),
      'x-context-version': String(f.proof.contextVersion),
      ...headers,
      ...testServiceIdentity.sign('worker', {
        method: 'POST',
        path: '/internal/v1/auth/resolve',
        body: rawBody,
      }),
    },
    body: rawBody,
  });
  return { status: response.status, body: await response.json() };
}

test('none is a frozen approved anonymous policy, not a request for manual credentials', async (fact) => {
  const f = await fixture();
  try {
    const allowed = await f.runtime.requireAnonymousOrInput(f.proof);
    fact.observedAnonymousPolicyAllowed = allowed;
    assert.equal(allowed, true);
    const pending = await db.actor(actor, (client) =>
      client.query(
        'SELECT id FROM input_requests WHERE project_id=$1 AND run_id=$2',
        [f.project.id, f.run.id],
      ),
    );
    assert.equal(pending.rowCount, 0);
  } finally {
    await f.close();
  }
});

test('auth resolve must reject the caller stale context instead of rebuilding it from the database', async (fact) => {
  const f = await fixture('storage_state');
  try {
    await db.actor(actor, (client) =>
      client.query(
        'UPDATE runs SET context_version=context_version+1,version=version+1 WHERE project_id=$1 AND id=$2',
        [f.project.id, f.run.id],
      ),
    );
    const result = await resolveAuth(f);
    fact.observedHttpStatus = result.status;
    fact.returnedOwnedSyntheticSecret = JSON.stringify(result.body).includes(
      f.secret,
    );
    assert.notEqual(
      result.status,
      200,
      'Stale proof must not return credential material',
    );
    assert.equal(JSON.stringify(result.body).includes(f.secret), false);
  } finally {
    await f.close();
  }
});

test('auth resolve must bind the caller worker identity to the lease', async (fact) => {
  const f = await fixture('storage_state');
  try {
    const result = await resolveAuth(f, { 'x-worker-id': 'wrong-worker' });
    fact.observedHttpStatus = result.status;
    fact.returnedOwnedSyntheticSecret = JSON.stringify(result.body).includes(
      f.secret,
    );
    assert.notEqual(
      result.status,
      200,
      'Wrong worker must not receive credential material',
    );
    assert.equal(JSON.stringify(result.body).includes(f.secret), false);
  } finally {
    await f.close();
  }
});

test('frozen auth metadata survives a current-head metadata update', async () => {
  const f = await fixture();
  try {
    await configs.updateAuthProfile(actor, f.project.id, f.profile.id, {
      expectedVersion: 1,
      name: 'Changed current head',
      sharingPolicy: 'exclusive_run',
    });
    const frozen = await f.runtime.authProfile(f.proof);
    assert.equal(frozen.id, f.profile.id);
    assert.equal(frozen.version, 1);
    assert.equal(frozen.name, 'Bound synthetic profile');
    assert.equal(frozen.sharingPolicy, 'shared_state');
    assert.deepEqual(frozen.allowedOrigins, ['http://localhost:8080']);
    assert.equal(await f.runtime.requireAnonymousOrInput(f.proof), true);
  } finally {
    await f.close();
  }
});

test('revoked none cannot become an anonymous fallback', async () => {
  const f = await fixture();
  try {
    await configs.updateAuthProfile(actor, f.project.id, f.profile.id, {
      expectedVersion: 1,
      revoke: true,
    });
    await assert.rejects(
      f.runtime.requireAnonymousOrInput(f.proof),
      (error) => error.code === 'AUTH_FAILED',
    );
  } finally {
    await f.close();
  }
});

test('frozen auth metadata rejects a wrong worker, fencing token and context', async () => {
  const f = await fixture();
  try {
    const other = new RuntimeClient(
      context.coordinator,
      { ...f.scope, workerId: 'another-worker' },
      context.artifacts,
      createWorkerModelOptions({
        transport: async () => {
          throw new Error('No calls');
        },
      }),
    );
    await assert.rejects(
      other.authProfile(f.proof),
      (error) => error.code === 'LEASE_EXPIRED',
    );
    for (const proof of [
      { ...f.proof, fencingToken: f.proof.fencingToken + 1 },
      { ...f.proof, contextVersion: f.proof.contextVersion + 1 },
    ])
      await assert.rejects(
        f.runtime.authProfile(proof),
        (error) => error.code === 'LEASE_EXPIRED',
      );
  } finally {
    await f.close();
  }
});

test('unconnected storage-state execution still waits instead of running anonymously', async () => {
  const f = await fixture('storage_state');
  try {
    assert.equal(await f.runtime.requireAnonymousOrInput(f.proof), false);
    const result = await db.actor(actor, (client) =>
      client.query('SELECT status FROM runs WHERE project_id=$1 AND id=$2', [
        f.project.id,
        f.run.id,
      ]),
    );
    assert.equal(result.rows[0].status, 'awaiting_input');
  } finally {
    await f.close();
  }
});

test('valid credential proof retains the exact bound profile and material', async () => {
  const f = await fixture('storage_state');
  try {
    const result = await resolveAuth(f);
    assert.equal(result.status, 200);
    assert.equal(result.body.mode, 'storage_state');
    assert.equal(
      JSON.parse(result.body.material.storageState).cookies[0].value,
      f.secret,
    );
    assert.ok(Date.parse(result.body.expiresAt) > Date.now());
  } finally {
    await f.close();
  }
});

test('missing and malformed credential proof headers return no material', async () => {
  const f = await fixture('storage_state');
  try {
    for (const headers of [
      { 'x-context-version': '' },
      { 'x-fencing-token': '0' },
      { 'x-fencing-token': '1.5' },
      { 'x-context-version': '9007199254740992' },
      { 'x-worker-id': '' },
    ]) {
      const result = await resolveAuth(f, headers);
      assert.ok([403, 422].includes(result.status));
      assert.equal('material' in result.body, false);
      assert.equal(JSON.stringify(result.body).includes(f.secret), false);
    }
  } finally {
    await f.close();
  }
});

test('wrong fencing and cancellation deny credential material', async () => {
  const f = await fixture('storage_state');
  try {
    const wrong = await resolveAuth(f, {
      'x-fencing-token': String(f.proof.fencingToken + 1),
    });
    assert.notEqual(wrong.status, 200);
    assert.equal(JSON.stringify(wrong.body).includes(f.secret), false);
    await f.close();
    const cancelled = await resolveAuth(f);
    assert.notEqual(cancelled.status, 200);
    assert.equal(JSON.stringify(cancelled.body).includes(f.secret), false);
  } finally {
    await f.close();
  }
});

test('none policy never returns unused stored credential material', async (fact) => {
  const f = await fixture('none', true);
  const originalDecrypt = vault.decrypt;
  let decryptCalls = 0;
  vault.decrypt = function (...args) {
    decryptCalls++;
    return originalDecrypt.apply(this, args);
  };
  try {
    assert.equal(f.profile.hasSecret, true);
    assert.equal(await f.runtime.requireAnonymousOrInput(f.proof), true);
    const result = await resolveAuth(f);
    assert.equal(result.status, 200);
    assert.equal(result.body.mode, 'none');
    fact.returnedUnusedSyntheticSecret = JSON.stringify(result.body).includes(
      f.secret,
    );
    assert.equal(Object.keys(result.body.material).length, 0);
    assert.equal(decryptCalls, 0);
    fact.vaultDecryptCalls = decryptCalls;
  } finally {
    vault.decrypt = originalDecrypt;
    await f.close();
  }
});
