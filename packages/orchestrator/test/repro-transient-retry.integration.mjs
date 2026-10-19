// Real PostgreSQL, all guards enabled. Run inside Colima's node:24 container
// with --network host and Docker socket/CLI mounts (no model or remote site).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AccountsRepository,
  ConfigurationRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  SecretVault,
  migrate,
  runDTO,
} from '@localqa/storage';
import { DEFAULT_LIMITS, smokeCase } from '@localqa/domain';
import { ArtifactStore, Coordinator, RuntimeClient } from '../dist/index.js';

const docker = (...args) => {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0)
    throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const proof = (lease) => ({
  taskId: lease.task.id,
  fencingToken: lease.fencingToken,
  leaseToken: lease.leaseToken,
  contextVersion: lease.contextVersion,
});

test(
  'transient reproduction retry and safe persisted failure causes',
  { timeout: 120000 },
  async (t) => {
    const scratch = mkdtempSync(join(tmpdir(), 'localqa-repro-grace-'));
    let container;
    let db;
    try {
      const password = randomBytes(24).toString('hex');
      const env = join(scratch, 'postgres.env');
      writeFileSync(
        env,
        `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
        { mode: 0o600 },
      );
      container = docker(
        'run',
        '--detach',
        '--publish',
        '127.0.0.1::5432',
        '--env-file',
        env,
        'postgres:18-alpine',
      );
      const port = docker('port', container, '5432/tcp').split(':').at(-1);
      const connection = `postgresql://localqa:${password}@127.0.0.1:${port}/localqa`;
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try {
          await migrate(
            connection,
            new URL('../../storage/migrations/', import.meta.url),
          );
          ready = true;
          break;
        } catch {
          await delay(200);
        }
      }
      assert.ok(ready);
      db = new Database(connection);
      const vault = new SecretVault(1, new Map([[1, randomBytes(32)]]));
      const owner = await new AccountsRepository(db).bootstrap({
        email: 'grace@localqa.test',
        displayName: 'Grace fixture',
        password: 'OnlyLocalFixture_123!',
      });
      const actor = { userId: owner.id };
      const models = new ModelRepository(db, vault);
      const model = await models.create(actor, {
        name: 'Unused model',
        endpoint: 'https://unused.example.test',
        configuredModelId: 'fixture',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
      });
      const coordinator = new Coordinator({
        db,
        vault,
        serviceActor: actor,
        platformSlots: 10,
        projectSlots: 10,
      });
      const sql = (query, params = []) =>
        coordinator.tx((client) => client.query(query, params));
      async function setup({
        project,
        exclusive = false,
        session = false,
      } = {}) {
        project ??= await new ProjectRepository(db).create(actor, {
          name: `Reproduction grace ${randomUUID()}`,
        });
        await models.grant(actor, project.id, model.id);
        const profile = exclusive
          ? await new ConfigurationRepository(db, vault).createAuthProfile(
              actor,
              project.id,
              {
                name: 'Exclusive fixture',
                mode: 'form',
                allowedOrigins: ['https://fixture.test'],
                sharingPolicy: 'exclusive_run',
                formConfig: {
                  loginUrl: 'https://fixture.test/login',
                  detectionMode: 'ai',
                },
                secretInput: {
                  username: 'fixture-only',
                  password: 'fixture-only-value',
                },
              },
            )
          : null;
        const config = {
          allowedOrigins: ['https://fixture.test'],
          actionPolicy: 'non_submitting',
          budget: { ...DEFAULT_LIMITS, maxActiveSeconds: 1800 },
          environmentVersion: null,
          authProfileVersion: profile?.version ?? null,
          knowledgeVersionIds: [],
          models: Object.fromEntries(
            [
              'coordinator',
              'explorer',
              'executor',
              'assertion',
              'reproducer',
            ].map((role) => [
              role,
              { profileId: model.id, version: model.version },
            ]),
          ),
        };
        const definition = smokeCase(
          { id: randomUUID(), projectId: project.id },
          'https://fixture.test/login',
        );
        const run = await coordinator.start(
          actor,
          {
            projectId: project.id,
            targetUrl: 'https://fixture.test/login',
            ...(profile ? { authProfileId: profile.id } : {}),
          },
          config,
          randomUUID(),
          [definition],
        );
        if (session)
          await coordinator.tx((client) =>
            coordinator.sessions.initialize(client, run, 'Grace fixture'),
          );
        const scope = {
          projectId: project.id,
          workerId: `grace-${randomUUID()}`,
        };
        const runtime = new RuntimeClient(
          coordinator,
          scope,
          new ArtifactStore(join(scratch, 'artifacts')),
        );
        const preflight = await runtime.claim();
        assert.equal(preflight.task.summary, 'preflight');
        await runtime.finish(proof(preflight), {
          stage: 'preflight',
          checked: true,
        });
        await coordinator.tick(project.id);
        const enqueue = (role, stage, extra = {}) =>
          coordinator.tx((client) =>
            coordinator.enqueue(
              client,
              run,
              role,
              stage,
              randomUUID(),
              null,
              1,
              extra,
            ),
          );
        const row = () =>
          coordinator.tx((client) => runDTO(client, project.id, run.id));
        const upload = async (lease, kind, bytes) =>
          runtime.upload(
            proof(lease),
            {
              id: randomUUID(),
              projectId: project.id,
              runId: run.id,
              taskId: lease.task.id,
              caseId: definition.id,
              stepId: null,
              snapshotId: null,
              kind,
              status: 'available',
              bytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              contentUrl: null,
              redaction: 'applied',
              error: null,
              createdAt: new Date().toISOString(),
            },
            bytes,
          );
        const results = (artifact) =>
          definition.criteria.map((criterion, i) => ({
            criterionId: criterion.id,
            result: i === 0 ? 'failed' : 'passed',
            reason: 'fixture observation',
            evidenceRefs: [artifact.id],
          }));
        const report = {
          status: 'issue_found',
          summary: 'Independent failure',
          verified: [],
          gaps: [],
          criteria: [],
          bug: {
            title: 'Fixture failure',
            expected: 'Entry visible',
            actual: 'Error page',
          },
        };
        return {
          run,
          definition,
          runtime,
          scope,
          enqueue,
          row,
          upload,
          results,
          report,
          profile,
          project,
        };
      }

      async function candidate() {
        const f = await setup();
        const original = await f.runtime.claim();
        await f.runtime.work(proof(original));
        const evidence = await f.upload(
          original,
          'screenshot',
          Buffer.from('original'),
        );
        await f.runtime.finish(
          proof(original),
          {
            stage: 'execute',
            oracle: 'agent_report',
            agentReport: f.report,
          },
          f.results(evidence),
        );
        await coordinator.tick(f.project.id);
        const first = await f.runtime.claim();
        assert.equal(first.task.role, 'reproducer');
        await f.runtime.work(proof(first));
        const finding = async () =>
          (
            await sql('SELECT document FROM findings WHERE run_id=$1', [
              f.run.id,
            ])
          ).rows[0].document;
        const attempts = async () =>
          (
            await sql(
              "SELECT * FROM jobs WHERE run_id=$1 AND role='reproducer' ORDER BY attempt",
              [f.run.id],
            )
          ).rows;
        const fail = async (
          lease,
          code = 'MODEL_FAILURE',
          outcome = 'malformed',
        ) =>
          f.runtime.finish(
            proof(lease),
            {
              stage: 'reproduce',
              oracle: 'agent_report',
              failure: {
                code,
                detail: `${outcome}: SECRET model/page/password must never persist`,
              },
              agentReport: {
                status: 'blocked',
                summary: 'Blocked fixture',
                verified: [],
                gaps: [],
                criteria: [],
                bug: null,
              },
            },
            f.definition.criteria.map((c) => ({
              criterionId: c.id,
              result: 'not_evaluated',
              reason: code,
              evidenceRefs: [],
            })),
            code,
          );
        return { ...f, first, finding, attempts, fail };
      }
      await t.test(
        'MODEL_FAILURE retries once, same-run priority and successful second recording; charges 2',
        async () => {
          const f = await candidate();
          const older = await f.enqueue('explorer', 'explore');
          await f.fail(f.first);
          await f.fail(f.first); // Same submitted payload remains idempotent after diagnostic normalization.
          assert.equal((await f.finding()).status, 'suspected');
          assert.equal((await f.attempts()).length, 2);
          const second = await f.runtime.claim();
          assert.equal(second.task.role, 'reproducer');
          assert.equal(second.task.attempt, 2);
          assert.notEqual(second.task.id, f.first.task.id);
          assert.equal(
            (await sql('SELECT status FROM jobs WHERE id=$1', [older])).rows[0]
              .status,
            'queued',
          );
          await f.runtime.work(proof(second));
          const screenshot = await f.upload(
            second,
            'screenshot',
            Buffer.from('independent'),
          );
          const rrweb = await f.upload(
            second,
            'rrweb',
            gzipSync(Buffer.from('[]')),
          );
          await f.runtime.finish(
            proof(second),
            {
              stage: 'reproduce',
              oracle: 'agent_report',
              agentReport: f.report,
              taskRecording: {
                taskId: second.task.id,
                status: 'available',
                rrwebArtifactId: rrweb.id,
                consoleArtifactId: null,
                networkArtifactId: null,
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                viewport: null,
                error: null,
              },
            },
            f.results(screenshot),
          );
          assert.equal((await f.finding()).status, 'confirmed');
          assert.equal((await f.finding()).recording.taskId, second.task.id);
          assert.equal((await f.row()).budgetUsed.reproductions, 2);
          assert.equal((await f.attempts()).length, 2);
        },
      );
      await t.test(
        'second transient failure blocks, keeps both reasons in finding/reproduction; safe detail',
        async () => {
          const f = await candidate();
          await f.fail(f.first);
          const second = await f.runtime.claim();
          await f.runtime.work(proof(second));
          await f.fail(second, 'WORKER_FAILURE', 'provider_error');
          assert.equal((await f.finding()).status, 'blocked');
          for (const code of ['MODEL_FAILURE', 'WORKER_FAILURE'])
            assert.match((await f.finding()).actual, new RegExp(code));
          const reproductions = (
            await sql(
              'SELECT document FROM reproductions WHERE run_id=$1 AND task_id=$2',
              [f.run.id, second.task.id],
            )
          ).rows;
          assert.match(
            reproductions[0].document.summary,
            /复现尝试 1.*MODEL_FAILURE[\s\S]*复现尝试 2.*WORKER_FAILURE/,
          );
          const jobs = await f.attempts();
          assert.equal(jobs.length, 2);
          for (const job of jobs) {
            assert.ok(job.result.failure.detail.length <= 300);
            assert.doesNotMatch(job.result.failure.detail, /SECRET|password/);
          }
          assert.match(jobs[0].result.failure.detail, /修复后仍不符合 Schema/);
          assert.equal((await f.row()).budgetUsed.reproductions, 2);
          await coordinator.tick(f.project.id);
          assert.equal((await f.attempts()).length, 2);
        },
      );
      for (const code of [
        'AUTH_FAILED',
        'POLICY_DENIED',
        'MODEL_NOT_CONFIGURED',
        'MODEL_BILLING_REQUIRED',
      ]) {
        await t.test(`${code} is deterministic and never retried`, async () => {
          const f = await candidate();
          await f.fail(f.first, code, 'none');
          assert.equal((await f.finding()).status, 'blocked');
          assert.equal((await f.attempts()).length, 1);
          assert.equal((await f.row()).budgetUsed.reproductions, 1);
        });
      }
      await t.test(
        'second deterministic agent report retains both attempts without another retry',
        async () => {
          const f = await candidate();
          await f.fail(f.first);
          const second = await f.runtime.claim();
          await f.runtime.work(proof(second));
          await f.runtime.finish(
            proof(second),
            {
              stage: 'reproduce',
              oracle: 'agent_report',
              agentReport: {
                status: 'blocked',
                summary: '测试账号没有该功能权限',
                verified: [],
                gaps: [],
                criteria: [],
                bug: null,
              },
            },
            f.definition.criteria.map((c) => ({
              criterionId: c.id,
              result: 'not_evaluated',
              reason: 'Permission missing',
              evidenceRefs: [],
            })),
          );
          const finding = await f.finding();
          assert.equal(finding.status, 'blocked');
          assert.match(
            finding.actual,
            /复现尝试 1.*MODEL_FAILURE[\s\S]*复现尝试 2.*REPRODUCTION_BLOCKED[\s\S]*测试账号没有该功能权限/,
          );
          assert.equal((await f.attempts()).length, 2);
          assert.equal((await f.row()).budgetUsed.reproductions, 2);
        },
      );
      await t.test('refused model outcome never retries', async () => {
        const f = await candidate();
        await f.fail(f.first, 'MODEL_FAILURE', 'refused');
        assert.equal((await f.finding()).status, 'blocked');
        assert.equal((await f.attempts()).length, 1);
      });
      await t.test('conclusive not reproduced never retries', async () => {
        const f = await candidate();
        const evidence = await f.upload(
          f.first,
          'screenshot',
          Buffer.from('passed evidence'),
        );
        await f.runtime.finish(
          proof(f.first),
          {
            stage: 'reproduce',
            oracle: 'agent_report',
            agentReport: { ...f.report, status: 'passed', bug: null },
          },
          f.results(evidence).map((r) => ({ ...r, result: 'passed' })),
        );
        assert.equal((await f.finding()).status, 'unconfirmed');
        assert.equal((await f.attempts()).length, 1);
      });
      for (const stop of [
        'reproductions',
        'finalize',
        'active-time',
        'budget-limit',
      ]) {
        await t.test(`${stop} prevents retry`, async () => {
          const f = await candidate();
          if (stop === 'reproductions')
            await sql(
              "UPDATE run_budgets SET limits=jsonb_set(limits,'{maxReproductions}','1') WHERE run_id=$1",
              [f.run.id],
            );
          if (stop === 'finalize')
            await coordinator.tx(async (c) =>
              coordinator.change(c, await f.row(), 'running', 'finalize'),
            );
          if (stop === 'active-time' || stop === 'budget-limit') {
            await coordinator.tx((c) =>
              coordinator.sessions.initialize(c, f.run, 'Grace retry fixture'),
            );
            await sql(
              "UPDATE jobs SET started_at=clock_timestamp()-interval '10 seconds' WHERE id=$1",
              [f.first.task.id],
            );
            await sql(
              "UPDATE run_budgets SET used=jsonb_set(used,'{activeSeconds}',limits->'maxActiveSeconds') WHERE run_id=$1",
              [f.run.id],
            );
            if (stop === 'budget-limit')
              assert.equal(
                (await f.runtime.heartbeat(proof(f.first))).cancelRequested,
                false,
              );
          }
          await f.fail(f.first);
          assert.equal((await f.finding()).status, 'blocked');
          assert.equal((await f.attempts()).length, 1);
          assert.equal((await f.row()).budgetUsed.reproductions, 1);
        });
      }
      await t.test(
        'lease loss retries a fresh reproducer, never executor recover; second loss blocks',
        async () => {
          const f = await candidate();
          for (let i = 0; i < 2; i++) {
            const lease = i === 0 ? f.first : await f.runtime.claim();
            assert.equal(lease.task.role, 'reproducer');
            if (i) await f.runtime.work(proof(lease));
            await sql(
              "UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
              [lease.task.id],
            );
            await coordinator.tick(f.project.id);
            assert.equal(
              (await f.finding()).status,
              i ? 'blocked' : 'suspected',
            );
          }
          assert.equal((await f.attempts()).length, 2);
          assert.match(
            (await f.finding()).actual,
            /复现尝试 1.*LEASE_EXPIRED[\s\S]*复现尝试 2.*LEASE_EXPIRED/,
          );
          assert.equal(
            (
              await sql(
                "SELECT 1 FROM jobs WHERE run_id=$1 AND document->>'summary'='recover'",
                [f.run.id],
              )
            ).rowCount,
            0,
          );
          assert.equal((await f.row()).budgetUsed.reproductions, 2);
        },
      );
      for (const [code, reason, outcome] of [
        ['WORKER_FAILURE', 'worker_failure', undefined],
        ['MODEL_TIMEOUT', 'model_failure', 'timeout'],
      ]) {
        await t.test(
          `stopped ${code} retains original code and retries`,
          async () => {
            const f = await candidate();
            await f.runtime.stop(proof(f.first), reason, { code, outcome });
            assert.equal((await f.finding()).status, 'suspected');
            const attempts = await f.attempts();
            assert.equal(attempts.length, 2);
            assert.equal(attempts[0].result.failure.code, code);
            if (outcome)
              assert.match(attempts[0].result.failure.detail, /^timeout:/);
          },
        );
      }
      await t.test(
        'explicit worker interruption retries, cancellation does not',
        async () => {
          const f = await candidate();
          await coordinator.stopTask(f.scope, proof(f.first), 'worker_failure');
          assert.equal((await f.finding()).status, 'suspected');
          assert.equal((await f.attempts()).length, 2);
          assert.equal((await f.row()).terminationReason, null);
          const g = await candidate();
          await coordinator.tx(async (c) => {
            const run = await runDTO(c, g.project.id, g.run.id);
            const current = await coordinator.change(c, run, 'cancelling');
            const job = (
              await c.query('SELECT * FROM jobs WHERE id=$1', [g.first.task.id])
            ).rows[0];
            await coordinator.interrupt(c, current, job, 'cancelled');
          });
          assert.equal((await g.finding()).status, 'blocked');
          assert.equal((await g.attempts()).length, 1);
        },
      );
    } finally {
      await db?.close();
      if (container) docker('rm', '--force', container);
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
