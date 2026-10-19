// Real PostgreSQL: exercise production grant/finish writes with all database
// guards enabled. An isolated Docker database is removed after the test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AccountsRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  SecretVault,
  migrate,
} from '@localqa/storage';
import { DEFAULT_LIMITS, smokeCase } from '@localqa/domain';
import { ArtifactStore, Coordinator, RuntimeClient } from '../dist/index.js';
import { mergeSessionFindings } from '../dist/session-findings.js';

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
  'replay metadata persists through production writes with PostgreSQL guards enabled',
  { timeout: 120000 },
  async (t) => {
    const scratch = mkdtempSync(join(tmpdir(), 'localqa-replay-link-'));
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
      let migrated = false;
      for (let i = 0; i < 60; i++) {
        try {
          await migrate(
            connection,
            new URL('../../storage/migrations/', import.meta.url),
          );
          migrated = true;
          break;
        } catch {
          await delay(200);
        }
      }
      assert.ok(migrated, 'isolated database migrations apply');
      db = new Database(connection);
      const vault = new SecretVault(1, new Map([[1, randomBytes(32)]]));
      const owner = await new AccountsRepository(db).bootstrap({
        email: 'replay@localqa.test',
        displayName: 'Replay test',
        password: 'ReplayFixtureOnly_123!',
      });
      const actor = { userId: owner.id };
      for (const scenario of [
        'available',
        'degraded',
        'missing',
        'static',
        'foreign',
        'wrong-kind',
      ]) {
        const project = await new ProjectRepository(db).create(actor, {
          name: `Replay metadata ${scenario}`,
        });
        const models = new ModelRepository(db, vault);
        const model = await models.create(actor, {
          name: 'Unused fixture',
          endpoint: 'https://unused.example.test',
          configuredModelId: 'fixture',
          adapter: 'openai_compatible',
          dataBoundary: 'internal',
        });
        await models.grant(actor, project.id, model.id);
        const config = {
          allowedOrigins: ['https://fixture.test'],
          actionPolicy: 'non_submitting',
          budget: { ...DEFAULT_LIMITS, maxActiveSeconds: 1800 },
          environmentVersion: null,
          authProfileVersion: null,
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
        const coordinator = new Coordinator({ db, vault, serviceActor: actor });
        const definition = smokeCase(
          { id: randomUUID(), projectId: project.id },
          'https://fixture.test/login',
        );
        const run = await coordinator.start(
          actor,
          { projectId: project.id, targetUrl: 'https://fixture.test/login' },
          config,
          randomUUID(),
          [definition],
        );
        const runtime = new RuntimeClient(
          coordinator,
          { projectId: project.id, workerId: 'replay-integration' },
          new ArtifactStore(join(scratch, 'artifacts')),
        );
        const preflight = await runtime.claim();
        assert.equal(preflight.task.summary, 'preflight');
        await runtime.finish(proof(preflight), {
          stage: 'preflight',
          checked: true,
        });
        await coordinator.tick(project.id);
        const executor = await runtime.claim();
        assert.equal(executor.task.role, 'executor');
        await t.test(
          'Step.thought is inserted and preserved on settlement',
          async () => {
            const grant = await runtime.grant(
              proof(executor),
              { name: 'observe', args: {} },
              undefined,
              '检查当前页面是否出现错误提示。',
            );
            assert.equal(grant.step.thought, '检查当前页面是否出现错误提示。');
            await runtime.record(proof(executor), grant, 'succeeded', null);
            const step = await coordinator.tx(
              async (client) =>
                (
                  await client.query('SELECT document FROM steps WHERE id=$1', [
                    grant.step.id,
                  ])
                ).rows[0].document,
            );
            assert.equal(step.thought, grant.step.thought);
            assert.equal(step.status, 'succeeded');
            assert.equal(step.seq, grant.step.seq);
            assert.equal(step.taskId, executor.task.id);
          },
        );
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
        const originalEvidence = await upload(
          executor,
          'screenshot',
          Buffer.from('original-fixture-evidence'),
        );
        const foreignRecording =
          scenario === 'foreign'
            ? await upload(executor, 'rrweb', gzipSync(Buffer.from('[]')))
            : null;
        const results = (artifact) =>
          definition.criteria.map((criterion, index) => ({
            criterionId: criterion.id,
            result: index === 0 ? 'failed' : 'passed',
            reason: 'fixture observation',
            evidenceRefs: [artifact.id],
          }));
        const report = {
          status: 'issue_found',
          summary: '入口失败已观察到',
          verified: [],
          gaps: [],
          criteria: [],
          bug: { title: '入口错误', expected: '可进入', actual: '错误页' },
        };
        await runtime.finish(
          proof(executor),
          { stage: 'execute', oracle: 'agent_report', agentReport: report },
          results(originalEvidence),
        );
        const finding = await coordinator.tx(
          async (client) =>
            (
              await client.query(
                'SELECT id,document FROM findings WHERE run_id=$1',
                [run.id],
              )
            ).rows[0],
        );
        assert.ok(finding);
        if (scenario === 'static')
          await coordinator.tx((client) =>
            client.query(
              `UPDATE findings SET kind='static',version=version+1,document=jsonb_set(jsonb_set(document,'{kind}','"static"'),'{version}',to_jsonb(version+1)) WHERE id=$1`,
              [finding.id],
            ),
          );
        await coordinator.tick(project.id);
        const reproducer = await runtime.claim();
        assert.equal(reproducer.task.role, 'reproducer');
        const grant = await runtime.grant(
          proof(reproducer),
          { name: 'observe', args: {} },
          undefined,
          '在独立浏览器核对错误页。',
        );
        await runtime.record(proof(reproducer), grant, 'succeeded', null);
        const evidence = await upload(
          reproducer,
          'screenshot',
          Buffer.from('independent-reproduction-evidence'),
        );
        const rrweb =
          scenario === 'missing'
            ? null
            : await upload(reproducer, 'rrweb', gzipSync(Buffer.from('[]')));
        const taskRecording = rrweb
          ? {
              taskId: reproducer.task.id,
              status: scenario === 'degraded' ? 'degraded' : 'available',
              rrwebArtifactId:
                foreignRecording?.id ??
                (scenario === 'wrong-kind' ? evidence.id : rrweb.id),
              consoleArtifactId: null,
              networkArtifactId: null,
              startedAt: new Date(
                Date.parse(grant.step.createdAt) - 5000,
              ).toISOString(),
              endedAt: new Date().toISOString(),
              viewport: { width: 800, height: 600 },
              error: null,
            }
          : null;
        await t.test(
          `${scenario}: confirmation writes recording with all immutable/evidence guards enabled`,
          async () => {
            await runtime.finish(
              proof(reproducer),
              {
                stage: 'reproduce',
                oracle: 'agent_report',
                agentReport: {
                  ...report,
                  reproStepActions: [{ index: 1, seq: grant.step.seq }],
                },
                taskRecording,
              },
              results(evidence),
            );
            const document = await coordinator.tx(
              async (client) =>
                (
                  await client.query(
                    'SELECT document FROM findings WHERE id=$1',
                    [finding.id],
                  )
                ).rows[0].document,
            );
            assert.equal(document.status, 'confirmed');
            assert.ok(document.reproductionRef);
            if (
              ['missing', 'static', 'foreign', 'wrong-kind'].includes(scenario)
            )
              assert.equal(document.recording, null);
            else {
              assert.equal(
                document.recording.reproductionId,
                document.reproductionRef,
              );
              assert.equal(document.recording.taskId, reproducer.task.id);
              assert.equal(document.recording.steps[0].index, 1);
              const settled = await coordinator.tx(
                async (client) =>
                  (
                    await client.query(
                      'SELECT document FROM steps WHERE id=$1',
                      [grant.step.id],
                    )
                  ).rows[0].document,
              );
              assert.equal(document.recording.steps[0].at, settled.finishedAt);
              const retained = await coordinator.tx((client) =>
                client.query(
                  "SELECT 1 FROM artifact_references WHERE ref_kind='finding' AND ref_id=$1 AND artifact_id=$2",
                  [finding.id, rrweb.id],
                ),
              );
              assert.equal(retained.rowCount, 1);
            }
            if (scenario === 'available') {
              const duplicateId = randomUUID();
              await coordinator.tx((client) =>
                client.query(
                  `INSERT INTO findings(id,project_id,run_id,case_id,kind,status,original_attempt_id,criteria_hash,fingerprint,expected_source,version,document)
           SELECT $2::uuid,project_id,run_id,case_id,kind,'suspected',original_attempt_id,criteria_hash,$3,expected_source,1,
             document||jsonb_build_object('id',$2::text,'status','suspected','version',1,'reproductionRef',NULL,'recording',NULL)
           FROM findings WHERE id=$1`,
                  [finding.id, duplicateId, randomUUID()],
                ),
              );
              await coordinator.tx((client) =>
                mergeSessionFindings(client, run, [
                  {
                    findingId: duplicateId,
                    sameAs: finding.id,
                    reason: 'same observable failure',
                  },
                ]),
              );
              const merged = await coordinator.tx(
                async (client) =>
                  (
                    await client.query(
                      'SELECT document FROM findings WHERE id=$1',
                      [finding.id],
                    )
                  ).rows[0].document,
              );
              assert.deepEqual(merged.recording, document.recording);
              assert.equal(merged.reproductionRef, document.reproductionRef);
            }
            // Confirmation cannot be "fixed" by mutating its immutable verdict.
            await assert.rejects(
              coordinator.tx((client) =>
                client.query(
                  "UPDATE verdicts SET document=jsonb_set(document,'{summary}','\"tampered\"') WHERE attempt_id IN (SELECT id FROM case_attempts WHERE task_id=$1)",
                  [reproducer.task.id],
                ),
              ),
              (error) => error.code === 'VALIDATION_ERROR',
            );
          },
        );
      }
    } finally {
      if (db) await db.close();
      if (container) docker('rm', '--force', '--volumes', container);
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
