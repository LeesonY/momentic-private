import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { getValidator } from '@localqa/contracts';
import { Worker } from '../../../apps/worker/dist/index.js';
import { sessionModelContext } from '../dist/session-schemas.js';
import { retrySessionCases } from '../dist/session-retries.js';
import { ConfigurationRepository } from '@localqa/storage';
import { authProfileFixture } from './fixtures/auth-profile.mjs';
import { Coordinator, MAX_SELF_SIGN_IN_ACTIONS } from '../dist/index.js';

/** Real reserve/settle methods over a SQL-aware ledger, not a mocked grant. */
function signInBudgetLedger(fixture) {
  const reservations = new Map();
  const budget = {
    limits: fixture.run.effectiveConfig.budget,
    used: { activeSeconds: 0, actions: 0, modelCalls: 0, reproductions: 0, totalTokens: 0 },
    reserved: {},
  };
  const rows = (items = []) => ({ rows: items, rowCount: items.length });
  const query = fixture.client.query.bind(fixture.client);
  fixture.client.query = async (sql, params = []) => {
    if (sql.includes('SELECT * FROM budget_reservations'))
      return rows([...reservations.values()].filter((r) => r.request_id === params[1]));
    if (sql.includes('SELECT br.* FROM budget_reservations'))
      return rows(reservations.has(params[1]) ? [reservations.get(params[1])] : []);
    if (sql.includes('SELECT * FROM run_budgets')) return rows([budget]);
    if (sql.includes('INSERT INTO budget_reservations')) {
      reservations.set(params[0], { id: params[0], run_id: params[2], task_id: params[3],
        request_id: params[4], fencing_token: String(params[5]), reserved: params[7], status: 'reserved' });
      return rows();
    }
    if (sql.includes('UPDATE run_budgets SET reserved')) {
      budget.reserved = params[1]; return rows();
    }
    if (sql.includes('UPDATE run_budgets SET used')) {
      budget.used = params[1]; budget.reserved = params[2]; return rows();
    }
    if (sql.includes('UPDATE budget_reservations SET status')) {
      Object.assign(reservations.get(params[0]), { status: params[1], charged: params[2] });
      return rows();
    }
    if (sql.includes('SELECT id,run_id FROM jobs'))
      return rows([{ id: fixture.task.id, run_id: fixture.run.id }]);
    if (sql.includes('SELECT id FROM runs')) return rows([{ id: fixture.run.id }]);
    if (sql.includes('UPDATE model_requests')) return rows();
    if (sql.includes('SELECT id, reservation_id, outcome, result_hash'))
      return rows(fixture.auth.intents.has(params[0]) ? [fixture.auth.intents.get(params[0])] : []);
    if (sql.includes('SELECT p.id, p.revoked'))
      return rows([{ id: fixture.auth.profileId, revoked: false }]);
    if (sql.includes('UPDATE action_intents') && sql.includes("execution_state = 'completed'")) {
      Object.assign(fixture.auth.intents.get(params[0]), { outcome: params[1], result_hash: params[2], execution_state: 'completed' });
      return rows();
    }
    if (sql.includes('SELECT id, document FROM steps WHERE action_id')) return rows();
    return query(sql, params);
  };
  fixture.coordinator.reserve = Coordinator.prototype.reserve;
  return { budget, reservations };
}

