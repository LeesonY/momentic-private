import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishPermissionLockedQuestion } from '../dist/session-permission.js';
import { Worker } from '../dist/index.js';

const ask = (question) => ({
  action: 'ask',
  rationale: 'Need info',
  cases: [],
  exploreTargets: [],
  coverageGaps: [],
  question,
});

test('frozen read-only run cannot enter a repeated write-authorization question', () => {
  const out = finishPermissionLockedQuestion(
    'non_submitting',
    ask(
      '当前 actionPolicy=non_submitting、writeScope 为空，是否授权创建账号？',
    ),
  );
  assert.equal(out.action, 'finish');
  assert.deepEqual(out.cases, []);
  assert.deepEqual(out.exploreTargets, []);
  assert.ok(out.coverageGaps.join(' ').includes('non_submitting'));
  assert.equal('question' in out, false);
});

test('frozen writing run may ask legitimate questions; read-only may ask for expected result', () => {
  const question = ask('预期的页面标题是什么？');
  assert.equal(
    finishPermissionLockedQuestion('non_submitting', question),
    null,
  );
  assert.equal(
    finishPermissionLockedQuestion(
      'approved_workflows',
      ask('是否授予提交权限？'),
    ),
    null,
  );
});

test('real Worker planner settles a locked write-permission ask, never creates an input request', async () => {
  const calls = [];
  const runtime = {
    async claim() {
      return {
        task: { id: 'plan-task', role: 'coordinator' },
        fencingToken: 1,
        leaseToken: 'fixture',
        contextVersion: 1,
      };
    },
    async work() {
      return {
        stage: 'plan',
        run: {
          targetUrl: 'http://fixture.local/',
          effectiveConfig: {
            allowedOrigins: ['http://fixture.local'],
            actionPolicy: 'non_submitting',
          },
        },
        session: {
          session: {
            objective: '测试新建账号',
            plan: '',
            history: [],
            coverageGaps: [],
            summary: '',
          },
          targetUrl: 'http://fixture.local/',
          login: { status: 'none', reasonCode: null, detail: null },
          actionPolicy: 'non_submitting',
          taskIntent: 'flow',
          writeScope: [],
          assertionCapabilities: {},
          remainingCases: 1,
          remainingPages: 1,
          concurrency: 1,
          activeTasks: [],
          sources: [],
          observations: [],
          cases: [],
          findings: [],
        },
      };
    },
    async model() {
      calls.push('model');
      return {
        requestResult: 'ok',
        data: ask(
          '当前 actionPolicy=non_submitting、writeScope 为空，请确认写入授权？',
        ),
      };
    },
    async input() {
      calls.push('input');
      throw Error('not allowed to ask for frozen permission');
    },
    async finish(_proof, outcome) {
      calls.push(outcome);
    },
    async heartbeat() {
      return { contextVersion: 1, cancelRequested: false };
    },
  };
  const worker = new Worker({
    runtime,
    browser: {},
    scratch: '.',
    heartbeatMs: 10000,
  });
  assert.equal(await worker.once(), true);
  assert.equal(calls[0], 'model');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].stage, 'plan');
  assert.equal(calls[1].decision.action, 'finish');
  assert.equal(calls[1].decision.coverageGaps.length, 1);
});
