import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BrowserSessionImpl } from '../dist/index.js';

function recordingSession() {
  const page = new EventEmitter();
  const context = new EventEmitter();
  context.close = async () => {};
  return new BrowserSessionImpl(
    randomUUID(),
    {
      projectId: randomUUID(),
      runId: randomUUID(),
      taskId: randomUUID(),
      enableRecording: true,
    },
    context,
    page,
    randomUUID(),
  );
}

test('same-millisecond rrweb events keep the last timestamp unchanged', () => {
  const session = recordingSession();
  const timestamp = 1_700_000_000_000;
  session.addRrwebEvents(
    Array.from({ length: 100 }, (_, index) => ({
      type: 3,
      data: { index },
      timestamp,
    })),
  );
  const events = session.getRecording().events;
  assert.equal(events.length, 100);
  assert.equal(events.at(-1).timestamp, timestamp);
  assert.equal(new Set(events.map((event) => event.timestamp)).size, 1);
});

test('a backwards rrweb timestamp is clamped without advancing equal ones', () => {
  const session = recordingSession();
  session.addRrwebEvents([{ type: 4, data: {}, timestamp: 2000 }]);
  session.addRrwebEvents([{ type: 3, data: {}, timestamp: 1000 }]);
  session.addRrwebEvents([{ type: 3, data: {}, timestamp: 2000 }]);
  const timestamps = session
    .getRecording()
    .events.map((event) => event.timestamp);
  assert.deepEqual(timestamps, [2000, 2000, 2000]);
});
