import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  signInKind,
  AuthExecutionManager,
  AuthActionsManager,
  Coordinator,
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

const sessionCase = {
  query: async (sql) => {
    assert.match(sql, /FROM run_cases WHERE id=\$1 AND project_id=\$2 AND run_id=\$3/);
    return { rows: [{ document: {} }] };
  },
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
      await signInKind(coordinator(managed), sessionCase, task, current),
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
      if (sql.includes('FROM run_cases')) return { rows: [{ document: {} }] };
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

function dispatcher(managed, mode = 'agent') {
  const coordinator = new Coordinator({
    db: {},
    vault: {},
    serviceActor: { userId: randomUUID() },
  });
  const events = [];
  coordinator.change = async (_client, current, status, phase) => {
    events.push(`phase:${phase}`);
    return { ...current, status, phase };
  };
  coordinator.enqueue = async (_client, _run, role, stage) => {
    events.push(`enqueue:${role}/${stage}`);
  };
  coordinator.finalize = async () => events.push('finalize');
  coordinator.startApprovedRegression = async (_client, current) => {
    events.push('regression');
    return current;
  };
  coordinator.sessions.read = async () => (managed ? session : null);
  coordinator.sessions.advance = async () => {
    events.push('session:advance');
    return true;
  };
  const profile = {
    id: randomUUID(),
    projectId: randomUUID(),
    environmentId: null,
    name: 'Account',
    mode,
    allowedOrigins: ['https://app.example.test'],
    sharingPolicy: 'exclusive_run',
    hasSecret: true,
    version: 1,
    status: 'active',
    formConfig: null,
  };
  const client = {
    query: async (sql) =>
      /auth_profile_versions/.test(sql)
        ? { rows: [{ document: profile, revoked: false }] }
        : { rows: [] },
  };
  return { coordinator, client, events };
}
const bound = (executionMode) => ({
  ...run(executionMode),
  phase: 'preflight',
  effectiveConfig: {
    allowedOrigins: ['https://app.example.test'],
    authProfileVersion: 1,
    budget: { maxCases: 1, maxPages: 1 },
  },
});

test('a login-bound session goes from preflight straight to its session agent', async () => {
  const { coordinator, client, events } = dispatcher(true);
  const updated = await coordinator.startSmokeAfterPreflight(
    client,
    bound('smoke'),
  );
  assert.equal(updated.phase, 'explore');
  assert.deepEqual(events, ['phase:auth', 'phase:explore', 'session:advance']);
  assert.ok(!events.some((event) => event.includes('/auth')));
});

test('non-session smoke and regression runs keep the run-level auth job', async () => {
  const smoke = dispatcher(false);
  await smoke.coordinator.startSmokeAfterPreflight(
    smoke.client,
    bound('smoke'),
  );
  assert.deepEqual(smoke.events, ['phase:auth', 'enqueue:executor/auth']);
  const regression = dispatcher(false);
  await regression.coordinator.startRegressionAfterPreflight(
    regression.client,
    bound('regression'),
  );
  assert.deepEqual(regression.events, ['phase:auth', 'enqueue:executor/auth']);
  const anonymous = dispatcher(false, 'none');
  await anonymous.coordinator.startRegressionAfterPreflight(
    anonymous.client,
    bound('regression'),
  );
  assert.deepEqual(anonymous.events, ['regression']);
});
