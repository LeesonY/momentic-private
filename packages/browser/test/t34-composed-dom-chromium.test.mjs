import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { captureBrowserSnapshot, resolveTarget } from '../dist/index.js';

async function withPage(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
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

test('T34 same-origin iframe target must be snapshot-bound to its exact frame; cannot alias duplicate main-frame testid', async () => {
  await withPage(async (page) => {
    await page.setContent(`<button data-testid="approve" onclick="this.textContent='main clicked'">Main</button>
      <iframe name="approval"></iframe>`);
    const frame = page.frame({ name: 'approval' });
    assert.ok(frame, 'test page has a real child frame');
    await frame.setContent(`<button data-testid="approve">Frame</button>
      <script>document.querySelector('button').addEventListener('click', function() {
        this.textContent = 'frame clicked'
      })</script>`);
    await frame.getByTestId('approve').waitFor();
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const iframeNode = snapshot.nodes.find(
      (n) => n.nodeId === 'testid_approve' && n.frameId !== 'main',
    );
    const mainNode = snapshot.nodes.find(
      (n) => n.nodeId === 'testid_approve' && n.frameId === 'main',
    );
    assert.ok(iframeNode);
    assert.ok(mainNode);
    const valid = await resolveTarget(
      page,
      targetFor(snapshot, iframeNode),
      snapshot,
    );
    assert.equal(valid.status, 'resolved');
    await valid.locator.click();
    assert.equal(
      await frame.getByTestId('approve').textContent(),
      'frame clicked',
    );
    assert.equal(await page.getByTestId('approve').textContent(), 'Main');

    const missingFrame = await resolveTarget(
      page,
      {
        snapshotId: snapshot.snapshotId,
        pageId: snapshot.pageId,
        nodeId: iframeNode.nodeId,
      },
      { ...snapshot, nodes: [iframeNode] },
    );
    assert.equal(missingFrame.status, 'rejected');
    assert.equal(missingFrame.reasonCode, 'TARGET_NOT_FOUND');
    const wrongFrame = await resolveTarget(
      page,
      { ...targetFor(snapshot, iframeNode), frameId: 'frame-not-owned' },
      snapshot,
    );
    assert.equal(wrongFrame.status, 'rejected');
    const stale = await resolveTarget(
      page,
      { ...targetFor(snapshot, iframeNode), snapshotId: randomUUID() },
      snapshot,
    );
    assert.equal(stale.status, 'rejected');
    assert.equal(stale.reasonCode, 'VERSION_CONFLICT');
  });
});

test('T34 open and nested shadow roots are observed, clickable via exact owned node, and closed roots remain opaque', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<main><div id="openHost"></div><div id="closedHost"></div></main>',
    );
    await page.evaluate(() => {
      const root = document
        .getElementById('openHost')
        .attachShadow({ mode: 'open' });
      root.innerHTML =
        '<section><button data-testid="shadow-approve">Approve in shadow</button><div id="nested"></div></section>';
      const nested = root
        .getElementById('nested')
        .attachShadow({ mode: 'open' });
      nested.innerHTML =
        '<button data-testid="nested-approve">Approve nested</button>';
      const closed = document
        .getElementById('closedHost')
        .attachShadow({ mode: 'closed' });
      closed.innerHTML =
        '<button data-testid="closed-approve">Invisible to owner snapshot</button>';
    });
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const outer = snapshot.nodes.find(
      (n) => n.nodeId === 'testid_shadow-approve',
    );
    const nested = snapshot.nodes.find(
      (n) => n.nodeId === 'testid_nested-approve',
    );
    assert.ok(outer, 'open shadow host button included in real snapshot');
    assert.ok(
      nested,
      'nested open shadow host button included in real snapshot',
    );
    assert.equal(
      snapshot.nodes.some((n) => n.nodeId === 'testid_closed-approve'),
      false,
      'closed shadow root stays opaque',
    );
    const owned = await resolveTarget(
      page,
      targetFor(snapshot, nested),
      snapshot,
    );
    assert.equal(owned.status, 'resolved');
    await owned.locator.click();
    assert.equal(
      await page.locator('[data-testid="nested-approve"]').count(),
      1,
    );
    const forged = await resolveTarget(
      page,
      { ...targetFor(snapshot, nested), nodeId: 'testid_closed-approve' },
      snapshot,
    );
    assert.equal(forged.status, 'rejected');
  });
});

