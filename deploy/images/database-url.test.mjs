import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadDatabaseUrl } from './database-url.mjs';

test('protected file DSN works without an inline credential', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'localqa-dburl-'));
  try {
    const file = join(folder, `db-${randomUUID()}`);
    const secret = 'postgresql://service:encoded%40secret@db:5432/localqa';
    writeFileSync(file, secret + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
    assert.equal(await loadDatabaseUrl({ DATABASE_URL_FILE: file }), secret);
    await assert.rejects(
      loadDatabaseUrl({ DATABASE_URL_FILE: file, DATABASE_URL: secret }),
      /exactly one/,
    );
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644);
      await assert.rejects(
        loadDatabaseUrl({ DATABASE_URL_FILE: file }),
        /unsafe ownership or permissions/,
      );
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('invalid and missing database connection sources fail closed', async () => {
  await assert.rejects(loadDatabaseUrl({}), /exactly one/);
  await assert.rejects(
    loadDatabaseUrl({ DATABASE_URL: 'https://example.test/db' }),
    /Invalid database/,
  );
  await assert.rejects(
    loadDatabaseUrl({ DATABASE_URL_FILE: './relative-secret' }),
    /absolute path/,
  );
});
