import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_STEP_PAGES,
  readTaskStepHistory,
} from '../src/components/session/taskStepHistory.ts';

test('step history reads later pages and exposes latest screenshot for long flows', async () => {
  const requests = [];
  const all = Array.from({ length: 245 }, (_, i) => ({
    id: `step-${i + 1}`,
    seq: i + 1,
    evidenceRefs: i === 244 ? ['latest-image'] : [],
  }));
  const result = await readTaskStepHistory(async ({ limit, cursor }) => {
    requests.push(cursor ?? 'first');
    const offset = cursor ? Number(cursor) : 0;
    return {
      items: all.slice(offset, offset + limit),
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
    };
  });
  assert.equal(result.steps.length, 245);
  assert.deepEqual(result.steps.at(-1).evidenceRefs, ['latest-image']);
  assert.deepEqual(requests, ['first', '100', '200']);
  assert.equal(result.hasMore, false);
});

test('non-advancing cursor fails explicitly rather than reporting no steps', async () => {
  await assert.rejects(
    readTaskStepHistory(async () => ({ items: [], nextCursor: 'same' })),
    /步骤分页游标未推进/,
  );
});

test('history caps work and marks remaining pages as not yet loaded', async () => {
  let calls = 0;
  const result = await readTaskStepHistory(async () => ({
    items: [{ id: `step-${++calls}`, seq: calls }],
    nextCursor: String(calls),
  }));
  assert.equal(calls, MAX_STEP_PAGES);
  assert.equal(result.hasMore, true);
});

test('repeat poll reads only the last loaded page and refreshes its status', async () => {
  const requests = [];
  const steps = Array.from({ length: 245 }, (_, i) => ({
    id: `step-${i + 1}`,
    seq: i + 1,
    status: i === 244 ? 'running' : 'succeeded',
  }));
  const fetchPage = async ({ limit, cursor }) => {
    const offset = cursor ? Number(cursor) : 0;
    requests.push(offset);
    return {
      items: steps.slice(offset, offset + limit),
      nextCursor: offset + limit < steps.length ? String(offset + limit) : null,
    };
  };
  const first = await readTaskStepHistory(fetchPage);
  assert.deepEqual(requests, [0, 100, 200]);
  steps[244] = { ...steps[244], status: 'succeeded' };
  const second = await readTaskStepHistory(fetchPage, first);
  assert.deepEqual(requests, [0, 100, 200, 200]);
  assert.equal(second.steps.length, 245);
  assert.equal(second.steps.at(-1).status, 'succeeded');
  assert.equal(new Set(second.steps.map((step) => step.id)).size, 245);
});

test('long histories drain beyond the per-poll cap without restarting from page one', async () => {
  const all = Array.from({ length: 2345 }, (_, i) => ({
    id: `step-${i + 1}`,
    seq: i + 1,
  }));
  const requests = [];
  const fetchPage = async ({ limit, cursor }) => {
    const offset = cursor ? Number(cursor) : 0;
    requests.push(offset);
    return {
      items: all.slice(offset, offset + limit),
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
    };
  };
  const first = await readTaskStepHistory(fetchPage);
  assert.equal(first.hasMore, true);
  assert.equal(first.steps.length, 2000);
  assert.equal(first.tailOffset, 1900);
  const second = await readTaskStepHistory(fetchPage, first);
  assert.equal(second.hasMore, false);
  assert.equal(second.steps.length, 2345);
  assert.equal(second.steps.at(-1).seq, 2345);
  assert.equal(requests[20], 1900);
});
