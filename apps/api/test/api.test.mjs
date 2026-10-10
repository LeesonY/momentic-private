import assert from 'node:assert/strict';
import { test as nodeTest, before, after } from 'node:test';
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { parseContract } from '@localqa/contracts';
import {
  Database,
  AccountsRepository,
  SecretVault,
  migrate,
} from '@localqa/storage';
import { smokeCase, criteriaHash } from '@localqa/domain';
import { createApiContext, createApiServer } from '../dist/index.js';
import { parsePagination } from '../dist/router.js';
import { toApiErrorResponse } from '../dist/errors.js';
import { StorageError } from '@localqa/storage';
import { DomainError } from '@localqa/domain';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const testEvidenceDir = mkdtempSync(join(tmpdir(), 'localqa-t06-'));
// Keep old evidence untouched and copy the baseline before any test starts.
const baselineDir = `${testEvidenceDir}/baseline`;
mkdirSync(baselineDir, { mode: 0o700 });
const baselinePath = `${root}docs/validation-results/T06-api.json`;
const baselineSha256 = existsSync(baselinePath)
  ? createHash('sha256').update(readFileSync(baselinePath)).digest('hex')
  : null;
if (baselineSha256) cpSync(baselinePath, `${baselineDir}/T06-api.json`);
const oldArtifacts = `${root}apps/api/.evidence/artifacts`;
if (existsSync(oldArtifacts))
  cpSync(oldArtifacts, `${baselineDir}/artifacts`, { recursive: true });
console.log(`[Test Evidence] ${testEvidenceDir}`);

const tag = randomUUID().slice(0, 8);
const pgContainer = `localqa-t06-pg-${tag}`;
const envFile = `${testEvidenceDir}/pg.env`;
const kekFile = `${testEvidenceDir}/kek.json`;
const pgPassword = randomBytes(24).toString('hex');

writeFileSync(
  envFile,
  `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${pgPassword}\n`,
  { mode: 0o600 },
);

const rawKekKey = randomBytes(32).toString('base64');
writeFileSync(
  kekFile,
  JSON.stringify({
    activeVersion: 1,
    keys: { 1: rawKekKey },
  }),
  { mode: 0o600 },
);

let pgConnection;
let db,
  vault,
  apiContext,
  apiServer,
  apiPort,
  baseUrl,
  fixtureProcess,
  fixtureOrigin;
let pgContainerId;
const ownership = {
  evidenceDir: testEvidenceDir,
  containerId: null,
  volumes: [],
  fixturePid: null,
  apiPid: process.pid,
  cleanup: {},
};
function saveOwnership() {
  writeFileSync(
    `${testEvidenceDir}/ownership.json`,
    JSON.stringify(ownership, null, 2) + '\n',
    { mode: 0o600 },
  );
}
saveOwnership();
const seedKey = `localqa-t06-seed-${tag}`;
const modelProbeCalls = [];
let adminCookie, operatorCookie, viewerCookie;
let adminUser, operatorUser, viewerUser;
let projectAlpha,
  projectBeta,
  testModelProfile,
  environmentAlpha,
  authProfileAlpha,
  knowledgeAlpha;
let testRun;

const facts = {
  task: 'T06',
  timestamp: new Date().toISOString(),
  node: process.version,
  postgres: null,
  apiBaseUrl: null,
  baselineSha256,
  evidenceDir: testEvidenceDir,
  execution:
    'isolated PostgreSQL/API; local HTTP fixture; injected model transport; no browser or worker process',
  tests: [],
  summary: {
    passed: 0,
    failed: 0,
  },
};

function test(name, fn) {
  return nodeTest(name, async () => {
    try {
      await fn();
    } catch (error) {
      recordTest(name, false, { code: error?.code ?? 'TEST_FAILED' });
      throw error;
    }
  });
}

function recordTest(name, passed, details = {}) {
  facts.tests.push({ name, passed, details });
  if (passed) facts.summary.passed++;
  else facts.summary.failed++;
}

async function apiRequest(method, endpoint, options = {}) {
  const url = `${baseUrl}${endpoint}`;
  const headers = { ...(options.headers || {}) };
  if (options.cookie) {
    headers['Cookie'] = options.cookie;
  }
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const reqOptions = {
    method: method.toUpperCase(),
    headers,
  };

  if (options.body) {
    reqOptions.body =
      typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
  }

  const res = await fetch(url, reqOptions);
  const status = res.status;
  const setCookie = res.headers.get('set-cookie');
  const contentType = res.headers.get('content-type') || '';
  let json = null;
  let text = '';

  if (contentType.includes('application/json')) {
    json = await res.json().catch(() => null);
  } else {
    text = await res.text().catch(() => '');
  }

  return { status, headers: res.headers, json, text, setCookie };
}

