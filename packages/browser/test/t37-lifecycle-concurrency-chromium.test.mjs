/* global document, window */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  BrowserManager,
  captureBrowserSnapshot,
  resolveTarget,
} from '../dist/index.js';
import { chromium } from 'playwright';

async function withPage(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await run(page);
  } finally {
    await browser.close();
  }
}

test('T37 32 consecutive snapshots evict old DOM witnesses and leave only a fresh authorized target', async () => {
  await withPage(async (page) => {
    await page.setContent('<button data-testid="approved">Confirm</button>');
    const pageId = randomUUID();
    const observations = [];
    for (let i = 0; i < 32; i++) {
      observations.push(await captureBrowserSnapshot(page, { pageId }));
    }
    for (const snapshot of observations.slice(0, 20)) {
      const stale = await resolveTarget(
        page,
        { pageId, snapshotId: snapshot.snapshotId, nodeId: 'testid_approved' },
        snapshot,
      );
      assert.equal(
        stale.status,
        'rejected',
        'evicted witness must never authorize a click',
      );
      assert.equal(stale.reasonCode, 'VERSION_CONFLICT');
    }
    const recent = observations.at(-1);
    const allowed = await resolveTarget(
      page,
      { pageId, snapshotId: recent.snapshotId, nodeId: 'testid_approved' },
      recent,
    );
    assert.equal(allowed.status, 'resolved');
    await allowed.elementHandle.dispose();
  });
});

test('T37 concurrent same-snapshot browser clicks have at most one mutation and cannot reuse the action grant', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    mode: 'full',
  });
  try {
    const page = session.getPage();
    await page.setContent(`<button data-testid="confirm">Confirm</button>
      <script>window.hitCount = 0;
      document.querySelector('button').addEventListener('click', () => {window.hitCount++;});</script>`);
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const target = {
      pageId: snapshot.pageId,
      snapshotId: snapshot.snapshotId,
      nodeId: 'testid_confirm',
    };
    const [a, b] = await Promise.all([
      session.executeTool({ name: 'click', args: { target } }),
      session.executeTool({ name: 'click', args: { target } }),
    ]);
    assert.equal(await page.evaluate(() => window.hitCount), 1);
    assert.equal(
      [a, b].filter((receipt) => receipt.status === 'succeeded').length,
      1,
    );
    assert.equal(
      [a, b].filter((receipt) => receipt.reasonCode === 'VERSION_CONFLICT')
        .length,
      1,
    );
  } finally {
    await session.close();
    await manager.close();
  }
});

test('T37 abort during dispatched click reports cancellation without claiming no browser side effect', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    mode: 'full',
  });
  const controller = new AbortController();
  try {
    const page = session.getPage();
    await page.exposeFunction('t37NotifyClick', () => controller.abort());
    await page.setContent(`<button data-testid="confirm">Confirm</button>
      <script>window.hitCount = 0;
      document.querySelector('button').addEventListener('click', () => {
        window.hitCount++; window.t37NotifyClick();
      });</script>`);
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const result = await session.executeTool(
      {
        name: 'click',
        args: {
          target: {
            pageId: snapshot.pageId,
            snapshotId: snapshot.snapshotId,
            nodeId: 'testid_confirm',
          },
        },
      },
      { signal: controller.signal },
    );
    assert.equal(controller.signal.aborted, true);
    assert.equal(await page.evaluate(() => window.hitCount), 1);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.reasonCode, 'USER_CANCELLED');
    assert.ok(
      result.actionId,
      'non-null actionId signals action may have occurred',
    );
    const followUp = await session.executeTool(
      { name: 'observe', args: {} },
      {
        signal: controller.signal,
      },
    );
    assert.equal(followUp.status, 'cancelled');
    assert.equal(await page.evaluate(() => window.hitCount), 1);
  } finally {
    await session.close();
    await manager.close();
  }
});

