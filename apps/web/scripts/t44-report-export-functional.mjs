// Real Vite/React/HttpApiClient + Chromium: API calls are isolated fixtures,
// download bytes are checked, and no model or production endpoint is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const report = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../docs/examples/report.sample.json', import.meta.url),
    ),
    'utf8',
  ),
);
const projectId = report.run.projectId;
const runId = report.run.id;
const admin = {
  id: report.run.creatorId,
  email: 'admin@localqa.test',
  displayName: 'Fixture Admin',
  globalRole: 'admin',
  disabled: false,
  version: 1,
};
const project = {
  id: projectId,
  name: 'T44 Report Download Fixture',
  status: 'active',
  version: 1,
  createdAt: new Date().toISOString(),
  defaultModelProfileId: null,
};
const imageId = randomUUID();
const missingId = randomUUID();
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YtMtWcAAAAASUVORK5CYII=',
  'base64',
);
const finding = report.findings[0];
assert.ok(finding, 'fixture needs at least one finding');
finding.evidenceRefs = [imageId, missingId];
report.example = false;
report.coverageGaps = ['受控示例中的未执行页面'];
report.warnings = ['受控示例：部分覆盖'];
const artifactBase = {
  projectId,
  runId,
  redaction: 'applied',
  createdAt: new Date().toISOString(),
  taskId: null,
  stepId: null,
  caseId: null,
  snapshotId: null,
};
const screenshot = {
  ...artifactBase,
  id: imageId,
  kind: 'screenshot',
  status: 'available',
  bytes: image.length,
  sha256: 'a'.repeat(64),
  contentUrl: `/api/v1/artifacts/${imageId}/content`,
  error: null,
};
const missing = {
  ...artifactBase,
  id: missingId,
  kind: 'screenshot',
  status: 'missing',
  bytes: null,
  sha256: null,
  contentUrl: null,
  error: 'Evidence is missing',
};
report.artifacts = [screenshot, missing];
const json = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});
const vite = await createViteServer({
  root,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await vite.listen();
  const address = vite.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const requests = [];
  const exports = new Map();
  let downloadedImageCount = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    requests.push(`${method} ${pathname}`);
    if (pathname === '/api/v1/auth/me') return route.fulfill(json(admin));
    if (pathname === '/api/v1/projects')
      return route.fulfill(json({ items: [project], nextCursor: null }));
    if (pathname === '/api/v1/runs' && method === 'GET')
      return route.fulfill(json({ items: [report.run], nextCursor: null }));
    if (pathname === `/api/v1/runs/${runId}` && method === 'GET')
      return route.fulfill(json(report.run));
    if (pathname === `/api/v1/runs/${runId}/cases`)
      return route.fulfill(json({ items: report.cases, nextCursor: null }));
    if (pathname === `/api/v1/runs/${runId}/tasks`)
      return route.fulfill(json({ items: [], nextCursor: null }));
    if (pathname === `/api/v1/runs/${runId}/findings`)
      return route.fulfill(json({ items: report.findings, nextCursor: null }));
    if (pathname === `/api/v1/runs/${runId}/messages`)
      return route.fulfill(json({ items: [], nextCursor: null }));
    if (pathname === `/api/v1/runs/${runId}/events`)
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: ':fixture\n\n',
      });
    if (pathname === `/api/v1/runs/${runId}/report`)
      return route.fulfill(json(report));
    if (pathname === `/api/v1/findings/${finding.id}`)
      return route.fulfill(json(finding));
    if (pathname === `/api/v1/artifacts/${imageId}`)
      return route.fulfill(json(screenshot));
    if (pathname === `/api/v1/artifacts/${missingId}`)
      return route.fulfill(json(missing));
    if (pathname === `/api/v1/artifacts/${imageId}/content`) {
      downloadedImageCount++;
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: image,
      });
    }
    if (pathname === `/api/v1/artifacts/${missingId}/content`)
      throw new Error('Missing evidence must never be downloaded');
    if (pathname === `/api/v1/runs/${runId}/exports` && method === 'POST') {
      const input = request.postDataJSON();
      assert.ok(['json', 'markdown', 'zip'].includes(input.format));
      assert.equal(input.includeArtifacts, input.format === 'zip');
      const id = randomUUID();
      const record = {
        id,
        runId,
        format: input.format,
        status: input.format === 'zip' ? 'queued' : 'ready',
        artifactId: input.format === 'zip' ? null : randomUUID(),
        snapshotAt: new Date().toISOString(),
        error: null,
      };
      exports.set(id, record);
      return route.fulfill(json(record, 202));
    }
    if (pathname.startsWith('/api/v1/exports/') && method === 'GET') {
      const id = pathname.split('/').at(-1);
      const exp = exports.get(id);
      if (!exp) return route.fulfill(json({ code: 'NOT_FOUND' }, 404));
      Object.assign(exp, { status: 'ready', artifactId: randomUUID() });
      return route.fulfill(json(exp));
    }
    if (/^\/api\/v1\/artifacts\/[^/]+\/content$/.test(pathname)) {
      const id = pathname.split('/')[4];
      const exp = [...exports.values()].find((e) => e.artifactId === id);
      assert.ok(exp, `unexpected artifact ${id}`);
      const content =
        exp.format === 'json'
          ? Buffer.from(JSON.stringify(report))
          : exp.format === 'markdown'
            ? Buffer.from('# T44 Actual Markdown Export\n')
            : Buffer.from('504b030400000000', 'hex');
      return route.fulfill({
        status: 200,
        contentType:
          exp.format === 'json'
            ? 'application/json'
            : exp.format === 'markdown'
              ? 'text/markdown'
              : 'application/zip',
        body: content,
      });
    }
    return route.fulfill(
      json({ code: 'NOT_FOUND', message: 'unused fixture endpoint' }, 404),
    );
  });
  await page.goto(`${origin}/#/workbench?runId=${runId}`);
  await page.getByTestId('workbench-container').waitFor();
  await page.getByTestId('tab-btn-report').click();
  await page.getByTestId('report-export-panel').waitFor();
  await page
    .getByTestId('report-evidence-summary')
    .getByText('受控示例中的未执行页面')
    .waitFor();

  for (const [format, suffix] of [
    ['json', '.json'],
    ['markdown', '.md'],
  ]) {
    const dlPromise = page.waitForEvent('download');
    await page.getByTestId(`btn-export-${format}`).click();
    const download = await dlPromise;
    assert.ok(download.suggestedFilename().endsWith(suffix));
    const bytes = readFileSync(await download.path());
    assert.ok(bytes.length > 0);
    if (format === 'json')
      assert.equal(JSON.parse(bytes.toString()).run.id, runId);
    else assert.match(bytes.toString(), /T44 Actual Markdown Export/);
    await page.getByTestId('export-notice-message').waitFor();
  }
  await page.getByTestId('btn-export-zip').click();
  await page.getByTestId('btn-refresh-export').waitFor();
  const zipPromise = page.waitForEvent('download');
  await page.getByTestId('btn-refresh-export').click();
  const zip = await zipPromise;
  assert.ok(zip.suggestedFilename().endsWith('.zip'));
  assert.equal(
    readFileSync(await zip.path())
      .subarray(0, 2)
      .toString(),
    'PK',
  );
  assert.equal(exports.size, 3);

  await page.getByTestId(`report-finding-${finding.id}`).click();
  await page.getByTestId('finding-detail-page').waitFor();
  await page.getByTestId(`evidence-row-${imageId}`).waitFor();
  await page.getByTestId(`evidence-unavailable-${missingId}`).waitFor();
  const imgDownloadPromise = page.waitForEvent('download');
  await page.getByTestId(`btn-download-evidence-${imageId}`).click();
  const imgDownload = await imgDownloadPromise;
  assert.deepEqual(readFileSync(await imgDownload.path()), image);
  await page.getByTestId(`btn-preview-evidence-${imageId}`).click();
  await page.getByTestId('evidence-screenshot').waitFor();
  await page.waitForFunction(() => {
    const imageElement = globalThis.document.querySelector(
      '[data-testid="evidence-screenshot"]',
    );
    return imageElement?.complete && imageElement.naturalWidth > 0;
  });
  assert.equal(downloadedImageCount, 2);
  assert.ok(requests.includes(`GET /api/v1/artifacts/${missingId}`));
  assert.ok(!requests.includes(`GET /api/v1/artifacts/${missingId}/content`));
  await page.close();
  console.log(
    'T44_PRODUCT_UI_ACCEPTED real report + JSON/Markdown/ZIP downloads + pending export + multi-evidence + PNG preview',
  );
} finally {
  await browser?.close();
  await vite.close();
}