before(async () => {
  try {
    // 1. Start Postgres container
    console.log(
      `[Test Setup] Launching PostgreSQL container: ${pgContainer}...`,
    );
    const runRes = spawnSync('docker', [
      'run',
      '--detach',
      '--name',
      pgContainer,
      '--publish',
      '127.0.0.1::5432',
      '--env-file',
      envFile,
      'postgres:18-alpine',
    ]);
    assert.equal(runRes.status, 0, `Docker run failed: ${runRes.stderr}`);
    pgContainerId = runRes.stdout.toString().trim();
    assert.match(pgContainerId, /^[a-f0-9]{64}$/);
    ownership.containerId = pgContainerId;
    saveOwnership();
    const inspected = spawnSync('docker', ['inspect', pgContainerId], {
      encoding: 'utf8',
    });
    assert.equal(inspected.status, 0);
    ownership.volumes = JSON.parse(inspected.stdout)[0]
      .Mounts.filter((mount) => mount.Type === 'volume')
      .map((mount) => mount.Name);
    saveOwnership();

    const portRes = spawnSync('docker', ['port', pgContainerId, '5432/tcp'], {
      encoding: 'utf8',
    });
    const mappedPort = portRes.stdout.trim().split(':').at(-1);
    pgConnection = `postgresql://localqa:${pgPassword}@127.0.0.1:${mappedPort}/localqa`;

    // Wait for pg to be fully ready over TCP
    let ready = false;
    for (let i = 0; i < 60; i++) {
      const probe = spawnSync('docker', [
        'exec',
        pgContainerId,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'localqa',
        '-d',
        'localqa',
      ]);
      if (probe.status === 0) {
        try {
          const probeClient = new pg.Client({ connectionString: pgConnection });
          await probeClient.connect();
          await probeClient.query('SELECT 1');
          await probeClient.end();
          ready = true;
          break;
        } catch {
          // TCP not ready yet
        }
      }
      await delay(250);
    }
    assert.ok(ready, 'PostgreSQL container readiness timeout');

    // 2. Run migrations
    console.log('[Test Setup] Running database migrations...');
    const migrationsApplied = await migrate(
      pgConnection,
      new URL('../../../packages/storage/migrations/', import.meta.url),
    );
    console.log(
      `[Test Setup] Applied migrations: ${migrationsApplied.join(', ')}`,
    );

    // 3. Load SecretVault
    // Windows cannot enforce POSIX owner-only bits on a temporary file.
    // Only this isolated test fixture uses the same freshly generated KEK
    // directly in memory; production SecretVault.fromProtectedFile is unchanged.
    vault =
      process.platform === 'win32'
        ? new SecretVault(1, new Map([[1, Buffer.from(rawKekKey, 'base64')]]))
        : await SecretVault.fromProtectedFile(kekFile);
    db = new Database(pgConnection);

    // Record Postgres version
    const pgClient = new pg.Client({ connectionString: pgConnection });
    await pgClient.connect();
    const vRes = await pgClient.query('SELECT version()');
    facts.postgres = vRes.rows[0].version;
    await pgClient.end();

    // 4. Bootstrap admin user
    const accountsRepo = new AccountsRepository(db);
    adminUser = await accountsRepo.bootstrap({
      email: 'admin@t06.localqa',
      displayName: 'LocalQA Admin',
      password: 'AdminSuperPassword123!',
    });

    // 5. Start Test Fixture Server
    fixtureProcess = spawn(
      process.execPath,
      [fileURLToPath(new URL('./t06-fixture-wrapper.mjs', import.meta.url))],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    ownership.fixturePid = fixtureProcess.pid;
    saveOwnership();
    const [fixture] = await once(fixtureProcess, 'message', {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(fixture.pid, fixtureProcess.pid);
    assert.ok(Number.isInteger(fixture.port) && fixture.port > 0);
    fixtureOrigin = `http://127.0.0.1:${fixture.port}`;
    ownership.fixtureOrigin = fixtureOrigin;
    saveOwnership();
    const fixtureResponse = await fetch(`${fixtureOrigin}/`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(fixtureResponse.status, 200);
    await fixtureResponse.arrayBuffer();

    // 6. Create API Context and start HTTP Server
    const artifactsDir = `${testEvidenceDir}/artifacts`;
    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });

    const modelTransport = async (url) => {
      const target = String(url);
      modelProbeCalls.push(target);
      let host;
      try {
        host = new URL(target).host;
      } catch {
        host = '';
      }
      if (host !== 'example.com') {
        throw new Error('local model transport refused unexpected host');
      }
      return new Response(
        JSON.stringify({
          model: 'test-stub',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  structuredOutput: false,
                  nativeTools: true,
                  imageInput: true,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    apiContext = createApiContext({
      connectionString: pgConnection,
      vault,
      artifactsDir,
      serviceActor: { userId: adminUser.id },
      publicOrigin: 'http://localhost',
      modelTransport,
    });

    apiServer = createApiServer(apiContext);
    await new Promise((resolve) => {
      apiServer.listen(0, '127.0.0.1', () => {
        const addr = apiServer.address();
        apiPort = addr.port;
        baseUrl = `http://127.0.0.1:${apiPort}`;
        facts.apiBaseUrl = baseUrl;
        ownership.apiBaseUrl = baseUrl;
        ownership.pgPort = Number(mappedPort);
        saveOwnership();
        console.log(`[Test Setup] API server listening at ${baseUrl}`);
        resolve();
      });
    });
  } catch (err) {
    recordTest('setup', false, { code: err?.code ?? 'SETUP_FAILED' });
    console.error('BEFORE HOOK ERROR:', err);
    throw err;
  }
});

after(async () => {
  console.log('[Test Teardown] Cleaning up services and containers...');
  if (apiServer) {
    await new Promise((resolve) => {
      apiServer.close(resolve);
      apiServer.closeAllConnections();
    });
    ownership.cleanup.apiClosed = !apiServer.listening;
  }
  if (
    fixtureProcess &&
    fixtureProcess.exitCode === null &&
    fixtureProcess.signalCode === null
  ) {
    const exited = once(fixtureProcess, 'exit');
    fixtureProcess.kill('SIGTERM');
    const force = setTimeout(() => fixtureProcess.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(force);
  }
  ownership.cleanup.fixtureExited =
    !fixtureProcess ||
    fixtureProcess.exitCode !== null ||
    fixtureProcess.signalCode !== null;
  if (apiContext?.db) {
    await apiContext.db.close().catch(() => {});
  }
  if (db) {
    await db.close().catch(() => {});
  }

  // Only the exact container created in this invocation may be destroyed.
  if (pgContainerId) {
    const removed = spawnSync(
      'docker',
      ['rm', '--force', '--volumes', pgContainerId],
      { encoding: 'utf8' },
    );
    ownership.cleanup.removeStatus = removed.status;
    const inspect = spawnSync(
      'docker',
      ['container', 'inspect', pgContainerId],
      { encoding: 'utf8' },
    );
    ownership.cleanup.containerAbsent =
      inspect.status !== 0 && /no such container/i.test(inspect.stderr);
    ownership.cleanup.volumesAbsent = ownership.volumes.map((id) => {
      const check = spawnSync('docker', ['volume', 'inspect', id], {
        encoding: 'utf8',
      });
      return {
        id,
        absent: check.status !== 0 && /no such volume/i.test(check.stderr),
      };
    });
  }

  // Clean files
  rmSync(envFile, { force: true });
  rmSync(kekFile, { force: true });

  // Write facts evidence
  ownership.cleanup.credentialsRemoved =
    !existsSync(envFile) && !existsSync(kekFile);
  ownership.cleanup.baselineUnchanged =
    baselineSha256 ===
    (existsSync(baselinePath)
      ? createHash('sha256').update(readFileSync(baselinePath)).digest('hex')
      : null);
  saveOwnership();
  facts.ownership = ownership;
  const resultsPath = `${root}docs/validation-results/T06-api-revalidation-${tag}.json`;
  writeFileSync(
    `${testEvidenceDir}/results.json`,
    JSON.stringify(facts, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  writeFileSync(resultsPath, JSON.stringify(facts, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(`[Test Complete] Results written to ${resultsPath}`);
  assert.equal(ownership.cleanup.baselineUnchanged, true);
  assert.equal(ownership.cleanup.fixtureExited, true);
  if (pgContainerId) {
    assert.equal(ownership.cleanup.removeStatus, 0);
    assert.equal(ownership.cleanup.containerAbsent, true);
    assert.ok(ownership.cleanup.volumesAbsent.every((volume) => volume.absent));
  }
});

test('T06-1: Health Probes', async () => {
  // GET /api/v1/health/live
  const live = await apiRequest('GET', '/api/v1/health/live');
  assert.equal(live.status, 200);
  assert.equal(live.json.status, 'ok');
  assert.equal(live.json.version, '1.0.0');
  parseContract('Health', live.json);

  // GET /api/v1/health/ready
  const ready = await apiRequest('GET', '/api/v1/health/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.json.status, 'ok');
  parseContract('Health', ready.json);

  recordTest('health_probes', true);
});

test('T06-2: Authentication, Sessions, CSRF, and RBAC Matrix', async () => {
  // Failed login
  const failLogin = await apiRequest('POST', '/api/v1/auth/login', {
    body: { email: 'admin@t06.localqa', password: 'WrongPassword' },
  });
  assert.equal(failLogin.status, 401);
  assert.equal(failLogin.json.code, 'UNAUTHENTICATED');
  parseContract('Error', failLogin.json);

  // CSRF / Cross-Site rejection
  const csrfRejection = await apiRequest('POST', '/api/v1/auth/login', {
    body: { email: 'admin@t06.localqa', password: 'AdminSuperPassword123!' },
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(csrfRejection.status, 403);
  assert.equal(csrfRejection.json.code, 'FORBIDDEN');
  parseContract('Error', csrfRejection.json);

  // Successful Admin Login
  const loginRes = await apiRequest('POST', '/api/v1/auth/login', {
    body: { email: 'admin@t06.localqa', password: 'AdminSuperPassword123!' },
  });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.setCookie);
  assert.ok(loginRes.setCookie.includes('session='));
  assert.ok(loginRes.setCookie.includes('HttpOnly'));
  assert.ok(loginRes.setCookie.includes('SameSite=Lax'));
  parseContract('LoginResult', loginRes.json);

  const match = loginRes.setCookie.match(/session=([^;]+)/);
  adminCookie = `session=${match[1]}`;

  // GET /api/v1/auth/me
  const me = await apiRequest('GET', '/api/v1/auth/me', {
    cookie: adminCookie,
  });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, 'admin@t06.localqa');
  assert.equal(me.json.globalRole, 'admin');
  parseContract('User', me.json);

  // Admin creates Operator and Viewer users
  const createOp = await apiRequest('POST', '/api/v1/users', {
    cookie: adminCookie,
    body: {
      email: 'operator@t06.localqa',
      displayName: 'Project Operator',
      password: 'OperatorPass12345!',
      globalRole: 'member',
    },
  });
  assert.equal(createOp.status, 201);
  operatorUser = parseContract('User', createOp.json);

  const createView = await apiRequest('POST', '/api/v1/users', {
    cookie: adminCookie,
    body: {
      email: 'viewer@t06.localqa',
      displayName: 'Project Viewer',
      password: 'ViewerPass12345!',
      globalRole: 'member',
    },
  });
  assert.equal(createView.status, 201);
  viewerUser = parseContract('User', createView.json);

  // Login as operator and viewer
  const opLogin = await apiRequest('POST', '/api/v1/auth/login', {
    body: { email: 'operator@t06.localqa', password: 'OperatorPass12345!' },
  });
  assert.equal(opLogin.status, 200);
  operatorCookie = `session=${opLogin.setCookie.match(/session=([^;]+)/)[1]}`;

  const viewLogin = await apiRequest('POST', '/api/v1/auth/login', {
    body: { email: 'viewer@t06.localqa', password: 'ViewerPass12345!' },
  });
  assert.equal(viewLogin.status, 200);
  viewerCookie = `session=${viewLogin.setCookie.match(/session=([^;]+)/)[1]}`;

  // Non-admin cannot list or create users
  const opListUsers = await apiRequest('GET', '/api/v1/users', {
    cookie: operatorCookie,
  });
  assert.equal(opListUsers.status, 403);
  assert.equal(opListUsers.json.code, 'FORBIDDEN');

  recordTest('auth_sessions_and_rbac', true);
});

test('T06-3: Model Profiles & Capability Probes', async () => {
  // Admin creates ModelProfile
  const createModelRes = await apiRequest('POST', '/api/v1/model-profiles', {
    cookie: adminCookie,
    body: {
      name: 'Default Test Stub Model',
      endpoint: 'https://example.com/v1',
      configuredModelId: 'test-stub',
      adapter: 'openai_compatible',
      dataBoundary: 'internal',
      apiKey: seedKey,
    },
  });
  assert.equal(createModelRes.status, 201);
  testModelProfile = parseContract('ModelProfile', createModelRes.json);

  // List ModelProfiles
  const listModels = await apiRequest('GET', '/api/v1/model-profiles', {
    cookie: operatorCookie,
  });
  assert.equal(listModels.status, 200);
  assert.ok(listModels.json.items.length >= 1);
  parseContract('ModelProfilePage', listModels.json);

  // Model capability probe
  const probeRes = await apiRequest(
    'POST',
    `/api/v1/model-profiles/${testModelProfile.id}/probe`,
    { cookie: adminCookie },
  );
  assert.equal(probeRes.status, 200);
  assert.equal(probeRes.json.profileId, testModelProfile.id);
  parseContract('ModelProbeResult', probeRes.json);
  assert.equal(modelProbeCalls.length, 1);
  assert.equal(modelProbeCalls[0].startsWith('https://example.com/'), true);
  assert.equal(probeRes.json.status, 'degraded');
  assert.notEqual(probeRes.json.status, 'ready');
  assert.equal(probeRes.json.capabilities.structuredOutput, true);
  assert.equal(probeRes.json.capabilities.nativeTools, false);
  assert.equal(probeRes.json.capabilities.imageInput, false);
  assert.match(probeRes.json.notes.join(''), /探测未通过/);
  assert.equal(JSON.stringify(probeRes.json).includes(seedKey), false);

  recordTest('model_profiles_and_probe', true);
});

test('T06-4: Projects, Members, and Strict Cross-Project Isolation (Zero Existence Leaks)', async () => {
  // Admin creates Project Alpha
  const alphaRes = await apiRequest('POST', '/api/v1/projects', {
    cookie: adminCookie,
    body: { name: 'Alpha Project' },
  });
  assert.equal(alphaRes.status, 201);
  projectAlpha = parseContract('Project', alphaRes.json);

  // Admin creates Project Beta (Isolated project)
  const betaRes = await apiRequest('POST', '/api/v1/projects', {
    cookie: adminCookie,
    body: { name: 'Beta Project (Confidential)' },
  });
  assert.equal(betaRes.status, 201);
  projectBeta = parseContract('Project', betaRes.json);

  // Owner PATCH atomically grants and binds a project default. T40 also
  // covers the separate administrator-managed multi-model grant API.
  const deniedDefault = await apiRequest(
    'PATCH',
    `/api/v1/projects/${projectAlpha.id}`,
    {
      cookie: operatorCookie,
      body: { expectedVersion: 1, defaultModelProfileId: testModelProfile.id },
    },
  );
  assert.equal(deniedDefault.status, 404); // non-member: no project existence leak
  const unknownDefault = await apiRequest(
    'PATCH',
    `/api/v1/projects/${projectAlpha.id}`,
    {
      cookie: adminCookie,
      body: { expectedVersion: 1, defaultModelProfileId: randomUUID() },
    },
  );
  assert.equal(unknownDefault.status, 404);
  const patchAlpha = await apiRequest(
    'PATCH',
    `/api/v1/projects/${projectAlpha.id}`,
    {
      cookie: adminCookie,
      body: { expectedVersion: 1, defaultModelProfileId: testModelProfile.id },
    },
  );
  assert.equal(patchAlpha.status, 200);
  projectAlpha = parseContract('Project', patchAlpha.json);
  assert.equal(projectAlpha.defaultModelProfileId, testModelProfile.id);
  const bound = await db.actor({ userId: adminUser.id }, async (client) =>
    client.query(
      'SELECT profile_id FROM model_profile_grants WHERE project_id=$1',
      [projectAlpha.id],
    ),
  );
  assert.equal(bound.rows[0]?.profile_id, testModelProfile.id);

  // Configure Alpha members: admin is owner, operatorUser is operator, viewerUser is viewer
  const replaceMembers = await apiRequest(
    'PUT',
    `/api/v1/projects/${projectAlpha.id}/members`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: projectAlpha.version,
        members: [
          { userId: adminUser.id, role: 'owner' },
          { userId: operatorUser.id, role: 'operator' },
          { userId: viewerUser.id, role: 'viewer' },
        ],
      },
    },
  );
  assert.equal(replaceMembers.status, 200);
  const deniedOperator = await apiRequest(
    'PATCH',
    `/api/v1/projects/${projectAlpha.id}`,
    {
      cookie: operatorCookie,
      body: {
        expectedVersion: replaceMembers.json.version,
        defaultModelProfileId: testModelProfile.id,
      },
    },
  );
  assert.equal(deniedOperator.status, 404); // forced RLS hides the writable row
  const deniedViewer = await apiRequest(
    'PATCH',
    `/api/v1/projects/${projectAlpha.id}`,
    {
      cookie: viewerCookie,
      body: {
        expectedVersion: replaceMembers.json.version,
        defaultModelProfileId: testModelProfile.id,
      },
    },
  );
  assert.equal(deniedViewer.status, 404);

  // List members
  const membersRes = await apiRequest(
    'GET',
    `/api/v1/projects/${projectAlpha.id}/members`,
    {
      cookie: operatorCookie,
    },
  );
  assert.equal(membersRes.status, 200);
  assert.equal(membersRes.json.items.length, 3);
  parseContract('MemberPage', membersRes.json);

  // Operator can access Alpha
  const opAlpha = await apiRequest(
    'GET',
    `/api/v1/projects/${projectAlpha.id}`,
    { cookie: operatorCookie },
  );
  assert.equal(opAlpha.status, 200);

  // Cross-project isolation: Operator and Viewer query Beta (not members of Beta) -> MUST return 404 NOT_FOUND!
  const opBeta = await apiRequest('GET', `/api/v1/projects/${projectBeta.id}`, {
    cookie: operatorCookie,
  });
  assert.equal(opBeta.status, 404);
  assert.equal(opBeta.json.code, 'NOT_FOUND');

  const viewBeta = await apiRequest(
    'GET',
    `/api/v1/projects/${projectBeta.id}`,
    { cookie: viewerCookie },
  );
  assert.equal(viewBeta.status, 404);
  assert.equal(viewBeta.json.code, 'NOT_FOUND');

  // Cross-project isolation: admin creates a run in Beta; Alpha's operator/viewer
  // must not read it or its messages (no existence leak across projects).
  const betaDefault = await apiRequest(
    'PATCH',
    `/api/v1/projects/${projectBeta.id}`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: projectBeta.version,
        defaultModelProfileId: testModelProfile.id,
      },
    },
  );
  assert.equal(betaDefault.status, 200);
  const betaRun = await apiRequest('POST', '/api/v1/runs', {
    cookie: adminCookie,
    headers: { 'Idempotency-Key': `beta-${randomUUID()}` },
    body: { projectId: projectBeta.id, targetUrl: `${fixtureOrigin}/` },
  });
  assert.equal(betaRun.status, 202);
  const crossRun = await apiRequest('GET', `/api/v1/runs/${betaRun.json.id}`, {
    cookie: operatorCookie,
  });
  assert.equal(crossRun.status, 404);
  const crossMessages = await apiRequest(
    'GET',
    `/api/v1/runs/${betaRun.json.id}/messages`,
    {
      cookie: operatorCookie,
    },
  );
  assert.equal(crossMessages.status, 404);
  assert.equal(crossMessages.json.code, 'NOT_FOUND');

  // A project owner without global admin privileges can bind an existing
  // platform model through PATCH alone, without a private grant endpoint.
  const ownerProject = (
    await apiRequest('POST', '/api/v1/projects', {
      cookie: adminCookie,
      body: { name: 'Owner-only default model test' },
    })
  ).json;
  const ownerMembers = await apiRequest(
    'PUT',
    `/api/v1/projects/${ownerProject.id}/members`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: 1,
        members: [
          { userId: adminUser.id, role: 'owner' },
          { userId: operatorUser.id, role: 'owner' },
        ],
      },
    },
  );
  assert.equal(ownerMembers.status, 200);
  const ownerPatch = await apiRequest(
    'PATCH',
    `/api/v1/projects/${ownerProject.id}`,
    {
      cookie: operatorCookie,
      body: {
        expectedVersion: ownerMembers.json.version,
        defaultModelProfileId: testModelProfile.id,
      },
    },
  );
  assert.equal(ownerPatch.status, 200);
  assert.equal(ownerPatch.json.defaultModelProfileId, testModelProfile.id);
  const ownerRun = await apiRequest('POST', '/api/v1/runs', {
    cookie: operatorCookie,
    headers: { 'Idempotency-Key': randomUUID() },
    body: { projectId: ownerProject.id, targetUrl: `${fixtureOrigin}/` },
  });
  assert.equal(ownerRun.status, 202);
  assert.notEqual(ownerRun.json.id, null);
  recordTest('project_membership_and_isolation', true);
});

test('T06-5: Environment, AuthProfile, and Knowledge Configuration', async () => {
  // Viewer cannot create environment
  const viewEnv = await apiRequest(
    'POST',
    `/api/v1/projects/${projectAlpha.id}/environments`,
    {
      cookie: viewerCookie,
      body: {
        name: 'Alpha Staging',
        baseUrl: fixtureOrigin,
        allowedOrigins: [fixtureOrigin],
        tlsPolicy: 'strict',
      },
    },
  );
  assert.equal(viewEnv.status, 403);

  // Admin creates Environment
  const envRes = await apiRequest(
    'POST',
    `/api/v1/projects/${projectAlpha.id}/environments`,
    {
      cookie: adminCookie,
      body: {
        name: 'Alpha Test Fixture',
        baseUrl: fixtureOrigin,
        allowedOrigins: [fixtureOrigin],
        tlsPolicy: 'strict',
        excludedPaths: ['/admin'],
      },
    },
  );
  assert.equal(envRes.status, 201);
  environmentAlpha = parseContract('Environment', envRes.json);

  // An auth profile must not expand the network authorization of its
  // chosen environment, even if the HTTP client bypasses the React UI.
  const widenedAuth = await apiRequest(
    'POST',
    `/api/v1/projects/${projectAlpha.id}/auth-profiles`,
    {
      cookie: adminCookie,
      body: {
        name: 'Denied Out-of-Scope Profile',
        mode: 'none',
        environmentId: environmentAlpha.id,
        allowedOrigins: ['https://outside.fixture.test'],
      },
    },
  );
  assert.equal(widenedAuth.status, 422);
  assert.equal(widenedAuth.json.code, 'TARGET_NOT_ALLOWED');

  // The same environment identifier may not be reused in another project.
  const foreignEnvironment = await apiRequest(
    'POST',
    `/api/v1/projects/${projectBeta.id}/auth-profiles`,
    {
      cookie: adminCookie,
      body: {
        name: 'Denied Foreign Environment',
        mode: 'none',
        environmentId: environmentAlpha.id,
        allowedOrigins: [fixtureOrigin],
      },
    },
  );
  assert.equal(foreignEnvironment.status, 404);

  // Admin creates AuthProfile
  const authRes = await apiRequest(
    'POST',
    `/api/v1/projects/${projectAlpha.id}/auth-profiles`,
    {
      cookie: adminCookie,
      body: {
        name: 'Test Auth Profile',
        mode: 'none',
        allowedOrigins: [fixtureOrigin],
        environmentId: environmentAlpha.id,
      },
    },
  );
  assert.equal(authRes.status, 201);
  authProfileAlpha = parseContract('AuthProfile', authRes.json);
  assert.equal(authProfileAlpha.environmentId, environmentAlpha.id);

  // T42: UI default auth selection must be backed by server authorization,
  // same-environment ownership, version concurrency and Origin constraints.
  const viewerDefaultAuth = await apiRequest(
    'PATCH',
    `/api/v1/environments/${environmentAlpha.id}`,
    {
      cookie: viewerCookie,
      body: {
        expectedVersion: environmentAlpha.version,
        defaultAuthProfileId: authProfileAlpha.id,
      },
    },
  );
  assert.equal(viewerDefaultAuth.status, 403);
  const invalidDefaultAuth = await apiRequest(
    'PATCH',
    `/api/v1/environments/${environmentAlpha.id}`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: environmentAlpha.version,
        defaultAuthProfileId: randomUUID(),
      },
    },
  );
  assert.equal(invalidDefaultAuth.status, 422);
  assert.equal(invalidDefaultAuth.json.code, 'TARGET_NOT_ALLOWED');
  const secondEnv = await apiRequest(
    'POST',
    `/api/v1/projects/${projectAlpha.id}/environments`,
    {
      cookie: adminCookie,
      body: {
        name: 'Other Environment',
        baseUrl: fixtureOrigin,
        allowedOrigins: [fixtureOrigin],
        tlsPolicy: 'strict',
      },
    },
  );
  assert.equal(secondEnv.status, 201);
  const sameProjectWrongEnv = await apiRequest(
    'PATCH',
    `/api/v1/environments/${secondEnv.json.id}`,
    {
      cookie: adminCookie,
      body: { expectedVersion: 1, defaultAuthProfileId: authProfileAlpha.id },
    },
  );
  assert.equal(sameProjectWrongEnv.status, 422);
  const validDefaultAuth = await apiRequest(
    'PATCH',
    `/api/v1/environments/${environmentAlpha.id}`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: environmentAlpha.version,
        name: 'Alpha Test Fixture Updated',
        defaultAuthProfileId: authProfileAlpha.id,
      },
    },
  );
  assert.equal(validDefaultAuth.status, 200);
  environmentAlpha = parseContract('Environment', validDefaultAuth.json);
  assert.equal(environmentAlpha.version, 2);
  assert.equal(environmentAlpha.defaultAuthProfileId, authProfileAlpha.id);
  const staleDefaultAuth = await apiRequest(
    'PATCH',
    `/api/v1/environments/${environmentAlpha.id}`,
    {
      cookie: adminCookie,
      body: { expectedVersion: 1, defaultAuthProfileId: null },
    },
  );
  assert.equal(staleDefaultAuth.status, 409);

  // Operator creates Knowledge
  const knowRes = await apiRequest(
    'POST',
    `/api/v1/projects/${projectAlpha.id}/knowledge`,
    {
      cookie: operatorCookie,
      body: {
        title: 'Checkout Flow Rules',
        text: 'Do not click confirm payment buttons',
        kind: 'rule',
      },
    },
  );
  assert.equal(knowRes.status, 201);
  knowledgeAlpha = parseContract('Knowledge', knowRes.json);
  assert.equal(knowledgeAlpha.approved, false);

  // Operator cannot approve knowledge
  const opApprove = await apiRequest(
    'PATCH',
    `/api/v1/knowledge/${knowledgeAlpha.id}`,
    {
      cookie: operatorCookie,
      body: { expectedVersion: 1, approved: true },
    },
  );
  assert.equal(opApprove.status, 403);

  // Admin approves knowledge
  const adminApprove = await apiRequest(
    'PATCH',
    `/api/v1/knowledge/${knowledgeAlpha.id}`,
    {
      cookie: adminCookie,
      body: { expectedVersion: 1, approved: true },
    },
  );
  assert.equal(adminApprove.status, 200);
  knowledgeAlpha = parseContract('Knowledge', adminApprove.json);
  assert.equal(knowledgeAlpha.approved, true);

  recordTest('config_and_knowledge_lifecycle', true);
});

test('T40: project model grants, admin authorization and cross-project model visibility', async () => {
  const alternate = await apiRequest('POST', '/api/v1/model-profiles', {
    cookie: adminCookie,
    body: {
      name: 'Second Scoped Fixture Model',
      endpoint: 'https://fixture.example.test/v1',
      configuredModelId: 'fixture-secondary',
      adapter: 'openai_compatible',
      dataBoundary: 'internal',
    },
  });
  assert.equal(alternate.status, 201);
  const alternateId = alternate.json.id;
  const alphaPath = `/api/v1/projects/${projectAlpha.id}/model-profiles`;
  const betaPath = `/api/v1/projects/${projectBeta.id}/model-profiles`;
  const before = await apiRequest('GET', alphaPath, { cookie: operatorCookie });
  assert.equal(before.status, 200);
  assert.ok(before.json.items.some((m) => m.id === testModelProfile.id));
  assert.ok(!before.json.items.some((m) => m.id === alternateId));
  const cross = await apiRequest('GET', betaPath, { cookie: operatorCookie });
  assert.equal(cross.status, 404);
  const deniedGrant = await apiRequest('POST', alphaPath, {
    cookie: operatorCookie,
    body: { modelProfileId: alternateId },
  });
  assert.equal(deniedGrant.status, 403);
  const unknown = await apiRequest('POST', alphaPath, {
    cookie: adminCookie,
    body: { modelProfileId: randomUUID() },
  });
  assert.equal(unknown.status, 404);
  const granted = await apiRequest('POST', alphaPath, {
    cookie: adminCookie,
    body: { modelProfileId: alternateId },
  });
  assert.equal(granted.status, 201);
  assert.equal(granted.json.id, alternateId);
  const after = await apiRequest('GET', alphaPath, { cookie: operatorCookie });
  assert.equal(after.status, 200);
  assert.ok(after.json.items.some((m) => m.id === alternateId));
  const beta = await apiRequest('GET', betaPath, { cookie: adminCookie });
  assert.equal(beta.status, 200);
  assert.ok(!beta.json.items.some((m) => m.id === alternateId));
  recordTest('project_model_grant_visibility', true);
});

test('T43: membership replacement, role guard and project archive', async () => {
  const created = await apiRequest('POST', '/api/v1/projects', {
    cookie: adminCookie,
    body: { name: 'T43 Members Lifecycle' },
  });
  assert.equal(created.status, 201);
  const id = created.json.id;
  const path = `/api/v1/projects/${id}/members`;
  const noOwner = await apiRequest('PUT', path, {
    cookie: adminCookie,
    body: {
      expectedVersion: created.json.version,
      members: [{ userId: operatorUser.id, role: 'operator' }],
    },
  });
  assert.equal(noOwner.status, 422);
  const duplicate = await apiRequest('PUT', path, {
    cookie: adminCookie,
    body: {
      expectedVersion: created.json.version,
      members: [
        { userId: adminUser.id, role: 'owner' },
        { userId: adminUser.id, role: 'viewer' },
      ],
    },
  });
  assert.equal(duplicate.status, 422);
  const originalMembers = [
    { userId: adminUser.id, role: 'owner' },
    { userId: operatorUser.id, role: 'operator' },
    { userId: viewerUser.id, role: 'viewer' },
  ];
  const saved = await apiRequest('PUT', path, {
    cookie: adminCookie,
    body: { expectedVersion: created.json.version, members: originalMembers },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.version, 2);
  const denied = await apiRequest('PUT', path, {
    cookie: viewerCookie,
    body: { expectedVersion: saved.json.version, members: originalMembers },
  });
  assert.equal(denied.status, 404); // RLS hides the writable project row.
  const stale = await apiRequest('PUT', path, {
    cookie: adminCookie,
    body: { expectedVersion: created.json.version, members: originalMembers },
  });
  assert.equal(stale.status, 409);
  const roles = await apiRequest('GET', path, { cookie: operatorCookie });
  assert.equal(roles.status, 200);
  assert.equal(roles.json.items.length, 3);
  const revised = await apiRequest('PUT', path, {
    cookie: adminCookie,
    body: {
      expectedVersion: saved.json.version,
      members: [
        { userId: adminUser.id, role: 'owner' },
        { userId: operatorUser.id, role: 'viewer' },
      ],
    },
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.json.version, 3);
  const finalMembers = await apiRequest('GET', path, { cookie: adminCookie });
  assert.equal(finalMembers.status, 200);
  assert.equal(finalMembers.json.items.length, 2);
  assert.ok(!finalMembers.json.items.some((m) => m.userId === viewerUser.id));
  assert.equal(
    finalMembers.json.items.find((m) => m.userId === operatorUser.id)?.role,
    'viewer',
  );
  const configured = await apiRequest('PATCH', `/api/v1/projects/${id}`, {
    cookie: adminCookie,
    body: {
      expectedVersion: revised.json.version,
      defaultModelProfileId: testModelProfile.id,
    },
  });
  assert.equal(configured.status, 200);
  const deniedArchive = await apiRequest('PATCH', `/api/v1/projects/${id}`, {
    cookie: operatorCookie,
    body: { expectedVersion: configured.json.version, status: 'archived' },
  });
  assert.equal(deniedArchive.status, 404);
  const archived = await apiRequest('PATCH', `/api/v1/projects/${id}`, {
    cookie: adminCookie,
    body: { expectedVersion: configured.json.version, status: 'archived' },
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.json.status, 'archived');
  const archivedRun = await apiRequest('POST', '/api/v1/runs', {
    cookie: adminCookie,
    headers: { 'Idempotency-Key': randomUUID() },
    body: { projectId: id, targetUrl: `${fixtureOrigin}/` },
  });
  assert.equal(archivedRun.status, 409);
  assert.equal(archivedRun.json.code, 'PROJECT_ARCHIVED');
  recordTest('T43_members_and_archive', true);
});

test('T45: empty project deletion checks authorization, exact confirmation, data and audit retention', async () => {
  const created = await apiRequest('POST', '/api/v1/projects', {
    cookie: adminCookie,
    body: { name: 'T45 Disposable Empty Project' },
  });
  assert.equal(created.status, 201);
  const project = created.json;
  const url = `/api/v1/projects/${project.id}`;
  const payload = {
    expectedVersion: project.version,
    confirmName: project.name,
  };
  const noAuth = await apiRequest('DELETE', url, { body: payload });
  assert.equal(noAuth.status, 401);
  const noAdmin = await apiRequest('DELETE', url, {
    cookie: operatorCookie,
    body: payload,
  });
  assert.equal(noAdmin.status, 403);
  const wrongName = await apiRequest('DELETE', url, {
    cookie: adminCookie,
    body: { ...payload, confirmName: 'Wrong Project' },
  });
  assert.equal(wrongName.status, 422);
  const wrongVersion = await apiRequest('DELETE', url, {
    cookie: adminCookie,
    body: { ...payload, expectedVersion: project.version + 1 },
  });
  assert.equal(wrongVersion.status, 409);
  const existing = await apiRequest('GET', url, { cookie: adminCookie });
  assert.equal(existing.status, 200);
  const removed = await apiRequest('DELETE', url, {
    cookie: adminCookie,
    body: payload,
  });
  assert.equal(removed.status, 204);
  const missing = await apiRequest('GET', url, { cookie: adminCookie });
  assert.equal(missing.status, 404);
  const audit = await apiContext.db.actor(
    { userId: adminUser.id },
    async (client) =>
      (
        await client.query(
          `SELECT action,project_id,object_id
         FROM audit_log WHERE object_id=$1 ORDER BY created_at`,
          [project.id],
        )
      ).rows,
  );
  assert.ok(audit.some((row) => row.action === 'project.created'));
  assert.ok(audit.some((row) => row.action === 'project.deleted'));
  // The original audit UUID is still retained after its project is gone.
  assert.ok(audit.some((row) => row.project_id === project.id));
  assert.ok(
    audit.some(
      (row) => row.action === 'project.deleted' && row.project_id === null,
    ),
  );

  const nonempty = await apiRequest('POST', '/api/v1/projects', {
    cookie: adminCookie,
    body: { name: 'T45 Nonempty Protected Project' },
  });
  assert.equal(nonempty.status, 201);
  const member = await apiRequest(
    'PUT',
    `/api/v1/projects/${nonempty.json.id}/members`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: nonempty.json.version,
        members: [
          { userId: adminUser.id, role: 'owner' },
          { userId: operatorUser.id, role: 'viewer' },
        ],
      },
    },
  );
  assert.equal(member.status, 200);
  const blocked = await apiRequest(
    'DELETE',
    `/api/v1/projects/${nonempty.json.id}`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: member.json.version,
        confirmName: nonempty.json.name,
      },
    },
  );
  assert.equal(blocked.status, 422);
  assert.equal(blocked.json.code, 'VALIDATION_ERROR');
  assert.equal(
    (
      await apiRequest('GET', `/api/v1/projects/${nonempty.json.id}`, {
        cookie: adminCookie,
      })
    ).status,
    200,
  );
  recordTest('T45_safe_delete_empty_project', true);
});

test('T06-6: Run Creation, Idempotency-Key Deduplication & Conflict', async () => {
  // Viewer cannot create run
  const viewRun = await apiRequest('POST', '/api/v1/runs', {
    cookie: viewerCookie,
    headers: { 'Idempotency-Key': 'key-view-01' },
    body: {
      projectId: projectAlpha.id,
      targetUrl: `${fixtureOrigin}/`,
    },
  });
  assert.equal(viewRun.status, 403);

  // Missing Idempotency-Key
  const noKey = await apiRequest('POST', '/api/v1/runs', {
    cookie: operatorCookie,
    body: {
      projectId: projectAlpha.id,
      targetUrl: `${fixtureOrigin}/`,
    },
  });
  assert.equal(noKey.status, 422);
  assert.equal(noKey.json.code, 'VALIDATION_ERROR');

  // Explicit model selection must be scoped to a project grant.
  // The frontend listing a global model never authorizes using it.
  const ungranted = await apiRequest('POST', '/api/v1/runs', {
    cookie: operatorCookie,
    headers: { 'Idempotency-Key': `ungranted-${randomUUID()}` },
    body: {
      projectId: projectAlpha.id,
      targetUrl: `${fixtureOrigin}/`,
      modelProfileId: randomUUID(),
    },
  });
  assert.equal(ungranted.status, 409);
  assert.equal(ungranted.json.code, 'MODEL_NOT_CONFIGURED');

  const idempotencyKey = `idemp-${randomUUID()}`;
  const runPayload = {
    projectId: projectAlpha.id,
    targetUrl: `${fixtureOrigin}/`,
    environmentId: environmentAlpha.id,
    modelProfileId: testModelProfile.id,
    brief: 'Smoke exploration of fixture home',
  };

  // 1. Initial creation
  const create1 = await apiRequest('POST', '/api/v1/runs', {
    cookie: operatorCookie,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: runPayload,
  });
  assert.equal(create1.status, 202);
  testRun = parseContract('Run', create1.json);
  assert.equal(testRun.status, 'queued');
  assert.equal(testRun.contextVersion, 1);
  assert.equal(
    testRun.effectiveConfig.models.executor.profileId,
    testModelProfile.id,
  );

  // Saturated admission returns 429 + Retry-After without persisting a new run.
  await db.actor({ userId: adminUser.id }, async (client) => {
    for (let i = 0; i < apiContext.coordinator.platformSlots; i++)
      await client.query(
        "INSERT INTO budget_reservations(id,project_id,run_id,request_id,kind,reserved,status) VALUES($1,$2,$3,$4,'concurrency','{}','reserved')",
        [randomUUID(), projectAlpha.id, testRun.id, randomUUID()],
      );
  });
  const saturated = await apiRequest('POST', '/api/v1/runs', {
    cookie: operatorCookie,
    headers: { 'Idempotency-Key': `saturated-${randomUUID()}` },
    body: runPayload,
  });
  assert.equal(saturated.status, 429);
  assert.equal(saturated.json.code, 'RATE_LIMITED');
  assert.equal(saturated.headers.get('retry-after'), '1');
  await db.actor({ userId: adminUser.id }, async (client) =>
    client.query(
      "UPDATE budget_reservations SET status='released' WHERE run_id=$1 AND kind='concurrency' AND status='reserved'",
      [testRun.id],
    ),
  );

  // 2. Exact duplicate idempotency request -> Returns existing Run (202)
  const create2 = await apiRequest('POST', '/api/v1/runs', {
    cookie: operatorCookie,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: runPayload,
  });
  assert.equal(create2.status, 202);
  assert.equal(create2.json.id, testRun.id);

  // 3. Different body with same Idempotency-Key -> 409 IDEMPOTENCY_CONFLICT!
  const createConflict = await apiRequest('POST', '/api/v1/runs', {
    cookie: operatorCookie,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      ...runPayload,
      brief: 'Changed brief - triggers conflict',
    },
  });
  assert.equal(createConflict.status, 409);
  assert.equal(createConflict.json.code, 'IDEMPOTENCY_CONFLICT');

  // GET /api/v1/runs
  const listRuns = await apiRequest(
    'GET',
    `/api/v1/runs?projectId=${projectAlpha.id}`,
    {
      cookie: operatorCookie,
    },
  );
  assert.equal(listRuns.status, 200);
  assert.ok(listRuns.json.items.some((r) => r.id === testRun.id));
  parseContract('RunPage', listRuns.json);

  // GET /api/v1/runs/{runId}
  const getRun = await apiRequest('GET', `/api/v1/runs/${testRun.id}`, {
    cookie: operatorCookie,
  });
  assert.equal(getRun.status, 200);
  assert.equal(getRun.json.id, testRun.id);
  parseContract('Run', getRun.json);

  recordTest('run_creation_and_idempotency', true);
});

