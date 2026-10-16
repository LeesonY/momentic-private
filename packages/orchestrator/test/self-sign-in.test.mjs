import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  signInKind,
  AuthExecutionManager,
  AuthActionsManager,
} from '../dist/index.js';

const session = { objective: '', round: 1 };
const run = (executionMode = 'smoke') => ({
  id: randomUUID(),
  projectId: randomUUID(),
  executionMode,
  status: 'running',
  effectiveConfig: { allowedOrigins: ['https://app.example.test'] },
});
const job = (role, summary) => ({
  id: randomUUID(),
  role,
  case_id: role === 'coordinator' ? null : randomUUID(),
  document: { summary },
  result: { stage: summary },
});
const coordinator = (managed) => ({
  sessions: { read: async () => (managed ? session : null) },
});
const noQueries = {
  query: async (sql) => assert.fail(`unexpected query: ${sql.slice(0, 60)}`),
};

test('only the auth job and session executors/reproducers may sign in', async () => {
  const cases = [
    [job('executor', 'auth'), run('regression'), false, 'auth'],
    [job('executor', 'auth'), run(), false, 'auth'],
    [job('executor', 'execute'), run(), true, 'self'],
    [job('reproducer', 'reproduce'), run(), true, 'self'],
    [job('executor', 'execute'), run(), false, null],
    [job('executor', 'execute'), run('regression'), true, null],
    [job('reproducer', 'reproduce'), run('regression'), true, null],
    [job('explorer', 'explore'), run(), true, null],
    [job('coordinator', 'plan'), run(), true, null],
    [job('finalizer', 'finalize'), run(), true, null],
    [job('executor', 'recover'), run(), true, null],
    [job('reproducer', 'execute'), run(), true, null],
  ];
  for (const [task, current, managed, expected] of cases)
    assert.equal(
      await signInKind(coordinator(managed), noQueries, task, current),
      expected,
      `${task.role}/${task.document.summary}/${current.executionMode}/${managed}`,
    );
});

const denied = (error) => error?.code === 'POLICY_DENIED';
function leased(task, current, managed) {
  return {
    ...coordinator(managed),
    validateLease: async () => ({ job: task, run: current }),
  };
}
const scope = { projectId: randomUUID(), workerId: 'w' };
const proof = {
  taskId: randomUUID(),
  fencingToken: 1,
  leaseToken: 'x',
  contextVersion: 1,
};

test('sign-in endpoints still refuse other tasks before touching auth state', async () => {
  for (const [task, current, managed] of [
    [job('executor', 'execute'), run(), false],
    [job('executor', 'execute'), run('regression'), true],
    [job('coordinator', 'plan'), run(), true],
    [job('explorer', 'explore'), run(), true],
  ]) {
    const owner = leased(task, current, managed);
    const execution = new AuthExecutionManager(owner);
    const actions = new AuthActionsManager(owner);
    await assert.rejects(
      execution.allocateAuthSession(noQueries, scope, proof),
      denied,
    );
    await assert.rejects(
      actions.grantAuth(noQueries, scope, proof, {
        requestId: 'r',
        sessionId: randomUUID(),
        action: 'navigate_auth',
        slot: 'login_url',
      }),
      denied,
    );
    await assert.rejects(
      actions.recordAuthObservation(noQueries, scope, proof, randomUUID(), {}),
      denied,
    );
    await assert.rejects(
      actions.beginAuthExecution(
        noQueries,
        scope,
        proof,
        randomUUID(),
        randomUUID(),
      ),
      denied,
    );
  }
});

test('a session executor passes the task check and binds its own browser context', async () => {
  const task = job('executor', 'execute');
  const execution = new AuthExecutionManager(leased(task, run(), true));
  // Past the task check the profile lookup runs; without a task context the
  // self sign-in is refused before any session row is created.
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      return { rows: [] };
    },
  };
  await assert.rejects(
    execution.allocateAuthSession(client, scope, proof),
    (error) => error?.code === 'AUTH_FAILED',
  );
  assert.ok(queries.some((sql) => /auth_profile_versions/.test(sql)));
  assert.ok(
    !queries.some((sql) => /INSERT INTO auth_execution_sessions/.test(sql)),
  );
});
