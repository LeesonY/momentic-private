import { randomUUID } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
import type {
  User,
  UserCreate,
  UserPatch,
  LoginResult,
} from '@localqa/contracts';
import type { PoolClient } from 'pg';
import { Database, StorageError, requireAdmin, audit } from './database.js';
import type { Actor } from './database.js';
import { hashPassword, verifyPassword, hashToken, newToken } from './crypto.js';

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  global_role: User['globalRole'];
  disabled: boolean;
  version: number;
};
export function userDTO(row: UserRow): User {
  return parseContract('User', {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    globalRole: row.global_role,
    disabled: row.disabled,
    version: row.version,
  });
}
const columns = 'id,email,display_name,global_role,disabled,version';
export class AccountsRepository {
  constructor(private readonly db: Database) {}
  async bootstrap(input: UserCreate): Promise<User> {
    const data = parseContract('UserCreate', input),
      hash = await hashPassword(data.password);
    return this.db.auth(async (client) => {
      const state = await client.query<{ initialized: boolean }>(
        'SELECT initialized FROM bootstrap_state WHERE singleton FOR UPDATE',
      );
      if (
        state.rows[0]?.initialized ||
        (await client.query('SELECT 1 FROM users LIMIT 1')).rowCount
      )
        throw new StorageError('VERSION_CONFLICT');
      const result = await client.query<UserRow>(
        `INSERT INTO users(id,email,display_name,password_hash,global_role) VALUES($1,$2,$3,$4,'admin') RETURNING ${columns}`,
        [randomUUID(), data.email.toLowerCase(), data.displayName, hash],
      );
      await client.query(
        'UPDATE bootstrap_state SET initialized=true WHERE singleton',
      );
      await client.query(
        `INSERT INTO audit_log(actor_id,action,object_id,result) VALUES($1,'bootstrap',$1,'ok')`,
        [result.rows[0]!.id],
      );
      return userDTO(result.rows[0]!);
    });
  }
  async create(actor: Actor, input: UserCreate): Promise<User> {
    const data = parseContract('UserCreate', input);
    // Avoid expensive KDF for non-admin callers.
    await this.db.actor(actor, requireAdmin);
    const hash = await hashPassword(data.password);
    return this.db.actor(actor, async (client) => {
      await requireAdmin(client);
      const result = await client.query<UserRow>(
        `INSERT INTO users(id,email,display_name,password_hash,global_role) VALUES($1,$2,$3,$4,$5) RETURNING ${columns}`,
        [
          randomUUID(),
          data.email.toLowerCase(),
          data.displayName,
          hash,
          data.globalRole ?? 'member',
        ],
      );
      await audit(client, 'user.created', result.rows[0]!.id);
      return userDTO(result.rows[0]!);
    });
  }
  async update(actor: Actor, id: string, input: UserPatch): Promise<User> {
    const data = parseContract('UserPatch', input);
    await this.db.actor(actor, requireAdmin);
    const hash =
      data.password === undefined ? null : await hashPassword(data.password);
    return this.db.actor(actor, async (client) => {
      await requireAdmin(client);
      if (
        !(await client.query('SELECT id FROM users WHERE id=$1', [id])).rowCount
      )
        throw new StorageError('NOT_FOUND');
      const result = await client.query<UserRow>(
        `SELECT * FROM patch_user($1,$2,$3,$4,$5,$6)`,
        [
          id,
          data.expectedVersion,
          data.displayName ?? null,
          data.disabled ?? null,
          data.globalRole ?? null,
          hash,
        ],
      );
      if (!result.rowCount) throw new StorageError('VERSION_CONFLICT');
      await audit(client, 'user.updated', id, null, result.rows[0]!.version);
      return userDTO(result.rows[0]!);
    });
  }
  async list(actor: Actor): Promise<User[]> {
    return this.db.actor(actor, async (client) => {
      await requireAdmin(client);
      return (
        await client.query<UserRow>(`SELECT ${columns} FROM users ORDER BY id`)
      ).rows.map(userDTO);
    });
  }
  async login(
    input: unknown,
    lifetimeSeconds = 3600,
  ): Promise<{ token: string; result: LoginResult }> {
    const data = parseContract('LoginInput', input);
    if (
      !Number.isSafeInteger(lifetimeSeconds) ||
      lifetimeSeconds < 1 ||
      lifetimeSeconds > 86400
    )
      throw new StorageError('VALIDATION_ERROR');
    return this.db.auth(async (client) => {
      const row = (
        await client.query<UserRow & { password_hash: string }>(
          'SELECT * FROM users WHERE lower(email)=$1 FOR SHARE',
          [data.email.toLowerCase()],
        )
      ).rows[0];
      if (!row) {
        await hashPassword(data.password);
        throw new StorageError('UNAUTHENTICATED');
      }
      if (
        !(await verifyPassword(data.password, row.password_hash)) ||
        row.disabled
      )
        throw new StorageError('UNAUTHENTICATED');
      const token = newToken();
      const result = await client.query<{ expires_at: Date }>(
        "INSERT INTO login_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+$3::integer*interval '1 second') RETURNING expires_at",
        [row.id, hashToken(token), lifetimeSeconds],
      );
      return {
        token,
        result: parseContract('LoginResult', {
          user: userDTO(row),
          expiresAt: result.rows[0]!.expires_at.toISOString(),
        }),
      };
    });
  }
  async authenticate(token: string): Promise<User> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new StorageError('UNAUTHENTICATED');
    return this.db.auth(async (client) => {
      const row = (
        await client.query<UserRow>(
          `SELECT u.id,u.email,u.display_name,u.global_role,u.disabled,u.version FROM login_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND NOT u.disabled`,
          [hashToken(token)],
        )
      ).rows[0];
      if (!row) throw new StorageError('UNAUTHENTICATED');
      return userDTO(row);
    });
  }
  async logout(token: string): Promise<void> {
    await this.db.auth(async (client) => {
      await client.query(
        'UPDATE login_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND revoked_at IS NULL',
        [hashToken(token)],
      );
    });
  }
}
export async function selectUser(
  client: PoolClient,
  id: string,
): Promise<User> {
  const row = (
    await client.query<UserRow>(`SELECT ${columns} FROM users WHERE id=$1`, [
      id,
    ])
  ).rows[0];
  if (!row) throw new StorageError('NOT_FOUND');
  return userDTO(row);
}
