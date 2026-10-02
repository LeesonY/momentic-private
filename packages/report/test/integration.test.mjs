import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from '../../../packages/storage/node_modules/pg/lib/index.js';
import { validateContract, parseContract } from '@localqa/contracts';
import {
  Database,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
  migrate,
  hashPayload,
} from '@localqa/storage';
import { Coordinator, RuntimeClient } from '@localqa/orchestrator';
import { DEFAULT_LIMITS, smokeCase, criteriaHash } from '@localqa/domain';
import { createStubAdapter } from '@localqa/model-gateway';
import { BrowserManager } from '@localqa/browser';
import { Worker } from '../../../apps/worker/dist/index.js';
import {
  LocalVolumeArtifactStore,
  ReportBuilder,
  ExportService,
  GarbageCollector,
  verifyUnpackedZip,
  assessReplayDegradation,
  unpackZip,
} from '../dist/index.js';

const root = '/work';
const evidence = `${root}/packages/report/.evidence`;
const artifactsRoot = `${root}/packages/report/.artifacts`;
const fixtureUrl = 'http://localhost:8080';

const env = Object.fromEntries(
  (await readFile(`${evidence}/postgres.env`, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => line.split('=')),
);

const connection = `postgresql://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@${env.PGHOST}:5432/${env.POSTGRES_DB}`;
const pool = new pg.Pool({ connectionString: connection });
const db = new Database(connection);

let fixture;
let vault;
let admin;
let model;
let coordinator;
let manager;
let artifactStore;
let exportService;
let reportBuilder;
let gc;

const facts = {
  task: 'T08',
  node: process.version,
  uid: process.getuid(),
  browser: 'Chromium via T03 sandbox-enabled BrowserManager',
  tests: [],
  verticalSliceReport: null,
  exportZipVerification: null,
  gcVerification: null,
  summaryVerification: null,
};

const act = () => ({ userId: admin.id });
const stub = createStubAdapter();

const modelOptions = {
  adapter: stub,
  async profile(id, version) {
    return {
      id,
      version,
      name: 'T08 test stub',
      endpoint: 'https://stub.example.test/v1',
      configuredModelId: 'stub-normal',
      kind: 'stub',
      dataBoundary: 'internal',
      capabilities: {
        structuredOutput: true,
        nativeTools: true,
        imageInput: true,
      },
      encryptedApiKey: null,
      approvedFallbackIds: [],
    };
  },
  decryptKey() {
    throw new Error('No global key provided to test stub');
  },
  allowTestStub: true,
};

function config(budget = {}) {
  return {
    allowedOrigins: [fixtureUrl],
    actionPolicy: 'non_submitting',
    budget: { ...DEFAULT_LIMITS, ...budget },
    environmentVersion: null,
    authProfileVersion: null,
    knowledgeVersionIds: [],
    models: Object.fromEntries(
      ['coordinator', 'explorer', 'executor', 'assertion', 'reproducer'].map(
        (role) => [role, { profileId: model.id, version: 1 }],
      ),
    ),
  };
}

async function trustedRun(path = '/', count = 1, budget = {}) {
  const project = await new ProjectRepository(db).create(act(), {
    name: `T08 trusted ${randomUUID().slice(0, 8)}`,
  });
  await new ModelRepository(db, vault).grant(act(), project.id, model.id);
  const runId = randomUUID();
  const brief = 'Fixed fixture oracle: visible main and welcome heading';
  const cases = Array.from({ length: count }, (_, index) => {
    const c = smokeCase(
      { id: runId, projectId: project.id },
      `${fixtureUrl}${path}`,
      index,
    );
    c.title = index === 0 ? 'Expected main' : 'Expected welcome heading';
    c.criteria = [
      {
        id: 'smoke.visible',
        kind: 'element_visible',
        description: c.title,
        sourceKind: 'user_spec',
        sourceRef: `brief:${hashPayload(brief)}`,
        locator:
          index === 0
            ? { by: 'role', value: 'main' }
            : { by: 'test_id', value: 'welcome-heading' },
      },
    ];
    return c;
  });
  const run = await coordinator.start(
    act(),
    { projectId: project.id, targetUrl: `${fixtureUrl}${path}`, brief },
    config(budget),
    randomUUID(),
    cases,
  );
  return { project, run, cases };
}

function client(projectId, workerId = 't08-worker') {
  return new RuntimeClient(
    coordinator,
    { projectId, workerId },
    artifactStore,
    modelOptions,
  );
}

function createWorker(runtime) {
  return new Worker({
    runtime,
    browser: manager,
    scratch: `${evidence}/scratch`,
    heartbeatMs: 10000,
    leaseSeconds: 45,
  });
}

before(async () => {
  // 1. Run migrations
  await migrate(
    connection,
    new URL('../../../packages/storage/migrations/', import.meta.url),
  );

  // 2. Setup vault and admin account
  vault = await SecretVault.fromProtectedFile(`${evidence}/kek.json`);
  admin = await new AccountsRepository(db).bootstrap({
    email: 'admin@t08.test',
    displayName: 'T08 coordinator',
    password: 'T08-test-only-admin-password',
  });

  // 3. Create global model
  model = await new ModelRepository(db, vault).create(act(), {
    name: 'T08 fixed stub fixture binding',
    endpoint: 'https://stub.example.test/v1',
    configuredModelId: 'stub-normal',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
  });

  artifactStore = new LocalVolumeArtifactStore(artifactsRoot);
  coordinator = new Coordinator({
    db,
    serviceActor: act(),
    vault,
    platformSlots: 4,
    projectSlots: 4,
    protectedOrigins: ['http://169.254.169.254', 'http://127.0.0.1:5432'],
  });

  manager = new BrowserManager();
  exportService = new ExportService({ artifactStore });
  reportBuilder = new ReportBuilder();
  gc = new GarbageCollector();

  // 4. Start fixture
  fixture = spawn('node', [`${root}/packages/test-fixture/server.js`], {
    cwd: root,
    env: { ...process.env, PORT: '8080' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (let n = 0; n < 80; n++) {
    try {
      const response = await fetch(fixtureUrl);
      if (response.ok) return;
    } catch {
      // waiting for fixture
    }
    await delay(100);
  }
  throw new Error('Fixture not ready');
});

after(async () => {
  if (manager) await manager.close();
  if (fixture) {
    fixture.kill('SIGTERM');
    await new Promise((resolve) => {
      if (fixture.exitCode !== null) resolve();
      else fixture.once('exit', resolve);
    });
  }
  await writeFile(
    `${evidence}/facts.json`,
    JSON.stringify(facts, null, 2) + '\n',
  );
  await pool.end();
  await db.close();
  vault?.dispose();
});

async function finishRun(project, run, runtime = client(project.id), max = 35) {
  const w = createWorker(runtime);
  for (let n = 0; n < max; n++) {
    await runtime.poll();
    const current = (
      await pool.query('SELECT status, phase FROM runs WHERE id=$1', [run.id])
    ).rows[0];
    if (
      current &&
      ['completed', 'cancelled', 'failed'].includes(current.status)
    ) {
      return current;
    }
    await w.once();
  }
  const rows = (
    await pool.query('SELECT role,status,result FROM jobs WHERE run_id=$1', [
      run.id,
    ])
  ).rows;
  throw new Error(`Run did not finish: ${JSON.stringify(rows)}`);
}

async function advanceToCases(project, run) {
  const runtime = client(project.id);
  const w = createWorker(runtime);
  for (let n = 0; n < 8; n++) {
    await runtime.poll();
    const current = (
      await pool.query('SELECT phase FROM runs WHERE id=$1', [run.id])
    ).rows[0];
    if (current?.phase === 'execute') break;
    await w.once();
  }
  return runtime;
}

test('1. Real vertical slice execution -> deterministic report constructed and passes report.schema validation', async () => {
  const { project, run } = await trustedRun('/', 1);
  const runtime = await advanceToCases(project, run);
  await finishRun(project, run, runtime);

  let report;
  await coordinator.tx(async (clientDb) => {
    report = await reportBuilder.build(clientDb, project.id, run.id, {
      artifactStore,
    });
    const jobs = (
      await clientDb.query(
        'SELECT role, status, result, document FROM jobs WHERE run_id = $1',
        [run.id],
      )
    ).rows;
    const events = (
      await clientDb.query(
        'SELECT type, payload FROM run_events WHERE run_id = $1 ORDER BY seq',
        [run.id],
      )
    ).rows;
    const auditRows = (
      await clientDb.query(
        'SELECT action, object_id, result, redacted_summary FROM audit_log WHERE project_id = $1 ORDER BY id',
        [project.id],
      )
    ).rows;
    console.log('DEBUG TEST 1 AUDIT LOG:', JSON.stringify(auditRows));
    console.log('DEBUG TEST 1 EVENTS:', JSON.stringify(events));
    console.log('DEBUG TEST 1 JOBS:', JSON.stringify(jobs));
    console.log(
      'DEBUG TEST 1 REPORT SUMMARY:',
      report.summary,
      'RUN:',
      report.run.status,
      report.run.phase,
      report.run.completion,
      report.run.terminationReason,
    );
  });

  // Contract validation against report.schema.json
  const valid = validateContract('Report', report);
  assert.equal(valid.success, true, JSON.stringify(valid.errors));

  // Verify structure and deterministic summary
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.run.id, run.id);
  assert.equal(report.run.projectId, project.id);
  assert.ok(report.summary.planned >= 1);
  assert.ok(report.summary.attempted >= 1);
  assert.ok(report.summary.evaluated >= 1);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.issueFound, 0);
  assert.equal(report.summary.passRate, 1);
  assert.equal(report.summary.attemptRate, 1);
  assert.equal(report.cleanupStatus, 'manual_required');
  assert.notEqual(report.cleanupStatus, 'succeeded');
  assert.ok(report.warnings.some((warning) => warning.includes('"unknown"')));

  // Verify coverage gaps and artifacts
  assert.ok(report.coverageGaps.length >= 1);
  assert.ok(report.artifacts.length >= 1);
  const screenshotArtifact = report.artifacts.find(
    (a) => a.kind === 'screenshot',
  );
  assert.ok(screenshotArtifact);
  assert.equal(screenshotArtifact.status, 'available');
  assert.ok(screenshotArtifact.bytes > 0);
  assert.ok(
    await artifactStore.exists(project.id, run.id, screenshotArtifact.id),
  );

  facts.verticalSliceReport = {
    runId: run.id,
    summary: report.summary,
    artifactCount: report.artifacts.length,
    coverageGaps: report.coverageGaps,
  };
  facts.tests.push({
    name: 'vertical-slice-report',
    runId: run.id,
    summary: report.summary,
  });
});

test('2. Deterministic summary: tested with real verdict combinations, zero denominators, not_run projection and invalidations', async () => {
  const project = await new ProjectRepository(db).create(act(), {
    name: `T08 Combinations ${randomUUID().slice(0, 8)}`,
  });
  const runId = randomUUID();
  const now = new Date().toISOString();

  await coordinator.tx(async (clientDb) => {
    try {
      // 1. Insert Run in 'running' state so guard_verdict accepts verdicts
      await clientDb.query(
        `INSERT INTO runs(id, project_id, creator_id, display_url, status, phase, completion, effective_config, budget_used, created_at, updated_at)
       VALUES($1, $2, $3, $4, 'running', 'execute', 'none', $5, $6, $7, $7)`,
        [
          runId,
          project.id,
          admin.id,
          'http://localhost:8080',
          config(),
          {
            activeSeconds: 5,
            actions: 1,
            modelCalls: 0,
            reproductions: 0,
            totalTokens: 0,
          },
          now,
        ],
      );

      // Also insert into run_budgets
      await clientDb.query(
        `INSERT INTO run_budgets(project_id, run_id, limits, used)
       VALUES($1, $2, $3, $4)`,
        [
          project.id,
          runId,
          config().budget,
          {
            activeSeconds: 5,
            actions: 1,
            modelCalls: 0,
            reproductions: 0,
            totalTokens: 0,
          },
        ],
      );

      // 2. Create 5 distinct cases
      const cases = Array.from({ length: 5 }, (_, idx) =>
        smokeCase(
          { id: runId, projectId: project.id },
          'http://localhost:8080',
          idx,
        ),
      );
      for (const c of cases) {
        await clientDb.query(
          'INSERT INTO run_cases(id, project_id, run_id, document, criteria_hash) VALUES($1, $2, $3, $4, $5)',
          [c.id, project.id, runId, c, criteriaHash(c)],
        );
      }

      // 3. Setup tasks in running state with fencing_token=1 and unexpired lease
      const task0 = randomUUID();
      await clientDb.query(
        "INSERT INTO jobs(id, project_id, run_id, unique_key, role, document, status, fencing_token, lease_until) VALUES($1, $2, $3, $4, 'executor', '{}', 'running', 1, clock_timestamp() + interval '1 hour')",
        [task0, project.id, runId, `k0:${task0}`],
      );

      const task1 = randomUUID();
      await clientDb.query(
        "INSERT INTO jobs(id, project_id, run_id, unique_key, role, document, status, fencing_token, lease_until) VALUES($1, $2, $3, $4, 'executor', '{}', 'running', 1, clock_timestamp() + interval '1 hour')",
        [task1, project.id, runId, `k1:${task1}`],
      );

      const task2 = randomUUID();
      await clientDb.query(
        "INSERT INTO jobs(id, project_id, run_id, unique_key, role, document, status, fencing_token, lease_until) VALUES($1, $2, $3, $4, 'executor', '{}', 'running', 1, clock_timestamp() + interval '1 hour')",
        [task2, project.id, runId, `k2:${task2}`],
      );

      // 4. Create 1 screenshot artifact for Case 0 & Case 1
      const artId0 = randomUUID();
      const testPng = Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
      ]);
      const artDoc0 = await artifactStore.put(
        {
          id: artId0,
          projectId: project.id,
          runId,
          kind: 'screenshot',
          redaction: 'not_needed',
          bytes: testPng.length,
          sha256: artifactStore.checksum(testPng),
          taskId: task0,
        },
        testPng,
      );
      await clientDb.query(
        "INSERT INTO artifacts(id, project_id, run_id, task_id, document, retain_until, held) VALUES($1, $2, $3, $4, $5, clock_timestamp() + interval '30 days', false)",
        [artId0, project.id, runId, task0, artDoc0],
      );

      const artId1 = randomUUID();
      const artDoc1 = await artifactStore.put(
        {
          id: artId1,
          projectId: project.id,
          runId,
          kind: 'screenshot',
          redaction: 'not_needed',
          bytes: testPng.length,
          sha256: artifactStore.checksum(testPng),
          taskId: task1,
        },
        testPng,
      );
      await clientDb.query(
        "INSERT INTO artifacts(id, project_id, run_id, task_id, document, retain_until, held) VALUES($1, $2, $3, $4, $5, clock_timestamp() + interval '30 days', false)",
        [artId1, project.id, runId, task1, artDoc1],
      );

      // Case 0: passed
      const attempt0 = randomUUID();
      await clientDb.query(
        "INSERT INTO case_attempts(id, project_id, run_id, case_id, task_id, attempt_number, status, context_id) VALUES($1, $2, $3, $4, $5, 1, 'succeeded', $6)",
        [attempt0, project.id, runId, cases[0].id, task0, randomUUID()],
      );
      const verdict0 = parseContract('Verdict', {
        id: randomUUID(),
        caseId: cases[0].id,
        attemptId: attempt0,
        status: 'passed',
        reasonCode: 'ALL_PASSED',
        summary: 'All criteria passed',
        criterionResults: cases[0].criteria.map((cr) => ({
          criterionId: cr.id,
          result: 'passed',
          reason: 'OK',
          evidenceRefs: [artId0],
        })),
        gaps: [],
        createdAt: new Date().toISOString(),
      });
      await clientDb.query(
        'INSERT INTO verdicts(id, project_id, case_id, attempt_id, document, payload_hash, fencing_token) VALUES($1, $2, $3, $4, $5, $6, 1)',
        [verdict0.id, project.id, cases[0].id, attempt0, verdict0, 'hash0'],
      );

      // Case 1: issue_found
      const attempt1 = randomUUID();
      await clientDb.query(
        "INSERT INTO case_attempts(id, project_id, run_id, case_id, task_id, attempt_number, status, context_id) VALUES($1, $2, $3, $4, $5, 1, 'succeeded', $6)",
        [attempt1, project.id, runId, cases[1].id, task1, randomUUID()],
      );
      const verdict1 = parseContract('Verdict', {
        id: randomUUID(),
        caseId: cases[1].id,
        attemptId: attempt1,
        status: 'issue_found',
        reasonCode: 'DEFECT_FOUND',
        summary: 'Defect found',
        criterionResults: [
          {
            criterionId: cases[1].criteria[0].id,
            result: 'failed',
            reason: 'Mismatch',
            evidenceRefs: [artId1],
          },
          {
            criterionId: cases[1].criteria[1].id,
            result: 'passed',
            reason: 'OK',
            evidenceRefs: [artId1],
          },
        ],
        gaps: [],
        createdAt: new Date().toISOString(),
      });
      await clientDb.query(
        'INSERT INTO verdicts(id, project_id, case_id, attempt_id, document, payload_hash, fencing_token) VALUES($1, $2, $3, $4, $5, $6, 1)',
        [verdict1.id, project.id, cases[1].id, attempt1, verdict1, 'hash1'],
      );

      // Case 2: blocked
      const attempt2 = randomUUID();
      await clientDb.query(
        "INSERT INTO case_attempts(id, project_id, run_id, case_id, task_id, attempt_number, status, context_id) VALUES($1, $2, $3, $4, $5, 1, 'succeeded', $6)",
        [attempt2, project.id, runId, cases[2].id, task2, randomUUID()],
      );
      const verdict2 = parseContract('Verdict', {
        id: randomUUID(),
        caseId: cases[2].id,
        attemptId: attempt2,
        status: 'blocked',
        reasonCode: 'SETUP_FAILURE',
        summary: 'Evaluation blocked',
        criterionResults: [
          {
            criterionId: cases[2].criteria[0].id,
            result: 'not_evaluated',
            reason: 'Setup failed',
            evidenceRefs: [],
          },
          {
            criterionId: cases[2].criteria[1].id,
            result: 'not_evaluated',
            reason: 'Setup failed',
            evidenceRefs: [],
          },
        ],
        gaps: ['Setup failure prevented evaluation'],
        createdAt: new Date().toISOString(),
      });
      await clientDb.query(
        'INSERT INTO verdicts(id, project_id, case_id, attempt_id, document, payload_hash, fencing_token) VALUES($1, $2, $3, $4, $5, $6, 1)',
        [verdict2.id, project.id, cases[2].id, attempt2, verdict2, 'hash2'],
      );

      // Case 3: attempt started but crashed/no verdict -> projected as inconclusive
      const task3 = randomUUID();
      await clientDb.query(
        "INSERT INTO jobs(id, project_id, run_id, unique_key, role, document, status, fencing_token, lease_until) VALUES($1, $2, $3, $4, 'executor', '{}', 'failed', 1, clock_timestamp())",
        [task3, project.id, runId, `k3:${task3}`],
      );
      await clientDb.query(
        "INSERT INTO case_attempts(id, project_id, run_id, case_id, task_id, attempt_number, status, context_id) VALUES($1, $2, $3, $4, $5, 1, 'interrupted', $6)",
        [randomUUID(), project.id, runId, cases[3].id, task3, randomUUID()],
      );

      // Case 4: NO attempt at all -> projected as not_run

      // Finalize jobs and run. Record a real cleanup failure on the finalizer
      // job result. Do not put that value in runs.status or jobs.status.
      const finalizerId = randomUUID();
      await clientDb.query(
        `INSERT INTO jobs(id, project_id, run_id, unique_key, role, document, status, fencing_token, result)
         VALUES($1, $2, $3, $4, 'finalizer', '{}', 'succeeded', 1, $5)`,
        [
          finalizerId,
          project.id,
          runId,
          `finalize:${finalizerId}`,
          { stage: 'finalize', cleanupStatus: 'failed' },
        ],
      );
      await clientDb.query(
        "UPDATE jobs SET status = 'succeeded' WHERE run_id = $1 AND status = 'running'",
        [runId],
      );
      await clientDb.query(
        "UPDATE runs SET status = 'completed', phase = 'finalize', completion = 'partial', version = version + 1 WHERE id = $1",
        [runId],
      );

      // Build Report and assert summary metrics
      const report = await reportBuilder.build(clientDb, project.id, runId, {
        artifactStore,
      });

      assert.equal(report.summary.planned, 5);
      assert.equal(report.summary.passed, 1);
      assert.equal(report.summary.issueFound, 1);
      assert.equal(report.summary.blocked, 1);
      assert.equal(report.summary.inconclusive, 1);
      assert.equal(report.summary.notRun, 1);
      assert.equal(report.summary.attempted, 4); // 5 - notRun
      assert.equal(report.summary.evaluated, 2); // passed + issueFound
      assert.equal(report.summary.passRate, 0.5); // 1 / 2
      assert.equal(report.summary.attemptRate, 0.8); // 4 / 5
      assert.equal(report.cleanupStatus, 'failed');
      assert.notEqual(report.cleanupStatus, 'succeeded');

      // Invalidation test: invalidate verdict 0 and check final_valid_verdicts
      await clientDb.query(
        'INSERT INTO verdict_invalidations(project_id, verdict_id, reason) VALUES($1, $2, $3)',
        [project.id, verdict0.id, 'Test invalidation'],
      );

      const reportAfterInvalidation = await reportBuilder.build(
        clientDb,
        project.id,
        runId,
        { artifactStore },
      );
      // Case 0 now has attempt but no valid verdict -> projected as inconclusive
      assert.equal(reportAfterInvalidation.summary.passed, 0);
      assert.equal(reportAfterInvalidation.summary.inconclusive, 2);
      assert.equal(reportAfterInvalidation.summary.evaluated, 1); // only Case 1 (issueFound)
      assert.equal(reportAfterInvalidation.summary.passRate, 0); // 0 / 1

      facts.summaryVerification = {
        planned: 5,
        outcomes: [
          'passed',
          'issue_found',
          'blocked',
          'inconclusive',
          'not_run',
        ],
        invalidationHandled: true,
      };
      facts.tests.push({
        name: 'summary-formula-and-invalidation',
        summary: report.summary,
      });
    } catch (err) {
      console.error('DEBUG TEST 2 SQL ERROR:', err);
      throw err;
    }
  });
});