test('T06-7: Run Messages and Context Version Advancement', async () => {
  let staleMsg, sendMsg;
  try {
    // Stale context version rejection
    staleMsg = await apiRequest('POST', `/api/v1/runs/${testRun.id}/messages`, {
      cookie: operatorCookie,
      body: {
        expectedContextVersion: 99,
        text: 'Stale message',
      },
    });
    assert.equal(staleMsg.status, 409);
    assert.equal(staleMsg.json.code, 'VERSION_CONFLICT');

    // Valid message advances context_version to 2
    sendMsg = await apiRequest('POST', `/api/v1/runs/${testRun.id}/messages`, {
      cookie: operatorCookie,
      body: {
        expectedContextVersion: 1,
        text: 'Prioritize exploring navigation links',
      },
    });
    assert.equal(sendMsg.status, 202);
    assert.equal(sendMsg.json.contextVersion, 2);
    testRun = parseContract('Run', sendMsg.json);

    // Redaction: secret-looking text is masked at write; DB, API, and events
    // never contain the original secret. Normal text is not over-redacted.
    // The literal marker "[REDACTED]" proves replacement happened (a plain
    // passthrough would keep the raw secret and fail these assertions).
    const secretMsg = await apiRequest(
      'POST',
      `/api/v1/runs/${testRun.id}/messages`,
      {
        cookie: operatorCookie,
        body: {
          expectedContextVersion: 2,
          text: 'login with password=Sup3rSecret! and Bearer abcdef012345 token',
        },
      },
    );
    assert.equal(secretMsg.status, 202, JSON.stringify(secretMsg.json));
    testRun = parseContract('Run', secretMsg.json);
    const list2 = await apiRequest(
      'GET',
      `/api/v1/runs/${testRun.id}/messages`,
      {
        cookie: operatorCookie,
      },
    );
    const msgs = parseContract('RunMessagePage', list2.json).items;
    const redacted = msgs.find((m) => m.redactedText.includes('login with'));
    assert.ok(redacted, 'redacted message present');
    assert.ok(
      !redacted.redactedText.includes('Sup3rSecret!'),
      'password not in API response',
    );
    assert.ok(
      !redacted.redactedText.includes('abcdef012345'),
      'bearer not in API response',
    );
    assert.ok(
      redacted.redactedText.includes('[redacted]'),
      'redaction marker present in API response',
    );
    const dbRow = await db.actor(
      { userId: adminUser.id },
      async (client) =>
        (
          await client.query(
            'SELECT redacted_text FROM run_messages WHERE id=$1',
            [redacted.id],
          )
        ).rows[0],
    );
    assert.ok(
      !dbRow.redacted_text.includes('Sup3rSecret!'),
      'password not in DB',
    );
    assert.ok(
      dbRow.redacted_text.includes('[redacted]'),
      'redaction marker present in DB',
    );
    const normal = await apiRequest(
      'POST',
      `/api/v1/runs/${testRun.id}/messages`,
      {
        cookie: operatorCookie,
        body: {
          expectedContextVersion: testRun.contextVersion,
          text: 'check the footer navigation',
        },
      },
    );
    assert.equal(normal.status, 202);
    const list3 = await apiRequest(
      'GET',
      `/api/v1/runs/${testRun.id}/messages`,
      { cookie: operatorCookie },
    );
    assert.ok(
      parseContract('RunMessagePage', list3.json).items.some(
        (m) => m.redactedText === 'check the footer navigation',
      ),
      'normal text not over-redacted',
    );

    // GET messages (approved contract addition): member can read own run's messages.
    const list = await apiRequest(
      'GET',
      `/api/v1/runs/${testRun.id}/messages`,
      {
        cookie: operatorCookie,
      },
    );
    assert.equal(list.status, 200);
    const page = parseContract('RunMessagePage', list.json);
    assert.ok(
      page.items.some(
        (m) => m.redactedText === 'Prioritize exploring navigation links',
      ),
    );

    recordTest('run_messages_and_context_version', true);
  } catch (err) {
    console.error(
      'T06-7 FAILED:',
      err,
      'staleMsg:',
      staleMsg?.status,
      staleMsg?.json,
      'sendMsg:',
      sendMsg?.status,
      sendMsg?.json,
    );
    throw err;
  }
});

