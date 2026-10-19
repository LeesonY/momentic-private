// Real PostgreSQL: a stopped browser task may attach its already-captured
// recording exactly once, fenced by the last lease, without changing status.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'a stopped browser task attaches recording evidence once with the last fence',
  { timeout: 120000 },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'localqa-stopped-recording-'));
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
        email: 'stopped-recording@localqa.test',
        displayName: 'Stopped recording test',
        password: 'StoppedRecordingFixture_123!',
      });
      const actor = { userId: owner.id };
      const project = await new ProjectRepository(db).create(actor, {
        name: 'Stopped recording',
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
      const artifacts = new ArtifactStore(join(scratch, 'artifacts'));
      const runtime = new RuntimeClient(
        coordinator,
        { projectId: project.id, workerId: 'stopped-recording-worker' },
        artifacts,
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
      const executionProof = proof(executor);

      const bytesFor = (kind) =>
        kind === 'rrweb'
          ? gzipSync(
              Buffer.from(
                JSON.stringify([
                  {
                    type: 4,
                    data: { href: 'https://fixture.test/' },
                    timestamp: 1,
                  },
                  { type: 2, data: { node: {} }, timestamp: 2 },
                ]),
              ),
            )
          : Buffer.from(
              JSON.stringify([
                kind === 'console'
                  ? {
                      at: new Date().toISOString(),
                      level: 'log',
                      source: 'console',
                      text: 'ok',
                    }
                  : {
                      at: new Date().toISOString(),
                      method: 'GET',
                      url: 'https://fixture.test/',
                      resourceType: 'document',
                      status: 200,
                      failed: false,
                      durationMs: 1,
                    },
              ]),
            );
      const artifactFor = (kind, bytes) => ({
        id: randomUUID(),
        projectId: project.id,
        runId: run.id,
        taskId: executor.task.id,
        caseId: definition.id,
        stepId: null,
        snapshotId: null,
        kind,
        status: 'degraded',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentUrl: null,
        redaction: 'applied',
        error: null,
        createdAt: new Date().toISOString(),
      });
      const entries = ['rrweb', 'console', 'network'].map((kind) => {
        const bytes = bytesFor(kind);
        return { artifact: artifactFor(kind, bytes), bytes };
      });
      const recording = {
        taskId: executor.task.id,
        status: 'degraded',
        rrwebArtifactId: entries[0].artifact.id,
        consoleArtifactId: entries[1].artifact.id,
        networkArtifactId: entries[2].artifact.id,
        startedAt: '2026-10-18T06:53:00.000Z',
        endedAt: '2026-10-18T06:53:01.000Z',
        viewport: { width: 1280, height: 720 },
        error: '任务被中止（CANCELLED），录像只到中止时刻',
      };

      await assert.rejects(
        runtime.saveStoppedRecording(executionProof, entries, recording),
        (error) => error.code === 'POLICY_DENIED',
        'a healthy running task is not writable',
      );
      await assert.rejects(
        runtime.saveStoppedRecording(
          { ...executionProof, fencingToken: executionProof.fencingToken - 1 },
          entries,
          recording,
        ),
        (error) => error.code === 'LEASE_EXPIRED',
        'an older fence is rejected',
      );
      const screenshot = Buffer.from('not-recording-evidence');
      await assert.rejects(
        runtime.saveStoppedRecording(
          executionProof,
          [
            {
              artifact: artifactFor('screenshot', screenshot),
              bytes: screenshot,
            },
          ],
          recording,
        ),
        (error) => error.code === 'VALIDATION_ERROR',
        'only recording kinds are accepted',
      );

      await coordinator.cancel(actor, project.id, run.id);
      await coordinator.tick(project.id);
      await runtime.saveStoppedRecording(executionProof, entries, recording);
      await assert.rejects(
        runtime.saveStoppedRecording(executionProof, entries, recording),
        (error) => error.code === 'IDEMPOTENCY_CONFLICT',
        'recording metadata is written once',
      );

      const stored = await coordinator.tx(async (client) => ({
        job: (
          await client.query('SELECT status,result FROM jobs WHERE id=$1', [
            executor.task.id,
          ])
        ).rows[0],
        artifacts: (
          await client.query(
            "SELECT id,document FROM artifacts WHERE task_id=$1 ORDER BY document->>'kind'",
            [executor.task.id],
          )
        ).rows,
        refs: (
          await client.query(
            "SELECT artifact_id FROM artifact_references WHERE ref_kind='task' AND ref_id=$1",
            [executor.task.id],
          )
        ).rows,
      }));
      assert.equal(stored.job.status, 'cancelled');
      assert.deepEqual(stored.job.result.taskRecording, recording);
      assert.equal(stored.artifacts.length, 3);
      assert.deepEqual(
        stored.artifacts.map((row) => row.document.kind),
        ['console', 'network', 'rrweb'],
      );
      assert.equal(stored.refs.length, 3);
      for (const entry of entries)
        assert.equal(
          readFileSync(
            join(scratch, 'artifacts', project.id, run.id, entry.artifact.id),
          ).equals(Buffer.from(entry.bytes)),
          true,
        );
      // A normal finish still stores available recording metadata and is not
      // writable through the stopped-recording supplement.
      const normalDefinition = smokeCase(
        { id: randomUUID(), projectId: project.id },
        'https://fixture.test/login',
      );
      const normalRun = await coordinator.start(
        actor,
        { projectId: project.id, targetUrl: 'https://fixture.test/login' },
        config,
        randomUUID(),
        [normalDefinition],
      );
      const normalPreflight = await runtime.claim();
      await runtime.finish(proof(normalPreflight), {
        stage: 'preflight',
        checked: true,
      });
      await coordinator.tick(project.id);
      const normalExecutor = await runtime.claim();
      const normalBytes = bytesFor('rrweb');
      const normalArtifact = artifactFor('rrweb', normalBytes);
      normalArtifact.runId = normalRun.id;
      normalArtifact.taskId = normalExecutor.task.id;
      normalArtifact.caseId = normalDefinition.id;
      normalArtifact.status = 'available';
      const saved = await runtime.upload(
        proof(normalExecutor),
        normalArtifact,
        normalBytes,
      );
      const normalRecording = {
        ...recording,
        taskId: normalExecutor.task.id,
        status: 'available',
        rrwebArtifactId: saved.id,
        consoleArtifactId: null,
        networkArtifactId: null,
        error: null,
      };
      await runtime.finish(
        proof(normalExecutor),
        { stage: 'execute', taskRecording: normalRecording },
        normalDefinition.criteria.map((criterion) => ({
          criterionId: criterion.id,
          result: 'passed',
          reason: 'fixture',
          evidenceRefs: [saved.id],
        })),
      );
      const normalJob = await coordinator.tx(
        async (client) =>
          (
            await client.query('SELECT status,result FROM jobs WHERE id=$1', [
              normalExecutor.task.id,
            ])
          ).rows[0],
      );
      assert.equal(normalJob.status, 'succeeded');
      assert.deepEqual(normalJob.result.taskRecording, normalRecording);
      await assert.rejects(
        runtime.saveStoppedRecording(
          proof(normalExecutor),
          [{ artifact: normalArtifact, bytes: normalBytes }],
          { ...normalRecording, status: 'degraded' },
        ),
        (error) =>
          ['POLICY_DENIED', 'IDEMPOTENCY_CONFLICT'].includes(error.code),
        'a succeeded task keeps the normal finish path',
      );
    } finally {
      await db?.close().catch(() => {});
      if (container) docker('rm', '-f', container);
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
