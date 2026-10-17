import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  SessionRecorder,
  BrowserSessionImpl,
  createPrivateAuthPort,
  createTrustedBrowserAuthPrimitives,
} from '../dist/index.js';

const ids = () => ({
  projectId: randomUUID(),
  runId: randomUUID(),
  taskId: randomUUID(),
});
const account = 'fixture-private-account';
const password = 'fixture-private-password';

test('private sign-in never records console, error or network content', () => {
  const recorder = new SessionRecorder(ids());
  const page = new EventEmitter();
  recorder.attachToPage(page);
  recorder.beginPrivateAuthentication();
  let reads = 0;
  const sensitive = () => {
    reads++;
    return password;
  };
  page.emit('console', { text: sensitive, type: () => 'log' });
  page.emit('pageerror', {
    get message() {
      return sensitive();
    },
  });
  page.emit('request', { url: sensitive });
  page.emit('response', { url: sensitive });
  page.emit('requestfailed', { url: sensitive });
  assert.equal(reads, 0);
  recorder.endPrivateAuthentication();
  assert.deepEqual(recorder.getRawConsole(), []);
  assert.deepEqual(recorder.getRawNetwork(), []);
});

test('known credentials stay redacted after an in-place sign-in ends', () => {
  const recorder = new SessionRecorder(ids());
  const page = new EventEmitter();
  recorder.attachToPage(page);
  recorder.beginPrivateAuthentication();
  recorder.rememberAuthenticationValue(account);
  recorder.rememberAuthenticationValue(password);
  recorder.endPrivateAuthentication();
  page.emit('console', {
    text: () => `Welcome ${account}, ${password}`,
    type: () => 'info',
  });
  page.emit('request', {
    url: () => `https://app.example.test/${account}`,
    method: () => 'GET',
    resourceType: () => 'document',
  });
  const stored = JSON.stringify(recorder.getSnapshotSummaries());
  assert.ok(!stored.includes(account));
  assert.ok(!stored.includes(password));
  assert.match(stored, /Welcome/);
  assert.equal(recorder.getRawNetwork().length, 1);
});

test('credentials are redacted before network URLs and errors are clipped', () => {
  const recorder = new SessionRecorder(ids());
  const page = new EventEmitter();
  recorder.attachToPage(page);
  recorder.rememberAuthenticationValue(account);
  const padding = 'x'.repeat(990);
  const request = {
    url: () => `https://app.example.test/${padding}${account}`,
    method: () => 'GET',
    resourceType: () => 'document',
    failure: () => ({ errorText: `${padding}${account}` }),
  };
  page.emit('request', request);
  page.emit('response', {
    url: request.url,
    request: () => request,
    status: () => 200,
  });
  page.emit('requestfailed', request);
  const stored = JSON.stringify(recorder.getRawNetwork());
  assert.ok(!stored.includes(account));
  assert.ok(
    !stored.includes(account.slice(0, 6)),
    'clipping must not retain a partial account value',
  );
});

test('later task snapshots redact credentials without exporting browser storage', async () => {
  const options = ids();
  const page = new EventEmitter();
  const context = new EventEmitter();
  context.close = async () => {};
  const session = new BrowserSessionImpl(
    randomUUID(),
    options,
    context,
    page,
    randomUUID(),
  );
  const original = {
    snapshotId: randomUUID(),
    pageId: session.activePageId,
    displayUrl: `https://app.example.test/${account}`,
    title: account,
    nodes: [
      {
        role: 'textbox',
        name: account,
        text: password,
        // The account box really holds the saved account after an in-place
        // sign-in; its current value must be redacted like any other text.
        value: account,
        nodeId: 'observed',
      },
    ],
    consoleSummary: [password],
    networkSummary: [{ url: account, summary: password }],
  };
  session.currentSnapshot = original;
  session.rememberAuthenticationValue(account);
  session.rememberAuthenticationValue(password);
  const snapshot = await session.getSnapshot();
  const text = JSON.stringify(snapshot);
  assert.ok(!text.includes(account));
  assert.ok(!text.includes(password));
  assert.ok(!text.includes('storageState'));
  assert.equal(snapshot.nodes[0].value, '•');
  assert.equal(snapshot.snapshotId, original.snapshotId);
  assert.equal(snapshot.nodes[0].nodeId, 'observed');
  assert.equal(original.title, account);
  await session.close();
});

