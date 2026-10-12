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
  'session agent: plan, concurrent cases, independent reproduction, follow-up, summary and stop guards',
  { timeout: 120000 },
  async () => {
    const base = await loadDatabaseUrl();
    const name = `localqa_session_test_${randomBytes(8).toString('hex')}`;
    assert.match(name, /^localqa_session_test_[a-f0-9]{16}$/);
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
    const goals = [
      '点击查看明细后应显示订单明细',
      '打开列表页面应显示订单列表',
    ];
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
      const project = await new ProjectRepository(db).create(actor, {
        name: 'Session fixture',
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
      fixture = createServer((_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          '<title>订单列表</title><main><h1>订单列表</h1><button type="button" onclick="document.getElementById(\'result\').textContent=\'加载失败\'">查看明细</button><div id="result"></div></main>',
        );
      });
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      const target = `http://127.0.0.1:${fixture.address().port}/`;
      const businessCase = (source, title, expected, outline) => ({
        entryUrl: target,
        title,
        summary: expected,
        preconditions: [],
        outline,
        criteria: [
          {
            id: 'business.visible',
            kind: 'semantic',
            description: expected,
            sourceKind: 'user_spec',
            sourceRef: source.ref,
            sourceQuote: expected,
            locator: null,
            expectedValue: null,
          },
        ],
      });
      const transport = async (_url, init) => {
        calls++;
        const wire = String(init.body);
        assert.ok(
          !wire.includes('OwnedSessionFixtureAdmin123!') &&
            !wire.includes('never-send-this-value'),
        );
        const body = JSON.parse(wire);
        const parts = body.messages.flatMap((m) =>
          typeof m.content === 'string'
            ? [{ type: 'text', text: m.content }]
            : m.content,
        );
        const system = body.messages
          .filter((m) => m.role === 'system')
          .map((m) =>
            typeof m.content === 'string'
              ? m.content
              : m.content.map((p) => p.text ?? '').join('\n'),
          )
          .join('\n');
        const json = parts
          .filter((p) => p.type === 'text')
          .map((p) => {
            try {
              return JSON.parse(p.text);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        let data = { done: true, toolCalls: [] };
        if (system.includes('只输出 SessionDecision JSON')) {
          const context = json.find((p) => p.session);
          const source = context.sources.find((s) => s.kind === 'user_spec');
          const round = context.session.round;
          data = {
            action: 'dispatch',
            rationale: `第${round}轮：按实际结果规划`,
            exploreTargets: [],
            cases: [],
            coverageGaps: [],
          };
          if (round === 1) data.exploreTargets = [target];
          else if (round === 2)
            data.cases = [
              businessCase(source, '明细流程', goals[0], [
                '点击查看明细',
                '检查订单明细',
              ]),
              {
                entryUrl: target,
                title: '入口可用性',
                summary: '入口内容可见',
                preconditions: [],
                outline: ['检查页面可见内容'],
                criteria: [
                  {
                    id: 'smoke.visible',
                    kind: 'element_visible',
                    description: '页面内容可见',
                    sourceKind: 'generic_smoke',
                    sourceRef: 'FR-016',
                    sourceQuote: '',
                    locator: { by: 'css', value: 'body', name: null },
                    expectedValue: null,
                  },
                ],
              },
            ];
          else if (round === 3) {
            assert.ok(
              context.findings.some((f) => f.status === 'confirmed'),
              'review must see independent reproduction',
            );
            data.cases = [
              businessCase(source, '列表补测', goals[1], ['检查订单列表']),
            ];
          } else data.action = 'finish';
        } else if (system.includes('只输出 SessionConclusion JSON')) {
          const context = json.find((p) => p.cases);
          assert.equal(context.cases.length, 3);
          data = {
            overview: '完成入口和列表验证；明细显示异常已独立复现。',
            caseComments: context.cases.map((c) => ({
              caseId: c.caseId,
              comment: c.outcome,
            })),
            coverageGaps: [],
          };
        } else if (system.includes('role=assertion')) {
          const input = json.find((p) => p.criterion);
          const expected = input.criterion.description.includes('订单明细')
            ? '订单明细'
            : '订单列表';
          const visible = input.observation.nodes.some(
            (n) => n.visible && `${n.name} ${n.text}`.includes(expected),
          );
          data = {
            criterionId: input.criterion.id,
            result: visible ? 'passed' : 'failed',
            reason: '按当前观察检查',
            evidenceRefs: input.ownedEvidence,
          };
        } else if (/role=(executor|reproducer)/.test(system)) {
          const input = json.filter((p) => p.assignedCase).at(-1);
          if (
            input?.assignedCase.title === '明细流程' &&
            !input.observation.nodes.some((n) =>
              `${n.name} ${n.text}`.includes('加载失败'),
            )
          ) {
            const node = input.observation.nodes.find(
              (n) =>
                n.role === 'button' &&
                `${n.name} ${n.text}`.includes('查看明细'),
            );
            assert.ok(
              node,
              'executor receives the assigned flow and actual observed controls',
            );
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
            usage: { prompt_tokens: 80, completion_tokens: 200 },
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
      assert.equal(
        (
          await ui.request.post(`${origin}/api/v1/auth/login`, {
            data: {
              email: owner.email,
              password: 'OwnedSessionFixtureAdmin123!',
            },
          })
        ).status(),
        200,
      );
      const start = async (budget = {}) => {
        const r = await ui.request.post(`${origin}/api/v1/runs`, {
          headers: { 'Idempotency-Key': randomUUID() },
          data: {
            projectId: project.id,
            targetUrl: target,
            modelProfileId: model.id,
            brief: goals.join('。') + '。password=never-send-this-value',
            budget: {
              maxCases: 3,
              maxPages: 1,
              maxActionsPerCase: 8,
              maxModelCalls: 30,
              maxReproductions: 1,
              ...budget,
            },
          },
        });
        assert.equal(r.status(), 202, await r.text());
        return r.json();
      };
      const run = await start();
      const page = await ui.newPage();
      await page.goto(`${origin}/#/workbench?runId=${run.id}`);
      await page.getByTestId('tab-btn-planning').click();
      await page.getByTestId('session-planning-panel').waitFor();
      let current;
      for (let i = 0; i < 35; i++) {
        await coordinator.tick(project.id);
        current = await api.runRepo.get(actor, project.id, run.id);
        if (['completed', 'cancelled', 'failed'].includes(current.status))
          break;
        await Promise.all(workers.map((worker) => worker.once()));
      }
      if (current.terminationReason !== 'normal')
        console.log(
          'SESSION_WIRE_JOBS',
          JSON.stringify(
            (
              await db.actor(actor, (c) =>
                c.query(
                  'SELECT role,status,result FROM jobs WHERE project_id=$1 AND run_id=$2',
                  [project.id, run.id],
                ),
              )
            ).rows.map((j) => ({
              role: j.role,
              status: j.status,
              stage: j.result?.stage,
              assessment: j.result?.assertionAssessment,
            })),
          ),
        );
      assert.equal(current.status, 'completed');
      assert.equal(current.terminationReason, 'normal');
      const response = await ui.request.get(
        `${origin}/api/v1/runs/${run.id}/report`,
      );
      assert.equal(response.status(), 200, await response.text());
      const report = await response.json();
      assert.deepEqual(
        [
          report.summary.planned,
          report.summary.passed,
          report.summary.issueFound,
        ],
        [3, 2, 1],
      );
      assert.equal(report.findings.length, 1);
      assert.equal(report.findings[0].status, 'confirmed');
      assert.equal(report.reproductions.length, 1);
      assert.equal(report.reproductions[0].freshContext, true);
      assert.equal(report.session.status, 'complete');
      assert.equal(report.session.round, 4);
      assert.deepEqual(
        report.session.history.map((round) => round.caseIds.length),
        [0, 2, 1, 0],
      );
      assert.ok(report.session.summary.includes('独立复现'));
      assert.equal(
        report.modelUsage.reduce((total, usage) => total + usage.requests, 0),
        calls,
      );
      await page.getByTestId('session-summary').waitFor();
      assert.ok(
        (await page.getByTestId('session-summary').innerText()).includes(
          '独立复现',
        ),
      );
      if (process.env.SESSION_SCREENSHOT)
        await page.screenshot({ path: process.env.SESSION_SCREENSHOT });
      const before = calls;
      const cancelled = await start();
      assert.equal(
        (
          await ui.request.post(`${origin}/api/v1/runs/${cancelled.id}/cancel`)
        ).status(),
        202,
      );
      await coordinator.tick(project.id);
      assert.equal(
        (await api.runRepo.get(actor, project.id, cancelled.id)).status,
        'cancelled',
      );
      assert.equal(calls, before);
      const limited = await start({ maxTotalTokens: 1000 });
      for (let i = 0; i < 4; i++) {
        await coordinator.tick(project.id);
        await workers[0].once();
      }
      const stopped = await api.runRepo.get(actor, project.id, limited.id);
      assert.equal(stopped.terminationReason, 'budget_limit');
      assert.equal(calls, before);
      console.log(
        'SESSION_AGENT_ACCEPTED: sourced business cases + independent contexts + reproduction + follow-up + truthful report + live planning UI + cancellation/budget (wire fixture)',
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
