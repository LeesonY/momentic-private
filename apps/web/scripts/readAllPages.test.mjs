// Offline verification for readAllPages: session data (cases, tasks,
// findings) must be read to the last page before it is counted or grouped.
// No browser, no network, no database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_PAGE_LIMIT,
  MAX_PAGE_REQUESTS,
  readAllPages,
} from '../src/api/pagination.ts';
import { MockApiClient } from '../src/mocks/mockClient.ts';

/** Cursor-paginated fake backend mirroring apps/api parsePagination/paginate. */
const fakeBackend = (total, options = {}) => {
  const calls = [];
  const items = Array.from({ length: total }, (_, i) => ({ id: i }));
  const repeatCursorAt = options.repeatCursorAt ?? -1;
  const load = async (query) => {
    calls.push({ ...query });
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = query.cursor ? Number(query.cursor) : 0;
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    let nextCursor = nextOffset < items.length ? String(nextOffset) : null;
    if (offset / limit === repeatCursorAt && nextCursor !== null)
      nextCursor = String(offset); // non-advancing/repeated cursor bug
    return { items: page, nextCursor };
  };
  return { load, calls };
};

test('reads every page of a multi-page collection in order', async () => {
  const backend = fakeBackend(250);
  const items = await readAllPages(backend.load);
  assert.equal(items.length, 250);
  assert.deepEqual(
    items.map((item) => item.id),
    Array.from({ length: 250 }, (_, i) => i),
  );
  assert.equal(backend.calls.length, 3);
  assert.deepEqual(backend.calls[0], { limit: MAX_PAGE_LIMIT });
  assert.deepEqual(backend.calls[1], { limit: MAX_PAGE_LIMIT, cursor: '100' });
  assert.deepEqual(backend.calls[2], { limit: MAX_PAGE_LIMIT, cursor: '200' });
});

test('uses the backend maximum page limit on every request', async () => {
  assert.equal(MAX_PAGE_LIMIT, 100);
  const backend = fakeBackend(101);
  const items = await readAllPages(backend.load);
  assert.equal(items.length, 101);
  assert.ok(backend.calls.every((call) => call.limit === 100));
});

test('single page and exact page boundaries end without an extra request', async () => {
  for (const total of [0, 1, 99, 100]) {
    const backend = fakeBackend(total);
    const items = await readAllPages(backend.load);
    assert.equal(items.length, total);
    assert.equal(backend.calls.length, total === 100 ? 1 : 1);
  }
});

test('empty result resolves to an empty array', async () => {
  const backend = fakeBackend(0);
  assert.deepEqual(await readAllPages(backend.load), []);
  assert.equal(backend.calls.length, 1);
});

test('a repeated cursor is an API error, never a silent first-page answer', async () => {
  const backend = fakeBackend(300, { repeatCursorAt: 1 });
  await assert.rejects(readAllPages(backend.load), /分页游标重复/);
  assert.equal(backend.calls.length, 2);
});

test('an endless stream of fresh cursors stops at the safety cap', async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    return { items: [], nextCursor: `cursor-${calls}` };
  };
  await assert.rejects(readAllPages(load), /分页页数超出上限/);
  assert.equal(calls, MAX_PAGE_REQUESTS);
});

test('mock client paginates run data like the real backend', async () => {
  const client = new MockApiClient();
  const page = await client.listRunFindings('run_mock_001', { limit: 2 });
  assert.ok(page.items.length <= 2);
  assert.equal(typeof page.nextCursor, typeof (page.nextCursor ? '' : null));
  const all = await readAllPages((query) =>
    client.listRunFindings('run_mock_001', query),
  );
  const single = await client.listRunFindings('run_mock_001', { limit: 100 });
  assert.equal(all.length, single.items.length);
  assert.deepEqual(all, single.items);
});

test('mock pagination defaults, validates limits and rejects bad cursors', async () => {
  const client = new MockApiClient();
  // No query → backend default limit 20.
  const tasks = await client.listRunTasks('run_mock_001');
  assert.ok(tasks.items.length <= 20);
  // `limit` outside 1..100 is a 422 on the real API, so the mock refuses it too
  // rather than silently clamping (a 200 request then works in dev and fails on
  // a server — that is how the replay activity list came out empty).
  const atLimit = await client.listRunTasks('run_mock_001', { limit: 100 });
  assert.ok(atLimit.items.length <= 100);
  for (const limit of [0, -1, 101, 1000, 2.5]) {
    await assert.rejects(
      client.listRunTasks('run_mock_001', { limit }),
      (error) => error.status === 422 && /Invalid limit/.test(error.message),
      `limit ${limit}`,
    );
  }
  const first = await client.listRunTasks('run_mock_001', { limit: 1 });
  if (first.nextCursor) {
    const second = await client.listRunTasks('run_mock_001', {
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0].id, first.items[0].id);
  }
  await assert.rejects(
    client.listRunTasks('run_mock_001', { cursor: 'not-a-number' }),
    /Invalid cursor/,
  );
  await assert.rejects(
    client.listRunTasks('run_mock_001', { cursor: '-5' }),
    /Invalid cursor/,
  );
});

test('mock readAllPages keeps Mo-style multi-attempt task data complete', async () => {
  const client = new MockApiClient();
  const tasks = await readAllPages((query) =>
    client.listRunTasks('run_mock_001', query),
  );
  const retried = tasks.filter(
    (task) =>
      task.caseId === 'case_mock_20_retried' && task.role === 'executor',
  );
  if (retried.length >= 2) {
    const attempts = await readAllPages((query) =>
      client.listCaseAttempts('case_mock_20_retried', query),
    );
    assert.equal(attempts.length, 2);
    assert.deepEqual(
      attempts.map((attempt) => attempt.attemptNumber).sort((a, b) => a - b),
      [1, 2],
    );
  }
});
