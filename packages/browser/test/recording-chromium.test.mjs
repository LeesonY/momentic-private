// Real Chromium: task recording must be replayable without leaking input
// values, hidden fields or URL query/fragment strings.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { BrowserManager } from '../dist/index.js';

const USER_VALUE = 'user-value-abc';
const PASSWORD_VALUE = 'password-value-xyz';
const HIDDEN_VALUE = 'hidden-value-xyz';
const QUERY_VALUE = 'secret-query-xyz';
const FRAGMENT_VALUE = 'secret-fragment-xyz';

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

function page() {
  return `<!doctype html><html><body>
    <h1>Recording fixture</h1>
    <input id="user" type="text" placeholder="账号" />
    <input id="pass" type="password" placeholder="密码" />
    <input id="hidden" type="hidden" value="${HIDDEN_VALUE}" />
    <button type="button">登录</button>
    <script>
      console.log('console marker');
      fetch('/api/data?token=${QUERY_VALUE}&visible=1').catch(() => {});
      fetch('/api/fail?token=${QUERY_VALUE}').catch(() => {});
    </script>
  </body></html>`;
}

async function session(manager, origin, extra = {}) {
  return manager.createSession({
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    allowedOrigins: [origin],
    mode: 'non_submitting',
    enableRecording: true,
    ...extra,
  });
}

const flush = async (browser) => {
  await browser
    .getPage()
    .evaluate(() => globalThis.__localqa_rrweb_flush?.())
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 250));
};

test('recording keeps replay snapshots but no input, hidden or URL secrets', async () => {
  const host = await listen((req, res) => {
    if (req.url?.startsWith('/api/fail')) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"error":"failed"}');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page());
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    await browser.executeTool({
      name: 'navigate',
      args: {
        url: `${host.origin}/login?token=${QUERY_VALUE}#${FRAGMENT_VALUE}`,
      },
    });
    await browser.executeTool({
      name: 'type_text',
      args: {
        target: (await browser.getSnapshot({ forceFresh: true })).nodes.find(
          (node) => node.placeholder === '账号',
        ),
        text: USER_VALUE,
      },
    });
    await browser.executeTool({
      name: 'type_text',
      args: {
        target: (await browser.getSnapshot({ forceFresh: true })).nodes.find(
          (node) => node.role === 'password',
        ),
        text: PASSWORD_VALUE,
      },
    });
    await browser.executeTool({
      name: 'navigate',
      args: {
        url: `${host.origin}/next?token=${QUERY_VALUE}#${FRAGMENT_VALUE}`,
      },
    });
    await flush(browser);
    const recording = browser.getRecording();
    assert.ok(recording);
    assert.notEqual(recording.status, 'degraded');
    assert.ok(recording.events.length > 0);
    assert.ok(
      recording.events.filter((event) => event.type === 2).length >= 2,
      'a new document emits another full snapshot',
    );
    const serialized = JSON.stringify(recording.events);
    for (const secret of [
      USER_VALUE,
      PASSWORD_VALUE,
      HIDDEN_VALUE,
      QUERY_VALUE,
      FRAGMENT_VALUE,
    ])
      assert.equal(serialized.includes(secret), false, secret);

    assert.ok(
      recording.consoleEntries.some((entry) =>
        entry.text.includes('console marker'),
      ),
    );
    for (const entry of recording.consoleEntries) {
      assert.ok(Number.isFinite(Date.parse(entry.at)));
      assert.ok(entry.text.length <= 500);
    }
    assert.ok(
      recording.networkEntries.some((entry) => entry.url.endsWith('/api/data')),
    );
    for (const entry of recording.networkEntries) {
      assert.equal(entry.url.includes('?'), false);
      assert.equal(entry.url.includes('#'), false);
      assert.ok(Number.isFinite(Date.parse(entry.at)));
    }
    assert.ok(Number.isFinite(Date.parse(recording.startedAt)));
    assert.ok(Number.isFinite(Date.parse(recording.endedAt)));
    assert.deepEqual(recording.viewport, { width: 1280, height: 720 });
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('a recording binding failure degrades the recording without failing the browser', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page());
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin);
    browser.addRrwebEvents = () => {
      throw new Error('binding failed');
    };
    const result = await browser.executeTool({
      name: 'navigate',
      args: { url: host.origin },
    });
    assert.equal(result.status, 'succeeded');
    await flush(browser);
    const recording = browser.getRecording();
    assert.equal(recording.status, 'degraded');
    assert.match(recording.error, /binding failed/);
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});

test('an over-limit recording stops and keeps the recorded part as degraded', async () => {
  const host = await listen((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page());
  });
  const manager = new BrowserManager();
  try {
    const browser = await session(manager, host.origin, {
      maxRecordingBytes: 1000,
    });
    await browser.executeTool({
      name: 'navigate',
      args: { url: host.origin },
    });
    await flush(browser);
    const recording = browser.getRecording();
    assert.equal(recording.status, 'degraded');
    assert.match(recording.error, /exceeded 1000 bytes/);
    assert.ok(recording.events.length > 0);
    await browser.close();
  } finally {
    await manager.close();
    await host.close();
  }
});
