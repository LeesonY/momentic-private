import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BrowserManager } from '@localqa/browser';
import { suggestSemanticLocatorRepairs } from '../dist/ai-locator-suggestions.js';

const URL = 'https://fixture.test/t52-chromium';
const HTML = `<!doctype html>
  <button data-testid="t52-inspect" id="inspect">Inspect details</button>
  <button data-testid="t52-view" id="view">View details</button>
  <output id="count">0</output>
  <script>document.querySelectorAll('button').forEach(button=>
    button.addEventListener('click',()=>document.querySelector('#count').textContent='1'))</script>`;
const open = async (manager) => {
  const session = await manager.createSession({
    projectId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    mode: 'non_submitting',
    allowedOrigins: ['https://fixture.test'],
  });
  const page = session.getPage();
  await page.route('https://fixture.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: HTML }),
  );
  await page.goto(URL);
  return { session, page };
};
test('T52 actual Chromium DOM: LLM candidate is read-only and independent context independently confirms unique target', async () => {
  const manager = new BrowserManager();
  let primary, secondary;
  try {
    primary = await open(manager);
    const snapshot = await primary.session.getSnapshot({ forceFresh: true });
    assert.equal(snapshot.redacted, true);
    assert.equal(snapshot.truncated, false);
    const messages = [];
    const hints = await suggestSemanticLocatorRepairs({
      locator: { by: 'role', value: 'button', name: 'Review details' },
      source: { documentId: 't52-frozen', stepIndex: 1, modulePath: [] },
      snapshot,
      reasonCode: 'LOCATOR_NOT_FOUND',
      signal: new AbortController().signal,
      verifyCandidate: async (proposed, verifySignal) => {
        try {
          return !!(await primary.session.resolveRegressionLocator(
            proposed,
            verifySignal,
          ));
        } catch {
          return false;
        }
      },
      async decide(input, schema) {
        messages.push({ input, schema });
        return {
          requestResult: 'ok',
          data: { abstain: false, candidateIds: ['candidate_1'] },
        };
      },
    });
    assert.equal(messages.length, 1, 'one bounded model opportunity');
    assert.equal(hints.length, 1);
    assert.equal(hints[0].verification, 'not_run');
    assert.deepEqual(hints[0].proposed, {
      by: 'role',
      value: 'button',
      name: 'Inspect details',
    });
    assert.equal(
      await primary.page.locator('#count').textContent(),
      '0',
      'suggestion did not click first browser',
    );
    secondary = await open(manager);
    const candidate = secondary.page.getByRole('button', {
      name: hints[0].proposed.name,
      exact: true,
    });
    assert.equal(
      await candidate.count(),
      1,
      'independent browser found exactly one accessible button',
    );
    assert.equal(await candidate.isVisible(), true);
    assert.equal(await candidate.isEnabled(), true);
    assert.equal(
      await secondary.page.locator('#count').textContent(),
      '0',
      'independent verification did not mutate page',
    );
    console.log(
      'T52_CHROMIUM_EVIDENCE',
      JSON.stringify({
        distinctBrowserSessions: true,
        modelCandidates: hints.length,
        replayMutations: 0,
        independentLocatorMatches: 1,
        approval: 'not_run',
      }),
    );
  } finally {
    await secondary?.session.close();
    await primary?.session.close();
    await manager.close();
  }
});
