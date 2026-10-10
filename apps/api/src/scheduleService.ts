import { randomUUID } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
import type {
  Schedule,
  ScheduleCreate,
  SchedulePatch,
  ScheduleOccurrence,
  Run,
} from '@localqa/contracts';
import { authorize, StorageError } from '@localqa/storage';
import type { ApiContext, RequestContext } from './types.js';
import {
  matchingMinutes,
  parseScheduleClock,
  scheduledLocal,
} from './scheduleClock.js';
import { startTrustedSmokeRun } from './routes/runs.js';
import { startTrustedRegressionRun } from './routes/savedCases.js';

interface ScheduleRow {
  id: string;
  project_id: string;
  name: string;
  cron: string;
  timezone: string;
  template_kind: 'smoke' | 'regression';
  run_template: unknown;
  overlap_policy: 'skip' | 'queue';
  missed_policy: 'skip' | 'catchup_one';
  enabled: boolean;
  version: number;
  created_by: string | null;
  last_checked_at: Date | null;
  created_at: Date;
}

interface OccurrenceRow {
  id: string;
  schedule_id: string;
  project_id: string;
  schedule_version: number;
  scheduled_at: Date;
  scheduled_local: string;
  status: 'pending' | 'dispatching' | 'started' | 'skipped' | 'failed';
  run_id: string | null;
  created_at: Date;
  template_kind_snapshot: 'smoke' | 'regression' | null;
  run_template_snapshot: unknown | null;
  overlap_policy_snapshot: 'skip' | 'queue' | null;
}

const asSchedule = (row: ScheduleRow): Schedule =>
  parseContract('Schedule', {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    templateKind: row.template_kind,
    runTemplate: row.run_template,
    overlapPolicy: row.overlap_policy,
    missedPolicy: row.missed_policy,
    enabled: row.enabled,
    version: row.version,
    createdAt: row.created_at.toISOString(),
  });
const asOccurrence = (row: OccurrenceRow): ScheduleOccurrence =>
  parseContract('ScheduleOccurrence', {
    id: row.id,
    projectId: row.project_id,
    scheduleId: row.schedule_id,
    scheduleVersion: row.schedule_version,
    scheduledAt: row.scheduled_at.toISOString(),
    scheduledLocal: row.scheduled_local,
    status: row.status,
    runId: row.run_id,
    createdAt: row.created_at.toISOString(),
  });

async function validateTemplate(
  client: import('pg').PoolClient,
  projectId: string,
  kind: 'smoke' | 'regression',
  template: unknown,
): Promise<void> {
  const parsed = parseContract(
    kind === 'smoke' ? 'RunCreate' : 'RegressionRunCreate',
    template,
  );
  if (parsed.projectId !== projectId)
    throw new StorageError('VALIDATION_ERROR');
  if (kind === 'regression') {
    const ids = (parsed as { caseVersionIds: string[] }).caseVersionIds;
    if (new Set(ids).size !== ids.length)
      throw new StorageError('VALIDATION_ERROR');
    const rows = (
      await client.query<{ id: string }>(
        `SELECT v.id FROM saved_case_versions v
         JOIN saved_cases c ON c.project_id=v.project_id AND c.id=v.case_id
         WHERE v.project_id=$1 AND v.id=ANY($2::uuid[])
           AND v.review_status='approved' AND c.status='active'`,
        [projectId, ids],
      )
    ).rows;
    if (rows.length !== ids.length) throw new StorageError('VALIDATION_ERROR');
  }
}

export async function createSchedule(
  ctx: RequestContext,
  projectId: string,
  raw: unknown,
): Promise<Schedule> {
  const input = parseContract('ScheduleCreate', raw);
  const timezone = input.timezone ?? 'Asia/Taipei';
  parseScheduleClock(input.cron, timezone);
  return ctx.api.db.actor(ctx.actor!, async (client) => {
    await authorize(client, projectId, 'run');
    await validateTemplate(
      client,
      projectId,
      input.templateKind,
      input.runTemplate,
    );
    const result = (
      await client.query<ScheduleRow>(
        `INSERT INTO schedules(
           id,project_id,name,cron,timezone,template_kind,run_template,
           overlap_policy,missed_policy,enabled,created_by,last_checked_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())
         RETURNING *`,
        [
          randomUUID(),
          projectId,
          input.name,
          input.cron,
          timezone,
          input.templateKind,
          JSON.stringify(input.runTemplate),
          input.overlapPolicy ?? 'skip',
          input.missedPolicy ?? 'skip',
          input.enabled ?? true,
          ctx.actor!.userId,
        ],
      )
    ).rows[0]!;
    return asSchedule(result);
  });
}

