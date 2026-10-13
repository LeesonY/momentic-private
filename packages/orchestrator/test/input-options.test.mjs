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

function makeContextSetup(answeredQueryRows = []) {
  const projectId = randomUUID();
  const runId = randomUUID();
  const profileId = randomUUID();

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

  let capturedQuery = null;
  const client = {
    async query(sql) {
      if (sql.includes('SELECT document FROM run_sessions')) {
        return { rows: [{ document: sessionDoc }] };
      }
      if (
        sql.includes('FROM input_requests i') &&
        sql.includes('JOIN run_events e') &&
        sql.includes('LEFT JOIN run_messages m')
      ) {
        capturedQuery = sql;
        return { rows: answeredQueryRows };
      }
      if (
        sql.includes('FROM run_messages') &&
        sql.includes('actor_id IS NOT NULL')
      ) {
        return { rows: [] };
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

  return { run, client, agent, getCapturedQuery: () => capturedQuery };
}

test('SessionContext executes single query and pairs answeredQuestions with question, options and answer', async () => {
  const answeredRows = [
    {
      document: {
        prompt: '你希望优先测试哪个业务流程？',
        options: ['流程A：登录与个人中心', '流程B：商品浏览与加购'],
      },
      redacted_text: '流程A：登录与个人中心',
    },
  ];

  const { run, client, agent, getCapturedQuery } =
    makeContextSetup(answeredRows);
  const context = await agent.context(client, run);

  assert.ok(context, 'context should not be null');
  assert.ok(
    getCapturedQuery(),
    'should execute the single query joining input_requests, run_events and run_messages',
  );
  assert.ok(getCapturedQuery().includes('ORDER BY e.seq DESC LIMIT 3'));
  assert.ok(getCapturedQuery().includes('m.created_at=e.created_at'));

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

test('SessionContext fills placeholder answer when user confirmed without text', async () => {
  const answeredRows = [
    {
      document: {
        prompt: '请确认是否继续测试当前步骤？',
        options: ['确认继续', '跳过'],
      },
      redacted_text: null, // 用户点了确认但未补充自由文本
    },
  ];

  const { run, client, agent } = makeContextSetup(answeredRows);
  const context = await agent.context(client, run);

  assert.equal(context.answeredQuestions.length, 1);
  assert.deepEqual(context.answeredQuestions[0], {
    question: '请确认是否继续测试当前步骤？',
    options: ['确认继续', '跳过'],
    answer: '（用户已确认，未补充文字）',
  });
});

test('SessionContext reverses DESC order to chronological ASC and caps at 3 items', async () => {
  // SQL 按 e.seq DESC 查出最近 3 条（时间由新到旧：Q3, Q2, Q1）
  const descRows = [
    {
      document: { prompt: '问题 3（最新）' },
      redacted_text: '答复 3',
    },
    {
      document: { prompt: '问题 2' },
      redacted_text: '答复 2',
    },
    {
      document: { prompt: '问题 1（最早）' },
      redacted_text: '答复 1',
    },
  ];

  const { run, client, agent } = makeContextSetup(descRows);
  const context = await agent.context(client, run);

  assert.equal(context.answeredQuestions.length, 3);
  // 反转后应为时间正序：Q1 -> Q2 -> Q3
  assert.equal(context.answeredQuestions[0].question, '问题 1（最早）');
  assert.equal(context.answeredQuestions[0].answer, '答复 1');
  assert.equal(context.answeredQuestions[1].question, '问题 2');
  assert.equal(context.answeredQuestions[1].answer, '答复 2');
  assert.equal(context.answeredQuestions[2].question, '问题 3（最新）');
  assert.equal(context.answeredQuestions[2].answer, '答复 3');
});
