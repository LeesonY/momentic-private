// One owned database: real API and browser forms, no provider calls or test runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from '../../../packages/storage/node_modules/pg/lib/index.js';
import {
  AccountsRepository,
  Database,
  ProjectRepository,
  ModelRepository,
  migrate,
} from '@localqa/storage';
import { createApiContext, createApiServer } from '../../api/dist/index.js';
import { createProxyServer } from '../../web/scripts/httpProxyHelper.mjs';
import { chromium } from '../../../packages/browser/node_modules/playwright/index.mjs';
import { loadDatabaseUrl } from '../../../deploy/images/database-url.mjs';
import { loadProtectedKek } from '../../../deploy/images/kek.mjs';

test(
  'model context: create/edit/read-back/reset, invalid budget rejection and frozen versions',
  { timeout: 60000 },
  async () => {
    const base = await loadDatabaseUrl();
    const name = `localqa_modelcontext_${randomBytes(8).toString('hex')}`;
    assert.match(name, /^localqa_modelcontext_[a-f0-9]{16}$/);
    assert.notEqual(new URL(base).pathname, `/${name}`);
    const admin = new pg.Client({ connectionString: base });
    const scratch = await mkdtemp(join(tmpdir(), 'localqa-modelcontext-'));
    let created = false,
      db,
      api,
      server,
      proxy,
      browser;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      const connection = new URL(base);
      connection.pathname = `/${name}`;
      await migrate(
        connection.href,
        new URL('../../../packages/storage/migrations/', import.meta.url),
      );
      const vault = await loadProtectedKek();
      db = new Database(connection.href);
      const owner = await new AccountsRepository(db).bootstrap({
        email: 'context@localqa.test',
        displayName: 'Owned context admin',
        password: 'OwnedContextFixtureAdmin123!',
      });
      const actor = { userId: owner.id };
      await new ProjectRepository(db).create(actor, {
        name: 'Owned context fixture',
      });
      const models = new ModelRepository(db, vault);
      api = createApiContext({
        connectionString: connection.href,
        vault,
        serviceActor: actor,
        artifactsDir: join(scratch, 'artifacts'),
        modelTransport: async () => {
          assert.fail('No provider calls authorized by this scenario');
        },
      });
      server = createApiServer(api);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      proxy = await createProxyServer({
        backendOrigin: `http://127.0.0.1:${server.address().port}`,
        distDir: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
      });
      await proxy.listen();
      const origin = `http://127.0.0.1:${proxy.address().port}`;
      api.publicOrigin = origin;
      browser = await chromium.launch({ chromiumSandbox: true });
      const ui = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
      });
      const request = ui.request;
      assert.equal(
        (
          await request.post(`${origin}/api/v1/auth/login`, {
            data: {
              email: owner.email,
              password: 'OwnedContextFixtureAdmin123!',
            },
          })
        ).status(),
        200,
      );
      const page = await ui.newPage();
      await page.goto(`${origin}/#/models`);
      await page.getByTestId('btn-add-model').click();
      await page.locator('#new-model-name').fill('Owned context model');
      await page
        .locator('#new-model-endpoint')
        .fill('https://context.fixture.test/v1');
      await page.locator('#new-model-id').fill('context-wire');
      await page.getByTestId('model-max-output-tokens').fill('8192');
      await page.getByTestId('model-context-window-tokens').fill('128000');
      const creation = page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/v1/model-profiles') &&
          r.request().method() === 'POST',
      );
      await page.getByTestId('btn-create-model-submit').click();
      const response = await creation;
      assert.equal(response.status(), 201, await response.text());
      const first = await response.json();
      assert.equal(first.contextWindowTokens, 128000);
      assert.equal(
        response.request().postDataJSON().contextWindowTokens,
        128000,
      );
      await page.reload();
      await page.getByTestId(`model-context-window-${first.id}`).waitFor();
      assert.match(
        await page.getByTestId(`model-context-window-${first.id}`).innerText(),
        /128,000/,
      );
      await page.getByTestId(`btn-edit-model-${first.id}`).click();
      const field = page.getByTestId('edit-model-context-window-tokens');
      assert.equal(await field.inputValue(), '128000');
      await field.fill('8192');
      await page.getByTestId('btn-edit-model-submit').click();
      await page
        .getByRole('alert')
        .filter({ hasText: '上下文窗口必须大于单次输出上限' })
        .waitFor();
      const unchanged = await (
        await request.get(`${origin}/api/v1/model-profiles/${first.id}`)
      ).json();
      assert.equal(unchanged.version, first.version);
      await field.fill('64000');
      const edit = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/model-profiles/${first.id}`) &&
          r.request().method() === 'PATCH',
      );
      await page.getByTestId('btn-edit-model-submit').click();
      const edited = await edit;
      assert.equal(edited.status(), 200, await edited.text());
      const second = await edited.json();
      assert.equal(second.contextWindowTokens, 64000);
      assert.equal(second.maxOutputTokens, 8192);
      assert.equal(
        (await models.readVersion(actor, first.id, first.version)).document
          .contextWindowTokens,
        128000,
      );
      assert.equal(
        (await models.readVersion(actor, first.id, second.version)).document
          .contextWindowTokens,
        64000,
      );
      for (const value of [0, 8000.5, 2000001, 8192]) {
        const bad = await request.patch(
          `${origin}/api/v1/model-profiles/${first.id}`,
          {
            data: {
              expectedVersion: second.version,
              contextWindowTokens: value,
            },
          },
        );
        assert.equal(bad.status(), 422, await bad.text());
      }
      const defaultCreate = await request.post(
        `${origin}/api/v1/model-profiles`,
        {
          data: {
            name: 'Invalid window',
            endpoint: 'https://context.fixture.test/v1',
            configuredModelId: 'invalid',
            adapter: 'openai_compatible',
            dataBoundary: 'internal',
            contextWindowTokens: 4000,
          },
        },
      );
      assert.equal(defaultCreate.status(), 422, await defaultCreate.text());
      await page.reload();
      await page.getByTestId(`btn-edit-model-${first.id}`).click();
      await page.getByTestId('edit-model-context-window-tokens').fill('');
      const reset = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/model-profiles/${first.id}`) &&
          r.request().method() === 'PATCH',
      );
      await page.getByTestId('btn-edit-model-submit').click();
      const restored = await reset;
      assert.equal(restored.status(), 200, await restored.text());
      assert.equal(restored.request().postDataJSON().contextWindowTokens, null);
      const third = await restored.json();
      assert.equal('contextWindowTokens' in third, false);
      assert.equal(third.maxOutputTokens, 8192);
      await page.reload();
      await page.getByTestId(`model-context-window-${first.id}`).waitFor();
      assert.match(
        await page.getByTestId(`model-context-window-${first.id}`).innerText(),
        /20,192.*默认/,
      );
      assert.equal(
        (await models.readVersion(actor, first.id, first.version)).document
          .contextWindowTokens,
        128000,
      );
      const count = await db.actor(
        actor,
        async (client) =>
          (await client.query('SELECT count(*)::int count FROM model_profiles'))
            .rows[0].count,
      );
      assert.equal(count, 1, 'invalid configuration must not create a profile');
      console.log(
        'MODEL_CONTEXT_ACCEPTED: real forms + persisted versions + reset + validation; no provider calls or runs',
      );
    } finally {
      await browser?.close();
      await proxy?.closeAll();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await api?.db.close();
      await db?.close();
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
