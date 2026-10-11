// Agent (Mo-style) sign-in against real PostgreSQL 18 and real Chromium.
// Production paths: ConfigurationRepository, Coordinator, server action gate,
// BoundModel + gateway + OpenAI adapter, Worker.once auth and imported explore.
// Only the provider transport is a scripted fake (no external model), so this
// proves the plumbing and the privacy boundary, not real model semantics.
//
// Database: LOCALQA_TEST_DATABASE_URL (an empty, disposable database), or a
// throwaway postgres:18-alpine container started through the Docker CLI.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  AccountsRepository,
  ConfigurationRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  SecretVault,
  migrate,
} from '@localqa/storage';
import { BrowserManager } from '@localqa/browser';
import { AGENT_LOGIN_CRITERION, DEFAULT_LIMITS } from '@localqa/domain';
import {
  ArtifactStore,
  Coordinator,
  RuntimeClient,
  createWorkerModelOptions,
} from '@localqa/orchestrator';
import { Worker } from '../dist/index.js';

const account = 'agent-user@fixture.test';
const password = `pw-${randomBytes(6).toString('hex')}`;

function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0) throw new Error(`Docker command failed: ${args[0]}`);
  return result.stdout.trim();
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString('utf8');
    if (text.length > 8192) break;
  }
  return new URLSearchParams(text);
}

/**
 * Scripted OpenAI-compatible transport. It reads only what the platform sent:
 * the redacted observation and history. It never knows a credential value.
 */
