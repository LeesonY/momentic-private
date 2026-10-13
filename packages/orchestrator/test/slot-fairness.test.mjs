import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Database,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
  migrate,
} from '../../storage/dist/index.js';
import { Coordinator } from '../dist/index.js';
import { DEFAULT_LIMITS, smokeCase } from '@localqa/domain';

// Two workers claim concurrently while reserved concurrency is at limit-1;
// exactly one may win the last slot. Proves no oversell (FR-020).
test('concurrent claim at slot limit admits exactly one worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'localqa-slots-'));
  const name = `localqa-slots-${randomBytes(5).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const secrets = join(dir, 'pg.env');
  writeFileSync(
    secrets,
    `POSTGRES_USER=localqa\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=localqa\n`,
    { mode: 0o600 },
  );
  const sock = net.createServer();
  await new Promise((r) => sock.listen(0, '127.0.0.1', r));
  const port = sock.address().port;
  await new Promise((r) => sock.close(r));
  let db;
  try {
    const start = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        name,
        '-p',
        `127.0.0.1:${port}:5432`,
        '--env-file',
        secrets,
        'postgres:18-alpine',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(start.status, 0, start.stderr);
    const connection = `postgresql://localqa:${password}@127.0.0.1:${port}/localqa`;
    for (let i = 0; i < 60; i++) {
      try {
        await migrate(connection);
        break;
      } catch {
        await delay(200);
      }
    }
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
    db = new Database(connection);
    const admin = await new AccountsRepository(db).bootstrap({
      email: 'admin@s.test',
      displayName: 'a',
      password: 'AdminPass123!',
    });
    const project = await new ProjectRepository(db).create(
      { userId: admin.id },
      { name: 'slots' },
    );
    const model = await new ModelRepository(db, vault).create(
      { userId: admin.id },
      {
        name: 'stub',
        endpoint: 'https://stub.example.test/v1',
        configuredModelId: 'stub-normal',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
      },
    );
    await new ProjectRepository(db).update({ userId: admin.id }, project.id, {
      expectedVersion: project.version,
      defaultModelProfileId: model.id,
    });
    // Coordinator with platformSlots=2 for a deterministic limit.
    const coordinator = new Coordinator({
      db,
      serviceActor: { userId: admin.id },
      vault,
      platformSlots: 2,
      projectSlots: 2,
    });
    // Start two runs (they occupy the two slots once workers claim their jobs).
    const fixture = 'http://localhost:8085/';
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const brief = 'slot test';
      const runId = randomUUID();
      const cases = [
        smokeCase({ id: runId, projectId: project.id }, fixture, 0),
      ];
      const run = await coordinator.start(
        { userId: admin.id },
        { projectId: project.id, targetUrl: fixture, brief },
        {
          allowedOrigins: [fixture],
          actionPolicy: 'non_submitting',
          budget: DEFAULT_LIMITS,
          environmentVersion: null,
          authProfileVersion: null,
          models: Object.fromEntries(
            [
              'coordinator',
              'explorer',
              'executor',
              'assertion',
              'reproducer',
            ].map((r) => [r, { profileId: model.id, version: 1 }]),
          ),
          knowledgeVersionIds: [],
        },
        randomUUID(),
        cases,
      );
      runs.push(run);
      await db.actor({ userId: admin.id }, (client) =>
        coordinator.enqueue(
          client,
          run,
          'explorer',
          'explore',
          'slot-test',
          null,
        ),
      );
    }
    // Control work has its own reserved slot; the race below concerns children.
    const control = await coordinator.claim(
      { projectId: project.id, workerId: 'worker-control' },
      45,
    );
    assert.equal(control.task.role, 'coordinator');
    // Simulate reserved=limit-1 by occupying one slot via a worker claim.
    const first = await coordinator.claim(
      { projectId: project.id, workerId: 'worker-a' },
      45,
    );
    assert.ok(first, 'first claim succeeds');
    assert.equal(first.task.role, 'explorer');
    // Now reserved=1, limit=2 -> exactly one slot left. Two workers race for it.
    const [w1, w2] = await Promise.all([
      coordinator.claim({ projectId: project.id, workerId: 'worker-b' }, 45),
      coordinator.claim({ projectId: project.id, workerId: 'worker-c' }, 45),
    ]);
    const winners = [w1, w2].filter(Boolean).length;
    assert.equal(
      winners,
      1,
      `exactly one worker must win the last slot, got ${winners}`,
    );
    // A further claim must find nothing.
    const none = await coordinator.claim(
      { projectId: project.id, workerId: 'worker-d' },
      45,
    );
    assert.equal(none, null, 'no slot left after the limit is reached');
    console.log(
      JSON.stringify({
        slots: 2,
        firstClaim: first.task.id,
        winner: (w1 || w2)?.task.id,
        winners,
      }),
    );
  } finally {
    if (db) await db.close().catch(() => {});
    spawnSync('docker', ['rm', '-f', '-v', name]);
    rmSync(dir, { recursive: true, force: true });
  }
});
