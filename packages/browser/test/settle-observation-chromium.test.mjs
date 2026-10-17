// Real Chromium: an action returns an observation of the page *after* it stopped
// rearranging. A validation message that is still leaving its transition (the
// 66 case: a 0.43 s snapshot showed "请输入密码" for a field that was already
// filled) must not appear in the action's snapshot, a notice that lives ~1.5 s
// must still be captured, and a page that keeps mutating must not stall the
// action beyond the settle cap.
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

const texts = (snapshot) =>
  snapshot.nodes
    .filter((node) => node.visible && node.role === 'statictext')
    .map((node) => node.name);

const clickButton = async (browser, label = '登录') => {
  const before = await browser.getSnapshot({ forceFresh: true });
  const button = before.nodes.find(
    (node) => node.role === 'button' && node.name === label,
  );
  assert.ok(button, `button ${label} is visible`);
  const started = Date.now();
  const result = await browser.executeTool({
    name: 'click',
    args: { target: target(before, button) },
  });
  return { before, result, elapsedMs: Date.now() - started };
};

// Element's leave transition: the item keeps its box for ~300 ms and is removed
// from the DOM afterwards, while the click immediately renders the new state.
const LEAVE_TRANSITION = `<!doctype html><html><head><style>
  .hint { transition: opacity 300ms ease; }
  .hint.leaving { opacity: 0; }
</style></head><body><main>
  <form id="form">
    <div class="item"><input id="user" placeholder="请输入账号">
      <div class="hint" id="user-hint">请输入账号</div></div>
    <div class="item"><input id="pass" type="password" placeholder="请输入密码" value="WrongPwd_123">
      <div class="hint" id="pass-hint">请输入密码</div></div>
    <button type="button" id="go">登录</button>
  </form>
</main>
<script>
  document.getElementById('go').addEventListener('click', () => {
    // The password is no longer empty: its hint leaves with a transition and is
    // removed from the DOM when the transition ends, exactly like Element.
    const passHint = document.getElementById('pass-hint');
    passHint.classList.add('leaving');
    setTimeout(() => passHint.remove(), 300);
  });
</script></body></html>`;

test('the action observation is taken after the leave transition finished', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(LEAVE_TRANSITION);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({ name: 'navigate', args: { url: host.origin } });
    const { result, elapsedMs } = await clickButton(browser);
    assert.equal(result.status, 'succeeded');
    // The departed hint is gone from the returned observation, not "still
    // leaving": the wait covered the 300 ms transition plus its removal.
    assert.deepEqual(texts(result.data), ['请输入账号']);
    assert.equal(result.data.settled, undefined, 'the page had settled');
    assert.ok(
      elapsedMs >= 300,
      `the click waited for the transition (took ${elapsedMs} ms)`,
    );
    // The password field itself is still there.
    const password = result.data.nodes.find((node) => node.role === 'password');
    assert.equal(password.placeholder, '请输入密码');
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

const FLASH_NOTICE = `<!doctype html><html><body><main>
  <form>
    <div class="item"><input id="user" placeholder="请输入账号"></div>
    <button type="button" id="go">登录</button>
  </form>
  <div id="toast" role="status" hidden>登录失败，请检查账号</div>
</main>
<script>
  document.getElementById('go').addEventListener('click', () => {
    const toast = document.getElementById('toast');
    toast.hidden = false;
    // A notice that lives 1.5 s: far longer than the settle window, so the
    // action's observation must contain it.
    setTimeout(() => toast.remove(), 1500);
  });
</script></body></html>`;

test('a notice that lives ~1.5 s is still part of the action observation', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(FLASH_NOTICE);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({ name: 'navigate', args: { url: host.origin } });
    const before = await browser.getSnapshot({ forceFresh: true });
    assert.deepEqual(
      before.nodes.filter((node) => node.role === 'status' && node.visible),
      [],
    );
    const { result, elapsedMs } = await clickButton(browser);
    const notice = result.data.nodes.find(
      (node) => node.role === 'status' && node.name === '登录失败，请检查账号',
    );
    assert.ok(notice, 'the transient notice is in the observation');
    assert.ok(
      elapsedMs < 1500,
      `the settle did not wait for the notice to expire (${elapsedMs} ms)`,
    );
    // It is gone from the page by report time, which is what makes it
    // "appeared then disappeared" for the report.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const later = await browser.getSnapshot({ forceFresh: true });
    assert.deepEqual(
      later.nodes.filter((node) => node.role === 'status' && node.visible),
      [],
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

const CHURNING = `<!doctype html><html><body><main>
  <form>
    <div class="item"><input id="user" placeholder="请输入账号"></div>
    <button type="button" id="go">登录</button>
  </form>
  <ul id="list"></ul>
</main>
<script>
  // A page that keeps restructuring itself (live list): the settle can never see
  // a quiet window, so it must stop at the cap and say the page was not stable.
  const list = document.getElementById('list');
  setInterval(() => {
    const item = document.createElement('li');
    item.textContent = '心跳 ' + Date.now();
    list.append(item);
    if (list.children.length > 5) list.firstElementChild.remove();
  }, 100);
</script></body></html>`;

test('a page that keeps mutating stops at the settle cap and says so', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(CHURNING);
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({ name: 'navigate', args: { url: host.origin } });
    const { result, elapsedMs } = await clickButton(browser);
    assert.equal(result.status, 'succeeded');
    assert.equal(
      result.data.settled,
      false,
      'the observation admits it is not settled',
    );
    // The cap (1.5 s) plus the click's own overhead, never unbounded.
    assert.ok(
      elapsedMs < 3000,
      `the action stayed bounded (took ${elapsedMs} ms)`,
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});
