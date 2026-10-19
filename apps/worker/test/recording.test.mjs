import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { packRrwebRecording } from '../dist/recording.js';

const event = (timestamp, payload = '') => ({
  type: 3,
  data: { source: 0, text: payload },
  timestamp,
});

test('an empty recording is missing, not an empty artifact', () => {
  const packed = packRrwebRecording([]);
  assert.equal(packed.status, 'missing');
  assert.equal(packed.bytes, null);
  assert.equal(packed.kept, 0);
});

test('a recording within the cap is gzip JSON of every event', () => {
  const events = [event(1, 'a'), event(2, 'b')];
  const packed = packRrwebRecording(events, 1024 * 1024);
  assert.equal(packed.status, 'available');
  assert.equal(packed.kept, 2);
  assert.ok(packed.bytes);
  assert.deepEqual(JSON.parse(gunzipSync(packed.bytes).toString()), events);
});

test('an over-limit recording keeps the earliest events and is degraded', () => {
  const events = Array.from({ length: 200 }, (_, index) =>
    event(index + 1, `${index}-${Math.random().toString(36).repeat(6)}`),
  );
  const packed = packRrwebRecording(events, 1500);
  assert.equal(packed.status, 'degraded');
  assert.ok(packed.kept > 0 && packed.kept < events.length);
  assert.ok(packed.bytes);
  const saved = JSON.parse(gunzipSync(packed.bytes).toString());
  assert.equal(saved.length, packed.kept);
  assert.deepEqual(saved, events.slice(0, packed.kept));
  assert.match(packed.error, /exceeded 1500 bytes/);
  assert.equal(packed.lastTimestamp, packed.kept);
});

test('an event larger than the cap is not saved', () => {
  const packed = packRrwebRecording(
    [event(1, Math.random().toString(36).repeat(1000))],
    100,
  );
  assert.equal(packed.status, 'degraded');
  assert.equal(packed.bytes, null);
  assert.equal(packed.kept, 0);
  assert.match(packed.error, /nothing was saved/);
});