test('T34 asynchronous second control cannot be guessed in an old snapshot; a new one must be observed', async () => {
  await withPage(async (page) => {
    await page.setContent(`<button id="start" aria-label="Start">Start</button><section id="region"></section>
      <script>document.querySelector('#start').addEventListener('click', () => {
        setTimeout(() => {
          const button = document.createElement('button');
          button.dataset.testid = 'async-second';
          button.textContent = 'Approve async';
          document.querySelector('#region').append(button);
        }, 160);
      }, {once:true});</script>`);
    const pageId = randomUUID();
    const before = await captureBrowserSnapshot(page, { pageId });
    assert.equal(
      before.nodes.some((n) => n.nodeId === 'testid_async-second'),
      false,
    );
    const start = before.nodes.find((n) => n.role === 'button');
    assert.ok(start);
    const resolved = await resolveTarget(
      page,
      targetFor(before, start),
      before,
    );
    assert.equal(resolved.status, 'resolved');
    await resolved.locator.click();
    const unobserved = await resolveTarget(
      page,
      {
        snapshotId: before.snapshotId,
        pageId,
        nodeId: 'testid_async-second',
        frameId: 'main',
      },
      before,
    );
    assert.equal(unobserved.status, 'rejected');
    await page.getByTestId('async-second').waitFor({ state: 'visible' });
    const after = await captureBrowserSnapshot(page, {
      pageId,
      stateVersion: 2,
    });
    const ready = after.nodes.find((n) => n.nodeId === 'testid_async-second');
    assert.ok(ready);
    assert.notEqual(after.snapshotId, before.snapshotId);
    assert.equal(
      (await resolveTarget(page, targetFor(before, start), after)).status,
      'rejected',
    );
    assert.equal(
      (await resolveTarget(page, targetFor(after, ready), after)).status,
      'resolved',
    );
  });
});

test('T34 an unapproved cross-origin iframe stays opaque to snapshots and cannot be clicked using forged snapshot metadata', async () => {
  const host = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      '<button data-testid="main-approve">Main</button><iframe id="external"></iframe>',
    );
  });
  const foreign = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      '<button data-testid="foreign-secret">Foreign private control</button>',
    );
  });
  host.listen(0, '127.0.0.1');
  foreign.listen(0, '127.0.0.1');
  try {
    await Promise.all([once(host, 'listening'), once(foreign, 'listening')]);
    const mainUrl = `http://127.0.0.1:${host.address().port}`;
    const foreignUrl = `http://127.0.0.1:${foreign.address().port}`;
    await withPage(async (page) => {
      await page.goto(mainUrl);
      await page.locator('#external').evaluate((element, url) => {
        element.src = url;
      }, foreignUrl);
      const external = page
        .frames()
        .find((frame) => frame.url().startsWith(foreignUrl));
      if (!external)
        await page.waitForFunction(
          (url) =>
            [...document.querySelectorAll('iframe')].some((frame) =>
              frame.src.startsWith(url),
            ),
          foreignUrl,
        );
      const iframe = page
        .frames()
        .find((frame) => frame.url().startsWith(foreignUrl));
      assert.ok(iframe);
      await iframe.getByTestId('foreign-secret').waitFor();
      const snapshot = await captureBrowserSnapshot(page, {
        pageId: randomUUID(),
      });
      assert.equal(
        snapshot.nodes.some((node) => node.nodeId === 'testid_foreign-secret'),
        false,
      );
      assert.equal(
        snapshot.nodes.some((node) => node.role === 'iframe' && !node.enabled),
        true,
      );
      const id = snapshot.frameIds.find((frameId) => frameId !== 'main');
      assert.ok(id);
      // Even an attacker-writable synthetic snapshot cannot authorize a
      // cross-origin action: the resolver rechecks the live frame origin.
      const forged = {
        ...snapshot,
        nodes: [
          ...snapshot.nodes,
          {
            nodeId: 'testid_foreign-secret',
            frameId: id,
            role: 'button',
            name: 'Foreign private control',
            text: 'Foreign private control',
            visible: true,
            enabled: true,
            bounds: { left: 0, top: 0, width: 40, height: 20 },
          },
        ],
      };
      const target = await resolveTarget(
        page,
        {
          pageId: snapshot.pageId,
          snapshotId: snapshot.snapshotId,
          nodeId: 'testid_foreign-secret',
          frameId: id,
        },
        forged,
      );
      assert.equal(target.status, 'rejected');
      assert.equal(target.reasonCode, 'TARGET_NOT_ALLOWED');
    });
  } finally {
    await Promise.all([
      new Promise((resolve) => host.close(resolve)),
      new Promise((resolve) => foreign.close(resolve)),
    ]);
  }
});

