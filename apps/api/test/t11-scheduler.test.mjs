import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  AccountsRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  SecretVault,
  migrate,
} from '@localqa/storage';
import {
  createApiContext,
  createApiServer,
  tickSchedules,
} from '../dist/index.js';
import { matchingMinutes } from '../dist/scheduleClock.js';
import { enqueueDueSchedules } from '../dist/scheduleService.js';

function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(
    result.status,
    0,
    `Isolated Docker operation failed: ${args[0]}`,
  );
  return result.stdout.trim();
}

test('cron uses local wall clock, skipping DST gaps and collapsing repeated hours', () => {
  const fallback = matchingMinutes(
    '30 1 * * *',
    'America/New_York',
    new Date('2026-11-01T05:00:00Z'),
    new Date('2026-11-01T07:00:00Z'),
  );
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].local, '2026-11-01T01:30');
  const spring = matchingMinutes(
    '30 2 * * *',
    'America/New_York',
    new Date('2026-03-08T06:30:00Z'),
    new Date('2026-03-08T08:00:00Z'),
  );
  assert.equal(spring.length, 0);
});

test(
  'T11 real PostgreSQL: create/patch/occurrence dispatch/overlap and durable history',
  { timeout: 110000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'localqa-t11-schedule-'));
    const password = randomBytes(24).toString('hex');
    const env = join(dir, 'postgres.env');
    writeFileSync(
      env,
      `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
      { mode: 0o600 },
    );
    let container = null;
    let db;
    let api;
    let server;
    try {
      container = docker([
        'run',
        '--detach',
        '--name',
        `localqa-t11-schedules-${randomUUID().slice(0, 9)}`,
        '--publish',
        '127.0.0.1::5432',
        '--env-file',
        env,
        'postgres:18-alpine',
      ]);
      const port = docker(['port', container, '5432/tcp']).split(':').at(-1);
      const connection = `postgresql://localqa:${password}@127.0.0.1:${port}/localqa`;
      let ready = false;
      for (let n = 0; n < 80; n++) {
        try {
          await migrate(
            connection,
            new URL('../../../packages/storage/migrations/', import.meta.url),
          );
          ready = true;
          break;
        } catch (error) {
          if (n === 79)
            console.error(
              'Migration diagnostic:',
              error.code ?? 'none',
              String(error.message)
                .replace(/postgresql:\/\/[^\s]*/gi, '<redacted-dsn>')
                .slice(0, 160),
            );
          await delay(160);
        }
      }
      assert.equal(ready, true);
      const vault = new SecretVault(1, new Map([[1, randomBytes(32)]]));
      db = new Database(connection);
      const owner = await new AccountsRepository(db).bootstrap({
        email: `t11-schedule-${randomUUID()}@localqa.test`,
        displayName: 'Schedule owner',
        password: 'T11-schedule-test-password',
      });
      const actor = { userId: owner.id };
      const project = await new ProjectRepository(db).create(actor, {
        name: 'Scheduled smoke fixture',
      });
      const modelRepo = new ModelRepository(db, vault);
      const model = await modelRepo.create(actor, {
        name: 'Schedule model binding',
        endpoint: 'https://unused.example.test/v1',
        configuredModelId: 'unused',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
      });
      await modelRepo.grant(actor, project.id, model.id);
      api = createApiContext({
        connectionString: connection,
        vault,
        serviceActor: actor,
        artifactsDir: join(dir, 'artifacts'),
        publicOrigin: 'http://localhost',
      });
      server = createApiServer(api);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      async function send(method, path, body, headers = {}) {
        const res = await fetch(base + path, {
          method,
          headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return {
          code: res.status,
          json: await res.json(),
          headers: res.headers,
        };
      }
      const login = await send('POST', '/api/v1/auth/login', {
        email: owner.email,
        password: 'T11-schedule-test-password',
      });
      assert.equal(login.code, 200);
      const cookie = { Cookie: login.headers.get('set-cookie').split(';')[0] };
      const created = await send(
        'POST',
        `/api/v1/projects/${project.id}/schedules`,
        {
          name: 'T11 every minute',
          cron: '* * * * *',
          timezone: 'Asia/Singapore',
          templateKind: 'smoke',
          missedPolicy: 'catchup_one',
          overlapPolicy: 'skip',
          runTemplate: {
            projectId: project.id,
            targetUrl: 'http://127.0.0.1:18383/',
          },
        },
        cookie,
      );
      assert.equal(created.code, 201, JSON.stringify(created.json));
      const schedule = created.json;
      const listed = await send(
        'GET',
        `/api/v1/projects/${project.id}/schedules`,
        null,
        cookie,
      );
      assert.equal(listed.json.items[0].id, schedule.id);
      const changed = await send(
        'PATCH',
        `/api/v1/schedules/${schedule.id}`,
        { expectedVersion: 1, name: 'Renamed scheduled smoke' },
        cookie,
      );
      assert.equal(changed.code, 200);
      assert.equal(changed.json.version, 2);
      const conflict = await send(
        'PATCH',
        `/api/v1/schedules/${schedule.id}`,
        { expectedVersion: 1, enabled: false },
        cookie,
      );
      assert.equal(conflict.code, 409);
      const now = new Date();
      await db.actor(actor, (client) =>
        client.query('UPDATE schedules SET last_checked_at=$2 WHERE id=$1', [
          schedule.id,
          new Date(now.getTime() - 66_000),
        ]),
      );
      // Admission is frozen at occurrence creation, not dispatch time.
      await enqueueDueSchedules(api, now);
      const editedTemplate = await send(
        'PATCH',
        `/api/v1/schedules/${schedule.id}`,
        {
          expectedVersion: 2,
          runTemplate: {
            projectId: project.id,
            targetUrl: 'http://127.0.0.1:19999/',
          },
        },
        cookie,
      );
      assert.equal(editedTemplate.code, 200);
      await tickSchedules(api, now);
      await tickSchedules(api, now); // Same wall minute must not duplicate.
      const occurrences = await send(
        'GET',
        `/api/v1/schedules/${schedule.id}/occurrences`,
        null,
        cookie,
      );
      assert.equal(occurrences.code, 200, JSON.stringify(occurrences.json));
      assert.equal(occurrences.json.items.length, 1);
      assert.equal(occurrences.json.items[0].status, 'started');
      assert.ok(occurrences.json.items[0].runId);
      const executed = await send(
        'GET',
        `/api/v1/runs/${occurrences.json.items[0].runId}`,
        null,
        cookie,
      );
      assert.equal(executed.code, 200);
      assert.equal(executed.json.targetUrl, 'http://127.0.0.1:18383/');
      const busy = await send(
        'POST',
        `/api/v1/schedules/${schedule.id}/run-now`,
        null,
        cookie,
      );
      assert.equal(busy.code, 409);
      console.log(
        'T11 real PG18: schedule versioning, cron dispatch, unique occurrence, overlap guard',
      );
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await api?.db.close();
      await db?.close();
      if (container) docker(['rm', '--force', '--volumes', container]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
