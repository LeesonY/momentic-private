import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestTaskStepSignal } from '../src/components/session/taskStepSignal.ts';

function event(runId, seq, taskId, type = 'step.recorded') {
  return {
    runId,
    seq,
    type,
    payload: { id: `step-${seq}`, taskId },
  };
}

test('browser frame refresh follows only a matching task and run', () => {
  const events = [
    event('run-1', 15, 'task-1'),
    event('run-1', 21, 'task-other'),
    event('run-other', 80, 'task-1'),
    event('run-1', 23, 'task-1', 'task.updated'),
    event('run-1', 17, 'task-1'),
  ];
  assert.equal(latestTaskStepSignal('run-1', 'task-1', events), 17);
  assert.equal(latestTaskStepSignal('run-1', 'task-other', events), 21);
  assert.equal(latestTaskStepSignal('run-1', null, events), 0);
});

test('invalid, out-of-order and non-step SSE must never initiate refresh', () => {
  const events = [
    event('run-1', 0, 'task-1'),
    event('run-1', -1, 'task-1'),
    event('run-1', NaN, 'task-1'),
    event('run-1', 1.5, 'task-1'),
    { ...event('run-1', 9, 'task-1'), payload: null },
    event('run-1', 12, 'task-1', 'artifact.updated'),
  ];
  assert.equal(latestTaskStepSignal('run-1', 'task-1', events), 0);
});

test('a burst is represented by its last step sequence without duplicates', () => {
  const events = Array.from({ length: 300 }, (_, index) =>
    event('run-1', 1000 + index, index % 3 === 0 ? 'task-1' : 'task-2'),
  ).reverse();
  assert.equal(latestTaskStepSignal('run-1', 'task-1', events), 1297);
  assert.equal(latestTaskStepSignal('run-1', 'task-2', events), 1299);
});
