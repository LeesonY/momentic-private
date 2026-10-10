import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  BrowserManager,
  createTrustedBrowserAuthPrimitives,
} from '../dist/index.js';

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

test('trusted auth primitives use real isolated Chromium, refuse stale targets and capture same-origin state', async () => {
  const host = await listen(async (req, res) => {
    if (req.url === '/login') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<form method="POST" action="/authenticate">' +
          '<input data-testid="username" name="username">' +
          '<input data-testid="password" name="password" type="password">' +
          '<button data-testid="submit" type="submit">Sign in</button></form>',
      );
    } else if (req.url === '/authenticate') {
      // Don't inspect or print the submitted credentials.
      for await (const _ of req) {
        /* Drain POST body. */
      }
      res.writeHead(303, {
        Location: '/private',
        'Set-Cookie': 'sid=private-session; Path=/; HttpOnly; SameSite=Lax',
      });
      res.end();
    } else if (req.url === '/private') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<main data-testid="signed-in">Authenticated</main>');
    } else {
      res.writeHead(404).end();
    }
  });
  const manager = new BrowserManager();
  try {
    const browserSession = await session(manager, host.origin);
    const trusted = createTrustedBrowserAuthPrimitives(browserSession, [
      host.origin,
    ]);
    const landed = await trusted.navigate(`${host.origin}/login`);
    assert.equal(landed.displayUrl, `${host.origin}/login`);
    const usernameTarget = await browserSession.resolveRegressionLocator({
      by: 'test_id',
      value: 'username',
    });
    await trusted.fill(usernameTarget, 'private-user');
    await assert.rejects(
      trusted.fill(usernameTarget, 'replayed'),
      (error) => error.code === 'VALIDATION_ERROR',
    );
    const passwordTarget = await browserSession.resolveRegressionLocator({
      by: 'test_id',
      value: 'password',
    });
    await trusted.fill(passwordTarget, 'private-pass');
    const submitTarget = await browserSession.resolveRegressionLocator({
      by: 'test_id',
      value: 'submit',
    });
    const result = await trusted.submit(submitTarget);
    assert.equal(result.displayUrl, `${host.origin}/private`);
    const state = await trusted.exportState();
    assert.equal(
      state.cookies?.find((cookie) => cookie.name === 'sid')?.value,
      'private-session',
    );

    const importSession = await session(manager, host.origin);
    const importer = createTrustedBrowserAuthPrimitives(importSession, [
      host.origin,
    ]);
    await importer.prepareState({
      cookies: state.cookies,
      origins: [
        {
          origin: host.origin,
          localStorage: [{ name: 'auth-scope', value: 'approved' }],
        },
      ],
    });
    await assert.rejects(
      importer.prepareState({ cookies: [] }),
      (error) => error.code === 'VALIDATION_ERROR',
    );
    await importer.navigate(`${host.origin}/private`);
    assert.equal(
      await importSession
        .getPage()
        .evaluate(() => globalThis.localStorage.getItem('auth-scope')),
      'approved',
    );
  } finally {
    await manager.close();
    await host.close();
  }
});

test('trusted Chromium auth route blocks an off-origin HTTP redirect before the foreign server sees it', async () => {
  let foreignHits = 0;
  const foreign = await listen((_req, res) => {
    foreignHits++;
    res.end('outside');
  });
  const host = await listen((_req, res) => {
    res.writeHead(302, { Location: `${foreign.origin}/steal` });
    res.end();
  });
  const manager = new BrowserManager();
  try {
    const browserSession = await session(manager, host.origin);
    const trusted = createTrustedBrowserAuthPrimitives(browserSession, [
      host.origin,
    ]);
    await assert.rejects(
      trusted.navigate(`${foreign.origin}/steal`),
      (error) => error.code === 'TARGET_NOT_ALLOWED',
    );
    await assert.rejects(trusted.navigate(`${host.origin}/redirect`));
    assert.equal(foreignHits, 0);
  } finally {
    await manager.close();
    await host.close();
    await foreign.close();
  }
});
