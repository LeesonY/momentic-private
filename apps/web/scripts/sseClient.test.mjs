import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const code = ts.transpileModule(
  readFileSync(new URL('../src/api/sse.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;

class FakeEventSource {
  static instances = [];
  listeners = new Map();
  constructor(url) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, callback) {
    this.listeners.set(type, callback);
  }
  emit(type, event) {
    this.listeners.get(type)?.({ data: JSON.stringify(event) });
  }
  close() {
    this.closed = true;
  }
}

test('named session updates reach UI and duplicates are ignored', () => {
  FakeEventSource.instances.length = 0;
  const exports = {};
  runInNewContext(code, {
    exports,
    require,
    EventSource: FakeEventSource,
    window: { location: { origin: 'https://fixture.test' } },
    URL,
    console,
    setTimeout,
    clearTimeout,
  });
  const received = [];
  const statuses = [];
  const client = new exports.SseClient({
    runId: 'fixture-run',
    onEvent: (event) => received.push(event),
    onStatusChange: (status) => statuses.push(status),
  });
  client.connect();
  const wire = FakeEventSource.instances.at(-1);
  assert.ok(wire.listeners.has('session.updated'));
  wire.onopen();
  const updated = {
    id: '1',
    seq: 1,
    runId: 'fixture-run',
    type: 'session.updated',
    payload: {},
  };
  wire.emit('session.updated', updated);
  wire.emit('session.updated', updated);
  wire.emit('task.updated', {
    id: '2',
    seq: 2,
    runId: 'fixture-run',
    type: 'task.updated',
  });
  assert.deepEqual(
    received.map((e) => e.type),
    ['session.updated', 'task.updated'],
  );
  assert.equal(client.getLastSeq(), 2);
  assert.equal(client.getStatus(), 'connected');
  client.disconnect();
  assert.equal(wire.closed, true);
  assert.equal(statuses.at(-1), 'disconnected');
});

test('manual retry closes the prior stream and ignores its late events and callbacks', () => {
  FakeEventSource.instances.length = 0;
  const exports = {};
  runInNewContext(code, {
    exports,
    require,
    EventSource: FakeEventSource,
    window: { location: { origin: 'https://fixture.test' } },
    URL,
    console,
    setTimeout,
    clearTimeout,
  });
  const received = [];
  const statuses = [];
  const errors = [];
  const client = new exports.SseClient({
    runId: 'fixture-run',
    onEvent: (event) => received.push(event.seq),
    onStatusChange: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
  });
  client.connect();
  const first = FakeEventSource.instances[0];
  first.onopen();
  first.emit('task.updated', {
    id: '1',
    seq: 1,
    runId: 'fixture-run',
    type: 'task.updated',
  });
  client.retry();
  const second = FakeEventSource.instances[1];
  assert.equal(first.closed, true);
  assert.equal(new URL(second.url).searchParams.get('lastEventId'), '1');
  first.emit('task.updated', {
    id: '99',
    seq: 99,
    runId: 'fixture-run',
    type: 'task.updated',
  });
  first.onopen();
  first.onerror({});
  assert.equal(client.getStatus(), 'connecting');
  assert.equal(client.getLastSeq(), 1);
  assert.equal(second.closed, undefined);
  assert.equal(errors.length, 0);
  second.onopen();
  second.emit('task.updated', {
    id: '2',
    seq: 2,
    runId: 'fixture-run',
    type: 'task.updated',
  });
  second.emit('task.updated', {
    id: '3',
    seq: 3,
    runId: 'wrong-run',
    type: 'task.updated',
  });
  assert.deepEqual(received, [1, 2]);
  assert.equal(client.getLastSeq(), 2);
  assert.equal(client.getStatus(), 'connected');
  client.disconnect();
  second.emit('task.updated', {
    id: '4',
    seq: 4,
    runId: 'fixture-run',
    type: 'task.updated',
  });
  assert.deepEqual(received, [1, 2]);
  assert.equal(statuses.at(-1), 'disconnected');
});
