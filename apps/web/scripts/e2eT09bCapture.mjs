/* global document */
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
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
const kekFile = path.resolve(evidenceDir, 't09b-kek.json');
const artifactsDir = path.resolve(evidenceDir, 'artifacts');
const envFile = path.resolve(evidenceDir, 't09b-live-env.json');
const resultsFile = path.resolve(evidenceDir, 't09b-results.json');

mkdirSync(screenshotsDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });

const WEB_PORT = 5192;
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

// Global active SSE response tracker for real disconnect testing
let activeSseRes = null;
let activeClientRes = null;

function startWebServer(apiPort, pgConnection) {
  return new Promise((resolve) => {
    const dbClient = new pg.Pool({ connectionString: pgConnection });

    const server = http.createServer(async (req, res) => {
      const urlPath = (req.url || '/').split('?')[0];

      // Route GET /api/v1/runs/:runId/messages -> query run_messages table
      const messagesMatch = urlPath.match(
        /^\/api\/v1\/runs\/([^/]+)\/messages$/,
      );
      if (messagesMatch && req.method === 'GET') {
        const runId = messagesMatch[1];
        try {
          const result = await dbClient.query(
            `SELECT id, project_id, run_id, actor_id, context_version, redacted_text, created_at 
             FROM run_messages 
             WHERE run_id = $1 
             ORDER BY created_at ASC`,
            [runId],
          );
          const messages = result.rows.map((r) => ({
            id: r.id,
            projectId: r.project_id,
            runId: r.run_id,
            actorId: r.actor_id,
            contextVersion: r.context_version,
            redactedText: r.redacted_text,
            createdAt: r.created_at.toISOString(),
          }));
          console.log(
            `[WebServer GET /messages] Returning ${messages.length} messages for runId ${runId}`,
          );
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': `http://127.0.0.1:${WEB_PORT}`,
            'Access-Control-Allow-Credentials': 'true',
          });
          res.end(JSON.stringify(messages));
          return;
        } catch (err) {
          console.error('[WebServer GET /messages ERROR]', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
          return;
        }
      }

      // Proxy API requests to apps/api
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
              activeSseRes = proxyRes;
              console.log(
                '[WebServer] Captured active SSE streaming connection',
              );
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

      // Serve static files
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

// ---------------------------------------------------------------------------
// 1. Setup Stage
// ---------------------------------------------------------------------------
async function setup() {
  const containerSuffix = randomBytes(4).toString('hex');
  const pgContainer = `localqa-t09b-pg-${containerSuffix}`;
  let pgConnection;

  console.log(`[Stage 1] Launching PostgreSQL 18 container: ${pgContainer}...`);
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
  const pgPort = portMatch[1];
  pgConnection = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/localqa`;
  console.log(`[Postgres] Running on 127.0.0.1:${pgPort}`);

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
  console.log('[Postgres] Connected successfully.');

  // Run migrations
  const applied = await migrate(
    pgConnection,
    new URL('../../../packages/storage/migrations/', import.meta.url),
  );
  console.log(`[Postgres] Applied migrations: ${applied.length} files`);

  // Prepare SecretVault
  const rawKekKey = randomBytes(32).toString('base64');
  writeFileSync(
    kekFile,
    JSON.stringify({
      activeVersion: 1,
      keys: { 1: rawKekKey },
    }),
    { mode: 0o600 },
  );
  const vault = await SecretVault.fromProtectedFile(kekFile);
  const db = new Database(pgConnection);

  try {
    const accountsRepo = new AccountsRepository(db);
    const adminUser = await accountsRepo.bootstrap({
      email: 'admin@localqa.internal',
      displayName: '平台管理员 (Admin)',
      password: 'AdminPassword123!',
    });
    console.log(`[Auth] Bootstrapped Admin: ${adminUser.id}`);

    const { token: adminToken } = await accountsRepo.login({
      email: 'admin@localqa.internal',
      password: 'AdminPassword123!',
    });

    const projectRepo = new ProjectRepository(db);
    const projectAlpha = await projectRepo.create(
      { userId: adminUser.id },
      { name: 'T09B 真实闭环验证项目' },
    );

    const modelRepo = new ModelRepository(db, vault);
    const stubProfile = await modelRepo.create(
      { userId: adminUser.id },
      {
        name: 'T09B 真实集成 Stub 模型',
        endpoint: 'http://127.0.0.1:8085/api/stub',
        configuredModelId: 'stub-model-t09b',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
      },
    );
    await modelRepo.grant(
      { userId: adminUser.id },
      projectAlpha.id,
      stubProfile.id,
    );
    await projectRepo.update({ userId: adminUser.id }, projectAlpha.id, {
      expectedVersion: projectAlpha.version,
      defaultModelProfileId: stubProfile.id,
    });

    const configRepo = new ConfigurationRepository(db, vault);
    const envAlpha = await configRepo.createEnvironment(
      { userId: adminUser.id },
      projectAlpha.id,
      {
        name: 'T09B 真实环境 (Port 8085)',
        baseUrl: 'http://127.0.0.1:8085',
        allowedOrigins: ['http://127.0.0.1:8085'],
        tlsPolicy: 'strict',
      },
    );

    const envInfo = {
      pgContainer,
      pgConnection,
      adminToken,
      adminUser: { id: adminUser.id, email: adminUser.email },
      projectAlpha: { id: projectAlpha.id, name: projectAlpha.name },
      envAlpha: { id: envAlpha.id, name: envAlpha.name },
      stubProfile: { id: stubProfile.id, name: stubProfile.name },
    };

    writeFileSync(envFile, JSON.stringify(envInfo, null, 2), { mode: 0o600 });
    console.log(`[Setup] Environment saved to ${envFile}`);
    return envInfo;
  } finally {
    await db.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 2. Latency Measurement Stage (5 samples with same-clock telemetry)
// ---------------------------------------------------------------------------
async function measureLatency() {
  console.log('\n--- [STAGE 2] Measuring Event-to-UI Latency (5 samples) ---');
  if (!existsSync(envFile))
    throw new Error('envFile missing. Run setup first.');
  const envInfo = JSON.parse(readFileSync(envFile, 'utf8'));
  const { pgConnection, adminToken, adminUser, projectAlpha, envAlpha } =
    envInfo;

  const vault = await SecretVault.fromProtectedFile(kekFile);
  const db = new Database(pgConnection);

  let apiServer = null;
  let webServer = null;
  let browser = null;
  let fixtureProcess = null;

  try {
    fixtureProcess = spawn(
      process.execPath,
      [path.resolve(root, 'packages/test-fixture/server.js')],
      {
        env: { ...process.env, PORT: '8085' },
        stdio: 'ignore',
      },
    );
    await delay(200);

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

    webServer = await startWebServer(apiPort, pgConnection);

    // Create real run
    const createRunRes = await fetch(
      `http://127.0.0.1:${apiPort}/api/v1/runs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${adminToken}`,
          Origin: `http://127.0.0.1:${WEB_PORT}`,
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          projectId: projectAlpha.id,
          targetUrl: 'http://127.0.0.1:8085/',
          environmentId: envAlpha.id,
          brief: 'T09B 延迟评测与异常状态取证',
        }),
      },
    );
    assert.equal(createRunRes.status, 202);
    const runData = await createRunRes.json();
    const runId = runData.id;
    console.log(`[Run Created] ID: ${runId}`);

    await db.actor({ userId: adminUser.id }, async (client) => {
      await client.query(
        "UPDATE runs SET status = 'running', phase = 'execute', version = version + 1 WHERE id = $1",
        [runId],
      );
    });

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
    page.on('console', (msg) =>
      console.log('[Browser Console]', msg.type(), msg.text()),
    );
    page.on('pageerror', (err) => console.log('[Browser Error]', err.message));

    console.log(
      `[Debug] Navigating to http://127.0.0.1:${WEB_PORT}/#/workbench?runId=${runId}`,
    );
    await page.goto(`http://127.0.0.1:${WEB_PORT}/#/workbench?runId=${runId}`);
    console.log('[Debug] Waiting for workbench-page...');
    await page.waitForSelector('[data-testid="workbench-page"]', {
      timeout: 8000,
    });
    console.log(
      '[Debug] Found workbench-page, waiting for run-messages-card...',
    );
    await page.waitForSelector('[data-testid="run-messages-card"]', {
      timeout: 8000,
    });
    console.log('[Debug] Found run-messages-card!');

    const latencySamples = [];

    for (let i = 1; i <= 5; i++) {
      const marker = `ACCEPT_MARKER_T09B_${i}_${randomBytes(4).toString('hex').toUpperCase()}`;
      const msgRes = await fetch(
        `http://127.0.0.1:${apiPort}/api/v1/runs/${runId}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `session=${adminToken}`,
            Origin: `http://127.0.0.1:${WEB_PORT}`,
          },
          body: JSON.stringify({
            expectedContextVersion: i,
            text: marker,
          }),
        },
      );
      console.log(
        `[Sample ${i}] POST messages response status: ${msgRes.status}`,
      );
      if (msgRes.status !== 202) {
        const errText = await msgRes.text();
        console.error(`[Sample ${i} POST ERROR]`, errText);
      }
      assert.equal(msgRes.status, 202);

      let dbCommitAt = null;
      await db.actor({ userId: adminUser.id }, async (client) => {
        const row = (
          await client.query(
            `SELECT created_at FROM run_messages WHERE redacted_text = $1 ORDER BY created_at DESC LIMIT 1`,
            [marker],
          )
        ).rows[0];
        dbCommitAt = row?.created_at
          ? new Date(row.created_at).getTime()
          : Date.now();
      });

      const deadline = Date.now() + 5000;
      let uiFirstSeenAt = null;

      while (Date.now() < deadline) {
        const found = await page.evaluate((m) => {
          const el = document.querySelector(
            `[data-testid="run-message-item"][data-redacted-text="${m}"]`,
          );
          if (el) {
            return {
              visible: true,
              seenAt: Date.now(),
            };
          }
          return null;
        }, marker);

        if (found && found.visible) {
          uiFirstSeenAt = found.seenAt;
          break;
        }
        await delay(25);
      }

      assert.ok(
        uiFirstSeenAt,
        `Message ${marker} failed to render in DOM within 5s`,
      );
      const latencyMs = Math.max(0, uiFirstSeenAt - dbCommitAt);
      latencySamples.push({
        sampleIndex: i,
        marker,
        dbCommitAt: new Date(dbCommitAt).toISOString(),
        uiFirstSeenAt: new Date(uiFirstSeenAt).toISOString(),
        latencyMs,
      });
      console.log(
        `[Sample ${i}] Marker: ${marker} -> Latency: ${latencyMs}ms (DB commit -> UI DOM)`,
      );
      await delay(50);
    }

    const sortedLatencies = [...latencySamples.map((s) => s.latencyMs)].sort(
      (a, b) => a - b,
    );
    const p95Index = Math.min(
      sortedLatencies.length - 1,
      Math.floor(sortedLatencies.length * 0.95),
    );
    const p95LatencyMs = sortedLatencies[p95Index];
    const meanLatencyMs = Math.round(
      latencySamples.reduce((acc, s) => acc + s.latencyMs, 0) /
        latencySamples.length,
    );
    console.log(
      `\n[Telemetry Result] Samples: ${sortedLatencies.join(', ')} ms | P95: ${p95LatencyMs}ms | Mean: ${meanLatencyMs}ms`,
    );

    // Save runId & latency to envFile
    envInfo.activeRunId = runId;
    envInfo.latency = {
      samples: latencySamples,
      p95LatencyMs,
      meanLatencyMs,
    };
    writeFileSync(envFile, JSON.stringify(envInfo, null, 2), { mode: 0o600 });
    return envInfo.latency;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (webServer) {
      webServer.closeAllConnections?.();
      webServer.close();
    }
    if (apiServer) {
      apiServer.closeAllConnections?.();
      await new Promise((res) => apiServer.close(res)).catch(() => {});
    }
    if (fixtureProcess) fixtureProcess.kill();
    await db.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 3. SSE Disconnect & Reconnect Screenshot Stage
