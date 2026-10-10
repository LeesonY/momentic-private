import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  browserActionsWithinApprovedBounds,
  modelRequestsWithinApprovedBounds,
} from './t32-model-request-bounds.mjs';

function record(count, extra = {}) {
  return {
    providerCalls: count,
    recordedModelCalls: count,
    settledCalls: count,
    ...extra,
  };
}

test('T32 fixed approved one-step and one-time model-format-repair upper bounds', () => {
  for (const calls of [2, 3, 4, 5, 6, 7, 8])
    assert.equal(modelRequestsWithinApprovedBounds(record(calls), false), true);
  for (const calls of [4, 5, 6, 8, 11, 16])
    assert.equal(modelRequestsWithinApprovedBounds(record(calls), true), true);
  for (const calls of [0, 1, 9, 17])
    assert.equal(
      modelRequestsWithinApprovedBounds(record(calls), false),
      false,
    );
  for (const calls of [0, 2, 3, 17])
    assert.equal(modelRequestsWithinApprovedBounds(record(calls), true), false);
});

test('T32 abnormal usage, incomplete settlement and non-numeric fields never pass a gate', () => {
  for (const sample of [
    null,
    {},
    record(5, { recordedModelCalls: 4 }),
    record(5, { settledCalls: 4 }),
    record(5, { settledCalls: null }),
    record(5, { providerCalls: 5.5 }),
    record(5, { providerCalls: '5' }),
    record(5, { providerCalls: NaN }),
    record(5, { providerCalls: -1 }),
  ]) {
    assert.equal(modelRequestsWithinApprovedBounds(sample, false), false);
  }
});

test('T32 a model with five settled requests can legitimately finish an approved two-click healthy case', () => {
  assert.equal(modelRequestsWithinApprovedBounds(record(5), false), true);
  assert.equal(
    modelRequestsWithinApprovedBounds(record(5, { settledCalls: 4 }), false),
    false,
  );
});

test('T32 verified Chromium action histogram accepts only bounded additional observations', () => {
  const baseline = {
    capture: 1,
    click: 2,
    navigate: 1,
    observe: 4,
    type_text: 1,
  };
  for (const extra of [0, 1, 2]) {
    const actionCounts = { ...baseline, observe: baseline.observe + extra };
    assert.equal(
      browserActionsWithinApprovedBounds(
        {
          actionCounts,
          browserActions: 9 + extra,
        },
        false,
      ),
      true,
    );
  }
  assert.equal(
    browserActionsWithinApprovedBounds(
      {
        actionCounts: {
          capture: 2,
          click: 4,
          navigate: 2,
          observe: 12,
          type_text: 2,
        },
        browserActions: 22,
      },
      true,
    ),
    true,
  );
});

test('T32 extra browser mutation, missing action proof, or more than four decisions cannot pass', () => {
  const valid = {
    capture: 1,
    click: 2,
    navigate: 1,
    observe: 4,
    type_text: 1,
  };
  const invalids = [
    null,
    { browserActions: 9 },
    { browserActions: 10, actionCounts: valid },
    { browserActions: 12, actionCounts: { ...valid, observe: 7 } },
    { browserActions: 10, actionCounts: { ...valid, click: 3 } },
    { browserActions: 10, actionCounts: { ...valid, navigate: 2 } },
    { browserActions: 10, actionCounts: { ...valid, type_text: 2 } },
    { browserActions: 10, actionCounts: { ...valid, capture: 2 } },
    { browserActions: 10, actionCounts: { ...valid, capture: 1.3 } },
    { browserActions: 10, actionCounts: { ...valid, extra: 1 } },
    { browserActions: 10, actionCounts: { ...valid, observe: '5' } },
  ];
  for (const entry of invalids) {
    assert.equal(browserActionsWithinApprovedBounds(entry, false), false);
  }
});
