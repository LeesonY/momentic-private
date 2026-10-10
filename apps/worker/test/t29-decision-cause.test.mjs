import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from '../dist/index.js';
import { createRegressionAiAction } from '../dist/regression-ai.js';
import { parseContract } from '@localqa/contracts';

const lease = {
  taskId: '22222222-2222-4222-8222-222222222222',
  fencingToken: 1,
  leaseToken: 'not-real',
  contextVersion: 1,
};
const message = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Only frozen fixture.' }],
  },
];

function workerFor(result) {
  let requests = 0;
  const worker = new Worker({
    runtime: {
      model: async () => {
        requests++;
        return result;
      },
    },
    browser: { close: async () => {} },
    scratch: '.',
  });
  return {
    worker,
    get requests() {
      return requests;
    },
  };
}

test('T29 regression decision hands a structured transport error to guarded AI, without generic masking or retry', async () => {
  const failure = {
    requestResult: 'unavailable',
    errorCode: 'SERVICE_UNAVAILABLE',
    data: null,
    rawOutput: 'untrusted provider text MUST NOT be used as an error cause',
  };
  const run = workerFor(failure);
  const returned = await run.worker.decide(
    lease,
    'executor',
    message,
    new AbortController().signal,
    true,
  );
  assert.equal(returned.requestResult, 'unavailable');
  assert.equal(returned.errorCode, 'SERVICE_UNAVAILABLE');
  assert.equal(run.requests, 1);
});

test('T29 ordinary non-regression decision keeps original fail-closed behavior', async () => {
  const { worker } = workerFor({
    requestResult: 'malformed',
    errorCode: 'VALIDATION_ERROR',
    data: null,
  });
  await assert.rejects(
    worker.decide(lease, 'planner', message, new AbortController().signal),
    (err) => err?.code === 'MODEL_FAILURE',
  );
});

test('T29 regression receives a malformed model record so frozen replay can classify MODEL_VALIDATION_FAILED', async () => {
  const { worker } = workerFor({
    requestResult: 'malformed',
    errorCode: 'VALIDATION_ERROR',
    data: null,
  });
  const result = await worker.decide(
    lease,
    'executor',
    message,
    new AbortController().signal,
    true,
  );
  assert.equal(result.requestResult, 'malformed');
  assert.equal(result.errorCode, 'VALIDATION_ERROR');
});

test('T29 cancelled scope does not invoke provider even when failure passthrough requested', async () => {
  const run = workerFor({ requestResult: 'ok', data: {} });
  const controller = new AbortController();
  controller.abort('cancelled');
  await assert.rejects(
    run.worker.decide(lease, 'executor', message, controller.signal, true),
    (err) => err?.code === 'CANCELLED',
  );
  assert.equal(run.requests, 0);
});

test('T29 non-executor role cannot opt into structured failure record passthrough', async () => {
  const run = workerFor({
    requestResult: 'unavailable',
    errorCode: 'SERVICE_UNAVAILABLE',
    data: null,
  });
  await assert.rejects(
    run.worker.decide(
      lease,
      'planner',
      message,
      new AbortController().signal,
      true,
    ),
    (err) => err?.code === 'VALIDATION_ERROR',
  );
  assert.equal(run.requests, 0);
});

test('T29 abort raised by provider before resolution remains cancellation, not model failure', async () => {
  const controller = new AbortController();
  const worker = new Worker({
    runtime: {
      model: async () => {
        controller.abort();
        return {
          requestResult: 'unavailable',
          errorCode: 'SERVICE_UNAVAILABLE',
          data: null,
        };
      },
    },
    browser: { close: async () => {} },
    scratch: '.',
  });
  await assert.rejects(
    worker.decide(lease, 'executor', message, controller.signal, true),
    (err) => err?.code === 'CANCELLED',
  );
});

test('T29 Worker-to-regression port preserves the frozen failure cause and executes zero mutating tools', async () => {
  const snapshot = parseContract('BrowserSnapshot', {
    snapshotId: '11111111-1111-4111-8111-111111111111',
    pageId: '22222222-2222-4222-8222-222222222222',
    frameIds: ['main'],
    displayUrl: 'http://fixture.local.test:8080/',
    title: 'Private test fixture',
    responseStatus: 200,
    capturedAt: '2026-10-09T06:00:00.000Z',
    stateVersion: 1,
    viewport: { width: 800, height: 600 },
    nodes: [],
    screenshotRef: null,
    networkSummary: [],
    consoleSummary: [],
    truncated: false,
    redacted: true,
  });
  for (const sample of [
    {
      result: 'timeout',
      code: 'MODEL_TIMEOUT',
      expected: 'MODEL_TIMEOUT',
    },
    {
      result: 'malformed',
      code: 'VALIDATION_ERROR',
      expected: 'MODEL_VALIDATION_FAILED',
    },
    {
      result: 'unavailable',
      code: 'SERVICE_UNAVAILABLE',
      expected: 'SERVICE_UNAVAILABLE',
    },
  ]) {
    const run = workerFor({
      requestResult: sample.result,
      errorCode: sample.code,
      data: null,
    });
    let observations = 0;
    let mutations = 0;
    const action = createRegressionAiAction({
      role: 'executor',
      decide: (messages, signal) =>
        run.worker.decide(lease, 'executor', messages, signal, true),
      observation: () => snapshot,
      evidence: () => [],
    });
    await assert.rejects(
      action({
        goal: 'Frozen two-action checkout',
        maxToolCalls: 2,
        minToolCalls: 2,
        criteria: [],
        source: {},
        signal: new AbortController().signal,
        executeTool: async (call) => {
          if (call.name === 'observe') {
            observations++;
            return { status: 'succeeded', data: snapshot };
          }
          mutations++;
          throw new Error('must never execute on model failure');
        },
      }),
      (err) => err?.code === sample.expected,
    );
    assert.equal(run.requests, 1);
    assert.equal(observations, 1);
    assert.equal(mutations, 0);
  }
});
