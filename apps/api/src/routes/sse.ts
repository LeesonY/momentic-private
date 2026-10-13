import type { RunEvent } from '@localqa/contracts';
import { parseContract } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import { ApiError } from '../errors.js';
import { requireAuth } from '../auth.js';
import type { Router } from '../router.js';
import type { RequestContext } from '../types.js';

// Bound database reads during both initial replay and live tailing. A long
// business run must not deserialize its entire retained event history at once.
const SSE_BATCH_SIZE = 200;

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
    const timers: {
      ping?: ReturnType<typeof setInterval>;
      poll?: ReturnType<typeof setInterval>;
    } = {};
    // Poll intervals can overlap under database load. An older query must
    // never replay an already flushed event or race the event cursor.
    let pollInFlight = false;

    // IncomingMessage.close means that the request body has completed on
    // modern Node; it is not reliable evidence of an SSE disconnection.
    // Only the response's close event releases the live stream.
    ctx.res.on('close', () => {
      closed = true;
      if (timers.ping) clearInterval(timers.ping);
      if (timers.poll) clearInterval(timers.poll);
    });

    const readBatch = async (afterSeq: number): Promise<RunEvent[]> =>
      ctx.api.db.actor(ctx.actor!, async (client) => {
        const rows = await client.query<{
          seq: string;
          type: RunEvent['type'];
          payload: unknown;
          created_at: Date;
        }>(
          `SELECT seq, type, payload, created_at
         FROM run_events
         WHERE project_id = $1 AND run_id = $2 AND seq > $3
         ORDER BY seq ASC LIMIT $4`,
          [projectId, runId, afterSeq, SSE_BATCH_SIZE],
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

    const flushEvents = (events: readonly RunEvent[]) => {
      for (const ev of events) {
        if (closed) break;
        if (ev.seq <= currentSeq) continue;
        writeEvent(ev);
        currentSeq = ev.seq;
      }
    };

    // Historical replay is ordered and exhaustive, but each query and its
    // decoded payload are bounded. New commits after the final batch are
    // picked up by the poller from the same monotonic cursor.
    while (!closed) {
      const events = await readBatch(currentSeq);
      flushEvents(events);
      if (events.length < SSE_BATCH_SIZE) break;
    }
    if (closed) return undefined;

    // 15-second heartbeat ping
    timers.ping = setInterval(() => {
      if (closed) return;
      ctx.res.write(': ping\n\n');
    }, 15000);
    timers.ping.unref();

    // Live polling for newly committed events
    timers.poll = setInterval(async () => {
      if (closed || pollInFlight) return;
      pollInFlight = true;
      try {
        // Catch up with bursts without overlapping DB polls. Yield after
        // ten batches so a busy run cannot monopolize the event loop.
        for (let batch = 0; batch < 10 && !closed; batch++) {
          const events = await readBatch(currentSeq);
          flushEvents(events);
          if (events.length < SSE_BATCH_SIZE) break;
        }
      } catch {
        // Polling errors do not abort the client connection
      } finally {
        pollInFlight = false;
      }
    }, 250);
    timers.poll.unref();

    // Return undefined so the HTTP dispatcher does not close the response stream
    return undefined;
  });
}
