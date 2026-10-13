import type { RunEvent, Step } from '@localqa/contracts';

/** The newest authenticated SSE witness for just one browser task.
 * Run-local sequence numbers prevent cross-agent or cross-run updates.
 * It is only an invalidation signal: step and screenshot bytes still come
 * from their separately authorized REST and artifact endpoints. */
export function latestTaskStepSignal(
  runId: string,
  taskId: string | null,
  events: readonly RunEvent[],
): number {
  if (!taskId) return 0;
  let latest = 0;
  for (const event of events) {
    if (
      event.runId !== runId ||
      event.type !== 'step.recorded' ||
      !Number.isSafeInteger(event.seq) ||
      event.seq < 1
    )
      continue;
    const step = event.payload as unknown as Partial<Step> | null;
    if (step && step.taskId === taskId && event.seq > latest)
      latest = event.seq;
  }
  return latest;
}
