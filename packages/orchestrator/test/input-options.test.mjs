import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Coordinator } from '../dist/core.js';
import { RuntimeClient } from '../dist/runtime.js';
import { SessionAgent } from '../dist/session-agent.js';
import { sessionModelContext } from '../dist/session-schemas.js';
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

test('SessionContext and sessionModelContext include answeredQuestions with question, options and answer', async () => {
  const projectId = randomUUID();
  const runId = randomUUID();
  const profileId = randomUUID();
  const inputId = randomUUID();

  const run = {
    id: runId,
    projectId,
    phase: 'plan',
    contextVersion: 1,
    targetUrl: 'https://fixture.test/',
    effectiveConfig: {
      allowedOrigins: ['https://fixture.test'],
      actionPolicy: 'non_submitting',
      taskIntent: 'flow',
      budget: { maxCases: 5, maxPages: 5, concurrency: 1 },
      models: {
        assertion: { profileId, version: 1 },
      },
    },
  };

  const sessionDoc = {
    objective: '测试目标流程',
    round: 1,
    status: 'planning',
    plan: '',
    caseIds: [],
    exploredUrls: [],
    coverageGaps: [],
    summary: '',
    history: [],
  };

  const resolvedInput = {
    id: inputId,
    kind: 'clarification',
    runId,
    prompt: '你希望优先测试哪个业务流程？',
    status: 'resolved',
    options: ['流程A：登录与个人中心', '流程B：商品浏览与加购'],
    version: 2,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };

  const answerMessage = {
    id: randomUUID(),
    redacted_text: '流程A：登录与个人中心',
    created_at: new Date(),
  };

  const client = {
    async query(sql) {
      if (sql.includes('SELECT document FROM run_sessions')) {
        return { rows: [{ document: sessionDoc }] };
      }
      if (
        sql.includes('FROM run_messages') &&
        sql.includes('actor_id IS NOT NULL')
      ) {
        return { rows: [answerMessage] };
      }
      if (
        sql.includes('FROM input_requests') &&
        sql.includes("status'='resolved'")
      ) {
        return { rows: [{ id: inputId, document: resolvedInput }] };
      }
      if (sql.includes('FROM run_messages m') && sql.includes('run_events e')) {
        return { rows: [{ redacted_text: answerMessage.redacted_text }] };
      }
      if (sql.includes('FROM run_knowledge_bindings')) {
        return { rows: [] };
      }
      if (sql.includes('FROM page_snapshots')) {
        return { rows: [] };
      }
      if (sql.includes('FROM run_cases')) {
        return { rows: [] };
      }
      if (sql.includes('FROM findings')) {
        return { rows: [] };
      }
      if (sql.includes('FROM jobs WHERE') && sql.includes('status IN')) {
        return { rows: [] };
      }
      if (sql.includes('FROM model_profile_versions')) {
        return {
          rows: [
            {
              document: {
                id: profileId,
                name: 'test-model',
                endpoint: 'https://model.test/v1',
                configuredModelId: 'test-model',
                adapter: 'openai_compatible',
                dataBoundary: 'internal',
                capabilities: {
                  structuredOutput: true,
                  nativeTools: true,
                  imageInput: false,
                },
                status: 'ready',
                version: 1,
              },
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const coordinator = new Coordinator({
    db: {},
    vault: {},
    serviceActor: { userId: randomUUID() },
  });
  const agent = new SessionAgent(coordinator);

  const context = await agent.context(client, run);
  assert.ok(context, 'context should not be null');
  assert.equal(context.answeredQuestions.length, 1);
  assert.deepEqual(context.answeredQuestions[0], {
    question: '你希望优先测试哪个业务流程？',
    options: ['流程A：登录与个人中心', '流程B：商品浏览与加购'],
    answer: '流程A：登录与个人中心',
  });

  // 验证 sessionModelContext 将 answeredQuestions 传给模型
  const modelContext = sessionModelContext(context);
  assert.ok(Array.isArray(modelContext.answeredQuestions));
  assert.equal(modelContext.answeredQuestions.length, 1);
  assert.deepEqual(modelContext.answeredQuestions[0], {
    question: '你希望优先测试哪个业务流程？',
    options: ['流程A：登录与个人中心', '流程B：商品浏览与加购'],
    answer: '流程A：登录与个人中心',
  });
});