test('closing a private port removes only its own route and refuses retained primitives', async () => {
  const options = ids();
  const page = new EventEmitter();
  page.isClosed = () => false;
  page.url = () => 'https://login.example.test/login';
  const context = new EventEmitter();
  const routes = new Map();
  const unrelated = async () => {};
  routes.set(unrelated, '**/*');
  context.route = async (pattern, handler) => routes.set(handler, pattern);
  context.unroute = async (pattern, handler) => {
    assert.equal(routes.get(handler), pattern);
    routes.delete(handler);
  };
  context.close = async () => {};
  const session = new BrowserSessionImpl(
    randomUUID(),
    options,
    context,
    page,
    randomUUID(),
  );
  const primitives = createTrustedBrowserAuthPrimitives(session, [
    'https://login.example.test',
  ]);
  const port = createPrivateAuthPort({
    binding: {
      sessionId: randomUUID(),
      projectId: options.projectId,
      runId: options.runId,
      taskId: options.taskId,
      contextId: session.id,
      workerId: 'fixture',
      fencingToken: 1,
      contextVersion: 1,
      profileId: randomUUID(),
      profileVersion: 1,
      authEpoch: 1,
      purpose: 'initializer',
      status: 'active',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    primitives,
    allowedOrigins: ['https://login.example.test'],
    gate: { async authorize() {}, async authorizeExport() {} },
  });
  try {
    assert.equal(routes.size, 2);
    await port.close();
    await port.close();
    assert.equal(routes.size, 1);
    assert.ok(routes.has(unrelated));
    assert.equal(session.isClosed, false);
    await assert.rejects(
      primitives.navigate('https://login.example.test/login'),
      (error) => error.code === 'VALIDATION_ERROR',
    );
  } finally {
    await session.close();
  }
});

test('post-login tool results redact snapshots but preserve network arrays and failed captures', async () => {
  const page = new EventEmitter();
  const context = new EventEmitter();
  context.close = async () => {};
  const session = new BrowserSessionImpl(
    randomUUID(),
    ids(),
    context,
    page,
    randomUUID(),
  );
  session.rememberAuthenticationValue(account);
  session.rememberAuthenticationValue(password);
  const snapshot = {
    snapshotId: randomUUID(),
    pageId: session.activePageId,
    stateVersion: 1,
    displayUrl: `https://app.example.test/${account}`,
    title: password,
    nodes: [
      {
        nodeId: 'observed',
        role: 'textbox',
        name: account,
        text: password,
        value: account,
      },
    ],
    consoleSummary: [],
    networkSummary: [],
  };
  try {
    for (const name of ['observe', 'navigate', 'capture']) {
      session.executor.execute = async () => ({
        result: { status: 'failed', data: snapshot },
        snapshot,
      });
      const result = await session.executeTool({ name, args: {} });
      assert.ok(!JSON.stringify(result).includes(account));
      assert.ok(!JSON.stringify(result).includes(password));
      assert.equal(result.data.snapshotId, snapshot.snapshotId);
    }
    for (const data of [
      [{ url: 'https://app.example.test', summary: 'safe' }],
      { criterionId: 'business', result: 'passed' },
      { kind: 'screenshot', id: randomUUID() },
    ]) {
      session.executor.execute = async () => ({
        result: { status: 'succeeded', data },
        snapshot,
      });
      const result = await session.executeTool({
        name: 'inspect_network',
        args: {},
      });
      assert.equal(
        result.data,
        data,
        'non-snapshot payload must retain its contract',
      );
    }
  } finally {
    await session.close();
  }
});
