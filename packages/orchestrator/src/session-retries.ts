import type { PoolClient } from 'pg';
import type { CaseRecord, Run } from '@localqa/contracts';
import type { Coordinator, JobRow } from './core.js';
import { sessionEntryUrl } from './session-planning.js';

export const CASE_RETRY_LIMIT = 3;
export type CaseRetryState = Record<
  string,
  { retries: number; lastAttempt: number }
>;

export async function readCaseRetries(
  client: PoolClient,
  run: Run,
): Promise<CaseRetryState> {
  const rows = (
    await client.query<{
      case_id: string;
      retries: number;
      last_attempt: number;
    }>(
      `SELECT case_id, max(attempt)::int AS last_attempt,
         GREATEST(count(*) FILTER (WHERE document->>'summary'='execute') - 1, 0)::int AS retries
       FROM jobs WHERE project_id=$1 AND run_id=$2 AND role='executor'
         AND case_id IS NOT NULL GROUP BY case_id`,
      [run.projectId, run.id],
    )
  ).rows;
  return Object.fromEntries(
    rows.map((row) => [
      row.case_id,
      { retries: row.retries, lastAttempt: row.last_attempt },
    ]),
  );
}

/** Retry immutable cases with new fenced tasks; never change an old verdict.
 * Count server-created execution jobs, not worker-writable result flags. A
 * recovery job is not a user retry, but its attempt still advances the fence. */
export async function retrySessionCases(
  client: PoolClient,
  coordinator: Coordinator,
  run: Run,
  cases: readonly CaseRecord[],
  requestedIds: readonly string[],
): Promise<{ caseIds: string[]; notes: string[] }> {
  const caseIds: string[] = [];
  const notes: string[] = [];
  if (!requestedIds.length) return { caseIds, notes };
  if (run.effectiveConfig.taskIntent === 'plan')
    return {
      caseIds,
      notes: ['仅规划的会话不能重跑用例，已忽略重跑请求。'],
    };
  // Serialize attempts/caps with the run, but never take child-job locks after
  // it: a child's finish/heartbeat already holds its job while waiting for this
  // same run lock. Reading committed statuses is sufficient to reject any
  // pending work, including a claim or finish currently waiting on the run.
  await client.query(
    'SELECT id FROM runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
    [run.projectId, run.id],
  );
  const owned = new Set(
    (
      await client.query<{ id: string }>(
        `SELECT id FROM run_cases WHERE project_id=$1 AND run_id=$2
         AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`,
        [run.projectId, run.id, requestedIds],
      )
    ).rows.map((row) => row.id),
  );
  const jobs = (
    await client.query<JobRow & { attempt: number }>(
      `SELECT * FROM jobs WHERE project_id=$1 AND run_id=$2
       AND case_id=ANY($3::uuid[]) ORDER BY id`,
      [run.projectId, run.id, requestedIds],
    )
  ).rows;
  const seen = new Set<string>();
  for (const caseId of requestedIds) {
    if (seen.has(caseId)) {
      notes.push(`用例重跑已忽略（${caseId}）：同一决定重复请求。`);
      continue;
    }
    seen.add(caseId);
    const record = cases.find((c) => c.definition.id === caseId);
    const caseJobs = jobs.filter((job) => job.case_id === caseId);
    const executors = caseJobs.filter((job) => job.role === 'executor');
    const retries = Math.max(
      0,
      executors.filter((job) => job.document.summary === 'execute').length - 1,
    );
    const invalid =
      !owned.has(caseId) || !record || record.definition.runId !== run.id
        ? '用例不属于本运行或不存在'
        : caseJobs.some((job) =>
              ['queued', 'running', 'waiting'].includes(job.status),
            )
          ? '仍有排队、运行或等待中的任务'
          : !['blocked', 'inconclusive'].includes(record.outcome)
            ? `最近一次结论为 ${record.outcome}，不是受阻`
            : retries >= CASE_RETRY_LIMIT
              ? `已达到 ${CASE_RETRY_LIMIT} 次重跑上限`
              : null;
    if (invalid || !record) {
      notes.push(`用例重跑已忽略（${caseId}）：${invalid}。`);
      continue;
    }
    const attempt = Math.max(1, ...executors.map((job) => job.attempt)) + 1;
    await coordinator.enqueue(
      client,
      run,
      'executor',
      'execute',
      `${caseId}:v${record.definition.version}`,
      caseId,
      attempt,
      {
        entryUrl: sessionEntryUrl(record.definition, run.targetUrl),
        retry: true,
        previousAttemptId: record.verdict?.attemptId ?? null,
      },
    );
    caseIds.push(caseId);
    notes.push(
      `用例已重跑：${record.definition.title}（${caseId}），执行任务第 ${attempt} 次，重跑 ${retries + 1}/${CASE_RETRY_LIMIT}。`,
    );
  }
  return { caseIds, notes };
}
