import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  Database,
  AccountsRepository,
  ProjectRepository,
  ConfigurationRepository,
  ModelRepository,
  SecretVault,
  migrate,
} from '../../../packages/storage/dist/index.js';
import { createApiContext, createApiServer } from '../../api/dist/index.js';
import {
  smokeCase,
  criteriaHash,
} from '../../../packages/domain/dist/index.js';

/**
 * Allocate a random free local TCP port.
 */
async function getFreePort() {
  const sock = net.createServer();
  await new Promise((resolve) => sock.listen(0, '127.0.0.1', resolve));
  const address = sock.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => sock.close(resolve));
  return port;
}

/**
 * Helper to roll back partially allocated resources in reverse order.
 * Strictly cleans by exact container ID, process/server handle, and directory path.
 */
async function rollbackResources(cleanupStack) {
  for (let i = cleanupStack.length - 1; i >= 0; i--) {
    const item = cleanupStack[i];
    try {
      if (item.type === 'server' && item.server) {
        await new Promise((resolve) => item.server.close(resolve));
        console.log(
          `  [Rollback] Closed server "${item.name}" on port ${item.port}`,
        );
      } else if (item.type === 'db' && item.db) {
        await item.db.close().catch(() => {});
        console.log('  [Rollback] Closed PostgreSQL database pool');
      } else if (item.type === 'apiContext' && item.apiContext?.db) {
        await item.apiContext.db.close().catch(() => {});
      } else if (item.type === 'container' && item.id) {
        // Destroy strictly by exact 64-char container ID to avoid deleting any other containers
        spawnSync('docker', ['rm', '--force', '--volumes', item.id]);
        console.log(
          `  [Rollback] Destroyed container by ID: ${item.id} (${item.name})`,
        );
      } else if (item.type === 'dir' && item.path && fs.existsSync(item.path)) {
        fs.rmSync(item.path, { recursive: true, force: true });
        console.log(`  [Rollback] Cleaned temporary directory: ${item.path}`);
      }
    } catch (cleanupErr) {
      console.warn(
        `  [Rollback Warning] Failed to clean up ${item.type}:`,
        cleanupErr.message,
      );
    }
  }
}

/**
 * 1. Prepare an isolated, repeatable fixture environment for T10-C.
 *
 * Capabilities:
 * - Creates a unique PostgreSQL container on a random port (tracking exact 64-character container ID).
 * - Runs storage migrations.
 * - Stores all credentials strictly in a mode 0600 file (never printed to stdout/stderr or report).
 * - Bootstraps unique User, Project, Environment, and internal ModelProfile.
 * - Injects a fake model transport that only accepts requests to the local fixture endpoint.
 * - Performs capability probe via API and verifies degraded/structuredOutput capability and recorded call.
 * - Starts a minimal controlled HTML test app on a separate random port (serving real HTML with testids).
 * - Uses the test app URL as environment.baseUrl and run.targetUrl (never treating API 404 as app ready).
 * - Sets the project's default model to the internal profile (does NOT mutate any existing projects).
 * - Creates a controlled source Run and RunCase (explicitly noted as synthetic, not executed by real smoke worker).
 * - Starts a dedicated API server on a random port.
 * - Robust rollback cleanup on any mid-flight prepare failure, supporting fault injection testing.
 * - Returns structured resource IDs and cleanup ledger.
 */
