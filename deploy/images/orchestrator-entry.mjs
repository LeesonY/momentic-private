#!/usr/bin/env node
import { Database, SecretVault } from '../../packages/storage/dist/index.js';
import { Coordinator } from '../../packages/orchestrator/dist/index.js';
import { readiness } from './readiness.mjs';
import { writeFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const vault = await SecretVault.fromProtectedFile(process.env.MASTER_KEY_FILE || '/run/secrets/kek.json');
const db = new Database(process.env.DATABASE_URL);
const adminId = await db.auth(async (client) => (await client.query("SELECT id FROM users WHERE global_role='admin' ORDER BY created_at LIMIT 1")).rows[0]?.id);
if (!adminId) throw new Error('Bootstrap admin before starting orchestrator');
const actor = {userId: adminId};
const coordinator = new Coordinator({db, serviceActor:actor, vault});
let running = true;
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { running = false; });
while (running) {
  try {
    if (await readiness({vault:true})) {
      const ids = await db.actor(actor, async (client) => (await client.query("SELECT id FROM projects WHERE status='active' ORDER BY id")).rows.map((r)=>r.id));
      for (const id of ids) { if (!running) break; await coordinator.tick(id); }
      await writeFile('/tmp/orchestrator-ready', String(Date.now()));
    }
  } catch (error) { console.error('Orchestrator tick failed:', error.message); }
  if (running) await new Promise((r)=>setTimeout(r,1000));
}
await db.close();
