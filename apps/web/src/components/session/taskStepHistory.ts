import type { Step, StepPage } from '@localqa/contracts';

// One wire page has at most 100 entries. Bound one poll's work for long runs.
export const MAX_STEP_PAGES = 20;

export interface TaskStepHistory {
  steps: Step[];
  hasMore: boolean;
  /** Opaque API cursor pointing at the start of the last fetched page. */
  tailCursor: string | null;
  /** Number of records before tailCursor, not the last observed step seq. */
  tailOffset: number;
}

export async function readTaskStepHistory(
  fetchPage: (query: { limit: number; cursor?: string }) => Promise<StepPage>,
  previous?: TaskStepHistory,
): Promise<TaskStepHistory> {
  // Re-fetch the last page to observe the running -> succeeded transition;
  // do not poll all previous pages again on every 2.5s interval.
  const byId = new Map(
    (previous?.steps.slice(0, previous.tailOffset) ?? []).map((step) => [
      step.id,
      step,
    ]),
  );
  const visited = new Set<string>();
  let cursor: string | null = previous?.tailCursor ?? null;
  let offset = previous?.tailOffset ?? 0;
  let lastCursor = cursor;
  let lastOffset = offset;

  for (let pageNumber = 0; pageNumber < MAX_STEP_PAGES; pageNumber++) {
    lastCursor = cursor;
    lastOffset = offset;
    const page = await fetchPage({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const step of page.items) byId.set(step.id, step);
    offset += page.items.length;
    if (!page.nextCursor)
      return {
        steps: [...byId.values()].sort((a, b) => a.seq - b.seq),
        hasMore: false,
        tailCursor: lastCursor,
        tailOffset: lastOffset,
      };
    // Malformed or non-advancing cursors must not hang the UI.
    if (page.nextCursor === cursor || visited.has(page.nextCursor))
      throw new Error('步骤分页游标未推进');
    visited.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return {
    steps: [...byId.values()].sort((a, b) => a.seq - b.seq),
    hasMore: true,
    tailCursor: lastCursor,
    tailOffset: lastOffset,
  };
}
