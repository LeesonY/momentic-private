import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BrowserManager } from '@localqa/browser';
import { runBrowserAuthImport } from '../dist/auth-import.js';

test('active importer uses real Chromium state injection behind private grant/begin/record', async () => {
  const origin = 'http://127.0.0.1:8181';
  const manager = new BrowserManager();
  try {
    const binding = {
      sessionId: randomUUID(),
      projectId: randomUUID(),
      runId: randomUUID(),
      taskId: randomUUID(),
      workerId: 'auth-test-worker',
      fencingToken: 3,
      contextVersion: 1,
      contextId: randomUUID(),
      profileId: randomUUID(),
      profileVersion: 1,
      authEpoch: 1,
      purpose: 'importer',
      status: 'active',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const authStateId = randomUUID();
    const proof = {
      taskId: binding.taskId,
      fencingToken: binding.fencingToken,
      contextVersion: binding.contextVersion,
      leaseToken: 'private-test-proof-only',
    };
    const profile = {
      id: binding.profileId,
      projectId: binding.projectId,
      version: binding.profileVersion,
      status: 'active',
      mode: 'storage_state',
      allowedOrigins: [origin, 'http://localhost:9191'],
    };
    const grant = {
      ...binding,
      authStateId,
      kind: 'import_auth_state',
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
      async grantAuthImport(p, id) {
        assert.equal(p.leaseToken, proof.leaseToken);
        assert.equal(id, binding.sessionId);
        history.push('grant');
        return grant;
      },
      async prepareAuthImport(_p, id, grantId) {
        assert.equal(id, binding.sessionId);
        assert.equal(grantId, grant.grantId);
        history.push('prepare');
        return {
          grant,
          state: {
            cookies: [
              {
                name: 'sid',
                value: 'isolated-approved-cookie',
                domain: '127.0.0.1',
                path: '/',
              },
              {
                name: 'idp-session',
                value: 'not-for-test-browser',
                domain: 'localhost',
                path: '/',
              },
            ],
            origins: [
              {
                origin: 'http://localhost:9191',
                localStorage: [{ name: 'idp-token', value: 'not-for-test' }],
              },
            ],
          },
        };
      },
      async beginAuthImport(_p, id, grantId) {
        assert.equal(id, binding.sessionId);
        assert.equal(grantId, grant.grantId);
        history.push('begin');
        return receipt;
      },
      async recordAuthImport(_p, id, grantId, actualReceipt, outcome) {
        assert.equal(id, binding.sessionId);
        assert.equal(grantId, grant.grantId);
        assert.equal(actualReceipt.executionId, receipt.executionId);
        assert.equal(outcome.status, 'succeeded');
        history.push('record');
      },
    };
    const session = await manager.createSession({
      sessionId: binding.contextId,
      projectId: binding.projectId,
      runId: binding.runId,
      taskId: binding.taskId,
      allowedOrigins: [origin],
    });
    const result = await runBrowserAuthImport(
      {
        session,
        binding,
        proof,
        profile,
        client,
        authStateId,
        executionOrigins: [origin],
      },
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      status: 'imported',
      reasonCode: 'AUTH_IMPORTED',
    });
    assert.deepEqual(history, ['grant', 'prepare', 'begin', 'record']);
    const cookies = await session.getContext().cookies(origin);
    assert.equal(
      cookies.find((cookie) => cookie.name === 'sid')?.value,
      'isolated-approved-cookie',
    );
    assert.equal(
      (await session.getContext().cookies('http://localhost:9191')).length,
      0,
    );
    assert.equal(JSON.stringify(result).includes(proof.leaseToken), false);
    assert.equal(
      JSON.stringify(result).includes('isolated-approved-cookie'),
      false,
    );

    const other = await manager.createSession({
      projectId: binding.projectId,
      runId: binding.runId,
      taskId: randomUUID(),
      allowedOrigins: [origin],
    });
    assert.equal((await other.getContext().cookies(origin)).length, 0);
    const mismatched = await runBrowserAuthImport(
      { session: other, binding, proof, profile, client, authStateId },
      new AbortController().signal,
    );
    assert.deepEqual(mismatched, {
      status: 'blocked',
      reasonCode: 'VALIDATION_ERROR',
    });
    assert.deepEqual(history, ['grant', 'prepare', 'begin', 'record']);
  } finally {
    await manager.close();
  }
});