for (const [role, stage] of [['executor', 'execute'], ['reproducer', 'reproduce'], ['explorer', 'explore']]) {
  test(`${role} self-sign-in reserves and settles zero shared actions, including failures/unknowns`, async () => {
    for (const status of ['succeeded', 'failed', 'unknown', 'cancelled']) {
      const fixture = authProfileFixture();
      if (role === 'explorer') fixture.bindTask(fixture.addJob(null, { role, stage, status: 'running' }));
      else fixture.selectTask(role, stage);
      const { budget, reservations } = signInBudgetLedger(fixture);
      // Even an exhausted *shared* action budget must not block private login.
      budget.used.actions = budget.limits.maxActions;
      const binding = await fixture.coordinator.allocateAuthSession(fixture.scope, fixture.proof);
      fixture.auth.sessions.get(binding.sessionId).status = 'active';
      const permit = await fixture.coordinator.authActions.grantAuth(fixture.client, fixture.scope, fixture.proof, {
        sessionId: binding.sessionId, requestId: randomUUID(), action: 'navigate_auth', slot: 'login_url',
      });
      assert.deepEqual([...reservations.values()][0].reserved, {});
      const intent = fixture.auth.intents.get(permit.grantId);
      Object.assign(intent, { execution_state: 'started', execution_id: randomUUID() });
      await fixture.coordinator.authActions.recordAuth(fixture.client, fixture.scope, fixture.proof,
        binding.sessionId, permit.grantId, { executionId: intent.execution_id }, { status });
      assert.equal(budget.used.actions, budget.limits.maxActions);
      assert.deepEqual(budget.reserved, {});
      assert.deepEqual([...reservations.values()][0].charged, {});
      assert.equal(intent.execution_state, 'completed');
      // The persisted auth intent/step was not removed to get zero accounting.
      assert.ok(fixture.auth.queries.some(({ sql }) => sql.includes('INSERT INTO steps')));
    }
  });
}

test('private sign-in has its own serialized 20-action cap and fails without another reservation', async () => {
  const fixture = authProfileFixture();
  const { reservations } = signInBudgetLedger(fixture);
  const binding = await fixture.coordinator.allocateAuthSession(fixture.scope, fixture.proof);
  fixture.auth.sessions.get(binding.sessionId).status = 'active';
  for (let i = 0; i < MAX_SELF_SIGN_IN_ACTIONS; i++)
    await fixture.coordinator.authActions.grantAuth(fixture.client, fixture.scope, fixture.proof, {
      sessionId: binding.sessionId, requestId: randomUUID(), action: 'navigate_auth', slot: 'login_url',
    });
  assert.equal(reservations.size, 20);
  await assert.rejects(fixture.coordinator.authActions.grantAuth(fixture.client, fixture.scope, fixture.proof, {
    sessionId: binding.sessionId, requestId: randomUUID(), action: 'navigate_auth', slot: 'login_url',
  }), (error) => error.code === 'AUTH_FAILED');
  assert.equal(reservations.size, 20);
  assert.equal(fixture.auth.intents.size, 20);
});

test('login intents do not consume maxActionsPerCase; the first actual case action does', async () => {
  const fixture = authProfileFixture();
  const { reservations } = signInBudgetLedger(fixture);
  fixture.run.effectiveConfig.budget.maxActionsPerCase = 1;
  const binding = await fixture.coordinator.allocateAuthSession(fixture.scope, fixture.proof);
  const session = fixture.auth.sessions.get(binding.sessionId);
  session.status = 'active';
  for (let i = 0; i < 4; i++)
    await fixture.coordinator.authActions.grantAuth(fixture.client, fixture.scope, fixture.proof, {
      sessionId: binding.sessionId, requestId: randomUUID(), action: 'navigate_auth', slot: 'login_url',
    });
  Object.assign(session, { status: 'ended', end_reason: 'signed_in' });
  const grant = await fixture.coordinator.grantAction(fixture.scope, fixture.proof, { name: 'observe', args: {} });
  assert.equal(grant.call.name, 'observe');
  assert.equal([...reservations.values()].filter((r) => r.reserved.actions === 1).length, 1);
  await assert.rejects(fixture.coordinator.grantAction(fixture.scope, fixture.proof, { name: 'observe', args: {} }),
    (error) => error.code === 'CASE_ACTION_LIMIT');
});