test('3. Export ZIP: actual archive creation, physical unpacking, SHA256 integrity and manifest check', async () => {
  const { project, run } = await trustedRun('/', 1);
  const runtime = await advanceToCases(project, run);
  await finishRun(project, run, runtime);

  await coordinator.tx(async (clientDb) => {
    const report = await reportBuilder.build(clientDb, project.id, run.id, {
      artifactStore,
    });
    const manifest = (
      await (
        await import('../dist/index.js')
      ).validateEvidenceReferences(
        project.id,
        run.id,
        report.artifacts,
        report.cases.map((c) => c.verdict).filter(Boolean),
        report.findings,
        report.reproductions,
        artifactStore,
      )
    ).manifest;

    // Export ZIP
    const exportResult = await exportService.exportZip(
      clientDb,
      report,
      manifest,
      { retainDays: 30 },
    );

    assert.ok(exportResult.zipBuffer.length > 0);
    assert.equal(exportResult.exportRecord.status, 'ready');
    assert.equal(exportResult.exportRecord.format, 'zip');
    assert.ok(exportResult.exportRecord.artifactId);

    // Actual unpacking and byte-level verification
    const verification = verifyUnpackedZip(
      exportResult.zipBuffer,
      manifest,
      report,
    );
    assert.equal(
      verification.verified,
      true,
      JSON.stringify(verification.errors),
    );
    assert.ok(verification.files.includes('report.json'));
    assert.ok(verification.files.includes('report.md'));
    assert.ok(verification.files.includes('manifest.json'));

    // Check extracted contents
    const unpacked = unpackZip(exportResult.zipBuffer);
    const manifestJson = JSON.parse(
      unpacked.get('manifest.json').data.toString('utf8'),
    );
    assert.equal(manifestJson.runId, run.id);
    assert.equal(manifestJson.totalArtifacts, report.artifacts.length);

    // Check that each available artifact has exact matching sha256
    for (const art of report.artifacts) {
      const entry = manifest.get(art.id);
      if (entry && entry.status === 'available' && entry.relativePath) {
        assert.ok(unpacked.has(entry.relativePath));
        const extractedSha = createHash('sha256')
          .update(unpacked.get(entry.relativePath).data)
          .digest('hex');
        assert.equal(extractedSha, art.sha256);
      }
    }

    // Markdown export check: ZERO external CDN links
    const mdExport = exportService.exportMarkdown(report, manifest);
    assert.ok(
      !/https?:\/\/(?!localhost\b)[\w.-]+\/(?:css|js|cdn|static)/i.test(
        mdExport.content,
      ),
    );

    facts.exportZipVerification = {
      exportId: exportResult.exportRecord.id,
      zipBytes: exportResult.zipBuffer.length,
      filesInZip: verification.files,
      manifestSummary: {
        total: manifestJson.totalArtifacts,
        available: manifestJson.availableArtifacts,
      },
    };
    facts.tests.push({
      name: 'export-zip-and-markdown',
      files: verification.files,
    });
  });
});

