/* global document, window */
import assert from 'node:assert/strict';
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
