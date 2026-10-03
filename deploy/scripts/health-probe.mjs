#!/usr/bin/env node
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import pg from '../../packages/storage/node_modules/pg/lib/index.js';
import { SecretVault } from '../../packages/storage/dist/index.js';

const mode = process.argv.includes('--live')
  ? 'live'
  : process.argv.includes('--ready')
    ? 'ready'
    : 'ready';

const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.POSTGRES_USER || 'localqa'}:${process.env.POSTGRES_PASSWORD || 'localqa'}@${process.env.PGHOST || '127.0.0.1'}:${process.env.PGPORT || '5432'}/${process.env.POSTGRES_DB || 'localqa'}`;

const kekFile = process.env.MASTER_KEY_FILE || '/run/secrets/kek.json';
const dataDir = process.env.DATA_DIR || '/var/localqa/data';

async function probe() {
  if (mode === 'live') {
    // Basic liveness
    process.stdout.write('OK: alive\n');
    process.exit(0);
  }

  // Readiness probe: check DB, Migrations, Vault KEK, and Data Dir
  const checks = {
    database: false,
    migrations: false,
    masterKey: false,
    dataDir: false,
  };

  // 1. Check Database connection
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000 });
  let client;
  try {
    client = await pool.connect();
    checks.database = true;

    // 2. Check Migrations
    const res = await client.query(
      "SELECT count(*)::integer n FROM storage_migrations WHERE name IN ('001_core.sql','002_invariants.sql','003_access.sql','004_hardening.sql','005_project_default_model.sql')",
    );
    if (res.rows[0]?.n === 5) {
      checks.migrations = true;
    }
  } catch (err) {
    console.error('[HealthProbe] Database check failed:', err.message);
  } finally {
    client?.release();
    await pool.end();
  }

  // 3. Check Master KEK file
  if (existsSync(kekFile)) {
    try {
      const vault = await SecretVault.fromProtectedFile(kekFile);
      if (vault.activeVersion >= 1) {
        checks.masterKey = true;
      }
    } catch (err) {
      console.error('[HealthProbe] Master KEK check failed:', err.message);
    }
  }

  // 4. Check Data Dir writability
  if (existsSync(dataDir)) {
    try {
      accessSync(dataDir, constants.R_OK | constants.W_OK);
      checks.dataDir = true;
    } catch (err) {
      console.error(
        '[HealthProbe] Data directory access check failed:',
        err.message,
      );
    }
  }

  const allPassed = Object.values(checks).every(Boolean);
  if (allPassed) {
    console.log('[HealthProbe] Ready:', JSON.stringify(checks));
    process.exit(0);
  } else {
    console.error('[HealthProbe] NOT Ready:', JSON.stringify(checks));
    process.exit(1);
  }
}

await probe();
