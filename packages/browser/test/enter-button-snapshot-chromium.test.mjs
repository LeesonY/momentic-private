import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { captureBrowserSnapshot } from '../dist/index.js';

async function withPage(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await run(page);
  } finally {
    await browser.close();
  }
}

/** The 114 login card: the button sits outside the form, no native submit. */
const LOGIN_114 = `<div class="login-card">
  <form class="el-form el-form--default">
    <input type="text" placeholder="请输入账号" class="el-input__inner">
    <input type="password" placeholder="请输入密码" class="el-input__inner">
  </form>
  <button type="button" class="fc-button">登录</button>
</div>`;

test('the snapshot records the button a plain Enter would activate', async () => {
  const cases = [
    {
      name: '114 card: one button outside the form',
      html: LOGIN_114,
      input: (node) => node.role === 'password',
      expected: (nodes) => nodes.find((node) => node.role === 'button')?.nodeId,
    },
    {
      name: 'native form submit button',
      html: '<form><input placeholder="请输入账号"><button type="submit">登录</button></form>',
      input: (node) => node.placeholder === '请输入账号',
      expected: (nodes) => nodes.find((node) => node.role === 'button')?.nodeId,
    },
    {
      name: 'two buttons in the card are ambiguous',
      html: '<div class="card"><input placeholder="请输入账号"><button>登录</button><button>取消</button></div>',
      input: (node) => node.placeholder === '请输入账号',
      expected: () => undefined,
    },
    {
      name: 'a dialog without a button does not borrow one from outside',
      html: '<div role="dialog"><input placeholder="请输入账号"></div><button>登录</button>',
      input: (node) => node.placeholder === '请输入账号',
      expected: () => undefined,
    },
    {
      name: 'a dialog with one button is the outermost scope',
      html: '<div role="dialog"><input placeholder="请输入账号"><button>登录</button></div><button>外面</button>',
      input: (node) => node.placeholder === '请输入账号',
      expected: (nodes) =>
        nodes.find((node) => node.role === 'button' && node.name === '登录')
          ?.nodeId,
    },
  ];
  for (const entry of cases) {
    await withPage(async (page) => {
      await page.setContent(entry.html);
      const snapshot = await captureBrowserSnapshot(page, {
        pageId: randomUUID(),
      });
      const input = snapshot.nodes.find(entry.input);
      assert.ok(input, `${entry.name}: input present`);
      assert.equal(
        input.enterButtonNodeId,
        entry.expected(snapshot.nodes),
        entry.name,
      );
    });
  }
});
