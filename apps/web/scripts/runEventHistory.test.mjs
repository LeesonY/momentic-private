import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRunEventHistory } from '../src/state/runEventHistory.ts';

const event = (runId, seq, payload = {}) => ({
  runId,
  seq,
  id: String(seq),
  type: 'task.updated',
  payload,
});

test('a delayed REST initial page never removes newer SSE steps', () => {
  const sse = [event('run-a', 105, { status: 'running' })];
  const rest = Array.from({ length: 100 }, (_, seq) => event('run-a', seq + 1));
  const merged = mergeRunEventHistory('run-a', sse, rest);
  assert.equal(merged.length, 101);
  assert.equal(merged.at(-1).seq, 105);
  assert.deepEqual(merged.at(-1).payload, { status: 'running' });
});

test('reconnect duplicates are stable and only the current run is retained', () => {
  const live = event('run-a', 42, { status: 'fresh' });
  const stale = event('run-a', 42, { status: 'stale' });
  const merged = mergeRunEventHistory(
    'run-a',
    [event('run-b', 999), live],
    [stale, event('run-a', 43), event('run-a', 0)],
  );
  assert.deepEqual(
    merged.map((item) => item.seq),
    [42, 43],
  );
  assert.deepEqual(merged[0].payload, { status: 'fresh' });
});

test('long event timelines stay bounded to the newest 150 events', () => {
  const rest = Array.from({ length: 210 }, (_, seq) => event('run-a', seq + 1));
  const merged = mergeRunEventHistory('run-a', [], rest);
  assert.equal(merged.length, 150);
  assert.equal(merged[0].seq, 61);
  assert.equal(merged.at(-1).seq, 210);
});
