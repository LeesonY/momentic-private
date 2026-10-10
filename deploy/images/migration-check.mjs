import { readdir } from 'node:fs/promises';

/** Schema readiness for the complete migration set shipped in this image. */
export async function hasAllMigrations(client) {
  const expected = (
    await readdir(
      new URL('../../packages/storage/migrations/', import.meta.url),
    )
  ).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name));
  if (!expected.length) return false;
  const installed = await client.query('SELECT name FROM storage_migrations');
  const applied = new Set(installed.rows.map((row) => row.name));
  return expected.every((name) => applied.has(name));
}
