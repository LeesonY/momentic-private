// One disposable PostgreSQL/Chromium scenario. The wire provider never uses a
// real model and the browser fixture never writes business data.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
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
  ConfigurationRepository,
  migrate,
} from '@localqa/storage';
import { BrowserManager } from '@localqa/browser';
import {
  Coordinator,
  ArtifactStore,
  RuntimeClient,
  createWorkerModelOptions,
} from '@localqa/orchestrator';
import { Worker } from '../dist/index.js';
import { createApiContext, createApiServer } from '../../api/dist/index.js';
import { createProxyServer } from '../../web/scripts/httpProxyHelper.mjs';
import { chromium } from '../../../packages/browser/node_modules/playwright/index.mjs';
import { loadDatabaseUrl } from '../../../deploy/images/database-url.mjs';
import { loadProtectedKek } from '../../../deploy/images/kek.mjs';

const gate = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

test(
  'completion wakes one manager during other agents; concurrency and report drain',
  { timeout: 90000 },
  async () => {
    const base = await loadDatabaseUrl();
    const name = `localqa_continuous_${randomBytes(8).toString('hex')}`;
    assert.match(name, /^localqa_continuous_[a-f0-9]{16}$/);
    assert.notEqual(new URL(base).pathname, `/${name}`);
    const admin = new pg.Client({ connectionString: base });
    const scratch = await mkdtemp(join(tmpdir(), 'localqa-continuous-'));
    const bStarted = gate(),
      bRelease = gate(),
      cStarted = gate(),
      cRelease = gate();
    let created = false,
      db,
      api,
      server,
      fixture,
      proxy,
      browser,
      uiBrowser;
    const flights = [];
    const reviews = [];
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
        email: 'continuous@localqa.test',
        displayName: 'Continuous fixture',
        password: 'OwnedContinuousFixtureAdmin123!',
      });
      const actor = { userId: owner.id };
      const project = await new ProjectRepository(db).create(actor, {
        name: 'Continuous fixture',
      });
      const models = new ModelRepository(db, vault);
      let model = await models.create(actor, {
        name: 'Owned continuous wire',
        endpoint: 'https://continuous.fixture.test/v1',
        configuredModelId: 'continuous-wire',
        adapter: 'openai_compatible',
        responseFormat: 'json_object',
        dataBoundary: 'internal',
        maxOutputTokens: 2000,
        apiKey: 'owned-wire-fixture',
      });
      model = await models.recordProbe(actor, model.id, model.version, {
        status: 'ready',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
      });
      await models.grant(actor, project.id, model.id);
      fixture = createServer((_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<main>Owned continuous dispatch fixture</main>');
      });
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      const site = `http://127.0.0.1:${fixture.address().port}`;
      const env = await new ConfigurationRepository(
        db,
        vault,
      ).createEnvironment(actor, project.id, {
        name: 'Owned site',
        baseUrl: site,
        allowedOrigins: [site],
        tlsPolicy: 'strict',
      });
      const candidate = (title) => ({
        entryUrl: `${site}/${title.toLowerCase()}`,
        title,
        summary: `Technical HTTP check ${title}`,
        preconditions: [],
        outline: ['Check HTTP response'],
        criteria: [
          {
            id: 'http',
            kind: 'http_status',
            description: 'HTTP response available',
            sourceKind: 'generic_smoke',
            sourceRef: 'FR-013/016',
            sourceQuote: '',
            locator: null,
            expectedValue: null,
          },
        ],
      });
      const transport = async (_url, init) => {
        const input = JSON.parse(init.body);
        const messages = input.messages ?? [];
        const system = messages
          .filter((m) => m.role === 'system')
          .map((m) => JSON.stringify(m.content))
          .join(' ');
        const json = messages
          .filter((m) => m.role === 'user')
          .flatMap((m) => {
            try {
              return [
                JSON.parse(
                  typeof m.content === 'string' ? m.content : m.content[0].text,
                ),
              ];
            } catch {
              return [];
            }
          });
        let data = { done: true, toolCalls: [] };
        if (system.includes('SessionDecision JSON')) {
          const context = json.find((m) => m.session);
          assert.ok(context);
          reviews.push(context);
          const titles =
            context.session.round === 1
              ? ['A', 'B']
              : context.session.round === 2
                ? ['C', 'D']
                : [];
          data = {
            action: titles.length ? 'dispatch' : 'finish',
            rationale:
              'Review completed results without replaying pending work',
            cases: titles.map(candidate),
            exploreTargets: [],
            coverageGaps: [],
          };
        } else if (system.includes('SessionConclusion')) {
          data = {
            overview: 'Four completed technical checks',
            caseComments: [],
            coverageGaps: [],
          };
        } else if (/role=(executor|reproducer)/.test(system)) {
          const context = json.findLast((m) => m.assignedCase);
          if (context?.assignedCase.title === 'B') {
            bStarted.resolve();
            await bRelease.promise;
          }
          if (context?.assignedCase.title === 'C') {
            cStarted.resolve();
            await cRelease.promise;
          }
        }
        return new Response(
          JSON.stringify({
            model: 'continuous-wire',
            choices: [
              {
                finish_reason: 'stop',
                message: { content: JSON.stringify(data) },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 200 },
          }),
          { status: 200 },
        );
      };
      const coordinator = new Coordinator({
        db,
        vault,
        serviceActor: actor,
        platformSlots: 25,
        projectSlots: 25,
      });
      const artifacts = new ArtifactStore(join(scratch, 'artifacts'));
      const options = createWorkerModelOptions({
        transport,
        load: (id, version) =>
          models.readVersion(actor, id, version, project.id),
      });
      browser = new BrowserManager();
      const workers = Array.from(
        { length: 5 },
        (_, slot) =>
          new Worker({
            runtime: new RuntimeClient(
              coordinator,
              { projectId: project.id, workerId: `continuous-${slot}` },
              artifacts,
              options,
            ),
            browser,
            scratch,
            heartbeatMs: 100,
          }),
      );
      api = createApiContext({
        connectionString: connection.href,
        vault,
        serviceActor: actor,
        artifactsDir: join(scratch, 'artifacts'),
        modelTransport: transport,
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
      uiBrowser = await chromium.launch({ chromiumSandbox: true });
      const ui = await uiBrowser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const request = ui.request;
      assert.equal(
        (
          await request.post(`${origin}/api/v1/auth/login`, {
            data: {
              email: owner.email,
              password: 'OwnedContinuousFixtureAdmin123!',
            },
          })
        ).status(),
        200,
      );
      const page = await ui.newPage();
      await page.goto(`${origin}/#/home`);
      await page.getByTestId('project-home-page').waitFor();
      await page.getByTestId('select-environment').selectOption(env.id);
      await page.getByTestId('select-model-profile').selectOption(model.id);
      await page.getByTestId('agent-concurrency-picker').click();
      const number = page.getByTestId('agent-concurrency-number');
      await number.fill('26');
      assert.equal(await number.inputValue(), '25');
      await page.getByTestId('agent-concurrency-range').fill('1');
      assert.equal(await number.inputValue(), '1');
      await number.fill('25');
      await number.press('Escape');
      assert.equal(
        await page
          .getByTestId('agent-concurrency-picker')
          .getAttribute('aria-expanded'),
        'false',
      );
      const started = page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/v1/runs') && r.request().method() === 'POST',
      );
      await page.getByTestId('btn-start-smoke-run').click();
      const response = await started;
      assert.equal(response.status(), 202, await response.text());
      assert.equal(response.request().postDataJSON().budget.concurrency, 25);
      const selected = await response.json();
      assert.equal(selected.effectiveConfig.budget.concurrency, 25);
      await request.post(`${origin}/api/v1/runs/${selected.id}/cancel`);
      await coordinator.tick(project.id);

      const create = (concurrency) =>
        request.post(`${origin}/api/v1/runs`, {
          headers: { 'Idempotency-Key': randomUUID() },
          data: {
            projectId: project.id,
            targetUrl: site,
            environmentId: env.id,
            modelProfileId: model.id,
            brief: 'Check four independent pages',
            budget: {
              concurrency,
              maxCases: 4,
              maxPages: 4,
              maxModelCalls: 30,
              maxActionsPerCase: 4,
            },
          },
        });
      assert.equal((await create(26)).status(), 422);
      const accepted = await create(2);
      assert.equal(accepted.status(), 202, await accepted.text());
      const run = await accepted.json();
      const jobs = () =>
        db.actor(
          actor,
          async (client) =>
            (
              await client.query(
                'SELECT * FROM jobs WHERE project_id=$1 AND run_id=$2 ORDER BY available_at,id',
                [project.id, run.id],
              )
            ).rows,
        );
      const pending = (job) =>
        ['queued', 'running', 'waiting'].includes(job.status);
      const managers = (rows) =>
        rows.filter(
          (job) =>
            job.role === 'coordinator' &&
            job.result?.stage === 'plan' &&
            pending(job),
        );
      const noReport = async () =>
        assert.equal(
          (await jobs()).some((job) => job.role === 'finalizer'),
          false,
        );
      await workers[0].once(); // preflight
      await coordinator.tick(project.id); // anonymous auth -> first plan
      await workers[0].once(); // plan A/B
      const first = workers[0].once(),
        second = workers[1].once();
      flights.push(first, second);
      await bStarted.promise;
      await Promise.race([first, second]); // A finished; B remains held
      let rows = await jobs();
      assert.equal(
        rows.filter(
          (job) => job.role === 'executor' && job.status === 'running',
        ).length,
        1,
      );
      assert.equal(
        managers(rows).length,
        1,
        'A finish must enqueue a review before tick',
      );
      await coordinator.tick(project.id);
      await coordinator.tick(project.id);
      assert.equal(
        managers(await jobs()).length,
        1,
        'ticks must not duplicate reviews',
      );
      await workers[2].once(); // review A and dispatch C/D, while B runs
      assert.equal(
        reviews[1].cases.find((c) => c.title === 'A').outcome,
        'passed',
      );
      const bCase = reviews[1].cases.find((c) => c.title === 'B');
      assert.equal(
        bCase.outcome,
        'not_run',
        'an active attempt is not an inconclusive result',
      );
      assert.ok(
        reviews[1].activeTasks.some(
          (task) => task.caseId === bCase.caseId && task.status === 'running',
        ),
      );
      const third = workers[3].once();
      flights.push(third);
      // C must be the first of the new pair; equal-time task IDs are unordered.
      // If D wins the claim, let it finish, review that result, then claim C.
      await Promise.race([cStarted.promise, third]);
      rows = await jobs();
      if (
        !rows.some(
          (j) =>
            j.role === 'executor' &&
            j.status === 'running' &&
            j.id !== rows.find((r) => r.case_id === bCase.caseId)?.id,
        )
      ) {
        await workers[2].once();
        const fourth = workers[3].once();
        flights.push(fourth);
      }
      await cStarted.promise;
      assert.equal(
        await coordinator.claim({
          projectId: project.id,
          workerId: 'quota-check',
        }),
        null,
        'two children fill the run limit even when the platform allows 25',
      );
      const current = await api.runRepo.get(actor, project.id, run.id);
      const message = await request.post(
        `${origin}/api/v1/runs/${run.id}/messages`,
        {
          data: {
            expectedContextVersion: current.contextVersion,
            text: '请按完成结果继续汇总',
          },
        },
      );
      assert.equal(message.status(), 202);
      await coordinator.tick(project.id);
      await workers[2].once(); // control job is claimable despite two busy child slots
      assert.equal(
        reviews.at(-1).activeTasks.filter((task) => task.status === 'running')
          .length,
        2,
      );
      await coordinator.tick(project.id);
      await noReport(); // manager proposed finish, but B/C are still active
      cRelease.resolve();
      await Promise.all(
        flights.filter((flight) => flight !== first && flight !== second),
      );
      await workers[2].once(); // review C
      await noReport();
      rows = await jobs();
      if (
        rows.some((job) => job.role === 'executor' && job.status === 'queued')
      ) {
        await workers[4].once(); // D, if it did not win the earlier claim
        await workers[2].once(); // review D
      }
      await noReport();
      bRelease.resolve();
      await Promise.all([first, second]);
      await workers[2].once(); // review B
      await coordinator.tick(project.id); // all children settled -> finalizer
      rows = await jobs();
      assert.equal(
        rows.filter(
          (job) => job.role === 'finalizer' && job.status === 'queued',
        ).length,
        1,
      );
      assert.equal(
        rows.filter((job) => job.role === 'executor' && pending(job)).length,
        0,
      );
      await workers[2].once();
      await coordinator.tick(project.id);
      const report = await (
        await request.get(`${origin}/api/v1/runs/${run.id}/report`)
      ).json();
      assert.equal(report.run.terminationReason, 'normal');
      assert.equal(report.summary.planned, 4);
      assert.equal(report.summary.passed, 4);
      assert.equal(report.summary.notRun, 0);
      assert.equal(report.session.status, 'complete');
      console.log(
        `CONTINUOUS_ACCEPTED: reviews=${reviews.length}; UI 1–25; A completion before B; single manager; child cap; reserved control; report drain`,
      );
    } finally {
      bRelease.resolve();
      cRelease.resolve();
      await Promise.allSettled(flights);
      await uiBrowser?.close();
      await browser?.close();
      await proxy?.closeAll();
      for (const item of [server, fixture])
        if (item) {
          item.closeAllConnections();
          await new Promise((resolve) => item.close(resolve));
        }
      await api?.db.close();
      await db?.close();
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
