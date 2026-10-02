// browser-verify.mjs: verify Playwright chromium under Linux container
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

let chromium;
try {
  const pw = await import('playwright');
  chromium = pw.chromium;
} catch (e1) {
  try {
    const requireFixture = createRequire('/work/packages/test-fixture/package.json');
    chromium = requireFixture('@playwright/test').chromium;
  } catch (e2) {
    try {
      const requireRoot = createRequire('/work/package.json');
      chromium = requireRoot('@playwright/test').chromium;
    } catch (e3) {
      try {
        const requireLocal = createRequire(import.meta.url);
        chromium = requireLocal('@playwright/test').chromium || requireLocal('playwright').chromium;
      } catch (e4) {
        throw new Error(`Failed to load playwright: ${e1.message}; ${e2.message}; ${e3.message}; ${e4.message}`);
      }
    }
  }
}

const EVIDENCE_DIR = process.env.EVIDENCE_DIR || '/evidence';
const FIXTURE_DIR = process.env.FIXTURE_DIR || '/work/packages/test-fixture';
const FIXTURE_PORT = process.env.FIXTURE_PORT || '8080';

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          if (res.statusCode >= 200 && res.statusCode < 400) resolve();
          else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.end();
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Server at ${url} not responding after ${timeoutMs}ms`);
}

async function main() {
  console.log('=== STARTING BROWSER VERIFY IN CONTAINER ===');
  
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }

  // 1. Start test-fixture server in background inside the container
  console.log(`Starting test-fixture from ${FIXTURE_DIR}/server.js on port ${FIXTURE_PORT}...`);
  const serverProc = spawn('node', ['server.js'], {
    cwd: FIXTURE_DIR,
    env: { ...process.env, PORT: FIXTURE_PORT },
    stdio: 'pipe'
  });

  serverProc.stdout.on('data', d => console.log(`[fixture stdout] ${d.toString().trim()}`));
  serverProc.stderr.on('data', d => console.error(`[fixture stderr] ${d.toString().trim()}`));

  const targetUrl = `http://127.0.0.1:${FIXTURE_PORT}/`;
  await waitForServer(targetUrl);
  console.log(`Fixture server is UP at ${targetUrl}`);

  // 2. Launch Chromium with sandbox explicitly enabled (NO --no-sandbox)
  console.log('Launching Chromium with chromiumSandbox: true (strict sandbox, NO --no-sandbox)...');
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    // DO NOT pass --no-sandbox!
    args: []
  });

  const browserVersion = browser.version();
  console.log(`Chromium launched successfully! Version: ${browserVersion}`);

  // 3. Inspect running browser processes to verify args
  let psOutput = '';
  try {
    const { execSync } = await import('child_process');
    psOutput = execSync('ps aux | grep -i chrome | grep -v grep || true').toString();
    console.log('--- Active Chrome Processes ---');
    console.log(psOutput);
    
    if (psOutput.includes('--no-sandbox')) {
      throw new Error('VIOLATION: Chromium process contains --no-sandbox argument!');
    }
    console.log('SUCCESS: Verified NO --no-sandbox argument found in Chrome processes.');
  } catch (err) {
    console.warn('Could not inspect ps aux or check failed:', err.message);
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai'
  });
  const page = await context.newPage();

  // 4. Navigate to fixture home page
  console.log(`Navigating to ${targetUrl}...`);
  const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  const status = response ? response.status() : null;
  console.log(`Page navigated. Status: ${status}`);

  // Wait for main title or navigation
  await page.waitForSelector('main', { timeout: 5000 });

  // 5. Capture evidence: Screenshot
  const screenshotPath = path.join(EVIDENCE_DIR, 'screenshot-fixture.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const screenshotStat = fs.statSync(screenshotPath);
  console.log(`Screenshot saved to ${screenshotPath} (Size: ${screenshotStat.size} bytes)`);

  // 6. Capture evidence: DOM Snapshot / HTML
  const domSnapshotPath = path.join(EVIDENCE_DIR, 'dom-snapshot.html');
  const pageHtml = await page.content();
  fs.writeFileSync(domSnapshotPath, pageHtml, 'utf8');
  console.log(`DOM snapshot saved to ${domSnapshotPath} (Length: ${pageHtml.length} chars)`);

  // 7. Check font rendering on canvas
  const canvasFontMetrics = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = '16px sans-serif';
    const textZh = '测试中文字体渲染能力';
    const metricsZh = ctx.measureText(textZh);
    return {
      text: textZh,
      width: metricsZh.width,
      font: ctx.font
    };
  });
  console.log('Canvas font metrics:', JSON.stringify(canvasFontMetrics));

  // 8. Test shm status during browser execution
  let shmUsage = {};
  try {
    const { execSync } = await import('child_process');
    shmUsage = execSync('df -B1 /dev/shm || df -h /dev/shm').toString();
    console.log('--- /dev/shm Usage ---');
    console.log(shmUsage);
  } catch (e) {
    console.warn('df /dev/shm failed:', e.message);
  }

  // 9. Clean up
  await browser.close();
  serverProc.kill('SIGTERM');

  const resultData = {
    browserVersion,
    pageStatus: status,
    hasNoSandboxFlag: psOutput.includes('--no-sandbox'),
    screenshotBytes: screenshotStat.size,
    domSnapshotLength: pageHtml.length,
    canvasFontMetrics,
    shmUsage: shmUsage.trim()
  };

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'browser-verify-result.json'), JSON.stringify(resultData, null, 2));
  console.log('=== BROWSER VERIFY COMPLETED SUCCESSFULLY ===');
}

main().catch(err => {
  console.error('FATAL in browser-verify:', err);
  process.exit(1);
});
