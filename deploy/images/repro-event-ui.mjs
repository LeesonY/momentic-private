// Minimal repro for 5_event_to_ui_p95: ring-by-ring diagnosis.
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../..', import.meta.url));
const deploy = `${root}/deploy`;
const out = `${root}/docs/validation-results/T09B-repro.json`;
const evidence = {
  task: 'T09-B-repro-5_event_to_ui',
  recordedAt: new Date().toISOString(),
  rings: {},
};

const containers = [
  'localqa-gateway',
  'localqa-web',
  'localqa-api',
  'localqa-orchestrator',
  'localqa-worker',
  'localqa-postgres',
  'localqa-t09b-fixture',
];
const volumes = ['localqa-pgdata', 'localqa-data'];
const networks = ['localqa-frontend', 'localqa-backend'];
const owned = ['.env', 'secrets', 'certs', 'ca'].map((n) => `${deploy}/${n}`);
if (
  owned.some(existsSync) ||
  containers.some(
    (n) => cmd('docker', ['container', 'inspect', n], true).status === 0,
  ) ||
  volumes.some(
    (n) => cmd('docker', ['volume', 'inspect', n], true).status === 0,
  ) ||
  networks.some(
    (n) => cmd('docker', ['network', 'inspect', n], true).status === 0,
  )
)
  throw new Error(
    'Refusing to touch existing deployment inputs or containers/volumes',
  );

function cmd(program, args, quiet = false) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 5 * 1024 * 1024,
  });
  if (!quiet && result.status !== 0)
    throw new Error(
      `${program} ${args.slice(0, 5).join(' ')} failed: ${(result.stderr || result.stdout).slice(-700)}`,
    );
  return result;
}
function compose(args) {
  return cmd('docker', ['compose', '-f', 'deploy/docker-compose.yml', ...args]);
}
function http(method, path, body, cookie, timeout = 10000) {
  return new Promise((done, fail) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: 18443,
        servername: 'localqa.internal',
        path,
        method,
        ca: readFileSync(`${deploy}/certs/tls.crt`),
        timeout,
        headers: {
          Host: '127.0.0.1:18443',
          Origin: 'https://127.0.0.1:18443',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body
            ? {
                'Content-Type': 'application/json',
                'Idempotency-Key': randomBytes(12).toString('hex'),
              }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (b) => (raw += b));
        res.on('end', () =>
          done({
            status: res.statusCode,
            headers: res.headers,
            json: (() => {
              try {
                return JSON.parse(raw);
              } catch {
                return raw;
              }
            })(),
          }),
        );
      },
    );
    req.on('error', fail);
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function requireStatus(method, path, body, cookie, status) {
  const res = await http(method, path, body, cookie);
  if (res.status !== status)
    throw new Error(
      `${method} ${path}: expected ${status}, got ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`,
    );
  return res;
}

