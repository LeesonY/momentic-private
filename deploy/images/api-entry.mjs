#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  createApiContext,
  createApiServer,
} from '../../apps/api/dist/index.js';
import { loadProtectedKek } from './kek.mjs';
import { Database } from '../../packages/storage/dist/index.js';
import { readiness } from './readiness.mjs';

const vault = await loadProtectedKek();
const secretFile =
  process.env.WORKER_IDENTITY_FILE || '/run/secrets/worker_identity.json';
const workerSecret = (await readFile(secretFile, 'utf8')).trim();
if (!workerSecret || !process.env.DATABASE_URL)
  throw new Error('Missing required API identity or database configuration');
const slots = Number(process.env.BROWSER_SLOTS || 4);
if (!Number.isSafeInteger(slots) || slots < 1)
  throw new Error('Invalid BROWSER_SLOTS');
const bootstrapDb = new Database(process.env.DATABASE_URL);
const adminId = await bootstrapDb.auth(
  async (client) =>
    (
      await client.query(
        "SELECT id FROM users WHERE global_role='admin' AND NOT disabled ORDER BY created_at LIMIT 1",
      )
    ).rows[0]?.id,
);
await bootstrapDb.close();
if (!adminId) throw new Error('Bootstrap admin before starting API');
// Production composition: no allowTestStub. createApiContext uses global fetch
// unless a caller injects modelTransport. This entry does not inject one.
const context = createApiContext({
  serviceActor: { userId: adminId },
  platformSlots: slots,
  projectSlots: slots,
  connectionString: process.env.DATABASE_URL,
  vault,
  artifactsDir: process.env.DATA_DIR,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  workerSecret,
});
const server = createApiServer(context);
const app = server.listeners('request')[0];
server.removeListener('request', app);
server.on('request', (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('alive\n');
    return;
  }
  if (req.url === '/readyz') {
    void readiness({ vault: true })
      .then((ok) => {
        res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' });
        res.end(ok ? 'ready\n' : 'unavailable\n');
      })
      .catch(() => {
        res.writeHead(503);
        res.end('unavailable\n');
      });
    return;
  }
  app(req, res);
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () =>
  console.log('API listening'),
);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => server.close(() => process.exit(0)));
