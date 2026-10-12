// Docker development verification: disposable database, owned web fixture,
// real Chromium and private auth ledger. Real provider is opt-in explicitly.
import assert from 'node:assert/strict';
import { scriptedSessionResponse } from './fixtures/session-wire.mjs';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import pg from '../../../packages/storage/node_modules/pg/lib/index.js';
import {
  AccountsRepository,
  ConfigurationRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  migrate,
} from '@localqa/storage';
import { BrowserManager } from '@localqa/browser';
import { DEFAULT_LIMITS } from '@localqa/domain';
import {
  ArtifactStore,
  Coordinator,
  RuntimeClient,
  createWorkerModelOptions,
} from '@localqa/orchestrator';
import { Worker } from '../dist/index.js';
import { loadDatabaseUrl } from '../../../deploy/images/database-url.mjs';
import { loadProtectedKek } from '../../../deploy/images/kek.mjs';

const real = process.env.AUTH_AI_REAL_MODEL === '1';
const ui = process.env.AUTH_AI_UI === '1';
const scenario = process.env.AUTH_AI_SCENARIO ?? 'ordinary';
assert.ok(['ordinary', 'two_step', 'wrong_password', 'otp'].includes(scenario));

test(
  `AI login: ${scenario} (${real ? 'real provider' : 'wire fixture'})`,
  { timeout: 210000 },
  async () => {
    const baseConnection = await loadDatabaseUrl();
    const vault = await loadProtectedKek();
    const sourceDb = new Database(baseConnection);
    const adminConnection = new pg.Client({ connectionString: baseConnection });
    const dbName = `localqa_ai_auth_test_${randomBytes(8).toString('hex')}`;
    assert.match(dbName, /^localqa_ai_auth_test_[a-f0-9]{16}$/);
    assert.notEqual(new URL(baseConnection).pathname, `/${dbName}`);
    let created = false,
      db,
      browser,
      fixture,
      apiContext,
      apiServer,
      uiProxy,
      uiBrowser;
    const scratch = await mkdtemp(join(tmpdir(), 'localqa-auth-ai-'));
    const username = `fixture-user-${randomBytes(8).toString('hex')}`;
    const password = `fixture-pass-${randomBytes(8).toString('hex')}`;
    const otp = randomBytes(4).toString('hex');
    let dashboardViews = 0,
      loginPosts = 0;
    try {
      let sourceModel;
      if (real) {
        const ownerId = await sourceDb.auth(
          async (c) =>
            (
              await c.query(
                "SELECT id FROM users WHERE global_role='admin' AND NOT disabled ORDER BY created_at LIMIT 1",
              )
            ).rows[0].id,
        );
        const row = await sourceDb.actor(
          { userId: ownerId },
          async (c) =>
            (
              await c.query(
                'SELECT id,version FROM model_profiles ORDER BY created_at LIMIT 1',
              )
            ).rows[0],
        );
        sourceModel = await new ModelRepository(sourceDb, vault).readVersion(
          { userId: ownerId },
          row.id,
          row.version,
        );
      }
      await adminConnection.connect();
      await adminConnection.query(`CREATE DATABASE "${dbName}"`);
      created = true;
      const connection = new URL(baseConnection);
      connection.pathname = `/${dbName}`;
      await migrate(
        connection.href,
        new URL('../../../packages/storage/migrations/', import.meta.url),
      );
      db = new Database(connection.href);
      const owner = await new AccountsRepository(db).bootstrap({
        email: 'ai-auth-owner@localqa.test',
        displayName: 'AI Auth Owner',
        password: 'OwnedAuthFixtureAdmin123!',
      });
      const actor = { userId: owner.id };
      fixture = createServer(async (req, res) => {
        const cookies = req.headers.cookie ?? '';
        const html = (text) => {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(text);
        };
        const userInput =
          '<label>邮箱或工号<input name="account" autocomplete="username"></label>';
        const passInput =
          '<label>登录口令<input type="password" name="phrase" autocomplete="current-password"></label>';
        const search = '<input type="search" aria-label="搜索帮助">';
        if (req.url === '/login') {
          html(
            `<title>登录测试系统</title>${search}<h1>测试系统登录</h1><form method="POST" action="${scenario === 'two_step' ? '/next' : '/session'}">${userInput}${scenario === 'two_step' ? '' : passInput}<button type="submit">${scenario === 'two_step' ? '下一步' : '登录'}</button></form>`,
          );
        } else if (req.url === '/password' && cookies.includes('preauth=1')) {
          html(
            `<title>输入登录口令</title><form method="POST" action="/session">${passInput}<button type="submit">登录</button></form>`,
          );
        } else if (req.url === '/next' || req.url === '/session') {
          let raw = '';
          for await (const part of req) raw += part.toString('utf8');
          const fields = new URLSearchParams(raw);
          if (req.url === '/next') {
            assert.equal(fields.get('account'), username);
            res
              .writeHead(303, {
                'set-cookie': 'preauth=1; HttpOnly; Path=/',
                location: '/password',
              })
              .end();
          } else {
            loginPosts++;
            const userOk =
              scenario === 'two_step'
                ? cookies.includes('preauth=1')
                : fields.get('account') === username;
            const passOk = fields.get('phrase') === password;
            if (userOk && passOk)
              res
                .writeHead(303, {
                  'set-cookie': `${scenario === 'otp' ? 'pending_otp' : 'authed'}=1; HttpOnly; Path=/`,
                  location: scenario === 'otp' ? '/otp' : '/dashboard',
                })
                .end();
            else
              html(
                `<h1>账号或密码错误</h1><form method="POST" action="/session">${userInput}${passInput}<button type="submit">登录</button></form>`,
              );
          }
        } else if (req.url === '/otp' && cookies.includes('pending_otp=1')) {
          html(
            '<title>输入动态验证码</title><h1>输入动态验证码</h1><form method="POST" action="/verify-code"><label>动态验证码<input type="tel" name="pin" autocomplete="one-time-code"></label><button type="submit">验证</button></form>',
          );
        } else if (req.url === '/verify-code') {
          let raw = '';
          for await (const part of req) raw += part.toString('utf8');
          assert.equal(new URLSearchParams(raw).get('pin'), otp);
          res
            .writeHead(303, {
              'set-cookie': 'authed=1; HttpOnly; Path=/',
              location: '/dashboard',
            })
            .end();
        } else if (req.url === '/dashboard' && cookies.includes('authed=1')) {
          dashboardViews++;
          html(
            '<title>业务控制台</title><main><h1>库存管理控制台</h1><a href="/logout">退出登录</a><p>当前库存：12</p></main>',
          );
        } else {
          res.writeHead(303, { location: '/login' }).end();
        }
      });
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      const origin = `http://127.0.0.1:${fixture.address().port}`;
      const project = await new ProjectRepository(db).create(actor, {
        name: 'AI Login Owned Fixture',
      });
      const models = new ModelRepository(db, vault);
      const model = await models.create(actor, {
        name: 'AI Login Validation',
        endpoint:
          sourceModel?.document.endpoint ?? 'https://wire-auth-fixture.test/v1',
        configuredModelId:
          sourceModel?.document.configuredModelId ?? 'fixture-auth-model',
        adapter: sourceModel?.document.adapter ?? 'openai_compatible',
        responseFormat: 'json_object',
        dataBoundary: real ? 'external' : 'internal',
        apiKey: sourceModel?.apiKey ?? 'owned-provider-fixture-key',
      });
      const modelReady = await models.recordProbe(
        actor,
        model.id,
        model.version,
        {
          capabilities: {
            structuredOutput: true,
            nativeTools: false,
            imageInput: false,
          },
          status: 'degraded',
        },
      );
      await models.grant(actor, project.id, model.id);
      let modelCalls = 0;
      const transport = async (url, init) => {
        const wire = String(init.body);
        assert.ok(
          !wire.includes(username) &&
            !wire.includes(password) &&
            !wire.includes(otp),
          'known auth material must not reach provider',
        );
        modelCalls++;
        if (real) return globalThis.fetch(url, init);
        const body = JSON.parse(wire);
        const system =
          body.messages.find((m) => m.role === 'system')?.content?.[0]?.text ??
          '';
        const observation = body.messages
          .flatMap((m) => m.content)
          .find(
            (part) => part.type === 'text' && part.text.startsWith('{"url":'),
          );
        let data = { done: true, toolCalls: [] };
        const sessionResponse = scriptedSessionResponse(body);
        if (sessionResponse) data = sessionResponse;
        if (observation) {
          const { nodes } = JSON.parse(observation.text);
          let selected;
          if (system.includes('判断是否已经登录'))
            selected =
              nodes.find((n) => n.text === '退出登录') ??
              nodes.find(
                (n) => n.role === 'h1' && n.text === '库存管理控制台',
              ) ??
              nodes.find(
                (n) => n.role === 'main' && n.text.includes('库存管理控制台'),
              );
          else if (system.includes('密码输入框'))
            selected = nodes.find((n) => n.role === 'password');
          else if (system.includes('验证码输入框'))
            selected = nodes.find((n) => n.inputType === 'tel');
          else if (system.includes('识别登录、下一步'))
            selected = nodes.find(
              (n) =>
                (n.role === 'button' || n.inputType === 'submit') &&
                (/登录|下一步|验证/.test(n.text) || n.inputType === 'submit'),
            );
          else selected = nodes.find((n) => n.role === 'text');
          data = {
            state: selected
              ? system.includes('判断是否已经登录')
                ? 'authenticated'
                : 'found'
              : 'missing',
            nodeId: selected?.nodeId ?? null,
          };
        }
        return new Response(
          JSON.stringify({
            model: 'fixture-auth-model',
            choices: [
              {
                finish_reason: 'stop',
                message: { content: JSON.stringify(data) },
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 15 },
          }),
          { status: 200 },
        );
      };
      const modelOptions = createWorkerModelOptions({
        transport,
        load: (id, version) =>
          models.readVersion(actor, id, version, project.id),
      });
      const configs = new ConfigurationRepository(db, vault);
      const environment = await configs.createEnvironment(actor, project.id, {
        name: 'AI login environment',
        baseUrl: `${origin}/dashboard`,
        allowedOrigins: [origin],
        excludedPaths: [],
        tlsPolicy: 'strict',
      });
      let profile = await configs.createAuthProfile(actor, project.id, {
        name: 'AI account login',
        environmentId: environment.id,
        mode: 'form',
        allowedOrigins: [origin],
        sharingPolicy: 'exclusive_run',
        formConfig: { loginUrl: `${origin}/login`, detectionMode: 'ai' },
        secretInput: {
          username,
          password:
            scenario === 'wrong_password' ? `${password}-wrong` : password,
        },
      });
      let environmentVersion = environment.version;
      if (ui) {
        const { createApiContext, createApiServer } =
          await import('../../api/dist/index.js');
        const { createProxyServer } =
          await import('../../web/scripts/httpProxyHelper.mjs');
        const { chromium } =
          await import('../../../packages/browser/node_modules/playwright/index.mjs');
        apiContext = createApiContext({
          connectionString: connection.href,
          vault,
          serviceActor: actor,
          artifactsDir: join(scratch, 'api-artifacts'),
          modelTransport: transport,
        });
        apiServer = createApiServer(apiContext);
        apiServer.listen(0, '127.0.0.1');
        await once(apiServer, 'listening');
        const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
        uiProxy = await createProxyServer({
          backendOrigin: apiOrigin,
          distDir: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
        });
        await uiProxy.listen();
        uiProxy.origin = `http://127.0.0.1:${uiProxy.address().port}`;
        apiContext.publicOrigin = uiProxy.origin;
        uiBrowser = await chromium.launch({ chromiumSandbox: true });
        const context = await uiBrowser.newContext({
          viewport: { width: 1440, height: 1000 },
        });
        const login = await context.request.post(
          `${uiProxy.origin}/api/v1/auth/login`,
          {
            data: { email: owner.email, password: 'OwnedAuthFixtureAdmin123!' },
          },
        );
        assert.equal(login.status(), 200);
        const page = await context.newPage();
        await page.goto(`${uiProxy.origin}/#/environments`);
        await page.getByTestId(`btn-add-auth-${environment.id}`).click();
        await page.getByTestId('auth-profile-mode').selectOption('form');
        await page.getByTestId('auth-ai-guidance').waitFor();
        assert.equal(
          await page.locator('#auth-profile-name').getAttribute('required'),
          null,
        );
        assert.equal(await page.locator('#auth-success-value').count(), 0);
        assert.equal(
          await page.getByText('用户名输入框', { exact: true }).count(),
          0,
        );
        const legacy = await configs.createAuthProfile(actor, project.id, {
          name: 'Legacy fixed login',
          environmentId: environment.id,
          mode: 'form',
          allowedOrigins: [origin],
          sharingPolicy: 'exclusive_run',
          secretInput: { username, password },
          formConfig: {
            loginUrl: `${origin}/login`,
            usernameTarget: { by: 'css', value: 'input[name="account"]' },
            passwordTarget: { by: 'css', value: 'input[name="phrase"]' },
            submitTarget: { by: 'css', value: 'button[type="submit"]' },
            successCriterion: {
              id: 'legacy_success',
              kind: 'element_visible',
              description: 'Logout visible',
              sourceKind: 'user_spec',
              sourceRef: 'owned-fixture',
              locator: { by: 'text', value: '退出登录' },
            },
          },
        });
        await page.reload();
        await page.getByTestId(`auth-enable-ai-${legacy.id}`).waitFor();
        const patch = page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            r.url().endsWith(`/auth-profiles/${legacy.id}`),
        );
        await page.getByTestId(`auth-enable-ai-${legacy.id}`).click();
        const switched = await (await patch).json();
        assert.equal(switched.formConfig.detectionMode, 'ai');
        assert.equal(switched.hasSecret, true);
        await page.getByTestId(`btn-add-auth-${environment.id}`).click();
        await page.getByTestId('auth-profile-mode').selectOption('form');
        await page.locator('#auth-login-url').fill(`${origin}/login`);
        await page.locator('#auth-username').fill(username);
        await page.locator('#auth-password').fill(password);
        const creation = page.waitForResponse(
          (r) =>
            r.request().method() === 'POST' &&
            r.url().endsWith(`/projects/${project.id}/auth-profiles`),
        );
        const defaultPatch = page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            r.url().endsWith(`/environments/${environment.id}`),
        );
        await page.getByTestId('btn-create-auth-profile').click();
        const response = await creation;
        assert.equal(response.status(), 201);
        profile = await response.json();
        assert.deepEqual(profile.formConfig, {
          loginUrl: `${origin}/login`,
          detectionMode: 'ai',
        });
        assert.equal(profile.name, `${environment.name} 登录`);
        assert.equal(profile.hasSecret, true);
        const updated = await (await defaultPatch).json();
        assert.equal(updated.defaultAuthProfileId, profile.id);
        environmentVersion = updated.version;
        await page.getByTestId(`auth-row-${profile.id}`).waitFor();
        const screenshot =
          process.env.AUTH_AI_SCREENSHOT_PATH ??
          join(tmpdir(), `localqa-auth-ai-ui-${randomUUID()}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        console.log(
          JSON.stringify({
            ui: 'passed',
            requiredLoginFields: 3,
            automaticName: true,
            defaultCredential: true,
            legacySwitch: true,
            screenshot,
          }),
        );
      }
      const coordinator = new Coordinator({
        db,
        vault,
        serviceActor: actor,
        platformSlots: 2,
        projectSlots: 2,
        modelOptions,
      });
      const roles = [
        'coordinator',
        'explorer',
        'executor',
        'assertion',
        'reproducer',
      ];
      const config = {
        allowedOrigins: [origin],
        actionPolicy: 'non_submitting',
        budget: DEFAULT_LIMITS,
        environmentVersion,
        authProfileVersion: profile.version,
        knowledgeVersionIds: [],
        models: Object.fromEntries(
          roles.map((role) => [
            role,
            { profileId: model.id, version: modelReady.version },
          ]),
        ),
      };
      const run = await coordinator.start(
        actor,
        {
          projectId: project.id,
          targetUrl: `${origin}/dashboard`,
          environmentId: environment.id,
          authProfileId: profile.id,
        },
        config,
        randomUUID(),
      );
      const runtimeWorkerId = `ai-worker-${randomUUID()}`;
      const runtime = new RuntimeClient(
        coordinator,
        { projectId: project.id, workerId: runtimeWorkerId },
        new ArtifactStore(join(scratch, 'artifacts')),
        modelOptions,
      );
      const recognize = runtime.recognizeAuth.bind(runtime);
      runtime.recognizeAuth = async (...args) => {
        if (args[3] === 'username') {
          await assert.rejects(
            () =>
              runtime.recordAuthCriterion(
                args[0],
                args[1],
                {
                  criterionId: 'login_success',
                  result: 'passed',
                  reason: 'forged flag',
                  evidenceRefs: [args[2]],
                },
                args[2],
              ),
            (error) => error.code === 'POLICY_DENIED',
          );
        }
        const result = await recognize(...args);
        console.log(
          JSON.stringify({
            recognition: args[3],
            found: Boolean(result.target),
            success: result.success?.result,
          }),
        );
        return result;
      };
      // Make the importer heartbeat race deterministic on fast machines too.
      const importGrant = runtime.grantAuthImport.bind(runtime);
      runtime.grantAuthImport = async (proof, sessionId) => {
        const before = await runtime.authSession(proof, sessionId);
        await delay(25);
        await runtime.heartbeat(proof, 45);
        const grant = await importGrant(proof, sessionId);
        assert.ok(Date.parse(grant.expiresAt) > Date.parse(before.expiresAt));
        return grant;
      };
      const preflight = await runtime.claim();
      assert.equal(preflight.task.summary, 'preflight');
      await runtime.finish(
        {
          taskId: preflight.task.id,
          fencingToken: preflight.fencingToken,
          leaseToken: preflight.leaseToken,
          contextVersion: preflight.contextVersion,
        },
        { stage: 'preflight', checked: true },
      );
      browser = new BrowserManager();
      await coordinator.tick(project.id);
      const worker = new Worker({
        runtime,
        browser,
        scratch: join(scratch, 'worker'),
        heartbeatMs: 250,
        pollMs: 250,
        leaseSeconds: 45,
      });
      const authFlight = worker.once();
      if (scenario === 'otp') {
        let input;
        for (let attempt = 0; attempt < 200; attempt++) {
          input = await coordinator.tx(
            async (c) =>
              (
                await c.query(
                  "SELECT document FROM input_requests WHERE project_id=$1 AND run_id=$2 AND document->>'kind'='one_time_code'",
                  [project.id, run.id],
                )
              ).rows[0]?.document,
          );
          if (input) break;
          await delay(100);
        }
        assert.ok(
          input,
          'AI must request an OTP when a code field is observed',
        );
        await coordinator.authOtp.submit(
          actor,
          project.id,
          run.id,
          input.id,
          input.version,
          'provide',
          otp,
        );
      }
      assert.equal(await authFlight, true);
      const auth = await coordinator.tx(async (c) => ({
        job: (
          await c.query(
            "SELECT status FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='auth'",
            [project.id, run.id],
          )
        ).rows[0],
        scope: (
          await c.query(
            'SELECT status,current_state_id FROM run_auth_scopes WHERE project_id=$1 AND run_id=$2',
            [project.id, run.id],
          )
        ).rows[0],
        actions: (
          await c.query(
            'SELECT action,slot FROM auth_action_requests WHERE project_id=$1 AND run_id=$2 ORDER BY created_at',
            [project.id, run.id],
          )
        ).rows,
        gates: (
          await c.query(
            'SELECT count(*)::integer AS n FROM auth_success_gates WHERE project_id=$1 AND run_id=$2',
            [project.id, run.id],
          )
        ).rows[0].n,
      }));
      console.log(
        JSON.stringify({
          scenario,
          real,
          modelCalls,
          loginPosts,
          dashboardViews,
          job: auth.job.status,
          authScope: auth.scope.status,
          hasAuthState: Boolean(auth.scope.current_state_id),
          successGates: auth.gates,
          actions: auth.actions,
        }),
      );
      if (scenario === 'wrong_password') {
        assert.notEqual(auth.job.status, 'succeeded');
        assert.equal(auth.scope.current_state_id, null);
        assert.equal(auth.gates, 0);
      } else {
        assert.equal(auth.job.status, 'succeeded');
        assert.equal(auth.scope.status, 'granted');
        assert.ok(auth.scope.current_state_id);
        assert.equal(auth.gates, 1);
        assert.ok(modelCalls >= 5);
        assert.equal(loginPosts, 1);
        if (scenario === 'two_step')
          assert.equal(
            auth.actions.filter((a) => a.action === 'submit_auth').length,
            2,
          );
        const viewsBefore = dashboardViews;
        await coordinator.tick(project.id);
        assert.equal(await worker.once(), true);
        assert.ok(
          dashboardViews > viewsBefore,
          'next testing context must reuse the captured login',
        );
      }
    } finally {
      await uiBrowser?.close();
      await uiProxy?.closeAll();
      if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
      await apiContext?.db.close();
      await browser?.close();
      if (fixture) await new Promise((resolve) => fixture.close(resolve));
      await db?.close();
      await sourceDb.close();
      if (created)
        await adminConnection.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
      await adminConnection.end();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
