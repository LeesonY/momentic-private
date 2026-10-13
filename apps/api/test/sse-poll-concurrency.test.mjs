import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(
  new URL('../src/routes/sse.ts', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

test('slow SSE database polls never overlap or replay a committed event', async () => {
  const registered = new Map();
  const writes = [];
  const intervals = [];
  let releaseFirstPoll;
  let liveReads = 0;
  let onClose;
  const eventRow = {
    seq: '1',
    type: 'task.updated',
    payload: { status: 'running' },
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
  const client = {
    async query(sql) {
      if (sql.includes('SELECT project_id FROM runs'))
        return { rows: [{ project_id: 'project-1' }] };
      if (sql.includes('MIN(seq)'))
        return { rows: [{ min_seq: null, max_seq: null }] };
      if (sql.includes('SELECT seq, type, payload, created_at')) {
        // The initial historical read is empty. Delay the first live read
        // so that a second interval tick races it.
        if (liveReads++ === 0) return { rows: [] };
        if (liveReads === 2)
          return new Promise((resolve) => {
            releaseFirstPoll = () => resolve({ rows: [eventRow] });
          });
        return { rows: [eventRow] };
      }
      throw new Error('unexpected SQL: ' + sql);
    },
  };
  const exported = {};
  runInNewContext(compiled, {
    exports: exported,
    require: (name) => {
      if (name === '@localqa/contracts')
        return { parseContract: (_type, value) => value };
      if (name === '@localqa/storage')
        return { StorageError: class StorageError extends Error {} };
      if (name === '../errors.js')
        return { ApiError: class ApiError extends Error {} };
      if (name === '../auth.js') return { requireAuth: async () => {} };
      throw new Error('Unexpected module: ' + name);
    },
    setInterval: (callback, interval) => {
      const timer = { callback, interval, unref() {}, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      timer.cleared = true;
    },
  });
  exported.registerSseRoutes({
    get: (path, handler) => registered.set(path, handler),
  });
  await registered.get('/api/v1/runs/{runId}/events')({
    params: { runId: 'run-1' },
    query: {},
    headers: {},
    actor: { userId: 'user-1' },
    api: { db: { actor: async (_actor, action) => action(client) } },
    req: {
      on: () => {
        throw new Error('SSE should not use request close for stream teardown');
      },
    },
    res: {
      on(event, callback) {
        assert.equal(event, 'close');
        onClose = callback;
      },
      writeHead(status) {
        assert.equal(status, 200);
      },
      write(chunk) {
        writes.push(chunk);
      },
    },
  });
  const poll = intervals.find((timer) => timer.interval === 250);
  assert.ok(poll);
  const pending = poll.callback();
  assert.equal(liveReads, 2);
  await poll.callback();
  assert.equal(liveReads, 2, 'overlapping poll was skipped');
  releaseFirstPoll();
  await pending;
  await poll.callback();
  assert.equal(liveReads, 3);
  const sent = writes.filter((part) => part.includes('id: 1'));
  assert.equal(sent.length, 1, 'repeated database row not streamed twice');
  onClose();
  assert.equal(
    intervals.every((timer) => timer.cleared),
    true,
  );
});

test('large historical SSE replay reads bounded batches in order and releases timers on response close', async () => {
  const registered = new Map();
  const writes = [];
  const reads = [];
  const intervals = [];
  let responseClose;
  const history = Array.from({ length: 487 }, (_, i) => ({
    seq: String(i + 1),
    type: 'task.updated',
    payload: { status: 'running' },
    created_at: new Date('2026-01-01T00:00:00Z'),
  }));
  const client = {
    async query(sql, args) {
      if (sql.includes('SELECT project_id FROM runs'))
        return { rows: [{ project_id: 'project-1' }] };
      if (sql.includes('MIN(seq)'))
        return { rows: [{ min_seq: '1', max_seq: '487' }] };
      if (sql.includes('SELECT seq, type, payload, created_at')) {
        assert.match(sql, /LIMIT \$4/);
        assert.equal(args[3], 200);
        reads.push(args[2]);
        return {
          rows: history
            .filter((event) => Number(event.seq) > args[2])
            .slice(0, args[3]),
        };
      }
      throw new Error('unexpected SQL: ' + sql);
    },
  };
  const exported = {};
  runInNewContext(compiled, {
    exports: exported,
    require: (name) => {
      if (name === '@localqa/contracts')
        return { parseContract: (_type, value) => value };
      if (name === '@localqa/storage')
        return { StorageError: class StorageError extends Error {} };
      if (name === '../errors.js')
        return { ApiError: class ApiError extends Error {} };
      if (name === '../auth.js') return { requireAuth: async () => {} };
      throw new Error('Unexpected module: ' + name);
    },
    setInterval: (callback, interval) => {
      const timer = { callback, interval, unref() {}, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      timer.cleared = true;
    },
  });
  exported.registerSseRoutes({
    get: (path, handler) => registered.set(path, handler),
  });
  await registered.get('/api/v1/runs/{runId}/events')({
    params: { runId: 'run-1' },
    query: {},
    headers: {},
    actor: { userId: 'user-1' },
    api: { db: { actor: async (_actor, action) => action(client) } },
    req: {
      on: () => {
        throw new Error('wrong close owner');
      },
    },
    res: {
      on(event, callback) {
        assert.equal(event, 'close');
        responseClose = callback;
      },
      writeHead(status) {
        assert.equal(status, 200);
      },
      write(chunk) {
        writes.push(chunk);
        return true;
      },
    },
  });
  assert.deepEqual(reads, [0, 200, 400]);
  const sequences = writes
    .filter((frame) => frame.startsWith('id:'))
    .map((frame) => Number(frame.match(/^id: (\d+)/)[1]));
  assert.deepEqual(
    sequences,
    Array.from({ length: 487 }, (_, i) => i + 1),
  );
  // A burst committed while the connection remains open must drain through
  // more than one bounded live poll page without gaps or duplicate frames.
  history.push(
    ...Array.from({ length: 300 }, (_, i) => ({
      seq: String(i + 488),
      type: 'task.updated',
      payload: { status: 'running' },
      created_at: new Date('2026-01-01T00:00:00Z'),
    })),
  );
  const livePoll = intervals.find((timer) => timer.interval === 250);
  await livePoll.callback();
  assert.deepEqual(reads.slice(3), [487, 687]);
  await livePoll.callback();
  const allSequences = writes
    .filter((frame) => frame.startsWith('id:'))
    .map((frame) => Number(frame.match(/^id: (\d+)/)[1]));
  assert.deepEqual(
    allSequences,
    Array.from({ length: 787 }, (_, i) => i + 1),
  );
  responseClose();
  assert.equal(intervals.length, 2);
  assert.ok(intervals.every((timer) => timer.cleared));
});
