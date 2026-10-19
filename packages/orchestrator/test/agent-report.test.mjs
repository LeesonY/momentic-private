// Mo-style case reports: the executing agent's report is the verdict. The
// server only bounds and cleans it; a missing report is never a pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_REPORT_SCHEMA,
  parseAgentReport,
  verdictFromReport,
} from '../dist/agent-report.js';
import {
  mapReproductionRecording,
  parseReproStepActions,
} from '../dist/reproduction-recording.js';
import { cleanDecisionNote } from '../dist/decision-note.js';
import { DECISION_SCHEMA } from '@localqa/agents';
import { createRequire } from 'node:module';
const Ajv = createRequire(
  new URL('../../model-gateway/package.json', import.meta.url),
)('ajv');

const at = (seconds) =>
  new Date(Date.UTC(2026, 9, 16, 12, 0, seconds)).toISOString();
const recordingInput = (overrides = {}) => ({
  kind: 'functional',
  outcome: 'reproduced',
  reproductionId: 'repro-1',
  taskId: 'reproducer-1',
  recording: {
    taskId: 'reproducer-1',
    status: 'available',
    rrwebArtifactId: 'rrweb-1',
    startedAt: at(0),
    endedAt: at(60),
  },
  steps: [
    { taskId: 'reproducer-1', seq: 2, createdAt: at(10), finishedAt: at(12) },
    { taskId: 'reproducer-1', seq: 5, createdAt: at(30), finishedAt: at(35) },
  ],
  anchors: [
    { index: 1, seq: 2 },
    { index: 2, seq: 5 },
  ],
  reproStepCount: 2,
  ...overrides,
});

test('reproducer anchors accept actual task seq values, including several steps at one action', () => {
  assert.deepEqual(
    parseReproStepActions(
      [
        { index: 1, seq: 2 },
        { index: 2, seq: 2 },
      ],
      2,
      [{ seq: 2 }],
    ),
    [
      { index: 1, seq: 2 },
      { index: 2, seq: 2 },
    ],
  );
});

test('out-of-range, missing, duplicate and backwards anchors are discarded independently', () => {
  const input = [
    null,
    { index: 0, seq: 2 },
    { index: 1, seq: 2 },
    { index: 2, seq: 1 },
    { index: 2, seq: 999 },
    { index: 1, seq: 5 },
    { index: 2, seq: 5 },
    { index: 3, seq: 5 },
  ];
  assert.deepEqual(parseReproStepActions(input, 2, [{ seq: 2 }, { seq: 5 }]), [
    { index: 1, seq: 2 },
    { index: 2, seq: 5 },
  ]);
  for (const value of [undefined, null, {}, 'bad', []])
    assert.deepEqual(parseReproStepActions(value), []);
});

test('bad optional anchors do not invalidate an otherwise useful agent report', () => {
  const report = parseAgentReport({
    ...blocked,
    reproStepActions: [null, { index: 1, seq: 2 }, { index: 2, seq: -1 }],
  });
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.reproStepActions, [{ index: 1, seq: 2 }]);
  assert.equal(parseAgentReport(blocked).reproStepActions, undefined);
  const validate = new Ajv({ strict: false }).compile(AGENT_REPORT_SCHEMA);
  assert.equal(
    validate({
      ...blocked,
      criteria: [],
      reproStepActions: [null, { seq: 'bad' }],
    }),
    true,
  );
});

test('recording anchors map finishedAt and add bounded three-second context', () => {
  assert.deepEqual(mapReproductionRecording(recordingInput()), {
    reproductionId: 'repro-1',
    taskId: 'reproducer-1',
    startedAt: at(7),
    endedAt: at(38),
    steps: [
      { index: 1, at: at(12) },
      { index: 2, at: at(35) },
    ],
  });
  const input = recordingInput();
  input.steps[0].createdAt = at(1);
  input.steps[1].finishedAt = at(59);
  assert.equal(mapReproductionRecording(input).startedAt, at(0));
  assert.equal(mapReproductionRecording(input).endedAt, at(60));
});

test('no anchors uses the full recording and missing finishedAt falls back to createdAt', () => {
  const input = recordingInput({ anchors: undefined });
  assert.deepEqual(mapReproductionRecording(input), {
    reproductionId: 'repro-1',
    taskId: 'reproducer-1',
    startedAt: at(0),
    endedAt: at(60),
    steps: [],
  });
  input.anchors = [{ index: 1, seq: 2 }];
  input.steps[0].finishedAt = null;
  assert.deepEqual(mapReproductionRecording(input).steps, [
    { index: 1, at: at(10) },
  ]);
});

test('static, unconfirmed, missing and unusable recordings never produce a replay link', () => {
  for (const override of [
    { kind: 'static' },
    { outcome: 'blocked' },
    { outcome: 'not_reproduced' },
    { recording: null },
  ])
    assert.equal(mapReproductionRecording(recordingInput(override)), null);
  const original = recordingInput().recording;
  for (const patch of [
    { status: 'missing' },
    { status: 'recording' },
    { status: 'degraded', rrwebArtifactId: null },
    { taskId: 'executor-1' },
    { startedAt: null },
    { endedAt: 'bad' },
    { endedAt: at(-1) },
  ])
    assert.equal(
      mapReproductionRecording(
        recordingInput({ recording: { ...original, ...patch } }),
      ),
      null,
    );
  assert.ok(
    mapReproductionRecording(
      recordingInput({ recording: { ...original, status: 'degraded' } }),
    ),
  );
});

test('anchors from another task or outside the recording are not fabricated', () => {
  const input = recordingInput();
  input.steps[0].taskId = 'executor-1';
  input.steps[1].finishedAt = at(70);
  const result = mapReproductionRecording(input);
  assert.deepEqual(result.steps, []);
  assert.equal(result.startedAt, at(0));
  assert.equal(result.endedAt, at(60));
});

test('the decision note is required for the model but never rejects a decision; long text is truncated', () => {
  // The model is told to annotate every decision (the activity list shows it)…
  assert.ok(DECISION_SCHEMA.required.includes('note'));
  // …and `note: null` is allowed so the gateway can fill a missing note rather
  // than repair or discard an otherwise valid decision (model-gateway
  // decision-note.test.mjs).
  assert.deepEqual(DECISION_SCHEMA.properties.note.type, ['string', 'null']);
  // No maxLength: an overlong note is truncated before persistence.
  assert.equal(DECISION_SCHEMA.properties.note.maxLength, undefined);
  assert.equal(cleanDecisionNote(undefined, []), null);
  assert.equal(cleanDecisionNote('', []), null);
  assert.equal(cleanDecisionNote({ note: 'bad' }, []), null);
  assert.equal(
    cleanDecisionNote('  先检查  错误提示\n再继续。 ', []),
    '先检查 错误提示 再继续。',
  );
  assert.equal(Array.from(cleanDecisionNote('字'.repeat(800), [])).length, 300);
});

test('saved credentials discard the entire note, including a match beyond the truncation boundary', () => {
  const saved = ['fixture-private-value'];
  for (const note of [
    'fixture-private-value',
    '尝试 fixture-private-value 后观察',
    '字'.repeat(800) + saved[0],
  ])
    assert.equal(cleanDecisionNote(note, saved), null);
  assert.equal(
    cleanDecisionNote('不包含保存值的目的说明。', saved),
    '不包含保存值的目的说明。',
  );
});

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

test('existing verdict fields stay required while replay anchors remain optional', () => {
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