test('ordinary run-level auth keeps its original action accounting', async () => {
  const fixture = authProfileFixture({ managed: false, executionMode: 'regression' });
  fixture.selectTask('executor', 'auth');
  const { budget, reservations } = signInBudgetLedger(fixture);
  const binding = await fixture.coordinator.allocateAuthSession(fixture.scope, fixture.proof);
  fixture.auth.sessions.get(binding.sessionId).status = 'active';
  const permit = await fixture.coordinator.authActions.grantAuth(fixture.client, fixture.scope, fixture.proof, {
    sessionId: binding.sessionId, requestId: randomUUID(), action: 'navigate_auth', slot: 'login_url',
  });
  assert.deepEqual([...reservations.values()][0].reserved, { actions: 1 });
  const intent = fixture.auth.intents.get(permit.grantId);
  Object.assign(intent, { execution_state: 'started', execution_id: randomUUID() });
  await fixture.coordinator.authActions.recordAuth(fixture.client, fixture.scope, fixture.proof,
    binding.sessionId, permit.grantId, { executionId: intent.execution_id }, { status: 'succeeded' });
  assert.equal(budget.used.actions, 1);
});

const changedProfile = (fixture, version = 2, patch = {}) => {
  const old = fixture.auth.versions.get(1);
  fixture.auth.head = version;
  fixture.auth.versions.set(version, {
    ...old,
    document: { ...old.document, version, ...patch },
    secret_id: randomUUID(),
    material: { username: 'new-user', password: 'new-password' },
  });
};
const authFailed = (error) => error?.code === 'AUTH_FAILED';

test('updating only account/password creates a new profile version bound to a new secret', async () => {
  const fixture = authProfileFixture();
  const queries = [];
  const old = fixture.auth.versions.get(1);
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('SELECT CASE WHEN is_admin()'))
        return { rows: [{ role: 'admin' }] };
      if (sql.includes('SELECT v.document FROM auth_profiles'))
        return { rows: [{ document: old.document }] };
      if (sql.includes('SELECT secret_id,secret_version'))
        return { rows: [old] };
      return { rows: [], rowCount: 1 };
    },
  };
  const vault = {
    encrypt: () => ({
      ciphertext: Buffer.from('encrypted'),
      nonce: Buffer.alloc(12),
      authTag: Buffer.alloc(16),
      keyVersion: 1,
    }),
  };
  const repository = new ConfigurationRepository(
    { actor: async (_actor, fn) => fn(client) },
    vault,
  );
  const updated = await repository.updateAuthProfile(
    { userId: fixture.run.creatorId },
    fixture.run.projectId,
    fixture.auth.profileId,
    {
      expectedVersion: 1,
      secretInput: { username: 'new-user', password: 'new-password' },
    },
  );
  assert.equal(updated.version, 2);
  assert.equal(old.document.version, 1);
  const inserted = queries.find(({ sql }) =>
    sql.includes('INSERT INTO auth_profile_versions'),
  );
  assert.equal(inserted.params[2], 2);
  assert.notEqual(inserted.params[5], old.secret_id);
  assert.equal(inserted.params[6], 1);
  assert.ok(
    queries.some(({ sql }) =>
      sql.includes('UPDATE auth_profiles SET version=version+1'),
    ),
  );
  assert.ok(queries.some(({ sql }) => sql.includes('INSERT INTO secrets')));
  assert.ok(
    queries.some(({ sql }) => sql.includes('INSERT INTO secret_versions')),
  );
  assert.equal(JSON.stringify(updated).includes('new-password'), false);
});

