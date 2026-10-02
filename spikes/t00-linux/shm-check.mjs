// shm-check.mjs: verify Chromium behavior under restricted /dev/shm
import { execSync } from 'child_process';
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
        throw new Error(`Failed to load playwright: ${e1.message}; ${e2.message}; ${e3.message}`);
      }
    }
  }
}

const EVIDENCE_DIR = process.env.EVIDENCE_DIR || '/evidence';

async function main() {
  console.log('=== SHM CONFIGURATION & BEHAVIOR CHECK ===');
  
  const shmDf = execSync('df -h /dev/shm').toString();
  console.log('Current /dev/shm status:');
  console.log(shmDf);

  // Test 1: Launch Chromium without --disable-dev-shm-usage, with chromiumSandbox: true
  console.log('Test 1: Launch Chromium with standard /dev/shm usage and chromiumSandbox: true...');
  let test1Passed = false;
  let test1Error = null;
  try {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: []
    });
    const page = await browser.newPage();
    await page.setContent('<html><body><h1>SHM Normal Test</h1><div style="width:2000px; height:2000px; background:blue;">Big Canvas/DOM</div></body></html>');
    const title = await page.$eval('h1', el => el.textContent);
    console.log('Test 1 Content loaded:', title);
    await browser.close();
    test1Passed = true;
  } catch (err) {
    test1Error = err.message;
    console.error('Test 1 failed:', err.message);
  }

  // Test 2: Launch Chromium with --disable-dev-shm-usage (fallback to /tmp)
  console.log('Test 2: Launch Chromium with --disable-dev-shm-usage (fallback to /tmp)...');
  let test2Passed = false;
  let test2Error = null;
  try {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: ['--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent('<html><body><h1>SHM Fallback Test (/tmp)</h1></body></html>');
    const title = await page.$eval('h1', el => el.textContent);
    console.log('Test 2 Content loaded:', title);
    await browser.close();
    test2Passed = true;
  } catch (err) {
    test2Error = err.message;
    console.error('Test 2 failed:', err.message);
  }

  const report = {
    shmDf: shmDf.trim(),
    test1StandardShm: { passed: test1Passed, error: test1Error },
    test2FallbackTmp: { passed: test2Passed, error: test2Error }
  };

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'shm-check-result.json'), JSON.stringify(report, null, 2));
  console.log('=== SHM CHECK COMPLETED ===');
}

main().catch(err => {
  console.error('FATAL in shm-check:', err);
  process.exit(1);
});
