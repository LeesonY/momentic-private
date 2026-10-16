import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS } from '@localqa/domain';
import { resolveSessionBudget } from '../dist/routes/runs.js';

test('session runs start from the wider defaults and regression keeps the old ones', () => {
  const budget = resolveSessionBudget();
  assert.equal(budget.maxTotalTokens, 1500000);
  assert.equal(budget.maxModelCalls, 300);
  assert.equal(budget.maxActiveSeconds, 1800);
  assert.equal(budget.maxActionsPerCase, 24);
  for (const key of Object.keys(DEFAULT_LIMITS))
    if (
      ![
        'maxActiveSeconds',
        'maxActionsPerCase',
        'maxModelCalls',
        'maxTotalTokens',
      ].includes(key)
    )
      assert.equal(budget[key], DEFAULT_LIMITS[key], key);
  // The regression path merges DEFAULT_LIMITS unchanged.
  assert.equal(DEFAULT_LIMITS.maxTotalTokens, 300000);
  assert.equal(DEFAULT_LIMITS.maxModelCalls, 100);
  assert.equal(DEFAULT_LIMITS.maxActiveSeconds, 600);
});

test('an explicit caller budget still overrides only the fields it sets', () => {
  const budget = resolveSessionBudget({ maxTotalTokens: 400000, maxCases: 3 });
  assert.equal(budget.maxTotalTokens, 400000);
  assert.equal(budget.maxCases, 3);
  assert.equal(budget.maxModelCalls, 300);
  assert.equal(budget.maxActiveSeconds, 1800);
  assert.equal(budget.concurrency, DEFAULT_LIMITS.concurrency);
});
