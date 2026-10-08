import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { resolveRegressionLocator } from '../dist/regression-locator.js';
import { resolveTarget } from '../dist/resolver.js';

// Mock DOM port only: no Playwright/browser process is created.
function fixture(count = 1, nodeCount = 1) {
  const element = { dispose: async () => {} };
  const calls = [];
  const locator = {
    count: async () => count,
    isVisible: async () => true,
    isEnabled: async () => true,
    elementHandle: async () => element,
    evaluate: async (fn, expected) => fn(element, expected),
  };
  const page = { mainFrame: () => page, frames: () => [page] };
  for (const name of [
    'getByRole',
    'getByLabel',
    'getByTestId',
    'getByText',
    'locator',
  ])
    page[name] = (...args) => {
      calls.push({ name, args });
      return locator;
    };
  const snapshot = {
    snapshotId: randomUUID(),
    pageId: randomUUID(),
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      nodeId: `testid_${i}`,
      frameId: 'main',
      role: 'textbox',
      name: 'Input',
      text: 'value',
      visible: true,
      enabled: true,
    })),
    stateVersion: 1,
  };
  return { page, snapshot, calls };
}
test('mock DOM: all five locator strategies bind the current unique owned node', async () => {
  for (const [by, method] of [
    ['role', 'getByRole'],
    ['label', 'getByLabel'],
    ['test_id', 'getByTestId'],
    ['text', 'getByText'],
    ['css', 'locator'],
  ]) {
    const { page, snapshot, calls } = fixture();
    const result = await resolveRegressionLocator(
      page,
      { by, value: by === 'role' ? 'textbox' : 'Input' },
      snapshot,
    );
    assert.equal(calls[0].name, method);
    assert.equal(result.snapshotId, snapshot.snapshotId);
    assert.equal(result.pageId, snapshot.pageId);
    assert.equal(result.nodeId, 'testid_0');
  }
});
test('mock DOM: missing/ambiguous/unowned/cancelled locators have stable machine codes', async () => {
  for (const [count, nodes, code] of [
    [0, 1, 'LOCATOR_NOT_FOUND'],
    [2, 1, 'LOCATOR_NOT_UNIQUE'],
    [1, 0, 'LOCATOR_NOT_OWNED_OR_AMBIGUOUS'],
    [1, 2, 'LOCATOR_NOT_OWNED_OR_AMBIGUOUS'],
  ]) {
    const { page, snapshot } = fixture(count, nodes);
    await assert.rejects(
      () =>
        resolveRegressionLocator(page, { by: 'css', value: 'input' }, snapshot),
      (error) => error.code === code,
    );
  }
  const { page, snapshot } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      resolveRegressionLocator(
        page,
        { by: 'css', value: 'input' },
        snapshot,
        controller.signal,
      ),
    (error) => error.code === 'CANCELLED',
  );
});
test('mock DOM: executor resolver rejects stale snapshot identity before DOM lookup', async () => {
  const { page, snapshot, calls } = fixture();
  const result = await resolveTarget(
    page,
    { snapshotId: randomUUID(), pageId: snapshot.pageId, nodeId: 'testid_0' },
    snapshot,
  );
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'VERSION_CONFLICT');
  assert.equal(calls.length, 0);
});
