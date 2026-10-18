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
  version: 3,
  status: 'active',
  defaultModelProfileId: null,
  createdAt: new Date().toISOString(),
};
const second = {
  ...first,
  id: randomUUID(),
  name: 'Busy DCP',
  version: 5,
};
let projects = [first, second];
const calls = [];
const previewFor = (project, activeRuns) => ({
  projectId: project.id,
  name: project.name,
  version: project.version,
  status: project.status,
  empty: false,
  counts: {
    runs: activeRuns > 0 ? activeRuns : 3,
    activeRuns,
    savedCases: 2,
    enabledSchedules: 1,
    environments: 4,
    authProfiles: 5,
    members: 2,
    activeApiKeys: 6,
  },
});
const vite = await createViteServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { port: 0, host: '127.0.0.1' },
});
await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 900 },
  });
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
    const previewMatch = pathname.match(
      /^\/api\/v1\/projects\/([^/]+)\/deletion-preview$/,
    );
    if (previewMatch && method === 'GET') {
      const project = projects.find((item) => item.id === previewMatch[1]);
      return fulfill(previewFor(project, project.id === second.id ? 2 : 0));
    }
    const deleteMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      calls.push({ id: deleteMatch[1], body: request.postDataJSON() });
      projects = projects.filter((item) => item.id !== deleteMatch[1]);
      return route.fulfill({ status: 204 });
    }
    if (pathname === '/api/v1/auth/me') return fulfill(admin);
    if (pathname === '/api/v1/projects')
      return fulfill({ items: [...projects], nextCursor: null });
    if (pathname === '/api/v1/models')
      return fulfill({ items: [], nextCursor: null });
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

  await page.goto(`${origin}#/projects`);
  await page.getByTestId('projects-table').waitFor();
  assert.equal(
    await page.getByTestId(`project-current-${first.id}`).innerText(),
    '当前',
  );
  assert.equal(
    await page.getByTestId(`project-model-${first.id}`).innerText(),
    '未设置',
  );

  // A project with running sessions cannot be deleted, and the dialog says why.
  await page.getByTestId(`btn-project-delete-${second.id}`).click();
  await page.getByTestId('project-delete-blocked').waitFor();
  assert.match(
    await page.getByTestId('project-delete-blocked').innerText(),
    /2 个会话没结束/,
  );
  assert.equal(
    await page.getByTestId('project-delete-name').isDisabled(),
    true,
  );
  assert.equal(
    await page.getByTestId('project-delete-confirm').isDisabled(),
    true,
  );
  await page.getByTestId('project-delete-cancel').click();

  // The deletable project: preview first, then the exact name, then 204.
  await page.getByTestId(`btn-project-delete-${first.id}`).click();
  const preview = page.getByTestId('project-delete-preview');
  await preview.waitFor();
  assert.equal(
    await preview.innerText(),
    '包含 3 个会话、2 条用例、4 个环境、5 个凭证、1 个启用的定时计划（将停用）、6 个 API Key（将吊销）、2 位成员。',
  );
  const confirm = page.getByTestId('project-delete-confirm');
  assert.equal(await confirm.isDisabled(), true, 'nothing typed yet');
  await page.getByTestId('project-delete-name').fill('Disposable');
  assert.equal(await confirm.isDisabled(), true, 'name must match exactly');
  await page.getByTestId('project-delete-name').fill(first.name);
  assert.equal(await confirm.isEnabled(), true);
  await confirm.click();

  // The page stays on the list it just changed.
  await page
    .getByTestId('project-delete-dialog')
    .waitFor({ state: 'detached' });
  await page
    .getByTestId(`project-row-${first.id}`)
    .waitFor({ state: 'detached' });
  assert.deepEqual(calls, [
    { id: first.id, body: { expectedVersion: 3, confirmName: first.name } },
  ]);
  // The deleted project was the current one: the shell switched to the other.
  assert.equal(
    await page.getByTestId('project-selector').inputValue(),
    second.id,
  );
  console.log(
    'T45_PROJECT_DELETE_UI_ACCEPTED preview + block + confirm + 204 + selection',
  );

  // A member never sees the 项目管理 entry, and opening the route directly says
  // the page is admin-only instead of leaking the project list.
  const member = await browser.newPage({
    viewport: { width: 900, height: 800 },
  });
  await member.addInitScript(() => {
    localStorage.setItem('LOCALQA_USE_MOCK', 'false');
  });
  await member.route('**/api/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fulfill = (body) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (pathname === '/api/v1/auth/me')
      return fulfill({ ...admin, globalRole: 'member' });
    if (pathname === '/api/v1/projects')
      return fulfill({ items: [...projects], nextCursor: null });
    return fulfill({ items: [], nextCursor: null });
  });
  await member.goto(`${origin}#/projects`);
  await member.getByTestId('projects-page').waitFor();
  assert.match(
    await member.getByTestId('projects-page').innerText(),
    /仅平台管理员可用/,
  );
  // The settings nav of another settings page must not offer 项目管理 to a member.
  await member.goto(`${origin}#/models`);
  // Attachment is enough: the sidebar collapses on narrow viewports.
  await member
    .getByTestId('settings-navigation')
    .waitFor({ state: 'attached' });
  assert.equal(
    await member.getByTestId('nav-projects').count(),
    0,
    'members do not see the admin entry',
  );
  await member.close();
  console.log('T45_PROJECT_ADMIN_GATE_ACCEPTED member blocked');
} finally {
  await browser.close();
  await vite.close();
}
