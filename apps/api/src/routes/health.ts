import { parseContract } from '@localqa/contracts';
import type { Router } from '../router.js';
import type { RequestContext } from '../types.js';

export function registerHealthRoutes(router: Router): void {
  // GET /api/v1/health/live
  router.get('/api/v1/health/live', async (ctx: RequestContext) => {
    ctx.res.statusCode = 200;
    return parseContract('Health', {
      status: 'ok',
      version: '1.0.0',
    });
  });

  // GET /api/v1/health/ready
  router.get('/api/v1/health/ready', async (ctx: RequestContext) => {
    try {
      await ctx.api.db.auth(async (client) => {
        await client.query('SELECT 1 FROM bootstrap_state WHERE singleton');
      });

      ctx.res.statusCode = 200;
      return parseContract('Health', {
        status: 'ok',
        version: '1.0.0',
      });
    } catch {
      ctx.res.statusCode = 503;
      return parseContract('Health', {
        status: 'not_ready',
        version: '1.0.0',
      });
    }
  });
}