test('4. Garbage Collection (GC): verifies retention rules, active run protection, manual held protection, export reference protection, and other-project isolation', async () => {
  const projectA = await new ProjectRepository(db).create(act(), {
    name: `T08 GC Project A ${randomUUID().slice(0, 8)}`,
  });
  const projectB = await new ProjectRepository(db).create(act(), {
    name: `T08 GC Project B ${randomUUID().slice(0, 8)}`,
  });

  await coordinator.tx(async (clientDb) => {
    const now = new Date().toISOString();

    // Run A1: Completed Run in Project A
    const runA1 = randomUUID();
    await clientDb.query(
      `INSERT INTO runs(id, project_id, creator_id, display_url, status, phase, completion, effective_config, budget_used, created_at, updated_at)
       VALUES($1, $2, $3, $4, 'completed', 'finalize', 'complete', $5, $6, $7, $7)`,
      [
        runA1,
        projectA.id,
        admin.id,
        'http://localhost:8080',
        config(),
        {
          activeSeconds: 1,
          actions: 0,
          modelCalls: 0,
          reproductions: 0,
          totalTokens: 0,
        },
        now,
      ],
    );
    await clientDb.query(
      `INSERT INTO run_budgets(project_id, run_id, limits, used)
       VALUES($1, $2, $3, $4)`,
      [
        projectA.id,
        runA1,
        config().budget,
        {
          activeSeconds: 1,
          actions: 0,
          modelCalls: 0,
          reproductions: 0,
          totalTokens: 0,
        },
      ],
    );

    // Run A2: Active Running Run in Project A
    const runA2 = randomUUID();
    await clientDb.query(
      `INSERT INTO runs(id, project_id, creator_id, display_url, status, phase, completion, effective_config, budget_used, created_at, updated_at)
       VALUES($1, $2, $3, $4, 'running', 'execute', 'none', $5, $6, $7, $7)`,
      [
        runA2,
        projectA.id,
        admin.id,
        'http://localhost:8080',
        config(),
        {
          activeSeconds: 1,
          actions: 0,
          modelCalls: 0,
          reproductions: 0,
          totalTokens: 0,
        },
        now,
      ],
    );
    await clientDb.query(
      `INSERT INTO run_budgets(project_id, run_id, limits, used)
       VALUES($1, $2, $3, $4)`,
      [
        projectA.id,
        runA2,
        config().budget,
        {
          activeSeconds: 1,
          actions: 0,
          modelCalls: 0,
          reproductions: 0,
          totalTokens: 0,
        },
      ],
    );

    // Run B1: Completed Run in Project B
    const runB1 = randomUUID();
    await clientDb.query(
      `INSERT INTO runs(id, project_id, creator_id, display_url, status, phase, completion, effective_config, budget_used, created_at, updated_at)
       VALUES($1, $2, $3, $4, 'completed', 'finalize', 'complete', $5, $6, $7, $7)`,
      [
        runB1,
        projectB.id,
        admin.id,
        'http://localhost:8080',
        config(),
        {
          activeSeconds: 1,
          actions: 0,
          modelCalls: 0,
          reproductions: 0,
          totalTokens: 0,
        },
        now,
      ],
    );
    await clientDb.query(
      `INSERT INTO run_budgets(project_id, run_id, limits, used)
       VALUES($1, $2, $3, $4)`,
      [
        projectB.id,
        runB1,
        config().budget,
        {
          activeSeconds: 1,
          actions: 0,
          modelCalls: 0,
          reproductions: 0,
          totalTokens: 0,
        },
      ],
    );

    const dummyData = Buffer.from('Dummy test artifact data', 'utf8');
    const dummySha = artifactStore.checksum(dummyData);

    // Helper to create and store artifact
    async function createArtifact(projId, rId, retainPast, isHeld) {
      const id = randomUUID();
      const doc = await artifactStore.put(
        {
          id,
          projectId: projId,
          runId: rId,
          kind: 'screenshot',
          redaction: 'not_needed',
          bytes: dummyData.length,
          sha256: dummySha,
        },
        dummyData,
      );

      const retainInterval = retainPast
        ? "- interval '10 days'"
        : "+ interval '30 days'";
      await clientDb.query(
        `INSERT INTO artifacts(id, project_id, run_id, document, retain_until, held)
         VALUES($1, $2, $3, $4, clock_timestamp() ${retainInterval}, $5)`,
        [id, projId, rId, doc, isHeld],
      );
      return id;
    }

    // 1. Artifact Eligible for GC (expired, not held, completed run)
    const artEligible = await createArtifact(projectA.id, runA1, true, false);

    // 2. Protected by Active Run (expired retain_until, but runA2 is 'running')
    const artActiveRun = await createArtifact(projectA.id, runA2, true, false);

    // 3. Protected by Manual Retention (held = true, even though retain_until is past)
    const artHeld = await createArtifact(projectA.id, runA1, true, true);

    // 4. Protected by Unexpired retain_until (+30 days)
    const artUnexpired = await createArtifact(projectA.id, runA1, false, false);

    // 5. Protected by Active Export Reference (expired retain_until on artifact, but referenced by active export)
    const artExportRef = await createArtifact(projectA.id, runA1, true, false);
    const exportId = randomUUID();
    await clientDb.query(
      `INSERT INTO exports(id, project_id, run_id, status, document, report_snapshot, artifact_id, retain_until, held)
       VALUES($1, $2, $3, 'ready', '{}', '{}', $4, clock_timestamp() + interval '30 days', false)`,
      [exportId, projectA.id, runA1, artExportRef],
    );

    // 6. Other Project B Artifact (expired, eligible in B, but GC will run for project A)
    const artProjectB = await createArtifact(projectB.id, runB1, true, false);

    // Verify all 6 artifacts exist on disk before GC
    assert.equal(
      await artifactStore.exists(projectA.id, runA1, artEligible),
      true,
    );
    assert.equal(
      await artifactStore.exists(projectA.id, runA2, artActiveRun),
      true,
    );
    assert.equal(await artifactStore.exists(projectA.id, runA1, artHeld), true);
    assert.equal(
      await artifactStore.exists(projectA.id, runA1, artUnexpired),
      true,
    );
    assert.equal(
      await artifactStore.exists(projectA.id, runA1, artExportRef),
      true,
    );
    assert.equal(
      await artifactStore.exists(projectB.id, runB1, artProjectB),
      true,
    );

    // RUN GC FOR PROJECT A
    const gcResult = await gc.runGC(clientDb, projectA.id, artifactStore);

    // Verify GC statistics
    assert.equal(gcResult.deletedArtifacts, 1);
    assert.deepEqual(gcResult.deletedArtifactIds, [artEligible]);
    assert.ok(gcResult.protectedActiveRuns >= 1);
    assert.ok(gcResult.protectedManualRetention >= 1);
    assert.ok(gcResult.protectedExportReferences >= 1);

    // Verify physical file deletions and retentions
    assert.equal(
      await artifactStore.exists(projectA.id, runA1, artEligible),
      false,
      'Eligible artifact must be deleted',
    );
    assert.equal(
      await artifactStore.exists(projectA.id, runA2, artActiveRun),
      true,
      'Active run artifact must be protected',
    );
    assert.equal(
      await artifactStore.exists(projectA.id, runA1, artHeld),
      true,
      'Held artifact must be protected',
    );
    assert.equal(
      await artifactStore.exists(projectA.id, runA1, artUnexpired),
      true,
      'Unexpired artifact must be protected',
    );
    assert.equal(
      await artifactStore.exists(projectA.id, runA1, artExportRef),
      true,
      'Export-referenced artifact must be protected',
    );
    assert.equal(
      await artifactStore.exists(projectB.id, runB1, artProjectB),
      true,
      'Project B artifact must not be touched',
    );

    // Verify DB update: deleted artifact is marked missing with explanation
    const eligibleDoc = (
      await clientDb.query('SELECT document FROM artifacts WHERE id = $1', [
        artEligible,
      ])
    ).rows[0].document;
    assert.equal(eligibleDoc.status, 'missing');
    assert.ok(eligibleDoc.error.includes('retention policy'));

    facts.gcVerification = {
      projectId: projectA.id,
      deletedArtifacts: gcResult.deletedArtifacts,
      protectedActiveRuns: gcResult.protectedActiveRuns,
      protectedManualRetention: gcResult.protectedManualRetention,
      protectedExportReferences: gcResult.protectedExportReferences,
      otherProjectUntouched: true,
    };
    facts.tests.push({ name: 'gc-protection-invariants', result: gcResult });
  });
});

