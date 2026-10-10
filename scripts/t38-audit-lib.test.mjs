import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditT36 } from './t36-audit-lib.mjs';

const record = (change = {}) => ({
  id: 'valid-id',
  campaign: 'T38',
  provider: 'moan2',
  configuredModel: 'MiniMax-M3',
  flowId: 'support-priority',
  pageStructure: 'reloaded_same_origin_iframe_confirmation',
  variant: 'healthy',
  classification: 'TN',
  passed: true,
  approvedActions: true,
  verdicts: ['passed'],
  providerRequestsObserved: 3,
  settledModelRequestsObserved: 3,
  tokens: { source: 'reported', input: 120, output: 40 },
  ...change,
});
test('T38 provider-isolated failure and unknown billing retained, not pooled with historical T37', () => {
  const audit = auditT36(
    [
      record(),
      record({
        id: 'another-id',
        variant: 'faulty',
        classification: 'execution_failure',
        passed: false,
        diagnosticReason: 'MODEL_TIMEOUT',
        providerRequestsObserved: 2,
        settledModelRequestsObserved: 1,
        tokens: null,
      }),
    ],
    'T38',
  );
  assert.equal(audit.samples, 2);
  assert.equal(audit.complete, 1);
  assert.equal(audit.incomplete, 1);
  assert.equal(audit.knownUsage.observedProviderRequestsLowerBound, 5);
  assert.equal(audit.knownUsage.observedSettlementsLowerBound, 4);
  assert.equal(audit.formalG3Approved, false);
  assert.throws(() => auditT36([record()], 'T37'), /T36_INVALID_LEDGER/);
});
test('T38 audit rejects forgery, wrong provenance and identical IDs', () => {
  for (const r of [
    record({ provider: 'deepseek' }),
    record({ pageStructure: 'unapproved' }),
    record({
      variant: 'faulty',
      classification: 'TP',
      verdicts: ['issue_found'],
    }),
    record({ approvedActions: false }),
  ])
    assert.throws(() => auditT36([r], 'T38'), /T36_INVALID_LEDGER/);
  assert.throws(
    () => auditT36([record(), record()], 'T38'),
    /T36_INVALID_LEDGER/,
  );
});
