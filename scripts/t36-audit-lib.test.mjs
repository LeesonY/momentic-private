import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditT36 } from './t36-audit-lib.mjs';

const fixture = (overrides = {}) => ({
  campaign: 'T36',
  provider: 'moan2',
  configuredModel: 'MiniMax-M3',
  flowId: 'support-priority',
  pageStructure: 'reloaded_same_origin_iframe_confirmation',
  id: 'id1',
  batch: 'batch1',
  variant: 'healthy',
  classification: 'TN',
  passed: true,
  verdicts: ['passed'],
  approvedActions: true,
  providerRequestsObserved: 3,
  settledModelRequestsObserved: 3,
  tokens: { source: 'reported', input: 100, output: 40 },
  ...overrides,
});

test('T36 audit preserves failed request denominator and distinguishes unknown token spending', () => {
  const audit = auditT36([
    fixture(),
    fixture({
      id: 'id2',
      variant: 'faulty',
      classification: 'execution_failure',
      passed: false,
      verdicts: ['blocked'],
      diagnosticReason: 'MODEL_TIMEOUT',
      providerRequestsObserved: 2,
      settledModelRequestsObserved: 1,
      tokens: null,
    }),
  ]);
  assert.equal(audit.samples, 2);
  assert.equal(audit.complete, 1);
  assert.equal(audit.incomplete, 1);
  assert.deepEqual(audit.seededFault, { confirmed: 0, total: 1 });
  assert.equal(audit.knownUsage.observedProviderRequestsLowerBound, 5);
  assert.equal(audit.knownUsage.observedSettlementsLowerBound, 4);
  assert.equal(audit.knownUsage.tokenRows, 1);
  assert.equal(audit.knownUsage.commercialCost, null);
  assert.equal(audit.formalG3Approved, false);
});

test('T36 audit rejects mixed campaign/provider, fabricated TP and duplicate accepted case', () => {
  for (const bad of [
    fixture({ campaign: 'T35' }),
    fixture({ provider: 'deepseek' }),
    fixture({ pageStructure: 'simple_form' }),
    fixture({ passed: false }),
    fixture({ variant: 'faulty', classification: 'TN' }),
    fixture({
      variant: 'faulty',
      classification: 'TP',
      verdicts: ['issue_found'],
    }),
  ])
    assert.throws(() => auditT36([bad]), /T36_INVALID_LEDGER/);
  assert.throws(() => auditT36([fixture(), fixture()]), /T36_INVALID_LEDGER/);
});
