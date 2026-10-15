import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continueWithoutPlannerQuestion } from '../dist/session-autonomy.js';

const ask = {
  action: 'ask',
  rationale: 'Need more context',
  question: 'Please send a password=NEVER_ECHO_THIS',
  options: ['one', 'two'],
  cases: [],
  exploreTargets: [],
  coverageGaps: [],
  title: '账号管理测试',
};
const setup = (overrides = {}) => ({
  taskIntent: 'flow',
  targetUrl: 'http://test.example/entry',
  exploredUrls: [],
  remainingPages: 2,
  activeTasks: [],
  ...overrides,
});

test('unknown goal details continue authorized discovery without human input', () => {
  const decision = continueWithoutPlannerQuestion(ask, setup());
  assert.equal(decision.action, 'dispatch');
  assert.deepEqual(decision.exploreTargets, ['http://test.example/entry']);
  assert.equal(decision.question, undefined);
  assert(!JSON.stringify(decision).includes('NEVER_ECHO_THIS'));
  assert.equal(decision.title, '账号管理测试');
});

test('already-explored target settles as a coverage gap, not repeated ask', () => {
  const decision = continueWithoutPlannerQuestion(
    ask,
    setup({
      exploredUrls: ['http://test.example/entry?secret=redacted'],
    }),
  );
  assert.equal(decision.action, 'finish');
  assert.deepEqual(decision.exploreTargets, []);
  assert.match(decision.coverageGaps.join(' '), /未验证/);
});

test('plan intent does not create browser exploration or ask', () => {
  const decision = continueWithoutPlannerQuestion(
    ask,
    setup({ taskIntent: 'plan' }),
  );
  assert.equal(decision.action, 'finish');
  assert.deepEqual(decision.exploreTargets, []);
});

test('active tests and exhausted budget do not trigger duplicate exploration', () => {
  for (const change of [
    { remainingPages: 0 },
    { activeTasks: [{ status: 'running' }] },
  ]) {
    const decision = continueWithoutPlannerQuestion(ask, setup(change));
    assert.equal(decision.action, 'finish');
  }
});

test('existing safe dispatch decisions are unchanged', () => {
  const decision = {
    action: 'dispatch',
    rationale: 'test',
    cases: [],
    exploreTargets: ['http://test.example/entry'],
    coverageGaps: [],
  };
  assert.strictEqual(
    continueWithoutPlannerQuestion(decision, setup()),
    decision,
  );
});
