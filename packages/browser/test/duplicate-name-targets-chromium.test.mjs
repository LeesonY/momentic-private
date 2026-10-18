/* global document, window */
// Real Chromium: a list page where every row has a 「详情」 button (and a 「备注」
// input) used to be completely un-actionable — eleven identical role+name
// matches returned TARGET_AMBIGUOUS, so the model could not click any of them.
// The snapshot already pinned one DOM object per node id, so the resolver binds
// that object instead of demanding a unique locator.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { BrowserManager } from '../dist/index.js';

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

async function session(manager, origin) {
  return manager.createSession({
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    allowedOrigins: [origin],
    mode: 'non_submitting',
  });
}

function target(snapshot, node) {
  return {
    snapshotId: snapshot.snapshotId,
    pageId: snapshot.pageId,
    nodeId: node.nodeId,
    frameId: node.frameId ?? 'main',
  };
}

const ROWS = `<!doctype html><html><body><main>
  <table id="table"><tbody id="rows"></tbody></table>
</main>
<script>
  window.__clicked = [];
  window.__render = (count) => {
    const rows = document.getElementById('rows');
    rows.replaceChildren();
    for (let index = 0; index < count; index += 1) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>第 ' + index + ' 行</td>' +
        '<td><input placeholder="备注"></td>' +
        '<td><button type="button">详情</button></td>';
      tr.querySelector('button').addEventListener('click', () => {
        window.__clicked.push(index);
      });
      rows.append(tr);
    }
  };
  window.__render(5);
</script></body></html>`;

test('the third of five identical buttons acts on the third row', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(ROWS);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({ name: 'navigate', args: { url: host.origin } });
    const snapshot = await browser.getSnapshot({ forceFresh: true });
    const details = snapshot.nodes.filter(
      (node) => node.role === 'button' && node.name === '详情',
    );
    assert.equal(details.length, 5, 'five identical buttons are observed');

    const clicked = await browser.executeTool({
      name: 'click',
      args: { target: target(snapshot, details[2]) },
    });
    assert.equal(clicked.status, 'succeeded', clicked.reasonCode ?? '');
    // Exactly the third row (index 2) ran its handler, not the first one.
    assert.deepEqual(
      await browser.getPage().evaluate(() => window.__clicked),
      [2],
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('a re-rendered list rejects the stale row instead of clicking another one', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(ROWS);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({ name: 'navigate', args: { url: host.origin } });
    const snapshot = await browser.getSnapshot({ forceFresh: true });
    const details = snapshot.nodes.filter(
      (node) => node.role === 'button' && node.name === '详情',
    );
    // The list is re-rendered: the observed row is gone, four look-alikes are
    // freshly created (nothing that points at the old element remains).
    await browser.getPage().evaluate(() => window.__render(4));
    const clicked = await browser.executeTool({
      name: 'click',
      args: { target: target(snapshot, details[2]) },
    });
    assert.equal(clicked.status, 'failed');
    assert.ok(
      ['VERSION_CONFLICT', 'TARGET_NOT_FOUND'].includes(clicked.reasonCode),
      `unexpected reason ${clicked.reasonCode}`,
    );
    assert.deepEqual(
      await browser.getPage().evaluate(() => window.__clicked),
      [],
      'no other row was clicked',
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('typing into the fourth of five identical inputs fills the fourth row', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(ROWS);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({ name: 'navigate', args: { url: host.origin } });
    const snapshot = await browser.getSnapshot({ forceFresh: true });
    const notes = snapshot.nodes.filter(
      (node) => node.role === 'text' && node.placeholder === '备注',
    );
    assert.equal(notes.length, 5, 'five identical inputs are observed');
    const typed = await browser.executeTool({
      name: 'type_text',
      args: { target: target(snapshot, notes[3]), text: '第四行备注' },
    });
    assert.equal(typed.status, 'succeeded', typed.reasonCode ?? '');
    const values = await browser
      .getPage()
      .evaluate(() =>
        [...document.querySelectorAll('input')].map((input) => input.value),
      );
    assert.deepEqual(values, ['', '', '', '第四行备注', '']);
    // The observation reports the value of that same row.
    assert.equal(
      typed.data.nodes.find((node) => node.nodeId === notes[3].nodeId).value,
      '第四行备注',
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});
