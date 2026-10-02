import { parseContract } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import { requireAuth } from '../auth.js';
import { parsePagination, paginate, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

export function registerConfigRoutes(router: Router): void {
  // GET /api/v1/projects/{projectId}/environments
  router.get(
    '/api/v1/projects/{projectId}/environments',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;

      const environments = await ctx.api.db.actor(
        ctx.actor!,
        async (client) => {
          await ctx.api.projectRepo.get(ctx.actor!, projectId);

          const rows = await client.query<{ document: unknown }>(
            `SELECT v.document
         FROM environments e
         JOIN environment_versions v
           ON v.project_id = e.project_id AND v.environment_id = e.id AND v.version = e.version
         WHERE e.project_id = $1
         ORDER BY v.created_at, e.id`,
            [projectId],
          );

          return rows.rows.map((r) => parseContract('Environment', r.document));
        },
      );

      const { limit, offset } = parsePagination(ctx.query);
      const page = paginate(environments, limit, offset);

      ctx.res.statusCode = 200;
      return parseContract('EnvironmentPage', page);
    },
  );

  // POST /api/v1/projects/{projectId}/environments
  router.post(
    '/api/v1/projects/{projectId}/environments',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;
      const input = parseContract('EnvironmentCreate', ctx.body);

      const created = await ctx.api.configRepo.createEnvironment(
        ctx.actor!,
        projectId,
        input,
      );

      ctx.res.statusCode = 201;
      return parseContract('Environment', created);
    },
  );

  // GET /api/v1/environments/{environmentId}
  router.get(
    '/api/v1/environments/{environmentId}',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const environmentId = ctx.params.environmentId!;

      const env = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const row = (
          await client.query<{ document: unknown }>(
            `SELECT v.document
           FROM environments e
           JOIN environment_versions v
             ON v.project_id = e.project_id AND v.environment_id = e.id AND v.version = e.version
           WHERE e.id = $1`,
            [environmentId],
          )
        ).rows[0];

        if (!row) throw new StorageError('NOT_FOUND');
        return parseContract('Environment', row.document);
      });

      ctx.res.statusCode = 200;
      return env;
    },
  );

  // PATCH /api/v1/environments/{environmentId}
  router.patch(
    '/api/v1/environments/{environmentId}',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const environmentId = ctx.params.environmentId!;
      const input = parseContract('EnvironmentPatch', ctx.body);

      const projectId = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const row = (
          await client.query<{ project_id: string }>(
            'SELECT project_id FROM environments WHERE id = $1',
            [environmentId],
          )
        ).rows[0];
        if (!row) throw new StorageError('NOT_FOUND');
        return row.project_id;
      });

      const updated = await ctx.api.configRepo.updateEnvironment(
        ctx.actor!,
        projectId,
        environmentId,
        input,
      );

      ctx.res.statusCode = 200;
      return parseContract('Environment', updated);
    },
  );

  // GET /api/v1/projects/{projectId}/auth-profiles
  router.get(
    '/api/v1/projects/{projectId}/auth-profiles',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;

      const profiles = await ctx.api.db.actor(ctx.actor!, async (client) => {
        await ctx.api.projectRepo.get(ctx.actor!, projectId);

        const rows = await client.query<{ document: unknown }>(
          `SELECT v.document
         FROM auth_profiles a
         JOIN auth_profile_versions v
           ON v.project_id = a.project_id AND v.auth_profile_id = a.id AND v.version = a.version
         WHERE a.project_id = $1
         ORDER BY v.created_at, a.id`,
          [projectId],
        );

        return rows.rows.map((r) => parseContract('AuthProfile', r.document));
      });

      const { limit, offset } = parsePagination(ctx.query);
      const page = paginate(profiles, limit, offset);

      ctx.res.statusCode = 200;
      return parseContract('AuthProfilePage', page);
    },
  );

  // POST /api/v1/projects/{projectId}/auth-profiles
  router.post(
    '/api/v1/projects/{projectId}/auth-profiles',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;
      const input = parseContract('AuthProfileCreate', ctx.body);

      const created = await ctx.api.configRepo.createAuthProfile(
        ctx.actor!,
        projectId,
        input,
      );

      ctx.res.statusCode = 201;
      return parseContract('AuthProfile', created);
    },
  );

  // PATCH /api/v1/auth-profiles/{authProfileId}
  router.patch(
    '/api/v1/auth-profiles/{authProfileId}',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const authProfileId = ctx.params.authProfileId!;
      const input = parseContract('AuthProfilePatch', ctx.body);

      const projectId = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const row = (
          await client.query<{ project_id: string }>(
            'SELECT project_id FROM auth_profiles WHERE id = $1',
            [authProfileId],
          )
        ).rows[0];
        if (!row) throw new StorageError('NOT_FOUND');
        return row.project_id;
      });

      const updated = await ctx.api.configRepo.updateAuthProfile(
        ctx.actor!,
        projectId,
        authProfileId,
        input,
      );

      ctx.res.statusCode = 200;
      return parseContract('AuthProfile', updated);
    },
  );

  // GET /api/v1/projects/{projectId}/knowledge
  router.get(
    '/api/v1/projects/{projectId}/knowledge',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;

      const knowledgeList = await ctx.api.db.actor(
        ctx.actor!,
        async (client) => {
          await ctx.api.projectRepo.get(ctx.actor!, projectId);

          const rows = await client.query<{ document: unknown }>(
            `SELECT v.document
         FROM knowledge k
         JOIN knowledge_versions v
           ON v.project_id = k.project_id AND v.knowledge_id = k.id AND v.version = k.version
         WHERE k.project_id = $1
         ORDER BY v.created_at, k.id`,
            [projectId],
          );

          return rows.rows.map((r) => parseContract('Knowledge', r.document));
        },
      );

      const { limit, offset } = parsePagination(ctx.query);
      const page = paginate(knowledgeList, limit, offset);

      ctx.res.statusCode = 200;
      return parseContract('KnowledgePage', page);
    },
  );

  // POST /api/v1/projects/{projectId}/knowledge
  router.post(
    '/api/v1/projects/{projectId}/knowledge',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;
      const input = parseContract('KnowledgeCreate', ctx.body);

      const created = await ctx.api.configRepo.createKnowledge(
        ctx.actor!,
        projectId,
        input,
      );

      ctx.res.statusCode = 201;
      return parseContract('Knowledge', created);
    },
  );

  // PATCH /api/v1/knowledge/{knowledgeId}
  router.patch(
    '/api/v1/knowledge/{knowledgeId}',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const knowledgeId = ctx.params.knowledgeId!;
      const input = parseContract('KnowledgePatch', ctx.body);

      const projectId = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const row = (
          await client.query<{ project_id: string }>(
            'SELECT project_id FROM knowledge WHERE id = $1',
            [knowledgeId],
          )
        ).rows[0];
        if (!row) throw new StorageError('NOT_FOUND');
        return row.project_id;
      });

      const updated = await ctx.api.configRepo.updateKnowledge(
        ctx.actor!,
        projectId,
        knowledgeId,
        input,
      );

      ctx.res.statusCode = 200;
      return parseContract('Knowledge', updated);
    },
  );
}
