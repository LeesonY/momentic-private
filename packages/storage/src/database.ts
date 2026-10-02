import pg from 'pg';
import type { PoolClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ErrorCode, Member } from '@localqa/contracts';

export class StorageError extends Error {
  constructor(
    readonly code: ErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}
export function mapDatabaseError(error: unknown): never {
  const db = error as { code?: string; message?: string };
  if (db.message === 'VERSION_CONFLICT')
    throw new StorageError('VERSION_CONFLICT');
  if (db.message === 'LEASE_EXPIRED') throw new StorageError('LEASE_EXPIRED');
  if (db.message === 'PROJECT_ARCHIVED')
    throw new StorageError('PROJECT_ARCHIVED');
  if (db.code === '23505') throw new StorageError('IDEMPOTENCY_CONFLICT');
  if (db.code === '23503' || db.code === '23514' || db.code === '22P02')
    throw new StorageError('VALIDATION_ERROR');
  if (db.code === '42501') throw new StorageError('NOT_FOUND');
  throw new StorageError('SERVICE_UNAVAILABLE'); // No SQL, stack or sensitive parameters in API errors.
}
export type Actor = { userId: string }; // Obtained from a verified server session, never the request body.
export type WorkerScope = { workerId: string; projectId: string }; // Verified by the internal identity boundary.
export class Database {
  readonly #pool: pg.Pool;
  constructor(connectionString: string) {
    this.#pool = new pg.Pool({
      connectionString,
      max: 8,
      options: '-c TimeZone=UTC',
    });
  }
  async close(): Promise<void> {
    await this.#pool.end();
  }
  async #transaction<T>(
    role: 'localqa_app' | 'localqa_auth' | 'localqa_worker',
    settings: Record<string, string>,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      await client.query(`SET LOCAL ROLE ${role}`);
      for (const [key, value] of Object.entries(settings))
        await client.query('SELECT set_config($1,$2,true)', [key, value]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof StorageError) throw error;
      mapDatabaseError(error);
    } finally {
      client.release();
    }
  }
  // Callbacks are trusted server code. SQL is still protected by forced RLS.
  actor<T>(actor: Actor, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.#transaction(
      'localqa_app',
      { 'localqa.actor_id': actor.userId },
      work,
    );
  }
  auth<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.#transaction('localqa_auth', {}, work);
  }
  worker<T>(
    scope: WorkerScope,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.#transaction(
      'localqa_worker',
      {
        'localqa.worker_project': scope.projectId,
        'localqa.worker_id': scope.workerId,
      },
      work,
    );
  }
}
export type Capability =
  | 'read'
  | 'run'
  | 'triage'
  | 'knowledge.write'
  | 'knowledge.approve'
  | 'config.write'
  | 'members.write'
  | 'secret.manage'
  | 'admin';
export const CAPABILITIES = Object.freeze({
  viewer: Object.freeze(['read']),
  operator: Object.freeze(['read', 'run', 'triage', 'knowledge.write']),
  owner: Object.freeze([
    'read',
    'run',
    'triage',
    'knowledge.write',
    'knowledge.approve',
    'config.write',
    'members.write',
    'secret.manage',
  ]),
  admin: Object.freeze([
    'read',
    'run',
    'triage',
    'knowledge.write',
    'knowledge.approve',
    'config.write',
    'members.write',
    'secret.manage',
    'admin',
  ]),
} satisfies Record<Member['role'] | 'admin', readonly Capability[]>);
export async function authorize(
  client: PoolClient,
  projectId: string,
  capability: Capability,
): Promise<Member['role'] | 'admin'> {
  const result = await client.query<{ role: Member['role'] | 'admin' }>(
    `SELECT CASE WHEN is_admin() THEN 'admin' ELSE project_role(id) END AS role FROM projects WHERE id=$1`,
    [projectId],
  );
  const role = result.rows[0]?.role;
  if (!role) throw new StorageError('NOT_FOUND');
  if (!(CAPABILITIES[role] as readonly string[]).includes(capability))
    throw new StorageError('FORBIDDEN');
  return role;
}
export async function requireAdmin(client: PoolClient): Promise<void> {
  if (
    !(await client.query<{ allowed: boolean }>('SELECT is_admin() AS allowed'))
      .rows[0]?.allowed
  )
    throw new StorageError('FORBIDDEN');
}
export async function audit(
  client: PoolClient,
  action: string,
  objectId: string | null,
  projectId: string | null = null,
  version: number | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log(project_id,actor_id,action,object_id,object_version,result) VALUES($1,actor_id(),$2,$3,$4,'ok')`,
    [projectId, action, objectId, version],
  );
}
export async function migrate(
  connectionString: string,
  directory = new URL('../migrations/', import.meta.url),
): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(741002)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS storage_migrations(name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const old = (
        await client.query<{ sha256: string }>(
          'SELECT sha256 FROM storage_migrations WHERE name=$1',
          [name],
        )
      ).rows[0];
      if (old) {
        if (old.sha256 !== hash)
          throw new Error(`Applied migration checksum changed: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO storage_migrations(name,sha256) VALUES($1,$2)',
          [name, hash],
        );
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(741002)');
    await client.end();
  }
  return applied;
}
