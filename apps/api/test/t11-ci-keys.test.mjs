import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  AccountsRepository,
  ProjectRepository,
  Database,
  SecretVault,
  migrate,
} from '@localqa/storage';
import { createApiContext, createApiServer } from '../dist/index.js';

function docker(args) {
  const cmd = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  assert.equal(cmd.status, 0, 'Isolated PostgreSQL Docker command failed');
  return cmd.stdout.trim();
}

test(
  'T11: project API key issue -> restricted reads -> revocation on real PostgreSQL',
  { timeout: 100000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'localqa-t11-key-'));
    const password = randomBytes(24).toString('hex');
    const env = join(dir, 'postgres.env');
    writeFileSync(
      env,
      `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
      { mode: 0o600 },
    );
    let id;
    let api;
    let server;
    try {
      id = docker([
        'run',
        '--detach',
        '--name',
        `localqa-t11-${randomUUID().slice(0, 12)}`,
        '--publish',
        '127.0.0.1::5432',
        '--env-file',
        env,
        'postgres:18-alpine',
      ]);
      const port = docker(['port', id, '5432/tcp']).split(':').at(-1);
      const connection = `postgresql://localqa:${password}@127.0.0.1:${port}/localqa`;
      let ready = false;
      for (let i = 0; i < 75; i++) {
        try {
          await migrate(
            connection,
            new URL('../../../packages/storage/migrations/', import.meta.url),
          );
          ready = true;
          break;
        } catch {
          await delay(160);
        }
      }
      assert.equal(ready, true);
      const vault = new SecretVault(1, new Map([[1, randomBytes(32)]]));
      const db = new Database(connection);
      const owner = await new AccountsRepository(db).bootstrap({
        email: `t11-${randomUUID()}@localqa.test`,
        displayName: 'T11 CI owner',
        password: 'T11-test-owner-password',
      });
      const actor = { userId: owner.id };
      const projects = new ProjectRepository(db);
      const a = await projects.create(actor, { name: 'T11 project A' });
      const b = await projects.create(actor, { name: 'T11 project B' });
      api = createApiContext({
        connectionString: connection,
        vault,
        serviceActor: actor,
        publicOrigin: 'http://localhost',
        artifactsDir: join(dir, 'artifacts'),
      });
      server = createApiServer(api);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      async function send(method, path, body, headers = {}) {
        const response = await fetch(base + path, {
          method,
          headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return {
          status: response.status,
          data: await response.json(),
          headers: response.headers,
        };
      }
      const login = await send('POST', '/api/v1/auth/login', {
        email: owner.email,
        password: 'T11-test-owner-password',
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const created = await send(
        'POST',
        `/api/v1/projects/${a.id}/api-keys`,
        { name: 'CI reader', scope: ['runs:read'] },
        { Cookie: cookie },
      );
      assert.equal(created.status, 201, JSON.stringify(created.data));
      assert.ok(created.data.token?.startsWith('lqa_'));
      assert.equal(created.headers.get('cache-control'), 'no-store');
      const keys = await send(
        'GET',
        `/api/v1/projects/${a.id}/api-keys`,
        null,
        { Cookie: cookie },
      );
      assert.equal(keys.status, 200);
      assert.equal(keys.data.items[0].id, created.data.key.id);
      assert.equal(
        JSON.stringify(keys.data).includes(created.data.token),
        false,
      );
      const bearer = { Authorization: `Bearer ${created.data.token}` };
      const list = await send(
        'GET',
        `/api/v1/runs?projectId=${a.id}`,
        null,
        bearer,
      );
      assert.equal(list.status, 200, JSON.stringify(list.data));
      const other = await send(
        'GET',
        `/api/v1/runs?projectId=${b.id}`,
        null,
        bearer,
      );
      assert.equal(other.status, 403);
      const createDenied = await send(
        'POST',
        '/api/v1/runs',
        { projectId: a.id, targetUrl: 'http://127.0.0.1/' },
        { ...bearer, 'Idempotency-Key': randomUUID() },
      );
      assert.equal(createDenied.status, 403);
      const me = await send('GET', '/api/v1/auth/me', null, bearer);
      assert.equal(me.status, 403);
      const revoked = await send(
        'POST',
        `/api/v1/api-keys/${created.data.key.id}/revoke`,
        null,
        { Cookie: cookie },
      );
      assert.equal(revoked.status, 200);
      assert.ok(revoked.data.revokedAt);
      const denied = await send(
        'GET',
        `/api/v1/runs?projectId=${a.id}`,
        null,
        bearer,
      );
      assert.equal(denied.status, 401);
      console.log(
        'T11 real PostgreSQL: scoped token, privilege boundary, revoke confirmed',
      );
    } finally {
      if (server)
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        });
      await api?.db.close();
      if (id) docker(['rm', '--force', '--volumes', id]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
