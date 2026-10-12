import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from '../dist/index.js';
test('preflight with approved auth completes without a model request', async () => {
  let modelCalls = 0;
  let finished;
  const runtime = {
    claim: async () => ({
      task: { id: 'fixture', summary: 'preflight' },
      fencingToken: 1,
      leaseToken: 'fixture',
      contextVersion: 1,
    }),
    work: async () => ({
      stage: 'preflight',
      run: {
        executionMode: 'smoke',
        effectiveConfig: { authProfileVersion: 1 },
      },
    }),
    authProfile: async () => ({ mode: 'form' }),
    model: async () => {
      modelCalls++;
      throw new Error('Provider key busy');
    },
    finish: async (_proof, result) => {
      finished = result;
    },
  };
  const worker = new Worker({
    runtime,
    browser: {},
    scratch: '.',
    heartbeatMs: 10000,
  });
  assert.equal(await worker.once(), true);
  assert.equal(modelCalls, 0);
  assert.deepEqual(finished, { stage: 'preflight', checked: true });
});
