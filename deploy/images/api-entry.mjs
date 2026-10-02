#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createApiContext, createApiServer } from '../../apps/api/dist/index.js';
import { SecretVault } from '../../packages/storage/dist/index.js';
import { readiness } from './readiness.mjs';

const vault = await SecretVault.fromProtectedFile(process.env.MASTER_KEY_FILE || '/run/secrets/kek.json');
const secretFile = process.env.WORKER_IDENTITY_FILE || '/run/secrets/worker_identity.json';
const workerSecret = (await readFile(secretFile, 'utf8')).trim();
if (!workerSecret || !process.env.DATABASE_URL) throw new Error('Missing required API identity or database configuration');
const context = createApiContext({
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
    res.writeHead(200, {'content-type':'text/plain'}); res.end('alive\n'); return;
  }
  if (req.url === '/readyz') {
    void readiness({ vault: true }).then((ok) => {
      res.writeHead(ok ? 200 : 503, {'content-type':'text/plain'}); res.end(ok ? 'ready\n' : 'unavailable\n');
    }).catch(() => { res.writeHead(503); res.end('unavailable\n'); });
    return;
  }
  app(req,res);
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('API listening'));
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
