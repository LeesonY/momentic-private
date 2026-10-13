import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const instances = [];
let retryCallback;
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    instances.push(this);
  }
  addEventListener(type, callback) {
    this.listeners.set(type, callback);
  }
  emit(type, event) {
    const payload = { data: JSON.stringify(event) };
    const callback =
      type === 'message' ? this.onmessage : this.listeners.get(type);
    if (!callback) throw new Error(`Missing listener for ${type}`);
    callback(payload);
  }
  close() {
    this.closed = true;
  }
}
const source = readFileSync(
  new URL('../src/api/sse.ts', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
runInNewContext(compiled, {
  exports,
  window: { location: { origin: 'https://fixture.test' } },
  URL,
  EventSource: FakeEventSource,
  console,
  setTimeout: (callback) => {
    retryCallback = callback;
    return 1;
  },
  clearTimeout: () => {
    retryCallback = undefined;
  },
});

test('named session.updated event reaches run projection once and cursor resumes after reconnect', () => {
  instances.length = 0;
  const events = [];
  const client = new exports.SseClient({
    runId: 'run-1',
    onEvent: (event) => events.push(event),
  });
  client.connect();
  const initial = instances.at(-1);
  const event = {
    schemaVersion: 1,
    id: '27',
    seq: 27,
    runId: 'run-1',
    at: '2026-01-01T00:00:00Z',
    type: 'session.updated',
    payload: { status: 'running' },
  };
  initial.emit('session.updated', event);
  initial.emit('session.updated', event);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session.updated');
  assert.equal(client.getLastSeq(), 27);
  initial.onerror({});
  assert.equal(initial.closed, true);
  assert.equal(typeof retryCallback, 'function');
  retryCallback();
  const resumed = instances.at(-1);
  assert.notEqual(resumed, initial);
  assert.equal(new URL(resumed.url).searchParams.get('lastEventId'), '27');
  resumed.emit('session.updated', { ...event, id: '28', seq: 28 });
  assert.equal(events.length, 2);
  client.disconnect();
  assert.equal(resumed.closed, true);
});
