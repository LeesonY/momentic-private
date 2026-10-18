/* global document */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import {
  BrowserManager,
  captureBrowserSnapshot,
  resolveTarget,
  SessionRecorder,
  snapshotTargetUnchanged,
} from '../dist/index.js';

async function withPage(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await run(page);
  } finally {
    await browser.close();
  }
}

function targetFor(snapshot, node) {
  return {
    snapshotId: snapshot.snapshotId,
    pageId: snapshot.pageId,
    nodeId: node.nodeId,
    frameId: node.frameId,
  };
}

function identity() {
  return {
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
  };
}

const TWO_FIELDS = `<div id="app">
  <div class="field"><input id="account" placeholder="请输入账号"></div>
  <div class="field"><input id="password" type="password" placeholder="请输入密码"></div>
  <button id="login">登录</button></div>`;

test('unrelated page churn does not invalidate an unchanged approved target', async () => {
  await withPage(async (page) => {
    await page.setContent(TWO_FIELDS);
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const account = snapshot.nodes.find((n) => n.name === '请输入账号');
    assert.ok(account);
    // Page initialization churn seen on the 114 login page: late title, a
    // full-screen loading mask appended to body, body class toggles and
    // another field's validation icon.
    await page.evaluate(() => {
      document.title = '柔性灰度APT攻击粘随与压制软件123·登录';
      document.body.classList.add('el-loading-parent--hidden');
      const mask = document.createElement('div');
      mask.className = 'el-loading-mask is-fullscreen';
      document.body.append(mask);
      document
        .querySelector('#password')
        .parentElement.append(document.createElement('i'));
    });
    const result = await resolveTarget(
      page,
      targetFor(snapshot, account),
      snapshot,
    );
    assert.equal(result.status, 'resolved');
    await result.elementHandle.fill('smoke_user_114');
    await result.elementHandle.dispose();
    assert.equal(await page.inputValue('#account'), 'smoke_user_114');
  });
});

test('an action on one field does not invalidate another approved field', async () => {
  await withPage(async (page) => {
    await page.setContent(TWO_FIELDS);
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const password = snapshot.nodes.find((n) => n.role === 'password');
    assert.ok(password);
    // Element-UI validation after typing in the account field: wrapper class
    // churn plus an added validation icon.
    await page.evaluate(() => {
      const wrapper = document.querySelector('#account').parentElement;
      wrapper.classList.add('is-success');
      wrapper.append(document.createElement('span'));
    });
    const result = await resolveTarget(
      page,
      targetFor(snapshot, password),
      snapshot,
    );
    assert.equal(result.status, 'resolved');
    await result.elementHandle.fill('WrongPwd_123');
    await result.elementHandle.dispose();
    assert.equal(await page.inputValue('#password'), 'WrongPwd_123');
  });
});

test('a remounted target with identical metadata is still refused', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<div id="slot"><button data-testid="confirm">Confirm</button></div>',
    );
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const node = snapshot.nodes.find((n) => n.nodeId === 'testid_confirm');
    assert.ok(node);
    await page.evaluate(() => {
      document.querySelector('#slot').innerHTML =
        '<button data-testid="confirm">Confirm</button>';
    });
    const result = await resolveTarget(
      page,
      targetFor(snapshot, node),
      snapshot,
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.reasonCode, 'VERSION_CONFLICT');
  });
});

test('a target recreated inside a replaced SPA subtree is still refused', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<div id="app"><div id="page"><div id="slot"><button data-testid="confirm">Confirm</button></div></div></div>',
    );
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const node = snapshot.nodes.find((n) => n.nodeId === 'testid_confirm');
    assert.ok(node);
    // The whole route subtree is replaced, so the target's parent is new too.
    await page.evaluate(() => {
      document.querySelector('#app').innerHTML =
        '<div id="page"><div id="slot"><button data-testid="confirm">Confirm</button></div></div>';
    });
    const result = await resolveTarget(
      page,
      targetFor(snapshot, node),
      snapshot,
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.reasonCode, 'VERSION_CONFLICT');
  });
});