test('T37 24 snapshots across three owned frames stay bounded, then frame remount denies old grants', async () => {
  await withPage(async (page) => {
    await page.setContent(`<button data-testid="main-confirm">Main</button>
      <iframe name="first"></iframe><iframe name="second"></iframe>`);
    const first = page.frame({ name: 'first' });
    const second = page.frame({ name: 'second' });
    assert.ok(first && second);
    await first.setContent(
      '<button data-testid="first-confirm">First</button>',
    );
    await second.setContent(
      '<button data-testid="second-confirm">Second</button>',
    );
    const pageId = randomUUID();
    const snapshots = await Promise.all(
      Array.from({ length: 24 }, () =>
        captureBrowserSnapshot(page, { pageId }),
      ),
    );
    const evicted = snapshots[0];
    const oldFrame = evicted.nodes.find(
      (node) => node.nodeId === 'testid_second-confirm',
    );
    assert.ok(oldFrame);
    const denied = await resolveTarget(
      page,
      {
        snapshotId: evicted.snapshotId,
        pageId,
        nodeId: oldFrame.nodeId,
        frameId: oldFrame.frameId,
      },
      evicted,
    );
    assert.equal(denied.status, 'rejected');
    assert.equal(denied.reasonCode, 'VERSION_CONFLICT');
    const newest = snapshots.at(-1);
    const latestNode = newest.nodes.find(
      (node) => node.nodeId === 'testid_second-confirm',
    );
    assert.ok(latestNode);
    const valid = await resolveTarget(
      page,
      {
        snapshotId: newest.snapshotId,
        pageId,
        nodeId: latestNode.nodeId,
        frameId: latestNode.frameId,
      },
      newest,
    );
    assert.equal(valid.status, 'resolved');
    await valid.elementHandle.dispose();
    await second.goto('about:blank');
    await second.setContent(
      '<button data-testid="second-confirm">Replacement</button>',
    );
    const detached = await resolveTarget(
      page,
      {
        snapshotId: newest.snapshotId,
        pageId,
        nodeId: latestNode.nodeId,
        frameId: latestNode.frameId,
      },
      newest,
    );
    assert.equal(detached.status, 'rejected');
    assert.equal(detached.reasonCode, 'VERSION_CONFLICT');
  });
});

test('T37 parallel cancelled and queued click never dispatches a second browser side effect', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    mode: 'full',
  });
  const controller = new AbortController();
  try {
    const page = session.getPage();
    await page.exposeFunction('t37AbortOnce', () => controller.abort());
    await page.setContent(`<button data-testid="confirm">Confirm</button>
      <script>window.hitCount = 0;
      document.querySelector('button').addEventListener('click', () => {
        window.hitCount++; window.t37AbortOnce();
      });</script>`);
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const call = {
      name: 'click',
      args: {
        target: {
          pageId: snapshot.pageId,
          snapshotId: snapshot.snapshotId,
          nodeId: 'testid_confirm',
        },
      },
    };
    const receipts = await Promise.all([
      session.executeTool(call, { signal: controller.signal }),
      session.executeTool(call, { signal: controller.signal }),
    ]);
    assert.equal(await page.evaluate(() => window.hitCount), 1);
    assert.ok(receipts.every((receipt) => receipt.status === 'cancelled'));
    assert.ok(
      receipts.every((receipt) => receipt.reasonCode === 'USER_CANCELLED'),
    );
    assert.ok(receipts[0].actionId);
    assert.equal(receipts[1].actionId, null);
  } finally {
    await session.close();
    await manager.close();
  }
});

test('T37 wait_for may await an observed hidden element but cannot guess absent testids or click while hidden', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    mode: 'full',
  });
  try {
    const page = session.getPage();
    await page.setContent(`<button data-testid="late" style="display:none">Confirm</button>
      <script>window.hitCount=0;
      document.querySelector('button').addEventListener('click', () => {window.hitCount++;});</script>`);
    const before = await session.getSnapshot({ forceFresh: true });
    const owned = {
      pageId: before.pageId,
      snapshotId: before.snapshotId,
      nodeId: 'testid_late',
    };
    assert.equal(
      before.nodes.find((n) => n.nodeId === owned.nodeId)?.visible,
      false,
    );
    const hiddenClick = await session.executeTool({
      name: 'click',
      args: { target: owned },
    });
    assert.equal(hiddenClick.status, 'failed');
    assert.equal(hiddenClick.reasonCode, 'TARGET_HIDDEN');
    const guessedWait = await session.executeTool({
      name: 'wait_for',
      args: {
        pageId: before.pageId,
        condition: 'element_visible',
        target: { ...owned, nodeId: 'testid-never-observed' },
        timeoutMs: 300,
      },
    });
    assert.equal(guessedWait.status, 'failed');
    assert.equal(guessedWait.reasonCode, 'TARGET_NOT_FOUND');
    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector('button').style.display = 'block';
      }, 160);
    });
    const awaited = await session.executeTool({
      name: 'wait_for',
      args: {
        pageId: before.pageId,
        condition: 'element_visible',
        target: owned,
        timeoutMs: 1500,
      },
    });
    assert.equal(awaited.status, 'succeeded');
    const fresh = await session.getSnapshot();
    const clicked = await session.executeTool({
      name: 'click',
      args: {
        target: {
          pageId: fresh.pageId,
          snapshotId: fresh.snapshotId,
          nodeId: 'testid_late',
        },
      },
    });
    assert.equal(clicked.status, 'succeeded');
    assert.equal(await page.evaluate(() => window.hitCount), 1);
  } finally {
    await session.close();
    await manager.close();
  }
});
