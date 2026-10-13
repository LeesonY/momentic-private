import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestLocatorRepair } from '../dist/repair-suggestions.js';

const source = {
  documentId: 'approved-checkout',
  stepIndex: 2,
  modulePath: [],
};
const old = { by: 'role', value: 'button', name: 'Complete Order' };
const node = {
  nodeId: 'testid_checkout',
  frameId: 'main',
  role: 'button',
  name: 'COMPLETE  ORDER',
  text: '',
  visible: true,
  enabled: true,
};
const snapshot = {
  snapshotId: '00000000-0000-4000-8000-000000000001',
  pageId: '00000000-0000-4000-8000-000000000002',
  displayUrl: 'https://fixture.test/cart?session=private-token#secret',
  redacted: true,
  truncated: false,
  nodes: [node],
};
const run = (options = {}) =>
  suggestLocatorRepair({
    locator: old,
    source,
    snapshot,
    reasonCode: 'LOCATOR_NOT_FOUND',
    ...options,
  });

test('redacted unique DOM name variation yields inert and attributable repair suggestion', () => {
  const before = JSON.stringify(snapshot);
  const proposal = run();
  assert.deepEqual(proposal, {
    kind: 'locator_name_variation',
    source,
    original: old,
    proposed: { by: 'role', value: 'button', name: 'COMPLETE  ORDER' },
    reasonCode: 'LOCATOR_NOT_FOUND',
    snapshotId: snapshot.snapshotId,
    pageId: snapshot.pageId,
    observedOrigin: 'https://fixture.test',
    reviewRequired: true,
    verification: 'not_run',
  });
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(JSON.stringify(proposal).includes('private-token'), false);
});

test('ambiguous, hidden, disabled, sensitive and cross-frame elements never produce suggestions', () => {
  for (const change of [
    { nodes: [node, { ...node, nodeId: 'other' }] },
    { nodes: [{ ...node, visible: false }] },
    { nodes: [{ ...node, enabled: false }] },
    { nodes: [{ ...node, sensitive: true }] },
    { nodes: [{ ...node, inputType: 'password' }] },
    { nodes: [{ ...node, frameId: 'cross-origin' }] },
    { nodes: [{ ...node, role: 'link' }] },
    { redacted: false },
    { truncated: true },
    { displayUrl: 'javascript:alert(1)' },
  ]) {
    assert.equal(run({ snapshot: { ...snapshot, ...change } }), null);
  }
});

test('never guesses semantic changes or proposes an unchanged failing locator', () => {
  assert.equal(
    run({ snapshot: { ...snapshot, nodes: [{ ...node, name: 'Pay now' }] } }),
    null,
  );
  assert.equal(
    run({ snapshot: { ...snapshot, nodes: [{ ...node, name: old.name }] } }),
    null,
  );
  assert.equal(run({ locator: { by: 'test_id', value: 'checkout' } }), null);
  assert.equal(run({ reasonCode: 'LOCATOR_NOT_UNIQUE' }), null);
  assert.equal(run({ reasonCode: 'MODEL_FAILURE' }), null);
  assert.equal(run({ snapshot: null }), null);
});

test('labeled input may suggest a unique role-based locator, but never writes data', () => {
  const proposal = run({
    locator: { by: 'label', value: 'Email Address' },
    snapshot: {
      ...snapshot,
      nodes: [{ ...node, role: 'textbox', name: 'EMAIL ADDRESS' }],
    },
  });
  assert.deepEqual(proposal?.proposed, {
    by: 'role',
    value: 'textbox',
    name: 'EMAIL ADDRESS',
  });
  assert.equal(proposal?.verification, 'not_run');
  assert.equal(
    run({ locator: { by: 'label', value: 'Complete Order' } }),
    null,
    'a clickable button cannot silently replace a labeled form input',
  );
});