test('session self sign-in selects the latest same-profile version and records it once', async () => {
  const fixture = authProfileFixture();
  changedProfile(fixture);
  assert.equal(
    (await fixture.coordinator.authProfile(fixture.scope, fixture.proof))
      .version,
    2,
  );
  assert.equal(
    (
      await fixture.coordinator.authProfile(
        fixture.scope,
        fixture.proof,
        'frozen',
      )
    ).version,
    1,
  );
  const binding = await fixture.coordinator.allocateAuthSession(
    fixture.scope,
    fixture.proof,
  );
  assert.equal(binding.profileId, fixture.auth.profileId);
  assert.equal(binding.profileVersion, 2);
  assert.equal(binding.contextId, fixture.task.result.authContextId);
  assert.equal(fixture.run.effectiveConfig.authProfileVersion, 1);
  assert.deepEqual(fixture.auth.events, [
    {
      type: 'auth.profile_version_changed',
      payload: {
        taskId: fixture.task.id,
        authProfileId: fixture.auth.profileId,
        frozenVersion: 1,
        selectedVersion: 2,
      },
    },
  ]);
  changedProfile(fixture, 3);
  assert.equal(
    (await fixture.coordinator.authProfile(fixture.scope, fixture.proof))
      .version,
    2,
  );
  assert.equal(
    (
      await fixture.coordinator.allocateAuthSession(
        fixture.scope,
        fixture.proof,
      )
    ).sessionId,
    binding.sessionId,
  );
  assert.equal(fixture.auth.events.length, 1);
});

test('retrying a blocked case uses updated material despite the old run auth scope version', async () => {
  const fixture = authProfileFixture();
  const first = await fixture.coordinator.allocateAuthSession(
    fixture.scope,
    fixture.proof,
  );
  assert.equal(first.profileVersion, 1);
  assert.deepEqual(fixture.auth.events, []);
  const definition = fixture.state.cases.get(fixture.task.case_id);
  fixture.addAttempt(definition, { job: fixture.task, outcome: 'blocked' });
  fixture.task.status = 'succeeded';
  fixture.auth.sessions.get(first.sessionId).status = 'ended';
  const record = fixture.currentCase(definition);
  const retries = await retrySessionCases(
    fixture.client,
    fixture.coordinator,
    fixture.run,
    [record],
    [record.definition.id],
  );
  assert.deepEqual(retries.caseIds, [record.definition.id]);
  const retryTask = fixture.state.enqueued[0];
  retryTask.status = 'running';
  fixture.bindTask(retryTask);
  changedProfile(fixture);
  const work = await fixture.coordinator.work(fixture.scope, fixture.proof);
  assert.equal(work.signIn, true);
  const retry = await fixture.coordinator.allocateAuthSession(
    fixture.scope,
    fixture.proof,
  );
  assert.equal(retry.profileVersion, 2);
  assert.equal(fixture.auth.scope.auth_profile_version, 1);
  assert.equal(fixture.auth.scope.auth_epoch, 1);
  const session = fixture.auth.sessions.get(retry.sessionId);
  session.status = 'active';
  const material = await fixture.coordinator.authStateService.authMaterial(
    fixture.client,
    fixture.scope,
    fixture.proof,
    retry.sessionId,
  );
  assert.deepEqual(material.material, {
    username: 'new-user',
    password: 'new-password',
  });
  changedProfile(fixture, 3);
  fixture.auth.versions.get(3).material.password = 'third-password';
  const pinned = await fixture.coordinator.authStateService.authMaterial(
    fixture.client,
    fixture.scope,
    fixture.proof,
    retry.sessionId,
  );
  assert.equal(pinned.material.password, 'new-password');
});

