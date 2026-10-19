import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  graceDeadline,
  graceEligibleRun,
  REPRODUCTION_BUDGET_GRACE_SECONDS,
} from '../dist/reproduction-grace.js';

const now = new Date('2026-10-18T00:00:00Z');
const run = (overrides = {}) => ({
  executionMode: 'smoke',
  status: 'running',
  effectiveConfig: { budget: { maxActiveSeconds: 1800 } },
  budgetUsed: { activeSeconds: 1800 },
  ...overrides,
});

test('time grace is exactly 180 seconds, reduced by already-observed overrun including fractional carry', () => {
  assert.equal(REPRODUCTION_BUDGET_GRACE_SECONDS, 180);
  assert.equal(
    Date.parse(graceDeadline(1800, 1800, now)) - now.getTime(),
    180_000,
  );
  assert.equal(
    Date.parse(graceDeadline(1840.25, 1800, now)) - now.getTime(),
    139_750,
  );
  assert.ok(Date.parse(graceDeadline(1981, 1800, now)) < now.getTime());
});

test('only a running smoke run at its time limit is eligible, never regression or user cancellation', () => {
  assert.equal(graceEligibleRun(run()), true);
  for (const status of ['cancelling', 'completed', 'failed', 'awaiting_input'])
    assert.equal(graceEligibleRun(run({ status })), false);
  assert.equal(graceEligibleRun(run({ executionMode: 'regression' })), false);
  assert.equal(
    graceEligibleRun(run({ budgetUsed: { activeSeconds: 1799 } })),
    false,
  );
});
