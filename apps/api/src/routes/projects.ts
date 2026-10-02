import { parseContract } from '@localqa/contracts';
import type { Member } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import { requireAuth, requireAdmin } from '../auth.js';
import { parsePagination, paginate, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

export function registerProjectRoutes(router: Router): void {
  // GET /api/v1/projects
  router.get('/api/v1/projects', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const projects = await ctx.api.projectRepo.list(ctx.actor!);
    const { limit, offset } = parsePagination(ctx.query);
    const page = paginate(projects, limit, offset);

    ctx.res.statusCode = 200;
    return parseContract('ProjectPage', page);
  });

  // POST /api/v1/projects
  router.post('/api/v1/projects', async (ctx: RequestContext) => {
    await requireAdmin(ctx);
    const input = parseContract('ProjectCreate', ctx.body);
    const created = await ctx.api.projectRepo.create(ctx.actor!, input);

    ctx.res.statusCode = 201;
    return parseContract('Project', created);
  });

  // GET /api/v1/projects/{projectId}
  router.get('/api/v1/projects/{projectId}', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const project = await ctx.api.projectRepo.get(
      ctx.actor!,
      ctx.params.projectId!,
    );

    ctx.res.statusCode = 200;
    return parseContract('Project', project);
  });

  // PATCH /api/v1/projects/{projectId}
  router.patch('/api/v1/projects/{projectId}', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const input = parseContract('ProjectPatch', ctx.body);
    const updated = await ctx.api.projectRepo.update(
      ctx.actor!,
      ctx.params.projectId!,
      input,
    );

    ctx.res.statusCode = 200;
    return parseContract('Project', updated);
  });

  // GET /api/v1/projects/{projectId}/members
  router.get(
    '/api/v1/projects/{projectId}/members',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;

      const members = await ctx.api.db.actor(ctx.actor!, async (client) => {
        // First verify project exists and is readable under RLS
        const exists = (
          await client.query('SELECT 1 FROM projects WHERE id = $1', [
            projectId,
          ])
        ).rowCount;
        if (!exists) throw new StorageError('NOT_FOUND');

        const rows = await client.query<{
          userId: string;
          role: Member['role'];
        }>(
          `SELECT pm.user_id AS "userId", pm.role
           FROM project_members pm
           WHERE pm.project_id = $1
           ORDER BY pm.user_id`,
          [projectId],
        );

        return rows.rows.map((r) =>
          parseContract('Member', {
            userId: r.userId,
            role: r.role,
          }),
        );
      });

      const { limit, offset } = parsePagination(ctx.query);
      const page = paginate(members, limit, offset);

      ctx.res.statusCode = 200;
      return parseContract('MemberPage', page);
    },
  );

  // PUT /api/v1/projects/{projectId}/members
  router.put(
    '/api/v1/projects/{projectId}/members',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;
      const input = parseContract('MemberUpdate', ctx.body);

      await ctx.api.projectRepo.replaceMembers(ctx.actor!, projectId, input);
      const updatedProject = await ctx.api.projectRepo.get(
        ctx.actor!,
        projectId,
      );

      ctx.res.statusCode = 200;
      return parseContract('Project', updatedProject);
    },
  );
}
