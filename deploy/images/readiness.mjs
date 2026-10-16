import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import pg from '../../packages/storage/node_modules/pg/lib/index.js';
import { SecretVault } from '../../packages/storage/dist/index.js';
import { loadDatabaseUrl } from './database-url.mjs';
import { hasAllMigrations } from './migration-check.mjs';

export async function readiness({ vault = false, browserMarker = false } = {}) {
  if (vault && !process.env.MASTER_KEY_FILE) return false;
  let connectionString;
  try {
    connectionString = await loadDatabaseUrl();
  } catch {
    return false;
  }
  const pool = new pg.Pool({
    connectionString,
    // Probes are short-lived and must never compete with task traffic for the
    // server's connection budget.
    max: 2,
    connectionTimeoutMillis: 3000,
  });
  // A restart can sever an idle readiness connection between query and end.
  // Never allow a probe's background event to crash the long-lived Worker.
  pool.on('error', (error) =>
    console.error(
      'Readiness DB connection lost',
      error.code ?? 'connection_error',
    ),
  );
  pool.on('connect', (client) =>
    client.on('error', (error) =>
      console.error(
        'Readiness client connection lost',
        error.code ?? 'connection_error',
      ),
    ),
  );
  try {
    // Never silently report ready with an old schema. Auth sessions, captures
    // and private state imports are introduced after migration 010. Compare
    // the checked-in migration set rather than maintaining a stale count.
    if (!(await hasAllMigrations(pool))) return false;
    await access(
      process.env.DATA_DIR || '/var/localqa/data',
      constants.R_OK | constants.W_OK,
    );
    if (vault) await SecretVault.fromProtectedFile(process.env.MASTER_KEY_FILE);
    if (browserMarker) {
      const marker = await stat('/var/localqa/scratch/browser-ready');
      if (Date.now() - marker.mtimeMs > 60000) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}
