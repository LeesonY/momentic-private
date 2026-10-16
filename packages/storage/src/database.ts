import pg from 'pg';
import type { PoolClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ErrorCode, Member } from '@localqa/contracts';

export class StorageError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}
/**
 * The database itself was unreachable or too busy to hand out a connection
 * (pool acquisition timeout, dropped socket, server shutdown). Distinct from a
 * plain SERVICE_UNAVAILABLE so a caller may retry an idempotent operation
 * instead of failing a whole task on a transient blip.
 */
export class DatabaseUnavailableError extends StorageError {
  constructor(
    message = 'SERVICE_UNAVAILABLE',
    readonly cause?: unknown,
  ) {
    super('SERVICE_UNAVAILABLE', message);
    this.name = 'DatabaseUnavailableError';
  }
}
const TRANSIENT_SQL_STATES = [
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
];
const TRANSIENT_SYSCALL_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
];
function transientDatabaseFailure(db: { code?: string; message?: string }) {
  if (typeof db.code === 'string' && TRANSIENT_SQL_STATES.includes(db.code))
    return true;
  if (typeof db.code === 'string' && TRANSIENT_SYSCALL_CODES.includes(db.code))
    return true;
  // pg-pool's bounded acquisition in #transaction reports this message.
  return (
    typeof db.message === 'string' &&
    db.message.includes('timeout exceeded when trying to connect')
  );
}
/** True only for connectivity/overload failures that are safe to retry. */
export function isTransientDatabaseError(error: unknown): boolean {
  return error instanceof DatabaseUnavailableError;
}
/**
 * Bounded retry for idempotent database work (lease heartbeats, budget
 * reservations). Never wraps a call whose database effect must happen exactly
 * once: finish/settle/action recording stay single-shot and are fenced by
 * their own idempotency keys.
 */
export async function withTransientRetry<T>(
  work: () => Promise<T>,
  options: { attempts?: number; delaysMs?: readonly number[] } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10)
    throw new StorageError('VALIDATION_ERROR');
  const delays = options.delaysMs ?? [250, 500];
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseError(error) || attempt === attempts) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, delays[Math.min(attempt - 1, delays.length - 1)]),
      );
    }
  }
  throw lastError;
}
/** DB_POOL_MAX, or an explicit value, bounded to a sane PostgreSQL range. */
export function resolvePoolMax(explicit?: number): number {
  const raw =
    explicit ??
    (process.env.DB_POOL_MAX === undefined
      ? undefined
      : Number(process.env.DB_POOL_MAX));
  if (raw === undefined) return 8;
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 100) {
    console.warn(
      `Ignoring invalid DB_POOL_MAX/pool size (${String(raw)}); using 8`,
    );
    return 8;
  }
  return raw;
}
export function mapDatabaseError(error: unknown): never {
  const db = error as { code?: string; message?: string };
  if (db.message === 'VERSION_CONFLICT')
    throw new StorageError('VERSION_CONFLICT');
  if (db.message === 'LEASE_EXPIRED') throw new StorageError('LEASE_EXPIRED');
  if (db.message === 'PROJECT_ARCHIVED')
    throw new StorageError('PROJECT_ARCHIVED');
  if (db.message === 'TARGET_NOT_ALLOWED')
    throw new StorageError(
      'TARGET_NOT_ALLOWED',
      '环境已删除或不可用，请重新选择环境',
    );
  if (db.message === 'AUTH_REVOKED')
    throw new StorageError(
      'FORBIDDEN',
      '认证配置已删除或吊销，请重新选择认证配置',
    );
  if (db.message === 'MODEL_NOT_CONFIGURED')
    throw new StorageError(
      'MODEL_NOT_CONFIGURED',
      '模型已删除或不可用，请重新选择模型',
    );
  if (db.code === '23505') throw new StorageError('IDEMPOTENCY_CONFLICT');
  if (db.code === '23503' || db.code === '23514' || db.code === '22P02')
    throw new StorageError('VALIDATION_ERROR');
  if (db.code === '42501') throw new StorageError('NOT_FOUND');
  // Connectivity and pool-overload failures keep the public SERVICE_UNAVAILABLE
  // code but are distinguishable for bounded retries.
  if (transientDatabaseFailure(db)) throw new DatabaseUnavailableError();
  throw new StorageError('SERVICE_UNAVAILABLE'); // No SQL, stack or sensitive parameters in API errors.
}
export type Actor = { userId: string }; // Obtained from a verified server session, never the request body.
export type WorkerScope = { workerId: string; projectId: string }; // Verified by the internal identity boundary.
export class Database {
  readonly #pool: pg.Pool;
  constructor(connectionString: string, options: { poolMax?: number } = {}) {
    this.#pool = new pg.Pool({
      connectionString,
      max: resolvePoolMax(options.poolMax),
      // Bounded acquisition on outage: pooled callers must not wait forever.
      // Transactions are still fenced by their own worker leases.
      connectionTimeoutMillis: 10000,
      options: '-c TimeZone=UTC',
    });
    // pg emits errors on idle pooled clients when PostgreSQL restarts. Without
    // a listener Node treats this as an uncaught exception and kills the
    // Worker/API process, potentially during a separate leased task.
    this.#pool.on('error', (error: Error & { code?: string }) => {
      console.error(
        'Database idle connection lost',
        error.code ?? 'connection_error',
      );
    });
    this.#pool.on('connect', (client) => {
      client.on('error', (error: Error & { code?: string }) => {
        console.error(
          'Database client connection lost',
          error.code ?? 'connection_error',
        );
      });
    });
  }
  async close(): Promise<void> {
    await this.#pool.end();
  }
  /** Effective pool size, for readiness logs and tests. */
  get poolMax(): number {
    return this.#pool.options.max ?? 8;
  }
  async #transaction<T>(
    role: 'localqa_app' | 'localqa_auth' | 'localqa_worker',
    settings: Record<string, string>,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      // pg.Pool.connect() failures happen before BEGIN/ROLLBACK. Map them
      // into stable, redacted storage errors just like in-flight failures.
      return mapDatabaseError(error);
    }
    let connectionLost = false;
    const onClientError = () => {
      connectionLost = true;
    };
    // A checked-out client can emit 'error' independently of its current query
    // when the server is restarted. Pool's idle-client listener does not own it.
    client.on('error', onClientError);
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
      try {
        await client.query('ROLLBACK');
      } catch {
        connectionLost = true;
      }
      if (error instanceof StorageError) throw error;
      return mapDatabaseError(error);
    } finally {
      client.removeListener('error', onClientError);
      client.release(
        connectionLost ? new Error('Database connection lost') : undefined,
      );
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
