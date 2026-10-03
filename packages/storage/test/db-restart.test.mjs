import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Database, migrate } from '../dist/index.js';

test('idle DB connections do not crash the service after PostgreSQL restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'localqa-restart-'));
  const name = `localqa-restart-${randomBytes(5).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const secrets = join(dir, 'postgres.env');
  writeFileSync(
    secrets,
    `POSTGRES_USER=localqa\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=localqa\n`,
    { mode: 0o600 },
  );
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
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
    let migrated = false;
    for (let i = 0; i < 60; i++) {
      try {
        await migrate(connection);
        migrated = true;
        break;
      } catch (error) {
        if (
          !['ECONNREFUSED', 'ECONNRESET', '57P01'].includes(error.code) &&
          !String(error.message).includes('Connection terminated')
        )
          throw error;
        await delay(200);
      }
    }
    assert.equal(migrated, true, 'Postgres initialization and migrations');
    db = new Database(connection);
    await db.auth(async (client) => client.query('SELECT 1'));
    const restart = spawnSync('docker', ['restart', name], {
      encoding: 'utf8',
    });
    assert.equal(restart.status, 0, restart.stderr);
    let recovered = false;
    for (let i = 0; i < 45; i++) {
      try {
        await db.auth(async (client) => client.query('SELECT 1'));
        recovered = true;
        break;
      } catch {
        await delay(200);
      }
    }
    assert.equal(recovered, true, 'same pool reconnects without process exit');
  } finally {
    if (db) await db.close().catch(() => {});
    spawnSync('docker', ['rm', '-f', '-v', name]);
    rmSync(dir, { recursive: true, force: true });
  }
});
