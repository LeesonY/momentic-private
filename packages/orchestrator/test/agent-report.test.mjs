// Mo-style case reports: the executing agent's report is the verdict. The
// server only bounds and cleans it; a missing report is never a pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_REPORT_SCHEMA,
  parseAgentReport,
  verdictFromReport,
} from '../dist/agent-report.js';

const blocked = {
  status: 'blocked',
  summary: '页面提示：用户名或密码错误，没能进入商品详情。',
  verified: [],
  gaps: ['账号 B 被拒绝，商品名称和价格未验证。'],
  criteria: [
    { criterionId: 'login_ok', result: 'failed', reason: '登录被拒' },
    { criterionId: 'detail_ok', result: 'maybe', reason: '没走到' },
  ],
  bug: null,
};

test('the report schema requires every field, so strict providers accept it', () => {
  assert.deepEqual(AGENT_REPORT_SCHEMA.required, [
    'status',
    'summary',
    'verified',
    'gaps',
    'criteria',
    'bug',
  ]);
});

test('an agent report becomes the verdict as submitted', () => {
  const report = parseAgentReport(blocked);
  assert.equal(report.status, 'blocked');
  // An unknown per-criterion result is kept as unknown, never as a pass.
  assert.deepEqual(
    report.criteria.map((item) => item.result),
    ['failed', 'unknown'],
  );
  const verdict = verdictFromReport(report);
  assert.equal(verdict.status, 'blocked');
  assert.equal(verdict.reasonCode, 'AGENT_BLOCKED');
  assert.equal(verdict.summary, blocked.summary);
  assert.deepEqual(verdict.gaps, blocked.gaps);
  // A server-side reason code (for example a blocked sign-in) is kept.
  assert.equal(
    verdictFromReport(report, 'LOGIN_BLOCKED').reasonCode,
    'LOGIN_BLOCKED',
  );
});

test('an issue report carries the bug the agent saw', () => {
  const report = parseAgentReport({
    ...blocked,
    status: 'issue_found',
    bug: { title: '购物车角标不更新', expected: '显示 1', actual: '仍为空' },
  });
  assert.equal(verdictFromReport(report).status, 'issue_found');
  assert.equal(report.bug.title, '购物车角标不更新');
  assert.equal(parseAgentReport({ ...blocked, bug: { title: '' } }).bug, null);
});

test('a missing or malformed report is inconclusive, never passed', () => {
  for (const value of [null, 'passed', [], { status: 'ok' }, {}]) {
    assert.equal(parseAgentReport(value), null);
    assert.equal(
      verdictFromReport(parseAgentReport(value)).status,
      'inconclusive',
    );
  }
});

test('report text is bounded and cleaned', () => {
  const report = parseAgentReport({
    ...blocked,
    summary: `  多余\n\n空白 ${'很长'.repeat(2000)}`,
    gaps: Array.from({ length: 50 }, (_, i) => `缺口 ${i}`),
  });
  assert.ok(report.summary.startsWith('多余 空白'));
  assert.ok(report.summary.length <= 2000);
  assert.equal(report.gaps.length, 30);
});
