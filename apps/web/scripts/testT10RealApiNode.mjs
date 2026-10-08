/**
 * Real API Node Integration Test Suite for T10 Case Lifecycle, Pagination, Versioning & Auth Boundary
 *
 * Verifies HttpApiClient against real apps/api HTTP backend and PostgreSQL container:
 * 1. Uses actual HttpApiClient source code (apps/web/src/api/client.ts) with VITE_MOCK=false.
 * 2. Self-contained fixture setup: dedicated Docker PostgreSQL container, migrations, vaults, accounts.
 * 3. Synthetic cookie/session forwarder used strictly for fixture transmission of this task's unique accounts.
 * 4. Zero mocked business data: all records, hashes, locks, RBAC, and versions produced by real backend.
 * 5. Covered API operations:
 *    - Case list status filtering (active, archived, all) and cursor pagination.
 *    - Draft version creation, preview, and review approval incrementing head version.
 *    - Explicit version regression run entrance with admission verification & 422 rejection of drafts/archived.
 *    - Archive, restore, and duplicate flows verifying version + 1 and unapproved draft invariants.
 *    - Auth input clean reject & 422 rejection for approve / text on auth_profile / one_time_code.
 *    - RBAC ladder: Viewer read-only restrictions vs Operator write capabilities, cross-project copy rule.
 * 6. Audit & teardown: self-created container, volumes, keys, random ports cleaned up and verified closed.
 *
 * Zero browser execution, zero Playwright, FakeBrowser/model explicitly deferred (Ego paused, P0Passed: false).
 */

import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { HttpApiClient } from '../src/api/client.ts';
import {
  Database,
  migrate,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
} from '../../../packages/storage/dist/index.js';
import {
  createApiContext,
  createApiServer,
} from '../../../apps/api/dist/index.js';

const storageReq = createRequire(
  new URL('../../../packages/storage/package.json', import.meta.url),
);
const pg = storageReq('pg');

// 1. Precondition checks
process.env.VITE_MOCK = 'false';
assert.equal(
  process.env.VITE_MOCK,
  'false',
  'VITE_MOCK must be explicitly false',
);

const clientSourcePath = fileURLToPath(
  new URL('../src/api/client.ts', import.meta.url),
);
const clientSource = readFileSync(clientSourcePath, 'utf8');
const clientSha256 = createHash('sha256').update(clientSource).digest('hex');

const tag = randomUUID().slice(0, 8);
const dir = mkdtempSync(join(tmpdir(), `localqa-t10-real-api-${tag}-`));

const facts = {
  task: 'T10-REAL-API-NODE-INTEGRATION',
  tag,
  clientSha256,
  command: 'node apps/web/scripts/testT10RealApiNode.mjs',
  timestamp: new Date().toISOString(),
  environment: {
    nodeVersion: process.version,
    viteMock: false,
    clientSourcePath,
  },
  ownership: {
    containerId: null,
    containerName: `localqa-t10-realapi-${tag}`,
    volumes: [],
    pgPort: null,
    apiPort: null,
    tmpDir: dir,
  },
  negativeStatuses: {},
  limitations: [
    'Real HTTP API and PostgreSQL container integration only',
    'HttpApiClient over HTTP and isolated PostgreSQL; no browser, DOM, hydration, or actual worker run execution',
    'FakeBrowser/model deferred; external model transport calls strictly forbidden',
    'Zero browser / ReactDOM / hydration / Playwright execution (Ego paused)',
    'P0Passed: false',
  ],
  tests: [],
  cleanup: {
    containerRemoved: false,
    pgPortClosed: false,
    apiPortClosed: false,
    tmpDirRemoved: false,
  },
};

let totalChecks = 0;
let passedChecks = 0;

async function check(name, fn) {
  totalChecks++;
  const startTime = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - startTime;
    passedChecks++;
    facts.tests.push({ name, passed: true, durationMs });
    console.log(`  ✓ [PASS] ${name} (${durationMs}ms)`);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    facts.tests.push({
      name,
      passed: false,
      durationMs,
      code: error.code ?? 'TEST_FAILED',
      status: error.status,
      message: error.message,
    });
    console.error(`  ✗ [FAIL] ${name} (${durationMs}ms): ${error.message}`);
    throw error;
  }
}

async function portClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error('port check timed out'));
    });
  });
}

function sampleCaseDoc(id = 'case-doc-1', name = 'Sample Case') {
  return {
    schemaVersion: 1,
    kind: 'localqa/test',
    id,
    name,
    variables: {},
    criteria: [
      {
        id: 'crit-life',
        kind: 'element_visible',
        description: 'Main visible',
        sourceKind: 'user_spec',
        sourceRef: 'smoke',
        locator: { by: 'css', value: 'body' },
      },
    ],
    steps: [
      { kind: 'navigate', url: 'http://localhost:8080/' },
      { kind: 'assert', criterionId: 'crit-life' },
    ],
  };
}

let db = null;
let context = null;
let server = null;
let client = null;
let pgConnection = null;
let apiPort = null;
let pgPort = null;
let opUser = null;
let viewUser = null;
let projectA = null;
let projectB = null;

