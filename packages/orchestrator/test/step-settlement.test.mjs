import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContract } from '@localqa/contracts';
import { safeStepReasonCode, settledStep } from '@localqa/orchestrator';

const step = () =>
  parseContract('Step', {
    id: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    taskId: '33333333-3333-4333-8333-333333333333',
    caseId: null,
    seq: 1,
    toolName: 'type_text',
    status: 'running',
    summary: 'Action intent persisted before execution',
    targetDescription: 'type_text',
    evidenceRefs: [],
    createdAt: '2026-10-17T03:02:00.000Z',
    finishedAt: null,
  });

test('a failed step records its reason code and still passes the Step contract', () => {
  const settled = settledStep(
    step(),
    'failed',
    [],
    'VERSION_CONFLICT',
    '2026-10-17T03:02:33.000Z',
  );
  assert.equal(settled.status, 'failed');
  assert.equal(settled.reasonCode, 'VERSION_CONFLICT');
  assert.equal(settled.summary, 'Browser failed');
  assert.equal(settled.finishedAt, '2026-10-17T03:02:33.000Z');
  parseContract('Step', settled);
});

test('a succeeded step carries no failure reason', () => {
  const settled = settledStep(step(), 'succeeded', [], 'VERSION_CONFLICT');
  assert.equal('reasonCode' in settled, false);
});

test('only code-shaped values are kept; typed text and URLs cannot leak into the step', () => {
  assert.equal(
    safeStepReasonCode('REPEATED_ACTION_LIMIT'),
    'REPEATED_ACTION_LIMIT',
  );
  assert.equal(safeStepReasonCode(null), null);
  assert.equal(safeStepReasonCode(''), null);
  assert.equal(safeStepReasonCode('x'.repeat(200)), 'BROWSER_FAILED');
  const settled = settledStep(
    step(),
    'failed',
    [],
    'typed smoke_user_114 / WrongPwd_123 https://fixture.test/?token=abc',
  );
  assert.equal(settled.reasonCode, 'BROWSER_FAILED');
  const json = JSON.stringify(settled);
  assert.equal(json.includes('smoke_user_114'), false);
  assert.equal(json.includes('WrongPwd_123'), false);
  assert.equal(json.includes('token='), false);
});
