import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fork, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { DEFAULT_LIMITS } from '@localqa/domain';
import {
  ArtifactStore,
  Coordinator,
  RuntimeClient,
  createWorkerModelOptions,
} from '@localqa/orchestrator';
import { createGateway, createOpenAIAdapter } from '@localqa/model-gateway';
import { Worker } from '../dist/index.js';
import { createApiContext, createApiServer } from '../../api/dist/index.js';
import { createProxyServer } from '../../web/scripts/httpProxyHelper.mjs';

const REAL_MODEL = process.env.LOCALQA_T19_REAL_AUTH === '1';
const T20_FAILURE = process.env.LOCALQA_T20_AUTH_FAILURE ?? '';
const T21_FAILURE = process.env.LOCALQA_T21_AUTH_FAILURE ?? '';
const T22_SCENARIO = process.env.LOCALQA_T22_OTP ?? '';
const T23_LONG_OTP = process.env.LOCALQA_T23_LONG_OTP === '1';
const T23_UI_OTP = process.env.LOCALQA_T23_WEB_OTP === '1';
const T23_CANCEL_OTP = process.env.LOCALQA_T23_CANCEL_OTP === '1';
const T24_SCENARIO = process.env.LOCALQA_T24_AUTH ?? '';
const fixtureOtp = randomBytes(4).toString('hex');
if (
  (T20_FAILURE &&
    !['expired', 'forbidden', 'revoked', 'revoked_mid'].includes(
      T20_FAILURE,
    )) ||
  (T21_FAILURE &&
    ![
      'login_redirect',
      'login_spa',
      'auth_lease_crash',
      'otp_required',
    ].includes(T21_FAILURE)) ||
  (T22_SCENARIO &&
    !['success', 'reject', 'expire', 'wrong'].includes(T22_SCENARIO)) ||
  (T24_SCENARIO &&
    ![
      'kill',
      'kill_submitted',
      'submit_race',
      'consume_race',
      'revoke_consume',
      'stale_lease',
    ].includes(T24_SCENARIO))
)
  throw new Error('INVALID_AUTH_FAILURE_SCENARIO');
function existingPiDeepSeek() {
  const path = join(
    process.env.USERPROFILE ?? process.env.HOME ?? tmpdir(),
    '.pi',
    'agent',
    'auth.json',
  );
  const entry = JSON.parse(readFileSync(path, 'utf8'))?.deepseek;
  if (entry?.type !== 'api_key' || typeof entry.key !== 'string' || !entry.key)
    throw new Error('PI_DEEPSEEK_NOT_CONFIGURED');
  return entry.key;
}

function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0) throw new Error(`Docker command failed: ${args[0]}`);
  return result.stdout.trim();
}