export async function prepareFixture(options = {}) {
  const tag = options.tag || randomUUID().slice(0, 8);
  const taskSlug = options.taskSlug || `t10c-fixture-${tag}`;
  const pgContainer = `localqa-t10c-pg-${tag}`;
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'localqa-t10c-fixture-'));

  const cleanupStack = [];
  cleanupStack.push({ type: 'dir', path: dir });

  const faultInjection = options.faultInjection || null;
  const checkFault = (step) => {
    if (faultInjection && faultInjection.failAt === step) {
      throw new Error(
        `[FaultInjection] Simulated failure triggered at step: "${step}"`,
      );
    }
  };

  try {
    console.log(
      `[T10-C Fixture Setup] Initializing isolated environment for tag "${tag}"...`,
    );
    checkFault('after_dir');

    // 1. Prepare protected files with mode 0600
    const envFile = path.join(dir, 'pg.env');
    const kekFile = path.join(dir, 'kek.json');
    const pgPassword = randomBytes(24).toString('hex');

    fs.writeFileSync(
      envFile,
      `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${pgPassword}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(envFile, 0o600);

    fs.writeFileSync(
      kekFile,
      JSON.stringify({
        activeVersion: 1,
        keys: { 1: randomBytes(32).toString('base64') },
      }),
      { mode: 0o600 },
    );
    fs.chmodSync(kekFile, 0o600);

    // 2. Allocate free port and spawn isolated PostgreSQL container
    const pgPort = await getFreePort();
    console.log(
      `  [PostgreSQL] Spawning container "${pgContainer}" on 127.0.0.1:${pgPort}...`,
    );
    const dockerRunRes = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        pgContainer,
        '-p',
        `127.0.0.1:${pgPort}:5432`,
        '--env-file',
        envFile,
        'postgres:18-alpine',
      ],
      { encoding: 'utf8' },
    );

    if (dockerRunRes.status !== 0) {
      throw new Error(
        `Failed to spawn Docker container ${pgContainer}: ${dockerRunRes.stderr}`,
      );
    }

    const containerId = (dockerRunRes.stdout || '').trim();
    cleanupStack.push({
      type: 'container',
      id: containerId,
      name: pgContainer,
    });
    console.log(
      `  [PostgreSQL] Container spawned with exact ID: ${containerId.slice(0, 12)}`,
    );

    checkFault('after_container');

    const pgConnection = `postgresql://localqa:${pgPassword}@127.0.0.1:${pgPort}/localqa`;

    // 3. Wait for PostgreSQL readiness and execute database migrations
    console.log(
      '  [PostgreSQL] Awaiting readiness and running database migrations...',
    );
    const migrationsUrl = new URL(
      '../../../packages/storage/migrations/',
      import.meta.url,
    );
    let migrated = false;
    for (let i = 0; i < 60; i++) {
      try {
        await migrate(pgConnection, migrationsUrl);
        migrated = true;
        break;
      } catch {
        await delay(250);
      }
    }

    if (!migrated) {
      throw new Error(
        `Database migrations timed out for container ${pgContainer}`,
      );
    }

    checkFault('after_db_migrate');

    // 4. Initialize storage repositories and secret vault
    const vault = await SecretVault.fromProtectedFile(kekFile);
    const db = new Database(pgConnection);
    cleanupStack.push({ type: 'db', db });

    const adminPassword = randomBytes(24).toString('hex');
    const adminEmail = `admin-${tag}@t10c.localqa`;
    const accountsRepo = new AccountsRepository(db);
    const adminUser = await accountsRepo.bootstrap({
      email: adminEmail,
      displayName: `Admin T10-C (${tag})`,
      password: adminPassword,
    });

    checkFault('after_bootstrap');

    const projectRepo = new ProjectRepository(db);
    const project = await projectRepo.create(
      { userId: adminUser.id },
      { name: `T10-C Project (${tag})` },
    );

    // 5. Start independent minimal controlled HTML test application on its own random port
    const appPort = await getFreePort();
    const testAppServer = http.createServer((req, res) => {
      const parsed = new URL(req.url, `http://127.0.0.1:${appPort}`);
      if (parsed.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            app: 'controlled-fixture-app',
            port: appPort,
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>LocalQA Controlled Fixture Test App</title>
</head>
<body>
  <div id="app" data-testid="controlled-fixture-app">
    <h1 data-testid="app-title">LocalQA 核心电商受控测试应用 (Controlled Fixture App)</h1>
    <p data-testid="app-status">ready</p>
    <button id="btn-checkout" data-testid="btn-checkout">结算</button>
  </div>
</body>
</html>`);
    });

    await new Promise((resolve) =>
      testAppServer.listen(appPort, '127.0.0.1', resolve),
    );
    cleanupStack.push({
      type: 'server',
      server: testAppServer,
      port: appPort,
      name: 'testApp',
    });

    const testAppUrl = `http://127.0.0.1:${appPort}/`;
    console.log(
      `  [Test App] Controlled HTML test application live at ${testAppUrl}`,
    );

    checkFault('after_test_app');

    // Create environment pointing to the controlled test app (not API root!)
    const configRepo = new ConfigurationRepository(db, vault);
    const environment = await configRepo.createEnvironment(
      { userId: adminUser.id },
      project.id,
      {
        name: `staging-${tag}`,
        baseUrl: testAppUrl,
        allowedOrigins: [`http://127.0.0.1:${appPort}`],
        tlsPolicy: 'strict',
      },
    );

    // 6. Define local model endpoint and fake transport with controlled credentials
    const modelEndpoint = 'https://fixture.model.localqa.test/v1';
    const fakeModelApiKey = `sec_fixture_key_${randomBytes(16).toString('hex')}`;
    const recordedModelCalls = [];

    const fakeModelTransport = async (url, fetchOptions = {}) => {
      const urlStr = String(url);
      if (!urlStr.startsWith(modelEndpoint)) {
        throw new Error(
          `[Security] fakeModelTransport rejected unauthorized endpoint: ${urlStr}`,
        );
      }

      const auth =
        fetchOptions.headers?.authorization ||
        fetchOptions.headers?.Authorization;
      if (auth !== `Bearer ${fakeModelApiKey}`) {
        return new Response(
          JSON.stringify({
            error: { message: 'Invalid API key', code: 'invalid_api_key' },
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      let parsedBody;
      try {
        parsedBody = JSON.parse(fetchOptions.body || '{}');
      } catch {
        parsedBody = {};
      }

      recordedModelCalls.push({
        url: urlStr,
        method: fetchOptions.method || 'POST',
        model: parsedBody.model || null,
        timestamp: new Date().toISOString(),
      });

      // OpenAI-compatible chat completion response simulating structured output probe
      const payload = {
        id: `chatcmpl-${randomUUID().slice(0, 8)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: parsedBody.model || 'stub-local-qwen-2.5',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                structuredOutput: true,
                nativeTools: false,
                imageInput: false,
              }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 18,
          completion_tokens: 12,
          total_tokens: 30,
        },
      };

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    // Create model profile in DB with encrypted apiKey in vault
    const modelRepo = new ModelRepository(db, vault);
    const model = await modelRepo.create(
      { userId: adminUser.id },
      {
        name: `T10-C Local Stub Model (${tag})`,
        endpoint: modelEndpoint,
        configuredModelId: 'stub-local-qwen-2.5',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
        apiKey: fakeModelApiKey,
      },
    );

    // 7. Start dedicated API Server on random port with injected model transport
    const apiPort = await getFreePort();
    const artifactsDir = path.join(dir, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    const apiContext = createApiContext({
      connectionString: pgConnection,
      vault,
      artifactsDir,
      serviceActor: { userId: adminUser.id },
      publicOrigin: `http://127.0.0.1:${apiPort}`,
      allowTestStub: true,
      modelTransport: fakeModelTransport,
    });
    cleanupStack.push({ type: 'apiContext', apiContext });

    const apiServer = createApiServer(apiContext);
    await new Promise((resolve) =>
      apiServer.listen(apiPort, '127.0.0.1', resolve),
    );
    cleanupStack.push({
      type: 'server',
      server: apiServer,
      port: apiPort,
      name: 'api',
    });

    const baseUrl = `http://127.0.0.1:${apiPort}`;

    checkFault('after_api_server');

    // 8. Session login to obtain authenticated cookie
    const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    if (loginRes.status !== 200) {
      throw new Error(
        `Bootstrap admin login failed: status ${loginRes.status}`,
      );
    }
    const setCookie = loginRes.headers.get('set-cookie');
    const sessionCookie = setCookie ? setCookie.split(';')[0] : '';

    // 9. Probe model profile through API using fake transport and verify degraded/structured capability
    console.log(`  [Model Profile] Probing profile "${model.id}" via API...`);
    const probeRes = await fetch(
      `${baseUrl}/api/v1/model-profiles/${model.id}/probe`,
      {
        method: 'POST',
        headers: { Cookie: sessionCookie },
      },
    );
    if (probeRes.status !== 200) {
      const errText = await probeRes.text();
      throw new Error(
        `Model probe failed with status ${probeRes.status}: ${errText}`,
      );
    }
    const probeData = await probeRes.json();
    if (
      probeData.status !== 'degraded' ||
      probeData.capabilities?.structuredOutput !== true ||
      recordedModelCalls.length === 0
    ) {
      throw new Error(
        `Model probe validation failed: expected degraded with structuredOutput=true, got ${JSON.stringify(probeData)}`,
      );
    }
    console.log(
      `  ✓ Model profile probed: status="${probeData.status}", structuredOutput=${probeData.capabilities?.structuredOutput}`,
    );

    // Read updated model profile to capture the new post-probe version (created by recordProbe)
    const probedModelRes = await fetch(
      `${baseUrl}/api/v1/model-profiles/${model.id}`,
      {
        headers: { Cookie: sessionCookie },
      },
    );
    const probedModel = await probedModelRes.json();
    const probedModelVersion = probedModel.version;
    if (typeof probedModelVersion !== 'number' || probedModelVersion < 2) {
      throw new Error(
        `Expected post-probe model version >= 2, got ${probedModelVersion}`,
      );
    }
    console.log(
      `  ✓ Probed model profile version verified: ${probedModelVersion}`,
    );

    // Freeze model as default ONLY for this isolated project
    await projectRepo.update({ userId: adminUser.id }, project.id, {
      expectedVersion: project.version,
      defaultModelProfileId: model.id,
    });

    checkFault('before_run_creation');

    // 10. Create source Run and synthetic RunCase fixture (marked as unexecuted)
    const runRes = await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionCookie,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        projectId: project.id,
        environmentId: environment.id,
        targetUrl: testAppUrl,
      }),
    });
    if (runRes.status !== 202) {
      throw new Error(`Creating source run failed: status ${runRes.status}`);
    }
    const runData = await runRes.json();
    const runId = runData.id;

    // Verify run effectiveConfig.models bound all 5 roles to our probed profile AND probed version
    const runModels = runData.effectiveConfig?.models || {};
    const roles = [
      'coordinator',
      'explorer',
      'executor',
      'assertion',
      'reproducer',
    ];
    for (const role of roles) {
      const binding = runModels[role];
      if (
        binding?.profileId !== model.id ||
        binding?.version !== probedModelVersion
      ) {
        throw new Error(
          `Run model binding mismatch for role ${role}: expected { profileId: "${model.id}", version: ${probedModelVersion} }, got { profileId: "${binding?.profileId}", version: ${binding?.version} }`,
        );
      }
    }
    console.log(
      `  ✓ Run created with all 5 roles bound to frozen model profile "${model.id}" (version: ${probedModelVersion})`,
    );

    const sourceCase = smokeCase(runData, testAppUrl, 0);
    await db.actor({ userId: adminUser.id }, (client) =>
      client.query(
        'INSERT INTO run_cases(id, project_id, run_id, document, criteria_hash) VALUES($1, $2, $3, $4, $5)',
        [
          sourceCase.id,
          project.id,
          runId,
          sourceCase,
          criteriaHash(sourceCase),
        ],
      ),
    );

    // 11. Write credentials ONLY to mode 0600 file (passwords NEVER printed)
    const credentialsPath = path.join(dir, '.credentials.json');
    const credentialsData = {
      adminUser: {
        id: adminUser.id,
        email: adminEmail,
        password: adminPassword,
      },
      modelApiKey: fakeModelApiKey,
      sessionCookie,
      apiBaseUrl: `${baseUrl}/api/v1`,
      testAppUrl,
      pgConnection,
      tag,
    };
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify(credentialsData, null, 2),
      {
        mode: 0o600,
      },
    );
    fs.chmodSync(credentialsPath, 0o600);

    // 12. Assemble cleanup ledger
    const ledger = {
      tag,
      taskSlug,
      containerId,
      pgContainer,
      pgPort,
      apiPort,
      appPort,
      dir,
      credentialsPath,
      createdIds: {
        userId: adminUser.id,
        projectId: project.id,
        environmentId: environment.id,
        modelProfileId: model.id,
        modelProfileVersion: probedModelVersion,
        runId,
        sourceRunCaseId: sourceCase.id,
      },
      ownership: 'T10-C',
      status: 'active',
    };

    console.log(
      `  ✓ Isolated fixture ready: API port ${apiPort}, Test App port ${appPort}, PG container "${pgContainer}"`,
    );
    console.log(`  ✓ Credentials stored in mode 0600 file: ${credentialsPath}`);

    return {
      tag,
      baseUrl,
      apiBaseUrl: `${baseUrl}/api/v1`,
      testAppUrl,
      apiPort,
      appPort,
      pgPort,
      credentialsFile: credentialsPath,
      credentialsFileMode: '0600',
      adminEmail,
      createdIds: {
        userId: adminUser.id,
        projectId: project.id,
        environmentId: environment.id,
        modelProfileId: model.id,
        modelProfileVersion: probedModelVersion,
        runId,
        sourceRunCaseId: sourceCase.id,
      },
      sourceRunCaseNotice:
        '未经真实冒烟执行 (Controlled fixture / synthetic source RunCase, not executed by real worker)',
      modelProbeEvidence: {
        status: probeData.status,
        capabilities: probeData.capabilities,
        probedVersion: probedModelVersion,
        recordedCallsCount: recordedModelCalls.length,
      },
      ledger,
      _handles: {
        apiServer,
        testAppServer,
        apiContext,
        db,
        containerId,
        pgContainer,
        dir,
      },
    };
  } catch (err) {
    console.error(
      `[T10-C Fixture Setup] Failed during preparation: ${err.message}. Performing automatic rollback...`,
    );
    await rollbackResources(cleanupStack);
    throw err;
  }
}

/**
 * 2. Perform read-only health and seed verification on the isolated fixture.
 */
export async function verifyFixtureHealth(fixture) {
  const { baseUrl, testAppUrl, credentialsFile, createdIds } = fixture;

  console.log(
    `[T10-C Fixture Verification] Verifying health and seed integrity for tag "${fixture.tag}"...`,
  );

  // Read credentials from mode 0600 file
  const creds = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  const cookie = creds.sessionCookie;

  // 1. Canonical API health check
  const healthRes = await fetch(`${baseUrl}/api/v1/health/live`);
  const healthData = await healthRes.json().catch(() => null);
  const healthOk = healthRes.status === 200 && healthData?.status === 'ok';

  // 2. Controlled HTML Test App check (ensuring environment.baseUrl serves HTML 200, not API 404)
  const appRes = await fetch(testAppUrl);
  const appHtml = await appRes.text().catch(() => '');
  const appOk =
    appRes.status === 200 &&
    appHtml.includes('data-testid="controlled-fixture-app"') &&
    appHtml.includes('<title>LocalQA Controlled Fixture Test App</title>');

  // 3. Auth me check
  const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
    headers: { Cookie: cookie },
  });
  const meData = await meRes.json().catch(() => null);
  const meOk = meRes.status === 200 && meData?.id === createdIds.userId;

  // 4. Project check with frozen model profile
  const projRes = await fetch(
    `${baseUrl}/api/v1/projects/${createdIds.projectId}`,
    {
      headers: { Cookie: cookie },
    },
  );
  const projData = await projRes.json().catch(() => null);
  const projOk =
    projRes.status === 200 &&
    projData?.id === createdIds.projectId &&
    projData?.defaultModelProfileId === createdIds.modelProfileId;

  // 5. Environment check pointing to test app
  const envRes = await fetch(
    `${baseUrl}/api/v1/projects/${createdIds.projectId}/environments`,
    { headers: { Cookie: cookie } },
  );
  const envData = await envRes.json().catch(() => null);
  const envOk =
    envRes.status === 200 &&
    Array.isArray(envData?.items) &&
    envData.items.some(
      (e) => e.id === createdIds.environmentId && e.baseUrl === testAppUrl,
    );

  // 6. Model profile check (status degraded, structuredOutput true, internal dataBoundary)
  const modelRes = await fetch(
    `${baseUrl}/api/v1/model-profiles/${createdIds.modelProfileId}`,
    { headers: { Cookie: cookie } },
  );
  const modelData = await modelRes.json().catch(() => null);
  const modelOk =
    modelRes.status === 200 &&
    modelData?.id === createdIds.modelProfileId &&
    modelData?.status === 'degraded' &&
    modelData?.capabilities?.structuredOutput === true &&
    modelData?.dataBoundary === 'internal';

  // 7. Run check and 5 role frozen model bindings (checking BOTH profileId and frozen version, strictly not using latest head)
  const runRes = await fetch(`${baseUrl}/api/v1/runs/${createdIds.runId}`, {
    headers: { Cookie: cookie },
  });
  const runData = await runRes.json().catch(() => null);
  const models = runData?.effectiveConfig?.models || {};
  const expectedProfileId = createdIds.modelProfileId;
  const expectedVersion = createdIds.modelProfileVersion;
  const roles = [
    'coordinator',
    'explorer',
    'executor',
    'assertion',
    'reproducer',
  ];
  const runModelsBound = roles.every((role) => {
    const b = models[role];
    return b?.profileId === expectedProfileId && b?.version === expectedVersion;
  });
  const runOk =
    runRes.status === 200 && runData?.id === createdIds.runId && runModelsBound;

  // 8. Case check
  const caseRes = await fetch(
    `${baseUrl}/api/v1/cases/${createdIds.sourceRunCaseId}`,
    {
      headers: { Cookie: cookie },
    },
  );
  const caseData = await caseRes.json().catch(() => null);
  const caseOk =
    caseRes.status === 200 &&
    (caseData?.id === createdIds.sourceRunCaseId ||
      caseData?.definition?.id === createdIds.sourceRunCaseId);

  const allHealthy =
    healthOk && appOk && meOk && projOk && envOk && modelOk && runOk && caseOk;

  return {
    healthy: allHealthy,
    checks: {
      healthLive: healthOk,
      testAppLive: appOk,
      authMe: meOk,
      project: projOk,
      environment: envOk,
      modelProfile: modelOk,
      runModelBindings: runOk,
      sourceRunCase: caseOk,
    },
    createdIds,
    sourceRunCaseNotice: fixture.sourceRunCaseNotice,
  };
}

