import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Coordinator } from '../dist/core.js';
import { RuntimeClient } from '../dist/runtime.js';
import { parseContract } from '@localqa/contracts';

test('waitForInput preserves options in input_requests document and event', async () => {
  const projectId = randomUUID();
  const runId = randomUUID();
  const taskId = randomUUID();
  const workerId = randomUUID();
  const leaseToken = randomUUID();

  let insertedDoc = null;
  let emittedEvent = null;

  const client = {
    async query(sql, params) {
      if (sql.includes('SELECT j.* FROM jobs j')) {
        return {
          rows: [
            {
              id: taskId,
              project_id: projectId,
              run_id: runId,
              worker_id: workerId,
              fencing_token: '1',
              status: 'running',
              document: { summary: 'plan' },
              result: { stage: 'plan' },
            },
          ],
        };
      }
      if (sql.includes('SELECT id FROM runs')) {
        return { rows: [{ id: runId }] };
      }
      if (sql.includes('SELECT event_seq FROM runs')) {
        return { rows: [{ event_seq: '0' }] };
      }
      if (sql.includes('UPDATE runs SET event_seq')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO input_requests')) {
        insertedDoc = params[3];
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO run_events')) {
        emittedEvent = { type: params[3], payload: params[4] };
        return { rows: [] };
      }
      if (sql.includes('UPDATE jobs SET')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE runs SET')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE task_leases SET')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const coordinator = new Coordinator({
    db: {},
    vault: {},
    serviceActor: { userId: randomUUID() },
  });
  coordinator.tx = async (fn) => fn(client);
  coordinator.validateLease = async () => ({
    job: { id: taskId, run_id: runId },
    run: { id: runId, projectId, status: 'running', phase: 'plan' },
  });
  coordinator.protectedOrigins = [];
  coordinator.pulse = async () => {};
  coordinator.change = async (_client, run, status, phase) => ({
    ...run,
    status,
    phase,
  });
  coordinator.releaseSlots = async () => {};

  const scope = { projectId, workerId };
  const proof = { taskId, fencingToken: 1, leaseToken, contextVersion: 1 };

  const options = ['继续执行冒烟', '补充登录信息', '跳过此流程'];
  const req = await coordinator.waitForInput(
    scope,
    proof,
    'clarification',
    '请选择接下来的操作',
    300000,
    options,
  );

  assert.deepEqual(req.options, options);
  assert.ok(insertedDoc, 'input_requests should have an inserted document');
  assert.deepEqual(insertedDoc.options, options);
  assert.equal(emittedEvent?.type, 'input.requested');
  assert.deepEqual(emittedEvent?.payload?.options, options);
});

test('TaskRuntime input method forwards options to coordinator', async () => {
  let forwardedOptions = null;
  const mockCoordinator = {
    async waitForInput(_scope, _proof, _kind, _prompt, _expiresMs, options) {
      forwardedOptions = options;
      return parseContract('InputRequest', {
        id: randomUUID(),
        runId: randomUUID(),
        kind: 'clarification',
        status: 'pending',
        prompt: '测试',
        expiresAt: new Date().toISOString(),
        version: 1,
        ...(options?.length ? { options } : {}),
      });
    },
  };

  const runtime = new RuntimeClient(mockCoordinator, {
    projectId: randomUUID(),
    workerId: randomUUID(),
  });

  const proof = {
    taskId: randomUUID(),
    fencingToken: 1,
    leaseToken: 'token',
    contextVersion: 1,
  };

  await runtime.input(proof, 'clarification', '问题内容', 300000, [
    '选项1',
    '选项2',
  ]);

  assert.deepEqual(forwardedOptions, ['选项1', '选项2']);
});
