import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/**
 * Load a PostgreSQL DSN without placing database credentials in an environment
 * variable or a process command line. The protected secret file is owned by
 * the running service UID and must not be group/world-accessible.
 *
 * DATABASE_URL remains a backwards-compatible development-only alternative.
 * Providing both sources is an error instead of an ambiguous fallback.
 */
export async function loadDatabaseUrl(env = process.env) {
  const filename = env.DATABASE_URL_FILE?.trim();
  const inline = env.DATABASE_URL?.trim();
  if (!!filename === !!inline)
    throw new Error(
      'Configure exactly one of DATABASE_URL_FILE or DATABASE_URL',
    );

  let connectionString = inline;
  if (filename) {
    if (!isAbsolute(filename))
      throw new Error('DATABASE_URL_FILE must be an absolute path');
    // O_NOFOLLOW refuses a symlink opened as the secret itself. Inspect the
    // actual open descriptor to avoid a path replacement TOCTOU race.
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const file = await open(filename, flags);
    try {
      const meta = await file.stat();
      if (!meta.isFile() || meta.size < 1 || meta.size > 8192)
        throw new Error('DATABASE_URL_FILE is not a regular sized secret');
      if (
        process.platform !== 'win32' &&
        ((meta.mode & 0o077) !== 0 ||
          (typeof process.getuid === 'function' &&
            meta.uid !== process.getuid()))
      )
        throw new Error(
          'DATABASE_URL_FILE has unsafe ownership or permissions',
        );
      connectionString = (await file.readFile({ encoding: 'utf8' })).trim();
    } finally {
      await file.close();
    }
  }
  // Do not expose the DSN in exceptions, logs or error messages.
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('Invalid database connection configuration');
  }
  if (
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.pathname ||
    url.pathname === '/'
  )
    throw new Error('Invalid database connection configuration');
  return connectionString;
}