test('T34 deep DOM traversal limit sets snapshot.truncated instead of silently pretending the whole page was observed', async () => {
  await withPage(async (page) => {
    await page.setContent('<main id="root"></main>');
    await page.evaluate(() => {
      const items = document.createDocumentFragment();
      for (let i = 0; i < 5500; i++) {
        const element = document.createElement('span');
        items.append(element);
      }
      const button = document.createElement('button');
      button.dataset.testid = 'late-button';
      items.append(button);
      document.getElementById('root').append(items);
    });
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    assert.equal(snapshot.truncated, true);
    assert.equal(
      snapshot.nodes.some((node) => node.nodeId === 'testid_late-button'),
      false,
    );
    assert.ok(snapshot.nodes.length < 1000);
  });
});

test('T36 same-origin iframe document reload invalidates old snapshot even with identical frame name and testid', async () => {
  await withPage(async (page) => {
    await page.setContent('<iframe name="stable-approval"></iframe>');
    const frame = page.frame({ name: 'stable-approval' });
    assert.ok(frame);
    await frame.setContent(
      '<button data-testid="confirmation">Approved old document</button>',
    );
    const before = await captureBrowserSnapshot(page, { pageId: randomUUID() });
    const original = before.nodes.find(
      (node) => node.nodeId === 'testid_confirmation',
    );
    assert.ok(original);
    assert.equal(
      (await resolveTarget(page, targetFor(before, original), before)).status,
      'resolved',
    );
    await frame.goto('about:blank');
    await frame.setContent(
      '<button data-testid="confirmation">Approved new document</button>',
    );
    const stale = await resolveTarget(
      page,
      targetFor(before, original),
      before,
    );
    assert.equal(
      stale.status,
      'rejected',
      'old approval cannot bind to a new frame document',
    );
    const after = await captureBrowserSnapshot(page, { pageId: before.pageId });
    const fresh = after.nodes.find(
      (node) => node.nodeId === 'testid_confirmation',
    );
    assert.ok(fresh);
    assert.equal(
      (await resolveTarget(page, targetFor(after, fresh), after)).status,
      'resolved',
    );
  });
});

test('T36 DOM remount invalidates old target even when a new button copies all visible metadata', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<div id="slot"><button data-testid="same-action">Confirm</button></div>',
    );
    const before = await captureBrowserSnapshot(page, { pageId: randomUUID() });
    const target = before.nodes.find(
      (node) => node.nodeId === 'testid_same-action',
    );
    assert.ok(target);
    await page.locator('#slot').evaluate((slot) => {
      slot.innerHTML = '<button data-testid="same-action">Confirm</button>';
    });
    assert.equal(
      (await resolveTarget(page, targetFor(before, target), before)).status,
      'rejected',
      'a remounted identical testid is not the element originally approved',
    );
    const after = await captureBrowserSnapshot(page, { pageId: before.pageId });
    const remounted = after.nodes.find(
      (node) => node.nodeId === 'testid_same-action',
    );
    assert.ok(remounted);
    assert.equal(
      (await resolveTarget(page, targetFor(after, remounted), after)).status,
      'resolved',
    );
  });
});

test('T36 a validated target pins original DOM element and refuses locator auto-rebind after intervening remount', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<div id="slot"><button data-testid="confirm">Confirm</button></div>',
    );
    const snapshot = await captureBrowserSnapshot(page, {
      pageId: randomUUID(),
    });
    const node = snapshot.nodes.find((n) => n.nodeId === 'testid_confirm');
    assert.ok(node);
    const resolved = await resolveTarget(
      page,
      targetFor(snapshot, node),
      snapshot,
    );
    assert.equal(resolved.status, 'resolved');
    await page.evaluate(() => {
      window.clickedNew = 0;
      const next = document.createElement('button');
      next.dataset.testid = 'confirm';
      next.textContent = 'Confirm';
      next.addEventListener('click', () => {
        window.clickedNew++;
      });
      document.querySelector('#slot').replaceChildren(next);
    });
    await assert.rejects(
      () => resolved.elementHandle.click({ timeout: 700 }),
      /detached|not attached|element is not attached/i,
    );
    assert.equal(await page.evaluate(() => window.clickedNew), 0);
    await resolved.elementHandle.dispose();
  });
});
