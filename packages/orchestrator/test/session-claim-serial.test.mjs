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
} = {}) {
  const fixture = sessionFixture({ executionMode });
  const authProfileId = randomUUID();
  fixture.run.auth_profile_id = authProfileId;
  fixture.run.effectiveConfig.authProfileVersion = 1;
  const record = fixture.addCase('not_run', {
    ...(requiresLogin !== undefined ? { requiresLogin } : {}),
  });
  const task = fixture.addJob(record.definition.id, {
    status: 'queued',
    attempt: 1,
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
      const blockedByExclusive =
        Boolean(busyHolder) &&
        isSession &&
        sharingPolicy === 'exclusive_run' &&
        task.role === 'executor' &&
        task.document.summary === 'execute' &&
        needsLogin &&
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
