import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn, fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from '../../../packages/storage/node_modules/pg/lib/index.js';
import { parseContract } from '@localqa/contracts';
import {
  Database,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  RunRepository,
  SecretVault,
  StorageError,
  migrate,
  hashPayload,
} from '@localqa/storage';
import {
  Coordinator,
  RuntimeClient,
  ArtifactStore,
  DECISION_SCHEMA,
} from '@localqa/orchestrator';
import { DEFAULT_LIMITS, smokeCase, TERMINAL } from '@localqa/domain';
import { createStubAdapter } from '@localqa/model-gateway';
import { BrowserManager } from '@localqa/browser';
import { Worker } from '../dist/index.js';

const root = '/work',
  evidence = `${root}/apps/worker/.evidence`;
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
let fixture, vault, admin, model, coordinator;
const facts = {
  task: 'T05',
  node: process.version,
  uid: process.getuid(),
  browser: 'Chromium via T03 sandbox-enabled BrowserManager',
  modelMode: 'T04 fixed stub; no real provider',
  tests: [],
  verticalSlice: null,
};
const act = () => ({ userId: admin.id });
const proof = (lease) => ({
  taskId: lease.task.id,
  fencingToken: lease.fencingToken,
  leaseToken: lease.leaseToken,
  contextVersion: lease.contextVersion,
});
const errorCode = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof StorageError && e.code === code);
const stores = new ArtifactStore(`${root}/packages/orchestrator/.artifacts`);
const stub = createStubAdapter();
const modelOptions = {
  adapter: stub,
  async profile(id, version) {
    return {
      id,
      version,
      name: 'T05 test stub',
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
async function setup(path = '/', budget = {}, extra = {}) {
  const project = await new ProjectRepository(db).create(act(), {
    name: `T05 ${randomUUID().slice(0, 8)}`,
  });
  await new ModelRepository(db, vault).grant(act(), project.id, model.id);
  const cfg = config(budget);
  const run = await coordinator.start(
    act(),
    { projectId: project.id, targetUrl: `${fixtureUrl}${path}`, ...extra },
    cfg,
    randomUUID(),
  );
  return { project, run, cfg };
}
function client(
  projectId,
  workerId = `worker-${randomUUID()}`,
  options = modelOptions,
) {
  return new RuntimeClient(
    coordinator,
    { projectId, workerId },
    stores,
    options,
  );
}
const manager = new BrowserManager();
function worker(runtime, extra = {}) {
  return new Worker({
    runtime,
    browser: manager,
    scratch: `${evidence}/scratch`,
    heartbeatMs: 200,
    pollMs: 200,
    ...extra,
  });
}
async function finishRun(project, run, runtime = client(project.id), max = 35) {
  const w = worker(runtime);
  for (let n = 0; n < max; n++) {
    await runtime.poll();
    const current = await new RunRepository(db, vault).get(
      act(),
      project.id,
      run.id,
    );
    if (TERMINAL.has(current.status)) return current;
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
  const w = worker(runtime);
  for (let n = 0; n < 8; n++) {
    await runtime.poll();
    const current = await new RunRepository(db, vault).get(
      act(),
      project.id,
      run.id,
    );
    if (current.phase === 'execute') return runtime;
    await w.once();
  }
  throw new Error('Plan phase did not advance');
}
before(async () => {
  const version = (
    await pool.query(
      "SELECT version(),current_setting('server_version_num')::integer number",
    )
  ).rows[0];
  assert.equal(Math.floor(version.number / 10000), 18);
  facts.postgres = version;
  facts.migrations = await migrate(
    connection,
    new URL('../../../packages/storage/migrations/', import.meta.url),
  );
  assert.equal(
    (
      await migrate(
        connection,
        new URL('../../../packages/storage/migrations/', import.meta.url),
      )
    ).length,
    0,
  );
  vault = await SecretVault.fromProtectedFile(`${evidence}/kek.json`);
  admin = await new AccountsRepository(db).bootstrap({
    email: 'admin@t05.test',
    displayName: 'T05 coordinator',
    password: 'T05-test-only-admin-password',
  });
  model = await new ModelRepository(db, vault).create(act(), {
    name: 'T05 fixed stub fixture binding',
    endpoint: 'https://stub.example.test/v1',
    configuredModelId: 'stub-normal',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
  });
  coordinator = new Coordinator({
    db,
    serviceActor: act(),
    vault,
    platformSlots: 4,
    projectSlots: 4,
  });
  fixture = spawn(
    process.execPath,
    [`${root}/packages/test-fixture/server.js`],
    {
      cwd: root,
      env: { ...process.env, PORT: '8080' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let logs = '';
  fixture.stdout.on('data', (data) => (logs += data));
  fixture.stderr.on('data', (data) => (logs += data));
  facts.fixtureLogs = () => logs;
  for (let n = 0; n < 80; n++) {
    try {
      const response = await fetch(fixtureUrl);
      if (response.ok) return;
    } catch {
      /* Fixture readiness: retry only connection startup errors. */
    }
    await delay(100);
  }
  throw new Error('Fixture not ready');
});
after(async () => {
  await manager.close();
  if (fixture) {
    fixture.kill('SIGTERM');
    await new Promise((resolve) => {
      if (fixture.exitCode !== null) resolve();
      else fixture.once('exit', resolve);
    });
  }
  facts.fixtureLogs = facts.fixtureLogs?.();
  facts.stubProviderCalls = stub.calls;
  facts.allMaterialHashes = (
    await pool.query(
      'SELECT id,project_id,run_id,document FROM artifacts ORDER BY id',
    )
  ).rows;
  await writeFile(
    `${evidence}/facts.json`,
    JSON.stringify(facts, null, 2) + '\n',
  );
  await pool.end();
  await db.close();
  vault?.dispose();
});

test('first vertical slice: Run+Job+event -> leased Worker -> real browser -> evidence/verdict -> sequential events', async () => {
  const { project, run } = await setup();
  const repo = new RunRepository(db, vault);
  let events = await repo.events(act(), project.id, run.id);
  assert.equal(events[0].type, 'run.updated');
  assert.equal(events[0].seq, 1);
  assert.equal(
    (
      await pool.query('SELECT count(*)::integer n FROM jobs WHERE run_id=$1', [
        run.id,
      ])
    ).rows[0].n,
    1,
  );
  const final = await finishRun(project, run);
  assert.equal(final.status, 'completed');
  assert.equal(final.completion, 'complete');
  assert.equal(final.terminationReason, 'normal');
  const summary = await repo.summary(act(), project.id, run.id);
  assert.equal(summary.passed, 1);
  assert.equal(summary.planned, 1);
  events = [];
  let afterSeq = 0;
  for (;;) {
    const page = await repo.events(act(), project.id, run.id, afterSeq);
    if (!page.length) break;
    events.push(...page);
    afterSeq = page.at(-1).seq;
  }
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
  );
  for (const event of events) {
    assert.equal(event.id, String(event.seq));
    parseContract('RunEvent', event);
  }
  const verdict = (
    await pool.query(
      'SELECT document FROM verdicts v JOIN case_attempts a ON a.id=v.attempt_id WHERE a.run_id=$1',
      [run.id],
    )
  ).rows[0].document;
  assert.equal(verdict.status, 'passed');
  const material = (
    await pool.query('SELECT document FROM artifacts WHERE run_id=$1', [run.id])
  ).rows[0].document;
  assert.ok(!material.contentUrl.startsWith('file:'));
  const bytes = await stores.get(project.id, run.id, material.id);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    material.sha256,
  );
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.ok(
    verdict.criterionResults.every((r) => r.evidenceRefs.includes(material.id)),
  );
  const assertion = (
    await pool.query(
      "SELECT result FROM jobs WHERE run_id=$1 AND role='executor'",
      [run.id],
    )
  ).rows[0].result.assertionAssessment;
  assert.equal(assertion.reasonCode, 'FAKE_EVIDENCE');
  assert.deepEqual(assertion.acceptedEvidenceRefs, []);
  const chrome = [];
  for (const pid of (await readdir('/proc')).filter((id) => /^\d+$/.test(id))) {
    try {
      const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8'))
        .split('\0')
        .filter(Boolean);
      if (
        args[0] &&
        /\/(chrome|headless_shell|chrome-headless-shell)$/.test(args[0])
      ) {
        assert.ok(!args.includes('--no-sandbox'));
        chrome.push({
          pid: Number(pid),
          args,
          status: (await readFile(`/proc/${pid}/status`, 'utf8'))
            .split('\n')
            .filter((line) => /^(Uid|Seccomp):/.test(line)),
        });
      }
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') continue;
      throw error;
    }
  }
  assert.ok(chrome.length > 0);
  facts.sandbox = {
    nonRoot: process.getuid() !== 0,
    noNoSandbox: true,
    processes: chrome,
  };
  facts.verticalSlice = {
    run: final,
    summary,
    verdict,
    material,
    events,
    browserContextIds: (
      await pool.query('SELECT context_id FROM case_attempts WHERE run_id=$1', [
        run.id,
      ])
    ).rows,
    stubAssertionRejected: assertion,
  };
  console.log(
    JSON.stringify({
      verticalSlice: 'real_browser_passed',
      runId: run.id,
      summary,
      eventCount: events.length,
      evidenceSha256: material.sha256,
    }),
  );
});
test('create idempotency, duplicate job key and transaction rollback leave no second dispatch', async () => {
  const { project, cfg } = await setup();
  const input = { projectId: project.id, targetUrl: fixtureUrl };
  const a = await coordinator.start(act(), input, cfg, 'same-start');
  const b = await coordinator.start(act(), input, cfg, 'same-start');
  assert.equal(a.id, b.id);
  await errorCode(
    coordinator.start(act(), { ...input, brief: 'changed' }, cfg, 'same-start'),
    'IDEMPOTENCY_CONFLICT',
  );
  await coordinator.tx(async (c) => {
    const one = await coordinator.enqueue(
      c,
      a,
      'explorer',
      'explore',
      'dedup',
      null,
    );
    const two = await coordinator.enqueue(
      c,
      a,
      'explorer',
      'explore',
      'dedup',
      null,
    );
    assert.equal(one, two);
  });
  const row = (
    await pool.query('SELECT * FROM jobs WHERE run_id=$1 LIMIT 1', [a.id])
  ).rows[0];
  await assert.rejects(
    pool.query(
      'INSERT INTO jobs(id,project_id,run_id,unique_key,role,document) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        project.id,
        a.id,
        row.unique_key,
        row.role,
        { ...row.document, id: randomUUID() },
      ],
    ),
    (e) => e.code === '23505',
  );
  const before = (await pool.query('SELECT count(*)::integer n FROM runs'))
    .rows[0].n;
  await assert.rejects(
    coordinator.start(
      act(),
      { projectId: project.id, targetUrl: fixtureUrl },
      { ...cfg, environmentVersion: 1 },
      randomUUID(),
    ),
  );
  assert.equal(
    (await pool.query('SELECT count(*)::integer n FROM runs')).rows[0].n,
    before,
  );
});
test('atomic reservations: competing final call slot, settlements/idempotency and missing usage estimation', async () => {
  const { project, run } = await setup('/', { maxModelCalls: 1 });
  const rt = client(project.id);
  const p = proof(await rt.claim());
  const requested = await Promise.allSettled([
    coordinator.tx((c) =>
      coordinator.reserve(
        c,
        { projectId: project.id, workerId: 'wrong' },
        p,
        'model',
        { modelCalls: 1 },
      ),
    ),
    Promise.resolve(),
  ]);
  assert.equal(requested[0].status, 'rejected');
  const scopedId = 'budget-worker';
  await coordinator.cancel(act(), project.id, run.id);
  await coordinator.tick(project.id);
  const s = await setup('/', { maxModelCalls: 1 });
  const scope = { projectId: s.project.id, workerId: scopedId };
  const lease = await coordinator.claim(scope);
  const pr = proof(lease);
  const settled = await Promise.allSettled([
    coordinator.tx((c) =>
      coordinator.reserve(c, scope, pr, 'model', {
        modelCalls: 1,
        totalTokens: 200,
      }),
    ),
    coordinator.tx((c) =>
      coordinator.reserve(c, scope, pr, 'model', {
        modelCalls: 1,
        totalTokens: 200,
      }),
    ),
  ]);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(
    settled.some(
      (r) => r.status === 'rejected' && r.reason.code === 'BUDGET_EXCEEDED',
    ),
  );
  const reservation = settled.find((r) => r.status === 'fulfilled').value;
  await coordinator.settle(
    scope,
    pr,
    reservation.id,
    { modelCalls: 1, totalTokens: 123 },
    'estimated',
  );
  await coordinator.settle(
    scope,
    pr,
    reservation.id,
    { modelCalls: 1, totalTokens: 123 },
    'estimated',
  );
  await errorCode(
    coordinator.settle(
      scope,
      pr,
      reservation.id,
      { modelCalls: 1, totalTokens: 124 },
      'estimated',
    ),
    'IDEMPOTENCY_CONFLICT',
  );
  const used = (
    await pool.query('SELECT used,reserved FROM run_budgets WHERE run_id=$1', [
      s.run.id,
    ])
  ).rows[0];
  assert.equal(used.used.modelCalls, 1);
  assert.equal(used.used.totalTokens, 123);
  assert.equal(used.reserved.modelCalls, 0);
  await coordinator.cancel(act(), s.project.id, s.run.id);
  await coordinator.tick(s.project.id);
  const unknownUsage = await setup();
  const base = createStubAdapter();
  const noUsage = {
    ...base,
    async send(input, signal) {
      const response = await base.send(input, signal);
      return { ...response, usage: null };
    },
  };
  const runtime = client(unknownUsage.project.id, 'missing-usage', {
    ...modelOptions,
    adapter: noUsage,
  });
  const l = await runtime.claim();
  const rec = await runtime.model(proof(l), 'coordinator', {
    purpose: 'decide',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'DISPATCHED' }] },
    ],
    outputSchema: DECISION_SCHEMA,
    maxOutputTokens: 100,
  });
  assert.equal(rec.usageSource, 'estimated');
  const diag = (
    await pool.query(
      'SELECT redacted_diagnostic FROM model_requests WHERE run_id=$1',
      [unknownUsage.run.id],
    )
  ).rows[0].redacted_diagnostic;
  assert.equal(diag.usageSource, 'estimated');
  assert.ok(diag.inputTokens > 0);
  assert.ok(diag.outputTokens > 0);
  await coordinator.cancel(act(), unknownUsage.project.id, unknownUsage.run.id);
  await coordinator.tick(unknownUsage.project.id);
});
test('cancel <=2s: signal closes active real browser and no later intent/model dispatch', async () => {
  const { project, run } = await setup();
  const rt = await advanceToCases(project, run);
  let release, reached;
  const ready = new Promise((r) => (reached = r));
  const blocked = new Promise((r) => (release = r));
  const w = worker(rt, {
    onActionIntent: async () => {
      reached();
      await blocked;
    },
  });
  const execution = w.once();
  await ready;
  const start = performance.now();
  await coordinator.cancel(act(), project.id, run.id);
  await delay(250);
  release();
  await execution;
  await rt.poll();
  const elapsed = performance.now() - start;
  assert.ok(elapsed <= 2000, `cancel elapsed ${elapsed}`);
  const final = await new RunRepository(db, vault).get(
    act(),
    project.id,
    run.id,
  );
  assert.equal(final.status, 'cancelled');
  assert.equal(final.terminationReason, 'user_cancel');
  assert.equal(final.completion, 'partial');
  const actions = (
    await pool.query('SELECT outcome FROM action_intents WHERE run_id=$1', [
      run.id,
    ])
  ).rows;
  assert.ok(actions.some((a) => a.outcome === 'unknown'));
  const before = (
    await pool.query(
      'SELECT count(*)::integer n FROM action_intents WHERE run_id=$1',
      [run.id],
    )
  ).rows[0].n;
  assert.equal(await rt.claim(), null);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer n FROM action_intents WHERE run_id=$1',
        [run.id],
      )
    ).rows[0].n,
    before,
  );
  facts.tests.push({
    name: 'cancel',
    elapsedMs: elapsed,
    status: final.status,
  });
});
test('expired lease and old fencing denied; actionless preparation can safely requeue', async () => {
  const { project, run } = await setup();
  const rt = client(project.id, 'old');
  const old = await rt.claim(1);
  await delay(1100);
  await rt.poll();
  const newer = client(project.id, 'new');
  const fresh = await newer.claim();
  assert.equal(fresh.task.id, old.task.id);
  assert.equal(fresh.fencingToken, old.fencingToken + 1);
  await errorCode(rt.heartbeat(proof(old)), 'LEASE_EXPIRED');
  await errorCode(
    rt.finish(proof(old), { stage: 'preflight' }),
    'LEASE_EXPIRED',
  );
  await newer.finish(proof(fresh), { stage: 'preflight' });
  await coordinator.cancel(act(), project.id, run.id);
  await rt.poll();
  facts.tests.push({
    name: 'fencing',
    old: old.fencingToken,
    new: fresh.fencingToken,
  });
});
test('crash after persisted intent: unknown action never replayed; original interrupted and recovery verdict preserves facts', async () => {
  const { project, run } = await setup();
  const rt = await advanceToCases(project, run);
  const lease = await rt.claim(1);
  const p = proof(lease);
  const work = await rt.work(p);
  const grant = await rt.grant(p, {
    name: 'navigate',
    args: { url: fixtureUrl },
  });
  assert.ok(grant.id);
  await delay(1100);
  await rt.poll();
  await errorCode(rt.record(p, grant, 'succeeded', null), 'LEASE_EXPIRED');
  const final = await finishRun(project, run, client(project.id, 'recovery'));
  assert.equal(final.terminationReason, 'worker_failure');
  assert.equal(final.completion, 'partial');
  const original = (
    await pool.query('SELECT status FROM case_attempts WHERE id=$1', [
      work.attemptId,
    ])
  ).rows[0];
  assert.equal(original.status, 'interrupted');
  const verdicts = (
    await pool.query(
      'SELECT v.document FROM verdicts v JOIN case_attempts a ON a.id=v.attempt_id WHERE a.run_id=$1',
      [run.id],
    )
  ).rows;
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].document.status, 'inconclusive');
  assert.equal(
    (
      await pool.query('SELECT outcome FROM action_intents WHERE id=$1', [
        grant.id,
      ])
    ).rows[0].outcome,
    'unknown',
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer n FROM action_intents WHERE task_id=$1',
        [lease.task.id],
      )
    ).rows[0].n,
    1,
  );
  facts.tests.push({
    name: 'crash-recovery',
    originalAttempt: work.attemptId,
    replayed: false,
  });
});
test('budget exhaustion prevents extra provider requests and false completion', async () => {
  const { project, run } = await setup('/', { maxModelCalls: 1 });
  const final = await finishRun(project, run);
  assert.equal(final.terminationReason, 'budget_limit');
  assert.equal(final.completion, 'none');
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer n FROM model_requests WHERE run_id=$1',
        [run.id],
      )
    ).rows[0].n,
    1,
  );
  const tokens = await setup('/', { maxTotalTokens: 1000 });
  const f = await finishRun(tokens.project, tokens.run);
  assert.equal(f.terminationReason, 'budget_limit');
  assert.ok(f.budgetUsed.totalTokens <= 1000);
  facts.tests.push({
    name: 'budgets',
    calls: final.budgetUsed.modelCalls,
    tokens: f.budgetUsed.totalTokens,
  });
});
test('NOTIFY discarded: polling alone recovers all stages without listener', async () => {
  const { project, run } = await setup();
  const runtime = client(project.id, 'poll-only');
  const final = await finishRun(project, run, runtime);
  assert.equal(final.completion, 'complete');
  assert.equal(final.status, 'completed');
  facts.tests.push({
    name: 'notify-loss',
    listener: false,
    status: final.status,
  });
});
test('awaiting_input only with no other runnable task; deadline expires to partial/blocked result', async () => {
  const { project, run } = await setup();
  const rt = client(project.id);
  const a = await rt.claim();
  await coordinator.tx((c) =>
    coordinator.enqueue(
      c,
      run,
      'coordinator',
      'preflight',
      'other-independent',
      null,
    ),
  );
  await rt.input(proof(a), 'clarification', 'Need human clarification', 60);
  assert.equal(
    (await new RunRepository(db, vault).get(act(), project.id, run.id)).status,
    'running',
  );
  const b = await rt.claim();
  await rt.input(proof(b), 'clarification', 'Need another clarification', 60);
  assert.equal(
    (await new RunRepository(db, vault).get(act(), project.id, run.id)).status,
    'awaiting_input',
  );
  await delay(90);
  await rt.poll();
  const final = await new RunRepository(db, vault).get(
    act(),
    project.id,
    run.id,
  );
  assert.equal(final.terminationReason, 'input_timeout');
  assert.equal(final.completion, 'none');
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM input_requests WHERE run_id=$1 AND document->>'status'='expired'",
        [run.id],
      )
    ).rows[0].n,
    2,
  );
});
test('runtime binding rejects forged run/task/lease IDs, forbidden roles/tools and foreign project proof', async () => {
  const { project, run } = await setup();
  const rt = client(project.id, 'binding');
  const l = await rt.claim();
  const p = proof(l);
  await errorCode(
    rt.model(p, 'coordinator', {
      purpose: 'decide',
      messages: [],
      outputSchema: { type: 'object' },
      maxOutputTokens: 20,
      runId: run.id,
    }),
    'VALIDATION_ERROR',
  );
  await errorCode(
    rt.model(p, 'executor', {
      purpose: 'decide',
      messages: [],
      outputSchema: { type: 'object' },
      maxOutputTokens: 20,
    }),
    'FORBIDDEN',
  );
  await errorCode(
    rt.grant(p, { name: 'observe', args: { taskId: l.task.id } }),
    'VALIDATION_ERROR',
  );
  await errorCode(rt.grant(p, { name: 'observe', args: {} }), 'POLICY_DENIED');
  const foreign = await setup();
  await errorCode(
    client(foreign.project.id, 'binding').finish(p, { stage: 'preflight' }),
    'LEASE_EXPIRED',
  );
  await coordinator.cancel(act(), project.id, run.id);
  await rt.poll();
});
async function trustedRun(path = '/', count = 1, budget = {}) {
  const project = await new ProjectRepository(db).create(act(), {
    name: 'T05 trusted fixed fixture oracle',
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
test('independent reproduction: original suspected, fresh context/same criteria/real new evidence required for confirmed', async () => {
  const { project, run } = await trustedRun('/fix-09/blank');
  const runtime = await advanceToCases(project, run);
  await worker(runtime).once();
  const first = (
    await pool.query('SELECT document FROM findings WHERE run_id=$1', [run.id])
  ).rows[0].document;
  assert.equal(first.status, 'suspected');
  assert.equal(first.reproductionRef, null);
  const final = await finishRun(project, run, runtime);
  assert.equal(final.completion, 'complete');
  const finding = (
    await pool.query('SELECT * FROM findings WHERE run_id=$1', [run.id])
  ).rows[0];
  assert.equal(finding.status, 'confirmed');
  const contexts = (
    await pool.query(
      'SELECT context_id FROM case_attempts WHERE run_id=$1 ORDER BY attempt_number',
      [run.id],
    )
  ).rows;
  assert.equal(contexts.length, 2);
  assert.notEqual(contexts[0].context_id, contexts[1].context_id);
  const repetition = (
    await pool.query('SELECT * FROM reproductions WHERE run_id=$1', [run.id])
  ).rows[0];
  assert.equal(repetition.criteria_hash, finding.criteria_hash);
  assert.equal(repetition.outcome, 'reproduced');
  assert.ok(repetition.document.evidenceRefs.length);
  assert.notDeepEqual(repetition.document.evidenceRefs, first.evidenceRefs);
  const summary = await new RunRepository(db, vault).summary(
    act(),
    project.id,
    run.id,
  );
  assert.equal(summary.planned, 1);
  assert.equal(summary.issueFound, 1);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer n FROM verdicts v JOIN case_attempts a ON a.id=v.attempt_id WHERE a.run_id=$1',
        [run.id],
      )
    ).rows[0].n,
    2,
  );
  facts.tests.push({
    name: 'independent-reproduction',
    finding: finding.document,
    reproduction: repetition.document,
    contexts,
    sameCriteria: true,
  });
});
test('interrupted case is not replayed; another independent case runs in a fresh real context', async () => {
  const { project, run } = await trustedRun('/', 2);
  const runtime = await advanceToCases(project, run);
  const lease = await runtime.claim(1);
  const p = proof(lease);
  const initial = await runtime.work(p);
  const grant = await runtime.grant(p, {
    name: 'navigate',
    args: { url: fixtureUrl },
  });
  await delay(1100);
  await runtime.poll();
  const final = await finishRun(
    project,
    run,
    client(project.id, 'independent-recovery'),
  );
  assert.equal(final.completion, 'partial');
  const summary = await new RunRepository(db, vault).summary(
    act(),
    project.id,
    run.id,
  );
  assert.equal(summary.planned, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.inconclusive, 1);
  const contexts = (
    await pool.query(
      'SELECT context_id,status FROM case_attempts WHERE run_id=$1',
      [run.id],
    )
  ).rows;
  assert.equal(
    new Set(contexts.map((x) => x.context_id)).size,
    contexts.length,
  );
  assert.equal(
    (
      await pool.query('SELECT outcome FROM action_intents WHERE id=$1', [
        grant.id,
      ])
    ).rows[0].outcome,
    'unknown',
  );
  facts.tests.push({
    name: 'independent-after-crash',
    interrupted: initial.attemptId,
    summary,
    contexts,
  });
});
test('platform/project/run slots reserve atomically and rollback quota-denied claims', async () => {
  const a = await setup('/', { concurrency: 1 });
  const b = await setup('/', { concurrency: 1 });
  const c = await setup('/', { concurrency: 1 });
  const limited = new Coordinator({
    db,
    serviceActor: act(),
    vault,
    platformSlots: 2,
    projectSlots: 1,
  });
  await coordinator.tx((client) =>
    coordinator.enqueue(
      client,
      a.run,
      'coordinator',
      'preflight',
      'second',
      null,
    ),
  );
  const leases = await Promise.all([
    limited.claim({ projectId: a.project.id, workerId: 'slot-a' }),
    limited.claim({ projectId: a.project.id, workerId: 'slot-a2' }),
  ]);
  assert.equal(leases.filter(Boolean).length, 1);
  assert.ok(
    await limited.claim({ projectId: b.project.id, workerId: 'slot-b' }),
  );
  assert.equal(
    await limited.claim({ projectId: c.project.id, workerId: 'slot-c' }),
    null,
  );
  const count = (
    await pool.query(
      "SELECT count(*)::integer n FROM budget_reservations WHERE kind='concurrency' AND status='reserved' AND project_id=ANY($1::uuid[])",
      [[a.project.id, b.project.id, c.project.id]],
    )
  ).rows[0].n;
  assert.equal(count, 2);
  for (const s of [a, b, c]) {
    await coordinator.cancel(act(), s.project.id, s.run.id);
    await coordinator.tick(s.project.id);
  }
  facts.tests.push({
    name: 'atomic-slots',
    platformLimit: 2,
    projectLimit: 1,
    runLimit: 1,
    held: count,
  });
});
test('SIGKILL after real browser action before outcome: unknown intent retained and never replayed', async () => {
  const { project, run } = await setup();
  const runtime = await advanceToCases(project, run);
  const child = fork(new URL('./crash-child.mjs', import.meta.url), [], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '',
    observed = null;
  child.stdout.on('data', (x) => (logs += x));
  child.stderr.on('data', (x) => (logs += x));
  const allowed = new Set([
    'claim',
    'work',
    'grant',
    'record',
    'model',
    'finish',
    'stop',
    'heartbeat',
    'poll',
    'requireAnonymousOrInput',
  ]);
  child.on('message', (message) => {
    if (message.event) {
      observed = message;
      return;
    }
    const answer = async () => {
      try {
        if (!allowed.has(message.method)) throw new StorageError('FORBIDDEN');
        const result = await runtime[message.method](...message.args);
        if (child.connected) child.send({ id: message.id, result });
      } catch (error) {
        if (child.connected)
          child.send({
            id: message.id,
            error:
              error instanceof StorageError
                ? error.code
                : 'SERVICE_UNAVAILABLE',
          });
      }
    };
    void answer();
  });
  const exit = await new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  assert.equal(exit.signal, 'SIGKILL', logs);
  assert.equal(observed?.responseStatus, 200);
  await delay(1100);
  await runtime.poll();
  const final = await finishRun(project, run, client(project.id, 'after-kill'));
  assert.equal(final.terminationReason, 'worker_failure');
  const intents = (
    await pool.query(
      "SELECT a.*,j.role FROM action_intents a JOIN jobs j ON j.id=a.task_id WHERE a.run_id=$1 AND j.role='executor'",
      [run.id],
    )
  ).rows;
  assert.equal(intents.length, 1);
  assert.equal(intents[0].outcome, 'unknown');
  const step = (
    await pool.query('SELECT document FROM steps WHERE action_id=$1', [
      intents[0].id,
    ])
  ).rows[0].document;
  assert.equal(step.status, 'unknown');
  facts.tests.push({
    name: 'real-SIGKILL',
    exit,
    observed,
    logs,
    replayed: false,
  });
});
test('expired model reservation is charged conservatively; late reported usage is audit-only and old result rejected', async () => {
  const { project, run } = await setup();
  let ready, release;
  const accepted = new Promise((resolve) => (ready = resolve));
  const late = new Promise((resolve) => (release = resolve));
  const base = createStubAdapter();
  const delayed = {
    ...base,
    async send(input, signal) {
      ready();
      await late;
      return base.send(input, signal);
    },
  };
  const runtime = client(project.id, 'late-model', {
    ...modelOptions,
    adapter: delayed,
  });
  const lease = await runtime.claim(1);
  const pending = runtime.model(proof(lease), 'coordinator', {
    purpose: 'decide',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'DISPATCHED' }] },
    ],
    outputSchema: DECISION_SCHEMA,
    maxOutputTokens: 200,
  });
  const rejected = assert.rejects(
    pending,
    (error) => error.code === 'LEASE_EXPIRED',
  );
  await accepted;
  await delay(1100);
  await runtime.poll();
  const budget = (
    await pool.query('SELECT used FROM run_budgets WHERE run_id=$1', [run.id])
  ).rows[0].used;
  const reserved = (
    await pool.query(
      "SELECT * FROM budget_reservations WHERE run_id=$1 AND kind='model'",
      [run.id],
    )
  ).rows[0];
  assert.equal(reserved.status, 'unknown');
  assert.equal(budget.modelCalls, 1);
  assert.equal(budget.totalTokens, reserved.reserved.totalTokens);
  assert.ok(budget.totalTokens > 18);
  const fresh = await client(project.id, 'fresh-model-worker').claim();
  assert.equal(fresh.fencingToken, lease.fencingToken + 1);
  release();
  await rejected;
  const diagnostic = (
    await pool.query('SELECT * FROM model_requests WHERE run_id=$1', [run.id])
  ).rows[0];
  assert.equal(diagnostic.status, 'unknown');
  assert.equal(diagnostic.redacted_diagnostic.usageSource, 'unknown');
  assert.equal(diagnostic.redacted_diagnostic.lateUsageSource, 'reported');
  assert.equal(
    (await pool.query('SELECT used FROM run_budgets WHERE run_id=$1', [run.id]))
      .rows[0].used.totalTokens,
    budget.totalTokens,
  );
  await coordinator.cancel(act(), project.id, run.id);
  await runtime.poll();
  facts.tests.push({
    name: 'late-model',
    charged: budget,
    lateAudit: diagnostic.redacted_diagnostic,
    oldResultRejected: true,
  });
});
test('clarification CAS resumes saved phase without changing fixed criteria or replaying actions', async () => {
  const { project, run } = await setup();
  const runtime = client(project.id, 'input-cas');
  const lease = await runtime.claim();
  const input = await runtime.input(
    proof(lease),
    'clarification',
    'Acknowledge the unchanged fixed scope',
    60000,
  );
  await errorCode(
    coordinator.resolveClarification(act(), project.id, input.id, 2),
    'VERSION_CONFLICT',
  );
  const resolved = await coordinator.resolveClarification(
    act(),
    project.id,
    input.id,
    1,
  );
  assert.equal(resolved.status, 'resolved');
  const current = await new RunRepository(db, vault).get(
    act(),
    project.id,
    run.id,
  );
  assert.equal(current.status, 'running');
  assert.equal(current.phase, 'preflight');
  assert.equal(current.contextVersion, 1);
  await errorCode(
    coordinator.resolveClarification(act(), project.id, input.id, 1),
    'VERSION_CONFLICT',
  );
  const fresh = await runtime.claim();
  assert.equal(fresh.fencingToken, lease.fencingToken + 1);
  await errorCode(
    runtime.finish(proof(lease), { stage: 'preflight' }),
    'LEASE_EXPIRED',
  );
  await coordinator.cancel(act(), project.id, run.id);
  await runtime.poll();
});
test('budget stop after plan preserves original tried result and independent not_run projection', async () => {
  const { project, run } = await trustedRun('/', 2, { maxModelCalls: 4 });
  const final = await finishRun(project, run);
  assert.equal(final.terminationReason, 'budget_limit');
  assert.equal(final.completion, 'partial');
  const summary = await new RunRepository(db, vault).summary(
    act(),
    project.id,
    run.id,
  );
  assert.equal(summary.planned, 2);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.notRun, 1);
  assert.equal(final.budgetUsed.modelCalls, 4);
  facts.tests.push({ name: 'budget-after-plan', summary });
});
test('one case input deadline blocks only that case; another queued independent case completes with real evidence', async () => {
  const { project, run } = await trustedRun('/', 2);
  const runtime = await advanceToCases(project, run);
  const lease = await runtime.claim();
  const initial = await runtime.work(proof(lease));
  await runtime.input(
    proof(lease),
    'clarification',
    'Need acknowledgment for this case',
    60,
  );
  assert.equal(
    (await new RunRepository(db, vault).get(act(), project.id, run.id)).status,
    'running',
  );
  await delay(90);
  await runtime.poll();
  const final = await finishRun(project, run);
  assert.equal(final.terminationReason, 'input_timeout');
  assert.equal(final.completion, 'partial');
  const summary = await new RunRepository(db, vault).summary(
    act(),
    project.id,
    run.id,
  );
  assert.equal(summary.passed, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.notRun, 0);
  const verdict = (
    await pool.query(
      'SELECT v.document FROM final_valid_verdicts v WHERE v.project_id=$1 AND v.case_id=$2',
      [project.id, initial.definition.id],
    )
  ).rows[0].document;
  assert.equal(verdict.reasonCode, 'INPUT_TIMEOUT');
  facts.tests.push({
    name: 'input-timeout-independent',
    summary,
    criteriaUnchanged: true,
  });
});
