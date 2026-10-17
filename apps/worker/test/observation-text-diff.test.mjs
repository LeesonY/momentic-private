// Pure Node: what one action changed on screen, in words. The fixtures mirror
// the 114 login page where a field's placeholder and its validation message are
// the same string, and every snapshot renumbers its node ids.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  focusChange,
  focusChangeLine,
  focusLabel,
  textChanges,
  textChangeLine,
} from '../dist/observation-text-diff.js';
import {
  actionObservation,
  compactObservation,
  trailEntry,
} from '../dist/index.js';

const pageId = '22222222-2222-4222-8222-222222222222';
let seed = 0;

function snapshot(extraNodes = []) {
  seed += 1;
  return {
    snapshotId: `11111111-1111-4111-8111-${String(seed).padStart(12, '0')}`,
    pageId,
    frameIds: ['main'],
    displayUrl: 'http://192.168.111.114:38445/login',
    title: '登录',
    responseStatus: 200,
    capturedAt: '2026-10-17T00:00:00.000Z',
    stateVersion: seed,
    viewport: { width: 1280, height: 720 },
    nodes: [
      {
        nodeId: `main_node_0`,
        frameId: 'main',
        role: 'text',
        inputType: 'text',
        name: '请输入账号',
        placeholder: '请输入账号',
        text: '',
        value: '',
        visible: true,
        enabled: true,
        bounds: { left: 0, top: 0, width: 10, height: 10 },
      },
      {
        nodeId: `main_node_1`,
        frameId: 'main',
        role: 'password',
        inputType: 'password',
        name: '请输入密码',
        placeholder: '请输入密码',
        text: '[redacted]',
        value: '',
        sensitive: true,
        visible: true,
        enabled: true,
        bounds: { left: 0, top: 0, width: 10, height: 10 },
      },
      {
        nodeId: `main_node_2`,
        frameId: 'main',
        role: 'button',
        inputType: 'button',
        name: '登录',
        text: '登录',
        visible: true,
        enabled: true,
        bounds: { left: 0, top: 0, width: 10, height: 10 },
      },
      ...extraNodes,
    ],
    screenshotRef: null,
    networkSummary: [],
    consoleSummary: [],
    truncated: false,
    redacted: true,
  };
}

const message = (nodeId, text, relatedNodeId) => ({
  nodeId,
  frameId: 'main',
  role: 'statictext',
  name: text,
  text,
  visible: true,
  enabled: true,
  bounds: { left: 0, top: 0, width: 10, height: 10 },
  ...(relatedNodeId ? { relatedNodeId } : {}),
});

test('a message that repeats the placeholder is reported as newly appeared', () => {
  const before = snapshot();
  const after = snapshot([
    message('main_text_1', '请输入账号', 'main_node_0'),
    message('main_text_2', '请输入密码', 'main_node_1'),
  ]);
  const changes = textChanges(before, after);
  assert.deepEqual(changes, {
    appeared: ['请输入账号（请输入账号）', '请输入密码（请输入密码）'],
    disappeared: [],
  });
  // The report view names the action, as the case report reads it.
  assert.equal(
    textChangeLine('click', changes),
    '点击后新出现：请输入账号（请输入账号）、请输入密码（请输入密码）',
  );

  // The action observation carries the same evidence next to the fields.
  const observation = actionObservation(after, changes);
  assert.deepEqual(observation.textChanges, changes);
  const field = observation.nodes.find((node) => node.nodeId === 'main_node_0');
  assert.equal(field.placeholder, '请输入账号');
  assert.equal(field.name, '请输入账号');
  const hint = observation.nodes.find((node) => node.nodeId === 'main_text_1');
  assert.equal(hint.relatedNodeId, 'main_node_0');

  // The report projection can resolve the same references from its own ids.
  const report = compactObservation(after);
  const reportedField = report.nodes.find(
    (node) => node.nodeId === 'main_node_0',
  );
  assert.equal(reportedField.placeholder, '请输入账号');
  const reportedHint = report.nodes.find(
    (node) => node.nodeId === 'main_text_1',
  );
  assert.equal(reportedHint.relatedNodeId, 'main_node_0');

  // The trail keeps the line the report prompt reads back.
  const entry = trailEntry(
    { name: 'click', args: { target: { nodeId: 'main_node_2' } } },
    before,
    true,
    null,
    changes,
  );
  assert.equal(
    entry.textChanges,
    '点击后新出现：请输入账号（请输入账号）、请输入密码（请输入密码）',
  );
});

test('renumbered ids for the same text are not a change', () => {
  const before = snapshot([
    message('main_text_9', '请输入账号', 'main_node_0'),
  ]);
  const after = snapshot([message('main_text_1', '请输入账号', 'main_node_0')]);
  assert.equal(textChanges(before, after), null);
});

