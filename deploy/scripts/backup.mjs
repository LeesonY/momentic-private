#!/usr/bin/env node
import {
  mkdir,
  writeFile,
  copyFile,
  readdir,
  readFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from '../../packages/storage/node_modules/pg/lib/index.js';
import { loadDatabaseUrl } from '../images/database-url.mjs';

const connectionString = await loadDatabaseUrl();

const dataDir = process.env.DATA_DIR || '/var/localqa/data';
const kekFile = process.env.MASTER_KEY_FILE || '/run/secrets/kek.json';

const targetBackupDir =
  process.argv[2] ||
  resolve(
    process.env.BACKUP_DIR || './backups',
    `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );

console.log(`[LocalQA Backup] Creating backup in: ${targetBackupDir}`);
await mkdir(targetBackupDir, { recursive: true, mode: 0o700 });
await mkdir(join(targetBackupDir, 'artifacts'), {
  recursive: true,
  mode: 0o700,
});
await mkdir(join(targetBackupDir, 'secrets'), { recursive: true, mode: 0o700 });

// 1. Dump Database
const dbDumpFile = join(targetBackupDir, 'database.sql');

// Try pg_dump first, or logical SQL tables dump fallback
const dumpTarget = new URL(connectionString);
const dbPassword = decodeURIComponent(dumpTarget.password);
dumpTarget.password = '';
// Never put a password-bearing DSN in pg_dump's observable command line.
// The short-lived child gets the password in an environment variable instead.
const pgDumpCmd = spawnSync('pg_dump', [dumpTarget.href, '-f', dbDumpFile], {
  env: { ...process.env, PGPASSWORD: dbPassword },
});
if (pgDumpCmd.status === 0 && existsSync(dbDumpFile)) {
  console.log('[LocalQA Backup] Database dumped via pg_dump');
} else {
  console.log(
    '[LocalQA Backup] pg_dump not found in local PATH, performing direct logical SQL extraction...',
  );
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    const tableNames = (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      )
    ).rows.map((r) => r.tablename);

    const dumpLines = [];
    dumpLines.push('-- LocalQA Logical Backup Dump');
    dumpLines.push(`-- Generated: ${new Date().toISOString()}`);
    dumpLines.push('SET statement_timeout = 0;');
    // The restore drill owns the transaction and disables triggers only within it.

    for (const table of tableNames) {
      const rows = (await client.query(`SELECT * FROM "${table}"`)).rows;
      dumpLines.push(`\n-- Table: ${table} (${rows.length} rows)`);
      if (rows.length > 0) {
        for (const row of rows) {
          const keys = Object.keys(row);
          const values = Object.values(row).map((val) => {
            if (val === null) return 'NULL';
            if (typeof val === 'boolean' || typeof val === 'number')
              return String(val);
            if (val instanceof Date) return `'${val.toISOString()}'`;
            if (typeof val === 'object')
              return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
            return `'${String(val).replace(/'/g, "''")}'`;
          });
          dumpLines.push(
            `INSERT INTO "${table}" ("${keys.join('", "')}") VALUES (${values.join(', ')});`,
          );
        }
      }
    }

    await writeFile(dbDumpFile, dumpLines.join('\n') + '\n', 'utf8');
    console.log('[LocalQA Backup] Logical SQL extraction complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

const dbBytes = await readFile(dbDumpFile);
const dbDumpSha256 = createHash('sha256').update(dbBytes).digest('hex');

// 2. Backup Artifacts & Generate Artifacts Manifest
const artifactsManifest = [];
let totalArtifactBytes = 0;

async function backupDir(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true, mode: 0o700 });
      await backupDir(srcPath, destPath);
    } else if (entry.isFile() && !entry.name.startsWith('.')) {
      const fileBytes = await readFile(srcPath);
      const sha = createHash('sha256').update(fileBytes).digest('hex');
      await copyFile(srcPath, destPath);
      artifactsManifest.push({
        relativePath: join(
          destDir.replace(join(targetBackupDir, 'artifacts'), ''),
          entry.name,
        ).replace(/^\//, ''),
        bytes: fileBytes.length,
        sha256: sha,
      });
      totalArtifactBytes += fileBytes.length;
    }
  }
}

await backupDir(dataDir, join(targetBackupDir, 'artifacts'));
await writeFile(
  join(targetBackupDir, 'artifacts-manifest.json'),
  JSON.stringify(artifactsManifest, null, 2) + '\n',
  'utf8',
);
console.log(
  `[LocalQA Backup] Backed up ${artifactsManifest.length} artifact(s) (${totalArtifactBytes} bytes)`,
);

// 3. Backup Master KEK (Stored in dedicated subdirectory with 0400 permission)
let kekSha256 = null;
if (existsSync(kekFile)) {
  const kekDest = join(targetBackupDir, 'secrets', 'kek.json');
  await copyFile(kekFile, kekDest);
  const kekBytes = await readFile(kekDest);
  kekSha256 = createHash('sha256').update(kekBytes).digest('hex');
  console.log(
    '[LocalQA Backup] Master KEK copied with secure file permissions.',
  );
} else {
  console.warn(
    '[LocalQA Backup] WARNING: Master KEK file not found at:',
    kekFile,
  );
}

// 4. Write Backup Summary Manifest
const backupManifest = {
  schemaVersion: 1,
  backupId: randomUUID(),
  timestamp: new Date().toISOString(),
  database: {
    file: 'database.sql',
    sha256: dbDumpSha256,
    bytes: dbBytes.length,
  },
  artifacts: {
    manifestFile: 'artifacts-manifest.json',
    count: artifactsManifest.length,
    totalBytes: totalArtifactBytes,
  },
  kek: {
    file: 'secrets/kek.json',
    sha256: kekSha256,
  },
  notes:
    'KEK is backed up alongside DB for disaster recovery drills; in high-security production, store KEK in a distinct KMS vault.',
};

await writeFile(
  join(targetBackupDir, 'backup-manifest.json'),
  JSON.stringify(backupManifest, null, 2) + '\n',
  'utf8',
);

console.log('[LocalQA Backup] Backup successfully completed!');
console.log(
  `[LocalQA Backup] Manifest: ${join(targetBackupDir, 'backup-manifest.json')}`,
);
