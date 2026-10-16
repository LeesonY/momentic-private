// Pool sizing, transient-error classification and the bounded retry helper.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Database,
  DatabaseUnavailableError,
  StorageError,
  isTransientDatabaseError,
  mapDatabaseError,
  resolvePoolMax,
  withTransientRetry,
} from '@localqa/storage';

test('pool size comes from an explicit value, DB_POOL_MAX, or the default 8', () => {
  const previous = process.env.DB_POOL_MAX;
  try {
    delete process.env.DB_POOL_MAX;
    assert.equal(resolvePoolMax(), 8);
    assert.equal(resolvePoolMax(12), 12);
    process.env.DB_POOL_MAX = '20';
    assert.equal(resolvePoolMax(), 20);
    assert.equal(resolvePoolMax(4), 4, 'explicit wins over the environment');
    for (const invalid of ['0', '-1', 'abc', '1000'])
      assert.equal(
        (process.env.DB_POOL_MAX = invalid) && resolvePoolMax(),
        8,
        invalid,
      );
    const db = new Database('postgresql://localqa:test@127.0.0.1:1/localqa', {
      poolMax: 33,
    });
    assert.equal(db.poolMax, 33);
    db.close().catch(() => {});
  } finally {
    if (previous === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = previous;
  }
});

test('only connectivity/overload failures are transient and retryable', () => {
  assert.equal(isTransientDatabaseError(new DatabaseUnavailableError()), true);
  assert.equal(
    isTransientDatabaseError(new StorageError('SERVICE_UNAVAILABLE')),
    false,
    'an unclassified failure is not retried',
  );
  for (const error of [
    { code: '08006' },
    { code: '08001' },
    { code: '57P01' },
    { code: 'ECONNRESET' },
    { code: 'ETIMEDOUT' },
    { message: 'timeout exceeded when trying to connect' },
  ]) {
    assert.throws(
      () => mapDatabaseError(error),
      (thrown) => isTransientDatabaseError(thrown),
      JSON.stringify(error),
    );
  }
  assert.throws(
    () => mapDatabaseError({ code: '23505' }),
    (thrown) => thrown.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => mapDatabaseError(new Error('unexpected')),
    (thrown) =>
      thrown.code === 'SERVICE_UNAVAILABLE' &&
      !isTransientDatabaseError(thrown),
  );
});

test('bounded retry: recovers from transient blips, gives up at the cap, never retries others', async () => {
  let calls = 0;
  const recovered = await withTransientRetry(
    async () => {
      calls++;
      if (calls < 3) throw new DatabaseUnavailableError();
      return 'ok';
    },
    { attempts: 3, delaysMs: [0, 0] },
  );
  assert.equal(recovered, 'ok');
  assert.equal(calls, 3);

  let capped = 0;
  await assert.rejects(
    withTransientRetry(
      async () => {
        capped++;
        throw new DatabaseUnavailableError();
      },
      { attempts: 3, delaysMs: [0, 0] },
    ),
    (error) => isTransientDatabaseError(error),
  );
  assert.equal(capped, 3, 'attempts are bounded');

  let permanent = 0;
  await assert.rejects(
    withTransientRetry(
      async () => {
        permanent++;
        throw new StorageError('VALIDATION_ERROR');
      },
      { attempts: 3, delaysMs: [0, 0] },
    ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.equal(permanent, 1, 'non-transient errors are not retried');

  await assert.rejects(
    withTransientRetry(async () => 'x', { attempts: 0 }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});
