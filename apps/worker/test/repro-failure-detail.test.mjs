import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from '../dist/index.js';
import { taskFailure, TRANSIENT_REPRODUCTION_FAILURES } from '@localqa/domain';

for (const outcome of [
  'malformed',
  'refused',
  'timeout',
  'provider_error',
  'unavailable',
  'rate_limited',
]) {
  test(`reproducer decision preserves only the ${outcome} failure category`, async () => {
    const worker = new Worker({
      runtime: {
        model: async () => ({
          requestResult: outcome,
          errorCode: 'VALIDATION_ERROR',
          data: null,
          rawOutput: 'SECRET password page text prompt',
        }),
      },
      browser: { close: async () => {} },
      scratch: '.',
    });
    await assert.rejects(
      worker.decide({}, 'reproducer', [], new AbortController().signal),
      (error) => {
        assert.equal(error.code, 'MODEL_FAILURE');
        assert.equal(error.outcome, outcome);
        const failure = taskFailure(error.code, error.outcome);
        assert.match(failure.detail, new RegExp(`^${outcome}:`));
        assert.ok(failure.detail.length <= 300);
        assert.doesNotMatch(
          JSON.stringify(error),
          /SECRET|password|page text|prompt/,
        );
        assert.doesNotMatch(
          JSON.stringify(failure),
          /SECRET|password|page text|prompt/,
        );
        return true;
      },
    );
  });
}

test('failed final report is a transient reproduction failure rather than an unexplained inconclusive verdict', async () => {
  const worker = new Worker({
    runtime: {
      model: async () => ({
        requestResult: 'malformed',
        errorCode: 'VALIDATION_ERROR',
        data: null,
      }),
    },
    browser: { close: async () => {} },
    scratch: '.',
  });
  const work = {
    definition: {
      title: 'Fixture',
      summary: '',
      preconditions: [],
      outline: [],
      criteria: [],
    },
  };
  await assert.rejects(
    worker.agentReport(
      {},
      'reproducer',
      work,
      { nodes: [], title: 'Fixture', consoleSummary: [] },
      [],
      new AbortController().signal,
    ),
    (error) => error.code === 'MODEL_FAILURE' && error.outcome === 'malformed',
  );
});

test('unknown diagnostic is discarded and deterministic failures stay off the retry allowlist', () => {
  const failure = taskFailure('untrusted password', 'SECRET page text');
  assert.deepEqual(failure, {
    code: 'WORKER_FAILURE',
    detail: '执行器偶发失败，任务未完成',
  });
  for (const code of [
    'AUTH_FAILED',
    'POLICY_DENIED',
    'MODEL_NOT_CONFIGURED',
    'MODEL_BILLING_REQUIRED',
    'MODEL_CAPABILITY_MISSING',
    'CANCELLED',
    'BUDGET_EXCEEDED',
  ]) {
    assert.equal(TRANSIENT_REPRODUCTION_FAILURES.has(code), false);
  }
});
