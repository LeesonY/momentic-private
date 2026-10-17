// Real Chromium fixtures for what a user can actually read on the page:
// visible text that is not itself a control (a field's validation message, a
// note, body copy) and the current content of value-bearing controls. Sensitive
// values stay out, text nodes never crowd out controls, and clipping is still
// reported honestly through `truncated`.
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

const visibleText = (snapshot, text) =>
  snapshot.nodes.filter((node) => node.visible && node.name === text);

/** Only the read-only text node(s) carrying exactly this text. */
const textNodes = (snapshot, text) =>
  visibleText(snapshot, text).filter((node) => node.role === 'statictext');

const LOGIN_FORM = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
<style>
  .msg { display: none; }
  .msg.shown { display: block; }
  .msg.enter { opacity: 0.5; }
</style></head><body>
<main>
  <h2>登录</h2>
  <form id="login">
    <div class="el-form-item" id="item-user">
      <label for="user">账号</label>
      <input id="user" name="userName" placeholder="请输入账号">
      <div class="msg" id="user-msg">请输入账号</div>
    </div>
    <div class="el-form-item" id="item-pass">
      <input id="pass" name="passWord" type="password" placeholder="请输入密码">
      <div class="msg" id="pass-msg">请输入密码</div>
    </div>
    <div class="el-form-item" id="item-never">
      <input id="never" name="never" placeholder="第三个字段">
      <div class="msg" id="never-msg">这条提示从不显示</div>
    </div>
    <button type="button" id="go">登录</button>
  </form>
  <p id="note">本页仅用于验证快照，不会提交任何真实账号。</p>
</main>
<script>
  const show = (id) => {
    const el = document.getElementById(id);
    // Element-like: a transition class first, then the message stays.
    el.classList.add('enter');
    el.classList.add('shown');
    requestAnimationFrame(() => el.classList.remove('enter'));
  };
  document.getElementById('go').addEventListener('click', () => {
    show('user-msg');
    show('pass-msg');
  });