test('regression and non-session smoke auth jobs keep frozen profile and credentials', async () => {
  for (const executionMode of ['regression', 'smoke']) {
    const fixture = authProfileFixture({ managed: false, executionMode });
    fixture.selectTask('executor', 'auth');
    changedProfile(fixture);
    assert.equal(
      (await fixture.coordinator.authProfile(fixture.scope, fixture.proof))
        .version,
      1,
    );
    const binding = await fixture.coordinator.allocateAuthSession(
      fixture.scope,
      fixture.proof,
    );
    assert.equal(binding.profileVersion, 1);
    fixture.auth.sessions.get(binding.sessionId).status = 'active';
    const material = await fixture.coordinator.authStateService.authMaterial(
      fixture.client,
      fixture.scope,
      fixture.proof,
      binding.sessionId,
    );
    assert.equal(material.material.password, 'old-password');
    const permit = await fixture.coordinator.authActions.grantAuth(
      fixture.client,
      fixture.scope,
      fixture.proof,
      {
        sessionId: binding.sessionId,
        requestId: randomUUID(),
        action: 'navigate_auth',
        slot: 'login_url',
      },
    );
    assert.equal(permit.profileVersion, 1);
    const metadata = fixture.auth.queries.find(({ sql }) =>
      sql.includes(
        'SELECT r.auth_profile_id, v.version AS auth_profile_version',
      ),
    );
    assert.equal(metadata.params[2], false);
    await fixture.coordinator.authActions.beginAuthExecution(
      fixture.client,
      fixture.scope,
      fixture.proof,
      binding.sessionId,
      permit.grantId,
    );
    assert.deepEqual(fixture.auth.events, []);
  }
});

test('self sign-in permits and private executions use the session version, not the run or newer head', async () => {
  const fixture = authProfileFixture();
  changedProfile(fixture, 2, { sharingPolicy: 'exclusive_run' });
  const binding = await fixture.coordinator.allocateAuthSession(
    fixture.scope,
    fixture.proof,
  );
  fixture.auth.sessions.get(binding.sessionId).status = 'active';
  changedProfile(fixture, 3);
  const permit = await fixture.coordinator.authActions.grantAuth(
    fixture.client,
    fixture.scope,
    fixture.proof,
    {
      sessionId: binding.sessionId,
      requestId: randomUUID(),
      action: 'navigate_auth',
      slot: 'login_url',
    },
  );
  assert.equal(permit.profileVersion, 2);
  assert.equal(permit.url, 'https://fixture.test/login');
  const metadataQuery = fixture.auth.queries.find(({ sql }) =>
    sql.includes('SELECT r.auth_profile_id, v.version AS auth_profile_version'),
  );
  assert.equal(metadataQuery.params[2], true);
  const receipt = await fixture.coordinator.authActions.beginAuthExecution(
    fixture.client,
    fixture.scope,
    fixture.proof,
    binding.sessionId,
    permit.grantId,
  );
  assert.ok(receipt.executionId);
  const lockCheck = fixture.auth.queries.find(({ sql }) =>
    sql.includes('SELECT 1 FROM auth_profile_run_locks'),
  );
  assert.equal(lockCheck.params[3], binding.sessionId);
});

test('successful self-sign-in browser grants validate the exact pinned version and context', async () => {
  const fixture = authProfileFixture();
  changedProfile(fixture);
  const binding = await fixture.coordinator.allocateAuthSession(
    fixture.scope,
    fixture.proof,
  );
  const session = fixture.auth.sessions.get(binding.sessionId);
  Object.assign(session, { status: 'ended', end_reason: 'signed_in' });
  changedProfile(fixture, 3);
  fixture.coordinator.reserve = async () => {
    throw Error('authorization-passed');
  };
  await assert.rejects(
    fixture.coordinator.grantAction(fixture.scope, fixture.proof, {
      name: 'observe',
      args: {},
    }),
    /authorization-passed/,
  );
  const gate = fixture.auth.queries.find(({ sql }) =>
    sql.includes('FROM auth_success_gates g'),
  );
  assert.equal(gate.params[6], 2);
  assert.equal(gate.params[4], fixture.task.result.authContextId);
  fixture.auth.scope.auth_epoch++;
  await assert.rejects(
    fixture.coordinator.grantAction(fixture.scope, fixture.proof, {
      name: 'observe',
      args: {},
    }),
    authFailed,
  );
  fixture.auth.scope.auth_epoch--;
  fixture.auth.scope.status = 'revoked';
  await assert.rejects(
    fixture.coordinator.grantAction(fixture.scope, fixture.proof, {
      name: 'observe',
      args: {},
    }),
    authFailed,
  );
  fixture.auth.scope.status = 'initializing';
  session.context_id = randomUUID();
  await assert.rejects(
    fixture.coordinator.grantAction(fixture.scope, fixture.proof, {
      name: 'observe',
      args: {},
    }),
    authFailed,
  );
});