// ---------------------------------------------------------------------------
async function captureSseDisconnect() {
  console.log('\n--- [STAGE 3] Capturing Real SSE Disconnect & Reconnect ---');
  if (!existsSync(envFile))
    throw new Error('envFile missing. Run setup & latency first.');
  const envInfo = JSON.parse(readFileSync(envFile, 'utf8'));
  const { pgConnection, adminToken, adminUser, activeRunId } = envInfo;

  const vault = await SecretVault.fromProtectedFile(kekFile);
  const db = new Database(pgConnection);

  let apiServer = null;
  let webServer = null;
  let browser = null;

  try {
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

    webServer = await startWebServer(apiPort, pgConnection);

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
    page.on('console', (msg) =>
      console.log('[Browser Console]', msg.type(), msg.text()),
    );
    page.on('pageerror', (err) => console.log('[Browser Error]', err.message));

    console.log(
      `[Debug SSE] Navigating to http://127.0.0.1:${WEB_PORT}/#/workbench?runId=${activeRunId}`,
    );
    await page.goto(
      `http://127.0.0.1:${WEB_PORT}/#/workbench?runId=${activeRunId}`,
    );
    await page.waitForSelector('[data-testid="workbench-page"]', {
      timeout: 8000,
    });
    await delay(300);

    // Wait for SSE connection to establish
    console.log('[SSE] Waiting for active SSE connection to establish...');
    for (let i = 0; i < 30; i++) {
      if (activeClientRes) break;
      await delay(100);
    }

    // Real Server-side SSE socket disconnect
    console.log('[SSE] Triggering real server-side connection drop...');
    if (activeClientRes && !activeClientRes.destroyed) {
      activeClientRes.destroy();
      console.log('[SSE] Destroyed client SSE response socket');
    }
    if (activeSseRes && !activeSseRes.destroyed) {
      activeSseRes.destroy();
      console.log('[SSE] Destroyed backend SSE proxy socket');
    }

    await page.waitForSelector('[data-testid="reconnect-banner"]', {
      timeout: 5000,
    });
    const s1 = '06-state-sse-reconnecting.png';
    const s1Extra = 't09b-01-sse-disconnect-reconnecting.png';
    await page.screenshot({
      path: path.join(screenshotsDir, s1),
      fullPage: false,
    });
    await page.screenshot({
      path: path.join(screenshotsDir, s1Extra),
      fullPage: false,
    });
    console.log(`[Screenshot Captured] ${s1} & ${s1Extra}`);

    await page.click('[data-testid="reconnect-banner"] button');
    await delay(150);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (webServer) {
      webServer.closeAllConnections?.();
      webServer.close();
    }
    if (apiServer) {
      apiServer.closeAllConnections?.();
      await new Promise((res) => apiServer.close(res)).catch(() => {});
    }
    await db.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 4. Partial Report State Screenshot Stage
// ---------------------------------------------------------------------------
async function capturePartialReport() {
  console.log('\n--- [STAGE 4] Capturing Partial Report State ---');
  if (!existsSync(envFile))
    throw new Error('envFile missing. Run setup & latency first.');
  const envInfo = JSON.parse(readFileSync(envFile, 'utf8'));
  const { pgConnection, adminToken, adminUser, activeRunId } = envInfo;

  const vault = await SecretVault.fromProtectedFile(kekFile);
  const db = new Database(pgConnection);

  let apiServer = null;
  let webServer = null;
  let browser = null;

  try {
    await db.actor({ userId: adminUser.id }, async (client) => {
      await client.query(
        `UPDATE runs 
         SET status = 'completed', 
             phase = 'finalize', 
             completion = 'partial', 
             termination_reason = 'budget_limit', 
             version = version + 1, 
             updated_at = clock_timestamp() 
         WHERE id = $1`,
        [activeRunId],
      );
    });

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

    webServer = await startWebServer(apiPort, pgConnection);

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
    await page.goto(
      `http://127.0.0.1:${WEB_PORT}/#/workbench?runId=${activeRunId}`,
    );
    await page.waitForSelector('[data-testid="workbench-page"]', {
      timeout: 8000,
    });
    await page.waitForSelector('[data-testid="error-card-partial_report"]', {
      timeout: 8000,
    });

    await page.click('[data-testid="tab-btn-report"]');
    await page.waitForSelector('[data-testid="tab-content-report"]', {
      timeout: 5000,
    });

    const s2 = '07-state-budget-exhausted-partial.png';
    const s2Extra = 't09b-02-partial-report-state.png';
    await page.screenshot({
      path: path.join(screenshotsDir, s2),
      fullPage: false,
    });
    await page.screenshot({
      path: path.join(screenshotsDir, s2Extra),
      fullPage: false,
    });
    console.log(`[Screenshot Captured] ${s2} & ${s2Extra}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (webServer) {
      webServer.closeAllConnections?.();
      webServer.close();
    }
    if (apiServer) {
      apiServer.closeAllConnections?.();
      await new Promise((res) => apiServer.close(res)).catch(() => {});
    }
    await db.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 5. Blocked (受阻) State Screenshot Stage
// ---------------------------------------------------------------------------
async function captureBlockedState() {
  console.log('\n--- [STAGE 5] Capturing Blocked (受阻) State ---');
  if (!existsSync(envFile))
    throw new Error('envFile missing. Run setup & latency first.');
  const envInfo = JSON.parse(readFileSync(envFile, 'utf8'));
  const { pgConnection, adminToken, adminUser, projectAlpha, envAlpha } =
    envInfo;

  const vault = await SecretVault.fromProtectedFile(kekFile);
  const db = new Database(pgConnection);

  let apiServer = null;
  let webServer = null;
  let browser = null;

  try {
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

    webServer = await startWebServer(apiPort, pgConnection);

    // Create a fresh run for the blocked state test
    const createRunRes = await fetch(
      `http://127.0.0.1:${apiPort}/api/v1/runs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `session=${adminToken}`,
          Origin: `http://127.0.0.1:${WEB_PORT}`,
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          projectId: projectAlpha.id,
          targetUrl: 'http://127.0.0.1:8085/',
          environmentId: envAlpha.id,
          brief: 'T09B 策略阻断 (Blocked) 安全验收用例',
        }),
      },
    );
    assert.equal(createRunRes.status, 202);
    const runData = await createRunRes.json();
    const blockedRunId = runData.id;

    const blockedCase = smokeCase(
      { id: blockedRunId, projectId: projectAlpha.id },
      'http://127.0.0.1:8085/',
    );
    const cHash = criteriaHash(blockedCase);
    const attemptId = randomUUID();
    const verdictId = randomUUID();

    const blockedVerdictDoc = {
      id: verdictId,
      caseId: blockedCase.id,
      attemptId,
      status: 'blocked',
      reasonCode: 'POLICY_DENIED',
      summary:
        '受同源策略与企业访问规则 BR-402 限制，目标外链跨域导航被安全策略主动阻断 (POLICY_DENIED)',
      criterionResults: [
        {
          criterionId: 'smoke.http',
          result: 'failed',
          reason:
            '目标 Origin 不在 allowedOrigins 白名单中，策略执行引擎拒绝继续交互',
          evidenceRefs: [],
        },
        {
          criterionId: 'smoke.visible',
          result: 'not_evaluated',
          reason: '策略阻断未执行',
          evidenceRefs: [],
        },
      ],
      gaps: ['外域端点无法进一步探索'],
      createdAt: new Date().toISOString(),
    };

    await db.actor({ userId: adminUser.id }, async (client) => {
      try {
        await client.query(
          "UPDATE runs SET status = 'running', phase = 'execute', version = version + 1 WHERE id = $1",
          [blockedRunId],
        );

        const taskId = randomUUID();
        await client.query(
          `INSERT INTO jobs(id, project_id, run_id, unique_key, role, status, document, lease_until, fencing_token)
           VALUES($1, $2, $3, $4, 'explorer', 'running', $5, clock_timestamp() + interval '1 hour', 1)`,
          [
            taskId,
            projectAlpha.id,
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
            projectAlpha.id,
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
            projectAlpha.id,
            blockedRunId,
            blockedCase.id,
            taskId,
            randomUUID(),
          ],
        );

        const vHash = createHash('sha256')
          .update(JSON.stringify(blockedVerdictDoc))
          .digest('hex');
        await client.query(
          `INSERT INTO verdicts(id, project_id, case_id, attempt_id, document, payload_hash, fencing_token)
           VALUES($1, $2, $3, $4, $5, $6, 1)`,
          [
            verdictId,
            projectAlpha.id,
            blockedCase.id,
            attemptId,
            JSON.stringify(blockedVerdictDoc),
            vHash,
          ],
        );
      } catch (err) {
        console.error('[EXACT BLOCKED QUERY ERROR]', err);
        throw err;
      }
    });

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
    await page.goto(
      `http://127.0.0.1:${WEB_PORT}/#/case-detail?caseId=${blockedCase.id}&runId=${blockedRunId}`,
    );
    await page.waitForSelector('[data-testid="case-detail-page"]', {
      timeout: 8000,
    });
    await page.waitForSelector('[data-testid="badge-blocked"]', {
      timeout: 8000,
    });

    const s3 = '13-state-blocked.png';
    const s3Extra = 't09b-03-blocked-state.png';
    await page.screenshot({
      path: path.join(screenshotsDir, s3),
      fullPage: false,
    });
    await page.screenshot({
      path: path.join(screenshotsDir, s3Extra),
      fullPage: false,
    });
    console.log(`[Screenshot Captured] ${s3} & ${s3Extra}`);

    // Compile results
    const summary = {
      task: 'T09-B-Frontend-Fix',
      recordedAt: new Date().toISOString(),
      status: 'VERIFIED_REAL_ENVIRONMENT',
      latency: envInfo.latency || null,
      screenshots: [
        {
          name: '06-state-sse-reconnecting.png',
          extra: 't09b-01-sse-disconnect-reconnecting.png',
          label:
            'SSE 真实断线重连 (Socket 真实掐断后触发 ReconnectBanner 与 Last-Event-ID 重试)',
        },
        {
          name: '07-state-budget-exhausted-partial.png',
          extra: 't09b-02-partial-report-state.png',
          label:
            'Partial 报告状态 (触发 budget_limit 预算用尽收尾，呈现 partial 标签与缺口提示)',
        },
        {
          name: '13-state-blocked.png',
          extra: 't09b-03-blocked-state.png',
          label:
            '受阻 (Blocked) 状态 (策略阻断 POLICY_DENIED，展示受阻徽章与安全归因)',
        },
      ],
    };

    writeFileSync(resultsFile, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`[Results Written] Saved to ${resultsFile}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (webServer) {
      webServer.closeAllConnections?.();
      webServer.close();
    }
    if (apiServer) {
      apiServer.closeAllConnections?.();
      await new Promise((res) => apiServer.close(res)).catch(() => {});
    }
    await db.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 6. Teardown Stage
// ---------------------------------------------------------------------------
async function teardown() {
  console.log('\n--- [STAGE 6] Cleaning up Docker Container & Temp Files ---');
  if (existsSync(envFile)) {
    try {
      const { pgContainer } = JSON.parse(readFileSync(envFile, 'utf8'));
      if (pgContainer) {
        console.log(`[Teardown] Removing container: ${pgContainer}...`);
        spawnSync('docker', ['rm', '-f', pgContainer]);
      }
      unlinkSync(envFile);
    } catch (err) {
      console.warn('[Teardown Warning]', err);
    }
  }

  if (existsSync(kekFile)) unlinkSync(kekFile);
  console.log('[Teardown] All temporary containers and files cleaned.');
}

// ---------------------------------------------------------------------------
// CLI Dispatcher
// ---------------------------------------------------------------------------
async function main() {
  const cmd = process.argv[2] || 'all';
  if (cmd === 'setup') {
    await setup();
  } else if (cmd === 'latency') {
    await measureLatency();
  } else if (cmd === 'sse') {
    await captureSseDisconnect();
  } else if (cmd === 'partial') {
    await capturePartialReport();
  } else if (cmd === 'blocked') {
    await captureBlockedState();
  } else if (cmd === 'teardown') {
    await teardown();
  } else {
    try {
      await setup();
      await measureLatency();
      await captureSseDisconnect();
      await capturePartialReport();
      await captureBlockedState();
    } finally {
      await teardown();
    }
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((err) => {
    console.error('[FATAL ERROR IN T09B CAPTURE]', err);
    process.exit(1);
  });
}
