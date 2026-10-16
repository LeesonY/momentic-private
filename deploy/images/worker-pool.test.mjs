import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerPoolMax } from './worker-pool.mjs';

test('worker pool scales past the in-flight claim count and stays bounded', () => {
  assert.equal(workerPoolMax(25), 33, 'BROWSER_SLOTS=25 -> 33 connections');
  assert.equal(workerPoolMax(4), 12);
  assert.equal(workerPoolMax(1), 9);
  assert.equal(workerPoolMax(100), 40, 'never beyond the hard cap');
  assert.equal(workerPoolMax(25, '12'), 12, 'DB_POOL_MAX overrides the slots');
  assert.equal(
    workerPoolMax(25, '200'),
    33,
    'an out-of-range override is ignored',
  );
  assert.equal(workerPoolMax(25, 'abc'), 33);
  assert.equal(workerPoolMax(0), 8);
  assert.equal(workerPoolMax(Number.NaN), 8);
});
