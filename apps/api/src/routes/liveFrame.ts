import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageError } from '@localqa/storage';
import { requireAuth } from '../auth.js';
import type { Router } from '../router.js';
import type { RequestContext } from '../types.js';

const LIVE_ROOT = join(
  process.env.DATA_DIR ?? '/var/localqa/data',
  'live-frames',
);
const MAX_FRAME_BYTES = 250_000;
const MAX_AGE_MS = 2500;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;

/** Ephemeral-only image transfer, not a report artifact or verdict. */
export function registerLiveFrameRoutes(router: Router): void {
  router.get(
    '/api/v1/tasks/{taskId}/live-frame',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const taskId = ctx.params.taskId!;
      if (!UUID.test(taskId)) throw new StorageError('NOT_FOUND');
      const task = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const row = (
          await client.query<{
            project_id: string;
            run_id: string;
            status: string;
            role: string;
            action_policy: string;
            auth_version: number | null;
            fencing_token: string;
          }>(
            `SELECT j.project_id,j.run_id,j.status,j.role,j.fencing_token,
                r.effective_config->>'actionPolicy' AS action_policy,
                CASE WHEN r.effective_config->>'authProfileVersion'='null'
                  THEN NULL ELSE (r.effective_config->>'authProfileVersion')::integer
                END AS auth_version
         FROM jobs j JOIN runs r ON r.id=j.run_id AND r.project_id=j.project_id
         WHERE j.id=$1`,
            [taskId],
          )
        ).rows[0];
        if (!row) throw new StorageError('NOT_FOUND');
        return row;
      });
      // Privacy boundary: never expose stream for authenticated or mutating
      // workflows. Normal saved screenshot artifacts have separate permissions.
      if (
        task.status !== 'running' ||
        task.action_policy !== 'non_submitting' ||
        task.auth_version !== null ||
        !['explorer', 'executor', 'reproducer'].includes(task.role)
      )
        throw new StorageError('NOT_FOUND');
      let bytes: Buffer;
      try {
        const file = join(LIVE_ROOT, taskId + '.jpg');
        const stat = await lstat(file);
        if (
          !stat.isFile() ||
          stat.size > MAX_FRAME_BYTES + 1024 ||
          stat.size < 150 ||
          Date.now() - stat.mtimeMs > MAX_AGE_MS
        )
          throw Error('stale');
        bytes = await readFile(file);
      } catch {
        ctx.res.statusCode = 204;
        ctx.res.setHeader('Cache-Control', 'no-store');
        ctx.res.end();
        return undefined;
      }
      const end = bytes.indexOf(10);
      let head: Record<string, unknown> = {};
      if (end < 10 || end > 1024) {
        ctx.res.statusCode = 204;
        ctx.res.end();
        return undefined;
      }
      try {
        head = JSON.parse(bytes.subarray(0, end).toString('utf8'));
      } catch {
        ctx.res.statusCode = 204;
        ctx.res.end();
        return undefined;
      }
      const image = bytes.subarray(end + 1);
      if (
        head['taskId'] !== taskId ||
        head['projectId'] !== task.project_id ||
        head['runId'] !== task.run_id ||
        head['schema'] !== 1 ||
        head['fencingToken'] !== Number(task.fencing_token) ||
        typeof head['capturedAt'] !== 'number' ||
        Math.abs(Date.now() - head['capturedAt']) > MAX_AGE_MS ||
        typeof head['sha256'] !== 'string' ||
        !SHA.test(head['sha256']) ||
        image.length > MAX_FRAME_BYTES ||
        image.length < 100 ||
        image[0] !== 0xff ||
        image[1] !== 0xd8 ||
        createHash('sha256').update(image).digest('hex') !== head['sha256']
      ) {
        ctx.res.statusCode = 204;
        ctx.res.setHeader('Cache-Control', 'no-store');
        ctx.res.end();
        return undefined;
      }
      ctx.res.setHeader('Content-Type', 'image/jpeg');
      ctx.res.setHeader('Cache-Control', 'private, no-store');
      ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
      ctx.res.setHeader('Referrer-Policy', 'no-referrer');
      ctx.res.setHeader(
        'X-Capture-Age-Ms',
        String(Date.now() - head['capturedAt']),
      );
      ctx.res.end(image);
      return undefined;
    },
  );
}
