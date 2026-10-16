// The deployed web container must never let a browser reuse an old index.html:
// after a redeploy the cached HTML points at a removed hashed bundle. Hashed
// /assets/* stay immutable; HTML and every SPA fallback revalidate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const entry = fileURLToPath(
  new URL('../../../deploy/images/web-entry.mjs', import.meta.url),
);

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('web container revalidates HTML/SPA routes and long-caches hashed assets', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'localqa-web-cache-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(
    join(dist, 'index.html'),
    '<!doctype html><script src="/assets/index-abc12345.js"></script>',
  );
  writeFileSync(join(dist, 'assets', 'index-abc12345.js'), 'console.log(1)');
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, WEB_DIST_DIR: dist, WEB_PORT: String(port) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        up = (await fetch(`${base}/healthz`)).ok;
      } catch {
        await delay(100);
      }
    }
    assert.ok(up, 'web-entry did not start');

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.equal(
      index.headers.get('cache-control'),
      'no-cache, no-store, must-revalidate',
    );

    const asset = await fetch(`${base}/assets/index-abc12345.js`);
    assert.equal(asset.status, 200);
    assert.equal(
      asset.headers.get('cache-control'),
      'public, max-age=31536000, immutable',
    );

    const spa = await fetch(`${base}/runs/some-client-route`);
    assert.equal(spa.status, 200);
    assert.match(spa.headers.get('content-type'), /text\/html/);
    assert.equal(
      spa.headers.get('cache-control'),
      'no-cache, no-store, must-revalidate',
    );

    // A missing asset still falls back to index.html: never mark it immutable.
    const missing = await fetch(`${base}/assets/index-missing.js`);
    assert.equal(missing.status, 200);
    assert.match(missing.headers.get('content-type'), /text\/html/);
    assert.equal(
      missing.headers.get('cache-control'),
      'no-cache, no-store, must-revalidate',
    );
  } finally {
    child.kill('SIGTERM');
    rmSync(dist, { recursive: true, force: true });
  }
});
