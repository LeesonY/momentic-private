import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test, before, after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import {
  AccountsRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  SecretVault,
  StorageError,
  migrate,
} from '@localqa/storage';

const tag = randomUUID().slice(0, 8);
const container = `localqa-g3d-pg-${tag}`;
const dir = `/tmp/localqa-g3d-${tag}`;
const envFile = `${dir}/pg.env`;
const kekFile = `${dir}/kek.json`;
const password = randomBytes(24).toString('hex');
const keyA = `g3d-a-${randomUUID()}`;
const keyB = `g3d-b-${randomUUID()}`;

mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(
  envFile,
  `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
  { mode: 0o600 },
);
writeFileSync(
  kekFile,
  JSON.stringify({
    activeVersion: 1,
    keys: { 1: randomBytes(32).toString('base64') },
  }),
  { mode: 0o600 },
);

let connection;
let db;
let vault;
let models;
let accounts;
let projects;
let admin;
let member;
let project;
let other;
let created = false;

function actor(user) {
  return { userId: user.id };
}

before(async () => {
  const run = spawnSync('docker', [
    'run',
    '--detach',
    '--name',
    container,
    '--publish',
    '127.0.0.1::5432',
    '--env-file',
    envFile,
    'postgres:18-alpine',
  ]);
  assert.equal(run.status, 0, 'docker run failed');
  created = true;
  const mapped = spawnSync('docker', ['port', container, '5432/tcp'], {
    encoding: 'utf8',
  });
  const port = mapped.stdout.trim().split(':').at(-1);
  assert.equal(port === '5432', false);
  assert.equal(port === '8085', false);
  connection = `postgresql://localqa:${password}@127.0.0.1:${port}/localqa`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = spawnSync('docker', [
      'exec',
      container,
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-U',
      'localqa',
      '-d',
      'localqa',
    ]);
    if (probe.status === 0) {
      try {
        const client = new pg.Client({ connectionString: connection });
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        ready = true;
        break;
      } catch {
        /* TCP not ready yet */
      }
    }
    await delay(250);
  }
  assert.equal(ready, true);
  const applied = await migrate(
    connection,
    new URL('../../../packages/storage/migrations/', import.meta.url),
  );
  assert.equal(applied.includes('001_core.sql'), true);
  assert.equal(applied.includes('008_saved_case_review_previews.sql'), true);
  vault = await SecretVault.fromProtectedFile(kekFile);
  db = new Database(connection);
  accounts = new AccountsRepository(db);
  projects = new ProjectRepository(db);
  models = new ModelRepository(db, vault);
  admin = await accounts.bootstrap({
    email: `g3d-admin-${tag}@localqa.test`,
    displayName: 'G3D Admin',
    password: 'G3d-admin-password',
  });
  member = await accounts.create(actor(admin), {
    email: `g3d-member-${tag}@localqa.test`,
    displayName: 'G3D Member',
    password: 'G3d-member-password',
    globalRole: 'member',
  });
  project = await projects.create(actor(admin), { name: `g3d-${tag}` });
  other = await projects.create(actor(admin), { name: `g3d-other-${tag}` });
  console.log(
    `[g3d-repository] postgres ${container} port ${port} migrations ${applied.length}`,
  );
});

after(async () => {
  vault?.dispose?.();
  if (db) await db.close().catch(() => {});
  if (created) {
    spawnSync('docker', ['rm', '--force', '--volumes', container]);
  }
  rmSync(dir, { recursive: true, force: true });
});

