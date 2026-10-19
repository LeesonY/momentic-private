import type { Run } from '@localqa/contracts';

/** Product rule: an already-running session reproduction gets at most three
 * additional minutes after the active-time budget expires. Not a new budget
 * for actions/model calls/tokens, and never a retry or a new task admission. */
export const REPRODUCTION_BUDGET_GRACE_SECONDS = 180;

export function graceDeadline(
  activeSeconds: number,
  limit: number,
  now: Date,
): string {
  // If a coordinator observes the cutoff late, do not renew the elapsed part
  // of the window. pulse() keeps the actual overrun instead of saturating it.
  return new Date(
    now.getTime() +
      (REPRODUCTION_BUDGET_GRACE_SECONDS - Math.max(0, activeSeconds - limit)) *
        1000,
  ).toISOString();
}

export function graceEligibleRun(run: Run): boolean {
  return (
    run.executionMode === 'smoke' &&
    run.status === 'running' &&
    run.budgetUsed.activeSeconds >= run.effectiveConfig.budget.maxActiveSeconds
  );
}
