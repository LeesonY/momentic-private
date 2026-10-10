import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
import type { ApiKey, ApiKeyScope } from '@localqa/contracts';
import { authorize, StorageError, audit } from '@localqa/storage';
import type { RequestContext } from './types.js';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Only routes with an explicitly defined project boundary accept CI keys. */
function keyRoute(ctx: RequestContext): {
  scope: ApiKeyScope;
  projectId: string | null;
  runId: string | null;
} | null {
  const method = ctx.method.toUpperCase();
  const path = ctx.pathname;
  if (
    method === 'POST' &&
    (path === '/api/v1/runs' || path === '/api/v1/regression-runs')
  ) {
    const body = ctx.body as Record<string, unknown> | null;
    return {
      scope: 'runs:create',
      projectId: typeof body?.projectId === 'string' ? body.projectId : null,
      runId: null,
    };
  }
  if (method === 'GET' && path === '/api/v1/runs')
    return {
      scope: 'runs:read',
      projectId: ctx.query['projectId'] ?? null,
      runId: null,
    };
  const match =
    /^\/api\/v1\/runs\/([a-f0-9-]{36})(?:\/(report|cancel))?$/i.exec(path);
  if (!match) return null;
  const suffix = match[2];
  if (!suffix && method === 'GET')
    return { scope: 'runs:read', projectId: null, runId: match[1]! };
  if (suffix === 'report' && method === 'GET')
    return { scope: 'reports:read', projectId: null, runId: match[1]! };
  if (suffix === 'cancel' && method === 'POST')
    return { scope: 'runs:cancel', projectId: null, runId: match[1]! };
  return null;
}

export async function authenticateApiKey(
  ctx: RequestContext,
  authorization: string,
): Promise<void> {
  if (!/^Bearer [A-Za-z0-9_-]{35,160}$/.test(authorization))
    throw new StorageError('UNAUTHENTICATED');
  const route = keyRoute(ctx);
  if (!route) throw new StorageError('FORBIDDEN');
  const hash = tokenHash(authorization.slice(7));
  const identity = await ctx.api.db.actor(
    ctx.api.adminActor,
    async (client) => {
      const row = (
        await client.query<{
          id: string;
          project_id: string;
          scope: ApiKeyScope[];
          created_by: string;
          user_active: boolean;
          project_active: boolean;
        }>(
          `SELECT k.id,k.project_id,k.scope,k.created_by,
                NOT u.disabled AS user_active,
                (p.status = 'active') AS project_active
         FROM api_keys k
         JOIN users u ON u.id=k.created_by
         JOIN projects p ON p.id=k.project_id
         WHERE k.token_hash=$1 AND k.revoked_at IS NULL
           AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())`,
          [hash],
        )
      ).rows[0];
      if (!row || !row.user_active || !row.project_active)
        throw new StorageError('UNAUTHENTICATED');
      return row;
    },
  );
  if (!identity.scope.includes(route.scope))
    throw new StorageError('FORBIDDEN');
  if (route.projectId && identity.project_id !== route.projectId)
    throw new StorageError('FORBIDDEN');
  if (!route.projectId) {
    if (!route.runId) throw new StorageError('FORBIDDEN');
    const runProject = await ctx.api.db.actor(
      ctx.api.adminActor,
      async (client) =>
        (
          await client.query<{ project_id: string }>(
            'SELECT project_id FROM runs WHERE id=$1',
            [route.runId],
          )
        ).rows[0]?.project_id,
    );
    if (!runProject || runProject !== identity.project_id)
      throw new StorageError('NOT_FOUND');
  }
  // The owner must STILL have the required role today. Revocation of project
  // membership instantly revokes effective use of previously issued keys.
  const capability =
    route.scope === 'runs:read' || route.scope === 'reports:read'
      ? 'read'
      : 'run';
  await ctx.api.db.actor({ userId: identity.created_by }, (client) =>
    authorize(client, identity.project_id, capability),
  );
  ctx.actor = { userId: identity.created_by };
  ctx.user = null;
}

export async function createApiKey(
  ctx: RequestContext,
  projectId: string,
  rawInput: unknown,
): Promise<{ key: ApiKey; token: string }> {
  const input = parseContract('ApiKeyCreate', rawInput);
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
    throw new StorageError('VALIDATION_ERROR');
  const token = `lqa_${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  const key = await ctx.api.db.actor(ctx.actor!, async (client) => {
    const role = await authorize(client, projectId, 'run');
    if (!['owner', 'admin', 'operator'].includes(role))
      throw new StorageError('FORBIDDEN');
    const created = (
      await client.query<{
        created_at: Date;
      }>(
        `INSERT INTO api_keys(
           id,project_id,name,scope,token_hash,created_by,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING created_at`,
        [
          id,
          projectId,
          input.name,
          JSON.stringify([...new Set(input.scope)]),
          tokenHash(token),
          ctx.actor!.userId,
          input.expiresAt ?? null,
        ],
      )
    ).rows[0]!;
    await audit(client, 'api_key.created', id, projectId);
    return parseContract('ApiKey', {
      id,
      projectId,
      name: input.name,
      scope: [...new Set(input.scope)],
      createdBy: ctx.actor!.userId,
      createdAt: created.created_at.toISOString(),
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
    });
  });
  return { key, token };
}

export async function revokeApiKey(
  ctx: RequestContext,
  id: string,
): Promise<ApiKey> {
  return ctx.api.db.actor(ctx.actor!, async (client) => {
    const row = (
      await client.query<{
        project_id: string;
        name: string;
        scope: ApiKeyScope[];
        created_by: string;
        created_at: Date;
        expires_at: Date | null;
        revoked_at: Date | null;
      }>('SELECT * FROM api_keys WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    if (!row) throw new StorageError('NOT_FOUND');
    const role = await authorize(client, row.project_id, 'run');
    if (
      role !== 'owner' &&
      role !== 'admin' &&
      row.created_by !== ctx.actor!.userId
    )
      throw new StorageError('FORBIDDEN');
    const revokedAt = row.revoked_at ?? new Date();
    if (!row.revoked_at)
      await client.query('UPDATE api_keys SET revoked_at=$2 WHERE id=$1', [
        id,
        revokedAt,
      ]);
    await audit(client, 'api_key.revoked', id, row.project_id);
    return parseContract('ApiKey', {
      id,
      projectId: row.project_id,
      name: row.name,
      scope: row.scope,
      createdBy: row.created_by,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at?.toISOString() ?? null,
      revokedAt: revokedAt.toISOString(),
    });
  });
}
