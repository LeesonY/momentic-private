import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { captureBrowserSnapshot } from '../dist/snapshot.js';
import {
  resolveCachedRegressionLocator,
  resolveRegressionLocator,
} from '../dist/regression-locator.js';

const locator = { by: 'role', value: 'button', name: 'Submit order' };

test(
  'real Chromium: fresh context cache hit is revalidated; moved/ambiguous/stale nodes fail closed',
  { timeout: 45000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const firstContext = await browser.newContext();
      const first = await firstContext.newPage();
      await first.setContent('<button aria-label="Submit order">Buy</button>');
      const firstSnapshot = await captureBrowserSnapshot(first, {
        pageId: randomUUID(),
      });
      const firstTarget = await resolveRegressionLocator(
        first,
        locator,
        firstSnapshot,
      );
      await firstContext.close();

      const nextContext = await browser.newContext();
      const page = await nextContext.newPage();
      await page.setContent('<button aria-label="Submit order">Buy</button>');
      const nextSnapshot = await captureBrowserSnapshot(page, {
        pageId: randomUUID(),
      });
      const candidate = {
        snapshotId: nextSnapshot.snapshotId,
        pageId: nextSnapshot.pageId,
        nodeId: nextSnapshot.nodes.find((node) => node.role === 'button')
          ?.nodeId,
        frameId: 'main',
      };
      assert.notEqual(firstTarget.snapshotId, nextSnapshot.snapshotId);
      assert.equal(
        (
          await resolveCachedRegressionLocator(
            page,
            locator,
            candidate,
            nextSnapshot,
          )
        )?.nodeId,
        candidate.nodeId,
      );

      // Old snapshot targets can never pass a new context's cache check.
      assert.equal(
        await resolveCachedRegressionLocator(
          page,
          locator,
          firstTarget,
          nextSnapshot,
        ),
        null,
      );

      // Snapshot metadata alone is insufficient: a second Playwright match
      // must fail closed even when the old snapshot still claims uniqueness.
      await page.evaluate(() => {
        const extra = document.createElement('button');
        extra.setAttribute('aria-label', 'Submit order');
        extra.textContent = 'Other purchase';
        document.body.append(extra);
      });
      assert.equal(
        await resolveCachedRegressionLocator(
          page,
          locator,
          candidate,
          nextSnapshot,
        ),
        null,
      );

      // A hidden original cannot be recovered by trusting cached visibility.
      await page.evaluate(() => {
        document.querySelector('button:first-child').style.display = 'none';
        document.querySelector('button:last-child').remove();
      });
      assert.equal(
        await resolveCachedRegressionLocator(
          page,
          locator,
          candidate,
          nextSnapshot,
        ),
        null,
      );

      await page.setContent('<button aria-label="Cancel">Cancel</button>');
      assert.equal(
        await resolveCachedRegressionLocator(
          page,
          locator,
          candidate,
          nextSnapshot,
        ),
        null,
      );
      await nextContext.close();
      console.log(
        'T12 Chromium: fresh-context match, stale, duplicate, hidden, renamed invalidation confirmed',
      );
    } finally {
      await browser.close();
    }
  },
);
