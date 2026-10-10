import { parseContract } from '@localqa/contracts';
import { authorize } from '@localqa/storage';
import { requireAuth } from '../auth.js';
import { createApiKey, revokeApiKey } from '../apiKeys.js';
import { parsePagination, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

export function registerApiKeyRoutes(router: Router): void {
  router.get(
    '/api/v1/projects/{projectId}/api-keys',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;
      const { limit, offset } = parsePagination(ctx.query);
      const page = await ctx.api.db.actor(ctx.actor!, async (client) => {
        await authorize(client, projectId, 'run');
        const rows = (
          await client.query<{
            id: string;
            name: string;
            scope: string[];
            created_by: string;
            created_at: Date;
            expires_at: Date | null;
            revoked_at: Date | null;
          }>(
            `SELECT id,name,scope,created_by,created_at,expires_at,revoked_at
             FROM api_keys WHERE project_id=$1
             ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
            [projectId, limit + 1, offset],
          )
        ).rows;
        return {
          items: rows.slice(0, limit).map((row) =>
            parseContract('ApiKey', {
              id: row.id,
              projectId,
              name: row.name,
              scope: row.scope,
              createdBy: row.created_by,
              createdAt: row.created_at.toISOString(),
              expiresAt: row.expires_at?.toISOString() ?? null,
              revokedAt: row.revoked_at?.toISOString() ?? null,
            }),
          ),
          nextCursor:
            rows.length > limit
              ? Buffer.from(String(offset + limit)).toString('base64url')
              : null,
        };
      });
      ctx.res.statusCode = 200;
      ctx.res.setHeader('Cache-Control', 'no-store');
      return parseContract('ApiKeyPage', page);
    },
  );
  router.post(
    '/api/v1/projects/{projectId}/api-keys',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const issued = await createApiKey(ctx, ctx.params.projectId!, ctx.body);
      ctx.res.statusCode = 201;
      ctx.res.setHeader('Cache-Control', 'no-store');
      return parseContract('ApiKeyCreated', issued);
    },
  );
  router.post(
    '/api/v1/api-keys/{keyId}/revoke',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      return revokeApiKey(ctx, ctx.params.keyId!);
    },
  );
}
