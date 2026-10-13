import type { RunEvent } from '@localqa/contracts';

/** Merge the REST bootstrap with live SSE without rolling back newer events.
 * Sequences are scoped to a run, not a global cross-run cursor. Keep the
 * already observed live version of a duplicate event. */
export function mergeRunEventHistory(
  runId: string,
  previous: readonly RunEvent[],
  incoming: readonly RunEvent[],
  maxEntries = 150,
): RunEvent[] {
  const bySeq = new Map<number, RunEvent>();
  for (const event of [...previous, ...incoming]) {
    if (
      event.runId !== runId ||
      !Number.isSafeInteger(event.seq) ||
      event.seq < 1
    )
      continue;
    if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }
  return [...bySeq.values()]
    .sort((left, right) => left.seq - right.seq)
    .slice(-maxEntries);
}
