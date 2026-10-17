import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WaitAndRecoveryManager } from '../dist/waiter.js';

function snapshot(name, nodeId = 'main_node_1') {
  return {
    displayUrl: 'https://fixture.test/checkout',
    title: 'Checkout',
    nodes: [
      {
        frameId: 'main',
        nodeId,
        role: 'button',
        name,
        visible: true,
        enabled: true,
      },
    ],
  };
}

test('long wizard preserves changing semantic steps even if URL, count and node ID stay constant', () => {
  const waiter = new WaitAndRecoveryManager();
  const fingerprints = [];
  for (let i = 1; i <= 24; i++) {
    const fingerprint = waiter.computeFingerprint(snapshot(`Stage ${i}`));
    assert.ok(!fingerprints.includes(fingerprint));
    waiter.recordAction('click', 'main_node_1', fingerprint);
    fingerprints.push(fingerprint);
  }
  assert.equal(fingerprints.length, 24);
});

test('node ID or capture identity churn alone cannot evade loop detection', () => {
  const waiter = new WaitAndRecoveryManager();
  const first = waiter.computeFingerprint(snapshot('Submit', 'node_1'));
  const second = waiter.computeFingerprint(snapshot('Submit', 'node_2'));
  assert.equal(first, second);
  waiter.recordAction('click', 'submit', first);
  waiter.recordAction('click', 'submit', second);
  assert.throws(
    () => waiter.recordAction('click', 'submit', second),
    /REPEATED_ACTION_LIMIT/,
  );
});

test('a state-changing action between two clicks breaks the repeat run', () => {
  const waiter = new WaitAndRecoveryManager();
  const fingerprint = waiter.computeFingerprint(snapshot('Submit'));
  waiter.recordAction('click', 'submit', fingerprint);
  waiter.recordStateChange('type_text', 'account');
  waiter.recordAction('click', 'submit', fingerprint);
  waiter.recordStateChange('type_text', 'password');
  waiter.recordAction('click', 'submit', fingerprint);
});

test('a rejected click followed by a state change is allowed again', () => {
  const waiter = new WaitAndRecoveryManager();
  const fingerprint = waiter.computeFingerprint(snapshot('Submit'));
  waiter.recordAction('click', 'submit', fingerprint);
  waiter.recordAction('click', 'submit', fingerprint);
  assert.throws(
    () => waiter.recordAction('click', 'submit', fingerprint),
    /REPEATED_ACTION_LIMIT/,
  );
  // The rejected click never entered the history; one real state change
  // clears the consecutive run.
  waiter.recordStateChange('type_text', 'account');
  waiter.recordAction('click', 'submit', fingerprint);
});
