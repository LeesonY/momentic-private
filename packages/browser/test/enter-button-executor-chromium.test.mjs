/* global document, window */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BrowserManager } from '../dist/index.js';

function identity() {
  return {
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
  };
}

function targetFor(snapshot, node) {
  return {
    snapshotId: snapshot.snapshotId,
    pageId: snapshot.pageId,
    nodeId: node.nodeId,
    frameId: node.frameId,
  };
}

/** The 114 login card: the button sits outside the form, no native submit. */
const LOGIN_114 = `<div class="login-card">
  <form class="el-form el-form--default">
    <input type="text" placeholder="请输入账号" class="el-input__inner">
    <input type="password" placeholder="请输入密码" class="el-input__inner">
  </form>
  <button type="button" class="fc-button">登录</button>
</div>`;

test('a plain Enter runs the page keyup handler through the equivalent button', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(
      `${LOGIN_114}<script>window.enterCount = 0;
        document.addEventListener('keyup', (event) => {
          if (event.key === 'Enter') window.enterCount++;
        });</script>`,
    );
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const password = snapshot.nodes.find((node) => node.role === 'password');
    assert.ok(password?.enterButtonNodeId, 'snapshot records the button');
    const result = await session.executeTool({
      name: 'press',
      args: { target: targetFor(snapshot, password), key: 'Enter' },
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(await page.evaluate(() => window.enterCount), 1);
  } finally {
    await session.close();
    await manager.close();
  }
});

test('a plain Enter is refused when the equivalent button is a business save', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(
      '<div class="card"><input placeholder="请输入账号"><button>保存</button></div>',
    );
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const input = snapshot.nodes.find(
      (node) => node.placeholder === '请输入账号',
    );
    assert.ok(input?.enterButtonNodeId);
    const result = await session.executeTool({
      name: 'press',
      args: { target: targetFor(snapshot, input), key: 'Enter' },
    });
    assert.equal(result.status, 'denied');
    assert.equal(result.reasonCode, 'POLICY_DENIED');
  } finally {
    await session.close();
    await manager.close();
  }
});

test('a plain Enter is refused when there is no equivalent button', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(
      '<div class="card"><input placeholder="请输入账号"></div>',
    );
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const input = snapshot.nodes.find(
      (node) => node.placeholder === '请输入账号',
    );
    assert.equal(input.enterButtonNodeId, undefined);
    const result = await session.executeTool({
      name: 'press',
      args: { target: targetFor(snapshot, input), key: 'Enter' },
    });
    assert.equal(result.status, 'denied');
    assert.equal(result.reasonCode, 'POLICY_DENIED');
  } finally {
    await session.close();
    await manager.close();
  }
});

test('a remounted equivalent button is a version conflict', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(LOGIN_114);
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const password = snapshot.nodes.find((node) => node.role === 'password');
    assert.ok(password?.enterButtonNodeId);
    await page.evaluate(() => {
      const button = document.querySelector('.fc-button');
      button.outerHTML = '<button type="button" class="fc-button">登录</button>';
    });
    const result = await session.executeTool({
      name: 'press',
      args: { target: targetFor(snapshot, password), key: 'Enter' },
    });
    assert.equal(result.status, 'denied');
    assert.equal(result.reasonCode, 'VERSION_CONFLICT');
  } finally {
    await session.close();
    await manager.close();
  }
});

test('a label that turned destructive after the snapshot is still refused', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(LOGIN_114);
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const password = snapshot.nodes.find((node) => node.role === 'password');
    assert.ok(password?.enterButtonNodeId);
    await page.evaluate(() => {
      document.querySelector('.fc-button').textContent = '保存';
    });
    const result = await session.executeTool({
      name: 'press',
      args: { target: targetFor(snapshot, password), key: 'Enter' },
    });
    assert.equal(result.status, 'denied');
    assert.equal(result.reasonCode, 'POLICY_DENIED');
  } finally {
    await session.close();
    await manager.close();
  }
});

