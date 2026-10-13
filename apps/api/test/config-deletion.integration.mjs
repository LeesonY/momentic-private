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
  ConfigurationRepository,
  migrate,
} from '@localqa/storage';
import { createApiContext, createApiServer } from '../dist/index.js';
import { createProxyServer } from '../../web/scripts/httpProxyHelper.mjs';
import { chromium } from '../../../packages/browser/node_modules/playwright/index.mjs';
import { loadDatabaseUrl } from '../../../deploy/images/database-url.mjs';
import { loadProtectedKek } from '../../../deploy/images/kek.mjs';

test(
  'environment and auth deletion: UI, permissions, live references and frozen history',
  { timeout: 90000 },
  async () => {
    const base = await loadDatabaseUrl();
    const name = `localqa_config_delete_${randomBytes(8).toString('hex')}`;
    assert.match(name, /^localqa_config_delete_[a-f0-9]{16}$/);
    assert.notEqual(new URL(base).pathname, `/${name}`);
    const control = new pg.Client({ connectionString: base });
    const scratch = await mkdtemp(join(tmpdir(), 'localqa-config-delete-'));
    let created = false,
      db,
      api,
      server,
      proxy,
      browser;
    try {
      await control.connect();
      await control.query(`CREATE DATABASE "${name}"`);
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
        email: 'config-delete@localqa.test',
        displayName: 'Config Delete',
        password: 'OwnedConfigDelete123!',
      });
      const actor = { userId: owner.id };
      const projects = new ProjectRepository(db);
      const project = await projects.create(actor, {
        name: 'Config delete fixture',
      });
      const config = new ConfigurationRepository(db, vault);
      let env = await config.createEnvironment(actor, project.id, {
        name: 'Disposable environment',
        baseUrl: 'https://target.fixture.test/',
        allowedOrigins: ['https://target.fixture.test'],
        tlsPolicy: 'strict',
      });
      const auth = await config.createAuthProfile(actor, project.id, {
        name: 'Disposable authentication',
        environmentId: env.id,
        mode: 'none',
        allowedOrigins: env.allowedOrigins,
      });
      env = await config.updateEnvironment(actor, project.id, env.id, {
        expectedVersion: env.version,
        defaultAuthProfileId: auth.id,
      });
      const modelRepo = new ModelRepository(db, vault);
      let model = await modelRepo.create(actor, {
        name: 'Fixture model',
        endpoint: 'https://model.fixture.test/v1',
        configuredModelId: 'fixture',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
      });
      model = await modelRepo.recordProbe(actor, model.id, 1, {
        status: 'ready',
        capabilities: {
          structuredOutput: true,
          nativeTools: true,
          imageInput: false,
        },
      });
      await modelRepo.grant(actor, project.id, model.id);
      const viewer = await accounts.create(actor, {
        email: 'viewer-config@localqa.test',
        displayName: 'Viewer',
        password: 'OwnedConfigViewer123!',
        globalRole: 'member',
      });
      await projects.replaceMembers(actor, project.id, {
        expectedVersion: project.version,
        members: [
          { userId: owner.id, role: 'owner' },
          { userId: viewer.id, role: 'viewer' },
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
      const context = await browser.newContext();
      const request = context.request;
      const check = async (response, status, code) => {
        assert.equal(
          response.status(),
          status,
          response.status() === status ? undefined : await response.text(),
        );
        if (code) assert.equal((await response.json()).code, code);
      };
      await check(
        await request.post(`${origin}/api/v1/auth/login`, {
          data: { email: owner.email, password: 'OwnedConfigDelete123!' },
        }),
        200,
      );
      const envEndpoint = `${origin}/api/v1/environments/${env.id}`;
      const authEndpoint = `${origin}/api/v1/auth-profiles/${auth.id}`;
      const confirmation = (record) => ({
        expectedVersion: record.version,
        confirmName: record.name,
      });
      await check(
        await request.delete(authEndpoint, {
          data: { ...confirmation(auth), confirmName: 'wrong' },
        }),
        422,
      );
      await check(
        await request.delete(envEndpoint, {
          data: { ...confirmation(env), expectedVersion: 1 },
        }),
        409,
        'VERSION_CONFLICT',
      );
      await check(
        await request.delete(envEndpoint, { data: confirmation(env) }),
        409,
        'CONFIG_IN_USE',
      );
      const viewerContext = await browser.newContext();
      await check(
        await viewerContext.request.post(`${origin}/api/v1/auth/login`, {
          data: { email: viewer.email, password: 'OwnedConfigViewer123!' },
        }),
        200,
      );
      await check(
        await viewerContext.request.delete(authEndpoint, {
          data: confirmation(auth),
        }),
        403,
      );
      await viewerContext.close();
      const scheduleResponse = await request.post(
        `${origin}/api/v1/projects/${project.id}/schedules`,
        {
          data: {
            name: 'Config usage',
            cron: '0 1 * * *',
            templateKind: 'smoke',
            runTemplate: {
              projectId: project.id,
              targetUrl: env.baseUrl,
              environmentId: env.id,
              modelProfileId: model.id,
            },
          },
        },
      );
      await check(scheduleResponse, 201);
      let schedule = await scheduleResponse.json();
      await check(
        await request.delete(authEndpoint, { data: confirmation(auth) }),
        409,
        'CONFIG_IN_USE',
      );
      await check(
        await request.delete(envEndpoint, { data: confirmation(env) }),
        409,
        'CONFIG_IN_USE',
      );
      const paused = await request.patch(
        `${origin}/api/v1/schedules/${schedule.id}`,
        {
          data: {
            expectedVersion: schedule.version,
            enabled: false,
            runTemplate: { ...schedule.runTemplate, authProfileId: auth.id },
          },
        },
      );
      await check(paused, 200);
      schedule = await paused.json();
      const runResponse = await request.post(`${origin}/api/v1/runs`, {
        headers: { 'Idempotency-Key': randomUUID() },
        data: {
          projectId: project.id,
          targetUrl: env.baseUrl,
          environmentId: env.id,
          modelProfileId: model.id,
        },
      });
      await check(runResponse, 202);
      const run = await runResponse.json();
      await check(
        await request.delete(authEndpoint, { data: confirmation(auth) }),
        409,
        'CONFIG_IN_USE',
      );
      await db.actor(actor, (c) =>
        c.query(
          "UPDATE runs SET status='cancelled',version=version+1 WHERE id=$1",
          [run.id],
        ),
      );
      const page = await context.newPage();
      let deletes = 0;
      page.on('request', (r) => {
        if (r.method() === 'DELETE') deletes++;
      });
      await page.goto(`${origin}/#/environments`);
      await page.getByTestId(`btn-delete-auth-${auth.id}`).click();
      assert.equal(
        await page.getByTestId('config-delete-confirm').isDisabled(),
        true,
      );
      await page.getByTestId('config-delete-name').fill('wrong');
      assert.equal(
        await page.getByTestId('config-delete-confirm').isDisabled(),
        true,
      );
      await page
        .getByTestId('config-delete-dialog')
        .getByRole('button', { name: '取消', exact: true })
        .click();
      assert.equal(deletes, 0);
      await page.getByTestId(`btn-delete-auth-${auth.id}`).click();
      await page.getByTestId('config-delete-name').fill(auth.name);
      const removedAuth = page.waitForResponse(
        (r) => r.url() === authEndpoint && r.request().method() === 'DELETE',
      );
      await page.getByTestId('config-delete-confirm').click();
      await check(await removedAuth, 204);
      await page
        .getByTestId('config-delete-dialog')
        .waitFor({ state: 'hidden' });
      assert.equal(await page.getByTestId(`auth-row-${auth.id}`).count(), 0);
      env = await (await request.get(envEndpoint)).json();
      assert.equal(env.defaultAuthProfileId, null);
      await check(
        await request.patch(`${origin}/api/v1/schedules/${schedule.id}`, {
          data: { expectedVersion: schedule.version, enabled: true },
        }),
        403,
      );
      await page.getByTestId(`btn-delete-env-${env.id}`).click();
      await page.getByTestId('config-delete-name').fill(env.name);
      const removedEnv = page.waitForResponse(
        (r) => r.url() === envEndpoint && r.request().method() === 'DELETE',
      );
      await page.getByTestId('config-delete-confirm').click();
      await check(await removedEnv, 204);
      await page.reload();
      await page.getByTestId('environments-empty-state').waitFor();
      await check(await request.get(envEndpoint), 404);
      await check(
        await request.delete(authEndpoint, { data: confirmation(auth) }),
        404,
      );
      await check(
        await request.patch(envEndpoint, {
          data: { expectedVersion: env.version, name: 'Undelete' },
        }),
        404,
      );
      await check(
        await request.post(
          `${origin}/api/v1/projects/${project.id}/auth-profiles`,
          {
            data: {
              name: 'Stale environment',
              mode: 'none',
              environmentId: env.id,
              allowedOrigins: env.allowedOrigins,
            },
          },
        ),
        404,
      );
      const history = await db.actor(actor, async (c) => {
        const old = (
          await c.query(
            'SELECT document FROM environment_versions WHERE project_id=$1 AND environment_id=$2 AND version=2',
            [project.id, env.id],
          )
        ).rows[0].document;
        const bindings = (
          await c.query(
            'SELECT environment_id,auth_profile_id FROM runs WHERE id=$1',
            [run.id],
          )
        ).rows[0];
        const authVersions = (
          await c.query(
            'SELECT count(*)::int AS count FROM auth_profile_versions WHERE auth_profile_id=$1',
            [auth.id],
          )
        ).rows[0].count;
        return { old, bindings, authVersions };
      });
      assert.equal(history.old.defaultAuthProfileId, auth.id);
      assert.equal(history.bindings.environment_id, env.id);
      assert.equal(history.bindings.auth_profile_id, auth.id);
      assert.equal(history.authVersions, 2);
    } finally {
      await browser?.close();
      await proxy?.closeAll();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await api?.db.close();
      await db?.close();
      if (created) await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await control.end();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