test('5. Replay degradation: trace/rrweb absence cleanly falls back to step screenshots and events with warnings', () => {
  const stepId = randomUUID();
  const screenId = randomUUID();

  const artifacts = [
    {
      id: screenId,
      projectId: randomUUID(),
      runId: randomUUID(),
      kind: 'screenshot',
      status: 'available',
      bytes: 1234,
      sha256: 'c'.repeat(64),
      contentUrl: null,
      redaction: 'not_needed',
      error: null,
      createdAt: new Date().toISOString(),
      taskId: null,
      stepId,
      caseId: null,
      snapshotId: null,
    },
  ];

  const steps = [
    {
      id: stepId,
      runId: randomUUID(),
      taskId: randomUUID(),
      caseId: null,
      seq: 1,
      toolName: 'navigate',
      status: 'succeeded',
      summary: 'Navigated to target URL',
      targetDescription: 'http://localhost:8080/entry',
      evidenceRefs: [screenId],
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    },
  ];

  const assessment = assessReplayDegradation(artifacts, steps);
  assert.equal(assessment.mode, 'degraded');
  assert.equal(assessment.hasTrace, false);
  assert.equal(assessment.hasRrweb, false);
  assert.equal(assessment.timeline.length, 1);
  assert.equal(assessment.timeline[0].screenshotArtifactId, screenId);
  assert.ok(
    assessment.warnings.some((w) => w.includes('degraded to step events')),
  );
  facts.tests.push({ name: 'replay-degradation', assessment });
});