test('version-change events validate their bounded metadata payload, never secrets', () => {
  const event = {
    schemaVersion: 1,
    id: '1',
    seq: 1,
    runId: randomUUID(),
    at: new Date().toISOString(),
    type: 'auth.profile_version_changed',
    payload: {
      taskId: randomUUID(),
      authProfileId: randomUUID(),
      frozenVersion: 1,
      selectedVersion: 2,
    },
  };
  assert.ok(getValidator('RunEvent')(event));
  for (const patch of [
    { selectedVersion: 0 },
    { selectedVersion: '2' },
    { password: 'secret' },
  ])
    assert.equal(
      getValidator('RunEvent')({
        ...event,
        payload: { ...event.payload, ...patch },
      }),
      false,
    );
  assert.equal(getValidator('RunEvent')({ ...event, payload: {} }), false);
});

test('revoked, deleted and non-active profiles block the case without failing the session run', async () => {
  for (const unavailable of ['revoked', 'deleted', 'non-active']) {
    const fixture = authProfileFixture();
    changedProfile(fixture);
    if (unavailable === 'revoked') fixture.auth.revoked = true;
    if (unavailable === 'deleted') fixture.auth.deleted = true;
    if (unavailable === 'non-active')
      fixture.auth.versions.get(2).document.status = 'revoked';
    const work = await fixture.coordinator.work(fixture.scope, fixture.proof);
    assert.equal(work.signIn, true);
    assert.equal(work.authStateId, null);
    assert.equal('loginBlocked' in work, false);
    await assert.rejects(
      fixture.coordinator.authProfile(fixture.scope, fixture.proof),
      authFailed,
    );
    await assert.rejects(
      fixture.coordinator.allocateAuthSession(fixture.scope, fixture.proof),
      authFailed,
    );
    assert.equal(fixture.auth.sessions.size, 0);
    assert.deepEqual(fixture.auth.events, []);
    const worker = new Worker({
      runtime: {
        finish: (...args) => fixture.coordinator.finish(fixture.scope, ...args),
      },
      browser: {},
      scratch: '.',
    });
    const detail =
      '登录未成功，没有执行：登录配置不可用，请在环境与认证中更新。';
    await worker.reportBlocked(fixture.proof, work, 'AUTH_FAILED', detail);
    assert.equal(fixture.run.status, 'running');
    assert.equal(fixture.run.terminationReason, null);
    const context = await fixture.agent.context(fixture.client, fixture.run);
    const report = sessionModelContext(context).cases[0].report;
    assert.equal(report.status, 'blocked');
    assert.equal(report.summary, detail);
    assert.deepEqual(report.gaps, [detail]);
  }
});

test('profile version selection still refuses other IDs, projects, environments and origins', async () => {
  for (const patch of [
    { id: randomUUID() },
    { projectId: randomUUID() },
    { environmentId: randomUUID() },
    { allowedOrigins: ['https://outside.test'] },
  ]) {
    const fixture = authProfileFixture();
    changedProfile(fixture, 2, patch);
    await assert.rejects(
      fixture.coordinator.authProfile(fixture.scope, fixture.proof),
      (error) => ['AUTH_FAILED', 'TARGET_NOT_ALLOWED'].includes(error?.code),
    );
    await assert.rejects(
      fixture.coordinator.allocateAuthSession(fixture.scope, fixture.proof),
      (error) => ['AUTH_FAILED', 'TARGET_NOT_ALLOWED'].includes(error?.code),
    );
    assert.equal(fixture.auth.sessions.size, 0);
  }
});

