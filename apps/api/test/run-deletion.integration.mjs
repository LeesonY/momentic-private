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
  'run deletion: terminal-only, owner permission, UI confirmation and history retention',
  { timeout: 90000 },
  async () => {
    const base = await loadDatabaseUrl();
    const name = `localqa_run_delete_${randomBytes(8).toString('hex')}`;
    assert.match(name, /^localqa_run_delete_[a-f0-9]{16}$/);
    assert.notEqual(new URL(base).pathname, `/${name}`);
    const control = new pg.Client({ connectionString: base });
    const scratch = await mkdtemp(join(tmpdir(), 'localqa-run-delete-'));
    let created = false,
      db,
      api,
      server,
      proxy,
      browser,
      inspection;
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
      const admin = await accounts.bootstrap({
        email: 'admin-run-delete@localqa.test',
        displayName: 'Run Delete Admin',
        password: 'OwnedRunDelete123!',
      });
      const actor = { userId: admin.id };
      const projects = new ProjectRepository(db);
      const project = await projects.create(actor, {
        name: 'Run deletion fixture',
      });
      const owner = await accounts.create(actor, {
        email: 'owner-run-delete@localqa.test',
        displayName: 'Owner',
        password: 'OwnedRunDeleteOwner123!',
        globalRole: 'member',
      });
      const viewer = await accounts.create(actor, {
        email: 'viewer-run-delete@localqa.test',
        displayName: 'Viewer',
        password: 'OwnedRunDeleteViewer123!',
        globalRole: 'member',
      });
      await projects.replaceMembers(actor, project.id, {
        expectedVersion: project.version,
        members: [
          { userId: admin.id, role: 'owner' },
          { userId: owner.id, role: 'owner' },
          { userId: viewer.id, role: 'viewer' },
        ],
      });
      const models = new ModelRepository(db, vault);
      let model = await models.create(actor, {
        name: 'Fixture',
        endpoint: 'https://provider.fixture.test/v1',
        configuredModelId: 'fixture',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
      });
      model = await models.recordProbe(actor, model.id, 1, {
        status: 'ready',
        capabilities: {
          structuredOutput: true,
          nativeTools: true,
          imageInput: false,
        },
      });
      await models.grant(actor, project.id, model.id);
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
      const check = async (r, status, code) => {
        assert.equal(
          r.status(),
          status,
          r.status() === status ? undefined : await r.text(),
        );
        if (code) assert.equal((await r.json()).code, code);
      };
      await check(
        await request.post(`${origin}/api/v1/auth/login`, {
          data: { email: admin.email, password: 'OwnedRunDelete123!' },
        }),
        200,
      );
      const response = await request.post(`${origin}/api/v1/runs`, {
        headers: { 'Idempotency-Key': randomUUID() },
        data: {
          projectId: project.id,
          targetUrl: 'https://target.fixture.test/',
          modelProfileId: model.id,
        },
      });
      await check(response, 202);
      await check(
        await request.post(`${origin}/api/v1/auth/login`, {
          data: { email: owner.email, password: 'OwnedRunDeleteOwner123!' },
        }),
        200,
      );
      let run = await response.json();
      const endpoint = `${origin}/api/v1/runs/${run.id}`;
      const confirmation = () => ({
        expectedVersion: run.version,
        confirmRunId: run.id,
      });
      await check(
        await request.delete(endpoint, { data: confirmation() }),
        409,
        'CONFIG_IN_USE',
      );
      const caseId = randomUUID();
      await new RunRepository(db, vault).addCase(actor, {
        id: caseId,
        runId: run.id,
        projectId: project.id,
        version: 1,
        title: 'Saved fixture',
        summary: 'Owned fixture',
        preconditions: [],
        outline: ['Navigate https://target.fixture.test/'],
        criteria: [
          {
            id: 'body',
            kind: 'element_visible',
            description: 'Body is visible',
            sourceKind: 'user_spec',
            sourceRef: 'owned-fixture',
            locator: { by: 'css', value: 'body' },
          },
        ],
      });
      const savedResponse = await request.post(
        `${origin}/api/v1/projects/${project.id}/saved-cases`,
        {
          data: {
            slug: 'retained-fixture',
            name: 'Retained case',
            sourceRunCaseId: caseId,
          },
        },
      );
      await check(savedResponse, 201);
      const saved = await savedResponse.json();
      await check(await request.post(`${endpoint}/cancel`), 202);
      await api.coordinator.tick(project.id);
      run = await (await request.get(endpoint)).json();
      assert.equal(run.status, 'cancelled');
      await check(
        await request.delete(endpoint, {
          data: { ...confirmation(), expectedVersion: 1 },
        }),
        409,
        'VERSION_CONFLICT',
      );
      await check(
        await request.delete(endpoint, {
          data: { ...confirmation(), confirmRunId: randomUUID() },
        }),
        422,
      );
      const viewerContext = await browser.newContext();
      await check(
        await viewerContext.request.post(`${origin}/api/v1/auth/login`, {
          data: { email: viewer.email, password: 'OwnedRunDeleteViewer123!' },
        }),
        200,
      );
      await check(
        await viewerContext.request.delete(endpoint, { data: confirmation() }),
        403,
      );
      await viewerContext.close();
      const tasks = await (
        await request.get(`${endpoint}/tasks?limit=100`)
      ).json();
      assert.ok(tasks.items.length);
      inspection = new pg.Client({ connectionString: connection.href });
      await inspection.connect();
      const before = (
        await inspection.query(
          'SELECT to_jsonb(r) AS document FROM runs r WHERE id=$1',
          [run.id],
        )
      ).rows[0].document;
      const page = await context.newPage();
      let deletes = 0;
      page.on('request', (r) => {
        if (r.method() === 'DELETE') deletes++;
      });
      await page.goto(`${origin}/#/workbench?runId=${run.id}`);
      await page.getByTestId('btn-delete-run').click();
      await page.getByTestId('run-delete-cancel').click();
      assert.equal(deletes, 0);
      await page.getByTestId('btn-delete-run').click();
      assert.match(
        await page.getByTestId('run-delete-dialog').innerText(),
        new RegExp(run.id),
      );
      const deleted = page.waitForResponse(
        (r) => r.url() === endpoint && r.request().method() === 'DELETE',
      );
      await page.getByTestId('run-delete-confirm').click();
      await check(await deleted, 204);
      await page.getByTestId('run-delete-dialog').waitFor({ state: 'hidden' });
      await page.reload();
      await page
        .getByTestId('sidebar-runs')
        .getByText('还没有运行', { exact: true })
        .waitFor();
      for (const suffix of [
        '',
        '/report',
        '/tasks',
        '/cases',
        '/event-history',
        '/messages',
      ])
        await check(await request.get(endpoint + suffix), 404);
      await check(await request.get(`${origin}/api/v1/cases/${caseId}`), 404);
      await check(
        await request.get(`${origin}/api/v1/tasks/${tasks.items[0].id}/steps`),
        404,
      );
      await check(
        await request.delete(endpoint, { data: confirmation() }),
        404,
      );
      const list = await request.get(
        `${origin}/api/v1/runs?projectId=${project.id}`,
      );
      await check(list, 200);
      assert.equal((await list.json()).items.length, 0);
      const savedCases = await request.get(
        `${origin}/api/v1/projects/${project.id}/saved-cases`,
      );
      await check(savedCases, 200);
      assert.ok(
        (await savedCases.json()).items.some((item) => item.id === saved.id),
      );
      await check(
        await request.get(`${origin}/api/v1/saved-cases/${saved.id}/versions`),
        200,
      );
      const after = (
        await inspection.query(
          'SELECT to_jsonb(r) AS document FROM runs r WHERE id=$1',
          [run.id],
        )
      ).rows[0].document;
      assert.deepEqual(after, before, 'Frozen run data is retained unchanged');
      const retention = (
        await inspection.query(
          "SELECT (SELECT count(*)::int FROM run_deletions WHERE run_id=$1) AS removed,(SELECT count(*)::int FROM audit_log WHERE object_id=$1 AND action='run.deleted') AS audit,(SELECT count(*)::int FROM run_cases WHERE run_id=$1) AS cases",
          [run.id],
        )
      ).rows[0];
      assert.deepEqual(retention, { removed: 1, audit: 1, cases: 1 });
    } finally {
      await browser?.close();
      await proxy?.closeAll();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await inspection?.end();
      await api?.db.close();
      await db?.close();
      if (created) await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await control.end();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
