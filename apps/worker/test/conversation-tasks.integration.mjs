// One owned end-to-end scenario: real PostgreSQL/Chromium/API, scripted wire
// provider. Creates and drops only its own disposable database on the test host.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
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

test(
  'conversation task: ask/resume, stable live lease, scoped save, plan-only and continue',
  { timeout: 120000 },
  async () => {
    const base = await loadDatabaseUrl();
    const name = `localqa_conversation_${randomBytes(8).toString('hex')}`;
    assert.match(name, /^localqa_conversation_[a-f0-9]{16}$/);
    assert.notEqual(new URL(base).pathname, `/${name}`);
    const admin = new pg.Client({ connectionString: base });
    const scratch = await mkdtemp(join(tmpdir(), 'localqa-session-'));
    let created = false,
      db,
      api,
      server,
      fixture,
      proxy,
      browser,
      uiBrowser;
    let calls = 0;
    let saves = 0,
      request;
    const goal = '保存后应显示已保存';
    let injectedMessage = false;
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
        email: 'session-owner@localqa.test',
        displayName: 'Session Owner',
        password: 'OwnedSessionFixtureAdmin123!',
      });
      const actor = { userId: owner.id };
      const member = await new AccountsRepository(db).create(actor, {
        email: 'member@localqa.test',
        displayName: 'Project Owner',
        password: 'OwnedConversationMember123!',
        globalRole: 'member',
      });
      const project = await new ProjectRepository(db).create(actor, {
        name: 'Session fixture',
      });
      await new ProjectRepository(db).replaceMembers(actor, project.id, {
        expectedVersion: project.version,
        members: [
          { userId: owner.id, role: 'owner' },
          { userId: member.id, role: 'owner' },
        ],
      });
      const models = new ModelRepository(db, vault);
      let model = await models.create(actor, {
        name: 'Owned session wire',
        endpoint: 'https://session-wire.fixture.test/v1',
        configuredModelId: 'session-wire',
        adapter: 'openai_compatible',
        responseFormat: 'json_object',
        dataBoundary: 'internal',
        maxOutputTokens: 1000,
        apiKey: 'owned-wire-credential',
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

      fixture = createServer((req, res) => {
        if (req.url === '/save') {
          saves++;
          res.end('ok');
          return;
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          "<main><button onclick=\"fetch('/save',{method:'POST'}).then(()=>document.getElementById('saved').textContent='已保存')\">保存</button><div id=\"saved\"></div></main>",
        );
      });
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      const target = `http://127.0.0.1:${fixture.address().port}/organizations`;
      const siteOrigin = new URL(target).origin;
      const config = new ConfigurationRepository(db, vault);
      const env = await config.createEnvironment(actor, project.id, {
        name: 'Owned test site',
        baseUrl: target,
        allowedOrigins: [siteOrigin],
        tlsPolicy: 'strict',
      });
      const auth = await config.createAuthProfile(actor, project.id, {
        name: 'Fixture login',
        mode: 'form',
        environmentId: env.id,
        allowedOrigins: [siteOrigin],
        formConfig: { loginUrl: siteOrigin + '/login', detectionMode: 'ai' },
        secretInput: {
          username: 'owned',
          password: 'owned-secret-do-not-send',
        },
      });
      const proposalCase = (source) => ({
        entryUrl: target,
        title: '保存测试数据',
        summary: goal,
        preconditions: [],
        outline: ['点击保存', '检查已保存提示'],
        criteria: [
          {
            id: 'saved',
            kind: 'semantic',
            description: goal,
            sourceKind: 'user_spec',
            sourceRef: source.ref,
            sourceQuote: goal,
            locator: null,
            expectedValue: null,
          },
        ],
      });
      const transport = async (_url, init) => {
        calls++;
        const wire = String(init.body);
        assert.ok(!wire.includes('owned-secret-do-not-send'));
        const body = JSON.parse(wire);
        const text = (m) =>
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p) => p.text ?? '').join('\n');
        const system = body.messages
          .filter((m) => m.role === 'system')
          .map(text)
          .join('\n');
        const json = body.messages
          .flatMap((m) =>
            typeof m.content === 'string' ? [{ text: m.content }] : m.content,
          )
          .map((part) => part.text)
          .map((value) => {
            try {
              return JSON.parse(value);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        let data = { done: true, toolCalls: [] };
        if (system.includes('只输出 SessionDecision JSON')) {
          const context = json.find((p) => p.session);
          const source = context.sources.find(
            (p) => p.kind === 'user_spec' && p.text.includes(goal),
          );
          data = {
            action: 'finish',
            rationale: '按已完成记录收尾，不重复保存',
            exploreTargets: [],
            cases: [],
            coverageGaps: [],
          };
          if (context.taskIntent === 'plan') {
            data.action = 'dispatch';
            data.cases = [proposalCase(source)];
          } else if (!source) {
            data.action = 'ask';
            data.question = '保存后的预期是什么？';
          } else if (!context.cases.length) {
            data.action = 'dispatch';
            data.cases = [proposalCase(source)];
          } else
            assert.ok(
              context.sources.some((p) => p.text.includes('不要重复保存')),
              'next planning receives the live message',
            );
        } else if (system.includes('只输出 SessionConclusion JSON')) {
          const context = json.find((p) => p.cases);
          data = {
            overview: '按实际记录总结本轮测试',
            caseComments: context.cases.map((p) => ({
              caseId: p.caseId,
              comment: p.outcome,
            })),
            coverageGaps: [],
          };
        } else if (system.includes('role=assertion')) {
          const input = json.find((p) => p.criterion);
          data = {
            criterionId: input.criterion.id,
            result: input.observation.nodes.some((n) =>
              `${n.name} ${n.text}`.includes('已保存'),
            )
              ? 'passed'
              : 'failed',
            reason: '当前页面保存提示',
            evidenceRefs: input.ownedEvidence,
          };
        } else if (/role=(executor|reproducer)/.test(system)) {
          const input = json.filter((p) => p.assignedCase).at(-1);
          if (
            input &&
            !input.observation.nodes.some((n) =>
              `${n.name} ${n.text}`.includes('已保存'),
            )
          ) {
            if (!injectedMessage) {
              injectedMessage = true;
              const runId = input.assignedCase.runId;
              const current = await api.runRepo.get(actor, project.id, runId);
              const reply = await request.post(
                `${api.publicOrigin}/api/v1/runs/${runId}/messages`,
                {
                  data: {
                    text: '补充：不要重复保存',
                    expectedContextVersion: current.contextVersion,
                  },
                },
              );
              assert.equal(reply.status(), 202, await reply.text());
              assert.equal(
                (await reply.json()).contextVersion,
                current.contextVersion,
                'live message must preserve browser authority',
              );
            }
            const node = input.observation.nodes.find(
              (n) => n.role === 'button' && n.name === '保存',
            );
            assert.ok(node);
            data = {
              done: false,
              toolCalls: [
                {
                  name: 'click',
                  args: {
                    target: {
                      snapshotId: input.observation.snapshotId,
                      pageId: input.observation.pageId,
                      nodeId: node.nodeId,
                      frameId: node.frameId,
                    },
                  },
                },
              ],
            };
          }
        }
        return new Response(
          JSON.stringify({
            model: 'session-wire',
            choices: [
              {
                finish_reason: 'stop',
                message: { content: JSON.stringify(data) },
              },
            ],
            usage: { prompt_tokens: 80, completion_tokens: 180 },
          }),
          { status: 200 },
        );
      };
      const coordinator = new Coordinator({
        db,
        vault,
        serviceActor: actor,
        platformSlots: 2,
        projectSlots: 2,
      });
      const artifacts = new ArtifactStore(join(scratch, 'artifacts'));
      const options = createWorkerModelOptions({
        transport,
        load: (id, version) =>
          models.readVersion(actor, id, version, project.id),
      });
      browser = new BrowserManager();
      const workers = [0, 1].map(
        (slot) =>
          new Worker({
            runtime: new RuntimeClient(
              coordinator,
              { projectId: project.id, workerId: `session-fixture-${slot}` },
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
        viewport: { width: 1440, height: 1050 },
      });
      request = ui.request;
      assert.equal(
        (
          await ui.request.post(`${origin}/api/v1/auth/login`, {
            data: {
              email: member.email,
              password: 'OwnedConversationMember123!',
            },
          })
        ).status(),
        200,
      );

      const check = async (response, status) => {
        assert.equal(
          response.status(),
          status,
          response.status() === status ? undefined : await response.text(),
        );
        return response;
      };
      const start = async (extra = {}) => {
        const response = await request.post(`${origin}/api/v1/runs`, {
          headers: { 'Idempotency-Key': randomUUID() },
          data: {
            projectId: project.id,
            targetUrl: target,
            modelProfileId: model.id,
            environmentId: env.id,
            taskIntent: 'flow',
            budget: {
              maxCases: 2,
              maxPages: 1,
              maxModelCalls: 20,
              maxActionsPerCase: 8,
            },
            ...extra,
          },
        });
        await check(response, 202);
        return response.json();
      };
      const advance = async (id, stopAtInput = false) => {
        for (let i = 0; i < 18; i++) {
          await coordinator.tick(project.id);
          const current = await api.runRepo.get(actor, project.id, id);
          if (
            ['completed', 'cancelled', 'failed'].includes(current.status) ||
            (stopAtInput && current.status === 'awaiting_input')
          )
            return current;
          await workers[0].once();
        }
        assert.fail('scenario did not reach its expected boundary');
      };
      const run = await start({
        actionPolicy: 'approved_workflows',
        writeScope: [target],
      });
      await advance(run.id, true);
      const inputs = await (
        await request.get(`${origin}/api/v1/runs/${run.id}/inputs`)
      ).json();
      assert.equal(inputs.items.length, 1);
      assert.equal(inputs.items[0].kind, 'clarification');
      const page = await ui.newPage();
      await page.goto(`${origin}/#/workbench?runId=${run.id}`);
      await page.getByTestId('input-request-input').waitFor();
      await page.reload();
      await page.getByTestId('input-request-input').fill(goal);
      const response = page.waitForResponse((r) =>
        r.url().endsWith(`/inputs/${inputs.items[0].id}/respond`),
      );
      await page.getByTestId('btn-submit-input-response').click();
      await check(await response, 200);
      const completed = await advance(run.id);
      assert.equal(completed.terminationReason, 'normal');
      assert.equal(
        saves,
        1,
        'live message cannot interrupt or replay the submitted save',
      );
      const report = await (
        await request.get(`${origin}/api/v1/runs/${run.id}/report`)
      ).json();
      assert.equal(
        report.summary.passed,
        1,
        JSON.stringify({
          summary: report.summary,
          cases: report.cases.map((c) => ({
            outcome: c.outcome,
            verdict: c.verdict,
          })),
        }),
      );
      assert.equal(report.cleanupStatus, 'manual_required');
      const messages = await (
        await request.get(`${origin}/api/v1/runs/${run.id}/messages`)
      ).json();
      assert.equal(messages.items.length, 2);
      assert.ok(messages.items.some((m) => m.redactedText.includes(goal)));
      await page.reload();
      await page.getByTestId('input-run-message').fill('继续检查组织页面');
      const continued = page.waitForResponse((r) =>
        r.url().endsWith(`/runs/${run.id}/follow-up`),
      );
      await page.getByTestId('btn-send-message').click();
      const nextResponse = await continued;
      await check(nextResponse, 202);
      const next = await nextResponse.json();
      assert.notEqual(next.id, run.id);
      assert.equal(next.effectiveConfig.previousRunId, run.id);
      assert.deepEqual(next.effectiveConfig.writeScope, [target]);
      await request.post(`${origin}/api/v1/runs/${next.id}/cancel`);
      await coordinator.tick(project.id);
      const plan = await start({ taskIntent: 'plan', brief: goal });
      const planned = await advance(plan.id);
      assert.equal(planned.terminationReason, 'normal');
      assert.equal(saves, 1);
      const plannedReport = await (
        await request.get(`${origin}/api/v1/runs/${plan.id}/report`)
      ).json();
      assert.equal(plannedReport.summary.planned, 1);
      assert.equal(plannedReport.summary.attempted, 0);
      const tasks = await (
        await request.get(`${origin}/api/v1/runs/${plan.id}/tasks`)
      ).json();
      assert.ok(
        tasks.items.every((task) =>
          ['coordinator', 'finalizer'].includes(task.role),
        ),
      );
      // A preflight request restores the real profile picker and binds only a live approved profile.
      const blocked = await start();
      await coordinator.tick(project.id);
      const scope = { projectId: project.id, workerId: 'owned-auth-input' };
      const lease = await coordinator.claim(scope);
      assert.ok(lease);
      const proof = {
        taskId: lease.task.id,
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
        contextVersion: lease.contextVersion,
      };
      const needed = await coordinator.waitForInput(
        scope,
        proof,
        'auth_profile',
        '选择登录账号',
        300000,
      );
      await page.goto(`${origin}/#/workbench?runId=${blocked.id}`);
      await page.reload();
      await page.getByTestId('input-auth-profile').selectOption(auth.id);
      const provided = page.waitForResponse((r) =>
        r.url().endsWith(`/inputs/${needed.id}/respond`),
      );
      await page.getByTestId('btn-submit-input-response').click();
      await check(await provided, 200);
      const resumed = await api.runRepo.get(actor, project.id, blocked.id);
      assert.equal(resumed.status, 'running');
      assert.equal(resumed.effectiveConfig.authProfileVersion, auth.version);
      assert.equal(
        resumed.contextVersion,
        2,
        'real auth changes advance authority',
      );
      const pending = await (
        await request.get(`${origin}/api/v1/runs/${blocked.id}/inputs`)
      ).json();
      assert.equal(pending.items.length, 0);
      await request.post(`${origin}/api/v1/runs/${blocked.id}/cancel`);
      await coordinator.tick(project.id);
      await page.goto(`${origin}/#/home`);
      await page.getByTestId('task-intents').waitFor();
      assert.equal(
        await page.getByTestId('task-intents').getByRole('button').count(),
        6,
      );
      await page.getByTestId('task-intent-plan').click();
      assert.equal(await page.getByTestId('allow-business-writes').count(), 0);
      console.log(
        `CONVERSATION_ACCEPTED: modelCalls=${calls}; non-admin project owner + real pending request after refresh + reply in planner context + one scoped save with live message + plan-only zero browser work + follow-up + auth profile resume`,
      );
    } finally {
      await uiBrowser?.close();
      await browser?.close();
      await proxy?.closeAll();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      if (fixture) {
        fixture.closeAllConnections();
        await new Promise((resolve) => fixture.close(resolve));
      }
      await api?.db.close();
      await db?.close();
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