export async function updateSchedule(
  ctx: RequestContext,
  id: string,
  raw: unknown,
): Promise<Schedule> {
  const input: SchedulePatch = parseContract('SchedulePatch', raw);
  return ctx.api.db.actor(ctx.actor!, async (client) => {
    const old = (
      await client.query<ScheduleRow>(
        'SELECT * FROM schedules WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!old) throw new StorageError('NOT_FOUND');
    await authorize(client, old.project_id, 'run');
    if (old.version !== input.expectedVersion)
      throw new StorageError('VERSION_CONFLICT');
    const updated = {
      name: input.name ?? old.name,
      cron: input.cron ?? old.cron,
      timezone: input.timezone ?? old.timezone,
      templateKind: input.templateKind ?? old.template_kind,
      runTemplate: input.runTemplate ?? old.run_template,
      overlapPolicy: input.overlapPolicy ?? old.overlap_policy,
      missedPolicy: input.missedPolicy ?? old.missed_policy,
      enabled: input.enabled ?? old.enabled,
    };
    parseScheduleClock(updated.cron, updated.timezone);
    await validateTemplate(
      client,
      old.project_id,
      updated.templateKind,
      updated.runTemplate,
    );
    // Existing occurrences reference their original version. A template or
    // clock modification affects only future unclaimed occurrences.
    const row = (
      await client.query<ScheduleRow>(
        `UPDATE schedules SET name=$2,cron=$3,timezone=$4,
           template_kind=$5,run_template=$6,overlap_policy=$7,
           missed_policy=$8,enabled=$9,version=version+1,
           last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE id=$1 RETURNING *`,
        [
          id,
          updated.name,
          updated.cron,
          updated.timezone,
          updated.templateKind,
          JSON.stringify(updated.runTemplate),
          updated.overlapPolicy,
          updated.missedPolicy,
          updated.enabled,
        ],
      )
    ).rows[0]!;
    return asSchedule(row);
  });
}

export async function listSchedules(
  ctx: RequestContext,
  projectId: string,
  limit: number,
  offset: number,
): Promise<{ items: Schedule[]; nextCursor: string | null }> {
  return ctx.api.db.actor(ctx.actor!, async (client) => {
    await authorize(client, projectId, 'read');
    const rows = (
      await client.query<ScheduleRow>(
        'SELECT * FROM schedules WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',
        [projectId, limit + 1, offset],
      )
    ).rows;
    return {
      items: rows.slice(0, limit).map(asSchedule),
      nextCursor:
        rows.length > limit
          ? Buffer.from(String(offset + limit)).toString('base64url')
          : null,
    };
  });
}

export async function listOccurrences(
  ctx: RequestContext,
  id: string,
  limit: number,
  offset: number,
): Promise<{ items: ScheduleOccurrence[]; nextCursor: string | null }> {
  return ctx.api.db.actor(ctx.actor!, async (client) => {
    const schedule = (
      await client.query<{ project_id: string }>(
        'SELECT project_id FROM schedules WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!schedule) throw new StorageError('NOT_FOUND');
    await authorize(client, schedule.project_id, 'read');
    const rows = (
      await client.query<OccurrenceRow>(
        `SELECT * FROM schedule_occurrences WHERE schedule_id=$1 AND project_id=$2
         ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
        [id, schedule.project_id, limit + 1, offset],
      )
    ).rows;
    return {
      items: rows.slice(0, limit).map(asOccurrence),
      nextCursor:
        rows.length > limit
          ? Buffer.from(String(offset + limit)).toString('base64url')
          : null,
    };
  });
}

/**
 * Evaluate due occurrences in a database row-lock, once across API replicas.
 * No catch-up storm: at most one missed matching minute per schedule.
 */
export async function enqueueDueSchedules(
  api: ApiContext,
  now = new Date(),
): Promise<void> {
  await api.db.actor(api.adminActor, async (client) => {
    const rows = (
      await client.query<ScheduleRow>(
        `SELECT * FROM schedules WHERE enabled=true AND created_by IS NOT NULL
         ORDER BY id FOR UPDATE SKIP LOCKED`,
      )
    ).rows;
    for (const row of rows) {
      const previous = row.last_checked_at ?? row.created_at;
      const since = new Date(
        Math.max(previous.getTime(), now.getTime() - 24 * 60 * 60 * 1000),
      );
      if (since.getTime() >= now.getTime()) continue;
      const times = matchingMinutes(row.cron, row.timezone, since, now);
      await client.query(
        'UPDATE schedules SET last_checked_at=$2 WHERE id=$1',
        [row.id, now],
      );
      const latest = times.at(-1);
      if (!latest) continue;
      const missed = now.getTime() - latest.at.getTime() >= 90_000;
      const active =
        (
          await client.query(
            `SELECT 1 FROM schedule_occurrences o JOIN runs r ON r.id=o.run_id
           WHERE o.schedule_id=$1
             AND r.status NOT IN ('completed','cancelled','failed') LIMIT 1`,
            [row.id],
          )
        ).rowCount !== 0;
      const pending =
        (
          await client.query(
            `SELECT 1 FROM schedule_occurrences
           WHERE schedule_id=$1 AND status IN ('pending','dispatching') LIMIT 1`,
            [row.id],
          )
        ).rowCount !== 0;
      // Skip policies never build a backlog. Queue policies retain at most
      // one waiting occurrence, independent of the duration of an active run.
      const status =
        (missed && row.missed_policy === 'skip') ||
        pending ||
        (active && row.overlap_policy === 'skip')
          ? 'skipped'
          : 'pending';
      await client.query(
        `INSERT INTO schedule_occurrences(
           id,schedule_id,project_id,schedule_version,
           scheduled_at,scheduled_local,status,template_kind_snapshot,
           run_template_snapshot,overlap_policy_snapshot
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(schedule_id,scheduled_local) DO NOTHING`,
        [
          randomUUID(),
          row.id,
          row.project_id,
          row.version,
          latest.at,
          latest.local,
          status,
          row.template_kind,
          JSON.stringify(row.run_template),
          row.overlap_policy,
        ],
      );
    }
  });
}

async function claimOccurrence(
  api: ApiContext,
  occurrenceId: string | null,
): Promise<{ occurrence: OccurrenceRow; schedule: ScheduleRow } | null> {
  return api.db.actor(api.adminActor, async (client) => {
    const row = (
      await client.query<OccurrenceRow>(
        `SELECT o.* FROM schedule_occurrences o WHERE
           (o.status='pending' OR
            (o.status='dispatching' AND o.processing_at<clock_timestamp()-interval '2 minutes'))
           ${occurrenceId ? 'AND o.id=$1' : ''}
           AND NOT EXISTS(
             SELECT 1 FROM schedule_occurrences previous
             JOIN runs r ON r.id=previous.run_id
             WHERE previous.schedule_id=o.schedule_id AND previous.id<>o.id
               AND r.status NOT IN ('completed','cancelled','failed')
           )
         ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`,
        occurrenceId ? [occurrenceId] : [],
      )
    ).rows[0];
    if (!row) return null;
    const schedule = (
      await client.query<ScheduleRow>(
        'SELECT * FROM schedules WHERE id=$1 FOR UPDATE',
        [row.schedule_id],
      )
    ).rows[0];
    if (!schedule || !schedule.created_by) {
      await client.query(
        "UPDATE schedule_occurrences SET status='skipped' WHERE id=$1",
        [row.id],
      );
      return null;
    }
    const active =
      (
        await client.query<{ id: string }>(
          `SELECT o.id FROM schedule_occurrences o JOIN runs r ON r.id=o.run_id
         WHERE o.schedule_id=$1 AND o.id<>$2
           AND r.status NOT IN ('completed','cancelled','failed') LIMIT 1`,
          [schedule.id, row.id],
        )
      ).rows.length > 0;
    if (active) {
      if (row.overlap_policy_snapshot === 'skip') {
        await client.query(
          "UPDATE schedule_occurrences SET status='skipped' WHERE id=$1",
          [row.id],
        );
      }
      return null;
    }
    await client.query(
      `UPDATE schedule_occurrences SET status='dispatching',
         processing_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE id=$1`,
      [row.id],
    );
    return { occurrence: row, schedule };
  });
}

/**
 * Dispatch through exactly the same API admission functions used by manual
 * runs. No anonymous fallback, no cached/previously approved auth state and
 * no implicit regression case-version substitution.
 */
export async function dispatchOccurrence(
  api: ApiContext,
  occurrenceId: string | null = null,
): Promise<Run | null> {
  const claimed = await claimOccurrence(api, occurrenceId);
  if (!claimed) return null;
  const { schedule, occurrence } = claimed;
  let run: Run | null = null;
  try {
    // A saved creator identity must still be enabled, and the project must
    // still be active. Membership checks alone do not cover account disable.
    const enabled = await api.db.actor(
      api.adminActor,
      async (client) =>
        (
          await client.query<{ authorized: boolean }>(
            `SELECT NOT u.disabled AND p.status='active' AS authorized
           FROM users u JOIN projects p ON p.id=$2 WHERE u.id=$1`,
            [schedule.created_by, schedule.project_id],
          )
        ).rows[0]?.authorized === true,
    );
    if (!enabled) throw new StorageError('FORBIDDEN');
    // The creator must retain project run capability when the clock fires.
    await api.db.actor({ userId: schedule.created_by! }, (client) =>
      authorize(client, schedule.project_id, 'run'),
    );
    const kind = occurrence.template_kind_snapshot;
    if (!kind || occurrence.run_template_snapshot === null)
      throw new StorageError('VALIDATION_ERROR');
    const expectedTemplate = parseContract(
      kind === 'smoke' ? 'RunCreate' : 'RegressionRunCreate',
      occurrence.run_template_snapshot,
    );
    if (expectedTemplate.projectId !== schedule.project_id)
      throw new StorageError('VALIDATION_ERROR');
    const context = {
      actor: { userId: schedule.created_by! },
      api,
      body: expectedTemplate,
      headers: { 'idempotency-key': `schedule:${occurrence.id}` },
      res: { statusCode: 0 },
    } as unknown as RequestContext;
    run = parseContract(
      'Run',
      kind === 'smoke'
        ? await startTrustedSmokeRun(context)
        : await startTrustedRegressionRun(context),
    );
    await api.db.actor(api.adminActor, async (client) => {
      await client.query(
        `UPDATE schedule_occurrences SET status='started',run_id=$2,
         updated_at=clock_timestamp() WHERE id=$1`,
        [occurrence.id, run!.id],
      );
    });
    return run;
  } catch {
    // Fail closed. Only the schedule id, version and fixed status are exposed
    // in the durable occurrence history; never store credentials or errors.
    await api.db.actor(api.adminActor, async (client) => {
      await client.query(
        `UPDATE schedule_occurrences SET status='failed',
           updated_at=clock_timestamp() WHERE id=$1`,
        [occurrence.id],
      );
    });
    return null;
  }
}

export async function tickSchedules(
  api: ApiContext,
  now = new Date(),
): Promise<void> {
  await enqueueDueSchedules(api, now);
  // Bound work per tick and never spin on a single queued overlap occurrence.
  for (let n = 0; n < 10; n++) {
    const result = await dispatchOccurrence(api);
    if (!result) break;
  }
}

export async function runScheduleNow(
  ctx: RequestContext,
  id: string,
): Promise<Run | null> {
  const occurrenceId = randomUUID();
  await ctx.api.db.actor(ctx.actor!, async (client) => {
    const row = (
      await client.query<ScheduleRow>(
        'SELECT * FROM schedules WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!row) throw new StorageError('NOT_FOUND');
    await authorize(client, row.project_id, 'run');
    if (!row.enabled) throw new StorageError('VALIDATION_ERROR');
    const overlapping =
      (
        await client.query(
          `SELECT 1 FROM schedule_occurrences o JOIN runs r ON r.id=o.run_id
         WHERE o.schedule_id=$1 AND r.status NOT IN ('completed','cancelled','failed')
         LIMIT 1`,
          [id],
        )
      ).rowCount !== 0;
    if (overlapping) throw new StorageError('VERSION_CONFLICT');
    const now = new Date();
    await client.query(
      `INSERT INTO schedule_occurrences(
         id,schedule_id,project_id,schedule_version,scheduled_at,
         scheduled_local,status,template_kind_snapshot,
         run_template_snapshot,overlap_policy_snapshot
       ) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9)`,
      [
        occurrenceId,
        id,
        row.project_id,
        row.version,
        now,
        `manual:${occurrenceId}:${scheduledLocal(now, row.timezone).label}`,
        row.template_kind,
        JSON.stringify(row.run_template),
        row.overlap_policy,
      ],
    );
  });
  return dispatchOccurrence(ctx.api, occurrenceId);
}
