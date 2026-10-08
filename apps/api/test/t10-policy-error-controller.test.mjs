import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { StorageError } from '@localqa/storage';
import { DomainError } from '@localqa/domain';
import { ApiError, toApiErrorResponse } from '../dist/errors.js';
import { createRequestHandler } from '../dist/app.js';
import { Router } from '../dist/router.js';

test('Storage policy denial becomes HTTP FORBIDDEN, with no private diagnostic', () => {
  const requestId = randomUUID();
  const result = toApiErrorResponse(
    new StorageError('POLICY_DENIED', 'root-private-state-diagnostic'),
    requestId,
  );
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'FORBIDDEN');
  assert.equal(result.body.requestId, requestId);
  assert.equal(
    JSON.stringify(result).includes('root-private-state-diagnostic'),
    false,
  );
});
test('Actual request handler sends 403 for a service policy refusal without a listener or database', async () => {
  const router = new Router();
  let calls = 0;
  router.post('/root-owned-policy-probe', async () => {
    calls++;
    throw new StorageError('POLICY_DENIED');
  });
  const req = Object.assign(Readable.from([]), {
    method: 'POST',
    url: '/root-owned-policy-probe',
    headers: { host: 'localhost' },
  });
  const headers = new Map();
  let payload;
  const res = {
    writableEnded: false,
    statusCode: 200,
    setHeader(name, value) {
      headers.set(name, value);
    },
    end(value) {
      payload = value;
      this.writableEnded = true;
    },
  };
  await createRequestHandler({ publicOrigin: 'http://localhost' }, router)(
    req,
    res,
  );
  assert.equal(calls, 1);
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(payload);
  assert.equal(body.code, 'FORBIDDEN');
  assert.equal(body.requestId, headers.get('X-Request-Id'));
  assert.equal(headers.get('Content-Type'), 'application/json; charset=utf-8');
});
test('Existing scoped-lease, domain reason, authentication and unknown-error mappings remain stable', () => {
  assert.equal(
    toApiErrorResponse(new StorageError('SCOPE_CHANGED'), randomUUID()).body
      .code,
    'LEASE_EXPIRED',
  );
  assert.equal(
    toApiErrorResponse(new StorageError('SCOPE_CHANGED'), randomUUID()).status,
    409,
  );
  for (const code of [
    'POLICY_DENIED',
    'BUDGET_EXCEEDED',
    'INPUT_TIMEOUT',
    'USER_CANCELLED',
  ]) {
    const result = toApiErrorResponse(new DomainError(code), randomUUID());
    assert.equal(result.body.code, 'VALIDATION_ERROR');
    assert.equal(result.status, 422);
  }
  for (const [code, status] of [
    ['FORBIDDEN', 403],
    ['UNAUTHENTICATED', 401],
    ['LEASE_EXPIRED', 409],
    ['VALIDATION_ERROR', 422],
  ])
    assert.equal(
      toApiErrorResponse(new StorageError(code), randomUUID()).status,
      status,
    );
  const unknown = toApiErrorResponse(
    new Error('root-private-unknown-diagnostic'),
    randomUUID(),
  );
  assert.equal(unknown.status, 500);
  assert.equal(
    JSON.stringify(unknown).includes('root-private-unknown-diagnostic'),
    false,
  );
  assert.equal(
    toApiErrorResponse(
      new ApiError('FORBIDDEN', 'Explicit denial', 403),
      randomUUID(),
    ).status,
    403,
  );
});
