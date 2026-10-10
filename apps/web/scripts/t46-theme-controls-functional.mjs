// T46: test the real Chromium form/option styling at desktop and mobile sizes.
// Requests are intercepted; real project data and model services are untouched.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

const admin = {
  id: randomUUID(),
  email: 'admin@localqa.test',
  displayName: 'Admin',
  globalRole: 'admin',
  disabled: false,
  version: 1,
};
const project = {
  id: randomUUID(),
  name: 'DCP',
  status: 'active',
  version: 1,
  defaultModelProfileId: null,
  createdAt: new Date().toISOString(),
};
const projects = [
  project,
  { ...project, id: randomUUID(), createdAt: new Date().toISOString() },
];
const model = {
  id: randomUUID(),
  name: 'Fixture Model',
  configuredModelId: 'fixture',
  endpoint: 'https://example.test/v1',
  adapter: 'openai_compatible',
  dataBoundary: 'external',
  status: 'untested',
  version: 1,
  capabilities: {
    structuredOutput: false,
    nativeTools: false,
    imageInput: false,
  },
};
const vite = await createViteServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { port: 0, host: '127.0.0.1' },
});
await vite.listen();
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 906, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      await context.addInitScript((initialTheme) => {
        localStorage.setItem('localqa:theme', initialTheme);
        localStorage.setItem('LOCALQA_USE_MOCK', 'false');
      }, theme);
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.route('**/api/v1/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        const data =
          path === '/api/v1/auth/me'
            ? admin
            : path === '/api/v1/projects'
              ? { items: projects, nextCursor: null }
              : path === '/api/v1/model-profiles'
                ? { items: [model], nextCursor: null }
                : path.endsWith('/members')
                  ? {
                      items: [{ userId: admin.id, role: 'owner' }],
                      nextCursor: null,
                    }
                  : { items: [], nextCursor: null };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(data),
        });
      });

      for (const route of [
        'home',
        'models',
        'members-ops',
        'environments',
        'saved-cases',
        'modules',
        'schedules',
      ]) {
        await page.goto(`${vite.resolvedUrls.local[0]}#/${route}`);
        await page.getByTestId('app-header').waitFor({ timeout: 15000 });
        await page.getByTestId('project-selector').waitFor();
        await page.waitForTimeout(180);
        const audit = await page.evaluate(() => {
          const toRGB = (value) => {
            const parts = value
              .match(/\d+(?:\.\d+)?/g)
              ?.slice(0, 3)
              .map(Number);
            return parts && parts.length === 3 ? parts : null;
          };
          const luminance = (rgb) =>
            rgb
              .map((n) => n / 255)
              .map((n) =>
                n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4,
              )
              .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
          const contrast = (fg, bg) => {
            const a = toRGB(fg);
            const b = toRGB(bg);
            if (!a || !b) return 0;
            const l1 = luminance(a);
            const l2 = luminance(b);
            return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          };
          const controls = [...document.querySelectorAll('select')];
          const entries = controls.flatMap((select) =>
            [...select.querySelectorAll('option, optgroup')].map((option) => {
              const s = getComputedStyle(option);
              return {
                tag: option.tagName,
                text: option.textContent?.trim().slice(0, 25),
                fg: s.color,
                bg: s.backgroundColor,
                contrast: contrast(s.color, s.backgroundColor),
                scheme: getComputedStyle(select).colorScheme,
              };
            }),
          );
          const legacy = [
            ...document.querySelectorAll(
              'input.input,textarea.input,select.input',
            ),
          ]
            .filter((el) => getComputedStyle(el).display !== 'none')
            .map((el) => ({
              tag: el.tagName,
              fg: getComputedStyle(el).color,
              bg: getComputedStyle(el).backgroundColor,
              contrast: contrast(
                getComputedStyle(el).color,
                getComputedStyle(el).backgroundColor,
              ),
            }));
          return {
            theme: document.documentElement.dataset.theme,
            viewport: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            projectOptions: document.querySelectorAll(
              '.lqa-project-select option',
            ).length,
            entries,
            legacy,
          };
        });
        assert.equal(audit.theme, theme);
        assert.equal(audit.projectOptions, 2);
        assert.ok(
          audit.scrollWidth <= width + 1,
          `${theme}/${width}/${route}: horizontal overflow`,
        );
        assert.ok(
          audit.entries.every((e) => e.scheme === theme),
          `${theme}/${width}/${route}: native color-scheme mismatch`,
        );
        assert.ok(
          audit.entries.every((e) => e.contrast >= 4.5),
          `${theme}/${width}/${route}: native popup options illegible: ${JSON.stringify(audit.entries)}`,
        );
        assert.ok(
          audit.legacy.every((e) => e.contrast >= 4.5),
          `${theme}/${width}/${route}: legacy input illegible: ${JSON.stringify(audit.legacy)}`,
        );
        results.push({
          theme,
          width,
          route,
          selects: audit.entries.length,
          legacy: audit.legacy.length,
          minContrast: Math.min(
            ...audit.entries.map((e) => e.contrast),
          ).toFixed(2),
        });
      }
      assert.deepEqual(
        pageErrors,
        [],
        `${theme}/${width}: ${pageErrors.join('; ')}`,
      );
      await context.close();
    }
  }
  console.log(
    'T46_THEME_NATIVE_CONTROLS_ACCEPTED',
    JSON.stringify({
      cases: results.length,
      optionChecks: results.reduce((n, r) => n + r.selects, 0),
      legacyInputChecks: results.reduce((n, r) => n + r.legacy, 0),
      minimumRatio: Math.min(...results.map((r) => Number(r.minContrast))),
    }),
  );
} finally {
  await browser.close();
  await vite.close();
}
