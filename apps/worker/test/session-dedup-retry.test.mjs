import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from '../dist/index.js';
import { RuntimeClient } from '@localqa/orchestrator';
import { SESSION_AGENT_PROMPT } from '@localqa/agents';
import { getValidator } from '@localqa/contracts';
import {
  proposal,
  sessionFixture,
} from '../../../packages/orchestrator/test/fixtures/session.mjs';

async function workerFixture(decision, stage = 'plan') {
  const fixture = sessionFixture();
  const record = fixture.addCase('blocked');
  const root = fixture.addFinding(record);
  const duplicate = fixture.addFinding(record, {
    triageDisposition: 'duplicate',
    duplicateOf: root.id,
  });
  const context = await fixture.agent.context(fixture.client, fixture.run);
  const requests = [],
    finished = [],
    inputs = [],
    stops = [];
  const runtime = {
    claim: async () => ({
      task: fixture.manager.document,
      fencingToken: 1,
      leaseToken: 'fixture',
      contextVersion: 1,
    }),
    work: async () => ({ stage, run: fixture.run, session: context }),
    model: async (_proof, role, payload) => {
      requests.push({ role, payload });
      return {
        requestResult: 'ok',
        data:
          typeof decision === 'function'
            ? decision(record, root, duplicate)
            : decision,
      };
    },
    finish: async (_proof, result) => finished.push(result),
    input: async (...args) => {
      inputs.push(args);
      return fixture.coordinator.waitForInput(
        { projectId: fixture.run.projectId, workerId: 'fixture-worker' },
        ...args,
      );
    },
    stop: async (_proof, reason) => stops.push(reason),
  };
  const worker = new Worker({
    runtime,
    browser: {},
    scratch: '.',
    heartbeatMs: 10000,
  });
  return {
    ...fixture,
    record,
    root,
    duplicate,
    requests,
    finished,
    inputs,
    stops,
    worker,
  };
}

test('RuntimeClient forwards a session decision alongside the clarification prompt and options', async () => {
  const fixture = sessionFixture();
  let forwarded;
  const coordinator = {
    waitForInput: async (...args) => {
      forwarded = args;
      return {};
    },
  };
  const runtime = new RuntimeClient(coordinator, {
    projectId: fixture.run.projectId,
    workerId: 'fixture-worker',
  });
  const decision = proposal({
    action: 'ask',
    question: '请确认账号',
    duplicateFindings: [],
    retryCaseIds: [],
  });
  const proof = {
    taskId: fixture.manager.id,
    fencingToken: 1,
    leaseToken: 'fixture',
    contextVersion: 1,
  };
  await runtime.input(
    proof,
    'clarification',
    decision.question,
    300000,
    ['账号已修正'],
    decision,
  );
  assert.equal(forwarded[6], decision);
  assert.deepEqual(forwarded[5], ['账号已修正']);
  assert.equal(forwarded[1], proof);
});

test('worker planner sends the shared dedup/retry prompt and preserves both decision fields on finish', async () => {
  const fixture = await workerFixture((record, root, duplicate) =>
    proposal({
      retryCaseIds: [record.definition.id],
      duplicateFindings: [
        { findingId: duplicate.id, sameAs: root.id, reason: '同一问题' },
      ],
    }),
  );
  assert.equal(await fixture.worker.once(), true);
  assert.deepEqual(fixture.stops, []);
  const payload = fixture.requests[0].payload;
  assert.equal(payload.messages[0].content[0].text, SESSION_AGENT_PROMPT);
  const context = JSON.parse(payload.messages[1].content[0].text);
  assert.equal(context.cases[0].retryCount, 0);
  assert.equal(context.caseRetryLimit, 3);
  assert.equal(context.findings[1].duplicateOf, fixture.root.id);
  assert.deepEqual(fixture.finished[0].decision.retryCaseIds, [
    fixture.record.definition.id,
  ]);
  assert.equal(
    fixture.finished[0].decision.duplicateFindings[0].sameAs,
    fixture.root.id,
  );
});

test('worker asks with the entire decision so the server can merge findings before waiting', async () => {
  const fixture = await workerFixture((_record, root) =>
    proposal({
      action: 'ask',
      question: '请确认测试账号已修正',
      options: ['账号正确，请重试', '稍后处理'],
      duplicateFindings: [
        { findingId: 'invalid', sameAs: root.id, reason: '忽略这条' },
      ],
    }),
  );
  assert.equal(await fixture.worker.once(), true);
  assert.deepEqual(fixture.stops, []);
  assert.equal(fixture.inputs.length, 1);
  assert.equal(fixture.inputs[0][5].action, 'ask');
  assert.equal(
    fixture.inputs[0][5].duplicateFindings[0].findingId,
    'invalid',
    'original invalid entry reaches the server for an explicit note',
  );
  assert.equal(fixture.state.session.status, 'reviewing');
  assert.ok(
    fixture.state.session.coverageGaps.some((gap) =>
      gap.includes('格式无效，已忽略'),
    ),
  );
  assert.deepEqual(fixture.state.inputs[0].options, [
    '账号正确，请重试',
    '稍后处理',
  ]);
  assert.equal(fixture.finished.length, 0);
});

test('permission-locked ask-to-finish downgrade retains finding reviews and does not execute retry IDs', async () => {
  const fixture = await workerFixture((record, root, duplicate) =>
    proposal({
      action: 'ask',
      question: '请开启提交权限，允许业务操作？',
      duplicateFindings: [
        { findingId: duplicate.id, sameAs: root.id, reason: '同一问题' },
      ],
      retryCaseIds: [record.definition.id],
    }),
  );
  await fixture.worker.once();
  assert.deepEqual(fixture.stops, []);
  assert.equal(fixture.inputs.length, 0);
  assert.equal(fixture.finished.length, 1);
  const decision = fixture.finished[0].decision;
  assert.equal(decision.action, 'finish');
  assert.equal(decision.duplicateFindings[0].sameAs, fixture.root.id);
  assert.ok(getValidator('SessionDecision')(decision));
  assert.equal(fixture.state.enqueued.length, 0);
});

test('worker summary context excludes duplicate findings and asks for latest execution results', async () => {
  const fixture = await workerFixture(
    { overview: '执行受阻，需要有效账号', caseComments: [], coverageGaps: [] },
    'finalize',
  );
  await fixture.worker.once();
  assert.deepEqual(fixture.stops, []);
  assert.equal(fixture.requests[0].role, 'finalizer');
  const context = JSON.parse(
    fixture.requests[0].payload.messages[1].content[0].text,
  );
  assert.equal(context.findings.length, 1);
  assert.equal(context.findings[0].id, fixture.root.id);
  assert.equal(context.findingCount, 1);
  assert.match(
    fixture.requests[0].payload.messages[0].content[0].text,
    /最近一次执行尝试/,
  );
  assert.equal(fixture.finished[0].stage, 'finalize');
});
