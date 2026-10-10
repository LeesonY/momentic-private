#!/usr/bin/env node
// Isolated six-service preflight; refuses to overwrite any existing deployment input.
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
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { runAcceptanceExtras } from './acceptance-extra.mjs';

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const noBuild = argv.includes('--no-build');
const only = onlyArg
  ? onlyArg
      .slice('--only='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

const root = fileURLToPath(new URL('../..', import.meta.url));
const deploy = `${root}/deploy`;
const evidence = {
  task: 'T09-B-P0-acceptance',
  recordedAt: new Date().toISOString(),
  P0Passed: false,
  checks: [],
  unverified: [],
  cleanup: {},
};
const output = `${root}/docs/validation-results/T09B-acceptance.json`;
const previous = existsSync(output)
  ? JSON.parse(readFileSync(output, 'utf8'))
  : null;
evidence.runScope = only ? 'partial' : 'full';
evidence.only = only;
evidence.noBuild = noBuild;
evidence.baseRun = only ? previous?.recordedAt : null;
evidence.baseRunCategories = only
  ? Object.fromEntries(
      Object.entries(previous?.categories || {}).map(([k, v]) => [
        k,
        { status: v.status, recordedAt: previous?.recordedAt },
      ]),
    )
  : null;
function shouldRun(name) {
  return !effectiveOnly || effectiveOnly.includes(name);
}
// Declared dependency closure: each target check names the checks whose
// fixtures it needs (a running run, project/model bindings, etc.).
const CHECK_DEPS = {
  '5_event_to_ui_p95': ['2_end_to_end'],
  '6_ui_sse_partial_blocked': ['2_end_to_end'],
};
function withDeps(ids) {
  if (!ids) return null;
  const out = new Set(ids);
  for (const id of ids) for (const dep of CHECK_DEPS[id] || []) out.add(dep);
  return [...out];
}
const effectiveOnly = only ? withDeps(only) : null;
evidence.only = only;
evidence.effectiveOnly = effectiveOnly;
evidence.prerequisiteChecks =
  effectiveOnly?.filter((k) => !only.includes(k)) ?? [];
evidence.targetChecks = only ?? 'all';
evidence.history = previous
  ? [
      ...(previous.history || []),
      {
        recordedAt: previous.recordedAt,
        categories: previous.categories,
        releaseDecision: previous.releaseDecision,
        P0Passed: previous.P0Passed,
      },
    ]
  : [];
evidence.categories = {};
evidence.timings = [];
evidence.timingsSummary = {};
function timingStart(label, waitReason = null) {
  return { label, start: Date.now(), waitReason };
}
function timingEnd(t, extra = {}) {
  const end = Date.now();
  evidence.timings.push({
    label: t.label,
    startAt: new Date(t.start).toISOString(),
    endAt: new Date(end).toISOString(),
    ms: end - t.start,
    waitReason: t.waitReason,
    ...extra,
  });
}
evidence.environment = {
  docker: cmd(
    'docker',
    ['version', '--format', '{{json .Server}}'],
    true,
  ).stdout.trim(),
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: (await import('node:os')).cpus().length,
    totalMemoryBytes: (await import('node:os')).totalmem(),
  },
};
function record(category, status, raw, reason = null, samples = null) {
  evidence.categories[category] = { status, raw, reason, samples };
  console.log(`[${category}] ${status} ${reason || ''}`);
}
evidence.prerequisites = [];
evidence.targetChecks = only ?? 'all';
const owned = ['.env', 'secrets', 'certs', 'ca'].map(
  (name) => `${deploy}/${name}`,
);
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
if (
  owned.some(existsSync) ||
  containers.some(
    (name) => cmd('docker', ['container', 'inspect', name], true).status === 0,
  ) ||
  volumes.some(
    (name) => cmd('docker', ['volume', 'inspect', name], true).status === 0,
  ) ||
  networks.some(
    (name) => cmd('docker', ['network', 'inspect', name], true).status === 0,
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
function note(name, detail) {
  evidence.checks.push({ name, ...detail, kind: 'prerequisite' });
  console.log(name, JSON.stringify(detail));
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
      `${method} ${path}: expected ${status}, got ${res.status} ${JSON.stringify(res.json).slice(0, 180)}`,
    );
  return res;
}
async function sseHeartbeat(runId, cookie, lastSeq) {
  return new Promise((done, fail) => {
    const started = Date.now();
    let text = '';
    let settled = false;
    const req = https.request(
      {
        host: '127.0.0.1',
        port: 18443,
        servername: 'localqa.internal',
        path: `/api/v1/runs/${runId}/events`,
        method: 'GET',
        ca: readFileSync(`${deploy}/certs/tls.crt`),
        headers: {
          Host: 'localqa.internal',
          Cookie: cookie,
          'Last-Event-ID': String(lastSeq),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`SSE status ${res.statusCode}`));
          return;
        }
        res.on('data', (data) => {
          text += data.toString();
          if (text.includes(': ping\n\n') && !settled) {
            settled = true;
            const ms = Date.now() - started;
            req.destroy();
            done({
              ms,
              frame: text.slice(-120),
              status: res.statusCode,
              contentType: res.headers['content-type'],
            });
          }
        });
        res.on('error', (error) => {
          if (!settled) fail(error);
        });
      },
    );
    req.on('error', (error) => {
      if (!settled) fail(error);
    });
    req.setTimeout(22000, () =>
      req.destroy(new Error('SSE heartbeat timed out')),
    );
    req.end();
  });
}
let cleanupError = null;
try {
  for (const path of owned.slice(1)) mkdirSync(path, { mode: 0o700 });
  chmodSync(`${deploy}/secrets`, 0o711);
  const password = randomBytes(24).toString('hex');
  const adminPassword = `T09-${randomBytes(18).toString('hex')}!`;
  const kek = randomBytes(32).toString('base64');
  const identity = randomBytes(32).toString('hex');
  const files = {
    postgres_password: password,
    admin_initial_password: adminPassword,
    'kek.json': JSON.stringify({ activeVersion: 1, keys: { 1: kek } }),
    'worker_identity.json': identity,
  };
  for (const [name, data] of Object.entries(files))
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
    `DATABASE_URL=postgresql://localqa:${password}@postgres:5432/localqa\nPUBLIC_ORIGIN=https://127.0.0.1:18443\nDATA_DIR=/var/localqa/data\nMASTER_KEY_FILE=/run/secrets/kek.json\nWORKER_IDENTITY_FILE=/run/secrets/worker_identity.json\nLOCALQA_ALLOW_TEST_STUB=1\nBROWSER_SLOTS=4\nJOB_HEARTBEAT_SECONDS=10\nJOB_LEASE_SECONDS=45\nJOB_POLL_INTERVAL_MS=500\nWORKER_FIXTURE_URL=http://localqa-t09b-fixture:8080/\nLOCALQA_API_IMAGE=localqa-api:latest\nLOCALQA_WORKER_IMAGE=localqa-worker:latest\nLOCALQA_ORCHESTRATOR_IMAGE=localqa-orchestrator:latest\nLOCALQA_WEB_IMAGE=localqa-web:latest\nGATEWAY_HTTP_PORT=18080\nGATEWAY_HTTPS_PORT=18443\n`,
    { mode: 0o600 },
  );
  compose(['config', '--quiet']);
  const tPgUp = timingStart(
    'compose up postgres',
    'compose start + pg healthcheck',
  );
  compose(['up', '-d', '--wait', 'postgres']);
  timingEnd(tPgUp);
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
  const tMigrate = timingStart('db migrate');
  compose([
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'node',
    'api',
    '/app/deploy/scripts/migrate.mjs',
  ]);
  timingEnd(tMigrate);
  const tBootstrap = timingStart('bootstrap admin');
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
  timingEnd(tBootstrap);
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
  const tStackUp = timingStart(
    'compose up six services',
    'compose start + healthchecks (5 services)',
  );
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
  timingEnd(tStackUp);
  // Verify the served page is the current build: the HTML entry references
  // the same asset hash as the local build output. This catches the historical
  // "old bundle served from /app/dist" failure mode.
  const servedIndex = cmd(
    'docker',
    ['exec', 'localqa-web', 'cat', '/app/apps/web/dist/index.html'],
    true,
  ).stdout;
  const servedAsset = (servedIndex.match(/assets\/(index-[^"]+\.js)/) || [])[1];
  const localIndex = readFileSync(`${root}/apps/web/dist/index.html`, 'utf8');
  const localAsset = (localIndex.match(/assets\/(index-[^"]+\.js)/) || [])[1];
  const bundleMatch = servedAsset && servedAsset === localAsset;
  evidence.checks.push({
    name: 'web_bundle_served_matches_build',
    servedAsset,
    localAsset,
    match: bundleMatch,
    kind: 'prerequisite',
  });
  if (!bundleMatch)
    throw new Error(
      `served web bundle (${servedAsset}) does not match local build (${localAsset})`,
    );
  note('six_services_ready', {
    statuses: containers.slice(0, 6).map((name) => ({
      name,
      health: cmd('docker', [
        'inspect',
        '-f',
        '{{.State.Health.Status}}',
        name,
      ]).stdout.trim(),
    })),
  });
  const sandbox = JSON.parse(
    cmd('docker', [
      'exec',
      'localqa-worker',
      'node',
      '-e',
      "process.stdout.write(require('fs').readFileSync('/var/localqa/scratch/sandbox-result.json','utf8'))",
    ]).stdout,
  );
  if (
    sandbox.uid !== 1001 ||
    !sandbox.processes.length ||
    sandbox.processes.some(
      (p) => p.uid !== 1001 || p.seccomp !== 2 || p.noSandbox,
    )
  )
    throw new Error('Worker sandbox evidence invalid');
  note('worker_sandbox', {
    uid: sandbox.uid,
    node: sandbox.node,
    playwright: sandbox.playwright,
    chromium: sandbox.browserVersion,
    seccompModes: [...new Set(sandbox.processes.map((p) => p.seccomp))],
    noSandbox: false,
  });
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
      { name: 'T09B isolated fixture' },
      cookie,
      201,
    )
  ).json;
  const model = (
    await requireStatus(
      'POST',
      '/api/v1/model-profiles',
      {
        name: 'T09B fixed stub',
        endpoint: 'https://stub.example.test/v1',
        configuredModelId: 'stub-normal',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
      },
      cookie,
      201,
    )
  ).json;
  const patched = (
    await requireStatus(
      'PATCH',
      `/api/v1/projects/${project.id}`,
      { expectedVersion: project.version, defaultModelProfileId: model.id },
      cookie,
      200,
    )
  ).json;
  if (patched.defaultModelProfileId !== model.id)
    throw new Error('Model default was not persisted');
  const run = (
    await requireStatus(
      'POST',
      '/api/v1/runs',
      { projectId: project.id, targetUrl: 'http://localqa-t09b-fixture:8080/' },
      cookie,
      202,
    )
  ).json;
  note('model_default_to_run', {
    projectId: project.id,
    modelId: model.id,
    runId: run.id,
    status: run.status,
  });
  let final;
  for (let i = 0; i < 60; i++) {
    final = (
      await requireStatus('GET', `/api/v1/runs/${run.id}`, null, cookie, 200)
    ).json;
    if (['completed', 'failed', 'cancelled'].includes(final.status)) break;
    await delay(1000);
  }
  const query = cmd('docker', [
    'exec',
    'localqa-postgres',
    'psql',
    '-U',
    'localqa',
    '-d',
    'localqa',
    '-Atc',
    `SELECT (SELECT count(*) FROM jobs WHERE run_id='${run.id}' AND status='succeeded'),(SELECT count(*) FROM steps WHERE run_id='${run.id}' AND document->>'toolName'='navigate' AND document->>'status'='succeeded'),(SELECT count(*) FROM artifacts WHERE run_id='${run.id}')`,
  ]).stdout.trim();
  const [jobs, navigate, artifacts] = query.split('|').map(Number);
  note('leased_worker_browser_result', {
    status: final.status,
    completion: final.completion,
    jobs,
    navigate,
    artifacts,
  });
  if (final.status !== 'completed' || jobs < 4 || navigate < 1 || artifacts < 1)
    throw new Error('Leased worker did not complete the real browser run');
  const facts = cmd('docker', [
    'exec',
    'localqa-postgres',
    'psql',
    '-U',
    'localqa',
    '-d',
    'localqa',
    '-Atc',
    `SELECT 'lease|'||count(*)||'|'||coalesce(max(fencing_token),0) FROM jobs WHERE run_id='${run.id}' AND worker_id IS NOT NULL UNION ALL SELECT 'verdict|'||count(*)||'|'||coalesce(max(document->>'status'),'none') FROM verdicts WHERE project_id='${project.id}' UNION ALL SELECT 'events|'||count(*)||'|'||coalesce(min(seq),0)||'..'||coalesce(max(seq),0) FROM run_events WHERE run_id='${run.id}' UNION ALL SELECT 'evidence|'||count(*)||'|'||coalesce(max(document->>'sha256'),'none') FROM artifacts WHERE run_id='${run.id}'`,
  ]).stdout.trim();
  const report = await http(
    'GET',
    `/api/v1/runs/${run.id}/report`,
    null,
    cookie,
  );
  const exportCreated = await http(
    'POST',
    `/api/v1/runs/${run.id}/exports`,
    { format: 'zip' },
    cookie,
  );
  const exportGet = exportCreated.json?.id
    ? await http(
        'GET',
        `/api/v1/exports/${exportCreated.json.id}`,
        null,
        cookie,
      )
    : null;
  const exportDownload = exportGet?.json?.artifactId
    ? await new Promise((done, fail) => {
        const request = https.get(
          {
            host: '127.0.0.1',
            port: 18443,
            servername: 'localqa.internal',
            ca: readFileSync(`${deploy}/certs/tls.crt`),
            path: `/api/v1/artifacts/${exportGet.json.artifactId}/content`,
            headers: { Host: '127.0.0.1:18443', Cookie: cookie },
          },
          (response) => {
            const parts = [];
            response.on('data', (part) => parts.push(part));
            response.on('end', () =>
              done({
                status: response.statusCode,
                headers: response.headers,
                bytes: Buffer.concat(parts),
              }),
            );
          },
        );
        request.on('error', fail);
      })
    : null;
  let zipVerification = null;
  if (exportDownload?.status === 200) {
    const dir = mkdtempSync(`${tmpdir()}/localqa-export-`);
    const zipPath = `${dir}/export.zip`;
    try {
      writeFileSync(zipPath, exportDownload.bytes);
      const listing = cmd('unzip', ['-Z1', zipPath], true);
      const integrity = cmd('unzip', ['-t', zipPath], true);
      const manifestOutput = cmd(
        'unzip',
        ['-p', zipPath, 'manifest.json'],
        true,
      );
      const manifest =
        manifestOutput.status === 0 ? JSON.parse(manifestOutput.stdout) : null;
      const entries = listing.stdout.trim().split('\n');
      const hashes = (manifest?.artifacts || []).map((entry) => {
        if (entry.status !== 'available' || !entry.relativePath)
          return { id: entry.id, status: entry.status, included: false };
        const extracted = spawnSync(
          'unzip',
          ['-p', zipPath, entry.relativePath],
          { maxBuffer: 25 * 1024 * 1024 },
        );
        return {
          id: entry.id,
          status: entry.status,
          included: entries.includes(entry.relativePath),
          sha256:
            extracted.status === 0
              ? createHash('sha256').update(extracted.stdout).digest('hex')
              : null,
          expectedSha256: entry.sha256,
        };
      });
      zipVerification = {
        zipSha256: createHash('sha256')
          .update(exportDownload.bytes)
          .digest('hex'),
        zipBytes: exportDownload.bytes.length,
        unzipStatus: integrity.status,
        entries,
        manifest,
        hashes,
        valid:
          integrity.status === 0 &&
          ['report.json', 'report.md', 'manifest.json'].every((name) =>
            entries.includes(name),
          ) &&
          hashes.every(
            (entry) =>
              entry.status !== 'available' ||
              (entry.included && entry.sha256 === entry.expectedSha256),
          ),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const cases = await http('GET', `/api/v1/runs/${run.id}/cases`, null, cookie);
  const screenshot = report.json?.artifacts?.find(
    (a) => a.kind === 'screenshot',
  );
  const content = screenshot
    ? await http(
        'GET',
        `/api/v1/artifacts/${screenshot.id}/content`,
        null,
        cookie,
      )
    : null;
  const rawClosure = {
    runId: run.id,
    db: facts,
    reportStatus: report.status,
    reportSummary: report.json?.summary,
    cleanupStatus: report.json?.cleanupStatus,
    caseStatuses: cases.json?.items?.map((c) => c.outcome),
    screenshot: screenshot && {
      id: screenshot.id,
      sha256: screenshot.sha256,
      bytes: screenshot.bytes,
      contentHttp: content?.status,
      contentType: content?.headers?.['content-type'],
    },
    exportCreate: { status: exportCreated.status, body: exportCreated.json },
    exportGet: exportGet && { status: exportGet.status, body: exportGet.json },
    exportDownload: exportDownload && {
      status: exportDownload.status,
      contentType: exportDownload.headers?.['content-type'],
    },
    zipVerification,
  };
  const closureOk =
    final.status === 'completed' &&
    facts.includes('verdict|1|passed') &&
    facts.includes('events|') &&
    screenshot?.status === 'available' &&
    report.status === 200 &&
    report.json?.summary?.passed === 1 &&
    exportCreated.status === 202 &&
    exportGet?.json?.artifactId &&
    exportDownload?.status === 200 &&
    zipVerification?.valid;
  if (shouldRun('2_end_to_end'))
    record(
      '2_end_to_end',
      closureOk ? '通过' : '失败',
      rawClosure,
      closureOk
        ? null
        : '运行和 verdict/证据已落库，但导出必须有真实可下载的 ZIP；不能将 status=ready + artifactId=null 视为完成。',
      1,
    );
  const twoSlotsActive = shouldRun('3_four_slots_fairness');
  let reservationIds = [];
  let uuid = () => '';
  // Deterministic admission test: four reserved browser slots, then another
  // request must fail with 429; artificial reservations are released afterwards.
  if (twoSlotsActive) {
    reservationIds = Array.from({ length: 4 }, () =>
      randomBytes(16).toString('hex'),
    );
    uuid = (hex) =>
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const occupancy = reservationIds
      .map(
        (hex) =>
          `INSERT INTO budget_reservations(id,project_id,run_id,request_id,kind,reserved,status) VALUES('${uuid(hex)}','${project.id}','${run.id}','${uuid(randomBytes(16).toString('hex'))}','concurrency','{}','reserved');`,
      )
      .join(' ');
    cmd('docker', [
      'exec',
      'localqa-postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'localqa',
      '-d',
      'localqa',
      '-c',
      occupancy,
    ]);
  }
  const denied = twoSlotsActive
    ? await http(
        'POST',
        '/api/v1/runs',
        {
          projectId: project.id,
          targetUrl: 'http://localqa-t09b-fixture:8080/',
        },
        cookie,
      )
    : { status: 'skipped', json: {}, headers: {} };
  if (twoSlotsActive)
    note('two_slots_admission', {
      configured: 2,
      thirdStatus: denied.status,
      code: denied.json.code,
      retryAfter: denied.headers['retry-after'],
      occupancy: 'test-reservations',
    });
  if (twoSlotsActive)
    cmd('docker', [
      'exec',
      'localqa-postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'localqa',
      '-d',
      'localqa',
      '-c',
      `UPDATE budget_reservations SET status='released' WHERE id IN ('${reservationIds.map(uuid).join("','")}')`,
    ]);
  if (
    twoSlotsActive &&
    (denied.status !== 429 ||
      denied.json.code !== 'RATE_LIMITED' ||
      denied.headers['retry-after'] !== '1')
  )
    throw new Error('Two-slot admission did not return 429');
  const seq = Number(
    cmd('docker', [
      'exec',
      'localqa-postgres',
      'psql',
      '-U',
      'localqa',
      '-d',
      'localqa',
      '-Atc',
      `SELECT max(seq) FROM run_events WHERE run_id='${run.id}'`,
    ]).stdout.trim(),
  );
  const heartbeat = await sseHeartbeat(run.id, cookie, seq);
  const heartbeatMs = heartbeat.ms;
  note('nginx_sse_heartbeat', {
    lastEventId: seq,
    heartbeatMs,
    observedWithin22s: heartbeatMs < 22000,
    waitReason: 'SSE 心跳语义（真实 15s），非性能开销',
  });
  if (heartbeatMs > 22000) throw new Error('SSE buffered or delayed');
  record(
    '1_proxy_sse_unbuffered',
    '通过',
    {
      lastEventId: seq,
      ...heartbeat,
      waitReason: 'SSE 心跳语义（真实 15s），非性能开销',
    },
    null,
    1,
  );
  await runAcceptanceExtras({
    cmd,
    http,
    record,
    deploy,
    root,
    cookie,
    adminPassword,
    project,
    model,
    run,
    final,
    sandbox,
    statuses: evidence.checks[0].statuses,
    timings: evidence.timings,
    only: effectiveOnly,
    previousCategories: previous?.categories || {},
    previousRecordedAt: previous?.recordedAt ?? null,
    fixtureUrl:
      'http://localqa-t09b-fixture:8080/fix-02-delayed.html?delay=5000',
  });
  // Summarize wall-clock timings: separate semantic waits from other overhead.
  // (final compose-down timing is appended in the finally block below.)
  const semanticWaits = evidence.timings.filter((t) => t.waitReason);
  const semanticMs = semanticWaits.reduce((s, t) => s + t.ms, 0);
  const totalMs = evidence.timings.reduce((s, t) => s + t.ms, 0);
  evidence.timingsSummary = {
    totalMs,
    semanticWaitMs: semanticMs,
    otherOverheadMs: totalMs - semanticMs,
    semanticWaits: semanticWaits.map((t) => ({
      label: t.label,
      ms: t.ms,
      waitReason: t.waitReason,
    })),
  };
  evidence.result = true;
} catch (error) {
  evidence.result = false;
  evidence.failure = error.message;
  console.error('Stack preflight failed:', error.message);
} finally {
  const tDown = timingStart('compose down + cleanup');
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
  for (const path of owned) rmSync(path, { recursive: true, force: true });
  timingEnd(tDown);
  evidence.cleanup = {
    containers: containers.filter(
      (name) =>
        cmd('docker', ['container', 'inspect', name], true).status === 0,
    ),
    volumes: volumes.filter(
      (name) => cmd('docker', ['volume', 'inspect', name], true).status === 0,
    ),
    networks: networks.filter(
      (name) => cmd('docker', ['network', 'inspect', name], true).status === 0,
    ),
    credentialsPresent: owned.some(existsSync),
    downError: cleanupError,
  };
  for (const key of [
    '1_six_services_business',
    '1_proxy_sse_unbuffered',
    '2_end_to_end',
    '3_ten_users_rbac',
    '3_four_slots_fairness',
    '4_db_restart',
    '4_worker_midtask_kill',
    '4_disk_full',
    '4_sse_reconnect',
    '4_credential_revocation',
    '5_api_p95',
    '5_event_to_ui_p95',
    '6_ui_refresh',
    '6_ui_sse_partial_blocked',
  ])
    if (!evidence.categories[key])
      record(
        key,
        '未验证',
        { sampleCount: 0 },
        '前置步骤失败或验证程序未能到达本项',
        0,
      );
  // Recompute summary after compose-down timing has been appended.
  const semanticWaits2 = evidence.timings.filter((t) => t.waitReason);
  const semanticMs2 = semanticWaits2.reduce((s, t) => s + t.ms, 0);
  const totalMs2 = evidence.timings.reduce((s, t) => s + t.ms, 0);
  evidence.timingsSummary = {
    totalMs: totalMs2,
    semanticWaitMs: semanticMs2,
    otherOverheadMs: totalMs2 - semanticMs2,
    semanticWaits: semanticWaits2.map((t) => ({
      label: t.label,
      ms: t.ms,
      waitReason: t.waitReason,
    })),
  };
  evidence.unverified = Object.entries(evidence.categories)
    .filter(([, item]) => item.status === '未验证')
    .map(([key, item]) => ({ item: key, reason: item.reason }));
  evidence.P0Passed = false;
  evidence.releaseDecision =
    '不放行：真实模型 G3 和必需的 G4 项未全部通过；任何失败/未验证均不可视为通过。';
  evidence.remainingGaps = Object.entries(evidence.categories)
    .filter(([, item]) => item.status !== '通过')
    .map(([key, item]) => ({
      item: key,
      status: item.status,
      reason: item.reason,
    }));
  evidence.harnessCompleted = evidence.result === true;
  evidence.result =
    evidence.remainingGaps.length || !evidence.harnessCompleted
      ? 'failed'
      : 'passed';
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
}
if (
  evidence.result !== 'passed' ||
  evidence.cleanup.containers.length ||
  evidence.cleanup.volumes.length ||
  evidence.cleanup.networks.length ||
  evidence.cleanup.credentialsPresent ||
  cleanupError ||
  evidence.remainingGaps.length
)
  process.exitCode = 1;