test(
  `isolated PostgreSQL -> Worker.once auth + imported Chromium exploration (${T24_SCENARIO || T22_SCENARIO || T21_FAILURE || T20_FAILURE || (REAL_MODEL ? 'real DeepSeek' : 'stub decision')})`,
  { timeout: REAL_MODEL || T23_LONG_OTP ? 210000 : 120000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'localqa-real-auth-'));
    const pgPassword = randomBytes(24).toString('hex');
    const envPath = join(dir, 'postgres.env');
    writeFileSync(
      envPath,
      `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${pgPassword}\n`,
      { mode: 0o600 },
    );
    let containerId = null;
    let db;
    let browser;
    let fixture;
    let apiContext;
    let apiServer;
    let apiOrigin;
    let apiCookie;
    let uiProxy;
    let uiBrowser;
    let crashChild;
    let authenticatedDashboardViews = 0;
    let unauthenticatedDashboardViews = 0;
    let expiredAppSession = false;
    try {
      fixture = createServer(async (req, res) => {
        if (req.url === '/login') {
          res.setHeader('content-type', 'text/html');
          res.end(
            '<form method="POST" action="/session">' +
              '<input name="username" data-testid="username">' +
              '<input name="password" type="password" data-testid="password">' +
              '<button type="submit" data-testid="submit">Sign in</button>' +
              '</form>',
          );
        } else if (req.url === '/otp') {
          res.setHeader('content-type', 'text/html');
          res.end(
            '<form method="POST" action="/verify-otp">' +
              '<input data-testid="otp" name="otp" autocomplete="one-time-code">' +
              '<button type="submit" data-testid="submit">Verify code</button>' +
              '</form>',
          );
        } else if (req.url === '/session') {
          // Require the actual form credentials. A fixture that grants a
          // session to every POST could falsely claim the Worker filled auth.
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString('utf8');
            if (body.length > 8192) break;
          }
          const submitted = new URLSearchParams(body);
          if (
            submitted.get('username') !== 'test-user' ||
            submitted.get('password') !== 'test-password'
          ) {
            res.writeHead(401).end();
            return;
          }
          if (T21_FAILURE === 'otp_required' || T22_SCENARIO) {
            // Password-only login cannot produce an authenticated cookie.
            // The OTP service is deliberately unavailable in this build.
            res.writeHead(303, { location: '/otp' }).end();
            return;
          }
          res.writeHead(303, {
            location: '/dashboard',
            'set-cookie':
              'sid=integration-auth; Path=/; HttpOnly; SameSite=Lax',
          });
          res.end();
        } else if (req.url === '/verify-otp') {
          let body = '';
          for await (const part of req) body += String(part);
          if (new URLSearchParams(body).get('otp') !== fixtureOtp) {
            res.writeHead(403).end();
            return;
          }
          res.writeHead(303, {
            location: '/dashboard',
            'set-cookie':
              'sid=integration-auth; Path=/; HttpOnly; SameSite=Lax',
          });
          res.end();
        } else if (req.url === '/dashboard') {
          if (
            !expiredAppSession &&
            req.headers.cookie?.includes('sid=integration-auth')
          ) {
            authenticatedDashboardViews++;
            res.setHeader('content-type', 'text/html');
            res.end('<main data-testid="logged-in">Signed in</main>');
          } else {
            unauthenticatedDashboardViews++;
            if (T21_FAILURE === 'login_redirect') {
              res.writeHead(302, { location: '/login' }).end();
              return;
            }
            if (T21_FAILURE === 'login_spa') {
              res.setHeader('content-type', 'text/html');
              res.end(
                '<form method="POST" action="/session">' +
                  '<input data-testid="username" name="username">' +
                  '<input data-testid="password" name="password" type="password">' +
                  '<button data-testid="submit" type="submit">Sign in</button>' +
                  '</form>',
              );
              return;
            }
            res
              .writeHead(T20_FAILURE === 'forbidden' ? 403 : 401)
              .end('Not authenticated');
          }
        } else res.writeHead(404).end();
      });
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      const origin = `http://127.0.0.1:${fixture.address().port}`;

      containerId = docker([
        'run',
        '--detach',
        '--name',
        `localqa-auth-integration-${randomUUID().slice(0, 10)}`,
        '--publish',
        '127.0.0.1::5432',
        '--env-file',
        envPath,
        'postgres:18-alpine',
      ]);
      const port = docker(['port', containerId, '5432/tcp']).split(':').at(-1);
      const connection = `postgresql://localqa:${pgPassword}@127.0.0.1:${port}/localqa`;
      let migrated = false;
      for (let i = 0; i < 65; i++) {
        try {
          await migrate(
            connection,
            new URL('../../../packages/storage/migrations/', import.meta.url),
          );
          migrated = true;
          break;
        } catch {
          await delay(200);
        }
      }
      assert.equal(migrated, true, 'PostgreSQL must be migrated');
      const kek = randomBytes(32);
      const vault = new SecretVault(1, new Map([[1, kek]]));
      db = new Database(connection);
      const owner = await new AccountsRepository(db).bootstrap({
        email: `auth-${randomUUID()}@localqa.test`,
        displayName: 'Auth Integration Owner',
        password: 'IsolatedAuthTestPassword123!',
      });
      const actor = { userId: owner.id };
      if (T22_SCENARIO) {
        apiContext = createApiContext({
          connectionString: connection,
          vault,
          serviceActor: actor,
          artifactsDir: join(dir, 'api-artifacts'),
          modelTransport: async () => {
            throw new Error('TEST_MODEL_FORBIDDEN');
          },
        });
        apiServer = createApiServer(apiContext);
        await new Promise((resolve) =>
          apiServer.listen(0, '127.0.0.1', resolve),
        );
        apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
        const login = await fetch(`${apiOrigin}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: owner.email,
            password: 'IsolatedAuthTestPassword123!',
          }),
        });
        assert.equal(login.status, 200);
        apiCookie = login.headers.get('set-cookie')?.split(';')[0];
        assert.ok(apiCookie);
      }
      const project = await new ProjectRepository(db).create(actor, {
        name: `Auth Integration ${randomUUID()}`,
      });
      const modelRepo = new ModelRepository(db, vault);
      const realKey = REAL_MODEL ? existingPiDeepSeek() : null;
      const model = await modelRepo.create(actor, {
        name: REAL_MODEL ? 'T19 real DeepSeek' : 'Unused model',
        endpoint: REAL_MODEL
          ? 'https://api.deepseek.com'
          : 'https://unused.example.test/v1',
        configuredModelId: REAL_MODEL ? 'deepseek-flash' : 'unused',
        adapter: 'openai_compatible',
        responseFormat: 'json_object',
        dataBoundary: REAL_MODEL ? 'external' : 'internal',
        ...(realKey ? { apiKey: realKey } : {}),
      });
      let modelVersion = model.version;
      if (REAL_MODEL) {
        const gateway = createGateway({
          profiles: [
            {
              id: model.id,
              version: model.version,
              name: model.name,
              endpoint: model.endpoint,
              configuredModelId: model.configuredModelId,
              kind: 'openai_compatible',
              dataBoundary: 'external',
              responseFormat: 'json_object',
              status: 'untested',
              encryptedApiKey: 'isolated-temp-vault-binding',
              approvedFallbackIds: [],
              capabilities: {
                structuredOutput: false,
                nativeTools: false,
                imageInput: false,
              },
            },
          ],
          decryptKey: () => realKey,
          adapter: createOpenAIAdapter(globalThis.fetch),
        });
        const probe = await gateway.capabilityProbe(model.id, 25000);
        assert.equal(probe.requestResult, 'ok');
        assert.equal(probe.data.capabilities.structuredOutput, true);
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
            status: 'degraded',
          },
        );
        modelVersion = probed.version;
      }
      await modelRepo.grant(actor, project.id, model.id);
      const modelOptions = REAL_MODEL
        ? createWorkerModelOptions({
            transport: globalThis.fetch,
            allowTestStub: false,
            load: (id, version) =>
              modelRepo.readVersion(actor, id, version, project.id),
          })
        : {};
      const configs = new ConfigurationRepository(db, vault);
      const profile = await configs.createAuthProfile(actor, project.id, {
        name: 'Isolated form login',
        mode: 'form',
        allowedOrigins: [origin],
        sharingPolicy: 'exclusive_run',
        secretInput: { username: 'test-user', password: 'test-password' },
        formConfig: {
          loginUrl: `${origin}/login`,
          usernameTarget: { by: 'test_id', value: 'username' },
          passwordTarget: { by: 'test_id', value: 'password' },
          submitTarget: { by: 'test_id', value: 'submit' },
          ...(T21_FAILURE === 'otp_required' || T22_SCENARIO
            ? { otpTarget: { by: 'test_id', value: 'otp' } }
            : {}),
          successCriterion: {
            id: 'login_success',
            kind: 'element_visible',
            description: 'Signed-in dashboard marker is present',
            sourceKind: 'user_spec',
            sourceRef: 'owned-integration-fixture',
            locator: { by: 'test_id', value: 'logged-in' },
          },
        },
      });
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
        environmentVersion: null,
        authProfileVersion: profile.version,
        knowledgeVersionIds: [],
        models: Object.fromEntries(
          roles.map((role) => [
            role,
            { profileId: model.id, version: modelVersion },
          ]),
        ),
      };
      const run = await coordinator.start(
        actor,
        {
          projectId: project.id,
          targetUrl: `${origin}/dashboard`,
          authProfileId: profile.id,
        },
        config,
        randomUUID(),
      );
      const runtime = new RuntimeClient(
        coordinator,
        { projectId: project.id, workerId: `auth-worker-${randomUUID()}` },
        new ArtifactStore(join(dir, 'artifacts')),
        modelOptions,
      );
      let t24AuthLease;
      let releaseT24WorkerConsume;
      let t24DirectConsume;
      if (
        ['consume_race', 'revoke_consume', 'stale_lease'].includes(T24_SCENARIO)
      ) {
        const originalClaim = runtime.claim.bind(runtime);
        runtime.claim = async (seconds) => {
          const lease = await originalClaim(seconds);
          if (lease?.task.summary === 'auth') t24AuthLease = lease;
          return lease;
        };
      }
      if (['consume_race', 'revoke_consume'].includes(T24_SCENARIO)) {
        const originalConsume = runtime.consumeAuthOtp.bind(runtime);
        t24DirectConsume = originalConsume;
        const blockedConsumer = new Promise((resolve) => {
          releaseT24WorkerConsume = resolve;
        });
        runtime.consumeAuthOtp = async (...args) => {
          await blockedConsumer;
          return originalConsume(...args);
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
      if (T24_SCENARIO === 'kill' || T24_SCENARIO === 'kill_submitted') {
        crashChild = fork(
          fileURLToPath(
            new URL(
              '../../../scripts/t24-auth-worker-child.mjs',
              import.meta.url,
            ),
          ),
          [],
          { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
        );
        let crashedLease;
        let crashedWorkerId;
        crashChild.on('message', (msg) => {
          if (msg?.kind === 't24-lease') {
            crashedLease = msg.lease;
            crashedWorkerId = msg.workerId;
          }
        });
        crashChild.send({
          kind: 't24-auth-child-start',
          connection,
          kek: kek.toString('base64'),
          projectId: project.id,
          userId: actor.userId,
          holdConsume: T24_SCENARIO === 'kill_submitted',
        });
        let challenge;
        for (let i = 0; i < 160; i++) {
          challenge = await coordinator.tx(
            async (client) =>
              (
                await client.query(
                  'SELECT c.*,i.document FROM auth_otp_challenges c JOIN input_requests i ON i.id=c.input_id WHERE c.project_id=$1 AND c.run_id=$2',
                  [project.id, run.id],
                )
              ).rows[0],
          );
          if (challenge && crashedLease) break;
          if (crashChild.exitCode !== null)
            assert.fail('Worker child exited before issuing OTP challenge');
          await delay(100);
        }
        assert.ok(
          challenge && crashedLease,
          'actual OS worker must reach OTP wait',
        );
        assert.equal(challenge.status, 'pending');
        if (T24_SCENARIO === 'kill_submitted') {
          const submitted = await fetch(
            `${apiOrigin}/api/v1/runs/${run.id}/inputs/${challenge.input_id}/respond`,
            {
              method: 'POST',
              headers: {
                cookie: apiCookie,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                decision: 'provide',
                expectedVersion: 1,
                oneTimeCode: fixtureOtp,
              }),
            },
          );
          assert.equal(submitted.status, 200);
          assert.equal((await submitted.json()).status, 'resolved');
          const staged = await coordinator.tx(
            async (client) =>
              (
                await client.query(
                  'SELECT status,ciphertext IS NOT NULL AS sealed FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2',
                  [project.id, challenge.input_id],
                )
              ).rows[0],
          );
          assert.deepEqual(staged, { status: 'submitted', sealed: true });
        }
        const killedPid = crashChild.pid;
        const childExit = once(crashChild, 'exit');
        const exitTimeout = new AbortController();
        if (process.platform === 'win32')
          spawnSync('taskkill', ['/PID', String(killedPid), '/T', '/F'], {
            encoding: 'utf8',
            timeout: 15000,
          });
        else crashChild.kill('SIGKILL');
        let exitCode;
        let signal;
        try {
          [exitCode, signal] = await Promise.race([
            childExit,
            delay(10000, undefined, { signal: exitTimeout.signal }).then(() =>
              assert.fail('OS worker process did not terminate'),
            ),
          ]);
        } finally {
          exitTimeout.abort();
        }
        assert.ok(signal || exitCode !== 0);
        crashChild = null;
        // Recovery must depend on a genuinely expired, unrenewed DB lease.
        await delay(3650);
        await coordinator.tick(project.id);
        const recovered = await coordinator.tx(async (client) => ({
          job: (
            await client.query(
              "SELECT status FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='auth'",
              [project.id, run.id],
            )
          ).rows[0],
          challenge: (
            await client.query(
              'SELECT status,ciphertext,nonce,auth_tag FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2',
              [project.id, challenge.input_id],
            )
          ).rows[0],
          input: (
            await client.query(
              'SELECT document FROM input_requests WHERE project_id=$1 AND id=$2',
              [project.id, challenge.input_id],
            )
          ).rows[0]?.document,
          session: (
            await client.query(
              'SELECT status,end_reason FROM auth_execution_sessions WHERE project_id=$1 AND id=$2',
              [project.id, challenge.auth_session_id],
            )
          ).rows[0],
          scope: (
            await client.query(
              'SELECT status,current_state_id FROM run_auth_scopes WHERE project_id=$1 AND run_id=$2',
              [project.id, run.id],
            )
          ).rows[0],
          run: (
            await client.query(
              'SELECT status,termination_reason FROM runs WHERE project_id=$1 AND id=$2',
              [project.id, run.id],
            )
          ).rows[0],
          activeLocks: (
            await client.query(
              "SELECT count(*)::integer n FROM auth_profile_run_locks WHERE project_id=$1 AND run_id=$2 AND status='held'",
              [project.id, run.id],
            )
          ).rows[0],
          authJobCount: (
            await client.query(
              "SELECT count(*)::integer n FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='auth'",
              [project.id, run.id],
            )
          ).rows[0],
          resolutions: (
            await client.query(
              "SELECT payload FROM run_events WHERE project_id=$1 AND run_id=$2 AND type='input.resolved'",
              [project.id, run.id],
            )
          ).rows.map((row) => row.payload),
        }));
        assert.equal(recovered.job?.status, 'interrupted');
        assert.equal(recovered.challenge?.status, 'expired');
        assert.equal(recovered.challenge?.ciphertext, null);
        assert.equal(recovered.challenge?.nonce, null);
        assert.equal(recovered.challenge?.auth_tag, null);
        assert.equal(
          recovered.input?.status,
          T24_SCENARIO === 'kill_submitted' ? 'resolved' : 'expired',
        );
        assert.equal(recovered.session?.status, 'ended');
        assert.equal(recovered.session?.end_reason, 'interrupted');
        assert.equal(recovered.scope?.current_state_id, null);
        assert.equal(recovered.run?.status, 'failed');
        assert.equal(recovered.run?.termination_reason, 'setup_failure');
        assert.equal(recovered.activeLocks?.n, 0);
        assert.equal(recovered.authJobCount?.n, 1);
        assert.ok(
          recovered.resolutions.some(
            (row) =>
              row.id === challenge.input_id &&
              row.status ===
                (T24_SCENARIO === 'kill_submitted' ? 'resolved' : 'expired'),
          ),
        );
        assert.equal(await runtime.claim(), null);
        const staleProof = {
          taskId: crashedLease.task.id,
          fencingToken: crashedLease.fencingToken,
          leaseToken: crashedLease.leaseToken,
          contextVersion: crashedLease.contextVersion,
        };
        const staleRuntime = new RuntimeClient(
          coordinator,
          { projectId: project.id, workerId: crashedWorkerId },
          new ArtifactStore(join(dir, 'stale-artifacts')),
          {},
        );
        for (const operation of [
          () =>
            staleRuntime.consumeAuthOtp(
              staleProof,
              challenge.auth_session_id,
              challenge.input_id,
            ),
          () =>
            staleRuntime.issueAuthOtp(staleProof, challenge.auth_session_id),
          () => staleRuntime.heartbeat(staleProof, 3),
        ])
          await assert.rejects(
            operation,
            (error) => error?.code === 'LEASE_EXPIRED',
          );
        await assert.rejects(
          () =>
            coordinator.authOtp.submit(
              actor,
              project.id,
              run.id,
              challenge.input_id,
              1,
              'provide',
              fixtureOtp,
            ),
          (error) => error?.code === 'VERSION_CONFLICT',
        );
        console.log(
          `T24 real OS-process ${T24_SCENARIO}: lease recovery interrupted, OTP zeroized, public input reconciled, stale proof rejected`,
        );
        return;
      }
      if (T21_FAILURE === 'auth_lease_crash') {
        // Simulate a Worker dying after reserving its private auth context,
        // but before activating the one-use ticket or exporting any state.
        // Let the DB-backed lease expire without a heartbeat; recovery is
        // exercised through the real Coordinator.tick, not mocked SQL.
        const abandoned = await runtime.claim(1);
        assert.equal(abandoned?.task.summary, 'auth');
        const abandonedProof = {
          taskId: abandoned.task.id,
          leaseToken: abandoned.leaseToken,
          fencingToken: abandoned.fencingToken,
          contextVersion: abandoned.contextVersion,
        };
        const allocated = await runtime.allocateAuthSession(abandonedProof);
        assert.equal(allocated.status, 'allocated');
        await delay(1350);
        await coordinator.tick(project.id);
        const recovered = await db.actor(actor, async (client) => {
          const authJob = (
            await client.query(
              "SELECT status FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='auth'",
              [project.id, run.id],
            )
          ).rows[0];
          const session = (
            await client.query(
              'SELECT status,end_reason FROM auth_execution_sessions WHERE project_id=$1 AND id=$2',
              [project.id, allocated.sessionId],
            )
          ).rows[0];
          const scope = (
            await client.query(
              'SELECT status,current_state_id FROM run_auth_scopes WHERE project_id=$1 AND run_id=$2',
              [project.id, run.id],
            )
          ).rows[0];
          const activeLocks = (
            await client.query(
              "SELECT count(*)::integer AS n FROM auth_profile_run_locks WHERE project_id=$1 AND run_id=$2 AND phase='initializing' AND status='held'",
              [project.id, run.id],
            )
          ).rows[0];
          const runState = (
            await client.query(
              'SELECT status,termination_reason FROM runs WHERE project_id=$1 AND id=$2',
              [project.id, run.id],
            )
          ).rows[0];
          const replayed = (
            await client.query(
              "SELECT count(*)::integer AS n FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='auth'",
              [project.id, run.id],
            )
          ).rows[0];
          return { authJob, session, scope, activeLocks, runState, replayed };
        });
        assert.equal(recovered.authJob?.status, 'interrupted');
        assert.deepEqual(recovered.session, {
          status: 'ended',
          end_reason: 'interrupted',
        });
        assert.equal(recovered.scope?.current_state_id, null);
        assert.equal(recovered.activeLocks.n, 0);
        assert.equal(recovered.runState?.status, 'failed');
        assert.equal(recovered.runState?.termination_reason, 'setup_failure');
        assert.equal(
          recovered.replayed.n,
          1,
          'never automatically replay auth',
        );
        await assert.rejects(
          () =>
            runtime.issueAuthActivationTicket(
              abandonedProof,
              allocated.sessionId,
            ),
          (error) => error?.code === 'LEASE_EXPIRED',
        );
        assert.equal(await runtime.claim(), null);
        console.log(
          'T21 auth_lease_crash: interrupted; private session ended, lock released, no state capture or auth replay, run=failed',
        );
        return;
      }
      browser = new BrowserManager();
      const worker = new Worker({
        runtime,
        browser,
        scratch: join(dir, 'scratch'),
        heartbeatMs: 250,
        leaseSeconds: 45,
        pollMs: 250,
      });
      if (T21_FAILURE === 'otp_required' || T22_SCENARIO) {
        // The auth Worker holds its real lease/Chromium context while an
        // independent authorized user submits one private OTP answer.
        const authTask = worker.once();
        let input;
        for (let tries = 0; tries < 120; tries++) {
          input = await coordinator.tx(
            async (client) =>
              (
                await client.query(
                  "SELECT document FROM input_requests WHERE project_id=$1 AND run_id=$2 AND document->>'kind'='one_time_code'",
                  [project.id, run.id],
                )
              ).rows[0]?.document,
          );
          if (input) break;
          await delay(75);
        }
        if (!input) {
          await authTask;
          const diagnostic = await coordinator.tx(async (client) => ({
            job: (
              await client.query(
                "SELECT status FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='auth'",
                [project.id, run.id],
              )
            ).rows[0],
            session: (
              await client.query(
                "SELECT status,end_reason,expires_at > clock_timestamp() AS live FROM auth_execution_sessions WHERE project_id=$1 AND run_id=$2 AND purpose='initializer'",
                [project.id, run.id],
              )
            ).rows[0],
            actions: (
              await client.query(
                'SELECT a.action,a.slot,i.outcome AS status FROM auth_action_requests a JOIN action_intents i ON i.id=a.grant_id WHERE a.project_id=$1 AND a.run_id=$2',
                [project.id, run.id],
              )
            ).rows,
            snapshots: (
              await client.query(
                'SELECT document FROM page_snapshots WHERE project_id=$1 AND run_id=$2 ORDER BY created_at DESC LIMIT 4',
                [project.id, run.id],
              )
            ).rows.map(({ document }) => ({
              url: document.displayUrl,
              nodeIds: document.nodes?.map((node) => node.nodeId).slice(0, 20),
            })),
          }));
          assert.fail(`OTP_INPUT_NOT_ISSUED ${JSON.stringify(diagnostic)}`);
        }
        assert.equal(input.status, 'pending');
        if (T23_CANCEL_OTP) {
          await coordinator.cancel(actor, project.id, run.id);
          await coordinator.tick(project.id);
          await authTask;
          const state = await coordinator.tx(async (client) => ({
            input: (
              await client.query(
                'SELECT document FROM input_requests WHERE project_id=$1 AND id=$2',
                [project.id, input.id],
              )
            ).rows[0]?.document,
            challenge: (
              await client.query(
                'SELECT status,ciphertext FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2',
                [project.id, input.id],
              )
            ).rows[0],
            scope: (
              await client.query(
                'SELECT current_state_id FROM run_auth_scopes WHERE project_id=$1 AND run_id=$2',
                [project.id, run.id],
              )
            ).rows[0],
            events: (
              await client.query(
                "SELECT payload FROM run_events WHERE project_id=$1 AND run_id=$2 AND type='input.resolved'",
                [project.id, run.id],
              )
            ).rows.map((row) => row.payload),
          }));
          assert.equal(state.input?.status, 'expired');
          assert.equal(state.challenge?.status, 'expired');
          assert.equal(state.challenge?.ciphertext, null);
          assert.equal(state.scope?.current_state_id, null);
          assert.ok(
            state.events.some(
              (event) => event.id === input.id && event.status === 'expired',
            ),
          );
          console.log(
            'T23: cancel during OTP invalidated private challenge and resolved UI input',
          );
          return;
        }
        if (T23_LONG_OTP) {
          const before = await coordinator.tx(
            async (client) =>
              (
                await client.query(
                  `SELECT expires_at,activated_at FROM auth_execution_sessions
               WHERE project_id=$1 AND run_id=$2 AND purpose='initializer'`,
                  [project.id, run.id],
                )
              ).rows[0],
          );
          assert.ok(before?.expires_at && before?.activated_at);
          // Actual elapsed time must exceed the originally claimed 45s
          // lease. Worker heartbeat keeps the live session authorized.
          await delay(49000);
          const afterWait = await coordinator.tx(
            async (client) =>
              (
                await client.query(
                  `SELECT status,expires_at,activated_at FROM auth_execution_sessions
               WHERE project_id=$1 AND run_id=$2 AND purpose='initializer'`,
                  [project.id, run.id],
                )
              ).rows[0],
          );
          assert.equal(afterWait?.status, 'active');
          assert.ok(
            afterWait.expires_at.getTime() >
              before.expires_at.getTime() + 40000,
            'fenced heartbeat must extend the same auth session',
          );
          assert.ok(afterWait.expires_at.getTime() > Date.now());
          assert.ok(
            afterWait.expires_at.getTime() <=
              afterWait.activated_at.getTime() + 300000,
            'hard deadline must never exceed five minutes from activation',
          );
          console.log(
            'T23: real OTP wait passed initial 45s lease; live fenced session renewed within hard cap',
          );
        }
        const respondViaApi = async (decision, code) => {
          const response = await fetch(
            `${apiOrigin}/api/v1/runs/${run.id}/inputs/${input.id}/respond`,
            {
              method: 'POST',
              headers: {
                cookie: apiCookie,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                expectedVersion: input.version,
                decision,
                ...(code ? { oneTimeCode: code } : {}),
              }),
            },
          );
          return { status: response.status, body: await response.json() };
        };
        if (T24_SCENARIO === 'revoke_consume') {
          const provided = await respondViaApi('provide', fixtureOtp);
          assert.equal(provided.status, 200);
          const sessionId = (
            await coordinator.tx(
              async (client) =>
                (
                  await client.query(
                    'SELECT auth_session_id FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2',
                    [project.id, input.id],
                  )
                ).rows[0],
            )
          ).auth_session_id;
          const revoked = await configs.updateAuthProfile(
            actor,
            project.id,
            profile.id,
            { expectedVersion: profile.version, revoke: true },
          );
          assert.equal(revoked.status, 'revoked');
          const proof = {
            taskId: t24AuthLease.task.id,
            fencingToken: t24AuthLease.fencingToken,
            leaseToken: t24AuthLease.leaseToken,
            contextVersion: t24AuthLease.contextVersion,
          };
          await assert.rejects(
            () => t24DirectConsume(proof, sessionId, input.id),
            (error) => ['AUTH_FAILED', 'LEASE_EXPIRED'].includes(error?.code),
          );
          releaseT24WorkerConsume();
          await authTask;
          await coordinator.tick(project.id);
          const ledger = await coordinator.tx(async (client) => ({
            challenge: (
              await client.query(
                'SELECT status,ciphertext FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2',
                [project.id, input.id],
              )
            ).rows[0],
            scope: (
              await client.query(
                'SELECT current_state_id FROM run_auth_scopes WHERE project_id=$1 AND run_id=$2',
                [project.id, run.id],
              )
            ).rows[0],
          }));
          assert.equal(ledger.challenge?.ciphertext, null);
          assert.equal(ledger.scope?.current_state_id, null);
          assert.equal(authenticatedDashboardViews, 0);
          console.log('T24: revoked profile denies consumption; no auth state');
          return;
        }
        if (T24_SCENARIO === 'stale_lease') {
          assert.ok(
            t24AuthLease,
            'auth proof must be claimed by the real Worker',
          );
          const proof = {
            taskId: t24AuthLease.task.id,
            fencingToken: t24AuthLease.fencingToken,
            leaseToken: t24AuthLease.leaseToken,
            contextVersion: t24AuthLease.contextVersion,
          };
          const sessionId = (
            await coordinator.tx(
              async (client) =>
                (
                  await client.query(
                    'SELECT auth_session_id FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2',
                    [project.id, input.id],
                  )
                ).rows[0],
            )
          ).auth_session_id;
          for (const counterfeit of [
            { ...proof, fencingToken: proof.fencingToken + 1 },
            { ...proof, contextVersion: proof.contextVersion + 1 },
            { ...proof, leaseToken: randomBytes(24).toString('hex') },
            { ...proof, taskId: randomUUID() },
          ]) {
            await assert.rejects(
              () => runtime.consumeAuthOtp(counterfeit, sessionId, input.id),
              (error) => error?.code === 'LEASE_EXPIRED',
            );
            await assert.rejects(
              () => runtime.heartbeat(counterfeit, 45),
              (error) => error?.code === 'LEASE_EXPIRED',
            );
          }
          console.log(
            'T24: forged fence/context/token/task cannot heartbeat or consume OTP',
          );
        }
        if (T24_SCENARIO === 'consume_race') {
          assert.ok(t24AuthLease);
          const provided = await respondViaApi('provide', fixtureOtp);
          assert.equal(provided.status, 200);
          const sessionId = (
            await coordinator.tx(
              async (client) =>
                (
                  await client.query(
                    'SELECT auth_session_id FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2',
                    [project.id, input.id],
                  )
                ).rows[0],
            )
          ).auth_session_id;
          const proof = {
            taskId: t24AuthLease.task.id,
            fencingToken: t24AuthLease.fencingToken,
            leaseToken: t24AuthLease.leaseToken,
            contextVersion: t24AuthLease.contextVersion,
          };
          const results = await Promise.allSettled(
            Array.from({ length: 8 }, () =>
              t24DirectConsume(proof, sessionId, input.id),
            ),
          );
          const successes = results.filter(
            (r) => r.status === 'fulfilled' && r.value.status === 'ready',
          );
          assert.equal(
            successes.length,
            1,
            'only one consumer may decrypt the OTP',
          );
          assert.equal(
            results.filter(
              (r) =>
                r.status === 'rejected' && r.reason?.code === 'AUTH_FAILED',
            ).length,
            7,
          );
          releaseT24WorkerConsume();
          assert.equal(await authTask, true);
          await coordinator.tick(project.id);
          const ledger = await coordinator.tx(async (client) => ({
            challenge: (
              await client.query(
                'SELECT status,ciphertext,nonce,auth_tag,key_version FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2',
                [project.id, input.id],
              )
            ).rows[0],
            scope: (
              await client.query(
                'SELECT current_state_id FROM run_auth_scopes WHERE project_id=$1 AND run_id=$2',
                [project.id, run.id],
              )
            ).rows[0],
          }));
          assert.equal(ledger.challenge?.status, 'consumed');
          assert.equal(ledger.challenge?.ciphertext, null);
          assert.equal(ledger.challenge?.nonce, null);
          assert.equal(ledger.challenge?.auth_tag, null);
          assert.equal(ledger.challenge?.key_version, null);
          assert.equal(ledger.scope?.current_state_id, null);
          assert.equal(authenticatedDashboardViews, 0);
          console.log(
            'T24: 8 concurrent OTP consume calls yielded exactly one ready, seven denied, no auth fallback',
          );
          return;
        }
        const respondViaWorkbench = async () => {
          uiProxy = createProxyServer({
            backendOrigin: apiOrigin,
            distDir: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
          });
          await uiProxy.listen();
          const webOrigin = `http://127.0.0.1:${uiProxy.address().port}`;
          const { chromium } =
            await import('../../web/node_modules/playwright/index.mjs');
          uiBrowser = await chromium.launch({ headless: true });
          const context = await uiBrowser.newContext();
          await context.addCookies([
            {
              name: 'session',
              value: apiCookie.split('=')[1],
              domain: '127.0.0.1',
              path: '/',
              httpOnly: true,
              sameSite: 'Lax',
            },
          ]);
          const page = await context.newPage();
          await page.goto(
            `${webOrigin}/#/workbench?runId=${encodeURIComponent(run.id)}`,
          );
          const codeInput = page.getByTestId('input-request-otp');
          await codeInput.waitFor({ state: 'visible', timeout: 20000 });
          assert.equal(await codeInput.getAttribute('type'), 'password');
          assert.equal(
            await page
              .getByTestId('input-request-bar')
              .getAttribute('data-request-id'),
            input.id,
          );
          assert.equal(
            await page.getByTestId('btn-submit-input-response').isDisabled(),
            true,
          );
          const responsePromise = page.waitForResponse(
            (response) =>
              response
                .url()
                .includes(`/runs/${run.id}/inputs/${input.id}/respond`) &&
              response.request().method() === 'POST',
            { timeout: 20000 },
          );
          await codeInput.fill(fixtureOtp);
          assert.equal(
            await page.getByTestId('btn-submit-input-response').isEnabled(),
            true,
          );
          await page.getByTestId('btn-submit-input-response').click();
          const response = await responsePromise;
          const posted = response.request().postDataJSON();
          assert.equal(posted.oneTimeCode, fixtureOtp);
          assert.equal(Object.hasOwn(posted, 'text'), false);
          assert.equal(Object.hasOwn(posted, 'authProfileId'), false);
          await codeInput.waitFor({ state: 'detached', timeout: 12000 });
          console.log(
            'T23: real Workbench OTP input rendered, filled, HTTP submitted and removed after resolution',
          );
          return { status: response.status(), body: await response.json() };
        };
        if (T22_SCENARIO === 'success') {
          const viewer = await new AccountsRepository(db).create(actor, {
            email: `otp-viewer-${randomUUID()}@localqa.test`,
            displayName: 'T22 Restricted Viewer',
            password: 'T22ViewerTestOnly123!',
            globalRole: 'member',
          });
          await new ProjectRepository(db).replaceMembers(actor, project.id, {
            expectedVersion: project.version,
            members: [
              { userId: actor.userId, role: 'owner' },
              { userId: viewer.id, role: 'viewer' },
            ],
          });
          await assert.rejects(
            () =>
              coordinator.authOtp.submit(
                { userId: viewer.id },
                project.id,
                run.id,
                input.id,
                input.version,
                'provide',
                fixtureOtp,
              ),
            (error) => error?.code === 'FORBIDDEN',
          );
          const url = `${apiOrigin}/api/v1/runs/${run.id}/inputs/${input.id}/respond`;
          const body = JSON.stringify({
            expectedVersion: input.version,
            decision: 'reject',
          });
          const unauthenticated = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
          assert.equal(unauthenticated.status, 401);
          const crossSite = await fetch(url, {
            method: 'POST',
            headers: {
              cookie: apiCookie,
              'content-type': 'application/json',
              'sec-fetch-site': 'cross-site',
            },
            body,
          });
          assert.equal(crossSite.status, 403);
        }
        if (T22_SCENARIO === 'success' || T22_SCENARIO === 'wrong') {
          const supplied =
            T24_SCENARIO === 'submit_race'
              ? await (async () => {
                  const responses = await Promise.all(
                    Array.from({ length: 12 }, () =>
                      respondViaApi('provide', fixtureOtp),
                    ),
                  );
                  const won = responses.filter((r) => r.status === 200);
                  const lost = responses.filter(
                    (r) =>
                      r.status === 409 && r.body.code === 'VERSION_CONFLICT',
                  );
                  assert.equal(
                    won.length,
                    1,
                    'exactly one HTTP submit must win',
                  );
                  assert.equal(
                    lost.length,
                    11,
                    'stale parallel requests must be denied',
                  );
                  console.log(
                    'T24: 12 simultaneous real HTTP OTP submits: one accepted, 11 version-conflict denied',
                  );
                  return won[0];
                })()
              : T23_UI_OTP && T22_SCENARIO === 'success'
                ? await respondViaWorkbench()
                : await respondViaApi(
                    'provide',
                    T22_SCENARIO === 'success'
                      ? fixtureOtp
                      : randomBytes(4).toString('hex'),
                  );
          assert.equal(supplied.status, 200);
          assert.equal(supplied.body.status, 'resolved');
          assert.equal(
            JSON.stringify(supplied.body).includes(fixtureOtp),
            false,
          );
          const duplicate = await respondViaApi('provide', fixtureOtp);
          assert.equal(duplicate.status, 409);
          assert.equal(duplicate.body.code, 'VERSION_CONFLICT');
        } else if (T22_SCENARIO === 'expire') {
          // Inject an expired challenge into the disposable database; no
          // production clock alteration or 45-second wall-clock wait.
          await coordinator.tx(async (client) => {
            await client.query(
              "UPDATE auth_otp_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1 AND input_id=$2",
              [project.id, input.id],
            );
          });
        } else {
          if (T22_SCENARIO === 'reject') {
            const rejected = await respondViaApi('reject');
            assert.equal(rejected.status, 200);
            assert.equal(rejected.body.status, 'rejected');
          } else {
            const rejected = await coordinator.authOtp.submit(
              actor,
              project.id,
              run.id,
              input.id,
              input.version,
              'reject',
            );
            assert.equal(rejected.status, 'rejected');
          }
        }
        assert.equal(await authTask, true);
        if (T22_SCENARIO === 'expire') {
          const late = await respondViaApi('provide', fixtureOtp);
          assert.equal(late.status, 409);
          assert.equal(late.body.code, 'VERSION_CONFLICT');
        }
        const privateRows = await coordinator.tx(async (client) => ({
          challenge: (
            await client.query(
              'SELECT status,ciphertext,nonce,auth_tag FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2',
              [project.id, input.id],
            )
          ).rows[0],
          document: (
            await client.query(
              'SELECT document FROM input_requests WHERE project_id=$1 AND id=$2',
              [project.id, input.id],
            )
          ).rows[0]?.document,
          events: (
            await client.query(
              "SELECT payload::text AS text FROM run_events WHERE project_id=$1 AND run_id=$2 AND type LIKE 'input.%'",
              [project.id, run.id],
            )
          ).rows.map((row) => row.text),
        }));
        assert.equal(privateRows.challenge?.ciphertext, null);
        assert.equal(privateRows.challenge?.nonce, null);
        assert.equal(privateRows.challenge?.auth_tag, null);
        assert.equal(JSON.stringify(privateRows).includes(fixtureOtp), false);
        if (T22_SCENARIO === 'success' || T22_SCENARIO === 'wrong') {
          assert.equal(privateRows.challenge?.status, 'consumed');
          if (T22_SCENARIO === 'success')
            console.log(
              'T22: authorized OTP completed; encrypted payload consumed once and absent from input/events',
            );
        }
      } else {
        assert.equal(await worker.once(), true);
      }
      if (
        T21_FAILURE === 'otp_required' ||
        (T22_SCENARIO && T22_SCENARIO !== 'success')
      ) {
        await coordinator.tick(project.id);
        const blockedOtp = await db.actor(actor, async (client) => {
          const job = (
            await client.query(
              "SELECT status FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='auth'",
              [project.id, run.id],
            )
          ).rows[0];
          const scope = (
            await client.query(
              'SELECT current_state_id FROM run_auth_scopes WHERE project_id=$1 AND run_id=$2',
              [project.id, run.id],
            )
          ).rows[0];
          const sessions = (
            await client.query(
              "SELECT status,end_reason FROM auth_execution_sessions WHERE project_id=$1 AND run_id=$2 AND purpose='initializer'",
              [project.id, run.id],
            )
          ).rows;
          const state = (
            await client.query(
              'SELECT status,termination_reason FROM runs WHERE project_id=$1 AND id=$2',
              [project.id, run.id],
            )
          ).rows[0];
          return { job, scope, sessions, state };
        });
        assert.notEqual(blockedOtp.job?.status, 'succeeded');
        assert.equal(blockedOtp.scope?.current_state_id, null);
        assert.ok(blockedOtp.sessions.length >= 1);
        assert.ok(blockedOtp.sessions.every((s) => s.status === 'ended'));
        assert.equal(blockedOtp.state?.status, 'failed');
        assert.equal(blockedOtp.state?.termination_reason, 'setup_failure');
        assert.equal(authenticatedDashboardViews, 0);
        assert.equal(unauthenticatedDashboardViews, 0);
        console.log(
          `T21/T22 ${T22_SCENARIO || T21_FAILURE}: OTP request closed, no captured auth state; run=failed`,
        );
        return;
      }
      const authRow = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              "SELECT j.status,s.current_state_id FROM jobs j JOIN run_auth_scopes s ON s.run_id=j.run_id AND s.project_id=j.project_id WHERE j.run_id=$1 AND j.document->>'summary'='auth'",
              [run.id],
            )
          ).rows[0],
      );
      assert.equal(authRow?.status, 'succeeded', 'real auth task must succeed');
      assert.ok(authRow.current_state_id, 'captured state must be authorized');
      if (
        T20_FAILURE === 'expired' ||
        T20_FAILURE === 'forbidden' ||
        T21_FAILURE === 'login_redirect' ||
        T21_FAILURE === 'login_spa'
      )
        expiredAppSession = true;
      if (T20_FAILURE === 'revoked') {
        // Use the public versioned repository mutation. Direct SQL would
        // bypass the protected version/audit trigger and is deliberately
        // rejected by PostgreSQL.
        const revoked = await configs.updateAuthProfile(
          actor,
          project.id,
          profile.id,
          { expectedVersion: profile.version, revoke: true },
        );
        assert.equal(revoked.status, 'revoked');
      }
      await coordinator.tick(project.id);
      // Exercise the *actual* Worker.once importer and subsequent page
      // navigation rather than bypassing it with the helper callback.
      // Only the model's read-only "done" decision is deterministic here;
      // the auth capture/import, browser and DB are all production paths.
      const modelRoles = [];
      if (T20_FAILURE === 'revoked_mid')
        runtime.model = async (_proof, role) => {
          modelRoles.push(role);
          assert.equal(role, 'explorer');
          const revoked = await configs.updateAuthProfile(
            actor,
            project.id,
            profile.id,
            { expectedVersion: profile.version, revoke: true },
          );
          assert.equal(revoked.status, 'revoked');
          return {
            requestResult: 'ok',
            data: {
              done: false,
              toolCalls: [
                { name: 'navigate', args: { url: `${origin}/dashboard` } },
              ],
            },
          };
        };
      else if (T20_FAILURE || T21_FAILURE)
        runtime.model = async (_proof, role) => {
          modelRoles.push(role);
          throw new Error('MODEL_CALL_AFTER_AUTH_REJECTION');
        };
      else if (!REAL_MODEL)
        runtime.model = async (_proof, role) => {
          modelRoles.push(role);
          assert.equal(role, 'explorer');
          return { requestResult: 'ok', data: { done: true, toolCalls: [] } };
        };
      assert.equal(await worker.once(), true);
      if (T20_FAILURE || T21_FAILURE) {
        const failure = await db.actor(actor, async (client) => {
          const job = (
            await client.query(
              "SELECT id,status FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='explore'",
              [project.id, run.id],
            )
          ).rows[0];
          const counts = (
            await client.query(
              `SELECT
                (SELECT count(*)::integer FROM action_intents WHERE project_id=$1 AND task_id=$2 AND tool_call->>'name'='navigate') AS navigations,
                (SELECT count(*)::integer FROM model_requests WHERE project_id=$1 AND run_id=$3) AS model_calls,
                (SELECT count(*)::integer FROM findings WHERE project_id=$1 AND run_id=$3) AS findings,
                (SELECT count(*)::integer FROM auth_import_grants WHERE project_id=$1 AND task_id=$2) AS import_grants`,
              [project.id, job.id, run.id],
            )
          ).rows[0];
          const state = (
            await client.query(
              'SELECT termination_reason FROM runs WHERE project_id=$1 AND id=$2',
              [project.id, run.id],
            )
          ).rows[0];
          return { job, counts, state };
        });
        assert.notEqual(failure.job?.status, 'succeeded');
        assert.equal(failure.state?.termination_reason, 'setup_failure');
        assert.equal(failure.counts.model_calls, 0);
        assert.equal(failure.counts.findings, 0);
        assert.equal(
          modelRoles.length,
          T20_FAILURE === 'revoked_mid' ? 1 : 0,
          'no AI decision after lost auth',
        );
        assert.equal(
          failure.counts.navigations,
          T20_FAILURE === 'revoked' ? 0 : 1,
          'revocation prevents navigation; expiry is observed on one navigation',
        );
        assert.equal(
          failure.counts.import_grants,
          T20_FAILURE === 'revoked' ? 0 : 1,
        );
        assert.equal(
          unauthenticatedDashboardViews,
          ['revoked', 'revoked_mid'].includes(T20_FAILURE) ? 0 : 1,
        );
        if (T20_FAILURE === 'revoked_mid')
          assert.ok(
            authenticatedDashboardViews >= 2,
            'authenticated navigation before revoke must actually succeed',
          );
        console.log(
          `T20/T21 ${T21_FAILURE || T20_FAILURE}: no anonymous fallback, no model ledger requests, no Finding; setup_failure`,
        );
        return;
      }
      if (!REAL_MODEL) assert.deepEqual(modelRoles, ['explorer']);
      assert.ok(
        authenticatedDashboardViews >= 2,
        'the imported context must navigate the protected dashboard after the login context',
      );
      assert.equal(
        unauthenticatedDashboardViews,
        0,
        'Worker must not navigate the dashboard anonymously',
      );
      const imported = await db.actor(actor, async (client) => {
        const job = (
          await client.query(
            "SELECT id,status,result FROM jobs WHERE project_id=$1 AND run_id=$2 AND document->>'summary'='explore'",
            [project.id, run.id],
          )
        ).rows[0];
        const session = (
          await client.query(
            "SELECT status,end_reason FROM auth_execution_sessions WHERE project_id=$1 AND task_id=$2 AND purpose='importer'",
            [project.id, job.id],
          )
        ).rows[0];
        const grant = (
          await client.query(
            'SELECT status FROM auth_import_grants WHERE project_id=$1 AND task_id=$2',
            [project.id, job.id],
          )
        ).rows[0];
        const actions = (
          await client.query(
            "SELECT tool_call->'args'->>'url' AS url,outcome FROM action_intents WHERE project_id=$1 AND task_id=$2 AND tool_call->>'name'='navigate'",
            [project.id, job.id],
          )
        ).rows;
        const calls = REAL_MODEL
          ? (
              await client.query(
                "SELECT status,redacted_diagnostic->>'reportedModelId' AS reported_model FROM model_requests WHERE project_id=$1 AND run_id=$2",
                [project.id, run.id],
              )
            ).rows
          : [];
        return { job, session, grant, actions, calls };
      });
      assert.equal(imported.job?.status, 'succeeded');
      assert.equal(imported.session?.status, 'ended');
      assert.equal(imported.session?.end_reason, 'task_finished');
      assert.equal(imported.grant?.status, 'ended');
      assert.deepEqual(imported.actions, [
        { url: `${origin}/dashboard`, outcome: 'succeeded' },
      ]);
      if (REAL_MODEL) {
        assert.ok(imported.calls.length >= 1);
        assert.ok(imported.calls.every((call) => call.status === 'settled'));
        assert.ok(
          imported.calls.some(
            (call) => call.reported_model === 'deepseek-flash',
          ),
        );
      }
      await coordinator.tick(project.id);
      const stage = await db.actor(
        actor,
        async (client) =>
          (await client.query('SELECT phase FROM runs WHERE id=$1', [run.id]))
            .rows[0]?.phase,
      );
      assert.equal(stage, 'plan');
      console.log(
        `Real PG 18 + Chromium: Worker.once auth + imported protected explore=success, phase=plan; ${REAL_MODEL ? `DeepSeek calls=${imported.calls.length}` : 'model decision stub only'}`,
      );
    } finally {
      if (crashChild && crashChild.exitCode === null) {
        if (process.platform === 'win32')
          spawnSync('taskkill', ['/PID', String(crashChild.pid), '/T', '/F'], {
            encoding: 'utf8',
            timeout: 15000,
          });
        else crashChild.kill('SIGKILL');
      }
      await uiBrowser?.close();
      await uiProxy?.closeAll();
      await browser?.close();
      if (apiServer)
        await new Promise((resolve) => {
          apiServer.close(resolve);
          apiServer.closeAllConnections();
        });
      await apiContext?.db.close();
      await db?.close();
      if (fixture) {
        fixture.close();
        await once(fixture, 'close').catch(() => {});
      }
      if (containerId) {
        const out = spawnSync(
          'docker',
          ['rm', '--force', '--volumes', containerId],
          {
            encoding: 'utf8',
            timeout: 30000,
          },
        );
        assert.equal(out.status, 0, 'Isolated PG container must be removed');
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
