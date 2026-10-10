import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { once } from 'node:events';
import { createRequestHandler } from '../dist/app.js';
import { Router } from '../dist/router.js';

async function withProbeServer(publicOrigin, check) {
  const router = new Router();
  router.get('/probe', async () => ({ ok: true }));
  router.post('/probe', async () => ({ ok: true }));
  const server = createServer(createRequestHandler({ publicOrigin }, router));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await check(`http://127.0.0.1:${address.port}/probe`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const approved = 'https://localqa.example.test:8443';
const hostile = 'https://untrusted.example.test';

test('credentialed CORS is only enabled for the configured frontend origin', async () => {
  await withProbeServer(approved, async (url) => {
    const accepted = await fetch(url, { headers: { Origin: approved } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('access-control-allow-origin'), approved);
    assert.equal(
      accepted.headers.get('access-control-allow-credentials'),
      'true',
    );
    assert.equal(accepted.headers.get('vary'), 'Origin');

    const denied = await fetch(url, { headers: { Origin: hostile } });
    assert.equal(denied.status, 200); // CORS rejects reading, not a GET side effect.
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.equal(denied.headers.get('access-control-allow-credentials'), null);
    assert.equal(denied.headers.get('vary'), 'Origin');

    const spoofedPort = await fetch(url, {
      headers: { Origin: 'https://localqa.example.test' },
    });
    assert.equal(spoofedPort.headers.get('access-control-allow-origin'), null);
  });
});

test('preflight rejects unapproved origins before browser credential use', async () => {
  await withProbeServer(approved, async (url) => {
    const good = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: approved,
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(good.status, 204);
    assert.equal(good.headers.get('access-control-allow-origin'), approved);

    const bad = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: hostile,
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });
});

test('missing or invalid PUBLIC_ORIGIN never authorizes credentialed CORS', async () => {
  for (const publicOrigin of [undefined, 'not-a-url']) {
    await withProbeServer(publicOrigin, async (url) => {
      const response = await fetch(url, { headers: { Origin: hostile } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(
        response.headers.get('access-control-allow-credentials'),
        null,
      );
    });
  }
});

test('same configured Origin still passes POST CSRF checks', async () => {
  await withProbeServer(approved, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Origin: approved },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test('POST rejects scheme downgrade on the same host even without a CORS read', async () => {
  await withProbeServer(approved, async (url) => {
    const downgraded = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'http://localqa.example.test:8443' },
    });
    assert.equal(downgraded.status, 403);
    assert.equal(downgraded.headers.get('access-control-allow-origin'), null);
  });
});