let adminCookie = null;
let operatorCookie = null;
let viewerCookie = null;
let activeCookie = null;
let fixtureApiOrigin = null;
let modelTransportCalls = 0;
const ownershipPath = join(dir, 'ownership.json');
function saveOwnership() {
  writeFileSync(
    ownershipPath,
    JSON.stringify(facts.ownership, null, 2) + '\n',
    { mode: 0o600 },
  );
}

// Forwarder interceptor wrapping globalThis.fetch for synthetic session transport
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(
    typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
  );
  if (!fixtureApiOrigin || target.origin !== fixtureApiOrigin)
    throw new Error('ONLY_OWNED_API_ALLOWED');
  const headers = new Headers(options.headers);
  if (activeCookie && !headers.has('Cookie')) {
    headers.set('Cookie', activeCookie);
  }
  const res = await originalFetch(url, { ...options, headers });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    activeCookie = setCookie.split(';')[0];
  }
  return res;
};

async function asUser(cookie, fn) {
  const previous = activeCookie;
  activeCookie = cookie;
  try {
    return await fn();
  } finally {
    activeCookie = previous;
  }
}

async function superuserQuery(sql, params = []) {
  const client = new pg.Client({ connectionString: pgConnection });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

console.log('================================================================');
console.log(' T10 Real API Node Integration: Real Server, DB & HttpApiClient');
console.log('================================================================');
console.log(`Task Tag: ${tag}`);
console.log(`Temp Directory: ${dir}`);
console.log(`Client SHA256: ${clientSha256}\n`);

try {
  // ---------------------------------------------------------------------------
  // Phase 1: PostgreSQL Docker Container Setup & Database Migration
  // ---------------------------------------------------------------------------
  console.log('--- Phase 1: PostgreSQL Container & Migration Setup ---');
  const pgPassword = randomBytes(24).toString('hex');
  const envFile = join(dir, 'pg.env');
  writeFileSync(
    envFile,
    `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${pgPassword}\n`,
    { mode: 0o600 },
  );

  const containerName = facts.ownership.containerName;
  const launch = spawnSync(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      containerName,
      '--publish',
      '127.0.0.1::5432',
      '--env-file',
      envFile,
      'postgres:18-alpine',
      '-c',
      'statement_timeout=3000',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(
    launch.status,
    0,
    `Failed to launch postgres container: ${launch.stderr}`,
  );
  facts.ownership.containerId = launch.stdout.trim();
  assert.match(facts.ownership.containerId, /^[a-f0-9]{64}$/);
  saveOwnership();

  const inspect = spawnSync(
    'docker',
    ['inspect', facts.ownership.containerId],
    { encoding: 'utf8' },
  );
  assert.equal(inspect.status, 0);
  facts.ownership.volumes = JSON.parse(inspect.stdout)[0]
    .Mounts.filter((m) => m.Type === 'volume')
    .map((m) => m.Name);
  saveOwnership();

  const portResult = spawnSync(
    'docker',
    ['port', facts.ownership.containerId, '5432/tcp'],
    { encoding: 'utf8' },
  );
  assert.equal(portResult.status, 0);
  pgPort = Number(portResult.stdout.trim().split(':').at(-1));
  assert.ok(pgPort > 0, `Invalid port: ${pgPort}`);
  facts.ownership.pgPort = pgPort;
  pgConnection = `postgres://localqa:${pgPassword}@127.0.0.1:${pgPort}/localqa`;

  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      await migrate(
        pgConnection,
        new URL('../../../packages/storage/migrations/', import.meta.url),
      );
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, 'PostgreSQL migrations must complete successfully');
  console.log(
    `  ✓ PostgreSQL running on port ${pgPort} and migrations applied.`,
  );

  // ---------------------------------------------------------------------------
  // Phase 2: User Accounts, Projects, Vault & Real API Server Initialization
  // ---------------------------------------------------------------------------
  console.log(
    '\n--- Phase 2: Accounts, Projects & Real API Server Initialization ---',
  );
  const kekFile = join(dir, 'kek.json');
  writeFileSync(
    kekFile,
    JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    }),
    { mode: 0o600 },
  );
  const vault = await SecretVault.fromProtectedFile(kekFile);
  db = new Database(pgConnection);

  const accounts = new AccountsRepository(db);
  const adminUser = await accounts.bootstrap({
    email: `owner-${tag}@localqa.test`,
    displayName: 'Owner User',
    password: 'OwnerPassword123!',
  });
  const adminActor = { userId: adminUser.id };

  opUser = await accounts.create(adminActor, {
    email: `operator-${tag}@localqa.test`,
    displayName: 'Operator User',
    password: 'OperatorPassword123!',
    globalRole: 'member',
  });

  viewUser = await accounts.create(adminActor, {
    email: `viewer-${tag}@localqa.test`,
    displayName: 'Viewer User',
    password: 'ViewerPassword123!',
    globalRole: 'member',
  });

  const projects = new ProjectRepository(db);
  projectA = await projects.create(adminActor, { name: `Project A ${tag}` });
  projectB = await projects.create(adminActor, { name: `Project B ${tag}` });

  // Membership setup:
  // Project A: adminUser (owner), opUser (operator), viewUser (viewer)
  // Project B: adminUser (owner), opUser (operator), viewUser (no initial membership)
  await db.actor(adminActor, async (c) => {
    await c.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'operator')",
      [projectA.id, opUser.id],
    );
    await c.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'viewer')",
      [projectA.id, viewUser.id],
    );
    await c.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'operator')",
      [projectB.id, opUser.id],
    );
  });

  const model = await new ModelRepository(db, vault).create(adminActor, {
    name: 'Never called model',
    endpoint: 'https://unused.example.test/v1',
    configuredModelId: 'unused-model',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
  });
  projectA = await projects.update(adminActor, projectA.id, {
    expectedVersion: projectA.version,
    defaultModelProfileId: model.id,
  });
  projectB = await projects.update(adminActor, projectB.id, {
    expectedVersion: projectB.version,
    defaultModelProfileId: model.id,
  });

  context = createApiContext({
    connectionString: pgConnection,
    vault,
    serviceActor: adminActor,
    artifactsDir: join(dir, 'artifacts'),
    publicOrigin: 'http://127.0.0.1',
    modelTransport: async () => {
      modelTransportCalls++;
      throw new Error('External model calls forbidden in admission tests');
    },
  });

  server = createApiServer(context);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiPort = server.address().port;
  assert.ok(apiPort > 0);
  facts.ownership.apiPort = apiPort;

  const apiUrl = `http://127.0.0.1:${apiPort}/api/v1`;
  fixtureApiOrigin = new URL(apiUrl).origin;
  saveOwnership();
  client = new HttpApiClient(apiUrl);
  console.log(`  ✓ Real API server listening at ${apiUrl}`);

  // Login each user via HttpApiClient to acquire authentic server-issued session cookies
  activeCookie = null;
  await client.login({ email: adminUser.email, password: 'OwnerPassword123!' });
  adminCookie = activeCookie;
  assert.ok(
    adminCookie && adminCookie.startsWith('session='),
    'Admin session cookie acquired',
  );

  activeCookie = null;
  await client.login({ email: opUser.email, password: 'OperatorPassword123!' });
  operatorCookie = activeCookie;
  assert.ok(
    operatorCookie && operatorCookie.startsWith('session='),
    'Operator session cookie acquired',
  );

  activeCookie = null;
  await client.login({ email: viewUser.email, password: 'ViewerPassword123!' });
  viewerCookie = activeCookie;
  assert.ok(
    viewerCookie && viewerCookie.startsWith('session='),
    'Viewer session cookie acquired',
  );

  console.log(
    '  ✓ Synthetic session tokens mapped to authentic server-issued credentials.',
  );

  // ---------------------------------------------------------------------------
  // Phase 3: Test Suites via HttpApiClient
  // ---------------------------------------------------------------------------
  console.log('\n--- Phase 3: Executing Test Suites against Real API ---');

  let lifecycleCaseId = null;
  let version1Id = null;
  let version2Id = null;

  // --- Suite 1: Saved Case Draft Creation & Version Approval Lifecycle ---
  await check(
    'HttpApiClient.createSavedCase creates active case with initial draft v1 and null approved version',
    async () => {
      await asUser(operatorCookie, async () => {
        const doc = sampleCaseDoc(`doc-${tag}-1`, 'Primary Lifecycle Case');
        const created = await client.createSavedCase(projectA.id, {
          slug: `slug-life-${tag}`,
          name: 'Primary Lifecycle Case',
          document: doc,
        });

        assert.equal(created.projectId, projectA.id);
        assert.equal(created.slug, `slug-life-${tag}`);
        assert.equal(created.status, 'active');
        assert.equal(created.version, 1);
        assert.equal(
          created.currentApprovedVersionId,
          null,
          'Must start without approved version',
        );

        lifecycleCaseId = created.id;

        const versions = await client.listSavedCaseVersions(lifecycleCaseId);
        assert.equal(versions.items.length, 1);
        assert.equal(versions.items[0].version, 1);
        assert.equal(versions.items[0].reviewStatus, 'draft');
        version1Id = versions.items[0].id;
      });
    },
  );

  await check(
    'HttpApiClient.createSavedCaseVersion creates draft v2 and increments head version',
    async () => {
      await asUser(operatorCookie, async () => {
        const updatedDoc = sampleCaseDoc(
          `doc-${tag}-2`,
          'Updated Lifecycle Case Steps',
        );
        updatedDoc.steps.push({
          kind: 'navigate',
          url: 'http://localhost:8080/checkout',
        });

        const newVer = await client.createSavedCaseVersion(lifecycleCaseId, {
          expectedVersion: 1,
          document: updatedDoc,
        });

        assert.equal(newVer.caseId, lifecycleCaseId);
        assert.equal(newVer.version, 2);
        assert.equal(newVer.reviewStatus, 'draft');
        version2Id = newVer.id;
      });
    },
  );

  await check(
    'HttpApiClient preview & commit review approves v2 and increments case head version to 3',
    async () => {
      // 1. Operator lacks owner permission to review/approve -> 403
      await asUser(operatorCookie, async () => {
        try {
          await client.previewSavedCaseReview(version2Id, {
            expectedVersion: 2,
            decision: 'approve',
            reason: 'Operator unauthorized attempt',
          });
          assert.fail('Operator should not be allowed to preview review');
        } catch (err) {
          facts.negativeStatuses.operator_review_preview = err.status;
          assert.equal(
            err.status,
            403,
            'Operator preview review must be 403 Forbidden',
          );
        }
      });

      // 2. Project Owner performs preview and commit review -> 200 OK
      await asUser(adminCookie, async () => {
        const reviewReason = 'Approved v2 for production regression';
        const preview = await client.previewSavedCaseReview(version2Id, {
          expectedVersion: 2,
          decision: 'approve',
          reason: reviewReason,
        });

        assert.ok(preview.confirmationToken, 'Must generate confirmationToken');
        assert.equal(preview.versionId, version2Id);

        // Negative: Mismatched reason/decision rejected with 422
        try {
          await client.commitSavedCaseReview(version2Id, {
            expectedVersion: 2,
            decision: 'approve',
            reason: 'Tampered different reason',
            confirmationToken: preview.confirmationToken,
          });
          assert.fail('Should reject mismatched review reason with 422');
        } catch (err) {
          facts.negativeStatuses.review_tampered_reason = err.status;
          assert.equal(err.status, 422, 'Mismatched reason must return 422');
        }

        const committed = await client.commitSavedCaseReview(version2Id, {
          expectedVersion: 2,
          decision: 'approve',
          reason: reviewReason,
          confirmationToken: preview.confirmationToken,
        });

        assert.equal(committed.id, version2Id);
        assert.equal(committed.reviewStatus, 'approved');

        // Check case head version
        const casesPage = await client.listSavedCases(projectA.id, {
          status: 'active',
        });
        const currentCase = casesPage.items.find(
          (c) => c.id === lifecycleCaseId,
        );
        assert.ok(currentCase);
        assert.equal(
          currentCase.version,
          3,
          'Approval must increment head version to 3',
        );
        assert.equal(
          currentCase.currentApprovedVersionId,
          version2Id,
          'currentApprovedVersionId must point to v2',
        );

        // Negative: Replay token rejected with 409
        try {
          await client.commitSavedCaseReview(version2Id, {
            expectedVersion: 2,
            decision: 'approve',
            reason: 'Duplicate replay attempt',
            confirmationToken: preview.confirmationToken,
          });
          assert.fail('Should reject consumed confirmationToken');
        } catch (err) {
          facts.negativeStatuses.replay_review_token = err.status;
          assert.equal(
            err.status,
            409,
            'Must return 409 Conflict on reused token',
          );
        }
      });
    },
  );

  // --- Suite 2: Saved Case Listing & Limit/Cursor Pagination ---
  let caseA2Id = null;
  let caseA3Id = null;

  await check(
    'HttpApiClient.listSavedCases filters by active, archived and all',
    async () => {
      await asUser(operatorCookie, async () => {
        // Create two more cases in project A
        const c2 = await client.createSavedCase(projectA.id, {
          slug: `slug-p2-${tag}`,
          name: 'Project A Case 2',
          document: sampleCaseDoc('c2-doc', 'Case 2'),
        });
        caseA2Id = c2.id;

        const c3 = await client.createSavedCase(projectA.id, {
          slug: `slug-p3-${tag}`,
          name: 'Project A Case 3',
          document: sampleCaseDoc('c3-doc', 'Case 3'),
        });
        caseA3Id = c3.id;

        // Archive caseA3
        await client.archiveSavedCase(caseA3Id, { expectedVersion: 1 });

        // Default / active: must include lifecycleCaseId and caseA2Id, exclude caseA3Id
        const activeList = await client.listSavedCases(projectA.id, {
          status: 'active',
        });
        const activeIds = activeList.items.map((c) => c.id);
        assert.ok(activeIds.includes(lifecycleCaseId));
        assert.ok(activeIds.includes(caseA2Id));
        assert.ok(
          !activeIds.includes(caseA3Id),
          'Archived case must not appear in active list',
        );

        // Archived list: must only contain caseA3Id
        const archivedList = await client.listSavedCases(projectA.id, {
          status: 'archived',
        });
        const archivedIds = archivedList.items.map((c) => c.id);
        assert.ok(archivedIds.includes(caseA3Id));
        assert.ok(!archivedIds.includes(lifecycleCaseId));

        // All list: must contain all three cases
        const allList = await client.listSavedCases(projectA.id, {
          status: 'all',
        });
        const allIds = allList.items.map((c) => c.id);
        assert.ok(allIds.includes(lifecycleCaseId));
        assert.ok(allIds.includes(caseA2Id));
        assert.ok(allIds.includes(caseA3Id));

        // Negative: invalid status query param rejected with 422
        try {
          await client.listSavedCases(projectA.id, {
            status: 'invalid_status',
          });
          assert.fail('Invalid status should throw');
        } catch (err) {
          facts.negativeStatuses.list_invalid_status = err.status;
          assert.equal(err.status, 422, 'Invalid status must return 422');
        }
      });
    },
  );

  await check(
    'HttpApiClient.listSavedCases pagination honors limit and non-overlapping cursor traversal',
    async () => {
      await asUser(operatorCookie, async () => {
        const page1 = await client.listSavedCases(projectA.id, {
          status: 'all',
          limit: 2,
        });
        assert.equal(page1.items.length, 2);
        assert.ok(page1.nextCursor, 'page 1 must have nextCursor');

        const page2 = await client.listSavedCases(projectA.id, {
          status: 'all',
          limit: 2,
          cursor: page1.nextCursor,
        });
        assert.ok(page2.items.length >= 1);

        // Verify no duplicate IDs across pages
        const page1Ids = new Set(page1.items.map((i) => i.id));
        for (const item of page2.items) {
          assert.ok(
            !page1Ids.has(item.id),
            `Duplicate ID across pages: ${item.id}`,
          );
        }
      });
    },
  );

  // --- Suite 3: Explicit Version Regression Run Entrance ---
  await check(
    'HttpApiClient.createRegressionRun accepts approved version and creates queued/pending run',
    async () => {
      await asUser(operatorCookie, async () => {
        const run = await client.createRegressionRun({
          projectId: projectA.id,
          caseVersionIds: [version2Id],
        });

        assert.ok(run.id);
        assert.equal(run.projectId, projectA.id);
        assert.ok(
          ['queued', 'pending'].includes(run.status),
          `Run status must be queued or pending, got ${run.status}`,
        );
      });
    },
  );

  await check(
    'HttpApiClient.createRegressionRun rejects unapproved draft with 422',
    async () => {
      await asUser(operatorCookie, async () => {
        try {
          await client.createRegressionRun({
            projectId: projectA.id,
            caseVersionIds: [version1Id], // version1 was superseded and remains draft
          });
          assert.fail('Should reject unapproved draft version');
        } catch (err) {
          facts.negativeStatuses.regression_run_unapproved_draft = err.status;
          assert.equal(
            err.status,
            422,
            'Must reject unapproved draft with 422',
          );
        }
      });
    },
  );

  await check(
    'HttpApiClient.createRegressionRun rejects archived case with 422',
    async () => {
      await asUser(operatorCookie, async () => {
        // Archive lifecycleCaseId (expectedVersion 3 -> becomes 4)
        await client.archiveSavedCase(lifecycleCaseId, { expectedVersion: 3 });

        try {
          await client.createRegressionRun({
            projectId: projectA.id,
            caseVersionIds: [version2Id],
          });
          assert.fail('Should reject archived case in regression run');
        } catch (err) {
          facts.negativeStatuses.regression_run_archived_case = err.status;
          assert.equal(
            err.status,
            422,
            'Archived case must be rejected with 422',
          );
        }

        // Restore lifecycleCaseId for subsequent tests (expectedVersion 4 -> becomes 5)
        await client.restoreSavedCase(lifecycleCaseId, { expectedVersion: 4 });
      });
    },
  );

  // --- Suite 4: Archive, Restore & Duplication Invariants ---
  await check(
    'HttpApiClient.archiveSavedCase and restoreSavedCase enforce strict version increments',
    async () => {
      await asUser(operatorCookie, async () => {
        // Current head version is 5. Archive with expectedVersion 5 -> becomes 6
        const archived = await client.archiveSavedCase(lifecycleCaseId, {
          expectedVersion: 5,
        });
        assert.equal(archived.id, lifecycleCaseId);
        assert.equal(archived.status, 'archived');
        assert.equal(archived.version, 6);
        assert.equal(
          archived.currentApprovedVersionId,
          version2Id,
          'Baseline strictly preserved',
        );

        // Negative: stale expectedVersion archive returns 409
        try {
          await client.archiveSavedCase(lifecycleCaseId, {
            expectedVersion: 5,
          });
          assert.fail('Stale version archive should throw');
        } catch (err) {
          facts.negativeStatuses.archive_stale_version = err.status;
          assert.equal(err.status, 409);
        }

        // Restore with expectedVersion 6 -> becomes 7
        const restored = await client.restoreSavedCase(lifecycleCaseId, {
          expectedVersion: 6,
        });
        assert.equal(restored.id, lifecycleCaseId);
        assert.equal(restored.status, 'active');
        assert.equal(restored.version, 7);
        assert.equal(
          restored.currentApprovedVersionId,
          version2Id,
          'Baseline strictly preserved',
        );

        // Negative: repeated restore on active case returns 409
        try {
          await client.restoreSavedCase(lifecycleCaseId, {
            expectedVersion: 7,
          });
          assert.fail('Repeated restore should throw 409');
        } catch (err) {
          facts.negativeStatuses.restore_stale_version = err.status;
          assert.equal(err.status, 409);
        }
      });
    },
  );

  let duplicatedCaseId = null;
  await check(
    'HttpApiClient.duplicateSavedCase creates unapproved draft v1 with distinct UUID in same project',
    async () => {
      await asUser(operatorCookie, async () => {
        const dup = await client.duplicateSavedCase(lifecycleCaseId, {
          newSlug: `slug-dup-same-${tag}`,
          newName: 'Duplicated In Same Project',
          sourceVersionId: version2Id,
        });

        assert.notEqual(
          dup.id,
          lifecycleCaseId,
          'Must have distinct canonical UUID',
        );
        assert.equal(dup.projectId, projectA.id);
        assert.equal(dup.slug, `slug-dup-same-${tag}`);
        assert.equal(dup.status, 'active');
        assert.equal(
          dup.version,
          1,
          'Duplicated case initial version must be 1',
        );
        assert.equal(
          dup.currentApprovedVersionId,
          null,
          'Must start in unapproved draft status',
        );

        duplicatedCaseId = dup.id;

        const dupVersions =
          await client.listSavedCaseVersions(duplicatedCaseId);
        assert.equal(dupVersions.items.length, 1);
        assert.equal(dupVersions.items[0].version, 1);
        assert.equal(dupVersions.items[0].reviewStatus, 'draft');
      });
    },
  );

  await check(
    'HttpApiClient.duplicateSavedCase copies cross-project to target project',
    async () => {
      await asUser(operatorCookie, async () => {
        const dupB = await client.duplicateSavedCase(lifecycleCaseId, {
          targetProjectId: projectB.id,
          newSlug: `slug-dup-projb-${tag}`,
          newName: 'Duplicated to Project B',
          sourceVersionId: version2Id,
        });

        assert.equal(dupB.projectId, projectB.id);
        assert.equal(dupB.status, 'active');
        assert.equal(dupB.version, 1);
        assert.equal(dupB.currentApprovedVersionId, null);

        const bCases = await client.listSavedCases(projectB.id);
        assert.ok(bCases.items.some((c) => c.id === dupB.id));
      });
    },
  );

  // --- Suite 5: Auth Input Clean Reject & Error 422 Boundary Enforcement ---
  let authRunId = null;
  let authInputId = null;
  let otpInputId = null;

  await check(
    'HttpApiClient.respondToInput rejects approve and text on auth_profile with 422, accepts clean reject',
    async () => {
      await asUser(operatorCookie, async () => {
        // 1. Create a run in Project A
        const run = await client.createRun({
          projectId: projectA.id,
          targetUrl: 'http://localhost:8080/test-auth',
        });
        authRunId = run.id;

        // 2. Insert auth_profile input request into database
        authInputId = randomUUID();
        const authInputDoc = {
          id: authInputId,
          runId: authRunId,
          version: 1,
          kind: 'auth_profile',
          status: 'pending',
          prompt: 'User credentials required',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        };

        await superuserQuery(
          'INSERT INTO input_requests(id, project_id, run_id, version, document) VALUES($1, $2, $3, 1, $4)',
          [authInputId, projectA.id, authRunId, authInputDoc],
        );

        // Negative 1: decision 'approve' on auth_profile throws 422
        try {
          await client.respondToInput(authRunId, authInputId, {
            expectedVersion: 1,
            decision: 'approve',
          });
          assert.fail('Should reject approve on auth_profile');
        } catch (err) {
          facts.negativeStatuses.auth_profile_approve_forbidden = err.status;
          assert.equal(err.status, 422, 'Must return 422 on approve');
        }

        // Negative 2: decision 'reject' with text payload throws 422
        try {
          await client.respondToInput(authRunId, authInputId, {
            expectedVersion: 1,
            decision: 'reject',
            text: 'illegal-plaintext-leak',
          });
          assert.fail('Should reject text on auth_profile reject');
        } catch (err) {
          facts.negativeStatuses.auth_profile_reject_with_text_forbidden =
            err.status;
          assert.equal(err.status, 422, 'Must return 422 on reject with text');
        }

        // Negative 3: version conflict throws 409
        try {
          await client.respondToInput(authRunId, authInputId, {
            expectedVersion: 999,
            decision: 'reject',
          });
          assert.fail('Should throw on version conflict');
        } catch (err) {
          facts.negativeStatuses.input_respond_version_conflict = err.status;
          assert.equal(err.status, 409, 'Must return 409 on version conflict');
        }

        // Positive: clean reject with no text succeeds and returns status 'rejected' with version incremented
        const resolved = await client.respondToInput(authRunId, authInputId, {
          expectedVersion: 1,
          decision: 'reject',
        });

        assert.equal(resolved.id, authInputId);
        assert.equal(resolved.status, 'rejected');
        assert.equal(resolved.version, 2, 'Version must increment to 2');
      });
    },
  );

  await check(
    'HttpApiClient.respondToInput rejects approve and text on one_time_code with 422, accepts clean reject',
    async () => {
      await asUser(operatorCookie, async () => {
        otpInputId = randomUUID();
        const otpInputDoc = {
          id: otpInputId,
          runId: authRunId,
          version: 1,
          kind: 'one_time_code',
          status: 'pending',
          prompt: 'OTP SMS code required',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        };

        await superuserQuery(
          'INSERT INTO input_requests(id, project_id, run_id, version, document) VALUES($1, $2, $3, 1, $4)',
          [otpInputId, projectA.id, authRunId, otpInputDoc],
        );

        // Negative: approve throws 422
        try {
          await client.respondToInput(authRunId, otpInputId, {
            expectedVersion: 1,
            decision: 'approve',
          });
          assert.fail('Should reject approve on one_time_code');
        } catch (err) {
          facts.negativeStatuses.one_time_code_approve_forbidden = err.status;
          assert.equal(err.status, 422);
        }

        // Negative: text on reject throws 422
        try {
          await client.respondToInput(authRunId, otpInputId, {
            expectedVersion: 1,
            decision: 'reject',
            text: '123456',
          });
          assert.fail('Should reject text on one_time_code');
        } catch (err) {
          facts.negativeStatuses.one_time_code_reject_with_text_forbidden =
            err.status;
          assert.equal(err.status, 422);
        }

        // Positive: clean reject succeeds
        const resolved = await client.respondToInput(authRunId, otpInputId, {
          expectedVersion: 1,
          decision: 'reject',
        });

        assert.equal(resolved.id, otpInputId);
        assert.equal(resolved.status, 'rejected');
        assert.equal(resolved.version, 2);
      });
    },
  );

  // --- Suite 6: Operator vs Viewer RBAC Boundaries ---
  await check(
    'Viewer has read-only access in Project A: list allowed, create/archive/restore forbidden with 403',
    async () => {
      await asUser(viewerCookie, async () => {
        // 1. Viewer can list cases
        const list = await client.listSavedCases(projectA.id);
        assert.ok(
          list.items.length >= 1,
          'Viewer must be able to list saved cases',
        );

        // 2. Viewer cannot create saved case
        try {
          await client.createSavedCase(projectA.id, {
            slug: `slug-viewer-illegal-${tag}`,
            name: 'Viewer Illegal Case',
            document: sampleCaseDoc('v-doc', 'Viewer Case'),
          });
          assert.fail('Viewer should not create case');
        } catch (err) {
          facts.negativeStatuses.viewer_create_case = err.status;
          assert.equal(err.status, 403, 'Viewer create must be 403');
        }

        // 3. Viewer cannot archive
        try {
          await client.archiveSavedCase(lifecycleCaseId, {
            expectedVersion: 7,
          });
          assert.fail('Viewer should not archive case');
        } catch (err) {
          facts.negativeStatuses.viewer_archive_case = err.status;
          assert.equal(err.status, 403, 'Viewer archive must be 403');
        }

        // 4. Viewer cannot restore
        try {
          await client.restoreSavedCase(caseA3Id, { expectedVersion: 2 });
          assert.fail('Viewer should not restore case');
        } catch (err) {
          facts.negativeStatuses.viewer_restore_case = err.status;
          assert.equal(err.status, 403, 'Viewer restore must be 403');
        }
      });
    },
  );

  await check(
    'Viewer in source Project A can duplicate to target Project B if user has operator role in target B',
    async () => {
      // Elevate viewUser in Project B only (Source A: viewer; Target B: operator)
      await superuserQuery(
        "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'operator') ON CONFLICT DO NOTHING",
        [projectB.id, viewUser.id],
      );

      await asUser(viewerCookie, async () => {
        // Cross-project duplicate: Source A (viewer) -> Target B (operator) must SUCCEED with 201!
        const crossDup = await client.duplicateSavedCase(lifecycleCaseId, {
          targetProjectId: projectB.id,
          newSlug: `slug-cross-from-viewer-${tag}`,
          newName: 'Cross Project Copy Allowed',
          sourceVersionId: version2Id,
        });

        assert.equal(crossDup.projectId, projectB.id);
        assert.equal(crossDup.status, 'active');
        assert.equal(crossDup.version, 1);
        assert.equal(crossDup.currentApprovedVersionId, null);

        // Same-project duplicate in Project A (where user is only viewer) must FAIL with 403!
        try {
          await client.duplicateSavedCase(lifecycleCaseId, {
            targetProjectId: projectA.id,
            newSlug: `slug-illegal-viewer-dup-${tag}`,
            newName: 'Illegal Viewer Duplication',
            sourceVersionId: version2Id,
          });
          assert.fail('Viewer cannot duplicate into viewer-only project');
        } catch (err) {
          facts.negativeStatuses.viewer_duplicate_in_same_viewer_project =
            err.status;
          assert.equal(
            err.status,
            403,
            'Target viewer must be rejected with 403',
          );
        }
      });
    },
  );

  await check(
    'HttpApiClient.respondToInput ordinary clarification provide resolves through the actual API',
    async () => {
      await asUser(operatorCookie, async () => {
        const run = await client.createRun({
          projectId: projectA.id,
          targetUrl: 'http://localhost:8080/',
        });
        const input = {
          id: randomUUID(),
          runId: run.id,
          kind: 'clarification',
          status: 'pending',
          prompt: 'Owned clarification fixture',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          version: 1,
        };
        await superuserQuery(
          'INSERT INTO input_requests(id,project_id,run_id,version,document) VALUES($1,$2,$3,1,$4)',
          [input.id, projectA.id, run.id, input],
        );
        try {
          const result = await client.respondToInput(run.id, input.id, {
            expectedVersion: 1,
            decision: 'provide',
            text: 'Owned non-sensitive clarification',
          });
          assert.equal(result.status, 'resolved');
          assert.equal(result.version, 2);
        } catch (error) {
          facts.negativeStatuses.clarification_provide = error.status ?? null;
          throw error;
        }
      });
    },
  );

  await check(
    'HttpApiClient.respondToInput concurrent provide on same input version yields one 200 and one 409 with zero double-writes',
    async () => {
      await asUser(operatorCookie, async () => {
        const run = await client.createRun({
          projectId: projectA.id,
          targetUrl: 'http://localhost:8080/',
        });
        const input = {
          id: randomUUID(),
          runId: run.id,
          kind: 'clarification',
          status: 'pending',
          prompt: 'Owned concurrent clarification fixture',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          version: 1,
        };
        await superuserQuery(
          'INSERT INTO input_requests(id, project_id, run_id, version, document) VALUES($1, $2, $3, 1, $4)',
          [input.id, projectA.id, run.id, input],
        );

        const [res1, res2] = await Promise.allSettled([
          client.respondToInput(run.id, input.id, {
            expectedVersion: 1,
            decision: 'provide',
            text: 'Concurrent answer 1',
          }),
          client.respondToInput(run.id, input.id, {
            expectedVersion: 1,
            decision: 'provide',
            text: 'Concurrent answer 2',
          }),
        ]);

        const statuses = [
          res1.status === 'fulfilled' ? 200 : res1.reason.status,
          res2.status === 'fulfilled' ? 200 : res2.reason.status,
        ].sort();

        assert.deepEqual(
          statuses,
          [200, 409],
          'Concurrent calls on same expectedVersion must yield one 200 and one 409',
        );

        // Verify database state: exactly one write, version incremented from 1 to 2
        const row = (
          await superuserQuery(
            'SELECT version, document FROM input_requests WHERE id = $1',
            [input.id],
          )
        ).rows[0];
        assert.equal(row.version, 2, 'Version must be 2, no double-write');
        assert.equal(row.document.status, 'resolved');
      });
    },
  );
} finally {
  const cleanupErrors = [];
  try {
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      facts.cleanup.apiPortClosed = await portClosed(apiPort);
    }
    if (context?.db) await context.db.close();
    if (db) await db.close();
  } catch (error) {
    cleanupErrors.push(error.code ?? 'SERVICE_CLEANUP_FAILED');
  }
  if (facts.ownership.containerId) {
    const removed = spawnSync(
      'docker',
      ['rm', '--force', '--volumes', facts.ownership.containerId],
      { encoding: 'utf8' },
    );
    const checked = spawnSync(
      'docker',
      ['container', 'inspect', facts.ownership.containerId],
      { encoding: 'utf8' },
    );
    facts.cleanup.containerRemoved = removed.status === 0;
    facts.cleanup.containerAbsent =
      checked.status !== 0 && /no such container/i.test(checked.stderr);
    facts.cleanup.volumes = facts.ownership.volumes.map((id) => {
      const v = spawnSync('docker', ['volume', 'inspect', id], {
        encoding: 'utf8',
      });
      return { id, absent: v.status !== 0 && /no such volume/i.test(v.stderr) };
    });
    if (pgPort) facts.cleanup.pgPortClosed = await portClosed(pgPort);
  }
  rmSync(join(dir, 'pg.env'), { force: true });
  rmSync(join(dir, 'kek.json'), { force: true });
  facts.cleanup.credentialsAbsent =
    !existsSync(join(dir, 'pg.env')) && !existsSync(join(dir, 'kek.json'));
  // Keep the ownership ledger and any reproduction artifacts; credentials are gone.
  facts.cleanup.tmpDirRetained = true;
  facts.cleanup.retainedReason =
    'Ownership ledger and reproduction artifacts retained; no credentials';
  facts.cleanup.modelTransportCalls = modelTransportCalls;
  facts.cleanup.errors = cleanupErrors;
  saveOwnership();
  globalThis.fetch = originalFetch;
  facts.summary = {
    totalChecks,
    passedChecks,
    allPassed: totalChecks > 0 && passedChecks === totalChecks,
  };
  facts.browserPaused = true;
  facts.P0Passed = false;
  const reportPath = fileURLToPath(
    new URL(
      `../../../docs/validation-results/T10-real-api-node-${tag}.json`,
      import.meta.url,
    ),
  );
  writeFileSync(reportPath, JSON.stringify(facts, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    new URL(
      '../../../docs/validation-results/T10-real-api-node-latest.json',
      import.meta.url,
    ),
    JSON.stringify({ report: reportPath, tag, timestamp: facts.timestamp }) +
      '\n',
  );
  console.log(`Evidence saved to: ${reportPath}`);
  assert.equal(cleanupErrors.length, 0);
  assert.equal(modelTransportCalls, 0);
  assert.equal(facts.cleanup.credentialsAbsent, true);
  if (server) assert.equal(facts.cleanup.apiPortClosed, true);
  if (facts.ownership.containerId) {
    assert.equal(facts.cleanup.containerRemoved, true);
    assert.equal(facts.cleanup.containerAbsent, true);
    assert.ok(facts.cleanup.volumes.every((v) => v.absent));
    assert.equal(facts.cleanup.pgPortClosed, true);
  }
}

console.log(
  '\n================================================================',
);
console.log(
  ` Summary: ${passedChecks}/${totalChecks} real API integration checks PASSED`,
);
console.log('================================================================');
console.log(
  JSON.stringify(
    {
      totalChecks,
      passedChecks,
      negativeStatuses: facts.negativeStatuses,
      cleanup: facts.cleanup,
      browserPaused: facts.browserPaused,
      P0Passed: facts.P0Passed,
    },
    null,
    2,
  ),
);

if (passedChecks !== totalChecks || totalChecks === 0) {
  process.exitCode = 1;
}
