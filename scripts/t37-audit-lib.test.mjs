import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditT36 } from './t36-audit-lib.mjs';

const record = (overrides = {}) => ({
  campaign: 'T37',
  provider: 'moan2',
  configuredModel: 'MiniMax-M3',
  flowId: 'support-priority',
  pageStructure: 'reloaded_same_origin_iframe_confirmation',
  id: 'unique1',
  variant: 'healthy',
  classification: 'TN',
  passed: true,
  approvedActions: true,
  verdicts: ['passed'],
  providerRequestsObserved: 3,
  settledModelRequestsObserved: 3,
  tokens: { source: 'reported', input: 100, output: 40 },
  ...overrides,
});

test('T37 independent audit partitions T37 from unchanged historical T36', () => {
  const result = auditT36(
    [
      record(),
      record({
        id: 'unique2',
        variant: 'faulty',
        classification: 'execution_failure',
        passed: false,
        diagnosticReason: 'MODEL_TIMEOUT',
        tokens: null,
        providerRequestsObserved: 2,
        settledModelRequestsObserved: 1,
      }),
    ],
    'T37',
  );
  assert.equal(result.source, 'T37-g3-moan2-business.ndjson');
  assert.equal(result.campaign, 'T37');
  assert.equal(result.samples, 2);
  assert.equal(result.complete, 1);
  assert.equal(result.incomplete, 1);
  assert.equal(result.knownUsage.observedProviderRequestsLowerBound, 5);
  assert.equal(result.knownUsage.observedSettlementsLowerBound, 4);
  assert.equal(result.knownUsage.tokenRows, 1);
  assert.equal(result.formalG3Approved, false);
  assert.throws(() => auditT36([record()], 'T36'), /T36_INVALID_LEDGER/);
});

test('T37 audit rejects forged confirmed product Finding or mixed model provenance', () => {
  for (const invalid of [
    record({ configuredModel: 'unknown' }),
    record({ campaign: 'T36' }),
    record({
      classification: 'TP',
      variant: 'faulty',
      verdicts: ['issue_found'],
    }),
    record({ approvedActions: false }),
  ])
    assert.throws(() => auditT36([invalid], 'T37'), /T36_INVALID_LEDGER/);
  assert.throws(
    () => auditT36([record(), record()], 'T37'),
    /T36_INVALID_LEDGER/,
  );
});
