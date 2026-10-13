import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewLocatorMaintenance } from '../src/components/saved-cases/locatorMaintenanceDraft.ts';

const baseline = () => ({
  id: 'source-v1',
  reviewStatus: 'approved',
  document: {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: 'checkout',
    name: 'Checkout',
    variables: { BASE_URL: 'https://fixture.test/' },
    criteria: [
      {
        id: 'order-ok',
        kind: 'text_equals',
        expectedValue: 'Order complete',
      },
    ],
    steps: [
      { kind: 'navigate', url: 'https://fixture.test/checkout' },
      {
        kind: 'click',
        locator: { by: 'role', value: 'button', name: 'Complete Order' },
      },
      { kind: 'assert', criterionId: 'order-ok' },
    ],
    fixtureRefs: [],
  },
});
const hint = () => ({
  taskId: 'task-A',
  runId: 'run-A',
  sourceVersionId: 'source-v1',
  suggestion: {
    kind: 'locator_name_variation',
    source: { documentId: 'checkout', stepIndex: 1, modulePath: [] },
    original: { by: 'role', value: 'button', name: 'Complete Order' },
    proposed: { by: 'role', value: 'button', name: 'COMPLETE ORDER' },
    reasonCode: 'LOCATOR_NOT_FOUND',
    snapshotId: 'snapshot-A',
    pageId: 'page-A',
    observedOrigin: 'https://fixture.test',
    reviewRequired: true,
    verification: 'not_run',
  },
});

test('approved hint proposes exactly one locator edit, preserving all business oracles and source', () => {
  const original = baseline();
  const result = previewLocatorMaintenance(original, hint());
  assert.deepEqual(result.before, original.document.steps[1].locator);
  assert.equal(result.document.steps[1].locator.name, 'COMPLETE ORDER');
  assert.deepEqual(
    result.document.criteria,
    original.document.criteria,
    'frozen business oracle cannot change',
  );
  assert.deepEqual(result.document.steps[0], original.document.steps[0]);
  assert.deepEqual(result.document.steps[2], original.document.steps[2]);
  assert.deepEqual(result.document.variables, original.document.variables);
  assert.deepEqual(result.document.fixtureRefs, original.document.fixtureRefs);
  assert.equal(
    original.document.steps[1].locator.name,
    'Complete Order',
    'approved source must remain immutable',
  );
});

test('wrong approval, frozen source, module, step, selector or origin all fail closed', () => {
  for (const altered of [
    (v, _r) => (v.reviewStatus = 'draft'),
    (_v, r) => (r.sourceVersionId = 'other-version'),
    (_v, r) => (r.suggestion.source.documentId = 'other-document'),
    (_v, r) => (r.suggestion.source.stepIndex = 2),
    (_v, r) => (r.suggestion.source.modulePath = [{ ref: 'external@1' }]),
    (_v, r) => (r.suggestion.original.name = 'Different'),
    (_v, r) => (r.suggestion.proposed.value = 'link'),
    (_v, r) => (r.suggestion.proposed.name = 'Pay $100'),
    (_v, r) => (r.suggestion.observedOrigin = 'https://other.test'),
    (_v, r) => (r.suggestion.reviewRequired = false),
    (_v, r) => (r.suggestion.verification = 'passed'),
    (_v, r) => (r.suggestion.reasonCode = 'LOCATOR_NOT_UNIQUE'),
  ]) {
    const v = baseline();
    const r = hint();
    altered(v, r);
    assert.throws(() => previewLocatorMaintenance(v, r), /不能自动生成/);
  }
});

test('typing must not be redirected to a clickable control from a label', () => {
  const approved = baseline();
  approved.document.steps[1] = {
    kind: 'type_text',
    locator: { by: 'label', value: 'Complete Order' },
    text: 'example',
  };
  const record = hint();
  record.suggestion.original = { by: 'label', value: 'Complete Order' };
  record.suggestion.proposed = {
    by: 'role',
    value: 'button',
    name: 'COMPLETE ORDER',
  };
  assert.throws(
    () => previewLocatorMaintenance(approved, record),
    /不能自动生成/,
  );
  record.suggestion.proposed.value = 'textbox';
  const preview = previewLocatorMaintenance(approved, record);
  assert.equal(preview.document.steps[1].locator.value, 'textbox');
});

test('a location suggestion must never replace a business assertion or navigate step', () => {
  for (const stepIndex of [0, 2]) {
    const record = hint();
    record.suggestion.source.stepIndex = stepIndex;
    record.suggestion.original =
      baseline().document.steps[stepIndex].locator ??
      record.suggestion.original;
    assert.throws(
      () => previewLocatorMaintenance(baseline(), record),
      /不能自动生成/,
    );
  }
});