test('T06-8: SSE Streaming, Event Framing, and 410 EVENTS_EXPIRED Recovery', async () => {
  // Connect to SSE stream
  const sseUrl = `${baseUrl}/api/v1/runs/${testRun.id}/events`;
  const res = await fetch(sseUrl, {
    headers: {
      Cookie: operatorCookie,
      Accept: 'text/event-stream',
    },
  });

  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/event-stream'));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let receivedData = '';

  for (let i = 0; i < 5; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    receivedData += decoder.decode(value, { stream: true });
    if (receivedData.includes('run.updated')) {
      break;
    }
  }
  await reader.cancel();

  assert.ok(receivedData.includes('id: 1'));
  assert.ok(receivedData.includes('run.updated'));
  const completeFrames = receivedData
    .split('\n\n')
    .filter((frame) => frame.includes('data: '));
  assert.ok(completeFrames.length >= 1);
  for (const frame of completeFrames) {
    assert.equal((frame.match(/^id: /gm) || []).length, 1);
    assert.equal((frame.match(/^event: /gm) || []).length, 1);
    assert.equal((frame.match(/^data: /gm) || []).length, 1);
  }

  // Verify event-history endpoint:
  const history = await apiRequest(
    'GET',
    `/api/v1/runs/${testRun.id}/event-history?afterSeq=0&limit=10`,
    {
      cookie: operatorCookie,
    },
  );
  assert.equal(history.status, 200);
  assert.ok(history.json.items.length >= 2);
  parseContract('RunEventPage', history.json);

  // A cursor beyond the current maximum is not an expired cursor.
  const futureController = new AbortController();
  const future = await fetch(`${baseUrl}/api/v1/runs/${testRun.id}/events`, {
    headers: { Cookie: operatorCookie, 'Last-Event-ID': '99999' },
    signal: futureController.signal,
  });
  assert.equal(future.status, 200);
  futureController.abort();
  const badCursor = await apiRequest(
    'GET',
    `/api/v1/runs/${testRun.id}/event-history?afterSeq=1junk`,
    { cookie: operatorCookie },
  );
  assert.equal(badCursor.status, 422);
  const defaultHistory = await apiRequest(
    'GET',
    `/api/v1/runs/${testRun.id}/event-history`,
    { cookie: operatorCookie },
  );
  assert.equal(defaultHistory.status, 200);
  assert.ok(defaultHistory.json.items.length <= 20);
  const badLimit = await apiRequest(
    'GET',
    `/api/v1/runs/${testRun.id}/event-history?limit=101`,
    { cookie: operatorCookie },
  );
  assert.equal(badLimit.status, 422);

  recordTest('sse_streaming_and_events', true);
});