</script>
</body></html>`;

test('a visible validation message is observed and tied to its field', async () => {
  const host = await listen((req, res) => {
    if (req.url === '/login') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(LOGIN_FORM);
      return;
    }
    res.writeHead(404).end();
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({
      name: 'navigate',
      args: { url: `${host.origin}/login` },
    });
    const before = await browser.getSnapshot({ forceFresh: true });
    // Nothing is shown before the submit: no message text node yet.
    assert.deepEqual(textNodes(before, '请输入账号'), []);
    assert.deepEqual(textNodes(before, '这条提示从不显示'), []);
    const userBefore = before.nodes.find((node) => node.name === '账号');
    assert.ok(userBefore);
    assert.equal(userBefore.value, '');
    // The page's own copy is visible text a user can read.
    assert.ok(
      visibleText(before, '本页仅用于验证快照，不会提交任何真实账号。').length >
        0,
    );

    const clicked = await browser.executeTool({
      name: 'click',
      args: {
        target: target(
          before,
          before.nodes.find((node) => node.role === 'button'),
        ),
      },
    });
    assert.equal(clicked.status, 'succeeded');

    const after = await browser.getSnapshot({ forceFresh: true });
    const user = after.nodes.find(
      (node) => node.role === 'text' && node.name === '账号',
    );
    assert.ok(user, 'the account field is still observed');
    const userMessage = textNodes(after, '请输入账号');
    assert.equal(userMessage.length, 1, 'exactly one new message text node');
    assert.equal(userMessage[0].role, 'statictext');
    assert.equal(userMessage[0].text, '请输入账号');
    assert.equal(
      userMessage[0].relatedNodeId,
      user.nodeId,
      'the message points at the field it belongs to',
    );
    const pass = after.nodes.find((node) => node.role === 'password');
    assert.ok(pass);
    const passMessage = textNodes(after, '请输入密码');
    assert.equal(passMessage.length, 1);
    assert.equal(passMessage[0].relatedNodeId, pass.nodeId);
    // A message that is still display:none is not a text the user can read.
    assert.deepEqual(textNodes(after, '这条提示从不显示'), []);
    // A page-level sentence has no field to belong to.
    const note = visibleText(
      after,
      '本页仅用于验证快照，不会提交任何真实账号。',
    )[0];
    assert.ok(note);
    assert.equal(note.relatedNodeId, undefined);
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('a control reports its current value while a password never does', async () => {
  const host = await listen((req, res) => {
    if (req.url === '/login') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(LOGIN_FORM);
      return;
    }
    if (req.url === '/values') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><body><main>
        <textarea id="ta" placeholder="备注"></textarea>
        <select id="sel" aria-label="角色">
          <option>浏览者</option><option>管理员</option>
        </select>
        <input id="num" type="number">
        <input id="ro" value="只读内容" readonly>
      </main></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({
      name: 'navigate',
      args: { url: `${host.origin}/login` },
    });
    const start = await browser.getSnapshot({ forceFresh: true });
    const user = start.nodes.find(
      (node) => node.role === 'text' && node.name === '账号',
    );
    assert.ok(user);
    assert.equal(user.value, '', 'an empty box reports an empty value');
    assert.equal(user.name, '账号', 'the label stays in name');

    const typed = await browser.executeTool({
      name: 'type_text',
      args: { target: target(start, user), text: 'smoke_test_user' },
    });
    assert.equal(typed.status, 'succeeded');
    const afterType = await browser.getSnapshot({ forceFresh: true });
    const echoed = afterType.nodes.find((node) => node.nodeId === user.nodeId);
    assert.equal(echoed.value, 'smoke_test_user');
    assert.equal(echoed.name, '账号', 'value never replaces the label');

    // The password shows that it holds something, never the value itself.
    const password = afterType.nodes.find((node) => node.role === 'password');
    const secret = 'SENTINEL_PASSWORD_42';
    const filled = await browser.executeTool({
      name: 'type_text',
      args: { target: target(afterType, password), text: secret },
    });
    assert.equal(filled.status, 'succeeded');
    const afterPassword = await browser.getSnapshot({ forceFresh: true });
    const hidden = afterPassword.nodes.find(
      (node) => node.nodeId === password.nodeId,
    );
    assert.equal(hidden.value, '[redacted]');
    assert.equal(hidden.text, '[redacted]');
    assert.equal(hidden.sensitive, true);
    assert.equal(JSON.stringify(afterPassword).includes(secret), false);

    await browser.executeTool({
      name: 'navigate',
      args: { url: `${host.origin}/values` },
    });
    const values = await browser.getSnapshot({ forceFresh: true });
    const textarea = values.nodes.find((node) => node.role === 'textarea');
    assert.ok(textarea);
    assert.equal(textarea.value, '');
    const readOnly = values.nodes.find(
      (node) => node.role === 'text' && node.value === '只读内容',
    );
    assert.ok(readOnly);
    assert.equal(readOnly.value, '只读内容');
    const select = values.nodes.find((node) => node.role === 'select');
    assert.ok(select);
    assert.equal(select.value, '浏览者', 'a select reports its selected item');
    const selected = await browser.executeTool({
      name: 'select_option',
      args: { target: target(values, select), value: '管理员' },
    });
    assert.equal(selected.status, 'succeeded');
    const afterSelect = await browser.getSnapshot({ forceFresh: true });
    assert.equal(
      afterSelect.nodes.find((node) => node.nodeId === select.nodeId).value,
      '管理员',
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('visible text never crowds out controls and clipping stays honest', async () => {
  const lines = Array.from(
    { length: 3000 },
    (_, index) => `<div>正文第 ${index} 行</div>`,
  ).join('');
  const host = await listen((req, res) => {
    if (req.url === '/heavy') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><body><main>
        <button id="one">开始</button>
        <input id="search" type="search" placeholder="搜索">
        <button id="two">保存</button>
        ${lines}
        <button id="three">结束</button>
      </main></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({
      name: 'navigate',
      args: { url: `${host.origin}/heavy` },
    });
    const snapshot = await browser.getSnapshot({ forceFresh: true });
    const controls = snapshot.nodes.filter(
      (node) => node.role === 'button' || node.role === 'search',
    );
    assert.deepEqual(
      controls.map((node) => node.name),
      ['开始', '搜索', '保存', '结束'],
      'every interactive control survives the text budget',
    );
    assert.ok(
      snapshot.nodes.length <= 1000,
      `node budget respected (got ${snapshot.nodes.length})`,
    );
    const texts = snapshot.nodes.filter((node) => node.role === 'statictext');
    assert.ok(texts.length > 0, 'visible text is still observed');
    assert.ok(
      texts.length <= 400,
      `text budget respected (got ${texts.length})`,
    );
    assert.equal(
      snapshot.truncated,
      true,
      'a clipped observation reports truncation',
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('unreadable text never marks a complete observation as clipped', async () => {
  const hidden = Array.from(
    { length: 800 },
    (_, index) => `<div style="display:none">隐藏提示 ${index}</div>`,
  ).join('');
  const host = await listen((req, res) => {
    if (req.url === '/quiet') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><body><main>
        <button id="one">开始</button>
        <input id="q" placeholder="搜索">
        ${hidden}
      </main></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({
      name: 'navigate',
      args: { url: `${host.origin}/quiet` },
    });
    const snapshot = await browser.getSnapshot({ forceFresh: true });
    assert.deepEqual(
      snapshot.nodes
        .filter((node) => node.role === 'button')
        .map((n) => n.name),
      ['开始'],
    );
    assert.equal(
      snapshot.nodes
        .filter((node) => node.role === 'statictext')
        .some((node) => node.name.includes('隐藏提示')),
      false,
      'display:none text is never observed as a text node',
    );
    assert.equal(
      snapshot.truncated,
      false,
      'candidates that were never readable must not claim clipping',
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('hidden text never spends the candidate budget a visible notice needs', async () => {
  // A collapsed menu / unexpanded select ahead of the one visible notice is the
  // common real shape: 800 invisible strings, then the message that matters.
  const hidden = Array.from(
    { length: 800 },
    (_, index) => `<div style="display:none">隐藏多语言串 ${index}</div>`,
  ).join('');
  const host = await listen((req, res) => {
    if (req.url === '/trailing') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><body>
        ${hidden}
        <main><form>
          <div class="el-form-item">
            <input id="user" placeholder="请输入账号">
            <div class="el-form-item__error">请输入账号</div>
          </div>
        </form></main>
      </body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({
      name: 'navigate',
      args: { url: `${host.origin}/trailing` },
    });
    const snapshot = await browser.getSnapshot({ forceFresh: true });
    const message = textNodes(snapshot, '请输入账号');
    assert.equal(
      message.length,
      1,
      'the hidden strings did not use the budget',
    );
    const field = snapshot.nodes.find(
      (node) => node.role === 'text' && node.name === '请输入账号',
    );
    assert.ok(field);
    assert.equal(message[0].relatedNodeId, field.nodeId);
    assert.equal(
      snapshot.truncated,
      false,
      'nothing readable was dropped, so the observation is complete',
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('a field message survives a page of body copy and clipping is reported', async () => {
  const lines = Array.from(
    { length: 700 },
    (_, index) => `<p>正文第 ${index} 段</p>`,
  ).join('');
  const host = await listen((req, res) => {
    if (req.url === '/busy') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><body><main>
        ${lines}
        <form><div class="el-form-item">
          <input id="user" placeholder="请输入账号">
          <div class="el-form-item__error">请输入账号</div>
        </div></form>
      </main></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({
      name: 'navigate',
      args: { url: `${host.origin}/busy` },
    });
    const snapshot = await browser.getSnapshot({ forceFresh: true });
    const message = textNodes(snapshot, '请输入账号');
    assert.equal(
      message.length,
      1,
      'the field message outranks ordinary body copy',
    );
    const field = snapshot.nodes.find(
      (node) => node.role === 'text' && node.name === '请输入账号',
    );
    assert.ok(field);
    assert.equal(message[0].relatedNodeId, field.nodeId);
    const texts = snapshot.nodes.filter((node) =>
      ['statictext', 'paragraph', 'label', 'cell', 'listitem'].includes(
        node.role,
      ),
    );
    assert.ok(
      texts.length <= 400,
      `text budget respected (got ${texts.length})`,
    );
    assert.equal(
      snapshot.truncated,
      true,
      'dropped visible body copy is reported',
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test("a long form's labels cannot crowd out its validation message", async () => {
  const fields = Array.from(
    { length: 460 },
    (_, index) =>
      `<div class="item"><label>字段 ${index}</label><input id="f${index}" placeholder="字段 ${index}">${
        index === 450 ? '<div class="msg">此字段不能为空</div>' : ''
      }</div>`,
  ).join('');
  const host = await listen((req, res) => {
    if (req.url === '/labels') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><html><body><main><form>${fields}</form></main></body></html>`,
      );
      return;
    }
    res.writeHead(404).end();
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({
      name: 'navigate',
      args: { url: `${host.origin}/labels` },
    });
    const snapshot = await browser.getSnapshot({ forceFresh: true });
    const message = textNodes(snapshot, '此字段不能为空');
    assert.equal(message.length, 1, 'the message outranks the labels');
    const field = snapshot.nodes.find(
      (node) => node.value === '' && node.nodeId === message[0].relatedNodeId,
    );
    assert.ok(field, 'the message names a field that is in the snapshot');
    const labels = snapshot.nodes.filter((node) => node.role === 'label');
    assert.ok(labels.length < 460, 'labels were clipped, not the message');
    const texts = snapshot.nodes.filter((node) =>
      ['statictext', 'paragraph', 'label', 'cell', 'listitem'].includes(
        node.role,
      ),
    );
    assert.ok(texts.length <= 400);
    assert.equal(snapshot.truncated, true);
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('a placeholder stays its own field and an invalid control says so', async () => {
  // The 114 shape: the validation message repeats the placeholder word for word,
  // so only `placeholder` vs a rendered text node tells them apart.
  const host = await listen((req, res) => {
    if (req.url === '/same-text') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><style>
        .msg { display: none; }
        .msg.shown { display: block; }
      </style></head><body><main><form>
        <div class="item">
          <input id="user" placeholder="请输入账号">
          <div class="msg" id="user-msg">请输入账号</div>
        </div>
        <div class="item">
          <input id="pass" type="password" placeholder="请输入密码">
          <div class="msg" id="pass-msg">请输入密码</div>
        </div>
        <button type="button" id="go">登录</button>
      </form></main>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          for (const id of ['user', 'pass']) {
            document.getElementById(id).setAttribute('aria-invalid', 'true');
            document.getElementById(id + '-msg').classList.add('shown');
          }
        });
      </script></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({
      name: 'navigate',
      args: { url: `${host.origin}/same-text` },
    });
    const before = await browser.getSnapshot({ forceFresh: true });
    const textNodesBefore = before.nodes.filter(
      (node) => node.role === 'statictext' && node.name === '请输入账号',
    );
    assert.equal(textNodesBefore.length, 0, 'no message before the click');

    await browser.executeTool({
      name: 'click',
      args: {
        target: target(
          before,
          before.nodes.find((node) => node.role === 'button'),
        ),
      },
    });
    const after = await browser.getSnapshot({ forceFresh: true });
    const field = after.nodes.find(
      (node) => node.role === 'text' && node.placeholder === '请输入账号',
    );
    assert.ok(field, 'the control keeps its own placeholder field');
    assert.equal(field.name, '请输入账号');
    assert.equal(field.invalid, true, 'aria-invalid marks the control');
    const hints = after.nodes.filter(
      (node) => node.role === 'statictext' && node.name === '请输入账号',
    );
    assert.equal(hints.length, 1, 'the message is a rendered text node');
    assert.equal(hints[0].relatedNodeId, field.nodeId);
    assert.equal(hints[0].placeholder, undefined, 'a message is not a hint');
    // The password field reports the same two pieces.
    const password = after.nodes.find((node) => node.role === 'password');
    assert.equal(password.placeholder, '请输入密码');
    assert.equal(password.invalid, true);
    assert.equal(
      after.nodes.find(
        (node) => node.role === 'statictext' && node.name === '请输入密码',
      ).relatedNodeId,
      password.nodeId,
    );
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});
