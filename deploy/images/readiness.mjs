import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import pg from '../../packages/storage/node_modules/pg/lib/index.js';
import { SecretVault } from '../../packages/storage/dist/index.js';

export async function readiness({ vault = false, browserMarker = false } = {}) {
  if (!process.env.DATABASE_URL || (vault && !process.env.MASTER_KEY_FILE))
    return false;
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
  });
  try {
    const result = await pool.query(
      "SELECT count(*)::integer AS n FROM storage_migrations WHERE name IN ('001_core.sql','002_invariants.sql','003_access.sql','004_hardening.sql','005_project_default_model.sql')",
    );
    if (result.rows[0]?.n !== 5) return false;
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
