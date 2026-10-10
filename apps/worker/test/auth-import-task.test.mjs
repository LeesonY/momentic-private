import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BrowserManager } from '@localqa/browser';
import { withApprovedBrowserAuth } from '../dist/auth-import-task.js';

function fixture(overrides = {}) {
  const allowed = 'http://127.0.0.1:8181';
  const authStateId = randomUUID();
  const proof = {
    taskId: randomUUID(),
    fencingToken: 5,
    contextVersion: 1,
    leaseToken: 'task-private-lease-not-for-logs',
  };
  const profile = {
    id: randomUUID(),
    projectId: randomUUID(),
    version: 3,
    status: 'active',
    mode: 'storage_state',
    allowedOrigins: [allowed],
  };
  const allocated = {
    sessionId: randomUUID(),
    projectId: profile.projectId,
    runId: randomUUID(),
    taskId: proof.taskId,
    workerId: 'real-chromium-worker',
    fencingToken: proof.fencingToken,
    contextVersion: proof.contextVersion,
    contextId: randomUUID(),
    profileId: profile.id,
    profileVersion: profile.version,
    authEpoch: 1,
    purpose: 'importer',
    status: 'allocated',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const active = { ...allocated, status: 'active', ...overrides.active };
  const grant = {
    ...active,
    kind: 'import_auth_state',
    authStateId,
    grantId: randomUUID(),
    deadline: new Date(Date.now() + 30000).toISOString(),
  };
  const receipt = {
    grantId: grant.grantId,
    executionId: randomBytes(32).toString('hex'),
    startedAt: new Date().toISOString(),
  };
  const history = [];
  const client = {
    async allocateAuthImporterSession(_proof, id) {
      history.push('allocate');
      assert.equal(id, authStateId);
      return allocated;
    },
    async issueAuthActivationTicket(_proof, id) {
      history.push('ticket');
      assert.equal(id, allocated.sessionId);
      return { activationTicket: 'opaque-private-ticket' };
    },
    async activateAuthSession(_proof, id, ticket) {
      history.push('activate');
      assert.equal(id, allocated.sessionId);
      assert.equal(ticket, 'opaque-private-ticket');
      return active;
    },
    async grantAuthImport() {
      history.push('grant');
      return grant;
    },
    async prepareAuthImport() {
      history.push('prepare');
      return {
        grant,
        state: {
          cookies: [
            {
              name: 'sid',
              value: 'real-chromium-task-cookie',
              domain: '127.0.0.1',
              path: '/',
            },
          ],
          origins: [],
        },
      };
    },
    async beginAuthImport() {
      history.push('begin');
      return receipt;
    },
    async recordAuthImport(_proof, _id, _grantId, passedReceipt, status) {
      history.push('record');
      assert.equal(passedReceipt.executionId, receipt.executionId);
      assert.equal(status.status, 'succeeded');
    },
    async endAuthSession(_proof, _id, reason) {
      history.push(`end:${reason}`);
      return { ...active, status: 'ended' };
    },
  };
  return { allowed, authStateId, proof, profile, client, history };
}

test('task admission activates the real context, imports once, runs task callback, then closes and ends session', async () => {
  const w = fixture();
  const browser = new BrowserManager();
  let seenSession;
  try {
    const result = await withApprovedBrowserAuth(
      {
        ...w,
        browser,
        allowedOrigins: [w.allowed],
        async onAuthenticated(session) {
          seenSession = session;
          const cookies = await session.getContext().cookies(w.allowed);
          assert.equal(
            cookies.find((cookie) => cookie.name === 'sid')?.value,
            'real-chromium-task-cookie',
          );
          w.history.push('callback');
        },
      },
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      status: 'imported',
      reasonCode: 'AUTH_IMPORTED',
    });
    assert.deepEqual(w.history, [
      'allocate',
      'ticket',
      'activate',
      'grant',
      'prepare',
      'begin',
      'record',
      'callback',
    ]);
    assert.equal(seenSession.isClosed, true);
    assert.equal(JSON.stringify(result).includes(w.proof.leaseToken), false);
  } finally {
    await browser.close();
  }
});

test('activation context substitution is blocked before browser creation or state grant', async () => {
  const w = fixture({ active: { contextId: randomUUID() } });
  const browser = new BrowserManager();
  let callback = false;
  try {
    const result = await withApprovedBrowserAuth(
      {
        ...w,
        browser,
        allowedOrigins: [w.allowed],
        async onAuthenticated() {
          callback = true;
        },
      },
      new AbortController().signal,
    );
    assert.equal(result.status, 'blocked');
    assert.equal(callback, false);
    assert.deepEqual(w.history, [
      'allocate',
      'ticket',
      'activate',
      'end:failed',
    ]);
  } finally {
    await browser.close();
  }
});

test('run origin wider than profile or invalid prevents all server operations', async () => {
  const w = fixture();
  const browser = new BrowserManager();
  try {
    for (const allowedOrigins of [
      ['http://127.0.0.1:8181', 'http://127.0.0.1:9191'],
      ['not a URL'],
    ]) {
      const result = await withApprovedBrowserAuth(
        {
          ...w,
          browser,
          allowedOrigins,
          async onAuthenticated() {
            assert.fail('callback must not run');
          },
        },
        new AbortController().signal,
      );
      assert.equal(result.status, 'blocked');
      assert.deepEqual(w.history, []);
    }
  } finally {
    await browser.close();
  }
});

test('callback failure closes the context and ends the private session', async () => {
  const w = fixture();
  const browser = new BrowserManager();
  let seenSession;
  try {
    const result = await withApprovedBrowserAuth(
      {
        ...w,
        browser,
        allowedOrigins: [w.allowed],
        async onAuthenticated(session) {
          seenSession = session;
          throw new Error('do not expose callback error');
        },
      },
      new AbortController().signal,
    );
    assert.equal(result.status, 'blocked');
    assert.equal(result.reasonCode, 'VALIDATION_ERROR');
    assert.equal(seenSession.isClosed, true);
    assert.equal(w.history.at(-1), 'end:failed');
  } finally {
    await browser.close();
  }
});

test('cancellation after ticket issuance prevents activation and cleans up the allocated session', async () => {
  const w = fixture();
  const controller = new AbortController();
  const originalTicket = w.client.issueAuthActivationTicket;
  w.client.issueAuthActivationTicket = async (...args) => {
    const issued = await originalTicket(...args);
    controller.abort();
    return issued;
  };
  const browser = new BrowserManager();
  try {
    const result = await withApprovedBrowserAuth(
      {
        ...w,
        browser,
        allowedOrigins: [w.allowed],
        async onAuthenticated() {
          assert.fail('no callback after cancellation');
        },
      },
      controller.signal,
    );
    assert.deepEqual(result, { status: 'cancelled', reasonCode: 'CANCELLED' });
    assert.deepEqual(w.history, ['allocate', 'ticket', 'end:cancelled']);
  } finally {
    await browser.close();
  }
});
