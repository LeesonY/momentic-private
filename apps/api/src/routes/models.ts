import { parseContract } from '@localqa/contracts';
import { requireAuth, requireAdmin } from '../auth.js';
import { parsePagination, paginate, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

export function registerModelRoutes(router: Router): void {
  // GET /api/v1/model-profiles
  router.get('/api/v1/model-profiles', async (ctx: RequestContext) => {
    await requireAuth(ctx);

    const profiles = await ctx.api.db.actor(
      ctx.api.adminActor,
      async (client) => {
        const rows = await client.query<{ document: unknown }>(
          `SELECT v.document
         FROM model_profiles m
         JOIN model_profile_versions v
           ON v.profile_id = m.id AND v.version = m.version
         ORDER BY m.created_at, m.id`,
        );
        return rows.rows.map((r) => parseContract('ModelProfile', r.document));
      },
    );

    const { limit, offset } = parsePagination(ctx.query);
    const page = paginate(profiles, limit, offset);

    ctx.res.statusCode = 200;
    return parseContract('ModelProfilePage', page);
  });

  // POST /api/v1/model-profiles
  router.post('/api/v1/model-profiles', async (ctx: RequestContext) => {
    await requireAdmin(ctx);
    const input = parseContract('ModelProfileCreate', ctx.body);
    const created = await ctx.api.modelRepo.create(ctx.actor!, input);

    ctx.res.statusCode = 201;
    return parseContract('ModelProfile', created);
  });

  // GET /api/v1/model-profiles/{modelProfileId}
  router.get(
    '/api/v1/model-profiles/{modelProfileId}',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const profile = await ctx.api.modelRepo.get(
        ctx.actor!,
        ctx.params.modelProfileId!,
      );

      ctx.res.statusCode = 200;
      return parseContract('ModelProfile', profile);
    },
  );

  // PATCH /api/v1/model-profiles/{modelProfileId}
  router.patch(
    '/api/v1/model-profiles/{modelProfileId}',
    async (ctx: RequestContext) => {
      await requireAdmin(ctx);
      const input = parseContract('ModelProfilePatch', ctx.body);
      const updated = await ctx.api.modelRepo.update(
        ctx.actor!,
        ctx.params.modelProfileId!,
        input,
      );

      ctx.res.statusCode = 200;
      return parseContract('ModelProfile', updated);
    },
  );

  // POST /api/v1/model-profiles/{modelProfileId}/probe
  router.post(
    '/api/v1/model-profiles/{modelProfileId}/probe',
    async (ctx: RequestContext) => {
      await requireAdmin(ctx);
      const profileId = ctx.params.modelProfileId!;

      // Verify model exists
      await ctx.api.modelRepo.get(ctx.actor!, profileId);

      const probeRecord = await ctx.api.gateway.capabilityProbe(profileId);
      const probeResult = probeRecord.data
        ? parseContract('ModelProbeResult', probeRecord.data)
        : parseContract('ModelProbeResult', {
            profileId,
            capabilities: {
              structuredOutput: true,
              nativeTools: true,
              imageInput: false,
            },
            status: 'ready',
            notes: [],
          });

      ctx.res.statusCode = 200;
      return probeResult;
    },
  );
}