test('a same-name element revealed by an ancestor visibility swap is refused', async () => {
  await withPage(async (page) => {
    await page.setContent(`<div id="panel-a"><button>Confirm</button></div>
      <div id="panel-b" style="display:none"><button>Confirm</button></div>`);
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const visible = snapshot.nodes.find(
      (n) => n.visible && n.role === 'button',
    );
    assert.ok(visible, 'the snapshot contains the visible button');
    // The page swaps panels through ancestor style only; neither button is
    // mutated, so only object identity can tell the locator rebound.
    await page.evaluate(() => {
      document.querySelector('#panel-a').style.display = 'none';
      document.querySelector('#panel-b').style.display = '';
    });
    const result = await resolveTarget(
      page,
      targetFor(snapshot, visible),
      snapshot,
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.reasonCode, 'VERSION_CONFLICT');
    // A fresh observation of the now-visible button is actionable.
    const fresh = await captureBrowserSnapshot(page, {
      pageId: snapshot.pageId,
      stateVersion: 2,
    });
    const revealed = fresh.nodes.find((n) => n.visible && n.role === 'button');
    assert.ok(revealed);
    assert.equal(
      (await resolveTarget(page, targetFor(fresh, revealed), fresh)).status,
      'resolved',
    );
  });
});

test('a same-name element revealed after the snapshot element was removed is refused', async () => {
  await withPage(async (page) => {
    await page.setContent(`<div id="panel-a"><button>Confirm</button></div>
      <div id="panel-b" style="display:none"><button>Confirm</button></div>`);
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const visible = snapshot.nodes.find(
      (n) => n.visible && n.role === 'button',
    );
    assert.ok(visible);
    await page.evaluate(() => {
      document.querySelector('#panel-a').remove();
      document.querySelector('#panel-b').style.display = '';
    });
    const result = await resolveTarget(
      page,
      targetFor(snapshot, visible),
      snapshot,
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.reasonCode, 'VERSION_CONFLICT');
  });
});

test('a removed target is still refused', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<div id="slot"><button data-testid="confirm">Confirm</button></div>',
    );
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const node = snapshot.nodes.find((n) => n.nodeId === 'testid_confirm');
    assert.ok(node);
    await page.evaluate(() =>
      document.querySelector('#slot').replaceChildren(),
    );
    const result = await resolveTarget(
      page,
      targetFor(snapshot, node),
      snapshot,
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.reasonCode, 'TARGET_NOT_FOUND');
  });
});

test('a duplicated target binds the element the snapshot pinned', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<div id="slot"><button data-testid="confirm">Original</button></div>',
    );
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const node = snapshot.nodes.find((n) => n.nodeId === 'testid_confirm');
    assert.ok(node);
    // A look-alike appears after the observation. The snapshot recorded the
    // first button's object identity, so the model's node still names one
    // element — the one it meant — and no locator uniqueness is needed.
    await page.evaluate(() => {
      const second = document.createElement('button');
      second.dataset.testid = 'confirm';
      second.textContent = 'Original';
      second.id = 'lookalike';
      document.body.append(second);
    });
    const result = await resolveTarget(
      page,
      targetFor(snapshot, node),
      snapshot,
    );
    assert.equal(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    try {
      const clickedId = await result.elementHandle.evaluate(
        (element) => element.id,
      );
      assert.equal(clickedId, '', 'the pinned original, not the look-alike');
    } finally {
      await result.elementHandle.dispose().catch(() => undefined);
    }
  });
});

test('without a pinned element a duplicated target is still refused as ambiguous', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<div id="slot"><button data-testid="confirm">Confirm</button></div>',
    );
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const node = snapshot.nodes.find((n) => n.nodeId === 'testid_confirm');
    assert.ok(node);
    // Evict this observation's DOM witness/registry: any snapshot taken through
    // a path without a registry behaves the same way, and locator uniqueness is
    // then the only evidence available.
    for (let index = 0; index < 13; index += 1)
      await captureBrowserSnapshot(page, { pageId: snapshot.pageId });
    await page.evaluate(() => {
      const second = document.createElement('button');
      second.dataset.testid = 'confirm';
      second.textContent = 'Confirm';
      document.body.append(second);
    });
    const result = await resolveTarget(
      page,
      targetFor(snapshot, node),
      snapshot,
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.reasonCode, 'TARGET_AMBIGUOUS');
  });
});

