// Real Chromium: a navigation returns an observation of the page as it is after
// the first paint finished rendering, not of the half-drawn shell that
// domcontentloaded hands back. The 66 run observed the 114 login page 1.7 s after
// it started, the app then mounted and fetched its config, and the first click
// hit a replaced button (stale-snapshot conflict).
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

test('the navigation observation is taken after the app rendered its real form', async () => {
  // A single-page app: the shell has a placeholder button, the config request
  // takes 700 ms, and the real form (a *new* button element) replaces it.
  const host = await listen((req, res) => {
    if (req.url === '/config.json') {
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ product: '柔性灰度APT攻击粘随与压制软件123' }),
        );
      }, 700);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><body><main id="app">
      <button type="button" id="go">登录中…</button>
    </main>
    <script>
      fetch('/config.json')
        .then((response) => response.json())
        .then((config) => {
          document.title = config.product + '·登录';
          document.getElementById('app').innerHTML =
            '<form><input placeholder="请输入账号">' +
            '<button type="button" id="go">登录</button></form>';
        });
    </script></body></html>`);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    const started = Date.now();
    const navigation = await browser.executeTool({
      name: 'navigate',
      args: { url: `${host.origin}/login` },
    });
    const elapsedMs = Date.now() - started;
    assert.equal(navigation.status, 'succeeded');
    const snapshot = navigation.data;
    assert.equal(snapshot.settled, undefined, 'the page had finished');
    assert.equal(snapshot.title, '柔性灰度APT攻击粘随与压制软件123·登录');
    const button = snapshot.nodes.find(
      (node) => node.role === 'button' && node.visible,
    );
    assert.equal(button.name, '登录', 'the rendered button, not the shell one');
    assert.ok(
      snapshot.nodes.some((node) => node.placeholder === '请输入账号'),
      'the rendered form is part of the observation',
    );
    assert.ok(
      elapsedMs >= 700,
      `the observation waited for the config request (${elapsedMs} ms)`,
    );

    // The click on the observed button works: the observation is not stale.
    const clicked = await browser.executeTool({
      name: 'click',
      args: { target: target(snapshot, button) },
    });
    assert.equal(clicked.status, 'succeeded', clicked.reasonCode ?? '');
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('a static page only pays the quiet window', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><html><body><main><button type="button">登录</button></main></body></html>',
    );
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    const started = Date.now();
    const navigation = await browser.executeTool({
      name: 'navigate',
      args: { url: host.origin },
    });
    const elapsedMs = Date.now() - started;
    assert.equal(navigation.status, 'succeeded');
    assert.equal(navigation.data.settled, undefined);
    assert.ok(
      elapsedMs >= 250,
      `the quiet window is waited out (${elapsedMs} ms)`,
    );
    assert.ok(
      elapsedMs < 1400,
      `a page that stops moving is not held to the cap (${elapsedMs} ms)`,
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('a page that keeps mutating stops at the navigation cap and says so', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><body><main>
      <button type="button">登录</button>
      <ul id="list"></ul>
    </main>
    <script>
      // A live list: the page never stops restructuring itself.
      const list = document.getElementById('list');
      setInterval(() => {
        const item = document.createElement('li');
        item.textContent = '心跳 ' + Date.now();
        list.append(item);
        if (list.children.length > 5) list.firstElementChild.remove();
      }, 100);
    </script></body></html>`);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    const started = Date.now();
    const navigation = await browser.executeTool({
      name: 'navigate',
      args: { url: host.origin },
    });
    const elapsedMs = Date.now() - started;
    assert.equal(navigation.status, 'succeeded');
    assert.equal(
      navigation.data.settled,
      false,
      'the observation admits the page was still changing',
    );
    assert.ok(
      elapsedMs < 4500,
      `the wait stays bounded by the cap (${elapsedMs} ms)`,
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});
