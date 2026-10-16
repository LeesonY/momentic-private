import type { PaginationQuery } from './types.ts';

/** The backend validates `limit` as 1..100 (parsePagination), so 100 is the
 * largest page one request may read. */
export const MAX_PAGE_LIMIT = 100;

/** Safety valve against a server bug that keeps producing fresh cursors with
 * no end: 10k pages * 100 records is far beyond any real session. */
export const MAX_PAGE_REQUESTS = 10_000;

/**
 * Read a cursor-paginated collection completely before counting or grouping
 * it. A repeated cursor is an API error, not a reason to loop forever or to
 * silently present the first page as a complete result.
 */
export async function readAllPages<T>(
  load: (query: PaginationQuery) => Promise<{
    items: T[];
    nextCursor?: string | null;
  }>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let request = 0; request < MAX_PAGE_REQUESTS; request++) {
    const page = await load({
      limit: MAX_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    // Includes the non-advancing case nextCursor === cursor.
    if (seen.has(page.nextCursor))
      throw new Error('分页游标重复，请刷新后重试');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('分页页数超出上限，请刷新后重试');
}
