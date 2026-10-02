import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, '..');
const distDir = path.resolve(webDir, 'dist');
const screenshotsDir = path.resolve(webDir, 'screenshots');

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

// Ensure screenshots dir
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

// 1. Static file server for apps/web/dist
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (_err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

const PORT = 5188;

async function run() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`Preview server listening on http://127.0.0.1:${PORT}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 850 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const results = [];

  try {
    // Flow 1: Launch Page (URL Input, Environment, Model notice)
    console.log('Capturing Flow 1: Launch Page...');
    await page.goto(`http://127.0.0.1:${PORT}/#/home`);
    await page.waitForSelector('[data-testid="project-home-page"]');
    await page.waitForSelector('[data-testid="external-model-notice"]');
    const path1 = path.join(screenshotsDir, '01-launch-page.png');
    await page.screenshot({ path: path1, fullPage: false });
    results.push({ name: '01-launch-page.png', path: path1, ok: true });

    // Flow 2: Run Workbench with partial report and reconnecting banner
    console.log(
      'Capturing Flow 2: Workbench with partial & reconnecting state...',
    );
    await page.goto(
      `http://127.0.0.1:${PORT}/#/workbench?runId=run_mock_002_partial`,
    );
    await page.waitForSelector('[data-testid="workbench-page"]');
    await page.waitForSelector('[data-testid="reconnect-banner"]');
    await page.waitForSelector('[data-testid="error-card-partial_report"]');
    const path2 = path.join(
      screenshotsDir,
      '02-workbench-partial-reconnecting.png',
    );
    await page.screenshot({ path: path2, fullPage: false });
    results.push({
      name: '02-workbench-partial-reconnecting.png',
      path: path2,
      ok: true,
    });

    // Flow 3: Case Detail
    console.log('Capturing Flow 3: Case Detail...');
    await page.goto(
      `http://127.0.0.1:${PORT}/#/case-detail?caseId=case_mock_10&runId=run_mock_001_completed`,
    );
    await page.waitForSelector('[data-testid="case-detail-page"]');
    await page.waitForSelector('[data-testid="criteria-table"]');
    await page.waitForSelector('[data-testid="step-row-3"]');
    const path3 = path.join(screenshotsDir, '03-case-detail.png');
    await page.screenshot({ path: path3, fullPage: false });
    results.push({ name: '03-case-detail.png', path: path3, ok: true });

    // Flow 4: Finding Detail & Triage Preview Modal
    console.log('Capturing Flow 4: Finding Detail & Triage Preview Modal...');
    await page.goto(
      `http://127.0.0.1:${PORT}/#/finding-detail?findingId=find_mock_01_calc_error&runId=run_mock_001_completed`,
    );
    await page.waitForSelector('[data-testid="finding-detail-page"]');
    await page.waitForSelector('[data-testid="btn-open-triage"]');
    await page.click('[data-testid="btn-open-triage"]');
    await page.waitForSelector('[data-testid="triage-modal-content"]');
    await page.fill(
      '[data-testid="triage-reason-textarea"]',
      '经研发与测试联调复核，确认优惠计算未扣减，准予提交决议',
    );
    await page.click('[data-testid="btn-request-triage-preview"]');
    await page.waitForSelector('[data-testid="btn-commit-triage-confirm"]');
    const path4 = path.join(screenshotsDir, '04-finding-triage-preview.png');
    await page.screenshot({ path: path4, fullPage: false });
    results.push({
      name: '04-finding-triage-preview.png',
      path: path4,
      ok: true,
    });

    console.log('All 4 screenshot captures succeeded:');
    for (const r of results) {
      const stats = fs.statSync(r.path);
      console.log(`- ${r.name}: ${stats.size} bytes (${r.path})`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error('Screenshot capture failed:', err);
  server.close();
  process.exit(1);
});