test('a notice that disappears is reported, and an ordinary action stays quiet', () => {
  const before = snapshot([message('main_text_5', '登录成功', null)]);
  const after = snapshot();
  assert.deepEqual(textChanges(before, after), {
    appeared: [],
    disappeared: ['登录成功'],
  });
  assert.equal(textChanges(before, before), null);
  assert.equal(textChanges(null, after), null);
  assert.ok(
    textChangeLine('click', textChanges(before, after)).includes(
      '消失：登录成功',
    ),
  );
});

test('the list is capped and says how much it dropped', () => {
  const before = snapshot();
  const after = snapshot(
    Array.from({ length: 9 }, (_, index) =>
      message(`main_text_${index}`, `提示 ${index}`, 'main_node_0'),
    ),
  );
  const changes = textChanges(before, after);
  assert.equal(changes.appeared.length, 7);
  assert.equal(changes.appeared.at(-1), '…（另有 3 条）');
  // Each entry is bounded and names its control.
  assert.ok(changes.appeared[0].endsWith('（请输入账号）'));
});

test('a control flagged aria-invalid is marked for the model', () => {
  const invalid = snapshot();
  invalid.nodes[0] = { ...invalid.nodes[0], invalid: true };
  const observation = actionObservation(invalid);
  assert.equal(
    observation.nodes.find((node) => node.nodeId === 'main_node_0').invalid,
    true,
  );
  assert.equal(
    actionObservation(snapshot()).nodes.find(
      (node) => node.nodeId === 'main_node_0',
    ).invalid,
    undefined,
  );
});

const withFocus = (snapshot, nodeId, extra = []) => ({
  ...snapshot,
  nodes: [
    ...snapshot.nodes.map((node) => ({
      ...node,
      ...(node.nodeId === nodeId ? { focused: true } : {}),
    })),
    ...extra,
  ],
});

test('focus moving between two steps is reported in words', () => {
  const before = withFocus(snapshot(), 'main_node_0');
  const after = withFocus(snapshot(), 'main_node_1');
  const change = focusChange(before, after);
  assert.deepEqual(change, { from: '请输入账号', to: '请输入密码' });
  assert.equal(
    focusChangeLine('press', change),
    '按键后焦点：请输入账号 → 请输入密码',
  );

  // A Tab that does not move focus is not a change.
  assert.equal(focusChange(after, withFocus(snapshot(), 'main_node_1')), null);
  // Focus leaving the page is reported as well.
  assert.deepEqual(focusChange(after, snapshot()), {
    from: '请输入密码',
    to: null,
  });
  assert.equal(
    focusChangeLine('press', focusChange(after, snapshot())),
    '按键后焦点：请输入密码 → 无',
  );
  assert.equal(focusChange(null, after), null);
});

test('the trail and the action observation both carry the focus move', () => {
  const before = withFocus(snapshot(), 'main_node_0');
  const after = withFocus(snapshot(), 'main_node_1');
  const change = focusChange(before, after);
  const entry = trailEntry(
    { name: 'press', args: { target: { nodeId: 'main_node_0' } } },
    before,
    true,
    null,
    null,
    change,
  );
  assert.equal(entry.focusChange, '按键后焦点：请输入账号 → 请输入密码');
  assert.equal(entry.textChanges, undefined);

  const observation = actionObservation(after, null, change);
  assert.deepEqual(observation.focusChange, change);
  assert.equal(
    observation.nodes.find((node) => node.nodeId === 'main_node_1').focused,
    true,
  );
  // The report view keeps the same flag (it carries ids only for referenced
  // nodes, so the field is found by its role).
  const report = compactObservation(after);
  assert.equal(
    report.nodes.find((node) => node.role === 'password').focused,
    true,
  );
});

test('a focused child frame control wins over the iframe that hosts it', () => {
  const frame = snapshot([
    {
      nodeId: 'frame_node',
      frameId: 'frame-1',
      role: 'iframe',
      name: '登录框',
      text: '',
      visible: true,
      enabled: true,
      bounds: { left: 0, top: 0, width: 10, height: 10 },
      focused: true,
    },
    {
      nodeId: 'frame_input',
      frameId: 'frame-1',
      role: 'textbox',
      name: '账号',
      text: '',
      visible: true,
      enabled: true,
      bounds: { left: 0, top: 0, width: 10, height: 10 },
      focused: true,
    },
  ]);
  assert.equal(focusLabel(frame), '账号');
});

test('a notice seen only in the action observation is reported both ways', () => {
  // The settle window keeps a ~1.5 s notice inside the action observation; by
  // report time it is gone. Both ends of the story must reach the report.
  const before = snapshot();
  const actionResult = snapshot([
    message('main_text_9', '登录失败，请检查账号'),
  ]);
  const atReport = snapshot();
  assert.deepEqual(textChanges(before, actionResult), {
    appeared: ['登录失败，请检查账号'],
    disappeared: [],
  });
  assert.deepEqual(textChanges(actionResult, atReport), {
    appeared: [],
    disappeared: ['登录失败，请检查账号'],
  });
});
