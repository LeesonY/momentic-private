#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import pg from '../../packages/storage/node_modules/pg/lib/index.js';

const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.POSTGRES_USER || 'localqa'}:${process.env.POSTGRES_PASSWORD || 'localqa'}@${process.env.PGHOST || '127.0.0.1'}:${process.env.PGPORT || '5432'}/${process.env.POSTGRES_DB || 'localqa'}`;

const dataDir = process.env.DATA_DIR || '/var/localqa/data';
const scratchDir = process.env.SCRATCH_DIR || '/var/localqa/scratch';

console.log('================================================================');
console.log(
  '[LocalQA Disk Status] Inspecting Storage Capacity and Cleanup Status',
);
console.log('================================================================');

// 1. Inspect Physical Artifact Storage
const quotaLimitRunBytes = 250 * 1024 * 1024; // 250 MiB
const quotaLimitArtifactBytes = 25 * 1024 * 1024; // 25 MiB

let totalArtifactBytes = 0;
let totalArtifactFiles = 0;
const runUsageMap = new Map();
const oversizedArtifacts = [];

async function walk(dir, currentRunId = null) {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // If parent is project dir, entry is run dir
      await walk(fullPath, entry.name);
    } else if (entry.isFile() && !entry.name.startsWith('.')) {
      const s = await stat(fullPath);
      totalArtifactBytes += s.size;
      totalArtifactFiles += 1;
      if (currentRunId) {
        runUsageMap.set(
          currentRunId,
          (runUsageMap.get(currentRunId) || 0) + s.size,
        );
      }
      if (s.size > quotaLimitArtifactBytes) {
        oversizedArtifacts.push({ path: fullPath, size: s.size });
      }
    }
  }
}

await walk(dataDir);

console.log(
  `[Artifact Volume] Total Size: ${(totalArtifactBytes / (1024 * 1024)).toFixed(2)} MiB (${totalArtifactBytes} bytes)`,
);
console.log(`[Artifact Volume] Total Files: ${totalArtifactFiles}`);

const quotaViolations = [];
for (const [rId, bytes] of runUsageMap.entries()) {
  if (bytes > quotaLimitRunBytes) {
    quotaViolations.push({
      runId: rId,
      bytes,
      mib: (bytes / (1024 * 1024)).toFixed(2),
    });
  }
}

if (quotaViolations.length > 0) {
  console.warn(
    `[Artifact Volume] WARNING: ${quotaViolations.length} run(s) exceeded 250MiB quota limit!`,
  );
  for (const q of quotaViolations) {
    console.warn(`  - Run ${q.runId}: ${q.mib} MiB`);
  }
} else {
  console.log('[Artifact Volume] All runs within 250MiB quota limit.');
}

if (oversizedArtifacts.length > 0) {
  console.warn(
    `[Artifact Volume] WARNING: ${oversizedArtifacts.length} artifact(s) exceeded 25MiB single file limit!`,
  );
}

// 2. Inspect Scratch Directory
let scratchBytes = 0;
let scratchFiles = 0;
async function walkScratch(dir) {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkScratch(fullPath);
    } else if (entry.isFile()) {
      const s = await stat(fullPath);
      scratchBytes += s.size;
      scratchFiles += 1;
    }
  }
}
await walkScratch(scratchDir);
console.log(
  `[Scratch Space] Usage: ${(scratchBytes / (1024 * 1024)).toFixed(2)} MiB (${scratchFiles} file(s))`,
);

// 3. Inspect PostgreSQL Table & Cleanup State
const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000 });
try {
  const client = await pool.connect();
  console.log('\n[Database Capacity & Retention Queue]');
  const dbSizes = await client.query(`
    SELECT relname AS table_name,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
           c.reltuples::bigint AS estimated_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 8;
  `);

  for (const row of dbSizes.rows) {
    console.log(
      `  - ${row.table_name.padEnd(24)}: ${row.total_size.padStart(10)} (~${row.estimated_rows} rows)`,
    );
  }

  // Check expired artifacts pending GC
  const gcPending = await client.query(`
    SELECT count(*)::integer n,
           COALESCE(sum((document->>'bytes')::bigint), 0) total_pending_bytes
    FROM artifacts
    WHERE retain_until <= clock_timestamp()
      AND held = false
      AND (document->>'status') <> 'missing'
  `);
  console.log(
    `\n[GC Cleanup Pending] ${gcPending.rows[0].n} expired artifact(s) ready for deletion (${(Number(gcPending.rows[0].total_pending_bytes) / (1024 * 1024)).toFixed(2)} MiB)`,
  );

  client.release();
} catch (err) {
  console.warn(
    '[Database Check] Unable to connect to DB for table sizes:',
    err.message,
  );
} finally {
  await pool.end();
}
console.log('================================================================');