async function versions(profileId) {
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  try {
    const result = await client.query(
      'SELECT version, document, credential_id FROM model_profile_versions WHERE profile_id=$1 ORDER BY version',
      [profileId],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

test('frozen versions, decrypt, grants, reset and probe concurrency', async () => {
  const createdProfile = await models.create(actor(admin), {
    name: 'g3d-frozen',
    endpoint: 'https://model.g3d.test/v1',
    configuredModelId: 'g3d-model',
    adapter: 'openai_compatible',
    dataBoundary: 'external',
    responseFormat: 'json_object',
    apiKey: keyA,
  });
  assert.equal(createdProfile.version, 1);
  assert.equal(createdProfile.responseFormat, 'json_object');
  assert.equal(createdProfile.status, 'untested');
  assert.equal(createdProfile.capabilities.structuredOutput, false);
  assert.equal(createdProfile.capabilities.nativeTools, false);
  assert.equal(createdProfile.capabilities.imageInput, false);
  assert.equal(JSON.stringify(createdProfile).includes(keyA), false);

  const first = await models.readVersion(actor(admin), createdProfile.id, 1);
  assert.equal(first.document.responseFormat, 'json_object');
  assert.equal(first.apiKey === keyA, true);
  await assert.rejects(
    () => models.readVersion(actor(admin), createdProfile.id, 1, other.id),
    (error) => error instanceof StorageError && error.code === 'NOT_FOUND',
  );
  await models.grant(actor(admin), project.id, createdProfile.id);
  const granted = await models.readVersion(
    actor(admin),
    createdProfile.id,
    1,
    project.id,
  );
  assert.equal(granted.apiKey === keyA, true);
  await assert.rejects(
    () =>
      models.recordProbe(actor(member), createdProfile.id, 1, {
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        status: 'degraded',
      }),
    (error) => error instanceof StorageError && error.code === 'FORBIDDEN',
  );

  const probed = await models.recordProbe(actor(admin), createdProfile.id, 1, {
    capabilities: {
      structuredOutput: true,
      nativeTools: false,
      imageInput: false,
    },
    status: 'degraded',
  });
  assert.equal(probed.version, 2);
  assert.equal(probed.responseFormat, 'json_object');
  assert.equal(probed.status, 'degraded');
  assert.equal(probed.capabilities.nativeTools, false);
  assert.equal(probed.capabilities.imageInput, false);
  const afterProbe = await versions(createdProfile.id);
  assert.equal(afterProbe.length, 2);
  assert.equal(afterProbe[0].credential_id, afterProbe[1].credential_id);
  const oldAfterProbe = await models.readVersion(
    actor(admin),
    createdProfile.id,
    1,
  );
  const newAfterProbe = await models.readVersion(
    actor(admin),
    createdProfile.id,
    2,
  );
  assert.equal(oldAfterProbe.document.responseFormat, 'json_object');
  assert.equal(oldAfterProbe.apiKey === keyA, true);
  assert.equal(newAfterProbe.document.responseFormat, 'json_object');
  assert.equal(newAfterProbe.apiKey === keyA, true);

  const reset = await models.update(actor(admin), createdProfile.id, {
    expectedVersion: 2,
    responseFormat: 'json_schema',
    apiKey: keyB,
  });
  assert.equal(reset.version, 3);
  assert.equal(reset.responseFormat, 'json_schema');
  assert.equal(reset.status, 'untested');
  assert.equal(reset.capabilities.structuredOutput, false);
  assert.equal(reset.capabilities.nativeTools, false);
  assert.equal(reset.capabilities.imageInput, false);
  const versionOne = await models.readVersion(
    actor(admin),
    createdProfile.id,
    1,
  );
  const versionTwo = await models.readVersion(
    actor(admin),
    createdProfile.id,
    2,
  );
  const versionThree = await models.readVersion(
    actor(admin),
    createdProfile.id,
    3,
  );
  assert.equal(versionOne.document.responseFormat, 'json_object');
  assert.equal(versionOne.document.status, 'untested');
  assert.equal(versionOne.apiKey === keyA, true);
  assert.equal(versionTwo.document.responseFormat, 'json_object');
  assert.equal(versionTwo.apiKey === keyA, true);
  assert.equal(versionThree.document.responseFormat, 'json_schema');
  assert.equal(versionThree.apiKey === keyB, true);
  assert.equal(versionThree.apiKey === keyA, false);
  const stored = await versions(createdProfile.id);
  assert.notEqual(stored[2].credential_id, stored[0].credential_id);

  const disabled = await models.update(actor(admin), createdProfile.id, {
    expectedVersion: 3,
    status: 'disabled',
  });
  assert.equal(disabled.version, 4);
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.responseFormat, 'json_schema');
  const beforeClose = (await versions(createdProfile.id)).length;
  const skipped = await models.recordProbe(actor(admin), createdProfile.id, 4, {
    capabilities: {
      structuredOutput: true,
      nativeTools: true,
      imageInput: true,
    },
    status: 'ready',
  });
  assert.equal(skipped, null);
  assert.equal((await versions(createdProfile.id)).length, beforeClose);
  const stillDisabled = await models.readVersion(
    actor(admin),
    createdProfile.id,
    4,
  );
  assert.equal(stillDisabled.document.status, 'disabled');
  assert.equal(stillDisabled.apiKey === keyB, true);
  const stillOld = await models.readVersion(actor(admin), createdProfile.id, 1);
  assert.equal(stillOld.document.responseFormat, 'json_object');
  assert.equal(stillOld.apiKey === keyA, true);

  const second = await models.create(actor(admin), {
    name: 'g3d-race',
    endpoint: 'https://model.g3d.test/v1',
    configuredModelId: 'g3d-race',
    adapter: 'openai_compatible',
    dataBoundary: 'external',
    responseFormat: 'json_object',
    apiKey: keyA,
  });
  const raced = await Promise.allSettled([
    models.recordProbe(actor(admin), second.id, 1, {
      capabilities: {
        structuredOutput: true,
        nativeTools: false,
        imageInput: false,
      },
      status: 'degraded',
    }),
    models.recordProbe(actor(admin), second.id, 1, {
      capabilities: {
        structuredOutput: true,
        nativeTools: false,
        imageInput: false,
      },
      status: 'degraded',
    }),
  ]);
  const fulfilled = raced.filter((item) => item.status === 'fulfilled');
  const rejected = raced.filter((item) => item.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason instanceof StorageError, true);
  assert.equal(rejected[0].reason.code, 'VERSION_CONFLICT');
  assert.equal(fulfilled[0].value.version, 2);
  assert.equal(fulfilled[0].value.responseFormat, 'json_object');
  assert.equal(fulfilled[0].value.status, 'degraded');
  const raceRows = await versions(second.id);
  assert.equal(raceRows.length, 2);
  assert.equal(raceRows[1].document.status, 'degraded');
  assert.notEqual(raceRows[1].document.status, 'disabled');
});
