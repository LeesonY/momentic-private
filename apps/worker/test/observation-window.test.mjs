// Pure Node: the model-facing node window. No Chromium, no model, no database.
// It proves that a validation message and its field reach the model even when a
// page has far more controls than the observation slice, and that ordinary
// pages keep their plain page-order head.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeWindow } from '../dist/observation-window.js';
import { actionObservation, compactObservation } from '../dist/index.js';

const node = (nodeId, role, name, extra = {}) => ({
  nodeId,
  frameId: 'main',
  role,
  name,
  text: '',
  visible: true,
  enabled: true,
  bounds: { left: 0, top: 0, width: 10, height: 10 },
  ...extra,
});

/** A form with 250 fields; the last one shows a validation message. */
function longForm() {
  const nodes = [];
  for (let index = 0; index < 250; index += 1) {
    nodes.push(node(`field_${index}`, 'textbox', `字段 ${index}`));
    if (index === 230)
      nodes.push(
        node('field_230_error', 'statictext', '此字段不能为空', {
          relatedNodeId: 'field_230',
        }),
      );
  }
  return nodes;
}

test('a message under control #230 and its field reach the model window', () => {
  const nodes = longForm();
  const window = observeWindow(nodes, 200);
  assert.ok(window.length <= 200);
  const ids = window.map((entry) => entry.nodeId);
  assert.ok(
    ids.includes('field_230_error'),
    'the validation message is promoted',
  );
  assert.ok(ids.includes('field_230'), 'its field is promoted with it');
  // Page order is preserved inside the window.
  assert.ok(ids.indexOf('field_230') < ids.indexOf('field_230_error'));
  const pageOrder = nodes.map((entry) => entry.nodeId);
  const positions = ids.map((id) => pageOrder.indexOf(id));
  assert.deepEqual(
    positions,
    [...positions].sort((l, r) => l - r),
  );

  // The real Worker projections (exported test seams) keep it as well.
  const snapshot = {
    snapshotId: '11111111-1111-4111-8111-111111111111',
    pageId: '22222222-2222-4222-8222-222222222222',
    displayUrl: 'https://fixture.test/form',
    title: 'form',
    responseStatus: 200,
    truncated: false,
    consoleSummary: [],
    nodes,
  };
  const acting = actionObservation(snapshot);
  const seen = acting.nodes.map((entry) => entry.nodeId);
  assert.ok(seen.includes('field_230_error'));
  assert.ok(seen.includes('field_230'));
  assert.equal(acting.truncated, true);
  // The report view carries text only, so it is checked by the message itself.
  const reported = compactObservation(snapshot);
  assert.ok(reported.nodes.some((entry) => entry.name === '此字段不能为空'));
  assert.equal(reported.truncated, true);
});

test('a live-region notice is promoted even when it is far down the page', () => {
  const nodes = [];
  for (let index = 0; index < 260; index += 1)
    nodes.push(node(`button_${index}`, 'button', `操作 ${index}`));
  nodes.push(node('toast', 'alert', '保存成功'));
  const ids = observeWindow(nodes, 200).map((entry) => entry.nodeId);
  assert.ok(ids.includes('toast'));
});

test('a page inside the limit is returned unchanged and in page order', () => {
  const nodes = Array.from({ length: 12 }, (_, index) =>
    node(`node_${index}`, 'button', `按钮 ${index}`),
  );
  const window = observeWindow(nodes, 200);
  assert.deepEqual(
    window.map((entry) => entry.nodeId),
    nodes.map((entry) => entry.nodeId),
  );
});

test('promotion stays bounded and never exceeds the limit', () => {
  const nodes = [];
  for (let index = 0; index < 400; index += 1) {
    nodes.push(node(`field_${index}`, 'textbox', `字段 ${index}`));
    nodes.push(
      node(`field_${index}_error`, 'statictext', '不能为空', {
        relatedNodeId: `field_${index}`,
      }),
    );
  }
  const window = observeWindow(nodes, 200);
  assert.equal(window.length, 200);
  assert.ok(window.some((entry) => entry.relatedNodeId));
});

test("a long form's labels cannot spend the promotion budget", () => {
  // Every field has a label text node plus its control, exactly like a real
  // Element form. The one validation message arrives last.
  const nodes = [];
  for (let index = 0; index < 250; index += 1) {
    nodes.push(
      node(`label_${index}`, 'label', `字段 ${index}`, {
        relatedNodeId: `field_${index}`,
      }),
    );
    nodes.push(node(`field_${index}`, 'textbox', `字段 ${index}`));
    if (index === 230)
      nodes.push(
        node('message', 'statictext', '此字段不能为空', {
          relatedNodeId: 'field_230',
        }),
      );
  }
  const ids = observeWindow(nodes, 200).map((entry) => entry.nodeId);
  assert.ok(ids.includes('message'), 'the message is promoted past the labels');
  assert.ok(ids.includes('field_230'));
});
