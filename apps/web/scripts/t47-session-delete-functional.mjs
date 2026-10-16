/* global localStorage, window */
// Actual React sidebar in Chromium, backed only by intercepted fixture APIs.
// No NAS or customer run is ever deleted by this test.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

const user = {
  id: randomUUID(),
  email: 'owner@localqa.fixture',
  displayName: 'Fixture owner',
  globalRole: 'admin',
  disabled: false,
  version: 1,
};
const project = {
  id: randomUUID(),
  name: 'Fixture project',
  version: 1,
  status: 'active',
  defaultModelProfileId: null,
  createdAt: new Date().toISOString(),
};
const budget = {
  maxCases: 8,
  maxPages: 6,
  maxDepth: 2,
  maxActiveSeconds: 600,
  maxActionsPerCase: 30,
  maxActions: 120,
  maxModelCalls: 100,
  maxReproductions: 3,
  concurrency: 1,
  maxTotalTokens: 300000,
};
const profile = { profileId: randomUUID(), version: 1 };
const effectiveConfig = {
  allowedOrigins: ['https://example.com'],
  actionPolicy: 'non_submitting',
  budget,
  environmentVersion: null,
  authProfileVersion: null,
  knowledgeVersionIds: [],
  models: {
    coordinator: profile,
    explorer: profile,
    executor: profile,
    assertion: profile,
    reproducer: profile,
  },
};
const makeRun = (status) => ({
  id: randomUUID(),
  projectId: project.id,
  creatorId: user.id,
  targetUrl: 'https://example.com/',
  executionMode: 'smoke',
  status,
  phase: 'finalize',
  completion: status === 'completed' ? 'complete' : 'none',
  terminationReason:
    status === 'failed'
      ? 'setup_failure'
      : status === 'completed'
        ? 'normal'
        : null,
  contextVersion: 1,
  effectiveConfig,
  budgetUsed: {
    activeSeconds: 3,
    actions: 2,
    modelCalls: 1,
    totalTokens: 200,
    reproductions: 0,
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  version: 7,
});

const [first, second, third, active] = [
  makeRun('completed'),
  makeRun('failed'),
  makeRun('cancelled'),
  makeRun('running'),
];
let runs = [first, second, third, active];
const deleted = [];
let failOnce = true;
const vite = await createViteServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { port: 0, host: '127.0.0.1' },
});
await vite.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('LOCALQA_USE_MOCK', 'false');
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const reply = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (path === '/api/v1/auth/me') return reply(user);
    if (path === '/api/v1/projects')
      return reply({ items: [project], nextCursor: null });
    if (path === '/api/v1/runs' && method === 'GET')
      return reply({ items: runs, nextCursor: null });
    if (path.startsWith('/api/v1/runs/') && method === 'DELETE') {
      const id = path.split('/').at(-1);
      const input = request.postDataJSON();
      deleted.push({ id, ...input });
      if (id === third.id && failOnce) {
        failOnce = false;
        return reply(
          { code: 'VERSION_CONFLICT', message: '运行状态已更新' },
          409,
        );
      }
      if (
        !runs.some(
          (run) => run.id === id && run.version === input.expectedVersion,
        )
      )
        return reply({ code: 'VERSION_CONFLICT' }, 409);
      runs = runs.filter((run) => run.id !== id);
      return route.fulfill({ status: 204 });
    }
    return reply({ items: [], nextCursor: null });
  });
  await page.goto(`${vite.resolvedUrls.local[0]}#/home`);
  await page.waitForTimeout(500);
  if ((await page.getByTestId(`history-item-${first.id}`).count()) === 0) {
    console.log(
      'T47_DEBUG',
      JSON.stringify({
        pageErrors,
        body: (await page.locator('body').innerText()).slice(0, 700),
        currentProject: await page.evaluate(
          () => window.__LOCALQA_CURRENT_PROJECT__?.id ?? null,
        ),
        runApi: await page.evaluate(async () => {
          try {
            return (
              await window.__LOCALQA_API_CLIENT__.listRuns(
                window.__LOCALQA_CURRENT_PROJECT__.id,
              )
            ).items.length;
          } catch (error) {
            return { error: String(error), issues: error?.issues ?? null };
          }
        }),
      }),
    );
  }
  await page
    .getByTestId(`history-item-${first.id}`)
    .waitFor({ timeout: 15000 });
  assert.equal(
    await page.getByTestId(`sidebar-runs-delete-${active.id}`).count(),
    0,
  );

  // Cancellation must not create a deletion request.
  await page.getByTestId(`sidebar-runs-delete-${first.id}`).click();
  await page.getByTestId('sidebar-runs-delete-dialog').waitFor();
  await page.getByTestId('sidebar-runs-delete-cancel').click();
  assert.equal(deleted.length, 0);

  // A single delete must pass the frozen version and exact confirmation ID.
  await page.getByTestId(`sidebar-runs-delete-${first.id}`).click();
  await page.getByTestId('sidebar-runs-delete-confirm').click();
  await page
    .getByTestId(`history-item-${first.id}`)
    .waitFor({ state: 'detached' });
  assert.deepEqual(deleted[0], {
    id: first.id,
    expectedVersion: first.version,
    confirmRunId: first.id,
  });

  // Batch-select only finished records; running is never selectable.
  await page.getByTestId('sidebar-runs-bulk-toggle').click();
  assert.equal(
    await page.getByTestId(`sidebar-runs-select-${active.id}`).isDisabled(),
    true,
  );
  await page.getByTestId('sidebar-runs-select-all').check();
  assert.equal(
    await page.getByTestId('sidebar-runs-delete-selected').innerText(),
    '删除已选（2）',
  );
  await page.getByTestId('sidebar-runs-delete-selected').click();
  await page.getByTestId('sidebar-runs-delete-confirm').click();
  await page
    .getByTestId(`history-item-${second.id}`)
    .waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId(`history-item-${third.id}`).count(), 1);
  assert.match(
    await page.getByRole('alert').first().innerText(),
    /已删除 1 条，失败 1 条/,
  );
  assert.equal(
    deleted.some((item) => item.id === active.id),
    false,
  );

  // Recover from a partial batch failure without losing the surviving record.
  await page.getByTestId('sidebar-runs-delete-selected').click();
  await page.getByTestId('sidebar-runs-delete-confirm').click();
  await page
    .getByTestId(`history-item-${third.id}`)
    .waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId(`history-item-${active.id}`).count(), 1);
  assert.equal(deleted.length, 4);
  console.log(
    'T47_SESSION_DELETE_UI_ACCEPTED single + cancel + batch + partial_failure + active_protection',
  );
} finally {
  await browser.close();
  await vite.close();
}
