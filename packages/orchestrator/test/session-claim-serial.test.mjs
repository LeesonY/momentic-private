import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { claimTask } from '../../storage/dist/leases.js';
import { sessionFixture } from './fixtures/session.mjs';

function claimFixture({
  sharingPolicy = 'exclusive_run',
  executionMode = 'smoke',
  managed = true,
  requiresLogin = true,
  role = 'executor',
  stage = 'execute',
  signedOut = false,
} = {}) {
  const fixture = sessionFixture({ executionMode });
  const authProfileId = randomUUID();
  fixture.run.auth_profile_id = authProfileId;
  fixture.run.effectiveConfig.authProfileVersion = 1;
  const explored = role === 'explorer';
  const record = explored
    ? null
    : fixture.addCase('not_run', {
        ...(requiresLogin !== undefined ? { requiresLogin } : {}),
      });
  const task = fixture.addJob(explored ? null : record.definition.id, {
    role,
    stage,
    status: 'queued',
    attempt: 1,
    ...(explored && signedOut ? { result: { signedOut: true } } : {}),
  });
  task.available_at = new Date(Date.now() - 1000);
  const scope = { projectId: fixture.run.projectId, workerId: 'worker-1' };
  let busyHolder = null;
  const query = fixture.client.query.bind(fixture.client);

  fixture.client.query = async (sql, params = []) => {
    if (
      sql.includes(
        'SELECT j.*,r.context_version,r.status run_status FROM jobs j',
      )
    ) {
      assert.match(sql, /sharingPolicy/);
      assert.match(sql, /r.execution_mode = 'smoke'/);
      assert.match(sql, /requiresLogin/);
      assert.match(sql, /v.version = p.version/);
      const isSession = managed && executionMode === 'smoke';
      const needsLogin = requiresLogin !== false;
      // Mirrors the claim SQL: executors/reproducers of a signed-in case and
      // every explorer that was not enqueued as a signed-out target sign in
      // themselves, so they queue behind a running self-signing task.
      const signsIn = explored
        ? task.document.summary === 'explore' && task.result?.signedOut !== true
        : ['executor', 'reproducer'].includes(task.role) &&
          ['execute', 'reproduce'].includes(task.document.summary) &&
          needsLogin;
      const blockedByExclusive =
        Boolean(busyHolder) &&
        isSession &&
        sharingPolicy === 'exclusive_run' &&
        signsIn &&
        busyHolder.authProfileId === authProfileId &&
        busyHolder.needsLogin;
      if (blockedByExclusive) return { rows: [] };
      return {
        rows: [
          {
            ...task,
            context_version: fixture.run.contextVersion,
            run_status: 'running',
          },
        ],
      };
    }
    if (sql.includes('SELECT context_version,status FROM runs'))
      return {
        rows: [
          { context_version: fixture.run.contextVersion, status: 'running' },
        ],
      };
    if (sql.includes("UPDATE jobs SET status='running'")) {
      task.status = 'running';
      task.worker_id = params[1];
      task.lease_until = new Date(Date.now() + 45000);
      task.fencing_token = String(Number(task.fencing_token) + 1);
      return { rows: [task] };
    }
    if (sql.includes('INSERT INTO task_leases')) return { rows: [] };
    return query(sql, params);
  };

  const setBusyHolder = (holder) => {
    busyHolder = holder;
  };

  return { fixture, task, scope, setBusyHolder, authProfileId };
}

test('exclusive_run session tasks are held in queue while another self-signing task is running', async () => {
  const { fixture, task, scope, setBusyHolder, authProfileId } = claimFixture({
    sharingPolicy: 'exclusive_run',
  });
  setBusyHolder({ authProfileId, needsLogin: true });
  const skipped = await claimTask(fixture.client, scope, 45, {
    children: true,
    control: false,
  });
  assert.equal(skipped, null);
  assert.equal(task.status, 'queued');

  setBusyHolder(null);
  const claimed = await claimTask(fixture.client, scope, 45, {
    children: true,
    control: false,
  });
  assert.ok(claimed);
  assert.equal(claimed.task.id, task.id);
  assert.equal(task.status, 'running');
});

test('shared_state profiles can claim while another task is running', async () => {
  const { fixture, task, scope, setBusyHolder, authProfileId } = claimFixture({
    sharingPolicy: 'shared_state',
  });
  setBusyHolder({ authProfileId, needsLogin: true });
  const claimed = await claimTask(fixture.client, scope, 45, {
    children: true,
    control: false,
  });
  assert.ok(claimed);
  assert.equal(claimed.task.id, task.id);
});

test('cases with requiresLogin=false can claim immediately even if exclusive account is busy', async () => {
  const { fixture, task, scope, setBusyHolder, authProfileId } = claimFixture({
    sharingPolicy: 'exclusive_run',
    requiresLogin: false,
  });
  setBusyHolder({ authProfileId, needsLogin: true });
  const claimed = await claimTask(fixture.client, scope, 45, {
    children: true,
    control: false,
  });
  assert.ok(claimed);
  assert.equal(claimed.task.id, task.id);
});

test('regression runs ignore exclusive session serialization at claim time', async () => {
  const { fixture, task, scope, setBusyHolder, authProfileId } = claimFixture({
    sharingPolicy: 'exclusive_run',
    executionMode: 'regression',
    managed: false,
  });
  setBusyHolder({ authProfileId, needsLogin: true });
  const claimed = await claimTask(fixture.client, scope, 45, {
    children: true,
    control: false,
  });
  assert.ok(claimed);
  assert.equal(claimed.task.id, task.id);
});

test('a signed-in exploration queues behind a running self-signing task', async () => {
  const { fixture, task, scope, setBusyHolder, authProfileId } = claimFixture({
    role: 'explorer',
    stage: 'explore',
  });
  setBusyHolder({ authProfileId, needsLogin: true });
  assert.equal(
    await claimTask(fixture.client, scope, 45, {
      children: true,
      control: false,
    }),
    null,
  );
  assert.equal(task.status, 'queued');
  setBusyHolder(null);
  const claimed = await claimTask(fixture.client, scope, 45, {
    children: true,
    control: false,
  });
  assert.equal(claimed?.task.id, task.id);
});

test('a signed-out exploration never waits for the exclusive account', async () => {
  const { fixture, task, scope, setBusyHolder, authProfileId } = claimFixture({
    role: 'explorer',
    stage: 'explore',
    signedOut: true,
  });
  setBusyHolder({ authProfileId, needsLogin: true });
  const claimed = await claimTask(fixture.client, scope, 45, {
    children: true,
    control: false,
  });
  assert.equal(claimed?.task.id, task.id);
});

test('an executor queues behind a running signed-in exploration', async () => {
  const { fixture, task, scope, setBusyHolder, authProfileId } = claimFixture({
    role: 'executor',
    stage: 'execute',
  });
  // The holder is the explorer that signed in; both share the account.
  setBusyHolder({ authProfileId, needsLogin: true });
  assert.equal(
    await claimTask(fixture.client, scope, 45, {
      children: true,
      control: false,
    }),
    null,
  );
  assert.equal(task.status, 'queued');
  // A holder that explored signed out does not hold the account.
  setBusyHolder({ authProfileId, needsLogin: false });
  const claimed = await claimTask(fixture.client, scope, 45, {
    children: true,
    control: false,
  });
  assert.equal(claimed?.task.id, task.id);
});
