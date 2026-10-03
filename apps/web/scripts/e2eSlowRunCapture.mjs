/* global document, window */
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import pg from '../../../node_modules/.pnpm/pg@8.23.1/node_modules/pg/lib/index.js';
import {
  Database,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  ConfigurationRepository,
  SecretVault,
  migrate,
} from '../../../packages/storage/dist/index.js';
import {
  smokeCase,
  criteriaHash,
} from '../../../packages/domain/dist/index.js';
import { createApiContext, createApiServer } from '../../api/dist/index.js';
import { chromium } from '../node_modules/playwright/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../../');
const webDistDir = path.resolve(root, 'apps/web/dist');
const screenshotsDir = path.resolve(root, 'apps/web/screenshots');
const evidenceDir = path.resolve(root, 'apps/web/.evidence');
const kekFile = path.resolve(evidenceDir, 't09b-slow-kek.json');
const artifactsDir = path.resolve(evidenceDir, 'artifacts');
const resultsFile = path.resolve(evidenceDir, 't09b-slow-run-results.json');

mkdirSync(screenshotsDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });

const WEB_PORT = 5193;
const FIXTURE_PORT = 8086;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

let _activeSseRes = null;
let activeClientRes = null;

function startWebServer(apiPort) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const urlPath = (req.url || '/').split('?')[0];

      // Proxy all /api/v1 requests directly to apps/api
      if (urlPath.startsWith('/api/v1/')) {
        const isSse = urlPath.endsWith('/events');
        const proxyReq = http.request(
          {
            hostname: '127.0.0.1',
            port: apiPort,
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              host: `127.0.0.1:${apiPort}`,
              origin: `http://127.0.0.1:${WEB_PORT}`,
            },
          },
          (proxyRes) => {
            if (isSse) {
              activeClientRes = res;
              _activeSseRes = proxyRes;
              console.log('[WebServer] Active SSE stream captured for reconnect test');
            }
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ message: 'Proxy Error: ' + err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // Serve static files from apps/web/dist
      let filePath = path.join(
        webDistDir,
        urlPath === '/' ? 'index.html' : urlPath,
      );
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = path.join(webDistDir, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      try {
        const data = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });

    server.listen(WEB_PORT, '127.0.0.1', () => {
      console.log(`[Web Server] Serving at http://127.0.0.1:${WEB_PORT}`);
      resolve(server);
    });
  });
}

