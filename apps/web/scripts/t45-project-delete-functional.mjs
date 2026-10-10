/* global localStorage */
// Real React app in Chromium with an isolated HTTP API fixture.
// Does not modify the development Docker database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

const admin = {
  id: randomUUID(),
  email: 'admin@localqa.fixture',
  displayName: 'Admin',
  globalRole: 'admin',
  disabled: false,
  version: 1,
};
const first = {
  id: randomUUID(),
  name: 'Disposable DCP',
  version: 1,
  status: 'active',
  defaultModelProfileId: null,
  createdAt: new Date().toISOString(),
};
const second = { ...first, id: randomUUID() };
const projects = [first, second];
const calls = [];
const vite = await createViteServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { port: 0, host: '127.0.0.1' },
});
await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 906, height: 900 } });
  await page.addInitScript(() => {
    localStorage.setItem('LOCALQA_USE_MOCK', 'false');
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const fulfill = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (pathname === `/api/v1/projects/${first.id}` && method === 'DELETE') {
      calls.push(request.postDataJSON());
      projects.shift();
      return route.fulfill({ status: 204 });
    }
    if (pathname === '/api/v1/auth/me') return fulfill(admin);
    if (pathname === '/api/v1/projects')
      return fulfill({ items: [...projects], nextCursor: null });
    if (pathname.endsWith('/members'))
      return fulfill({
        items: [{ userId: admin.id, role: 'owner' }],
        nextCursor: null,
      });
    if (pathname === '/api/v1/users')
      return fulfill({ items: [admin], nextCursor: null });
    if (pathname.includes('/health'))
      return fulfill({ status: 'ok', components: [] });
    return fulfill({ items: [], nextCursor: null });
  });
  await page.goto(`${origin}#/members-ops`);
  await page.getByTestId('delete-project-card').waitFor();
  assert.equal(
    await page.getByTestId('delete-project-target-id').innerText(),
    first.id,
  );
  const duplicateOptions = await page
    .getByTestId('project-selector')
    .locator('option')
    .allTextContents();
  assert.equal(duplicateOptions.length, 2);
  assert.ok(duplicateOptions[0].includes(first.id.slice(0, 8)));
  assert.ok(duplicateOptions[1].includes(second.id.slice(0, 8)));
  const button = page.getByTestId('btn-delete-project');
  assert.equal(await button.isDisabled(), true);
  await page.getByTestId('delete-project-name').fill(first.name);
  assert.equal(await button.isDisabled(), true);
  await page.getByTestId('confirm-project-delete').check();
  assert.equal(await button.isEnabled(), true);
  page.once('dialog', (dialog) => dialog.dismiss());
  await button.click();
  assert.equal(calls.length, 0, 'cancelled confirmation must not delete');
  page.once('dialog', (dialog) => dialog.accept());
  await button.click();
  await page.waitForURL('**/#/home');
  assert.deepEqual(calls, [
    { expectedVersion: first.version, confirmName: first.name },
  ]);
  assert.equal(
    await page.getByTestId('project-selector').inputValue(),
    second.id,
  );
  console.log(
    'T45_PROJECT_DELETE_UI_ACCEPTED cancel + confirm + 204 + selection',
  );
} finally {
  await browser.close();
  await vite.close();
}
