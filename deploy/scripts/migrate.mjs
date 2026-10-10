#!/usr/bin/env node
import { migrate } from '../../packages/storage/dist/index.js';
import { loadDatabaseUrl } from '../images/database-url.mjs';

const migrationsDir = new URL(
  '../../packages/storage/migrations/',
  import.meta.url,
);

const connectionString = await loadDatabaseUrl();

console.log(
  '[LocalQA Migrate] Starting database migrations from:',
  migrationsDir.pathname,
);

try {
  const applied = await migrate(connectionString, migrationsDir);
  if (applied.length === 0) {
    console.log(
      '[LocalQA Migrate] Schema already up to date. (0 migrations applied)',
    );
  } else {
    console.log(
      `[LocalQA Migrate] Successfully applied ${applied.length} migration(s):`,
      applied.join(', '),
    );
  }
} catch (error) {
  console.error('[LocalQA Migrate] Migration failed:', error);
  process.exit(1);
}
