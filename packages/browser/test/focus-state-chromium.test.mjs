/* global document */
// Real Chromium: keyboard focus is a snapshot fact. A Tab-order case is
// unverifiable unless the observation says which element actually holds focus,
// including an input inside an open shadow root and a focused element the normal
// selector would miss.
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

const focusedNodes = (snapshot) =>
  snapshot.nodes.filter((node) => node.focused);

const LOGIN = `<!doctype html><html><body><main>
  <form>
    <input id="user" placeholder="账号">
    <input id="pass" type="password" placeholder="密码">
    <button type="button" id="go">登录</button>
  </form>
  <my-widget id="widget"></my-widget>
  <div id="editable" contenteditable="true">可编辑块</div>
</main>
<script>
  customElements.define('my-widget', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML =
        '<label>影子输入<input id="inner" placeholder="影子"></label>';
    }
  });
</script></body></html>`;

test('every Tab step reports which control actually has focus', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(LOGIN);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({ name: 'navigate', args: { url: host.origin } });
    const start = await browser.getSnapshot({ forceFresh: true });
    // Focus is on the page itself after a navigation: nothing is marked.
    assert.deepEqual(focusedNodes(start), []);
    const account = start.nodes.find((node) => node.placeholder === '账号');
    const password = start.nodes.find((node) => node.role === 'password');
    const submit = start.nodes.find((node) => node.role === 'button');
    assert.ok(account && password && submit);

    // Playwright focuses the target and then presses Tab: 账号 -> 密码.
    const first = await browser.executeTool({
      name: 'press',
      args: { target: target(start, account), key: 'Tab' },
    });
    assert.equal(first.status, 'succeeded');
    const afterFirst = await browser.getSnapshot({ forceFresh: true });
    assert.deepEqual(
      focusedNodes(afterFirst).map((node) => node.nodeId),
      [password.nodeId],
      'focus moved from the account box to the password box',
    );

    // 密码 -> 登录按钮.
    const second = await browser.executeTool({
      name: 'press',
      args: { target: target(afterFirst, password), key: 'Tab' },
    });
    assert.equal(second.status, 'succeeded');
    const afterSecond = await browser.getSnapshot({ forceFresh: true });
    assert.deepEqual(
      focusedNodes(afterSecond).map((node) => node.nodeId),
      [submit.nodeId],
      'focus moved from the password box to the submit button',
    );
    // The button really is the action target the model would use next.
    assert.equal(afterSecond.nodes.find((node) => node.focused)?.name, '登录');
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('Shift+Tab reports focus moving back to the previous control', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(LOGIN);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({ name: 'navigate', args: { url: host.origin } });
    const start = await browser.getSnapshot({ forceFresh: true });
    const account = start.nodes.find((node) => node.placeholder === '账号');
    const password = start.nodes.find((node) => node.role === 'password');
    assert.ok(account && password);

    // Forward: 账号 -> 密码.
    const forward = await browser.executeTool({
      name: 'press',
      args: { target: target(start, account), key: 'Tab' },
    });
    assert.equal(forward.status, 'succeeded');
    const afterForward = await browser.getSnapshot({ forceFresh: true });
    assert.deepEqual(
      focusedNodes(afterForward).map((node) => node.nodeId),
      [password.nodeId],
    );

    // Reverse: 密码 -> 账号. Playwright focuses the target, then Shift+Tab.
    const reverse = await browser.executeTool({
      name: 'press',
      args: { target: target(afterForward, password), key: 'Shift+Tab' },
    });
    assert.equal(reverse.status, 'succeeded');
    const afterReverse = await browser.getSnapshot({ forceFresh: true });
    assert.deepEqual(
      focusedNodes(afterReverse).map((node) => node.nodeId),
      [account.nodeId],
      'Shift+Tab moved focus back to the account box',
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('focus inside an open shadow root and on a plain editable block is marked', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(LOGIN);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({ name: 'navigate', args: { url: host.origin } });
    const start = await browser.getSnapshot({ forceFresh: true });
    // Clicking the shadow input is what a user does to focus it.
    const shadowInput = start.nodes.find((node) => node.placeholder === '影子');
    assert.ok(shadowInput, 'the shadow input is part of the snapshot');
    const clicked = await browser.executeTool({
      name: 'click',
      args: { target: target(start, shadowInput) },
    });
    assert.equal(clicked.status, 'succeeded');
    const afterShadow = await browser.getSnapshot({ forceFresh: true });
    assert.deepEqual(
      focusedNodes(afterShadow).map((node) => node.nodeId),
      [shadowInput.nodeId],
      'the focused shadow-root input is marked',
    );

    // A contenteditable block is not matched by the legacy selector; it still has
    // to be reported, because that is where Tab went.
    await browser.getPage().evaluate(() => {
      const editable = document.getElementById('editable');
      editable.focus();
    });
    const afterEditable = await browser.getSnapshot({ forceFresh: true });
    const focused = focusedNodes(afterEditable);
    assert.equal(focused.length, 1);
    assert.equal(focused[0].name, '可编辑块');
    assert.equal(focused[0].role, 'div');
    assert.equal(focused[0].focused, true);
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('a signed-in browser still redacts a focused field', async () => {
  const account = 'saved-account-9f@example.test';
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(LOGIN);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    browser.rememberAuthenticationValue(account);
    await browser.executeTool({ name: 'navigate', args: { url: host.origin } });
    const start = await browser.getSnapshot({ forceFresh: true });
    const accountNode = start.nodes.find((node) => node.placeholder === '账号');
    assert.ok(accountNode);
    // The saved account is typed by the private sign-in; the field keeps focus.
    await browser.executeTool({
      name: 'type_text',
      args: { target: target(start, accountNode), text: account },
    });
    const after = await browser.getSnapshot({ forceFresh: true });
    const field = after.nodes.find(
      (node) => node.nodeId === accountNode.nodeId,
    );
    assert.equal(field.focused, true, 'focus is still reported');
    assert.equal(field.value, '•');
    assert.equal(field.name, '账号');
    assert.equal(JSON.stringify(after).includes(account), false);
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});
