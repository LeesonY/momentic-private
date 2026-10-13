import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BrowserManager } from '@localqa/browser';
import {
  CandidateLocatorFailure,
  resolveCandidateLocator,
} from '../dist/candidate-locator-recovery.js';

const locator = { by: 'role', value: 'button', name: 'Next' };

async function inBrowser(operation) {
  const manager = new BrowserManager();
  const session = await manager.createSession({
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    mode: 'non_submitting',
  });
  try {
    await operation(session);
  } finally {
    await session.close();
    await manager.close();
  }
}

test(
  'real Chromium: independently verifying a delayed button retries only owned snapshots, clicking once',
  { timeout: 30000 },
  async () => {
    await inBrowser(async (session) => {
      const page = session.getPage();
      await page.setContent('<div id="root">Ready</div>');
      let inject = true;
      const wrapper = {
        get activePageId() {
          return session.activePageId;
        },
        executeTool: async (...args) => {
          const receipt = await session.executeTool(...args);
          if (inject && args[0].name === 'observe') {
            inject = false;
            await page.evaluate(() => {
              const button = document.createElement('button');
              button.textContent = 'Next';
              button.addEventListener('click', () => {
                window.clicks = (window.clicks ?? 0) + 1;
              });
              document.body.append(button);
            });
          }
          return receipt;
        },
        resolveRegressionLocator: (...args) =>
          session.resolveRegressionLocator(...args),
      };
      const target = await resolveCandidateLocator(
        wrapper,
        locator,
        new AbortController().signal,
      );
      const clicked = await session.executeTool(
        { name: 'click', args: { target } },
        { signal: new AbortController().signal },
      );
      assert.equal(clicked.status, 'succeeded');
      assert.equal(await page.evaluate(() => window.clicks ?? 0), 1);
      assert.equal(inject, false);
    });
  },
);

test(
  'real Chromium: permanently absent button never causes mutation',
  { timeout: 30000 },
  async () => {
    await inBrowser(async (session) => {
      const page = session.getPage();
      await page.setContent('<div>No control</div>');
      await assert.rejects(
        resolveCandidateLocator(session, locator, new AbortController().signal),
        (error) =>
          error instanceof CandidateLocatorFailure &&
          error.code === 'LOCATOR_NOT_FOUND',
      );
      assert.equal(await page.locator('button').count(), 0);
    });
  },
);

test(
  'real Chromium: two matching buttons fail closed without a click',
  { timeout: 30000 },
  async () => {
    await inBrowser(async (session) => {
      const page = session.getPage();
      await page.setContent('<button>Next</button><button>Next</button>');
      const a = new AbortController();
      await assert.rejects(
        resolveCandidateLocator(session, locator, a.signal),
        (error) =>
          error instanceof CandidateLocatorFailure &&
          error.code === 'LOCATOR_NOT_OWNED_OR_AMBIGUOUS',
      );
      assert.equal(await page.getByRole('button', { name: 'Next' }).count(), 2);
    });
  },
);

test(
  'real Chromium: cancellation while recovering never dispatches a click',
  { timeout: 30000 },
  async () => {
    await inBrowser(async (session) => {
      const page = session.getPage();
      await page.setContent('<div>No control</div>');
      const abort = new AbortController();
      const wrapper = {
        get activePageId() {
          return session.activePageId;
        },
        executeTool: async (...args) => {
          const receipt = await session.executeTool(...args);
          abort.abort('VERIFICATION_CANCELLED');
          return receipt;
        },
        resolveRegressionLocator: (...args) =>
          session.resolveRegressionLocator(...args),
      };
      await assert.rejects(
        resolveCandidateLocator(wrapper, locator, abort.signal),
        (error) =>
          error instanceof CandidateLocatorFailure &&
          error.code === 'VERIFICATION_CANCELLED',
      );
      assert.equal(await page.locator('button').count(), 0);
    });
  },
);
