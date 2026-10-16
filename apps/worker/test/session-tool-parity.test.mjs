import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { toolsForRole } from '@localqa/agents';
import { validateBrowserTool } from '@localqa/domain';

const BROWSER_TOOLS = [
  'capture',
  'click',
  'navigate',
  'observe',
  'press',
  'scroll',
  'select_option',
  'type_text',
  'wait_for',
];

function target() {
  return {
    snapshotId: randomUUID(),
    pageId: randomUUID(),
    nodeId: 'main_node_0',
  };
}

const LEDGER_VALID_CALLS = {
  observe: { name: 'observe', args: {} },
  navigate: { name: 'navigate', args: { url: 'http://fixture.local/login' } },
  capture: {
    name: 'capture',
    args: { pageId: randomUUID(), reason: 'evidence' },
  },
  click: { name: 'click', args: { target: target() } },
  type_text: {
    name: 'type_text',
    args: { target: target(), text: 'smoke_value' },
  },
  select_option: {
    name: 'select_option',
    args: { target: target(), value: 'option' },
  },
  press: { name: 'press', args: { target: target(), key: 'Tab' } },
  scroll: {
    name: 'scroll',
    args: { pageId: randomUUID(), direction: 'down', pixels: 10 },
  },
  wait_for: {
    name: 'wait_for',
    args: { pageId: randomUUID(), condition: 'dom_ready', timeoutMs: 100 },
  },
};

test('browser roles are advertised exactly the tools the action ledger can grant', () => {
  for (const role of ['explorer', 'executor', 'reproducer']) {
    assert.deepEqual(
      toolsForRole(role),
      BROWSER_TOOLS,
      `${role} must not be offered a tool the session ledger always denies`,
    );
    for (const name of toolsForRole(role)) {
      const call = LEDGER_VALID_CALLS[name];
      assert.ok(call, `missing ledger-valid call fixture for '${name}'`);
      assert.doesNotThrow(
        () =>
          validateBrowserTool(role, call, ['http://fixture.local'], [], true),
        `${role} advertises '${name}' but the ledger denies it`,
      );
    }
  }
});

test('non-browser roles keep their contract tools', () => {
  assert.deepEqual(toolsForRole('planner'), []);
  assert.deepEqual(toolsForRole('finalizer'), []);
  assert.deepEqual(toolsForRole('coordinator'), [
    'request_input',
    'submit_case',
  ]);
});