/**
 * 2b. Perform regression run creation and verify canonical API provenance fields and queued/not_run state.
 * Creates a controlled saved case targeting testAppUrl, approves it through the review protocol,
 * launches a regression run, and reads back run and case provenance and state.
 */
export async function verifyRegressionRunApiProvenance(fixture) {
  const { baseUrl, testAppUrl, credentialsFile, createdIds } = fixture;

  console.log(
    `[T10-C2 Regression Provenance] Verifying API provenance and queued state for project "${createdIds.projectId}"...`,
  );

  // Read credentials from mode 0600 file
  const creds = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  const cookie = creds.sessionCookie;

  // 1. Create a controlled saved case targeting testAppUrl
  const slug = `t10c2-reg-${randomUUID().slice(0, 8)}`;
  const docPayload = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: slug,
    name: 'Controlled Regression Test Case',
    variables: {},
    criteria: [
      {
        id: 'crit_page_load',
        kind: 'url_matches',
        description: 'Test app loads with fixture testid',
        sourceKind: 'saved_case',
        sourceRef: 'test-case-spec',
        expectedValue: testAppUrl,
      },
    ],
    steps: [
      { kind: 'navigate', url: testAppUrl },
      { kind: 'assert', criterionId: 'crit_page_load' },
    ],
  };

  const createCaseRes = await fetch(
    `${baseUrl}/api/v1/projects/${createdIds.projectId}/saved-cases`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        slug,
        name: 'Controlled Regression Test Case',
        document: docPayload,
      }),
    },
  );
  if (createCaseRes.status !== 201 && createCaseRes.status !== 200) {
    const errText = await createCaseRes.text();
    throw new Error(
      `Failed to create saved case: ${createCaseRes.status} ${errText}`,
    );
  }
  const savedCase = await createCaseRes.json();

  // 2. Fetch versions of the saved case
  const versionsRes = await fetch(
    `${baseUrl}/api/v1/saved-cases/${savedCase.id}/versions`,
    {
      headers: { Cookie: cookie },
    },
  );
  if (versionsRes.status !== 200) {
    const errText = await versionsRes.text();
    throw new Error(
      `Failed to fetch saved case versions: ${versionsRes.status} ${errText}`,
    );
  }
  const versionsPage = await versionsRes.json();
  const v1 = versionsPage.items?.[0];
  if (!v1 || !v1.id) {
    throw new Error('No draft version found for created saved case');
  }

  // 3. Request review preview
  const previewRes = await fetch(
    `${baseUrl}/api/v1/saved-case-versions/${v1.id}/review-preview`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        expectedVersion: v1.version,
        decision: 'approve',
        reason: 'Automated provenance audit verification',
      }),
    },
  );
  if (previewRes.status !== 200) {
    const errText = await previewRes.text();
    throw new Error(
      `Failed to get review preview: ${previewRes.status} ${errText}`,
    );
  }
  const preview = await previewRes.json();

  // 4. Commit review approval
  const commitRes = await fetch(
    `${baseUrl}/api/v1/saved-case-versions/${v1.id}/review`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        confirmationToken: preview.confirmationToken,
        expectedVersion: preview.expectedVersion,
        decision: preview.decision,
        reason: preview.reason,
      }),
    },
  );
  if (commitRes.status !== 200) {
    const errText = await commitRes.text();
    throw new Error(`Failed to commit review: ${commitRes.status} ${errText}`);
  }
  const approvedVersion = await commitRes.json();

  // 5. Launch regression run with approved version
  const idempotencyKey = randomUUID();
  const regRunRes = await fetch(`${baseUrl}/api/v1/regression-runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      Cookie: cookie,
    },
    body: JSON.stringify({
      projectId: createdIds.projectId,
      environmentId: createdIds.environmentId,
      caseVersionIds: [v1.id],
    }),
  });
  if (regRunRes.status !== 202) {
    const errText = await regRunRes.text();
    throw new Error(
      `Failed to launch regression run: ${regRunRes.status} ${errText}`,
    );
  }
  const regressionRun = await regRunRes.json();

  // 6. Fetch run detail
  const runDetailRes = await fetch(
    `${baseUrl}/api/v1/runs/${regressionRun.id}`,
    {
      headers: { Cookie: cookie },
    },
  );
  const regressionRunDetail = await runDetailRes.json();

  // 7. Fetch run cases
  const runCasesRes = await fetch(
    `${baseUrl}/api/v1/runs/${regressionRun.id}/cases`,
    {
      headers: { Cookie: cookie },
    },
  );
  const runCasesPage = await runCasesRes.json();
  const cases = runCasesPage.items || [];

  // 8. Fetch first case detail
  let firstCaseDetail = null;
  if (cases.length > 0) {
    const caseId = cases[0].definition?.id || cases[0].id;
    const caseDetailRes = await fetch(`${baseUrl}/api/v1/cases/${caseId}`, {
      headers: { Cookie: cookie },
    });
    firstCaseDetail = await caseDetailRes.json();
  }

  return {
    savedCase,
    approvedVersion,
    regressionRun: regressionRunDetail,
    cases,
    firstCaseDetail,
  };
}

/**
 * 3. Destroy all isolated resources according to the cleanup ledger.
 * Strictly avoids touching any external ports (such as 8085), external model profiles, or other spaces.
 */
export async function cleanupFixture(fixture) {
  const handles = fixture?._handles || {};
  const ledger = fixture?.ledger || {};
  const { apiServer, testAppServer, apiContext, db, containerId, dir } =
    handles;

  console.log(
    `[T10-C Fixture Teardown] Cleaning up isolated resources for tag "${ledger.tag}"...`,
  );

  // 1. Close servers
  if (apiServer) {
    await new Promise((resolve) => apiServer.close(resolve));
    console.log(`  ✓ API server on port ${ledger.apiPort} closed`);
  }
  if (testAppServer) {
    await new Promise((resolve) => testAppServer.close(resolve));
    console.log(`  ✓ Test application server on port ${ledger.appPort} closed`);
  }

  // 2. Close DB connections
  if (apiContext?.db) {
    await apiContext.db.close().catch(() => {});
  }
  if (db) {
    await db.close().catch(() => {});
  }

  // 3. Remove isolated PG Docker container by exact container ID
  const targetContainerId =
    containerId || ledger.containerId || ledger.pgContainer;
  if (targetContainerId) {
    spawnSync('docker', ['rm', '--force', '--volumes', targetContainerId]);
    console.log(
      `  ✓ Isolated PG container destroyed by ID: "${targetContainerId}"`,
    );
  }

  // 4. Remove isolated temporary directory
  const targetDir = dir || ledger.dir;
  if (targetDir && fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    console.log(`  ✓ Isolated temporary directory "${targetDir}" deleted`);
  }

  if (ledger) {
    ledger.status = 'cleaned';
  }

  console.log(
    `[T10-C Fixture Teardown] Complete. All isolated resources destroyed.`,
  );
  return { cleaned: true, tag: ledger.tag };
}
