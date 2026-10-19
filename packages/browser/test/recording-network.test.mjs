import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SessionRecorder } from '../dist/index.js';

const ids = () => ({
  projectId: randomUUID(),
  runId: randomUUID(),
  taskId: randomUUID(),
});

function request(url, method = 'GET', resourceType = 'xhr') {
  return {
    url: () => url,
    method: () => method,
    resourceType: () => resourceType,
    failure: () => ({ errorText: 'net::ERR_FAILED' }),
  };
}

function response(req, status) {
  return {
    url: req.url,
    request: () => req,
    status: () => status,
    ok: () => status >= 200 && status < 300,
  };
}

function recorder() {
  const instance = new SessionRecorder(ids());
  const page = new EventEmitter();
  instance.attachToPage(page);
  return { instance, page };
}

test('one request produces one recording entry updated by its response', () => {
  const { instance, page } = recorder();
  const req = request('https://app.example.test/api/data?token=secret#part');
  const before = Date.now();
  page.emit('request', req);
  let entries = instance.getRecordingNetworkEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, null);
  assert.equal(entries[0].failed, false);
  assert.equal(entries[0].durationMs, null);
  assert.equal(entries[0].url, 'https://app.example.test/api/data');
  assert.ok(Date.parse(entries[0].at) >= before);
  const requestAt = entries[0].at;

  page.emit('response', response(req, 200));
  entries = instance.getRecordingNetworkEntries();
  assert.equal(entries.length, 1, 'the response updates the request entry');
  assert.equal(entries[0].status, 200);
  assert.equal(entries[0].failed, false);
  assert.equal(typeof entries[0].durationMs, 'number');
  assert.equal(entries[0].url, 'https://app.example.test/api/data');
  assert.equal(entries[0].at, requestAt, 'at stays at request start');
});

test('an unfinished request is still emitted with null completion fields', () => {
  const { instance, page } = recorder();
  page.emit('request', request('https://app.example.test/pending'));
  const entries = instance.getRecordingNetworkEntries();
  assert.deepEqual(
    entries.map(({ status, failed, durationMs }) => ({
      status,
      failed,
      durationMs,
    })),
    [{ status: null, failed: false, durationMs: null }],
  );
});

test('a failed request keeps one entry and records the failure', () => {
  const { instance, page } = recorder();
  const req = request('https://app.example.test/fail');
  page.emit('request', req);
  page.emit('requestfailed', req);
  const entries = instance.getRecordingNetworkEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, null);
  assert.equal(entries[0].failed, true);
  assert.equal(typeof entries[0].durationMs, 'number');
});

test('an HTTP error is one failed entry, not a request plus a response row', () => {
  const { instance, page } = recorder();
  const req = request('https://app.example.test/500');
  page.emit('request', req);
  page.emit('response', response(req, 500));
  const entries = instance.getRecordingNetworkEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 500);
  assert.equal(entries[0].failed, true);
});

test('the 2000-entry cap counts requests and keeps the newest', () => {
  const { instance, page } = recorder();
  for (let index = 0; index <= 2000; index++)
    page.emit('request', request(`https://app.example.test/request-${index}`));
  const entries = instance.getRecordingNetworkEntries();
  assert.equal(entries.length, 2000);
  assert.equal(entries[0].url, 'https://app.example.test/request-1');
  assert.equal(entries.at(-1).url, 'https://app.example.test/request-2000');
  assert.ok(
    instance
      .getRecordingNotes()
      .some((note) => note.includes('truncated to the latest 2000')),
  );
});