function scriptedTransport(log, trace) {
  const reply = (content) => {
    trace.push({ reply: content });
    return new Response(
      JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        model: 'scripted-agent',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(content) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const texts = (message) =>
    typeof message.content === 'string'
      ? [message.content]
      : message.content.map((part) => part.text ?? '');
  const step = (action, variable = null, nodeId = null) =>
    reply({ action, variable, nodeId, frameId: null, reason: null });
  return async (_url, init) => {
    const text = String(init?.body ?? '');
    log.push(text);
    const request = JSON.parse(text);
    const all = request.messages.flatMap(texts);
    if (!all.some((part) => part.includes('role=auth_agent')))
      return reply({ done: true, toolCalls: [] });
    const user = JSON.parse(
      all.find(
        (part) => part.startsWith('{') && part.includes('"observation"'),
      ),
    );
    const nodes = user.observation.nodes;
    const last = user.history.at(-1);
    trace.push({
      url: user.observation.url,
      roles: nodes.map((node) => node.role).join(','),
      last: last ? `${last.action}:${last.variable ?? ''}` : null,
      issue: user.issue,
    });
    const passwordField = nodes.find((node) => node.role === 'password');
    const emailField = nodes.find((node) => node.role === 'email');
    const button = nodes.find((node) => node.role === 'button');
    if (passwordField && last?.variable !== 'QA_PASSWORD')
      return step('fill', 'QA_PASSWORD', passwordField.nodeId);
    if (emailField && last?.variable !== 'QA_USERNAME')
      return step('fill', 'QA_USERNAME', emailField.nodeId);
    if (button) return step('click', null, button.nodeId);
    return step('done');
  };
}

test(
  'agent sign-in: two-step login, server oracle, captured state imported by explore',
  { timeout: 180000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'localqa-agent-auth-'));
    let containerId = null;
    let db;
    let browser;
    let fixture;
    let dashboardWithSession = 0;
    let dashboardWithoutSession = 0;
    const sessions = new Set();
    const transportLog = [];
    const trace = [];
    try {
      // Two-step login: email, then a password page. A fixed username/password
      // selector profile cannot express this; the agent follows instructions.
      fixture = createServer(async (req, res) => {
        const html = (status, markup, headers = {}) => {
          res.writeHead(status, { 'content-type': 'text/html', ...headers });
          res.end(`<!doctype html><title>Fixture</title>${markup}`);
        };
        if (req.method === 'GET' && req.url === '/login') {
          html(
            200,
            '<form method="POST" action="/login/next">' +
              // No test ids or aria labels: located by placeholder.
              '<input type="email" name="email" placeholder="Email">' +
              '<button type="submit">Next</button></form>',
          );
        } else if (req.method === 'POST' && req.url === '/login/next') {
          const email = (await body(req)).get('email');
          if (email !== account) return html(404, '<p>Unknown account</p>');
          html(
            200,
            '<form method="POST" action="/session">' +
              `<input type="hidden" name="email" value="${account}">` +
              // Only a wrapping label: located as the page's single password field.
              '<label>Password <input type="password" name="password"></label>' +
              '<button type="submit">Sign in</button></form>',
          );
        } else if (req.method === 'POST' && req.url === '/session') {
          const form = await body(req);
          if (
            form.get('email') !== account ||
            form.get('password') !== password
          )
            return html(401, '<p>Invalid credentials</p>');
          const sid = randomUUID();
          sessions.add(sid);
          res.writeHead(303, {
            location: '/dashboard',
            'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`,
          });
          res.end();
        } else if (req.url === '/dashboard') {
          const sid = /sid=([0-9a-f-]+)/.exec(req.headers.cookie ?? '')?.[1];
          if (sid && sessions.has(sid)) {
            dashboardWithSession++;
            html(
              200,
              `<main data-testid="logged-in">Signed in as ${account}</main><a href="/logout">Sign out</a>`,
            );
          } else {
            dashboardWithoutSession++;
            res.writeHead(302, { location: '/login' }).end();
          }
        } else res.writeHead(404).end();
      });
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      const origin = `http://127.0.0.1:${fixture.address().port}`;

      let connection = process.env.LOCALQA_TEST_DATABASE_URL;
      if (!connection) {
        const pgPassword = randomBytes(24).toString('hex');
        const envPath = join(dir, 'postgres.env');
        writeFileSync(
          envPath,
          `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${pgPassword}\n`,
          { mode: 0o600 },
        );
        containerId = docker([
          'run',
          '--detach',
          '--name',
          `localqa-agent-auth-${randomUUID().slice(0, 10)}`,
          '--publish',
          '127.0.0.1::5432',
          '--env-file',
          envPath,
          'postgres:18-alpine',
        ]);
        const port = docker(['port', containerId, '5432/tcp'])
          .split(':')
          .at(-1);
        connection = `postgresql://localqa:${pgPassword}@127.0.0.1:${port}/localqa`;
      }
      let migrated = false;
      for (let i = 0; i < 65 && !migrated; i++) {
        try {
          await migrate(
            connection,
            new URL('../../../packages/storage/migrations/', import.meta.url),
          );
          migrated = true;
        } catch {
          await delay(300);
        }
      }
      assert.equal(migrated, true, 'PostgreSQL must be migrated');
      const vault = new SecretVault(1, new Map([[1, randomBytes(32)]]));
      db = new Database(connection);
      const owner = await new AccountsRepository(db).bootstrap({
        email: `agent-${randomUUID()}@localqa.test`,
        displayName: 'Agent Auth Owner',
        password: 'IsolatedAgentAuthPassword123!',
      });
      const actor = { userId: owner.id };
      const project = await new ProjectRepository(db).create(actor, {
        name: `Agent Auth ${randomUUID()}`,
      });
      const modelRepo = new ModelRepository(db, vault);
      const model = await modelRepo.create(actor, {
        name: 'Scripted agent model',
        endpoint: 'https://scripted-agent.invalid/v1',
        configuredModelId: 'scripted-agent',
        adapter: 'openai_compatible',
        responseFormat: 'json_object',
        dataBoundary: 'internal',
        apiKey: 'scripted-agent-key',
      });
      // Bound models must have a recorded probe; the scripted transport
      // supports structured output.
      const probed = await modelRepo.recordProbe(
        actor,
        model.id,
        model.version,
        {
          capabilities: {
            structuredOutput: true,
            nativeTools: false,
            imageInput: false,
          },
          status: 'ready',
        },
      );
      await modelRepo.grant(actor, project.id, model.id);
      const modelOptions = createWorkerModelOptions({
        transport: scriptedTransport(transportLog, trace),
        allowTestStub: false,
        load: (id, version) =>
          modelRepo.readVersion(actor, id, version, project.id),
      });

      const configs = new ConfigurationRepository(db, vault);
      const agentConfig = {
        loginUrl: `${origin}/login`,
        instructions:
          '先在 Email 填 QA_USERNAME 并点 Next，再在密码页填 QA_PASSWORD 并点 Sign in。',
        variables: [
          { name: 'QA_USERNAME', sensitive: false, note: '测试账号' },
          { name: 'QA_PASSWORD', sensitive: true },
        ],
      };
      const base = {
        name: 'Agent sign-in',
        mode: 'agent',
        allowedOrigins: [origin],
        sharingPolicy: 'exclusive_run',
      };
      // Storage rules: every variable has exactly one non-empty value.
      for (const [input, code] of [
        [
          { agentConfig, secretInput: { QA_USERNAME: account } },
          'VALIDATION_ERROR',
        ],
        [
          {
            agentConfig,
            secretInput: {
              QA_USERNAME: account,
              QA_PASSWORD: password,
              X: 'y',
            },
          },
          'VALIDATION_ERROR',
        ],
        [
          {
            agentConfig: {
              ...agentConfig,
              variables: [agentConfig.variables[0], agentConfig.variables[0]],
            },
            secretInput: { QA_USERNAME: account },
          },
          'VALIDATION_ERROR',
        ],
        [
          {
            agentConfig: {
              ...agentConfig,
              loginUrl: 'https://elsewhere.test/',
            },
            secretInput: { QA_USERNAME: account, QA_PASSWORD: password },
          },
          'TARGET_NOT_ALLOWED',
        ],
      ])
        await assert.rejects(
          configs.createAuthProfile(actor, project.id, { ...base, ...input }),
          (error) => error.code === code,
        );
      const profile = await configs.createAuthProfile(actor, project.id, {
        ...base,
        agentConfig,
        secretInput: { QA_USERNAME: account, QA_PASSWORD: password },
      });
      assert.equal(profile.mode, 'agent');
      assert.deepEqual(profile.agentConfig, agentConfig);
      assert.ok(!JSON.stringify(profile).includes(password));

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
      const run = await coordinator.start(
        actor,
        {
          projectId: project.id,
          targetUrl: `${origin}/dashboard`,
          authProfileId: profile.id,
        },
        {
          allowedOrigins: [origin],
          actionPolicy: 'non_submitting',
          budget: DEFAULT_LIMITS,
          environmentVersion: null,
          authProfileVersion: profile.version,
          knowledgeVersionIds: [],
          models: Object.fromEntries(
            roles.map((role) => [
              role,
              { profileId: model.id, version: probed.version },
            ]),
          ),
        },
        randomUUID(),
      );
      const runtime = new RuntimeClient(
        coordinator,
        { projectId: project.id, workerId: `agent-worker-${randomUUID()}` },
        new ArtifactStore(join(dir, 'artifacts')),
        modelOptions,
      );
      // Diagnostics: auth service calls and their constant error codes only.
      const authCalls = [];
      let lastBinding = null;
      for (const name of Object.getOwnPropertyNames(
        Object.getPrototypeOf(runtime),
      ).filter((key) => /auth/i.test(key))) {
        const original = runtime[name].bind(runtime);
        runtime[name] = async (...args) => {
          try {
            const value = await original(...args);
            authCalls.push(name);
            if (name === 'activateAuthSession') lastBinding = value;
            if (name === 'grantAuthImport' && lastBinding)
              authCalls.push(
                `grantCheck:${JSON.stringify({
                  kind: value.kind,
                  mismatched: Object.keys(lastBinding).filter(
                    (key) => value[key] !== lastBinding[key],
                  ),
                  deadline: value.deadline,
                  expiresAt: lastBinding.expiresAt,
                  now: new Date().toISOString(),
                })}`,
              );
            return value;
          } catch (error) {
            authCalls.push(`${name}!${error?.code ?? error?.name}`);
            throw error;
          }
        };
      }
      const preflight = await runtime.claim();
      assert.equal(preflight?.task.summary, 'preflight');
      await runtime.finish(
        {
          taskId: preflight.task.id,
          leaseToken: preflight.leaseToken,
          fencingToken: preflight.fencingToken,
          contextVersion: preflight.contextVersion,
        },
        { stage: 'preflight', checked: true },
      );
      await coordinator.tick(project.id);

      browser = new BrowserManager();
      const worker = new Worker({
        runtime,
        browser,
        scratch: join(dir, 'scratch'),
        heartbeatMs: 250,
        leaseSeconds: 45,
        pollMs: 250,
      });
      assert.equal(await worker.once(), true, 'auth job must run');
      const auth = await db.actor(actor, async (client) => {
        const job = (
          await client.query(
            "SELECT id,status FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='auth'",
            [project.id, run.id],
          )
        ).rows[0];
        const slots = (
          await client.query(
            'SELECT action,slot FROM auth_action_requests WHERE project_id=$1 AND task_id=$2 ORDER BY created_at,id',
            [project.id, job.id],
          )
        ).rows;
        const gates = (
          await client.query(
            'SELECT criterion_id,result FROM auth_success_gates WHERE project_id=$1 AND task_id=$2',
            [project.id, job.id],
          )
        ).rows;
        const calls = (
          await client.query(
            'SELECT count(*)::integer AS n FROM model_requests WHERE project_id=$1 AND run_id=$2',
            [project.id, run.id],
          )
        ).rows[0].n;
        return { job, slots, gates, calls };
      });
      if (auth.job.status !== 'succeeded') {
        // Constant codes and page shapes only: no values are ever traced.
        const detail = await db.actor(actor, async (client) => ({
          run: (
            await client.query(
              'SELECT status,phase,termination_reason FROM runs WHERE id=$1',
              [run.id],
            )
          ).rows[0],
          session: (
            await client.query(
              'SELECT status,end_reason FROM auth_execution_sessions WHERE project_id=$1 AND task_id=$2',
              [project.id, auth.job.id],
            )
          ).rows,
          models: (
            await client.query(
              "SELECT status,redacted_diagnostic->>'requestResult' AS result,redacted_diagnostic->>'errorCode' AS code FROM model_requests WHERE project_id=$1 AND run_id=$2",
              [project.id, run.id],
            )
          ).rows,
        }));
        console.log(
          JSON.stringify({ ...detail, slots: auth.slots, trace, authCalls }),
        );
      }
      assert.equal(auth.job.status, 'succeeded');
      assert.deepEqual(
        auth.slots.map((row) => `${row.action}:${row.slot}`).sort(),
        [
          'fill_credential:variable',
          'fill_credential:variable',
          'navigate_auth:login_url',
          'submit_auth:submit',
          'submit_auth:submit',
        ],
      );
      assert.deepEqual(auth.gates, [
        { criterion_id: AGENT_LOGIN_CRITERION.id, result: 'passed' },
      ]);
      assert.equal(auth.calls, 5, 'two fills, two clicks and done');

      // The captured state is imported by an ordinary exploration task.
      assert.equal(
        dashboardWithSession,
        1,
        'auth landed on the dashboard once',
      );
      await coordinator.tick(project.id);
      assert.equal(await worker.once(), true, 'explore job must run');
      if (dashboardWithSession < 2) {
        const detail = await db.actor(actor, async (client) => ({
          run: (
            await client.query(
              'SELECT status,phase,termination_reason FROM runs WHERE id=$1',
              [run.id],
            )
          ).rows[0],
          jobs: (
            await client.query(
              "SELECT document->>'summary' AS stage,status,result FROM jobs WHERE project_id=$1 AND run_id=$2",
              [project.id, run.id],
            )
          ).rows,
          intents: (
            await client.query(
              "SELECT tool_call->>'name' AS name,outcome FROM action_intents WHERE project_id=$1 AND run_id=$2 ORDER BY id",
              [project.id, run.id],
            )
          ).rows,
        }));
        console.log(JSON.stringify({ explore: detail, authCalls }));
      }
      assert.ok(dashboardWithSession >= 2, 'explore used the captured session');
      assert.equal(dashboardWithoutSession, 0, 'no anonymous dashboard visit');
      const explore = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              "SELECT status FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='explore'",
              [project.id, run.id],
            )
          ).rows[0],
      );
      assert.equal(explore.status, 'succeeded');

      // Privacy boundary: the sensitive value never reaches any provider
      // request, and sign-in requests carry no variable value at all. Later
      // exploration may see the account name the application itself renders
      // (it was declared non-sensitive), exactly as with form sign-in.
      const signIn = transportLog.filter((request) =>
        request.includes('role=auth_agent'),
      );
      assert.equal(signIn.length, 5);
      assert.ok(
        transportLog.length > signIn.length,
        'explore called the model',
      );
      for (const request of transportLog)
        assert.ok(!request.includes(password), 'password reached the model');
      for (const request of signIn)
        assert.ok(!request.includes(account), 'a value reached sign-in');
      console.log(
        `Real PG 18 + Chromium: agent sign-in ${auth.slots.length} private actions, ${auth.calls} model calls, gate=${AGENT_LOGIN_CRITERION.id}, explore imported state (dashboard views=${dashboardWithSession})`,
      );
    } finally {
      await browser?.close();
      await db?.close();
      if (fixture) {
        fixture.close();
        await once(fixture, 'close').catch(() => {});
      }
      if (containerId)
        spawnSync('docker', ['rm', '--force', '--volumes', containerId], {
          encoding: 'utf8',
          timeout: 30000,
        });
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