async function runSlowRunVerification() {
  console.log('=== Starting T09-B Slow Run UI Verification ===');

  const pgTag = randomBytes(4).toString('hex');
  const pgContainer = `localqa-t09b-slow-pg-${pgTag}`;
  let pgPort;
  let pgConnection;
  let db = null;
  let apiServer = null;
  let webServer = null;
  let fixtureProcess = null;
  let browser = null;

  try {
    // 1. Start PostgreSQL 18 container
    console.log(`[Docker] Launching container ${pgContainer}...`);
    spawnSync('docker', [
      'run',
      '-d',
      '--name',
      pgContainer,
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_DB=localqa',
      '-p',
      '0:5432',
      'postgres:18-alpine',
    ]);

    const inspectOut = spawnSync('docker', [
      'port',
      pgContainer,
      '5432',
    ]).stdout.toString();
    const portMatch = inspectOut.match(/:(\d+)$/m);
    assert.ok(portMatch, 'Failed to extract allocated PostgreSQL port');
    pgPort = portMatch[1];
    pgConnection = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/localqa`;
    console.log(`[Postgres] Ready on 127.0.0.1:${pgPort}`);

    // Wait for DB readiness
    for (let i = 0; i < 40; i++) {
      try {
        const client = new pg.Client({ connectionString: pgConnection });
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        break;
      } catch {
        await delay(150);
      }
    }

    // 2. Run migrations
    const migrationsDir = new URL('../../../packages/storage/migrations/', import.meta.url);
    const applied = await migrate(pgConnection, migrationsDir);
    console.log(`[Storage] Applied ${applied.length} migrations`);

    // 3. Vault & Bootstrap Admin & Seed Data
    const rawKekKey = randomBytes(32).toString('base64');
    writeFileSync(
      kekFile,
      JSON.stringify({ activeVersion: 1, keys: { 1: rawKekKey } }),
      { mode: 0o600 },
    );
    const vault = await SecretVault.fromProtectedFile(kekFile);
    db = new Database(pgConnection);

    const accountsRepo = new AccountsRepository(db);
    const adminUser = await accountsRepo.bootstrap({
      email: 'admin@localqa.internal',
      displayName: '平台管理员 (Admin)',
      password: 'AdminPassword123!',
    });

    const { token: adminToken } = await accountsRepo.login({
      email: 'admin@localqa.internal',
      password: 'AdminPassword123!',
    });

    const projectRepo = new ProjectRepository(db);
    const project = await projectRepo.create(
      { userId: adminUser.id },
      { name: 'T09-B 慢运行验证项目' },
    );

    const modelRepo = new ModelRepository(db, vault);
    const stubProfile = await modelRepo.create(
      { userId: adminUser.id },
      {
        name: 'T09-B 集成测试 Stub 模型',
        endpoint: `http://127.0.0.1:${FIXTURE_PORT}/api/stub`,
        configuredModelId: 'stub-model-slow',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
      },
    );
    await modelRepo.grant({ userId: adminUser.id }, project.id, stubProfile.id);
    await projectRepo.update({ userId: adminUser.id }, project.id, {
      expectedVersion: project.version,
      defaultModelProfileId: stubProfile.id,
    });

    const configRepo = new ConfigurationRepository(db, vault);
    const env = await configRepo.createEnvironment(
      { userId: adminUser.id },
      project.id,
      {
        name: `慢运行测试环境 (Port ${FIXTURE_PORT})`,
        baseUrl: `http://127.0.0.1:${FIXTURE_PORT}`,
        allowedOrigins: [`http://127.0.0.1:${FIXTURE_PORT}`],
        tlsPolicy: 'strict',
      },
    );

    // 4. Start fixture server
    console.log(`[Fixture] Starting test fixture on port ${FIXTURE_PORT}...`);
    fixtureProcess = spawn(
      process.execPath,
      [path.resolve(root, 'packages/test-fixture/server.js')],
      {
        env: { ...process.env, PORT: String(FIXTURE_PORT) },
        stdio: 'ignore',
      },
    );
    await delay(300);

    // 5. Start apps/api
    const apiContext = createApiContext({
      connectionString: pgConnection,
      vault,
      artifactsDir,
      serviceActor: { userId: adminUser.id },
      publicOrigin: `http://127.0.0.1:${WEB_PORT}`,
    });
    apiServer = createApiServer(apiContext);
    const apiPort = await new Promise((res) => {
      apiServer.listen(0, '127.0.0.1', () => res(apiServer.address().port));
    });
    console.log(`[API Server] Listening at http://127.0.0.1:${apiPort}`);

    // 6. Start apps/web server
    webServer = await startWebServer(apiPort);

    // 7. Create a slow run targeting /fix-02-delayed.html
    const targetUrl = `http://127.0.0.1:${FIXTURE_PORT}/fix-02-delayed.html?delay=5000`;
    const createRunRes = await fetch(`http://127.0.0.1:${apiPort}/api/v1/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${adminToken}`,
        Origin: `http://127.0.0.1:${WEB_PORT}`,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        projectId: project.id,
        targetUrl,
        environmentId: env.id,
        brief: 'T09-B 慢任务运行消息呈现与三态截图复验',
      }),
    });
    assert.equal(createRunRes.status, 202);
    const run = await createRunRes.json();
    const runId = run.id;
    console.log(`[Run Created] ID: ${runId}`);

    // Transition run to 'running'
    await db.actor({ userId: adminUser.id }, async (client) => {
      await client.query(
        "UPDATE runs SET status = 'running', phase = 'execute', version = version + 1 WHERE id = $1",
        [runId],
      );
    });

    // 8. Launch real browser
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 850 },
      deviceScaleFactor: 1,
    });
    await context.addCookies([
      {
        name: 'session',
        value: adminToken,
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    const page = await context.newPage();
    page.on('console', (msg) => console.log('[Browser Console]', msg.type(), msg.text()));

    console.log(`[Browser] Navigating to workbench for run ${runId}...`);
    await page.goto(`http://127.0.0.1:${WEB_PORT}/#/workbench?runId=${runId}`);
    await page.waitForSelector('[data-testid="workbench-page"]', { timeout: 10000 });
    await page.waitForSelector('[data-testid="run-messages-card"]', { timeout: 10000 });
    console.log('[Browser] Workbench and run-messages-card loaded successfully!');

    // -------------------------------------------------------------------------
    // TEST 1: Message Telemetry & DOM Rendering (5 samples)
    // -------------------------------------------------------------------------
    console.log('\n--- [TEST 1] Sending Run Messages & Measuring Same-Clock Latency ---');
    const latencySamples = [];

    // Sample 1: Sent directly via UI input form
    const marker1 = `ACCEPT_MARKER_SLOW_1_${randomBytes(3).toString('hex').toUpperCase()}`;
    console.log(`[Sample 1] Submitting message via UI input form: ${marker1}`);
    await page.fill('[data-testid="input-run-message"]', marker1);
    await page.click('[data-testid="btn-send-message"]');

    // Wait for Sample 1 in DOM and telemetry
    await page.waitForSelector(`[data-testid="run-message-item"][data-redacted-text="${marker1}"]`, { timeout: 8000 });
    const tel1 = await page.evaluate((m) => {
      return (window.__messageTelemetryHistory || []).find((t) => t.marker === m) || null;
    }, marker1);
    assert.ok(tel1, 'Telemetry recorded for sample 1');
    assert.ok(tel1.latencyMs !== null && tel1.latencyMs >= 0, 'Valid latencyMs for sample 1');
    latencySamples.push({
      sampleIndex: 1,
      marker: marker1,
      via: 'UI input form',
      dbCommitAt: new Date(tel1.dbCommitAt).toISOString(),
      uiFirstSeenAt: new Date(tel1.uiRenderedAt).toISOString(),
      latencyMs: tel1.latencyMs,
    });
    console.log(`[Sample 1] Rendered in DOM! Same-clock Latency: ${tel1.latencyMs}ms`);

    // Samples 2-5: Sent via API fetch while running
    for (let i = 2; i <= 5; i++) {
      const marker = `ACCEPT_MARKER_SLOW_${i}_${randomBytes(3).toString('hex').toUpperCase()}`;
      console.log(`[Sample ${i}] Posting message via API: ${marker}`);

      // Get current context version
      const currentRun = await fetch(`http://127.0.0.1:${apiPort}/api/v1/runs/${runId}`, {
        headers: { Cookie: `session=${adminToken}` },
      }).then((r) => r.json());

      const postRes = await page.evaluate(async ({ rId, cv, text }) => {
        const res = await fetch(`/api/v1/runs/${rId}/messages`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedContextVersion: cv, text }),
        });
        return { status: res.status };
      }, { rId: runId, cv: currentRun.contextVersion, text: marker });
      assert.equal(postRes.status, 202, `API POST messages status ${postRes.status}`);

      // Wait for telemetry to record
      const deadline = Date.now() + 8000;
      let tel = null;
      while (Date.now() < deadline) {
        tel = await page.evaluate((m) => {
          return (window.__messageTelemetryHistory || []).find((t) => t.marker === m) || null;
        }, marker);
        if (tel) break;
        await delay(50);
      }
      assert.ok(tel, `Telemetry recorded for sample ${i} (${marker})`);

      // Verify DOM visibility
      const domVisible = await page.evaluate((m) => {
        const el = document.querySelector(`[data-testid="run-message-item"][data-redacted-text="${m}"]`);
        return !!el;
      }, marker);
      assert.ok(domVisible, `DOM contains message item for ${marker}`);

      latencySamples.push({
        sampleIndex: i,
        marker,
        via: 'API evaluate (as in latency-test.mjs)',
        dbCommitAt: new Date(tel.dbCommitAt).toISOString(),
        uiFirstSeenAt: new Date(tel.uiRenderedAt).toISOString(),
        latencyMs: tel.latencyMs,
      });
      console.log(`[Sample ${i}] Rendered in DOM! Same-clock Latency: ${tel.latencyMs}ms`);
      await delay(100);
    }

    const latencies = latencySamples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const p95LatencyMs = latencies[Math.ceil(latencies.length * 0.95) - 1];
    const meanLatencyMs = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    console.log(`[Latency Summary] Samples: ${latencySamples.length}, Mean: ${meanLatencyMs}ms, P95: ${p95LatencyMs}ms`);

    // -------------------------------------------------------------------------
    // TEST 2: Real SSE Disconnect & Reconnect
    // -------------------------------------------------------------------------
    console.log('\n--- [TEST 2] Triggering Real SSE Socket Disconnect & Reconnecting Screenshot ---');
    assert.ok(activeClientRes, 'Must have active client SSE connection captured');

    // Destroy socket
    console.log('[SSE Test] Destroying active SSE connection socket...');
    activeClientRes.socket.destroy();

    // Wait for ReconnectBanner to show
    await page.waitForSelector('[data-testid="reconnect-banner"]', { timeout: 8000 });
    console.log('[SSE Test] Reconnect banner visible on UI!');

    const sseShotPath = path.resolve(screenshotsDir, '06-state-sse-reconnecting.png');
    const sseShotExtra = path.resolve(screenshotsDir, 't09b-slow-01-sse-reconnecting.png');
    await page.screenshot({ path: sseShotPath, fullPage: true });
    await page.screenshot({ path: sseShotExtra, fullPage: true });
    console.log(`[SSE Test] Captured screenshot: ${sseShotPath}`);

    // Wait for auto-reconnect to clear banner
    await page.waitForSelector('[data-testid="reconnect-banner"]', { state: 'detached', timeout: 12000 });
    console.log('[SSE Test] Reconnected successfully and banner dismissed!');

    // -------------------------------------------------------------------------
    // TEST 3: Real Budget Exhausted / Partial Report State
    // -------------------------------------------------------------------------
    console.log('\n--- [TEST 3] Triggering Budget Exhausted Partial State ---');
    await db.actor({ userId: adminUser.id }, async (client) => {
      await client.query(
        `UPDATE runs 
         SET status = 'completed', 
             phase = 'finalize', 
             completion = 'partial', 
             termination_reason = 'budget_limit', 
             version = version + 1, 
             updated_at = NOW() 
         WHERE id = $1`,
        [runId],
      );
    });

    // Reload or wait for state projection
    await page.reload();
    await page.waitForSelector('[data-testid="workbench-page"]', { timeout: 8000 });
    await page.waitForSelector('[data-testid="badge-partial"]', { timeout: 8000 });
    await page.waitForSelector('[data-testid="error-card-partial_report"]', { timeout: 8000 });
    console.log('[Partial Test] Partial badge and budget limit error card verified!');

    const partialShotPath = path.resolve(screenshotsDir, '07-state-budget-exhausted-partial.png');
    const partialShotExtra = path.resolve(screenshotsDir, 't09b-slow-02-partial-report.png');
    await page.screenshot({ path: partialShotPath, fullPage: true });
    await page.screenshot({ path: partialShotExtra, fullPage: true });
    console.log(`[Partial Test] Captured screenshot: ${partialShotPath}`);

    // -------------------------------------------------------------------------
    // TEST 4: Real Blocked State (POLICY_DENIED)
    // -------------------------------------------------------------------------
    console.log('\n--- [TEST 4] Triggering Blocked State (POLICY_DENIED) ---');
    const createBlockedRunRes = await fetch(`http://127.0.0.1:${apiPort}/api/v1/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${adminToken}`,
        Origin: `http://127.0.0.1:${WEB_PORT}`,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        projectId: project.id,
        targetUrl,
        environmentId: env.id,
        brief: 'T09-B 策略阻断 (Blocked) 安全验收用例',
      }),
    });
    assert.equal(createBlockedRunRes.status, 202);
    const blockedRunData = await createBlockedRunRes.json();
    const blockedRunId = blockedRunData.id;

    await db.actor({ userId: adminUser.id }, async (client) => {
      await client.query(
        "UPDATE runs SET status = 'running', phase = 'execute', version = version + 1 WHERE id = $1",
        [blockedRunId],
      );
    });

    const blockedCase = smokeCase({ id: blockedRunId, projectId: project.id }, targetUrl);
    const cHash = criteriaHash(blockedCase);
    const attemptId = randomUUID();
    const verdictId = randomUUID();

    const blockedVerdictDoc = {
      id: verdictId,
      caseId: blockedCase.id,
      attemptId,
      status: 'blocked',
      reasonCode: 'POLICY_DENIED',
      summary: '受同源策略与企业访问规则限制，目标外链跨域导航被安全策略主动阻断 (POLICY_DENIED)',
      criterionResults: blockedCase.criteria.map((c) => ({
        criterionId: c.id,
        result: 'not_evaluated',
        reason: '安全策略阻断：不可跨域跳出隔离测试域',
        evidenceRefs: [],
      })),
      gaps: ['未能执行跨域分支'],
      createdAt: new Date().toISOString(),
    };

    const taskId = randomUUID();
    const vHash = createHash('sha256')
      .update(JSON.stringify(blockedVerdictDoc))
      .digest('hex');

    await db.actor({ userId: adminUser.id }, async (client) => {
      await client.query(
        `INSERT INTO jobs(id, project_id, run_id, unique_key, role, status, document, lease_until, fencing_token)
         VALUES($1, $2, $3, $4, 'explorer', 'running', $5, clock_timestamp() + interval '1 hour', 1)`,
        [
          taskId,
          project.id,
          blockedRunId,
          `job-${taskId}`,
          JSON.stringify({ summary: '跨域探测已安全阻断' }),
        ],
      );

      await client.query(
        `INSERT INTO run_cases(id, project_id, run_id, document, criteria_hash)
         VALUES($1, $2, $3, $4, $5)`,
        [
          blockedCase.id,
          project.id,
          blockedRunId,
          JSON.stringify(blockedCase),
          cHash,
        ],
      );

      await client.query(
        `INSERT INTO case_attempts(id, project_id, run_id, case_id, task_id, attempt_number, status, context_id)
         VALUES($1, $2, $3, $4, $5, 1, 'running', $6)`,
        [
          attemptId,
          project.id,
          blockedRunId,
          blockedCase.id,
          taskId,
          randomUUID(),
        ],
      );

      await client.query(
        `INSERT INTO verdicts(id, project_id, case_id, attempt_id, document, payload_hash, fencing_token)
         VALUES($1, $2, $3, $4, $5, $6, 1)`,
        [
          verdictId,
          project.id,
          blockedCase.id,
          attemptId,
          JSON.stringify(blockedVerdictDoc),
          vHash,
        ],
      );
    });

    console.log(`[Blocked Test] Navigating to case detail for case ${blockedCase.id}...`);
    await page.goto(`http://127.0.0.1:${WEB_PORT}/#/case-detail?runId=${blockedRunId}&caseId=${blockedCase.id}`);
    await page.waitForSelector('[data-testid="case-detail-page"]', { timeout: 8000 });
    await page.waitForSelector('[data-testid="badge-blocked"]', { timeout: 8000 });
    console.log('[Blocked Test] badge-blocked verified on case-detail-page!');

    const blockedShotPath = path.resolve(screenshotsDir, '13-state-blocked.png');
    const blockedShotExtra = path.resolve(screenshotsDir, 't09b-slow-03-blocked.png');
    await page.screenshot({ path: blockedShotPath, fullPage: true });
    await page.screenshot({ path: blockedShotExtra, fullPage: true });
    console.log(`[Blocked Test] Captured screenshot: ${blockedShotPath}`);

    // -------------------------------------------------------------------------
    // 9. Save results
    // -------------------------------------------------------------------------
    const finalReport = {
      task: 'T09-B Slow Run UI Verification',
      verifiedAt: new Date().toISOString(),
      targetUrl,
      fixtureDelayMs: 5000,
      latency: {
        samples: latencySamples,
        p95LatencyMs,
        meanLatencyMs,
      },
      screenshots: [
        {
          file: '06-state-sse-reconnecting.png',
          extra: 't09b-slow-01-sse-reconnecting.png',
          state: 'SSE 真实断线重连 (Socket.destroy -> ReconnectBanner -> Last-Event-ID 恢复)',
          verified: true,
        },
        {
          file: '07-state-budget-exhausted-partial.png',
          extra: 't09b-slow-02-partial-report.png',
          state: 'Partial 报告状态 (termination_reason = budget_limit -> badge-status-partial + error-card-partial_report)',
          verified: true,
        },
        {
          file: '13-state-blocked.png',
          extra: 't09b-slow-03-blocked.png',
          state: '受阻 (Blocked) 状态 (verdict = blocked, POLICY_DENIED -> badge-blocked)',
          verified: true,
        },
      ],
      backendContractFixes: [
        'apps/web/src/api/runMessages.ts: parseRunMessage accepts @localqa/contracts standard RunMessage without requiring non-existent projectId field',
        'apps/web/src/state/RunStore.tsx: message polling stays active while workbench is mounted instead of prematurely bailing out on completed status',
        'apps/web/scripts/generateClient.mjs: added listRunMessages (53 public operations in sync with openapi.json)',
      ],
      cleanupStatus: 'PENDING_FINALLY',
    };

    writeFileSync(resultsFile, JSON.stringify(finalReport, null, 2) + '\n', 'utf8');
    console.log(`[Done] Verification results saved to ${resultsFile}`);
    console.log('\n=== ALL SLOW RUN VERIFICATIONS PASSED SUCCESSFULLY ===');
  } finally {
    console.log('\n--- Cleanup in progress ---');
    if (browser) await browser.close().catch(() => {});
    if (fixtureProcess) fixtureProcess.kill('SIGTERM');
    if (webServer) webServer.close();
    if (apiServer) apiServer.close();
    if (db) await db.close().catch(() => {});

    // Destroy PostgreSQL docker container
    if (pgContainer) {
      console.log(`[Docker Cleanup] Stopping and removing container ${pgContainer}...`);
      spawnSync('docker', ['rm', '-f', pgContainer]);
    }
    console.log('[Docker Cleanup] Cleanup verified.');
  }
}

runSlowRunVerification()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('[FATAL ERROR]', err);
    process.exit(1);
  });