test('the target witness ignores unrelated churn but catches a remount', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<div id="slot"><button data-testid="confirm">Confirm</button></div><div id="other"></div>',
    );
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const handle = await page.getByTestId('confirm').elementHandle();
    await page.evaluate(() => {
      document.title = 'later';
      document.querySelector('#other').append(document.createElement('i'));
    });
    assert.equal(
      await snapshotTargetUnchanged(
        page,
        snapshot.snapshotId,
        'main',
        page.mainFrame(),
        handle,
      ),
      true,
    );
    await page.evaluate(() => {
      document.querySelector('#slot').innerHTML =
        '<button data-testid="confirm">Confirm</button>';
    });
    assert.equal(
      await snapshotTargetUnchanged(
        page,
        snapshot.snapshotId,
        'main',
        page.mainFrame(),
        handle,
      ),
      false,
    );
    await handle.dispose();
  });
});

test('the session executor acts on an approved field after unrelated page churn', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(TWO_FIELDS);
    const snapshot = await session.getSnapshot({ forceFresh: true });
    await page.evaluate(() => {
      document.title = 'late title';
      const mask = document.createElement('div');
      mask.className = 'el-loading-mask';
      document.body.append(mask);
    });
    const account = snapshot.nodes.find((n) => n.name === '请输入账号');
    assert.ok(account);
    const result = await session.executeTool({
      name: 'type_text',
      args: { target: targetFor(snapshot, account), text: 'smoke_user_114' },
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(await page.inputValue('#account'), 'smoke_user_114');
  } finally {
    await session.close();
    await manager.close();
  }
});

test('a transient alert rendered after a mutating click is part of the action observation', async () => {
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/login') {
      setTimeout(() => {
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end('{}');
      }, 700);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><button data-testid="submit">登录</button>
      <script>
        document.querySelector('[data-testid=submit]').addEventListener('click', async () => {
          await fetch('/login', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' });
          const alert = document.createElement('div');
          alert.setAttribute('role', 'alert');
          alert.textContent = '用户名或密码错误';
          document.body.append(alert);
          setTimeout(() => alert.remove(), 1500);
        });
      </script>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'full',
  });
  try {
    const page = session.getPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const submit = snapshot.nodes.find((n) => n.nodeId === 'testid_submit');
    assert.ok(submit);
    const result = await session.executeTool({
      name: 'click',
      args: { target: targetFor(snapshot, submit) },
    });
    assert.equal(result.status, 'succeeded');
    const observed = result.data;
    assert.ok(
      observed.nodes.some(
        (node) =>
          node.role === 'alert' && node.name.includes('用户名或密码错误'),
      ),
      `transient alert missing from observation: ${JSON.stringify(observed.nodes)}`,
    );
  } finally {
    await session.close();
    await manager.close();
    server.close();
    await once(server, 'close');
  }
});

test('capture does not invalidate the observation the model is acting on', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(
      '<input placeholder="账号"><button data-testid="submit">登录</button>',
    );
    const before = await session.getSnapshot({ forceFresh: true });
    const account = before.nodes.find((n) => n.name === '账号');
    assert.ok(account);
    const captured = await session.executeTool({
      name: 'capture',
      args: { pageId: session.activePageId, reason: 'evidence' },
    });
    assert.equal(captured.status, 'succeeded');
    assert.equal(
      (await session.getSnapshot()).snapshotId,
      before.snapshotId,
      'capture must not replace the current snapshot',
    );
    const typed = await session.executeTool({
      name: 'type_text',
      args: { target: targetFor(before, account), text: 'smoke_user_114' },
    });
    assert.equal(typed.status, 'succeeded');
    assert.equal(await page.inputValue('input'), 'smoke_user_114');
  } finally {
    await session.close();
    await manager.close();
  }
});

