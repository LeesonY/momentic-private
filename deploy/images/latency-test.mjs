import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import https from 'node:https';

export async function measureEventToUi({
  cmd,
  http,
  sql,
  cookie,
  adminPassword,
  project,
  root,
}) {
  const marker = `ACCEPT_MARKER_${randomBytes(4).toString('hex').toUpperCase()}`;
  const runRes = await http(
    'POST',
    '/api/v1/runs',
    { projectId: project.id, targetUrl: 'http://localqa-t09b-fixture:8080/' },
    cookie,
  );
  if (runRes.status !== 202)
    return { error: `Run creation failed ${runRes.status}` };
  const runId = runRes.json.id;
  // Wait for the run to reach running phase before injecting message.
  let run;
  for (let i = 0; i < 20; i++) {
    run = (await http('GET', `/api/v1/runs/${runId}`, null, cookie)).json;
    if (run.status === 'running') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (run.status !== 'running')
    return { error: `Run not running: ${run.status}` };
  const messageRes = await http(
    'POST',
    `/api/v1/runs/${runId}/messages`,
    { expectedContextVersion: runRes.json.contextVersion, text: marker },
    cookie,
  );
  if (messageRes.status !== 202)
    return { error: `Message failed ${messageRes.status}` };
  const file = join(
    mkdtempSync(join(tmpdir(), 'localqa-latency-')),
    'input.json',
  );
  writeFileSync(
    file,
    JSON.stringify({
      email: 'admin@localqa.internal',
      password: adminPassword,
      runId,
      marker,
    }),
    { mode: 0o600 },
  );
  const script = `const fs=await import('node:fs/promises'); const input=JSON.parse(await fs.readFile('${file}','utf8')); const task=await taskSpace('T09-B event-to-ui'); const page=task.page('p1'); let out={spaceId:task.spaceId,marker:input.marker}; try { await page.cdp('Security.setIgnoreCertificateErrors',{ignore:true}); await page.goto('https://127.0.0.1:18443/'); const loginVisible=await page.evaluate(()=>!!document.querySelector('[data-testid="login-page"]')); if(loginVisible){ await page.fill('[data-testid="login-username-input"]',input.email); await page.fill('[data-testid="login-password-input"]',input.password); await page.click('button[type=submit]'); await page.waitForFunction(() => !document.querySelector('[data-testid="login-page"]') || !!document.querySelector('[data-testid="login-error-message"]'),undefined,{timeout:12000}); } const loginError=await page.evaluate(()=>!!document.querySelector('[data-testid="login-error-message"]')); if(loginError) throw new Error('Login failed'); await page.goto('https://127.0.0.1:18443/#/workbench?runId='+input.runId); await page.waitForSelector('[data-testid="workbench-page"]',{state:'visible',timeout:12000}); out.startedAt=Date.now(); const deadline=Date.now()+10000; while(Date.now()<deadline){ const visible=await page.evaluate(async (m)=>{ const res=await fetch('/api/v1/runs/'+location.hash.split('runId=')[1]+'/messages',{credentials:'include'}); const data=await res.json(); return Array.isArray(data) && data.some(msg=>msg.redactedText===m); },input.marker); if(visible){out.firstSeenAt=Date.now();break;} await page.waitForTimeout(60); } if(out.firstSeenAt) out.latencyMs=out.firstSeenAt-out.startedAt; } catch(e){out.error=String(e)} console.log('ACCEPT_LATENCY_JSON '+JSON.stringify(out)); await task.finish({keep:[]});`;
  let result;
  try {
    result = spawnSync('ego-browser', ['nodejs', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
  } finally {
    rmSync(file, { force: true });
  }
  const match = (result.stderr || result.stdout)?.match(
    /ACCEPT_LATENCY_JSON (\{[^\n]+\})/,
  );
  const parsed = match ? JSON.parse(match[1]) : null;
  const createdAt = sql(
    `SELECT created_at FROM run_messages WHERE redacted_text='${marker}' ORDER BY created_at DESC LIMIT 1`,
  );
  return {
    marker,
    createdAt,
    result: parsed,
    error: parsed?.error || result.stderr?.slice(-2000),
  };
}
