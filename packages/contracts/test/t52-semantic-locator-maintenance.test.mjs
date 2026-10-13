import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { previewLocatorMaintenance, parseContract } from '../dist/index.js';

const baseline = {
  id: randomUUID(),
  caseId: randomUUID(),
  version: 3,
  sha256: 'a'.repeat(64),
  reviewStatus: 'approved',
  createdBy: randomUUID(),
  createdAt: new Date().toISOString(),
  reviewedBy: randomUUID(),
  reviewedAt: new Date().toISOString(),
  document: {
    id: 't52-frozen',
    schemaVersion: 1,
    kind: 'localqa/test',
    name: 'T52 DOM drift review',
    criteria: [
      {
        id: 'visible',
        kind: 'element_visible',
        description: 'Target remains visible',
        sourceKind: 'user_spec',
        sourceRef: 'T52',
      },
    ],
    steps: [
      { kind: 'navigate', url: 'https://fixture.test/regression' },
      {
        kind: 'click',
        locator: { by: 'role', value: 'button', name: 'Review details' },
      },
      { kind: 'assert', criterionId: 'visible' },
    ],
  },
};
const hint = {
  kind: 'locator_semantic_candidate',
  source: { documentId: baseline.document.id, stepIndex: 1, modulePath: [] },
  original: structuredClone(baseline.document.steps[1].locator),
  proposed: { by: 'role', value: 'button', name: 'Inspect details' },
  reasonCode: 'LOCATOR_NOT_FOUND',
  snapshotId: randomUUID(),
  pageId: randomUUID(),
  observedOrigin: 'https://fixture.test',
  reviewRequired: true,
  verification: 'not_run',
};
const record = {
  runId: randomUUID(),
  taskId: randomUUID(),
  sourceVersionId: baseline.id,
  suggestion: hint,
};
test('T52 semantic candidate preserves immutable baseline and original oracle', () => {
  assert.ok(parseContract('RepairSuggestionRecord', record));
  const before = JSON.stringify(baseline);
  const result = previewLocatorMaintenance(baseline, record);
  assert.equal(JSON.stringify(baseline), before);
  assert.deepEqual(result.before, hint.original);
  assert.deepEqual(result.after, hint.proposed);
  assert.deepEqual(result.document.steps[0], baseline.document.steps[0]);
  assert.deepEqual(result.document.steps[2], baseline.document.steps[2]);
  assert.deepEqual(result.document.criteria, baseline.document.criteria);
  assert.equal(result.document.steps[1].locator.name, 'Inspect details');
});
test('T52 manipulated case/hash/source/frame/role fails closed', () => {
  const invalid = [
    { ...record, sourceVersionId: randomUUID() },
    { ...record, suggestion: { ...hint, kind: 'locator_name_variation' } },
    {
      ...record,
      suggestion: { ...hint, source: { ...hint.source, stepIndex: 0 } },
    },
    {
      ...record,
      suggestion: {
        ...hint,
        source: {
          ...hint.source,
          modulePath: [
            { ref: 'foreign', sha256: 'a'.repeat(64), invocationStepIndex: 0 },
          ],
        },
      },
    },
    {
      ...record,
      suggestion: {
        ...hint,
        proposed: { by: 'role', value: 'link', name: 'Inspect details' },
      },
    },
    {
      ...record,
      suggestion: { ...hint, proposed: { by: 'css', value: '.unsafe' } },
    },
    { ...record, suggestion: { ...hint, verification: 'passed' } },
    {
      ...record,
      suggestion: { ...hint, observedOrigin: 'https://other.test' },
    },
    {
      ...record,
      suggestion: {
        ...hint,
        original: { ...hint.original, name: 'Another original' },
      },
    },
  ];
  for (const bad of invalid)
    assert.throws(() => previewLocatorMaintenance(baseline, bad));
  assert.throws(() =>
    previewLocatorMaintenance({ ...baseline, reviewStatus: 'draft' }, record),
  );
});