test('a target replaced between observe and capture is still refused', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(
      '<div id="slot"><button data-testid="confirm">Confirm</button></div>',
    );
    const before = await session.getSnapshot({ forceFresh: true });
    const node = before.nodes.find((n) => n.nodeId === 'testid_confirm');
    assert.ok(node);
    await page.evaluate(() => {
      document.querySelector('#slot').innerHTML =
        '<button data-testid="confirm">Confirm</button>';
    });
    const captured = await session.executeTool({
      name: 'capture',
      args: { pageId: session.activePageId, reason: 'evidence' },
    });
    assert.equal(captured.status, 'succeeded');
    const clicked = await session.executeTool({
      name: 'click',
      args: { target: targetFor(before, node) },
    });
    assert.equal(clicked.status, 'failed');
    assert.equal(clicked.reasonCode, 'VERSION_CONFLICT');
  } finally {
    await session.close();
    await manager.close();
  }
});

test('a complete DOM is not marked truncated when summaries overflow', async () => {
  await withPage(async (page) => {
    await page.setContent('<button data-testid="confirm">Confirm</button>');
    const recorder = new SessionRecorder({
      ...identity(),
      maxConsoleSummary: 1,
    });
    recorder.attachToPage(page);
    for (let index = 0; index < 5; index += 1)
      await page.evaluate((value) => console.log(`log ${value}`), index);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
      recorder,
    });
    assert.equal(snapshot.truncated, false);
    assert.equal(recorder.getSnapshotSummaries().truncated, true);
  });
});

test('typing between two submissions is not mistaken for a repeated click', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(
      '<input data-testid="account" placeholder="账号"><input data-testid="password" type="password" placeholder="密码"><button data-testid="login-button" type="button">登录</button>',
    );
    const act = async (name, nodeId, extra = {}) => {
      const current = await session.getSnapshot();
      const node = current.nodes.find((n) => n.nodeId === nodeId);
      assert.ok(node, `${nodeId} present in the current observation`);
      return session.executeTool({
        name,
        args: { target: targetFor(current, node), ...extra },
      });
    };
    assert.equal(
      (await act('click', 'testid_login-button')).status,
      'succeeded',
    );
    assert.equal(
      (await act('type_text', 'testid_account', { text: 'smoke_user_114' }))
        .status,
      'succeeded',
    );
    assert.equal(
      (await act('click', 'testid_login-button')).status,
      'succeeded',
    );
    assert.equal(
      (await act('type_text', 'testid_password', { text: 'WrongPwd_123' }))
        .status,
      'succeeded',
    );
    assert.equal(
      (await act('click', 'testid_login-button')).status,
      'succeeded',
    );
  } finally {
    await session.close();
    await manager.close();
  }
});

test('repeated clicks on an unchanged page are still stopped, and a state change clears it', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(
      '<input data-testid="account" placeholder="账号"><button data-testid="login-button" type="button">登录</button>',
    );
    const act = async (name, nodeId, extra = {}) => {
      const current = await session.getSnapshot();
      const node = current.nodes.find((n) => n.nodeId === nodeId);
      assert.ok(node);
      return session.executeTool({
        name,
        args: { target: targetFor(current, node), ...extra },
      });
    };
    assert.equal(
      (await act('click', 'testid_login-button')).status,
      'succeeded',
    );
    assert.equal(
      (await act('click', 'testid_login-button')).status,
      'succeeded',
    );
    const stopped = await act('click', 'testid_login-button');
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.reasonCode, 'REPEATED_ACTION_LIMIT');
    // A successful state-changing action clears the consecutive run.
    assert.equal(
      (await act('type_text', 'testid_account', { text: 'smoke_user_114' }))
        .status,
      'succeeded',
    );
    assert.equal(
      (await act('click', 'testid_login-button')).status,
      'succeeded',
    );
  } finally {
    await session.close();
    await manager.close();
  }
});
