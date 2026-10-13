import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRegression } from '@localqa/orchestrator';
import { replayRegression } from '../dist/regression-replay.js';

function compiled() {
  return compileRegression(
    {
      schemaVersion: 1,
      kind: 'localqa/test',
      id: 'recovery',
      name: 'Long business flow',
      criteria: [
        {
          id: 'ready',
          kind: 'element_visible',
          description: 'Page ready',
          sourceKind: 'generic_smoke',
          sourceRef: 'fixture',
          locator: { by: 'css', value: 'body' },
        },
      ],
      steps: [
        { kind: 'navigate', url: 'https://fixture.test/' },
        {
          kind: 'click',
          locator: { by: 'role', value: 'button', name: 'Next' },
        },
        {
          kind: 'type_text',
          locator: { by: 'label', value: 'Email' },
          text: 'hello',
        },
      ],
    },
    {
      projectId: 'p',
      env: {},
      allowedOrigins: ['https://fixture.test'],
      maxExpandedSteps: 100,
      resolveModule: () => undefined,
    },
  );
}
const missing = () =>
  Object.assign(new Error('hidden DOM details'), { code: 'LOCATOR_NOT_FOUND' });

test('delayed DOM recovers before action without repeating an already executed click', async () => {
  const operations = [];
  let resolves = 0;
  const result = await replayRegression(
    compiled(),
    {
      async executeTool(call) {
        operations.push(call.name);
        return { status: 'succeeded' };
      },
      async resolveTarget() {
        resolves++;
        if (resolves === 1 || resolves === 3) throw missing();
        return {
          snapshotId: '00000000-0000-4000-8000-000000000001',
          pageId: '00000000-0000-4000-8000-000000000002',
          nodeId: `node-${resolves}`,
        };
      },
      async evaluateCriterion() {
        throw new Error('unreachable');
      },
    },
    new AbortController().signal,
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(operations, ['navigate', 'click', 'type_text']);
  assert.equal(result.steps[1].resolutionAttempts, 2);
  assert.deepEqual(result.steps[1].recoveryCodes, ['LOCATOR_NOT_FOUND']);
  assert.equal(result.steps[2].resolutionAttempts, 2);
});

test('ambiguous locator never triggers self-heal or subsequent business mutation', async () => {
  let resolutions = 0;
  const operations = [];
  const result = await replayRegression(
    compiled(),
    {
      async executeTool(call) {
        operations.push(call.name);
        return { status: 'succeeded' };
      },
      async resolveTarget() {
        resolutions++;
        throw Object.assign(new Error('ambiguous'), {
          code: 'LOCATOR_NOT_UNIQUE',
        });
      },
      async evaluateCriterion() {
        throw new Error('unreachable');
      },
    },
    new AbortController().signal,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.reasonCode, 'LOCATOR_NOT_UNIQUE');
  assert.equal(resolutions, 1);
  assert.deepEqual(operations, ['navigate']);
  assert.deepEqual(result.steps[1].recoveryCodes, []);
});

test('exhausted missing locator stops before click, preserving machine cause', async () => {
  let resolutions = 0;
  const operations = [];
  const result = await replayRegression(
    compiled(),
    {
      async executeTool(call) {
        operations.push(call.name);
        return { status: 'succeeded' };
      },
      async resolveTarget() {
        resolutions++;
        throw missing();
      },
      async evaluateCriterion() {
        throw new Error('unreachable');
      },
    },
    new AbortController().signal,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.reasonCode, 'LOCATOR_NOT_FOUND');
  assert.equal(resolutions, 3);
  assert.deepEqual(operations, ['navigate']);
  assert.deepEqual(result.steps[1].recoveryCodes, [
    'LOCATOR_NOT_FOUND',
    'LOCATOR_NOT_FOUND',
  ]);
  assert.equal(JSON.stringify(result).includes('hidden DOM details'), false);
});

test('cancellation during missing-element recovery never dispatches the pending click', async () => {
  const cancellation = new AbortController();
  const operations = [];
  let resolutions = 0;
  const result = await replayRegression(
    compiled(),
    {
      async executeTool(call) {
        operations.push(call.name);
        return { status: 'succeeded' };
      },
      async resolveTarget() {
        resolutions++;
        cancellation.abort();
        throw missing();
      },
      async evaluateCriterion() {
        throw new Error('unreachable');
      },
    },
    cancellation.signal,
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reasonCode, 'CANCELLED');
  assert.equal(resolutions, 1);
  assert.deepEqual(operations, ['navigate']);
});
