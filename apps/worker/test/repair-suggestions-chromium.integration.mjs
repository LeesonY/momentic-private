/* global window */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BrowserManager } from '@localqa/browser';
import { suggestLocatorRepair } from '../dist/repair-suggestions.js';

test('real Chromium failed frozen name produces review-only evidence candidate without clicking', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    mode: 'full',
    allowedOrigins: ['https://fixture.test'],
  });
  try {
    const page = session.getPage();
    await page.route('https://fixture.test/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body:
          '<button aria-label="COMPLETE ORDER">Checkout</button>' +
          '<script>window.actionCount=0;document.querySelector("button").onclick=()=>window.actionCount++;</script>',
      }),
    );
    await page.goto('https://fixture.test/checkout?secret=never-store');
    const frozen = { by: 'role', value: 'button', name: 'Complete Order' };
    const observed = await session.getSnapshot({ forceFresh: true });
    await assert.rejects(
      session.resolveRegressionLocator(frozen),
      (error) => error.code === 'LOCATOR_NOT_FOUND',
    );
    const suggestion = suggestLocatorRepair({
      locator: frozen,
      source: { documentId: 'approved', stepIndex: 0, modulePath: [] },
      snapshot: observed,
      reasonCode: 'LOCATOR_NOT_FOUND',
    });
    assert.equal(suggestion?.proposed.name, 'COMPLETE ORDER');
    assert.equal(suggestion?.reviewRequired, true);
    assert.equal(suggestion?.verification, 'not_run');
    assert.equal(await page.evaluate(() => window.actionCount), 0);

    await page.setContent(
      '<button aria-label="COMPLETE ORDER">First</button>' +
        '<button aria-label="COMPLETE ORDER">Second</button>',
    );
    assert.equal(
      suggestLocatorRepair({
        locator: frozen,
        source: { documentId: 'approved', stepIndex: 0, modulePath: [] },
        snapshot: await session.getSnapshot({ forceFresh: true }),
        reasonCode: 'LOCATOR_NOT_FOUND',
      }),
      null,
    );
  } finally {
    await session.close();
    await manager.close();
  }
});
