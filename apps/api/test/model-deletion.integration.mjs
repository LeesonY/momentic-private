// Run on the test host in the browser-enabled worker image. All writes are
// restricted to a disposable database; the deployed application is untouched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from '../../../packages/storage/node_modules/pg/lib/index.js';
import {
  AccountsRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  RunRepository,
  migrate,
} from '@localqa/storage';
import { createApiContext, createApiServer } from '../dist/index.js';
import { createProxyServer } from '../../web/scripts/httpProxyHelper.mjs';
import { chromium } from '../../../packages/browser/node_modules/playwright/index.mjs';
import { loadDatabaseUrl } from '../../../deploy/images/database-url.mjs';
import { loadProtectedKek } from '../../../deploy/images/kek.mjs';

test(
  'model deletion: HTTP permissions, references, frozen history and Chromium confirmation',
  { timeout: 120000 },
  async () => {
    const base = await loadDatabaseUrl();
    const name = `localqa_model_delete_test_${randomBytes(8).toString('hex')}`;
    assert.match(name, /^localqa_model_delete_test_[a-f0-9]{16}$/);
    assert.notEqual(new URL(base).pathname, `/${name}`);
    const admin = new pg.Client({ connectionString: base });
    const scratch = await mkdtemp(join(tmpdir(), 'localqa-model-delete-'));
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
      const accounts = new AccountsRepository(db);
      const owner = await accounts.bootstrap({
        email: 'model-delete@localqa.test',
        displayName: 'Delete Fixture',
        password: 'OwnedDeleteFixtureAdmin123!',
      });
      const actor = { userId: owner.id };
      const projects = new ProjectRepository(db);
      const project = await projects.create(actor, { name: 'Delete fixture' });
      const models = new ModelRepository(db, vault);
      const model = await models.create(actor, {
        name: 'Disposable model',
        endpoint: 'https://model.fixture.test/v1',
        configuredModelId: 'fixture',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
        apiKey: 'owned-fixture-model-key',
      });
      await models.grant(actor, project.id, model.id);
      const member = await accounts.create(actor, {
        email: 'member-delete@localqa.test',
        displayName: 'Member',
        password: 'OwnedDeleteFixtureMember123!',
        globalRole: 'member',
      });
      await projects.replaceMembers(actor, project.id, {
        expectedVersion: project.version,
        members: [
          { userId: owner.id, role: 'owner' },
          { userId: member.id, role: 'viewer' },
        ],
      });
      api = createApiContext({
        connectionString: connection.href,
        vault,
        serviceActor: actor,
        artifactsDir: join(scratch, 'artifacts'),
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
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const request = context.request;
      assert.equal(
        (
          await request.post(`${origin}/api/v1/auth/login`, {
            data: {
              email: owner.email,
              password: 'OwnedDeleteFixtureAdmin123!',
            },
          })
        ).status(),
        200,
      );
      const endpoint = `${origin}/api/v1/model-profiles/${model.id}`;
      const confirmation = {
        expectedVersion: model.version,
        confirmName: model.name,
      };
      const remove = (data = confirmation) =>
        request.delete(endpoint, { data });
      const result = async (response, status, code) => {
        assert.equal(
          response.status(),
          status,
          response.status() === status ? undefined : await response.text(),
        );
        if (code) assert.equal((await response.json()).code, code);
      };
      await result(
        await remove({ ...confirmation, confirmName: 'wrong name' }),
        422,
        'VALIDATION_ERROR',
      );
      await result(
        await remove({ ...confirmation, expectedVersion: 9 }),
        409,
        'VERSION_CONFLICT',
      );
      const memberContext = await browser.newContext();
      assert.equal(
        (
          await memberContext.request.post(`${origin}/api/v1/auth/login`, {
            data: {
              email: member.email,
              password: 'OwnedDeleteFixtureMember123!',
            },
          })
        ).status(),
        200,
      );
      await result(
        await memberContext.request.delete(endpoint, { data: confirmation }),
        403,
        'FORBIDDEN',
      );
      const memberPage = await memberContext.newPage();
      await memberPage.goto(`${origin}/#/models`);
      await memberPage.getByTestId(`model-card-${model.id}`).waitFor();
      assert.equal(
        await memberPage.getByTestId(`btn-delete-model-${model.id}`).count(),
        0,
      );
      await memberContext.close();

      let latestProject = await projects.get(actor, project.id);
      latestProject = await projects.update(actor, project.id, {
        expectedVersion: latestProject.version,
        defaultModelProfileId: model.id,
      });
      const page = await context.newPage();
      let deletes = 0;
      page.on('request', (req) => {
        if (req.method() === 'DELETE') deletes++;
      });
      await page.goto(`${origin}/#/models`);
      await page.getByTestId(`btn-delete-model-${model.id}`).click();
      assert.equal(
        await page.getByTestId('model-delete-confirm').isDisabled(),
        true,
      );
      await page.getByTestId('model-delete-name').fill('wrong name');
      assert.equal(
        await page.getByTestId('model-delete-confirm').isDisabled(),
        true,
      );
      await page.getByTestId('model-delete-cancel').click();
      assert.equal(deletes, 0, 'cancel must not send a DELETE');
      await page.getByTestId(`btn-delete-model-${model.id}`).click();
      await page.getByTestId('model-delete-name').fill(model.name);
      await page.getByTestId('model-delete-confirm').click();
      await page.getByTestId('model-delete-error').waitFor();
      assert.match(
        await page.getByTestId('model-delete-error').innerText(),
        /默认模型/,
      );
      assert.equal(await page.getByTestId(`model-card-${model.id}`).count(), 1);
      await page.getByTestId('model-delete-cancel').click();
      latestProject = await projects.update(actor, project.id, {
        expectedVersion: latestProject.version,
        defaultModelProfileId: null,
      });

      const schedule = await request.post(
        `${origin}/api/v1/projects/${project.id}/schedules`,
        {
          data: {
            name: 'Delete reference fixture',
            cron: '0 1 * * *',
            timezone: 'Asia/Shanghai',
            templateKind: 'smoke',
            runTemplate: {
              projectId: project.id,
              targetUrl: 'https://target.fixture.test/',
              modelProfileId: model.id,
            },
          },
        },
      );
      await result(schedule, 201);
      let scheduleData = await schedule.json();
      await result(await remove(), 409, 'MODEL_NOT_CONFIGURED');
      const implicit = await request.patch(
        `${origin}/api/v1/schedules/${scheduleData.id}`,
        {
          data: {
            expectedVersion: scheduleData.version,
            runTemplate: {
              projectId: project.id,
              targetUrl: 'https://target.fixture.test/',
            },
          },
        },
      );
      await result(implicit, 200);
      scheduleData = await implicit.json();
      await result(await remove(), 409, 'MODEL_NOT_CONFIGURED');
      const paused = await request.patch(
        `${origin}/api/v1/schedules/${scheduleData.id}`,
        {
          data: { expectedVersion: scheduleData.version, enabled: false },
        },
      );
      await result(paused, 200);
      scheduleData = await paused.json();
      const runResponse = await request.post(`${origin}/api/v1/runs`, {
        headers: { 'Idempotency-Key': randomUUID() },
        data: {
          projectId: project.id,
          targetUrl: 'https://target.fixture.test/',
          modelProfileId: model.id,
        },
      });
      await result(runResponse, 202);
      const run = await runResponse.json();
      await result(await remove(), 409, 'MODEL_NOT_CONFIGURED');
      // Finish only the fixture run. There is no worker serving this database.
      await db.actor(actor, (c) =>
        c.query(
          "UPDATE runs SET status='cancelled',version=version+1 WHERE id=$1",
          [run.id],
        ),
      );

      await page.reload();
      await page.getByTestId(`btn-delete-model-${model.id}`).click();
      await page.getByTestId('model-delete-name').fill(model.name);
      if (process.env.MODEL_DELETE_SCREENSHOT)
        await page.screenshot({ path: process.env.MODEL_DELETE_SCREENSHOT });
      const deleted = page.waitForResponse(
        (r) => r.request().method() === 'DELETE' && r.url() === endpoint,
      );
      await page.getByTestId('model-delete-confirm').click();
      await result(await deleted, 204);
      await page
        .getByTestId('model-delete-dialog')
        .waitFor({ state: 'detached' });
      await page
        .getByTestId(`model-card-${model.id}`)
        .waitFor({ state: 'detached' });
      assert.equal(
        await page.locator(`option[value="${model.id}"]`).count(),
        0,
      );
      await page.reload();
      await page.getByTestId('models-empty-state').waitFor();
      for (const path of [
        '/model-profiles',
        `/projects/${project.id}/model-profiles`,
      ]) {
        const list = await request.get(`${origin}/api/v1${path}`);
        await result(list, 200);
        assert.equal((await list.json()).items.length, 0);
      }
      await result(await request.get(endpoint), 404, 'NOT_FOUND');
      await result(await remove(), 404, 'NOT_FOUND');
      await result(await request.post(`${endpoint}/probe`), 404, 'NOT_FOUND');
      await result(
        await request.patch(endpoint, {
          data: { expectedVersion: 1, name: 'resurrect' },
        }),
        404,
        'NOT_FOUND',
      );
      await result(
        await request.post(
          `${origin}/api/v1/projects/${project.id}/model-profiles`,
          { data: { modelProfileId: model.id } },
        ),
        404,
        'NOT_FOUND',
      );
      await result(
        await request.post(`${origin}/api/v1/runs`, {
          headers: { 'Idempotency-Key': randomUUID() },
          data: {
            projectId: project.id,
            targetUrl: 'https://target.fixture.test/',
            modelProfileId: model.id,
          },
        }),
        409,
        'MODEL_NOT_CONFIGURED',
      );
      await result(
        await request.post(`${origin}/api/v1/runs`, {
          headers: { 'Idempotency-Key': randomUUID() },
          data: {
            projectId: project.id,
            targetUrl: 'https://target.fixture.test/',
          },
        }),
        409,
        'MODEL_NOT_CONFIGURED',
      );
      await result(
        await request.patch(`${origin}/api/v1/projects/${project.id}`, {
          data: {
            expectedVersion: latestProject.version,
            defaultModelProfileId: model.id,
          },
        }),
        409,
        'MODEL_NOT_CONFIGURED',
      );
      await result(
        await request.patch(`${origin}/api/v1/schedules/${scheduleData.id}`, {
          data: {
            expectedVersion: scheduleData.version,
            enabled: true,
            runTemplate: {
              projectId: project.id,
              targetUrl: 'https://target.fixture.test/',
              modelProfileId: model.id,
            },
          },
        }),
        409,
        'MODEL_NOT_CONFIGURED',
      );
      await assert.rejects(
        models.grant(actor, project.id, model.id),
        (e) => e.code === 'MODEL_NOT_CONFIGURED',
      );
      await assert.rejects(
        models.recordProbe(actor, model.id, 1, {
          capabilities: model.capabilities,
          status: 'ready',
        }),
        (e) => e.code === 'NOT_FOUND',
      );
      const frozen = await models.readVersion(actor, model.id, 1, project.id);
      assert.equal(frozen.document.name, model.name);
      assert.equal(frozen.apiKey, 'owned-fixture-model-key');
      await result(await request.get(`${origin}/api/v1/runs/${run.id}`), 200);
      // A selected binding held by a stale API request cannot create a new run.
      await assert.rejects(
        new RunRepository(db, vault).create(actor, {
          ...run,
          id: randomUUID(),
          status: 'queued',
        }),
        (e) => e.code === 'MODEL_NOT_CONFIGURED',
      );
      const history = await db.actor(
        actor,
        async (c) =>
          (
            await c.query(
              'SELECT action FROM audit_log WHERE object_id=$1 AND action=$2',
              [model.id, 'model.deleted'],
            )
          ).rows,
      );
      assert.equal(history.length, 1);
      console.log(
        'MODEL_DELETE_ACCEPTED: cancel, name/version, admin, defaults, schedule, active run, tombstone, frozen history, stale binding, UI reload',
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
