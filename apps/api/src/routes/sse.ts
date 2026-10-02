import type { RunEvent } from '@localqa/contracts';
import { parseContract } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import { ApiError } from '../errors.js';
import { requireAuth } from '../auth.js';
import type { Router } from '../router.js';
import type { RequestContext } from '../types.js';

export function registerSseRoutes(router: Router): void {
  // GET /api/v1/runs/{runId}/events
  router.get('/api/v1/runs/{runId}/events', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const runId = ctx.params.runId!;

    // Verify run exists and actor has read access to its project
    const projectId = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM runs WHERE id = $1',
          [runId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      return row.project_id;
    });

    // Parse Last-Event-ID from header or query param
    const lastEventIdHeader =
      ctx.headers['last-event-id'] || ctx.query['lastEventId'];
    let lastSeq = 0;
    if (lastEventIdHeader) {
      if (!/^(0|[1-9]\d*)$/.test(lastEventIdHeader)) {
        throw new ApiError('VALIDATION_ERROR', 'Invalid Last-Event-ID', 422);
      }
      const parsed = Number(lastEventIdHeader);
      if (!Number.isSafeInteger(parsed))
        throw new ApiError('VALIDATION_ERROR', 'Invalid Last-Event-ID', 422);
      lastSeq = parsed;
    }

    // Check for expired events (410 EVENTS_EXPIRED)
    const seqRange = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ min_seq: string | null; max_seq: string | null }>(
          'SELECT MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM run_events WHERE project_id = $1 AND run_id = $2',
          [projectId, runId],
        )
      ).rows[0];

      return {
        minSeq: row?.min_seq != null ? parseInt(row.min_seq, 10) : null,
        maxSeq: row?.max_seq != null ? parseInt(row.max_seq, 10) : null,
      };
    });

    if (seqRange.minSeq !== null && seqRange.maxSeq !== null) {
      if (lastSeq > 0 && lastSeq < seqRange.minSeq - 1) {
        throw new ApiError(
          'EVENTS_EXPIRED',
          'Requested event sequence has expired. Re-fetch full state.',
          410,
        );
      }
    }

    // Set SSE headers
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Helper to format and write SSE event
    const writeEvent = (event: RunEvent) => {
      const json = JSON.stringify(event);
      // Framing with event type for type listeners
      ctx.res.write(
        `id: ${event.seq}\nevent: ${event.type}\ndata: ${json}\n\n`,
      );
    };

    let currentSeq = lastSeq;
    let closed = false;

    // Fetch and send historical events
    const historical = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const rows = await client.query<{
        seq: string;
        type: RunEvent['type'];
        payload: unknown;
        created_at: Date;
      }>(
        `SELECT seq, type, payload, created_at
         FROM run_events
         WHERE project_id = $1 AND run_id = $2 AND seq > $3
         ORDER BY seq ASC`,
        [projectId, runId, currentSeq],
      );

      return rows.rows.map((r) =>
        parseContract('RunEvent', {
          schemaVersion: 1,
          id: String(r.seq),
          runId,
          seq: Number(r.seq),
          type: r.type,
          at: r.created_at.toISOString(),
          payload: r.payload,
        }),
      );
    });

    for (const ev of historical) {
      if (closed) break;
      writeEvent(ev);
      if (ev.seq > currentSeq) {
        currentSeq = ev.seq;
      }
    }

    // 15-second heartbeat ping
    const pingTimer = setInterval(() => {
      if (closed) return;
      ctx.res.write(': ping\n\n');
    }, 15000);
    pingTimer.unref();

    // Live polling for newly committed events
    const pollTimer = setInterval(async () => {
      if (closed) return;
      try {
        const newEvents = await ctx.api.db.actor(ctx.actor!, async (client) => {
          const rows = await client.query<{
            seq: string;
            type: RunEvent['type'];
            payload: unknown;
            created_at: Date;
          }>(
            `SELECT seq, type, payload, created_at
             FROM run_events
             WHERE project_id = $1 AND run_id = $2 AND seq > $3
             ORDER BY seq ASC`,
            [projectId, runId, currentSeq],
          );

          return rows.rows.map((r) =>
            parseContract('RunEvent', {
              schemaVersion: 1,
              id: String(r.seq),
              runId,
              seq: Number(r.seq),
              type: r.type,
              at: r.created_at.toISOString(),
              payload: r.payload,
            }),
          );
        });

        for (const ev of newEvents) {
          if (closed) break;
          writeEvent(ev);
          if (ev.seq > currentSeq) {
            currentSeq = ev.seq;
          }
        }
      } catch {
        // Polling errors do not abort the client connection
      }
    }, 250);
    pollTimer.unref();

    ctx.req.on('close', () => {
      closed = true;
      clearInterval(pingTimer);
      clearInterval(pollTimer);
    });

    // Return undefined so the HTTP dispatcher does not close the response stream
    return undefined;
  });
}
