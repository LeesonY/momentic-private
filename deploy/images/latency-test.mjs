import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Build a run, wait for it running, then drive the UI in a fresh browser and
// post a message while the page is open. The page's SSE/polling calls
// recordMessageRendered(marker, createdAt); we read window.__messageTelemetryHistory.
export async function measureEventToUi({
  http,
  cookie,
  adminPassword,
  project,
  root,
}) {
  const samples = [];
  const targetCount = 20;
  for (let i = 0; i < targetCount; i++) {
    const marker = `ACCEPT_MARKER_${i}_${randomBytes(3).toString('hex').toUpperCase()}`;
    const runRes = await http(
      'POST',
      '/api/v1/runs',
      {
        projectId: project.id,
        targetUrl:
          'http://localqa-t09b-fixture:8080/fix-02-delayed.html?delay=5000',
        brief:
          'Delayed rendering page; keep the run active for message injection window.',
        budget: {
          maxActiveSeconds: 600,
          maxActionsPerCase: 30,
          maxActions: 120,
          maxCases: 8,
          maxPages: 6,
          maxModelCalls: 100,
          maxDepth: 2,
          maxReproductions: 3,
          concurrency: 2,
          maxTotalTokens: 300000,
        },
      },
      cookie,
    );
    if (runRes.status !== 202) {
      samples.push({ marker, error: `run ${runRes.status}` });
      continue;
    }
    const runId = runRes.json.id;
    let run;
    for (let j = 0; j < 25; j++) {
      run = (await http('GET', `/api/v1/runs/${runId}`, null, cookie)).json;
      if (run.status === 'running') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (run.status !== 'running') {
      samples.push({ marker, error: `run not running: ${run.status}` });
      continue;
    }
    const cvAtOpen = run.contextVersion;
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
        contextVersion: cvAtOpen,
      }),
      { mode: 0o600 },
    );
    const script = `const fs=await import('node:fs/promises'); const input=JSON.parse(await fs.readFile('${file}','utf8')); const task=await taskSpace('T09-B latency'); const page=task.page('p1'); let out={spaceId:task.spaceId,marker:input.marker}; try { await page.cdp('Security.setIgnoreCertificateErrors',{ignore:true}); await page.goto('https://127.0.0.1:18443/'); const loginVisible=await page.evaluate(()=>!!document.querySelector('[data-testid="login-page"]')); if(loginVisible){ await page.fill('[data-testid="login-username-input"]',input.email); await page.fill('[data-testid="login-password-input"]',input.password); await page.click('button[type=submit]'); await page.waitForFunction(() => !document.querySelector('[data-testid="login-page"]') || !!document.querySelector('[data-testid="login-error-message"]'),undefined,{timeout:12000}); await page.waitForFunction(() => location.hash.includes('/home') || !!document.querySelector('[data-testid="btn-logout"]'),undefined,{timeout:12000}); } await page.goto('https://127.0.0.1:18443/#/workbench?runId='+input.runId); const stillLogin=await page.evaluate(()=>!!document.querySelector('[data-testid="login-page"]')); if(stillLogin){ await page.fill('[data-testid="login-username-input"]',input.email); await page.fill('[data-testid="login-password-input"]',input.password); await page.click('button[type=submit]'); await page.waitForFunction(() => !document.querySelector('[data-testid="login-page"]') || !!document.querySelector('[data-testid="login-error-message"]'),undefined,{timeout:12000}); await page.waitForFunction(() => location.hash.includes('/home') || !!document.querySelector('[data-testid="btn-logout"]'),undefined,{timeout:12000}); await page.goto('https://127.0.0.1:18443/#/workbench?runId='+input.runId); } await page.waitForSelector('[data-testid="workbench-page"]',{state:'visible',timeout:20000}); await page.waitForSelector('[data-testid="run-messages-card"]',{state:'visible',timeout:12000}).catch(()=>{}); const deadline=Date.now()+10000; while(Date.now()<deadline){ const hit=await page.evaluate((m)=>{ const h=(window.__messageTelemetryHistory||[]).find(t=>t.marker===m); return h||null; },input.marker); if(hit){ out.telemetry=hit; break; } await page.waitForTimeout(60); } if(!out.telemetry){ out.error='no telemetry for marker'; try{ out.domHasMarker=await page.evaluate((m)=>document.body.innerText.includes(m),input.marker); out.telemetryCount=await page.evaluate(()=>(window.__messageTelemetryHistory||[]).length); out.bodyText=(await page.evaluate(()=>document.body.innerText.slice(0,800))); }catch(e){out.domError=String(e)} } } catch(e){out.error=String(e)} console.log('ACCEPT_LATENCY_JSON '+JSON.stringify(out)); await task.finish({keep:[]});`;
    // Start the browser script in the background, post the message, then wait
    // for the page to render the marker. This keeps the run's execution window
    // real instead of posting before the page exists.
    const child = spawn('ego-browser', ['nodejs', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    await new Promise((r) => setTimeout(r, 3000));
    const messageRes = await http(
      'POST',
      `/api/v1/runs/${runId}/messages`,
      { expectedContextVersion: cvAtOpen, text: marker },
      cookie,
    );
    if (messageRes.status !== 202) {
      child.kill('SIGKILL');
      samples.push({
        marker,
        error: `message ${messageRes.status} ${JSON.stringify(messageRes.json)}`,
        runStatusAtPost: run.status,
      });
      rmSync(file, { force: true });
      continue;
    }
    const result = await new Promise((resolve) => {
      child.on('close', (code) => resolve({ status: code, stdout, stderr }));
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ status: null, stdout, stderr });
      }, 120000);
    });
    rmSync(file, { force: true });
    const match = (result.stderr || result.stdout)?.match(
      /ACCEPT_LATENCY_JSON (\{[^\n]+\})/,
    );
    const parsed = match ? JSON.parse(match[1]) : null;
    const telemetry = parsed?.telemetry;
    samples.push({
      marker,
      postStatus: parsed?.postStatus,
      postBody: parsed?.postBody,
      runStatus: parsed?.runStatus,
      sentCv: parsed?.sentCv ?? null,
      sentMarker: parsed?.sentMarker,
      latencyMs: telemetry?.latencyMs ?? null,
      dbCommitAt: telemetry?.dbCommitAt ?? null,
      uiRenderedAt: telemetry?.uiRenderedAt ?? null,
      error: telemetry
        ? null
        : (parsed?.error ??
          (parsed?.domHasMarker
            ? `telemetry missing but marker visible in DOM (telemetryCount=${parsed.telemetryCount})`
            : `no telemetry (telemetryCount=${parsed?.telemetryCount})`)),
      domHasMarker: parsed?.domHasMarker,
      bodyText: parsed?.bodyText?.slice(0, 400),
    });
  }
  const ok = samples.filter((s) => s.latencyMs != null);
  const latencies = ok.map((s) => s.latencyMs).sort((a, b) => a - b);
  const p95 = latencies.length
    ? latencies[Math.ceil(latencies.length * 0.95) - 1]
    : null;
  return {
    count: samples.length,
    measured: ok.length,
    p95Ms: p95,
    minMs: latencies[0] ?? null,
    maxMs: latencies.at(-1) ?? null,
    samples,
    note: 'latencyMs = browser Date.now() at DOM render - Date.parse(run_messages.created_at); both captured on the same browser clock via recordMessageRendered',
  };
}