test('T06-9: Internal Worker Protocol (/internal/v1/*) and Service Identity', async () => {
  // 1. Internal endpoint MUST REJECT user cookie sessions
  const cookieReject = await apiRequest('POST', '/internal/v1/leases/claim', {
    cookie: operatorCookie,
    body: {
      workerId: 'worker-node-1',
      capabilities: ['chromium'],
    },
  });
  assert.equal(cookieReject.status, 403);
  assert.equal(cookieReject.json.code, 'FORBIDDEN');

  // 2. Claim task as worker (service identity)
  const claimRes = await apiRequest(
    'POST',
    `/internal/v1/leases/claim?projectId=${projectAlpha.id}`,
    {
      body: {
        workerId: 'worker-node-1',
        capabilities: ['chromium'],
      },
    },
  );
  assert.equal(claimRes.status, 200);
  const lease = parseContract('Lease', claimRes.json);
  assert.ok(lease.leaseToken);
  assert.ok(lease.fencingToken >= 1);

  // 3. Heartbeat task
  const heartbeatRes = await apiRequest(
    'POST',
    `/internal/v1/tasks/${lease.task.id}/heartbeat`,
    {
      headers: {
        'X-Lease-Token': lease.leaseToken,
        'X-Worker-Id': 'worker-node-1',
      },
      body: {
        fencingToken: lease.fencingToken,
        contextVersion: lease.contextVersion,
      },
    },
  );
  assert.equal(heartbeatRes.status, 200);
  parseContract('HeartbeatResult', heartbeatRes.json);

  // Update task to explorer role so browser action is permitted by domain policy
  await db.actor({ userId: adminUser.id }, async (client) => {
    await client.query("UPDATE jobs SET role = 'explorer' WHERE id = $1", [
      lease.task.id,
    ]);
  });

  // 4. Action reservation
  const reserveRes = await apiRequest('POST', '/internal/v1/actions/reserve', {
    headers: {
      'X-Lease-Token': lease.leaseToken,
      'X-Worker-Id': 'worker-node-1',
    },
    body: {
      taskId: lease.task.id,
      fencingToken: lease.fencingToken,
      contextVersion: lease.contextVersion,
      toolCall: {
        name: 'navigate',
        args: { url: `${fixtureOrigin}/` },
      },
    },
  });
  assert.equal(reserveRes.status, 200);
  assert.equal(reserveRes.json.permitted, true);
  const permit = parseContract('ActionPermit', reserveRes.json);

  // 5. Complete action result
  const actionRes = await apiRequest(
    'POST',
    `/internal/v1/actions/${permit.actionId}/result`,
    {
      headers: {
        'X-Lease-Token': lease.leaseToken,
        'X-Worker-Id': 'worker-node-1',
        'X-Fencing-Token': String(lease.fencingToken),
        'X-Context-Version': String(lease.contextVersion),
      },
      body: {
        outcome: 'succeeded',
        summary: `Navigated to ${fixtureOrigin}/`,
        evidenceRefs: [],
        resultHash: createHash('sha256').update('nav-outcome').digest('hex'),
      },
    },
  );
  assert.equal(actionRes.status, 200);

  // 6. Complete task
  const completeRes = await apiRequest(
    'POST',
    `/internal/v1/tasks/${lease.task.id}/complete`,
    {
      headers: {
        'X-Lease-Token': lease.leaseToken,
        'X-Worker-Id': 'worker-node-1',
      },
      body: {
        fencingToken: lease.fencingToken,
        status: 'succeeded',
        result: { completed: true },
        resultHash: createHash('sha256')
          .update(JSON.stringify({ completed: true }))
          .digest('hex'),
      },
    },
  );
  assert.equal(completeRes.status, 200);
  parseContract('Task', completeRes.json);

  recordTest('internal_worker_protocol', true);
});

