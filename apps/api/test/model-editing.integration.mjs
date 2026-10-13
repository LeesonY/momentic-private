// Runs against an owned disposable database, using the deployment connection.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import pg from '../../../packages/storage/node_modules/pg/lib/index.js';
import {
  AccountsRepository,
  Database,
  ModelRepository,
  migrate,
} from '@localqa/storage';
import { loadDatabaseUrl } from '../../../deploy/images/database-url.mjs';
import { loadProtectedKek } from '../../../deploy/images/kek.mjs';

test('model edits replace credentials, reset probes and preserve frozen versions', async () => {
  const base = await loadDatabaseUrl();
  const vault = await loadProtectedKek();
  const control = new pg.Client({ connectionString: base });
  const name = `localqa_model_edit_${randomBytes(8).toString('hex')}`;
  assert.match(name, /^localqa_model_edit_[a-f0-9]{16}$/);
  assert.notEqual(new URL(base).pathname, `/${name}`);
  let db;
  let created = false;
  try {
    await control.connect();
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    const connection = new URL(base);
    connection.pathname = `/${name}`;
    await migrate(connection.href);
    db = new Database(connection.href);
    const admin = await new AccountsRepository(db).bootstrap({
      email: 'model-edit@localqa.test',
      displayName: 'Model editing fixture',
      password: 'OwnedModelEditing123!',
    });
    const actor = { userId: admin.id };
    const models = new ModelRepository(db, vault);
    const firstKey = `fixture-a-${randomBytes(16).toString('hex')}`;
    const secondKey = `fixture-b-${randomBytes(16).toString('hex')}`;
    let model = await models.create(actor, {
      name: 'Editing fixture',
      endpoint: 'https://provider.example.test/v1',
      configuredModelId: 'model-a',
      adapter: 'openai_compatible',
      dataBoundary: 'external',
      apiKey: firstKey,
    });
    const capabilities = {
      structuredOutput: true,
      nativeTools: true,
      imageInput: true,
    };
    const probe = async () => {
      model = await models.recordProbe(actor, model.id, model.version, {
        status: 'ready',
        capabilities,
      });
    };
    await probe();
    model = await models.update(actor, model.id, {
      expectedVersion: model.version,
      name: 'Renamed fixture',
    });
    assert.equal(model.status, 'ready');
    assert.deepEqual(model.capabilities, capabilities);
    // The frontend omits a blank Key, so a model ID edit retains the credential.
    model = await models.update(actor, model.id, {
      expectedVersion: model.version,
      configuredModelId: 'model-b',
    });
    assert.equal(model.configuredModelId, 'model-b');
    assert.equal(model.status, 'untested');
    assert.deepEqual(model.capabilities, {
      structuredOutput: false,
      nativeTools: false,
      imageInput: false,
    });
    assert.ok(
      (await models.readVersion(actor, model.id, model.version)).apiKey ===
        firstKey,
    );
    await probe();
    model = await models.update(actor, model.id, {
      expectedVersion: model.version,
      apiKey: secondKey,
    });
    assert.equal(
      model.status,
      'untested',
      'Key-only changes reset probe results',
    );
    assert.ok(
      (await models.readVersion(actor, model.id, model.version)).apiKey ===
        secondKey,
    );
    const frozen = await models.readVersion(actor, model.id, 2);
    assert.equal(frozen.document.configuredModelId, 'model-a');
    assert.equal(frozen.document.status, 'ready');
    assert.ok(
      frozen.apiKey === firstKey,
      'Existing runs retain their frozen credential',
    );
    const dto = JSON.stringify(await models.get(actor, model.id));
    assert.ok(
      !dto.includes(firstKey) &&
        !dto.includes(secondKey) &&
        !dto.includes('apiKey'),
    );
    await assert.rejects(
      models.update(actor, model.id, { expectedVersion: 2, apiKey: firstKey }),
      { code: 'VERSION_CONFLICT' },
    );
    model = await models.update(actor, model.id, {
      expectedVersion: model.version,
      status: 'disabled',
    });
    model = await models.update(actor, model.id, {
      expectedVersion: model.version,
      configuredModelId: 'model-c',
      apiKey: firstKey,
    });
    assert.equal(
      model.status,
      'disabled',
      'Credential edits do not enable disabled models',
    );
  } finally {
    await db?.close();
    if (created) await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await control.end();
  }
});
