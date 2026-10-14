// T55: run ONLY against a disposable PostgreSQL fixture named localqa-t55-pg.
// Production databases and live workers are intentionally unreachable.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../../orchestrator/dist/index.js';
import { before, after, test } from 'node:test';
import pg from 'pg';
import {
  Database,
  AccountsRepository,
  ProjectRepository,
  LeaseRepository,
  StorageError,
  SecretVault,
  hashPayload,
  migrate,
} from '../dist/index.js';

const connection = process.env.LOCALQA_TEST_DATABASE_URL;
const uri = connection ? new URL(connection) : null;
if (
  !uri ||
  uri.hostname !== 'localqa-t55-pg' ||
  uri.pathname !== '/localqa_t55'
)
  throw new Error('T55_REQUIRES_DISPOSABLE_PG_ONLY');

if (process.argv.includes('--crash-lease-holder')) {
  const projectId = process.argv.at(-1);
  const db = new Database(connection);
  const lease = await new LeaseRepository(db).claim(
    {
      projectId,
      workerId: 't55-crash-holder',
    },
    1,
  );
  if (!lease) process.exit(2);
  // Only the claim acknowledgement is reported; no bearer lease token.
  process.stdout.write(
    JSON.stringify({
      claimedTask: lease.task.id,
      fencingToken: lease.fencingToken,
    }) + '\n',
  );
  // Parent sends SIGKILL after claim has committed. Intentionally do not
  // complete, heartbeat, or release the lease.
  setInterval(() => {}, 60000);
} else {
  let db, root, leases, project, actor;
  const scope = (workerId) => ({ projectId: project.id, workerId });
  const assertStorageCode = (promise, code) =>
    assert.rejects(
      promise,
      (error) => error instanceof StorageError && error.code === code,
    );
  const proofOf = (lease) => ({
    taskId: lease.task.id,
    fencingToken: lease.fencingToken,
    leaseToken: lease.leaseToken,
    contextVersion: lease.contextVersion,
  });
  const limits = {
    concurrency: 2,
    maxCases: 5,
    maxActiveSeconds: 300,
    maxPages: 2,
    maxActions: 20,
    maxModelCalls: 3,
    maxTotalTokens: 1000,
  };
  const seed = async ({
    summary = 'safe-lease-task',
    role = 'executor',
  } = {}) => {
    const runId = randomUUID(),
      taskId = randomUUID();
    await root.query(
      `INSERT INTO runs (id, project_id, creator_id, display_url, status,
      phase, completion, context_version, version, effective_config, budget_used)
      VALUES ($1,$2,$3,'https://fixture.t55.test/','running','execute','none',1,1,$4,$5)`,
      [
        runId,
        project.id,
        actor.userId,
        {
          actionPolicy: 'non_submitting',
          allowedOrigins: ['https://fixture.t55.test'],
          budget: limits,
          models: {},
          knowledgeVersionIds: [],
        },
        {
          activeSeconds: 0,
          actions: 0,
          modelCalls: 0,
          reproductions: 0,
          totalTokens: 0,
        },
      ],
    );
    await root.query(
      'INSERT INTO run_budgets (project_id,run_id,limits,used) VALUES ($1,$2,$3,$4)',
      [project.id, runId, limits, { actions: 0 }],
    );
    await root.query(
      `INSERT INTO jobs (id,project_id,run_id,case_id,unique_key,role,status,attempt,document)
      VALUES ($1,$2,$3,NULL,$4,$5,'queued',1,$6)`,
      [
        taskId,
        project.id,
        runId,
        `t55:${runId}`,
        role,
        {
          id: taskId,
          runId,
          role,
          caseId: null,
          status: 'queued',
          attempt: 1,
          summary,
          elapsedSeconds: 0,
        },
      ],
    );
    return { runId, taskId };
  };
  const expire = async (lease) => {
    await root.query(
      "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [lease.task.id],
    );
    await root.query(
      "UPDATE task_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE task_id=$1 AND fencing_token=$2",
      [lease.task.id, lease.fencingToken],
    );
  };
  before(async () => {
    await migrate(connection);
    db = new Database(connection);
    root = new pg.Client({ connectionString: connection });
    await root.connect();
    const user = await new AccountsRepository(db).bootstrap({
      email: 't55-admin@fixture.test',
      displayName: 'T55 fixture',
      password: randomBytes(24).toString('hex'),
    });
    actor = { userId: user.id };
    project = await new ProjectRepository(db).create(actor, {
      name: 'T55 isolated lease fault fixture',
    });
    leases = new LeaseRepository(db, actor);
  });
  after(async () => {
    await root?.end();
    await db?.close();
  });

  test('T55.1 concurrent recovery requeues one actionless crash, old lease denied, new lease completes', async () => {
    const { taskId } = await seed();
    const first = await leases.claim(scope('t55-old'), 2);
    assert.equal(first.task.id, taskId);
    await expire(first);
    const results = await Promise.all([
      leases.recoverExpired(scope('t55-recovery-a')),
      leases.recoverExpired(scope('t55-recovery-b')),
    ]);
    assert.equal(
      results.reduce((sum, x) => sum + x.requeued, 0),
      1,
    );
    assert.equal(
      results.reduce((sum, x) => sum + x.interrupted, 0),
      0,
    );
    const second = await leases.claim(scope('t55-new'), 4);
    assert.equal(second.task.id, taskId);
    assert.equal(second.fencingToken, first.fencingToken + 1);
    await assertStorageCode(
      leases.heartbeat(scope('t55-old'), proofOf(first)),
      'LEASE_EXPIRED',
    );
    await assertStorageCode(
      leases.complete(scope('t55-old'), proofOf(first), {
        fencingToken: first.fencingToken,
        status: 'succeeded',
        result: {},
        resultHash: hashPayload({}),
      }),
      'LEASE_EXPIRED',
    );
    await leases.complete(scope('t55-new'), proofOf(second), {
      fencingToken: second.fencingToken,
      status: 'succeeded',
      result: {},
      resultHash: hashPayload({}),
    });
    const row = (
      await root.query('SELECT status,fencing_token FROM jobs WHERE id=$1', [
        taskId,
      ])
    ).rows[0];
    assert.equal(row.status, 'succeeded');
    assert.equal(Number(row.fencing_token), second.fencingToken);
    assert.equal(
      (
        await root.query(
          "SELECT count(*)::int count FROM audit_log WHERE action='lease.expired' AND object_id=$1",
          [taskId],
        )
      ).rows[0].count,
      1,
    );
  });

  test('T55.2 unknown action interrupts without replay and charges reserved action budget', async () => {
    const { runId, taskId } = await seed();
    const first = await leases.claim(scope('t55-action'), 2);
    assert.equal(first.task.id, taskId);
    const reservation = randomUUID(),
      intent = randomUUID();
    await root.query(
      `INSERT INTO budget_reservations
      (id,project_id,run_id,task_id,request_id,fencing_token,kind,reserved,status)
      VALUES ($1,$2,$3,$4,$5,$6,'action',$7,'reserved')`,
      [
        reservation,
        project.id,
        runId,
        taskId,
        randomUUID(),
        first.fencingToken,
        { actions: 1 },
      ],
    );
    await root.query('UPDATE run_budgets SET reserved=$2 WHERE run_id=$1', [
      runId,
      { actions: 1 },
    ]);
    await root.query(
      `INSERT INTO action_intents
      (id,project_id,run_id,task_id,fencing_token,context_version,reservation_id,tool_call)
      VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
      [
        intent,
        project.id,
        runId,
        taskId,
        first.fencingToken,
        reservation,
        { name: 'click', args: { target: 'fixture-only' } },
      ],
    );
    await expire(first);
    assert.deepEqual(await leases.recoverExpired(scope('t55-recover-action')), {
      requeued: 0,
      interrupted: 1,
    });
    const job = (
      await root.query('SELECT status FROM jobs WHERE id=$1', [taskId])
    ).rows[0];
    assert.equal(job.status, 'interrupted');
    const action = (
      await root.query('SELECT outcome FROM action_intents WHERE id=$1', [
        intent,
      ])
    ).rows[0];
    assert.equal(action.outcome, 'unknown');
    const reservationResult = (
      await root.query(
        'SELECT status,charged FROM budget_reservations WHERE id=$1',
        [reservation],
      )
    ).rows[0];
    assert.equal(reservationResult.status, 'unknown');
    assert.equal(reservationResult.charged.actions, 1);
    const budget = (
      await root.query(
        'SELECT used,reserved FROM run_budgets WHERE run_id=$1',
        [runId],
      )
    ).rows[0];
    assert.equal(budget.used.actions, 1);
    assert.equal(budget.reserved.actions, 0);
    assert.equal(await leases.claim(scope('t55-after-action'), 2), null);
    await assertStorageCode(
      leases.heartbeat(scope('t55-action'), proofOf(first)),
      'LEASE_EXPIRED',
    );
    assert.deepEqual(await leases.recoverExpired(scope('t55-recover-action')), {
      requeued: 0,
      interrupted: 0,
    });
  });

  test('T55.3 an expired lease on a cancelling run is never resurrected', async () => {
    const { runId, taskId } = await seed();
    const first = await leases.claim(scope('t55-cancel'), 2);
    assert.equal(first.task.id, taskId);
    // Respect the real database optimistic-version trigger during cancellation.
    await root.query(
      "UPDATE runs SET status='cancelling',version=version+1 WHERE id=$1",
      [runId],
    );
    await expire(first);
    assert.deepEqual(await leases.recoverExpired(scope('t55-recover-cancel')), {
      requeued: 0,
      interrupted: 1,
    });
    assert.equal(
      (await root.query('SELECT status FROM jobs WHERE id=$1', [taskId]))
        .rows[0].status,
      'interrupted',
    );
    assert.equal(await leases.claim(scope('t55-cancel-new'), 2), null);
  });

  test('T55.4 actual SIGKILL of a separate lease-holder process is recovered after expiry', async () => {
    const { taskId } = await seed();
    const child = spawn(
      process.execPath,
      [new URL(import.meta.url).pathname, '--crash-lease-holder', project.id],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    try {
      const received = await Promise.race([
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('CLAIM_ACK_TIMEOUT')),
            10000,
          );
          child.stdout.on('data', () => {
            if (output.includes('\n')) {
              clearTimeout(timer);
              resolve(output.split('\n')[0]);
            }
          });
          child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
        }),
        once(child, 'exit').then(() => {
          throw new Error('CHILD_EXITED_BEFORE_CLAIM ' + err.slice(0, 100));
        }),
      ]);
      const ack = JSON.parse(received);
      assert.equal(ack.claimedTask, taskId);
      assert.equal(ack.fencingToken, 1);
      assert.equal(child.kill('SIGKILL'), true);
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, null);
      assert.equal(signal, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 1250));
      assert.deepEqual(await leases.recoverExpired(scope('t55-after-kill')), {
        requeued: 1,
        interrupted: 0,
      });
      const next = await leases.claim(scope('t55-replacement'), 4);
      assert.equal(next.task.id, taskId);
      assert.equal(next.fencingToken, ack.fencingToken + 1);
      await leases.complete(scope('t55-replacement'), proofOf(next), {
        fencingToken: next.fencingToken,
        status: 'succeeded',
        result: {},
        resultHash: hashPayload({}),
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit').catch(() => {});
      }
    }
  });

  test('T55.5 coordinator tick drains cancelled crash and publishes one terminal report', async () => {
    const isolated = await new ProjectRepository(db).create(actor, {
      name: 'T55 dedicated coordinator convergence fixture',
    });
    const runId = randomUUID(),
      taskId = randomUUID();
    const example = JSON.parse(
      readFileSync(
        new URL('../../../docs/examples/report.sample.json', import.meta.url),
        'utf8',
      ),
    ).run;
    const config = {
      ...example.effectiveConfig,
      allowedOrigins: ['https://fixture.t55.test'],
      actionPolicy: 'non_submitting',
    };
    const counters = {
      activeSeconds: 0,
      actions: 0,
      modelCalls: 0,
      reproductions: 0,
      totalTokens: 0,
    };
    await root.query(
      `INSERT INTO runs (id, project_id, creator_id, display_url, status,
      phase, completion, context_version, version, effective_config, budget_used)
      VALUES ($1,$2,$3,'https://fixture.t55.test/','running','execute','none',1,1,$4,$5)`,
      [runId, isolated.id, actor.userId, config, counters],
    );
    await root.query(
      'INSERT INTO run_budgets (project_id,run_id,limits,used) VALUES ($1,$2,$3,$4)',
      [isolated.id, runId, config.budget, counters],
    );
    await root.query(
      `INSERT INTO jobs (id,project_id,run_id,case_id,unique_key,role,status,attempt,document)
      VALUES ($1,$2,$3,NULL,$4,'executor','queued',1,$5)`,
      [
        taskId,
        isolated.id,
        runId,
        `t55:coordinator:${runId}`,
        {
          id: taskId,
          runId,
          role: 'executor',
          caseId: null,
          status: 'queued',
          attempt: 1,
          summary: 'execute',
          elapsedSeconds: 0,
        },
      ],
    );
    const vaultDir = await mkdtemp(join(tmpdir(), 'localqa-t55-'));
    let vault;
    try {
      const keyFile = join(vaultDir, 'fixture-key.json');
      await writeFile(
        keyFile,
        JSON.stringify({
          activeVersion: 1,
          keys: { 1: randomBytes(32).toString('base64') },
        }),
        { mode: 0o600 },
      );
      vault = await SecretVault.fromProtectedFile(keyFile);
      const coordinator = new Coordinator({ db, vault, serviceActor: actor });
      const workerScope = {
        projectId: isolated.id,
        workerId: 't55-cancel-crash',
      };
      const acquired = await coordinator.leases.claim(workerScope, 2);
      assert.equal(acquired.task.id, taskId);
      const pending = await coordinator.cancel(actor, isolated.id, runId);
      assert.equal(pending.status, 'cancelling');
      await expire(acquired);
      await coordinator.tick(isolated.id);
      const status = (
        await root.query(
          'SELECT status,termination_reason FROM runs WHERE id=$1',
          [runId],
        )
      ).rows[0];
      assert.equal(status.status, 'cancelled');
      assert.equal(status.termination_reason, 'user_cancel');
      assert.equal(
        (await root.query('SELECT status FROM jobs WHERE id=$1', [taskId]))
          .rows[0].status,
        'interrupted',
      );
      const counts = async () =>
        (
          await root.query(
            "SELECT type,count(*)::int n FROM run_events WHERE run_id=$1 AND type IN ('report.ready','run.finished') GROUP BY type",
            [runId],
          )
        ).rows;
      assert.deepEqual(
        Object.fromEntries((await counts()).map((r) => [r.type, r.n])),
        { 'report.ready': 1, 'run.finished': 1 },
      );
      await coordinator.tick(isolated.id);
      assert.deepEqual(
        Object.fromEntries((await counts()).map((r) => [r.type, r.n])),
        { 'report.ready': 1, 'run.finished': 1 },
      );
      await assertStorageCode(
        coordinator.leases.heartbeat(workerScope, proofOf(acquired)),
        'LEASE_EXPIRED',
      );
    } finally {
      vault?.dispose();
      await rm(vaultDir, { recursive: true, force: true });
    }
  });
}