test('Tab keeps working without an equivalent button', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    ...identity(),
    mode: 'non_submitting',
  });
  try {
    const page = session.getPage();
    await page.setContent(LOGIN_114);
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const account = snapshot.nodes.find((node) => node.role === 'text');
    assert.ok(account);
    const result = await session.executeTool({
      name: 'press',
      args: { target: targetFor(snapshot, account), key: 'Tab' },
    });
    assert.equal(result.status, 'succeeded');
  } finally {
    await session.close();
    await manager.close();
  }
});

// A real SPA handles Enter itself (the 114 page does) and suppresses the
// browser's implicit form submission, which would otherwise reload the page.
const KEYUP_HANDLER = `<script>window.enterCount = 0;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault();
  });
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Enter') window.enterCount++;
  });</script>`;
const NO_BUTTON_PAGE = `<div class="card"><input placeholder="账号"></div>${KEYUP_HANDLER}`;
// The button is the input's sibling's sibling, not its sibling: remounting it
// must not dirty the target's own witness (the form), so the test reaches the
// equivalent-button check.
const FORM_BUTTON_PAGE = `<div class="card"><form><input placeholder="账号"></form><button>登录</button></div>${KEYUP_HANDLER}`;

async function withServer(html, run) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('an approved workflow inside its write scope keeps Enter unrestricted', async () => {
  await withServer(NO_BUTTON_PAGE, async (origin) => {
    const manager = new BrowserManager();
    const session = await manager.createSession({
      ...identity(),
      mode: 'approved_workflows',
      allowedOrigins: [origin],
      writeScope: [origin],
    });
    try {
      await session.executeTool({ name: 'navigate', args: { url: origin } });
      const snapshot = await session.getSnapshot();
      const input = snapshot.nodes.find((node) => node.placeholder === '账号');
      assert.ok(input);
      // No equivalent button at all: the old policy never restricted Enter
      // inside the write scope, so this must still run.
      assert.equal(input.enterButtonNodeId, undefined);
      const result = await session.executeTool({
        name: 'press',
        args: { target: targetFor(snapshot, input), key: 'Enter' },
      });
      assert.equal(result.status, 'succeeded');
      assert.equal(await session.getPage().evaluate(() => window.enterCount), 1);
    } finally {
      await session.close();
      await manager.close();
    }
  });
});

test('an approved workflow inside its write scope ignores a remounted equivalent button', async () => {
  await withServer(FORM_BUTTON_PAGE, async (origin) => {
    const manager = new BrowserManager();
    const session = await manager.createSession({
      ...identity(),
      mode: 'approved_workflows',
      allowedOrigins: [origin],
      writeScope: [origin],
    });
    try {
      await session.executeTool({ name: 'navigate', args: { url: origin } });
      const snapshot = await session.getSnapshot();
      const input = snapshot.nodes.find((node) => node.placeholder === '账号');
      assert.ok(input?.enterButtonNodeId);
      await session.getPage().evaluate(() => {
        const button = document.querySelector('button');
        button.outerHTML = '<button>登录</button>';
      });
      const result = await session.executeTool({
        name: 'press',
        args: { target: targetFor(snapshot, input), key: 'Enter' },
      });
      assert.equal(result.status, 'succeeded');
      assert.equal(await session.getPage().evaluate(() => window.enterCount), 1);
    } finally {
      await session.close();
      await manager.close();
    }
  });
});

test('an approved workflow outside its write scope still judges the equivalent button', async () => {
  await withServer(NO_BUTTON_PAGE, async (origin) => {
    const manager = new BrowserManager();
    const session = await manager.createSession({
      ...identity(),
      mode: 'approved_workflows',
      allowedOrigins: [origin],
      writeScope: ['http://other.test/'],
    });
    try {
      await session.executeTool({ name: 'navigate', args: { url: origin } });
      const snapshot = await session.getSnapshot();
      const input = snapshot.nodes.find((node) => node.placeholder === '账号');
      assert.ok(input);
      const result = await session.executeTool({
        name: 'press',
        args: { target: targetFor(snapshot, input), key: 'Enter' },
      });
      assert.equal(result.status, 'denied');
      assert.equal(result.reasonCode, 'POLICY_DENIED');
      assert.equal(await session.getPage().evaluate(() => window.enterCount), 0);
    } finally {
      await session.close();
      await manager.close();
    }
  });
});