let cleanupError = null;
try {
  for (const p of owned.slice(1)) mkdirSync(p, { mode: 0o700 });
  chmodSync(`${deploy}/secrets`, 0o711);
  const password = randomBytes(24).toString('hex');
  const adminPassword = `T09-${randomBytes(18).toString('hex')}!`;
  const kek = randomBytes(32).toString('base64');
  const identity = randomBytes(32).toString('hex');
  for (const [name, data] of Object.entries({
    postgres_password: password,
    admin_initial_password: adminPassword,
    'kek.json': JSON.stringify({ activeVersion: 1, keys: { 1: kek } }),
    'worker_identity.json': identity,
  }))
    writeFileSync(`${deploy}/secrets/${name}`, data, { mode: 0o600 });
  cmd('docker', [
    'run',
    '--rm',
    '-v',
    `${deploy}/secrets:/secrets`,
    '--entrypoint',
    'chown',
    'node:24-bookworm-slim',
    '1001:1001',
    '/secrets/kek.json',
    '/secrets/worker_identity.json',
    '/secrets/service_identity.json',
    '/secrets/admin_initial_password',
  ]);
  cmd('docker', [
    'run',
    '--rm',
    '-v',
    `${deploy}/secrets:/secrets`,
    '--entrypoint',
    'chown',
    'node:24-bookworm-slim',
    '70:70',
    '/secrets/postgres_password',
  ]);
  cmd('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-keyout',
    `${deploy}/certs/tls.key`,
    '-out',
    `${deploy}/certs/tls.crt`,
    '-subj',
    '/CN=localqa.internal',
    '-addext',
    'subjectAltName=DNS:localqa.internal,IP:127.0.0.1',
  ]);
  writeFileSync(
    `${deploy}/.env`,
    `DATABASE_URL=postgresql://localqa:${password}@postgres:5432/localqa\nPUBLIC_ORIGIN=https://127.0.0.1:18443\nDATA_DIR=/var/localqa/data\nMASTER_KEY_FILE=/run/secrets/kek.json\nWORKER_IDENTITY_FILE=/run/secrets/worker_identity.json\nSERVICE_IDENTITY_FILE=/run/secrets/service_identity.json\nLOCALQA_ALLOW_TEST_STUB=1\nBROWSER_SLOTS=4\nJOB_HEARTBEAT_SECONDS=10\nJOB_LEASE_SECONDS=45\nJOB_POLL_INTERVAL_MS=500\nWORKER_FIXTURE_URL=http://localqa-t09b-fixture:8080/\nLOCALQA_API_IMAGE=localqa-api:latest\nLOCALQA_WORKER_IMAGE=localqa-worker:latest\nLOCALQA_ORCHESTRATOR_IMAGE=localqa-orchestrator:latest\nLOCALQA_WEB_IMAGE=localqa-web:latest\nGATEWAY_HTTP_PORT=18080\nGATEWAY_HTTPS_PORT=18443\n`,
    { mode: 0o600 },
  );
  compose(['config', '--quiet']);
  compose(['up', '-d', '--wait', 'postgres']);
  cmd('docker', [
    'run',
    '--rm',
    '-v',
    'localqa-data:/data',
    '--entrypoint',
    'chown',
    'node:24-bookworm-slim',
    '1001:1001',
    '/data',
  ]);
  compose([
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'node',
    'api',
    '/app/deploy/scripts/migrate.mjs',
  ]);
  compose([
    'run',
    '--rm',
    '--no-deps',
    '-e',
    'ADMIN_INITIAL_EMAIL=admin@localqa.internal',
    '--entrypoint',
    'node',
    'api',
    '/app/deploy/scripts/bootstrap-admin.mjs',
  ]);
  cmd('docker', [
    'run',
    '-d',
    '--name',
    'localqa-t09b-fixture',
    '--network',
    'localqa-backend',
    '-v',
    `${root}:/app:ro`,
    '-w',
    '/app',
    '-e',
    'PORT=8080',
    'node:24-bookworm-slim',
    'node',
    'packages/test-fixture/server.js',
  ]);
  compose([
    'up',
    '-d',
    '--wait',
    'api',
    'web',
    'orchestrator',
    'worker',
    'gateway',
  ]);
  const login = await requireStatus(
    'POST',
    '/api/v1/auth/login',
    { email: 'admin@localqa.internal', password: adminPassword },
    null,
    200,
  );
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  const project = (
    await requireStatus(
      'POST',
      '/api/v1/projects',
      { name: 'T09B repro fixture' },
      cookie,
      201,
    )
  ).json;
  const model = (
    await requireStatus(
      'POST',
      '/api/v1/model-profiles',
      {
        name: 'T09B repro stub',
        endpoint: 'https://stub.example.test/v1',
        configuredModelId: 'stub-normal',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
      },
      cookie,
      201,
    )
  ).json;
  await requireStatus(
    'PATCH',
    `/api/v1/projects/${project.id}`,
    { expectedVersion: project.version, defaultModelProfileId: model.id },
    cookie,
    200,
  );
  // slow run with a real message-injection window
  const run = (
    await requireStatus(
      'POST',
      '/api/v1/runs',
      {
        projectId: project.id,
        targetUrl:
          'http://localqa-t09b-fixture:8080/fix-02-delayed.html?delay=5000',
        brief: 'repro',
        budget: { maxActiveSeconds: 600 },
      },
      cookie,
      202,
    )
  ).json;
  let running;
  for (let i = 0; i < 30; i++) {
    running = (await http('GET', `/api/v1/runs/${run.id}`, null, cookie)).json;
    if (running.status === 'running') break;
    await delay(300);
  }
  if (running.status !== 'running')
    throw new Error(`run not running: ${running.status}`);
  const marker = `REPRO_${randomBytes(4).toString('hex').toUpperCase()}`;
  const posted = await requireStatus(
    'POST',
    `/api/v1/runs/${run.id}/messages`,
    { expectedContextVersion: running.contextVersion, text: marker },
    cookie,
    202,
  );
  evidence.rings.ring0_post = {
    status: posted.status,
    contextVersionAfter: posted.json?.contextVersion,
  };
  evidence.rings.ring1_api = { note: 'GET messages via API with same session' };
  const list = await http(
    'GET',
    `/api/v1/runs/${run.id}/messages`,
    null,
    cookie,
  );
  evidence.rings.ring1_api.status = list.status;
  evidence.rings.ring1_api.body = list.json;
  if (list.status !== 200) {
    evidence.rings.ring1_api.error = `GET messages returned ${list.status}: ${JSON.stringify(list.json).slice(0, 300)}`;
    // Grab API logs to see the real error behind the 503.
    evidence.rings.ring1_api.apiLogs = cmd(
      'docker',
      ['logs', '--tail', '40', 'localqa-api'],
      true,
    ).stderr.slice(-2500);
  }
  evidence.rings.ring1_api.markerPresent = JSON.stringify(list.json).includes(
    marker,
  );
  evidence.rings.ring1_api.firstItemKeys = list.json?.items?.[0]
    ? Object.keys(list.json.items[0])
    : null;

  // Ring 2: does the front-end parser accept the real payload?
  evidence.rings.ring2_frontend_accept = {
    note: 'feed real API payload into parseRunMessage logic (from built bundle semantics)',
  };
  const parseScript = `const fs=await import('node:fs/promises'); const input=JSON.parse(await fs.readFile(process.env.REPRO_INPUT,'utf8')); const payload=input.payload; try { const items=Array.isArray(payload)?payload:(payload.items||[]); const accepted=[]; for(const m of items){ if(m&&typeof m.id==='string'&&typeof m.runId==='string'&&typeof m.actorId==='string'&&typeof m.contextVersion==='number'&&typeof m.redactedText==='string'&&typeof m.createdAt==='string') accepted.push(m); } console.log('ACCEPTED '+accepted.length+'/'+items.length+' hasMarker='+accepted.some(m=>m.redactedText.includes(input.marker))); } catch(e){ console.log('PARSE_ERROR '+String(e)); }`;
  writeFileSync(
    `${deploy}/repro-input.json`,
    JSON.stringify({ payload: list.json, marker }),
    { mode: 0o600 },
  );
  const parseOut = spawnSync(
    'node',
    ['--input-type=module', '-e', parseScript],
    {
      env: { ...process.env, REPRO_INPUT: `${deploy}/repro-input.json` },
      encoding: 'utf8',
    },
  );
  evidence.rings.ring2_frontend_accept.output = parseOut.stdout.trim();
  evidence.rings.ring2_frontend_accept.exitCode = parseOut.status;
  rmSync(`${deploy}/repro-input.json`, { force: true });

  // Ring 3: production bundle in the container == local build?
  evidence.rings.ring3_bundle = {
    note: 'compare container bundle vs local apps/web build output',
  };
  const localHash = createHash('sha256')
    .update(readFileSync(`${root}/apps/web/dist/index.html`))
    .digest('hex');
  cmd(
    'docker',
    ['exec', 'localqa-web', 'cat', '/app/apps/web/dist/index.html'],
    true,
  );
  const containerAssets = cmd(
    'docker',
    ['exec', 'localqa-web', 'ls', '/app/apps/web/dist/assets'],
    true,
  )
    .stdout.trim()
    .split('\n');
  const mainAsset = containerAssets.find((a) => a.endsWith('.js'));
  const containerJs = cmd(
    'docker',
    ['exec', 'localqa-web', 'cat', `/app/apps/web/dist/assets/${mainAsset}`],
    true,
  ).stdout;
  evidence.rings.ring3_bundle.localIndexHash = localHash;
  evidence.rings.ring3_bundle.containerAsset = mainAsset;
  evidence.rings.ring3_bundle.containerHasRecordMessageRendered =
    containerJs.includes('recordMessageRendered') ||
    containerJs.includes('__messageTelemetryHistory');
  evidence.rings.ring3_bundle.containerHasRunMessagesCard =
    containerJs.includes('run-messages-card');

  // Ring 4: real browser render — select the repro project first so the
  // workbench's message polling targets the right run, then read telemetry.
  evidence.rings.ring4_render = {
    note: 'real browser: select project, open workbench, read __messageTelemetryHistory and DOM',
  };
  const browserInputPath = `${deploy}/repro-browser-input.json`;
  writeFileSync(
    browserInputPath,
    JSON.stringify({
      email: 'admin@localqa.internal',
      password: adminPassword,
      runId: run.id,
      projectId: project.id,
      marker,
    }),
    { mode: 0o600 },
  );
  const browserScript = `const fs=await import('node:fs/promises'); const input=JSON.parse(await fs.readFile(${JSON.stringify(browserInputPath)},'utf8')); const task=await taskSpace('T09-B repro'); const page=task.page('p1'); let out={spaceId:task.spaceId}; try { await page.cdp('Security.setIgnoreCertificateErrors',{ignore:true}); await page.goto('https://127.0.0.1:18443/'); const loginVisible=await page.evaluate(()=>!!document.querySelector('[data-testid="login-page"]')); if(loginVisible){ await page.fill('[data-testid="login-username-input"]',input.email); await page.fill('[data-testid="login-password-input"]',input.password); await page.click('button[type=submit]'); await page.waitForFunction(() => !document.querySelector('[data-testid="login-page"]') || !!document.querySelector('[data-testid="login-error-message"]'),undefined,{timeout:12000}); } await page.goto('https://127.0.0.1:18443/#/workbench?runId='+input.runId); await page.waitForSelector('[data-testid="workbench-page"]',{state:'visible',timeout:12000}); await page.waitForSelector('[data-testid="run-messages-card"]',{state:'visible',timeout:12000}).catch(()=>{}); out.messagesCountAtOpen=await page.evaluate(()=>document.querySelector('[data-testid="run-messages-count"]')?.textContent); out.sseStatusAtOpen=await page.evaluate(()=>document.body.innerText.includes('SSE')?'SSE-pill-present':'SSE-pill-absent'); out.runDebug=await page.evaluate(()=>{ const el=document.querySelector('[data-testid="run-messages-card"]'); const run=document.body.innerText.match(/上下文版本: v(\\d+)/)?.[1]; const status=document.body.innerText.match(/(执行中|调度已完成|已取消|失败)/)?.[1]; return {hasCard:!!el,contextVersion:run,status}; }); out.pageHtmlSnippet=await page.evaluate(()=>{ const el=document.querySelector('[data-testid="run-messages-card"]'); return el?el.outerHTML.slice(0,600):'NO_CARD'; }).catch(e=>'EVAL_ERR '+String(e)); out.screenshot=await page.screenshot({path:'${root}/deploy/.evidence/repro-workbench.png'}).catch(()=>null); const deadline=Date.now()+10000; while(Date.now()<deadline){ const hit=await page.evaluate((m)=>{ const h=(window.__messageTelemetryHistory||[]).find(t=>t.marker===m); return h||null; },input.marker); if(hit){ out.telemetry=hit; break; } await page.waitForTimeout(120); } out.telemetryCount=await page.evaluate(()=>(window.__messageTelemetryHistory||[]).length); out.messagesCount=await page.evaluate(()=>document.querySelector('[data-testid="run-messages-count"]')?.textContent); out.domHasMarker=await page.evaluate((m)=>document.body.innerText.includes(m),input.marker); out.bodyText=await page.evaluate(()=>document.body.innerText.slice(0,1200)); } catch(e){out.error=String(e)} console.log('REPRO_BROWSER_JSON '+JSON.stringify(out)); await task.finish({keep:[]});`;
  const browserOut = spawnSync('ego-browser', ['nodejs', '-e', browserScript], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  rmSync(browserInputPath, { force: true });
  const bMatch = (browserOut.stderr || browserOut.stdout)?.match(
    /REPRO_BROWSER_JSON (\{[^\n]+\})/,
  );
  evidence.rings.ring4_render.raw = bMatch ? JSON.parse(bMatch[1]) : null;
  evidence.rings.ring4_render.stderrTail = browserOut.stderr?.slice(-1500);

  // Decide where the chain breaks.
  const r1 =
    evidence.rings.ring1_api.markerPresent === true &&
    evidence.rings.ring1_api.status === 200;
  const r2 =
    evidence.rings.ring2_frontend_accept.output.includes('hasMarker=true');
  const r3 =
    evidence.rings.ring3_bundle.containerHasRecordMessageRendered === true;
  const r4 = evidence.rings.ring4_render.raw?.telemetry != null;
  evidence.diagnosis = !r1
    ? 'API does not return the message (backend/contract issue)'
    : !r2
      ? 'frontend parser rejects the payload (schema mismatch, e.g. missing projectId)'
      : !r3
        ? 'container bundle lacks the fix (old web image)'
        : !r4
          ? 'render/polling layer: API returns and parser accepts, but UI does not render (polling stopped early / SSE handling)'
          : 'all rings passed';
  evidence.allPassed = r1 && r2 && r3 && r4;
} catch (error) {
  evidence.error = String(error);
} finally {
  cmd('docker', ['rm', '-f', 'localqa-t09b-fixture'], true);
  const down = cmd(
    'docker',
    [
      'compose',
      '-f',
      'deploy/docker-compose.yml',
      'down',
      '--volumes',
      '--remove-orphans',
    ],
    true,
  );
  if (down.status !== 0) cleanupError = down.stderr;
  for (const p of owned) rmSync(p, { recursive: true, force: true });
  evidence.cleanup = {
    containers: containers.filter(
      (n) => cmd('docker', ['container', 'inspect', n], true).status === 0,
    ),
    volumes: volumes.filter(
      (n) => cmd('docker', ['volume', 'inspect', n], true).status === 0,
    ),
    networks: networks.filter(
      (n) => cmd('docker', ['network', 'inspect', n], true).status === 0,
    ),
    credentialsPresent: owned.some(existsSync),
    downError: cleanupError,
  };
  writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        diagnosis: evidence.diagnosis,
        allPassed: evidence.allPassed,
        cleanup: evidence.cleanup,
      },
      null,
      2,
    ),
  );
}
