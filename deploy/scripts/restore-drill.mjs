#!/usr/bin/env node
import { readFile, copyFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import pg from '../../packages/storage/node_modules/pg/lib/index.js';
import { SecretVault, migrate } from '../../packages/storage/dist/index.js';
import {
  LocalVolumeArtifactStore,
  ReportBuilder,
} from '../../packages/report/dist/index.js';

const backupDir = process.argv[2];
const targetDbUrl = process.argv[3];
const targetDataDir = process.argv[4];
const targetKekFile = process.argv[5];

if (!backupDir || !targetDbUrl || !targetDataDir || !targetKekFile) {
  console.error(
    'Usage: node restore-drill.mjs <backupDir> <targetDbUrl> <targetDataDir> <targetKekFile>',
  );
  process.exit(1);
}

console.log('================================================================');
console.log('[LocalQA Restore Drill] Starting Disaster Recovery Simulation');
console.log(`[LocalQA Restore Drill] Backup Source: ${backupDir}`);
console.log('[LocalQA Restore Drill] Target Database: [REDACTED]');
console.log(`[LocalQA Restore Drill] Target Data Dir: ${targetDataDir}`);
console.log(`[LocalQA Restore Drill] Target KEK File: ${targetKekFile}`);
console.log('================================================================');

// 1. Verify Backup Manifest Integrity
const manifestPath = join(backupDir, 'backup-manifest.json');
if (!existsSync(manifestPath)) {
  console.error(
    '[LocalQA Restore Drill] ERROR: backup-manifest.json not found in backup directory!',
  );
  process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const sqlFile = join(backupDir, manifest.database.file);
const sqlBytes = await readFile(sqlFile);
if (sqlBytes.length !== manifest.database.bytes)
  throw new Error('Database dump length mismatch');
const artifactManifest = JSON.parse(
  await readFile(join(backupDir, manifest.artifacts.manifestFile), 'utf8'),
);
if (artifactManifest.length !== manifest.artifacts.count)
  throw new Error('Artifact manifest count mismatch');
for (const artifact of artifactManifest) {
  if (
    !artifact.relativePath ||
    artifact.relativePath.startsWith('/') ||
    artifact.relativePath.split(/[\\/]/).includes('..')
  )
    throw new Error('Unsafe artifact path in manifest');
  const bytes = await readFile(
    join(backupDir, 'artifacts', artifact.relativePath),
  );
  if (
    bytes.length !== artifact.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  )
    throw new Error(
      `Artifact backup checksum mismatch: ${artifact.relativePath}`,
    );
}
if (!manifest.kek.sha256) throw new Error('Missing KEK in backup');
const kekBytes = await readFile(join(backupDir, manifest.kek.file));
if (createHash('sha256').update(kekBytes).digest('hex') !== manifest.kek.sha256)
  throw new Error('KEK backup checksum mismatch');
const calculatedSqlSha = createHash('sha256').update(sqlBytes).digest('hex');
if (calculatedSqlSha !== manifest.database.sha256) {
  console.error(
    '[LocalQA Restore Drill] ERROR: Database dump checksum mismatch!',
  );
  process.exit(1);
}
console.log(
  '[LocalQA Restore Drill] Backup manifest & SQL dump checksum verified.',
);

// 2. Prepare Target Database & Run Migrations
console.log(
  '[LocalQA Restore Drill] Applying schema migrations to target database...',
);
const migrationsDir = new URL(
  '../../packages/storage/migrations/',
  import.meta.url,
);
await migrate(targetDbUrl, migrationsDir);
console.log('[LocalQA Restore Drill] Schema migrations successfully applied.');

// 3. Restore Database Dump
console.log('[LocalQA Restore Drill] Restoring database records from dump...');
const pool = new pg.Pool({ connectionString: targetDbUrl });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query('TRUNCATE bootstrap_state, storage_migrations');
    await client.query(sqlBytes.toString('utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  console.log('[LocalQA Restore Drill] Database rows restored.');

  // 4. CRITICAL: Lease Invalidation and Zombie Task Reconcile
  // Post-restore invariant: Old active leases and in-flight tasks from the backup
  // MUST NOT be treated as active running work!
  console.log(
    '[LocalQA Restore Drill] Invalidating zombie leases and reconciling in-flight tasks...',
  );
  const leaseReconcile = await client.query(`
    UPDATE task_leases
    SET lease_until = clock_timestamp() - interval '1 second'
    WHERE lease_until > clock_timestamp();
  `);
  console.log(
    `[LocalQA Restore Drill] Invalidate expired leases count: ${leaseReconcile.rowCount}`,
  );

  const jobsReconcile = await client.query(`
    UPDATE jobs
    SET status = 'interrupted',
        result = COALESCE(result, '{}'::jsonb) || '{"recoveredAfterDisaster": true}'::jsonb
    WHERE status IN ('running', 'waiting');
  `);
  console.log(
    `[LocalQA Restore Drill] Reconciled zombie jobs count: ${jobsReconcile.rowCount}`,
  );

  const attemptsReconcile = await client.query(`
    UPDATE case_attempts
    SET status = 'interrupted',
        finished_at = clock_timestamp()
    WHERE status = 'running';
  `);
  console.log(
    `[LocalQA Restore Drill] Reconciled in-flight attempts count: ${attemptsReconcile.rowCount}`,
  );

  // Confirm NO active leases remain
  const activeLeaseCheck = await client.query(
    'SELECT count(*)::integer n FROM task_leases WHERE lease_until > clock_timestamp()',
  );
  if (activeLeaseCheck.rows[0].n !== 0) {
    throw new Error(
      'Lease safety invariant failed: active leases remain after recovery!',
    );
  }
  console.log(
    '[LocalQA Restore Drill] Confirmed: 0 active leases exist in restored database.',
  );
} finally {
  client.release();
}

// 5. Restore Artifacts
console.log('[LocalQA Restore Drill] Restoring artifact physical files...');
await mkdir(targetDataDir, { recursive: true, mode: 0o700 });
const backupArtifactsDir = join(backupDir, 'artifacts');

async function copyAll(src, dst) {
  if (!existsSync(src)) return;
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      await mkdir(d, { recursive: true, mode: 0o700 });
      await copyAll(s, d);
    } else {
      await copyFile(s, d);
    }
  }
}
await copyAll(backupArtifactsDir, targetDataDir);
console.log(
  '[LocalQA Restore Drill] Artifact files restored to new data volume.',
);

// 6. Restore Master KEK and Verify Decryption
console.log('[LocalQA Restore Drill] Restoring Master KEK...');
const srcKek = join(backupDir, manifest.kek.file);
if (existsSync(srcKek)) {
  await mkdir(resolve(targetKekFile, '..'), { recursive: true, mode: 0o700 });
  await copyFile(srcKek, targetKekFile);
  chmodSync(targetKekFile, 0o600);

  const vault = await SecretVault.fromProtectedFile(targetKekFile);
  if (vault.activeVersion < 1) {
    throw new Error('Restored KEK file has invalid active version');
  }
  console.log(
    '[LocalQA Restore Drill] Restored Master KEK successfully initialized with version:',
    vault.activeVersion,
  );
}

// 7. Verify Data Readability: Read Out Reports and Evidence
console.log(
  '[LocalQA Restore Drill] Validating report and artifact accessibility from restored state...',
);
const store = new LocalVolumeArtifactStore(targetDataDir);
const reportBuilder = new ReportBuilder();

const verifyClient = await pool.connect();
try {
  // Find a completed run
  const runRow = (
    await verifyClient.query(
      "SELECT id, project_id FROM runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];

  if (runRow) {
    const adminId = (
      await verifyClient.query(
        "SELECT id FROM users WHERE global_role='admin' LIMIT 1",
      )
    ).rows[0]?.id;
    if (!adminId) throw new Error('Restored admin missing');
    await verifyClient.query('BEGIN');
    let report;
    try {
      await verifyClient.query('SET LOCAL ROLE localqa_app');
      await verifyClient.query(
        "SELECT set_config('localqa.actor_id', $1, true)",
        [adminId],
      );
      report = await reportBuilder.build(
        verifyClient,
        runRow.project_id,
        runRow.id,
        {
          artifactStore: store,
        },
      );
      await verifyClient.query('COMMIT');
    } catch (error) {
      await verifyClient.query('ROLLBACK');
      throw error;
    }
    console.log(
      `[LocalQA Restore Drill] Successfully constructed report for run ${runRow.id}. Planned: ${report.summary.planned}, Passed: ${report.summary.passed}`,
    );

    // Check evidence files
    for (const art of report.artifacts) {
      if (art.status === 'available') {
        const fileExists = await store.exists(
          runRow.project_id,
          runRow.id,
          art.id,
        );
        if (!fileExists) {
          throw new Error(
            `Restored artifact file ${art.id} not found in restored data volume!`,
          );
        }
        const fileData = await store.get(runRow.project_id, runRow.id, art.id);
        const actualSha = store.checksum(fileData);
        if (art.sha256 && actualSha !== art.sha256) {
          throw new Error(
            `Checksum mismatch on restored artifact ${art.id}: expected ${art.sha256}, got ${actualSha}`,
          );
        }
      }
    }
    if (report.artifacts.length === 0)
      throw new Error('Restore drill requires an evidence artifact');
    console.log(
      `[LocalQA Restore Drill] Verified ${report.artifacts.length} artifact(s) on disk with matching checksums.`,
    );
  } else {
    throw new Error(
      'Restore drill requires a completed run to verify its report',
    );
  }
} finally {
  verifyClient.release();
  await pool.end();
}

console.log('================================================================');
console.log(
  '[LocalQA Restore Drill] SUCCESS: Disaster Recovery Drill Verified!',
);
console.log('================================================================');