test('reproducer self sign-in uses the latest version; an unrelated task cannot borrow its pinned session', async () => {
  const fixture = authProfileFixture();
  fixture.selectTask('reproducer', 'reproduce');
  changedProfile(fixture);
  const binding = await fixture.coordinator.allocateAuthSession(
    fixture.scope,
    fixture.proof,
  );
  assert.equal(binding.profileVersion, 2);
  changedProfile(fixture, 3);
  fixture.selectTask();
  assert.equal(
    (await fixture.coordinator.authProfile(fixture.scope, fixture.proof))
      .version,
    3,
  );
  const next = await fixture.coordinator.allocateAuthSession(
    fixture.scope,
    fixture.proof,
  );
  assert.equal(next.profileVersion, 3);
  assert.equal(fixture.auth.events.length, 2);
});

test('allocation rechecks an edit under the profile lock and never silently uses stale metadata', async () => {
  const fixture = authProfileFixture();
  changedProfile(fixture);
  fixture.auth.onProfileLock = () => changedProfile(fixture, 3);
  await assert.rejects(
    fixture.coordinator.allocateAuthSession(fixture.scope, fixture.proof),
    authFailed,
  );
  assert.equal(fixture.auth.sessions.size, 0);
  assert.equal(fixture.auth.scope, null);
  assert.deepEqual(fixture.auth.events, []);
});

test('self sign-in still cannot capture reusable auth state after selecting a newer version', async () => {
  const fixture = authProfileFixture();
  changedProfile(fixture);
  const binding = await fixture.coordinator.allocateAuthSession(
    fixture.scope,
    fixture.proof,
  );
  fixture.auth.sessions.get(binding.sessionId).status = 'active';
  await assert.rejects(
    fixture.coordinator.authStateService.issueCaptureGrant(
      fixture.client,
      fixture.scope,
      fixture.proof,
      binding.sessionId,
      randomUUID(),
    ),
    (error) => error?.code === 'POLICY_DENIED',
  );
});
test('revocation after allocation denies material, permits and ordinary browser grants', async () => {
  for (const unavailable of ['revoked', 'non-active']) {
    const fixture = authProfileFixture();
    changedProfile(fixture);
    const binding = await fixture.coordinator.allocateAuthSession(
      fixture.scope,
      fixture.proof,
    );
    fixture.auth.sessions.get(binding.sessionId).status = 'active';
    if (unavailable === 'revoked') fixture.auth.revoked = true;
    else fixture.auth.versions.get(2).document.status = 'revoked';
    await assert.rejects(
      fixture.coordinator.authStateService.authMaterial(
        fixture.client,
        fixture.scope,
        fixture.proof,
        binding.sessionId,
      ),
      authFailed,
    );
    await assert.rejects(
      fixture.coordinator.authActions.grantAuth(
        fixture.client,
        fixture.scope,
        fixture.proof,
        {
          sessionId: binding.sessionId,
          requestId: randomUUID(),
          action: 'navigate_auth',
          slot: 'login_url',
        },
      ),
      authFailed,
    );
    // A permit issued before the revocation must not start afterwards.
    const grantId = randomUUID();
    fixture.auth.intents.set(grantId, {
      id: grantId,
      auth_session_id: binding.sessionId,
      auth_epoch: binding.authEpoch,
      fencing_token: '1',
      context_version: fixture.run.contextVersion,
      execution_state: 'issued',
    });
    await assert.rejects(
      fixture.coordinator.authActions.beginAuthExecution(
        fixture.client,
        fixture.scope,
        fixture.proof,
        binding.sessionId,
        grantId,
      ),
      authFailed,
    );
    await assert.rejects(
      fixture.coordinator.grantAction(fixture.scope, fixture.proof, {
        name: 'observe',
        args: {},
      }),
      authFailed,
    );
  }
});
