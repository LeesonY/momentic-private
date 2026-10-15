#!/usr/bin/env node
import {
  createApiContext,
  createApiServer,
  loadServiceIdentity,
  tickSchedules,
} from '../../apps/api/dist/index.js';
import { loadProtectedKek } from './kek.mjs';
import { Database } from '../../packages/storage/dist/index.js';
import { readiness } from './readiness.mjs';
import { loadDatabaseUrl } from './database-url.mjs';

const vault = await loadProtectedKek();
// Fail closed before listening: a malformed or absent key ring must not leave
// `/internal/v1/*` reachable without service authentication.
const serviceIdentity = await loadServiceIdentity();
const connectionString = await loadDatabaseUrl();
const slots = Number(process.env.BROWSER_SLOTS || 4);
if (!Number.isSafeInteger(slots) || slots < 1)
  throw new Error('Invalid BROWSER_SLOTS');
const bootstrapDb = new Database(connectionString);
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
  connectionString,
  vault,
  artifactsDir: process.env.DATA_DIR,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  serviceIdentity,
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
// Durable, DB-fenced occurrences survive process restarts. Scheduler dispatch
// reuses API run admission; never inject a privileged pre-approved run.
let scheduleTicking = false;
let scheduleStopped = false;
const schedulerLoop = setInterval(async () => {
  if (scheduleTicking || scheduleStopped) return;
  scheduleTicking = true;
  try {
    if (await readiness({ vault: true })) await tickSchedules(context);
  } catch {
    console.error('Scheduler tick failed');
  } finally {
    scheduleTicking = false;
  }
}, 30_000);
schedulerLoop.unref();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    scheduleStopped = true;
    clearInterval(schedulerLoop);
    server.close(() => process.exit(0));
  });
