#!/usr/bin/env node
import { chromium } from '../../packages/browser/node_modules/playwright/index.mjs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { readiness } from './readiness.mjs';

if (process.getuid() === 0) throw new Error('Refusing to run browser as root');
const target = process.env.WORKER_FIXTURE_URL || 'data:text/html,<button id="action">Ready</button>';
const scratch = '/var/localqa/scratch';
let running = true;
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { running = false; });
while (running) {
  try {
    const browser = await chromium.launch({ chromiumSandbox: true });
    try {
      const page = await browser.newPage();
      await page.goto(target, {waitUntil:'domcontentloaded',timeout:12000});
      // Actual, isolated, non-submitting action against an explicitly configured fixture.
      if (process.env.WORKER_FIXTURE_URL) {
        if (!(await page.title()).includes('LocalQA Test Fixture')) throw new Error('Fixture title mismatch');
        await page.getByTestId('tab-btn-details').click({timeout:5000});
        if (!(await page.getByTestId('tab-panel-details').isVisible())) throw new Error('Fixture tab action failed');
      } else await page.locator('button').click({timeout:5000});
      const pids = (await readdir('/proc')).filter((s) => /^\d+$/.test(s));
      const processes = [];
      for (const pid of pids) {
        try {
          const cmdline = (await readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0').filter(Boolean);
          if (!cmdline[0]?.includes('chrome')) continue;
          const status = await readFile(`/proc/${pid}/status`,'utf8');
          processes.push({uid: Number(status.match(/^Uid:\s+(\d+)/m)?.[1]), seccomp:Number(status.match(/^Seccomp:\s+(\d+)/m)?.[1]),noSandbox:cmdline.includes('--no-sandbox')});
        } catch { /* process exited during inspection */ }
      }
      if (!processes.length || processes.some((p) => p.uid === 0 || p.seccomp !== 2 || p.noSandbox)) throw new Error('Chromium sandbox invariant failed');
      if (!(await readiness())) throw new Error('Database/schema/data not ready');
      await writeFile(`${scratch}/sandbox-result.json`,JSON.stringify({node:process.version,uid:process.getuid(),url:target,action:process.env.WORKER_FIXTURE_URL?'details-tab.click':'button.click',processes,browserVersion:browser.version(),playwright:(await import('../../packages/browser/node_modules/playwright/package.json',{with:{type:'json'}})).default.version}));
      await writeFile(`${scratch}/browser-ready`,String(Date.now()));
    } finally { await browser.close(); }
  } catch (error) {
    console.error('Worker browser capacity not ready:',error.message);
    await import('node:fs/promises').then(({rm})=>rm(`${scratch}/browser-ready`,{force:true}));
  }
  if (running) await new Promise((r)=>setTimeout(r,15000));
}
// This entrypoint validates browser capacity; task-claim transport/identity is not integrated here.
