import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { SessionAgent, SESSION_ROUND_LIMIT } from '../dist/session-agent.js';

function fixture(session) {
  const jobs = [];
  const dispatched = [];
  const run = {
    id: randomUUID(),
    projectId: randomUUID(),
    phase: 'execute',
    terminationReason: null,
  };
  const coordinator = {
    enqueueReproductions: async () => 0,
    change: async (_client, current, status, phase) => ({
      ...current,
      status,
      phase,
    }),
    enqueue: async (_client, _run, role, stage) =>
      dispatched.push({ role, stage }),
  };
  const agent = new SessionAgent(coordinator);
  agent.read = async () => session;
  agent.write = async (_client, _run, next) => Object.assign(session, next);
  const client = { query: async () => ({ rows: [] }) };
  const child = (status) => ({
    id: randomUUID(),
    role: 'executor',
    status,
    result: { stage: 'execute' },
    document: { summary: 'execute' },
  });
  return { agent, client, run, jobs, dispatched, child };
}

test('an explicitly stopped planner drains late results without requesting more work', async () => {
  const state = fixture({
    round: 2,
    status: 'finalizing',
    planningStopped: true,
    reviewedTaskIds: [],
  });
  state.jobs.push(state.child('succeeded'), state.child('running'));
  await state.agent.advance(state.client, state.run, state.jobs);
  assert.deepEqual(state.dispatched, []);
  state.jobs[1].status = 'succeeded';
  await state.agent.advance(state.client, state.run, state.jobs);
  assert.deepEqual(state.dispatched, [
    { role: 'finalizer', stage: 'finalize' },
  ]);
});

test('completion during an active review remains available for the next review', async () => {
  const session = { round: 1, status: 'reviewing', reviewedTaskIds: [] };
  const state = fixture(session);
  state.jobs.push(state.child('succeeded'), {
    id: randomUUID(),
    role: 'coordinator',
    status: 'running',
    result: { stage: 'plan' },
  });
  await state.agent.advance(state.client, state.run, state.jobs);
  assert.deepEqual(session.reviewedTaskIds, []);
  state.jobs[1].status = 'succeeded';
  session.status = 'working';
  await state.agent.advance(state.client, state.run, state.jobs);
  assert.deepEqual(state.dispatched, [{ role: 'coordinator', stage: 'plan' }]);
  assert.deepEqual(session.reviewedTaskIds, [state.jobs[0].id]);
});

test('round limit stops dispatching and waits for running children before reporting', async () => {
  const state = fixture({
    round: SESSION_ROUND_LIMIT,
    status: 'working',
    coverageGaps: [],
  });
  state.jobs.push(state.child('running'));
  await state.agent.advance(state.client, state.run, state.jobs);
  assert.deepEqual(state.dispatched, []);
  state.jobs[0].status = 'succeeded';
  await state.agent.advance(state.client, state.run, state.jobs);
  assert.deepEqual(state.dispatched, [
    { role: 'finalizer', stage: 'finalize' },
  ]);
});