test('T06-10: Human Triage Preview Token and Single-Use Consumption', async () => {
  // Insert a test finding directly in DB
  const testCase = smokeCase(testRun, `${fixtureOrigin}/`);
  const caseId = testCase.id;
  const cHash = criteriaHash(testCase);
  const findingId = randomUUID();
  const originalAttemptId = randomUUID();

  const findingDoc = {
    id: findingId,
    runId: testRun.id,
    caseIds: [caseId],
    kind: 'functional',
    status: 'suspected',
    title: 'Cart item count mismatch',
    severity: 'medium',
    expected: 'Expected 1 item',
    actual: 'Saw 0',
    expectedSource: 'user_spec',
    reproSteps: ['Step 1: Check cart'],
    evidenceRefs: [],
    reproductionRef: null,
    triageDisposition: 'open',
    version: 1,
  };

  await db.actor({ userId: adminUser.id }, async (client) => {
    const jobRow = (
      await client.query(
        'SELECT id, project_id, run_id FROM jobs WHERE run_id = $1 LIMIT 1',
        [testRun.id],
      )
    ).rows[0];
    let taskId = jobRow?.id;
    if (!taskId) {
      taskId = randomUUID();
      await client.query(
        `INSERT INTO jobs(id, project_id, run_id, unique_key, role, status, document)
         VALUES($1, $2, $3, $4, 'explorer', 'queued', '{}')`,
        [taskId, projectAlpha.id, testRun.id, `job-${taskId}`],
      );
    }

    await client.query(
      `INSERT INTO run_cases(id, project_id, run_id, document, criteria_hash)
       VALUES($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [caseId, projectAlpha.id, testRun.id, testCase, cHash],
    );
    await client.query(
      `INSERT INTO case_attempts(id, project_id, run_id, case_id, task_id, attempt_number, status, context_id)
       VALUES($1, $2, $3, $4, $5, 1, 'completed', $6) ON CONFLICT DO NOTHING`,
      [
        originalAttemptId,
        projectAlpha.id,
        testRun.id,
        caseId,
        taskId,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO findings(id, project_id, run_id, case_id, original_attempt_id, criteria_hash, fingerprint, kind, status, expected_source, version, document)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11)`,
      [
        findingId,
        projectAlpha.id,
        testRun.id,
        caseId,
        originalAttemptId,
        cHash,
        'err-404-cart',
        findingDoc.kind,
        findingDoc.status,
        findingDoc.expectedSource,
        findingDoc,
      ],
    );
  });

  // GET /api/v1/findings/{findingId}
  const getFinding = await apiRequest('GET', `/api/v1/findings/${findingId}`, {
    cookie: operatorCookie,
  });
  assert.equal(getFinding.status, 200);
  assert.equal(getFinding.json.id, findingId);
  parseContract('Finding', getFinding.json);

  // 1. Generate Triage Preview token (300s expiry)
  const previewRes = await apiRequest(
    'POST',
    `/api/v1/findings/${findingId}/triage-preview`,
    {
      cookie: operatorCookie,
      body: {
        expectedVersion: 1,
        disposition: 'accepted',
        reason: 'Confirmed real defect in checkout tally',
      },
    },
  );
  assert.equal(previewRes.status, 200);
  const preview = parseContract('TriagePreview', previewRes.json);
  assert.ok(preview.confirmationToken);
  assert.equal(preview.expectedVersion, 1);
  assert.equal(preview.disposition, 'accepted');

  // Stale version preview rejected
  const stalePreview = await apiRequest(
    'POST',
    `/api/v1/findings/${findingId}/triage-preview`,
    {
      cookie: operatorCookie,
      body: {
        expectedVersion: 99,
        disposition: 'accepted',
        reason: 'Invalid version',
      },
    },
  );
  assert.equal(stalePreview.status, 409);
  assert.equal(stalePreview.json.code, 'VERSION_CONFLICT');

  // 2. Commit triage using confirmation token
  const commitRes = await apiRequest(
    'POST',
    `/api/v1/findings/${findingId}/triage`,
    {
      cookie: operatorCookie,
      body: {
        expectedVersion: 1,
        disposition: 'accepted',
        reason: 'Confirmed real defect in checkout tally',
        confirmationToken: preview.confirmationToken,
      },
    },
  );
  assert.equal(commitRes.status, 200);
  const triagedFinding = parseContract('Finding', commitRes.json);
  assert.equal(triagedFinding.version, 2);
  assert.equal(triagedFinding.triageDisposition, 'accepted');

  // 3. Re-using same confirmation token MUST fail (single-use token!)
  const reuseRes = await apiRequest(
    'POST',
    `/api/v1/findings/${findingId}/triage`,
    {
      cookie: operatorCookie,
      body: {
        expectedVersion: 2,
        disposition: 'accepted',
        reason: 'Confirmed real defect in checkout tally',
        confirmationToken: preview.confirmationToken,
      },
    },
  );
  assert.equal(reuseRes.status, 409);
  assert.equal(reuseRes.json.code, 'VERSION_CONFLICT');

  recordTest('human_triage_preview_and_commit', true);
});

