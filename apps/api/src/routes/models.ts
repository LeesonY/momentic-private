import { parseContract, isErrorCode } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import { requireAuth, requireAdmin } from '../auth.js';
import { ApiError } from '../errors.js';
import { createFrozenGateway } from '../frozen-model.js';
import { parsePagination, paginate, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

export function registerModelRoutes(router: Router): void {
  // Project-scoped profiles: a globally listed model is not permission to use it.
  router.get(
    '/api/v1/projects/{projectId}/model-profiles',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;
      await ctx.api.projectRepo.get(ctx.actor!, projectId);
      const models = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const result = await client.query<{ document: unknown }>(
          `SELECT v.document
           FROM model_profile_grants g
           JOIN model_profiles p ON p.id = g.profile_id
           JOIN model_profile_versions v ON v.profile_id = p.id AND v.version = p.version
          WHERE g.project_id = $1 AND p.deleted_at IS NULL
          ORDER BY p.created_at, p.id`,
          [projectId],
        );
        return result.rows.map((row) =>
          parseContract('ModelProfile', row.document),
        );
      });
      const { limit, offset } = parsePagination(ctx.query);
      ctx.res.statusCode = 200;
      return parseContract('ModelProfilePage', paginate(models, limit, offset));
    },
  );

  // Admin grant. The repository enforces both admin identity and project
  // owner permission; no credentials or unapproved model content is returned.
  router.post(
    '/api/v1/projects/{projectId}/model-profiles',
    async (ctx: RequestContext) => {
      await requireAdmin(ctx);
      const projectId = ctx.params.projectId!;
      const { modelProfileId } = parseContract('ModelGrantCreate', ctx.body);
      await ctx.api.projectRepo.get(ctx.actor!, projectId);
      const model = await ctx.api.modelRepo.get(ctx.actor!, modelProfileId);
      await ctx.api.modelRepo.grant(ctx.actor!, projectId, modelProfileId);
      ctx.res.statusCode = 201;
      return parseContract('ModelProfile', model);
    },
  );

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
         WHERE m.deleted_at IS NULL
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

  router.delete(
    '/api/v1/model-profiles/{modelProfileId}',
    async (ctx: RequestContext) => {
      await requireAdmin(ctx);
      const input = parseContract('ModelDeleteConfirm', ctx.body);
      await ctx.api.modelRepo.delete(
        ctx.actor!,
        ctx.params.modelProfileId!,
        input,
      );
      ctx.res.statusCode = 204;
      ctx.res.end();
    },
  );

  // All model profiles share the same 120s probe budget.
  // POST /api/v1/model-profiles/{modelProfileId}/probe
  router.post(
    '/api/v1/model-profiles/{modelProfileId}/probe',
    async (ctx: RequestContext) => {
      await requireAdmin(ctx);
      const profileId = ctx.params.modelProfileId!;
      const current = await ctx.api.modelRepo.get(ctx.actor!, profileId);
      if (current.status === 'disabled') {
        throw new ApiError(
          'MODEL_NOT_CONFIGURED',
          'Model profile is disabled',
          409,
        );
      }
      if (!ctx.api.modelTransport) {
        throw new ApiError(
          'MODEL_NOT_CONFIGURED',
          'Model transport is not configured',
          409,
        );
      }
      const frozen = await ctx.api.modelRepo.readVersion(
        ctx.actor!,
        profileId,
        current.version,
      );
      if (frozen.document.status === 'disabled') {
        throw new ApiError(
          'MODEL_NOT_CONFIGURED',
          'Model profile is disabled',
          409,
        );
      }
      const probeRecord = await createFrozenGateway(
        frozen,
        ctx.api.modelTransport,
      ).capabilityProbe(profileId, 120_000);
      if (
        probeRecord.requestResult !== 'ok' ||
        probeRecord.errorCode ||
        !probeRecord.data
      ) {
        const code =
          probeRecord.errorCode && isErrorCode(probeRecord.errorCode)
            ? probeRecord.errorCode
            : 'SERVICE_UNAVAILABLE';
        throw new ApiError(code, 'Model probe failed');
      }
      let probeResult;
      try {
        probeResult = parseContract('ModelProbeResult', probeRecord.data);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new ApiError('SERVICE_UNAVAILABLE', 'Model probe failed');
      }
      if (probeResult.status === 'disabled') {
        throw new ApiError(
          'MODEL_NOT_CONFIGURED',
          'Automatic probe cannot disable a profile',
          409,
        );
      }
      const saved = await ctx.api.modelRepo.recordProbe(
        ctx.actor!,
        profileId,
        current.version,
        {
          capabilities: probeResult.capabilities,
          status: probeResult.status,
        },
      );
      if (!saved) {
        throw new ApiError(
          'MODEL_NOT_CONFIGURED',
          'Model profile is disabled',
          409,
        );
      }
      ctx.res.statusCode = 200;
      return probeResult;
    },
  );
}
