// Offline verification for the Mo session follow-ups:
// 1. InputRequestBar shows the real expiresAt deadline instead of a
//    hard-coded "300 秒" wait (24h questions included).
// 2. findingDedup helpers: merged duplicates never count and fold under
//    the retained finding; orphans stay visible and flagged.
// 3. Mock fixtures cover all three: a clarification with expiresAt, a
//    duplicate pair and a re-run case with two executor tasks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputRequestDeadlineLabel } from '../src/components/session/inputDeadline.ts';
import {
  countFindings,
  findingDuplicateOf,
  groupFindings,
  isDuplicateFinding,
  mergedInto,
  orphanMergedFindings,
  visibleFindings,
} from '../src/components/session/findingDedup.ts';
import {
  mockClarificationRequest,
  mockFindings,
  mockTasks,
} from '../src/mocks/data.ts';

const finding = (overrides) => ({
  id: 'f1',
  runId: 'r1',
  caseIds: [],
  kind: 'functional',
  status: 'suspected',
  title: '缺陷',
  severity: 'medium',
  expected: 'e',
  actual: 'a',
  expectedSource: 'generic_smoke',
  reproSteps: [],
  evidenceRefs: [],
  reproductionRef: null,
  triageDisposition: 'open',
  version: 1,
  ...overrides,
});

test('inputRequestDeadlineLabel renders same-day deadlines as a bare time', () => {
  const now = new Date('2026-10-17T08:00:00+08:00');
  const label = inputRequestDeadlineLabel('2026-10-17T14:05:00+08:00', now);
  assert.match(label, /14:05/);
  assert.ok(!label.includes('10月'), 'same day must not repeat the date');
});

test('inputRequestDeadlineLabel renders a future day with month and day', () => {
  const now = new Date('2026-10-16T08:00:00+08:00');
  const label = inputRequestDeadlineLabel('2026-10-17T14:05:00+08:00', now);
  assert.match(label, /10月17日/);
  assert.match(label, /14:05/);
});

test('inputRequestDeadlineLabel never fabricates a duration', () => {
  assert.equal(inputRequestDeadlineLabel(null), '');
  assert.equal(inputRequestDeadlineLabel(''), '');
  assert.equal(inputRequestDeadlineLabel('not-a-date'), '');
});

test('duplicate findings never count towards defect totals', () => {
  const kept = finding({ id: 'f1', title: '保留' });
  const merged = finding({
    id: 'f2',
    title: '重复',
    triageDisposition: 'duplicate',
    duplicateOf: 'f1',
  });
  const plain = finding({ id: 'f3' });
  assert.equal(countFindings([kept, merged, plain]), 2);
  assert.deepEqual(
    visibleFindings([kept, merged, plain]).map((f) => f.id),
    ['f1', 'f3'],
  );
});

test('a duplicateOf pointer alone marks the finding as merged', () => {
  const merged = finding({ id: 'f2', duplicateOf: 'f1' });
  assert.equal(isDuplicateFinding(merged), true);
  assert.equal(findingDuplicateOf(merged), 'f1');
});

test('merged duplicates fold under the retained finding', () => {
  const kept = finding({ id: 'f1', title: '保留' });
  const m1 = finding({
    id: 'f2',
    triageDisposition: 'duplicate',
    duplicateOf: 'f1',
  });
  const m2 = finding({ id: 'f3', duplicateOf: 'f1' });
  const groups = groupFindings([kept, m1, m2]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].finding.id, 'f1');
  assert.deepEqual(
    mergedInto([kept, m1, m2], 'f1').map((f) => f.id),
    ['f2', 'f3'],
  );
});

test('a merged finding whose target is absent stays visible and flagged', () => {
  const orphan = finding({
    id: 'f9',
    triageDisposition: 'duplicate',
    duplicateOf: 'f-missing',
  });
  const groups = groupFindings([orphan]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].orphan, true);
  assert.deepEqual(
    orphanMergedFindings([orphan]).map((f) => f.id),
    ['f9'],
  );
});

test('mock clarification sample carries a 24h expiresAt and options', () => {
  assert.equal(mockClarificationRequest.kind, 'clarification');
  assert.ok(mockClarificationRequest.options.length >= 2);
  const waitMs =
    new Date(mockClarificationRequest.expiresAt).getTime() - Date.now();
  assert.ok(
    waitMs > 23 * 60 * 60 * 1000 && waitMs <= 24 * 60 * 60 * 1000,
    'expiresAt must be about 24 hours out',
  );
  const label = inputRequestDeadlineLabel(mockClarificationRequest.expiresAt);
  assert.ok(label.length > 0, 'the mock question shows its deadline');
});

test('mock findings include a merged duplicate pair', () => {
  const merged = mockFindings.find((f) => f.triageDisposition === 'duplicate');
  assert.ok(merged, 'mock needs a merged finding');
  assert.equal(findingDuplicateOf(merged), 'find_mock_01_calc_error');
  assert.equal(countFindings(mockFindings), mockFindings.length - 1);
});

test('mock tasks include a second execution attempt for one case', () => {
  const retried = mockTasks.filter(
    (task) =>
      task.caseId === 'case_mock_20_retried' && task.role === 'executor',
  );
  assert.equal(retried.length, 2);
  assert.deepEqual(
    retried.map((task) => task.attempt).sort((a, b) => a - b),
    [1, 2],
  );
});