test('T06-11: Idempotent Run Cancellation', async () => {
  // First cancel
  const cancel1 = await apiRequest(
    'POST',
    `/api/v1/runs/${testRun.id}/cancel`,
    {
      cookie: operatorCookie,
    },
  );
  assert.equal(cancel1.status, 202);
  assert.ok(['cancelling', 'cancelled'].includes(cancel1.json.status));
  parseContract('Run', cancel1.json);

  // Second cancel (Idempotent)
  const cancel2 = await apiRequest(
    'POST',
    `/api/v1/runs/${testRun.id}/cancel`,
    {
      cookie: operatorCookie,
    },
  );
  assert.equal(cancel2.status, 202);
  parseContract('Run', cancel2.json);

  recordTest('run_cancellation_idempotent', true);
});

test('T06-12: Report, Export, and Artifact Lifecycle', async () => {
  // GET /api/v1/runs/{runId}/report
  const reportRes = await apiRequest(
    'GET',
    `/api/v1/runs/${testRun.id}/report`,
    {
      cookie: operatorCookie,
    },
  );
  assert.equal(reportRes.status, 200);
  assert.equal(reportRes.json.schemaVersion, 1);
  parseContract('Report', reportRes.json);

  // POST /api/v1/runs/{runId}/exports
  const exportRes = await apiRequest(
    'POST',
    `/api/v1/runs/${testRun.id}/exports`,
    {
      cookie: operatorCookie,
      body: { format: 'json' },
    },
  );
  assert.equal(exportRes.status, 202);
  const exp = parseContract('Export', exportRes.json);
  assert.ok(
    exp.artifactId,
    'ready JSON export must contain downloadable bytes',
  );
  const jsonBytes = await fetch(
    `${baseUrl}/api/v1/artifacts/${exp.artifactId}/content`,
    {
      headers: { Cookie: operatorCookie },
    },
  );
  assert.equal(jsonBytes.status, 200);
  assert.equal(jsonBytes.headers.get('content-type'), 'application/json');
  assert.equal((await jsonBytes.json()).run.id, testRun.id);

  const markdown = await apiRequest(
    'POST',
    `/api/v1/runs/${testRun.id}/exports`,
    {
      cookie: operatorCookie,
      body: { format: 'markdown' },
    },
  );
  assert.equal(markdown.status, 202);
  const mdRecord = parseContract('Export', markdown.json);
  assert.equal(mdRecord.format, 'markdown');
  assert.equal(mdRecord.status, 'ready');
  assert.ok(mdRecord.artifactId);
  const mdResponse = await fetch(
    `${baseUrl}/api/v1/artifacts/${mdRecord.artifactId}/content`,
    { headers: { Cookie: operatorCookie } },
  );
  assert.equal(mdResponse.status, 200);
  assert.match(mdResponse.headers.get('content-type'), /^text\/markdown/);
  const mdBytes = await mdResponse.text();
  assert.ok(mdBytes.length > 0, 'Markdown download must contain real bytes');
  assert.match(mdBytes, /#/);

  const zip = await apiRequest('POST', `/api/v1/runs/${testRun.id}/exports`, {
    cookie: operatorCookie,
    body: { format: 'zip' },
  });
  assert.equal(zip.status, 202);
  assert.ok(zip.json.artifactId);
  const zipResponse = await fetch(
    `${baseUrl}/api/v1/artifacts/${zip.json.artifactId}/content`,
    {
      headers: { Cookie: operatorCookie },
    },
  );
  assert.equal(zipResponse.status, 200);
  assert.equal(zipResponse.headers.get('content-type'), 'application/zip');
  const zipPath = `${testEvidenceDir}/export-${tag}.zip`;
  try {
    writeFileSync(zipPath, Buffer.from(await zipResponse.arrayBuffer()));
    // Node's test runner is cross-platform; GNU unzip is not installed on
    // Windows. Expand to an owned temp dir and verify the same bytes/hashes.
    const windowsExtractDir = join(testEvidenceDir, 'zip-extracted');
    if (process.platform === 'win32') {
      mkdirSync(windowsExtractDir, { recursive: true });
    }
    const testZip =
      process.platform === 'win32'
        ? spawnSync(
            'powershell',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${windowsExtractDir.replace(/'/g, "''")}' -Force`,
            ],
            { encoding: 'utf8' },
          )
        : spawnSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
    assert.equal(testZip.status, 0, testZip.stderr);
    const manifest = JSON.parse(
      process.platform === 'win32'
        ? readFileSync(join(windowsExtractDir, 'manifest.json'), 'utf8')
        : spawnSync('unzip', ['-p', zipPath, 'manifest.json'], {
            encoding: 'utf8',
          }).stdout,
    );
    assert.equal(manifest.runId, testRun.id);
    for (const entry of manifest.artifacts) {
      if (entry.status !== 'available') continue;
      assert.ok(
        !entry.relativePath.includes('..') &&
          !entry.relativePath.startsWith('/'),
      );
      const file =
        process.platform === 'win32'
          ? {
              status: 0,
              stdout: readFileSync(join(windowsExtractDir, entry.relativePath)),
            }
          : spawnSync('unzip', ['-p', zipPath, entry.relativePath]);
      assert.equal(file.status, 0);
      assert.equal(
        createHash('sha256').update(file.stdout).digest('hex'),
        entry.sha256,
      );
    }
    for (const name of ['report.json', 'report.md', 'manifest.json']) {
      const bytes =
        process.platform === 'win32'
          ? readFileSync(join(windowsExtractDir, name))
          : spawnSync('unzip', ['-p', zipPath, name]).stdout;
      assert.ok(bytes.length > 0, name);
    }
  } finally {
    rmSync(zipPath, { force: true });
  }

  // GET /api/v1/exports/{exportId}
  const getExp = await apiRequest('GET', `/api/v1/exports/${exp.id}`, {
    cookie: operatorCookie,
  });
  assert.equal(getExp.status, 200);
  assert.equal(getExp.json.id, exp.id);
  parseContract('Export', getExp.json);
  assert.equal(getExp.json.artifactId, exp.artifactId);

  recordTest('report_and_exports', true);
});

test('T06 regression: pagination and stable lease errors', async () => {
  for (const query of [
    { limit: '101' },
    { limit: '1junk' },
    { limit: '0' },
    { cursor: '%%%' },
    { cursor: Buffer.from('7junk').toString('base64url') },
  ]) {
    assert.throws(
      () => parsePagination(query),
      (e) => e.code === 'VALIDATION_ERROR',
    );
  }
  assert.equal(parsePagination({}).limit, 20);
  assert.equal(
    parsePagination({ cursor: Buffer.from('2').toString('base64url') }).offset,
    2,
  );
  const invalidPage = await apiRequest(
    'GET',
    `/api/v1/runs?projectId=${projectAlpha.id}&limit=101`,
    { cookie: operatorCookie },
  );
  assert.equal(invalidPage.status, 422);
  const invalidCursor = await apiRequest(
    'GET',
    `/api/v1/runs?projectId=${projectAlpha.id}&cursor=MTJqdW5r`,
    { cookie: operatorCookie },
  );
  assert.equal(invalidCursor.status, 422);
  const scoped = toApiErrorResponse(
    new StorageError('SCOPE_CHANGED'),
    randomUUID(),
  );
  assert.equal(scoped.status, 409);
  assert.equal(scoped.body.code, 'LEASE_EXPIRED');
  for (const code of [
    'POLICY_DENIED',
    'BUDGET_EXCEEDED',
    'INPUT_TIMEOUT',
    'USER_CANCELLED',
  ]) {
    const response = toApiErrorResponse(new DomainError(code), randomUUID());
    assert.equal(response.body.code, 'VALIDATION_ERROR');
    assert.equal(response.status, 422);
  }
  recordTest('pagination_and_stable_lease_errors', true);
});

test('T06 regression: artifact Range, missing bytes and multipart-only upload', async () => {
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const artId = randomUUID();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const doc = parseContract('Artifact', {
    id: artId,
    projectId: projectAlpha.id,
    runId: testRun.id,
    kind: 'screenshot',
    status: 'available',
    bytes: bytes.length,
    sha256,
    redaction: 'not_needed',
    contentUrl: `/api/v1/artifacts/${artId}/content`,
    error: null,
    createdAt: new Date().toISOString(),
    taskId: null,
    stepId: null,
    caseId: null,
    snapshotId: null,
  });
  const dir = `${testEvidenceDir}/artifacts/${projectAlpha.id}/${testRun.id}`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${artId}`;
  writeFileSync(file, bytes);
  try {
    await db.actor({ userId: adminUser.id }, (client) =>
      client.query(
        "INSERT INTO artifacts(id,project_id,run_id,document,retain_until) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 day')",
        [artId, projectAlpha.id, testRun.id, doc],
      ),
    );
    const url = `${baseUrl}/api/v1/artifacts/${artId}/content`;
    const full = await fetch(url, { headers: { Cookie: operatorCookie } });
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const partial = await fetch(url, {
      headers: { Cookie: operatorCookie, Range: 'bytes=2-5' },
    });
    assert.equal(partial.status, 206);
    assert.equal(
      partial.headers.get('content-range'),
      `bytes 2-5/${bytes.length}`,
    );
    assert.deepEqual(
      Buffer.from(await partial.arrayBuffer()),
      bytes.subarray(2, 6),
    );
    const suffix = await fetch(url, {
      headers: { Cookie: operatorCookie, Range: 'bytes=-3' },
    });
    assert.equal(suffix.status, 206);
    assert.deepEqual(
      Buffer.from(await suffix.arrayBuffer()),
      bytes.subarray(-3),
    );
    const invalid = await fetch(url, {
      headers: { Cookie: operatorCookie, Range: 'bytes=999-' },
    });
    assert.equal(invalid.status, 416);
    assert.equal(
      invalid.headers.get('content-range'),
      `bytes */${bytes.length}`,
    );
    rmSync(file);
    const missing = await apiRequest(
      'GET',
      `/api/v1/artifacts/${artId}/content`,
      { cookie: operatorCookie },
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'NOT_FOUND');
    const jsonUpload = await apiRequest('POST', '/internal/v1/artifacts', {
      headers: { 'X-Lease-Token': 'invalid' },
      body: { taskId: randomUUID(), file: bytes.toString('base64') },
    });
    assert.equal(jsonUpload.status, 422);
    const missingJob = await apiRequest('POST', '/internal/v1/artifacts', {
      headers: {
        'X-Lease-Token': 'invalid',
        'Content-Type': 'multipart/form-data; boundary=test',
      },
      body: `--test\r\nContent-Disposition: form-data; name="taskId"\r\n\r\n${randomUUID()}\r\n--test\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\nhello\r\n--test--\r\n`,
    });
    assert.equal(missingJob.status, 404);
    recordTest('artifact_range_missing_and_multipart', true);
  } finally {
    rmSync(file, { force: true });
  }
});
