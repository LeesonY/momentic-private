import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditT35 } from './t35-g3-audit.mjs';

function record(overrides = {}) {
  return {
    campaign: 'T35',
    provider: 'moan2',
    configuredModel: 'MiniMax-M3',
    flowId: 'support-priority',
    pageStructure: 'same_origin_iframe_async_confirmation',
    variant: 'healthy',
    classification: 'TN',
    passed: true,
    id: 'a',
    batch: 'batch1',
    providerRequestsObserved: 3,
    settledModelRequestsObserved: 3,
    tokens: { source: 'reported', input: 500, output: 120 },
    ...overrides,
  };
}

test('T35 audit retains failed sessions and their observed provider calls, never zeros missing billing', () => {
  const result = auditT35([
    record(),
    record({
      id: 'b',
      variant: 'faulty',
      classification: 'execution_failure',
      passed: false,
      diagnosticReason: 'MODEL_TIMEOUT',
      providerRequestsObserved: 2,
      settledModelRequestsObserved: 1,
      tokens: null,
    }),
  ]);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.complete, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.healthy, { correct: 1, total: 1 });
  assert.deepEqual(result.seededFault, { confirmed: 0, total: 1 });
  assert.equal(result.reasons.MODEL_TIMEOUT, 1);
  assert.equal(result.usage.observedProviderRequestsLowerBound, 5);
  assert.equal(result.usage.observedSettledRequestsLowerBound, 4);
  assert.equal(result.usage.reportedTokenRows, 1);
  assert.equal(result.usage.vendorInvoice, null);
  assert.equal(result.formalG3Approved, false);
});

test('T35 audit excludes mismatched providers, false positive attribution and duplicate rows', () => {
  for (const invalid of [
    record({ provider: 'deepseek' }),
    record({ campaign: 'T34' }),
    record({ variant: 'faulty', classification: 'TN' }),
    record({ flowId: 'unapproved' }),
    record({ pageStructure: 'simple_form' }),
    record({ passed: false }),
  ])
    assert.throws(() => auditT35([invalid]), /T35_LEDGER_INVALID/);
  assert.throws(() => auditT35([record(), record()]), /T35_LEDGER_INVALID/);
});
