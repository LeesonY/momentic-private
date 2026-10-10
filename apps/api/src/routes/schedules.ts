import { parseContract } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import { requireAuth } from '../auth.js';
import {
  createSchedule,
  updateSchedule,
  listSchedules,
  listOccurrences,
  runScheduleNow,
} from '../scheduleService.js';
import { parsePagination, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

export function registerScheduleRoutes(router: Router): void {
  router.get(
    '/api/v1/projects/{projectId}/schedules',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const { limit, offset } = parsePagination(ctx.query);
      return parseContract(
        'SchedulePage',
        await listSchedules(ctx, ctx.params.projectId!, limit, offset),
      );
    },
  );
  router.post(
    '/api/v1/projects/{projectId}/schedules',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const result = await createSchedule(ctx, ctx.params.projectId!, ctx.body);
      ctx.res.statusCode = 201;
      return result;
    },
  );
  router.patch(
    '/api/v1/schedules/{scheduleId}',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      return updateSchedule(ctx, ctx.params.scheduleId!, ctx.body);
    },
  );
  router.get(
    '/api/v1/schedules/{scheduleId}/occurrences',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const { limit, offset } = parsePagination(ctx.query);
      return parseContract(
        'ScheduleOccurrencePage',
        await listOccurrences(ctx, ctx.params.scheduleId!, limit, offset),
      );
    },
  );
  router.post(
    '/api/v1/schedules/{scheduleId}/run-now',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const run = await runScheduleNow(ctx, ctx.params.scheduleId!);
      if (!run) throw new StorageError('POLICY_DENIED');
      ctx.res.statusCode = 202;
      return parseContract('Run', run);
    },
  );
}
