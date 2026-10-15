#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const tag = randomBytes(4).toString('hex');
const net = `localqa-t09b1-${tag}`;
const db = `${net}-pg`,
  api = `${net}-api`,
  worker = `${net}-worker`,
  fixture = `${net}-fixture`;
const volumes = [`${net}-db`, `${net}-data`, `${net}-secrets`];
const web = `${net}-web`,
  orchestrator = `${net}-orchestrator`;
const containers = [db, api, worker, fixture, web, orchestrator];
const password = randomBytes(24).toString('hex');
const kek = randomBytes(32).toString('base64');
const identity = randomBytes(32).toString('hex');
// Versioned key ring for the internal service-identity gate. The worker and
// orchestrator entries must exist for their HTTP clients to sign requests.
const serviceIdentity = JSON.stringify({
  services: {
    worker: {
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    },
    orchestrator: {
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    },
  },
});
const adminPassword = randomBytes(24).toString('hex');
const redacted = (text) =>
  String(text ?? '')
    .replaceAll(password, '[DB_SECRET]')
    .replaceAll(kek, '[KEK]')
    .replaceAll(identity, '[IDENTITY]')
    .replaceAll(serviceIdentity, '[SERVICE_IDENTITY]')
    .replaceAll(adminPassword, '[ADMIN_SECRET]');
const commands = [],
  facts = {},
  cleanup = { containers: [], volumes: [], network: false };
let error = null;
function run(args, optional = false, timeout = 120000) {
  const r = spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  commands.push({
    command: redacted(['docker', ...args].join(' ')),
    code: r.status,
    stdout: redacted(r.stdout),
    stderr: redacted(r.stderr),
  });
  if (!optional && r.status !== 0)
    throw new Error(
      `docker ${args.slice(0, 3).join(' ')} failed: ${redacted(r.stderr).slice(0, 500)}`,
    );
  return r;
}
function waitHealthy(name) {
  for (let n = 0; n < 60; n++) {
    const r = run(['inspect', '--format', '{{json .State}}', name], true);
    if (r.status === 0) {
      // A container may be inspected while its log buffers are being written;
      // an unparseable snapshot is a retry, not a harness crash.
      let state;
      try {
        state = JSON.parse(r.stdout);
      } catch {
        state = null;
      }
      if (state?.Health?.Status === 'healthy') return state;
      if (state?.Status === 'exited' || state?.Health?.Status === 'unhealthy')
        throw new Error(
          `${name} exited/unhealthy: ${redacted(run(['logs', name], true).stdout).slice(-1200)}`,
        );
    }
    spawnSync('node', ['-e', 'setTimeout(()=>{},1000)']);
  }
  throw new Error(`${name} health deadline`);
}
try {
  const nginx = readFileSync(`${root}deploy/config/nginx.conf`, 'utf8');
  if (
    !nginx.includes('proxy_pass http://web:8080;') ||
    !nginx.includes('proxy_pass http://api:3000;') ||
    !nginx.includes('proxy_buffering off;') ||
    !nginx.includes('ssl_certificate /etc/nginx/certs/tls.crt;')
  )
    throw new Error('Gateway route/TLS/SSE config mismatch');
  facts.gatewayConfig = {
    web: 'web:8080',
    api: 'api:3000',
    sseBuffering: false,
    tlsCertMount: '/etc/nginx/certs',
    validated: 'static only',
  };
  run(['network', 'create', net]);
  for (const v of volumes) run(['volume', 'create', v]);
  run([
    'run',
    '-d',
    '--name',
    db,
    '--network',
    net,
    '-e',
    'POSTGRES_USER=localqa',
    '-e',
    'POSTGRES_DB=localqa',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-v',
    `${volumes[0]}:/var/lib/postgresql`,
    '--health-cmd=pg_isready -h 127.0.0.1 -U localqa -d localqa',
    '--health-interval=2s',
    'postgres:18-alpine',
  ]);
  waitHealthy(db);
  const dburl = `postgresql://localqa:${password}@${db}:5432/localqa`;
  const migrate = run([
    'run',
    '--rm',
    '--network',
    net,
    '-e',
    `DATABASE_URL=${dburl}`,
    '--entrypoint',
    'node',
    'localqa-api:t09b1-current',
    '/app/deploy/scripts/migrate.mjs',
  ]);
  facts.migrations = migrate.stdout.trim();
  const bootstrap = run([
    'run',
    '--rm',
    '--network',
    net,
    '-e',
    `DATABASE_URL=${dburl}`,
    '-e',
    `ADMIN_INITIAL_PASSWORD=${adminPassword}`,
    '--entrypoint',
    'node',
    'localqa-api:t09b1-current',
    '/app/deploy/scripts/bootstrap-admin.mjs',
  ]);
  facts.bootstrap = bootstrap.status === 0;
  // Make protected files inside Docker's private volume, owned by the actual runtime UID.
  run([
    'run',
    '--rm',
    '-v',
    `${volumes[2]}:/secrets`,
    '-e',
    `LOCALQA_KEK=${kek}`,
    '-e',
    `LOCALQA_IDENTITY=${identity}`,
    `LOCALQA_SERVICE_IDENTITY=${serviceIdentity}`,
    '--entrypoint',
    'node',
    'node:24-bookworm-slim',
    '-e',
    "const f=require('fs');for(const [name,data] of [['kek.json',JSON.stringify({activeVersion:1,keys:{1:process.env.LOCALQA_KEK}})],['worker_identity.json',process.env.LOCALQA_IDENTITY],['service_identity.json',process.env.LOCALQA_SERVICE_IDENTITY]]) {const p='/secrets/'+name;f.writeFileSync(p,data,{mode:0o400});f.chownSync(p,1001,1001);f.chmodSync(p,0o400)}",
  ]);
  run([
    'run',
    '-d',
    '--name',
    fixture,
    '--network',
    net,
    '--entrypoint',
    'node',
    'localqa-worker:t09b1-current',
    '/app/packages/test-fixture/server.js',
  ]);
  const common = [
    '--network',
    net,
    '--user',
    '1001:1001',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=128m',
    '-v',
    `${volumes[1]}:/var/localqa/data`,
    '-v',
    `${volumes[2]}:/run/secrets:ro`,
    '-e',
    `DATABASE_URL=${dburl}`,
    '-e',
    'DATA_DIR=/var/localqa/data',
  ];
  run([
    'run',
    '-d',
    '--name',
    api,
    ...common,
    '-e',
    'MASTER_KEY_FILE=/run/secrets/kek.json',
    '-e',
    'WORKER_IDENTITY_FILE=/run/secrets/worker_identity.json',
    '-e',
    'SERVICE_IDENTITY_FILE=/run/secrets/service_identity.json',
    '-e',
    'PUBLIC_ORIGIN=https://localqa.invalid',
    '--health-cmd=node /app/deploy/images/check.mjs api ready',
    '--health-interval=2s',
    '--health-retries=5',
    'localqa-api:t09b1-current',
  ]);
  waitHealthy(api);
  const apiProbe = run([
    'exec',
    api,
    'node',
    '/app/deploy/images/check.mjs',
    'api',
    'ready',
  ]);
  facts.api = {
    ready: apiProbe.status === 0,
    uid: run(['exec', api, 'id', '-u']).stdout.trim(),
  };
  run([
    'run',
    '-d',
    '--name',
    orchestrator,
    ...common,
    '-e',
    'MASTER_KEY_FILE=/run/secrets/kek.json',
    '--health-cmd=node /app/deploy/images/check.mjs orchestrator ready',
    '--health-interval=2s',
    'localqa-orchestrator:t09b1-current',
  ]);
  waitHealthy(orchestrator);
  facts.orchestrator = {
    ready: true,
    uid: run(['exec', orchestrator, 'id', '-u']).stdout.trim(),
  };
  run([
    'run',
    '-d',
    '--name',
    web,
    '--network',
    net,
    '--user',
    '1001:1001',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=64m',
    '--health-cmd=node /app/web-entry.mjs --check',
    '--health-interval=2s',
    'localqa-web:t09b1-current',
  ]);
  waitHealthy(web);
  const webCheck = run([
    'exec',
    web,
    'node',
    '-e',
    "fetch('http://127.0.0.1:8080/').then(async r=>{if(!r.ok||!(await r.text()).includes('<div id=\"root\">'))process.exit(1);console.log(r.status)})",
  ]);
  facts.web = {
    ready: true,
    uid: run(['exec', web, 'id', '-u']).stdout.trim(),
    indexStatus: Number(webCheck.stdout.trim()),
  };
  run([
    'run',
    '-d',
    '--name',
    worker,
    ...common,
    '--cap-add',
    'SYS_ADMIN',
    '--shm-size',
    '256m',
    '--tmpfs',
    '/var/localqa/scratch:rw,nosuid,size=256m,mode=1777',
    '-e',
    `WORKER_FIXTURE_URL=http://${fixture}:8080/`,
    '--health-cmd=node /app/deploy/images/check.mjs worker ready',
    '--health-interval=2s',
    '--health-retries=8',
    'localqa-worker:t09b1-current',
  ]);
  waitHealthy(worker);
  const marker = JSON.parse(
    run([
      'exec',
      worker,
      'node',
      '-e',
      "process.stdout.write(require('fs').readFileSync('/var/localqa/scratch/sandbox-result.json','utf8'))",
    ]).stdout,
  );
  if (
    marker.uid === 0 ||
    !marker.processes.length ||
    marker.processes.some(
      (p) => p.uid === 0 || p.seccomp !== 2 || p.noSandbox,
    ) ||
    !marker.url.includes('fixture') ||
    marker.action !== 'details-tab.click'
  )
    throw new Error('Browser evidence failed');
  facts.worker = {
    ready: true,
    marker,
    uid: run(['exec', worker, 'id', '-u']).stdout.trim(),
  };
  for (const image of [
    'localqa-api:t09b1-current',
    'localqa-worker:t09b1-current',
    'localqa-orchestrator:t09b1-current',
    'localqa-web:t09b1-current',
  ]) {
    const info = JSON.parse(run(['image', 'inspect', image]).stdout)[0];
    facts[image] = {
      id: info.Id,
      sizeBytes: info.Size,
      arch: info.Architecture,
      created: info.Created,
      digests: info.RepoDigests,
      node: run([
        'run',
        '--rm',
        '--entrypoint',
        'node',
        image,
        '-v',
      ]).stdout.trim(),
    };
  }
  facts.playwright = run([
    'exec',
    worker,
    'node',
    '-e',
    "console.log(require('/app/packages/browser/node_modules/playwright/package.json').version)",
  ]).stdout.trim();
  facts.postgres = run(['exec', db, 'postgres', '--version']).stdout.trim();
  if (
    facts.playwright !== '1.63.0' ||
    !marker.node.startsWith('v24.') ||
    marker.browserVersion !== '153.0.8010.12' ||
    facts.api.uid !== '1001'
  )
    throw new Error('Design baseline version/UID mismatch');
  facts.designBaseline = {
    node: '24 LTS',
    playwright: '1.63.0',
    browser: '153.0.8010.12 (T00)',
    browserImage: 'mcr.microsoft.com/playwright:v1.63.0-noble',
    matches: true,
  };
  facts.baseImages = {};
  for (const image of [
    'node:24-bookworm-slim',
    'mcr.microsoft.com/playwright:v1.63.0-noble',
  ]) {
    const info = JSON.parse(run(['image', 'inspect', image]).stdout)[0];
    facts.baseImages[image] = {
      id: info.Id,
      digests: info.RepoDigests,
      arch: info.Architecture,
    };
  }
  facts.imageCredentialScan = {};
  for (const image of [
    'localqa-api:t09b1-current',
    'localqa-worker:t09b1-current',
    'localqa-orchestrator:t09b1-current',
    'localqa-web:t09b1-current',
  ]) {
    const scan = run([
      'run',
      '--rm',
      '--entrypoint',
      'node',
      image,
      '-e',
      "const f=require('fs');console.log(['/app/.env','/app/deploy/.env','/app/deploy/secrets','/app/deploy/certs','/app/deploy/.evidence'].filter(p=>f.existsSync(p)).join(','))",
    ]);
    facts.imageCredentialScan[image] = scan.stdout.trim() === '';
    if (!facts.imageCredentialScan[image])
      throw new Error(`Credentials bundled in ${image}`);
  }
} catch (e) {
  error = String(e);
} finally {
  for (const name of containers) {
    run(['rm', '-f', '-v', name], true);
    cleanup.containers.push({
      name,
      absent: run(['inspect', name], true).status !== 0,
    });
  }
  for (const name of volumes) {
    run(['volume', 'rm', name], true);
    cleanup.volumes.push({
      name,
      absent: run(['volume', 'inspect', name], true).status !== 0,
    });
  }
  run(['network', 'rm', net], true);
  cleanup.network = run(['network', 'inspect', net], true).status !== 0;
  if (
    cleanup.containers.some((x) => !x.absent) ||
    cleanup.volumes.some((x) => !x.absent) ||
    !cleanup.network
  )
    error ||= 'Cleanup incomplete';
  const timings = '/tmp/localqa-t09b1-build-times.tsv';
  if (existsSync(timings))
    facts.buildTiming = {
      kind: 'cached build, actual elapsed wall time; first uncached builds not timed',
      items: readFileSync(timings, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const [service, startEpoch, endEpoch, seconds] = line.split('\t');
          return {
            service,
            startEpoch: Number(startEpoch),
            endEpoch: Number(endEpoch),
            seconds: Number(seconds),
          };
        }),
    };
  facts.buildOutput = {};
  for (const service of ['api', 'worker', 'orchestrator', 'web']) {
    const log = `/tmp/localqa-t09b1-${service}-build.log`;
    if (existsSync(log))
      facts.buildOutput[service] = {
        command: `docker build --network host --build-arg NPM_REGISTRY=https://registry.npmmirror.com -f deploy/images/${service}.Dockerfile -t localqa-${service}:t09b1-current .`,
        tail: readFileSync(log, 'utf8').split('\n').slice(-22).join('\n'),
      };
  }
  const record = {
    task: 'T09-B1',
    timestamp: new Date().toISOString(),
    passed: !error,
    P0Passed: false,
    error,
    facts,
    cleanup,
    commands,
    unverified: [
      'Worker task-claim transport and real provider are not wired by this capacity entrypoint',
      'Full six-service stack/TLS gateway and production CA not exercised',
      'Cross-architecture x86_64, host userns alternative and readonly-root under production traffic unverified',
    ],
  };
  writeFileSync(
    `${root}docs/validation-results/T09-images.json`,
    JSON.stringify(record, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      passed: record.passed,
      error,
      record: 'docs/validation-results/T09-images.json',
    }),
  );
  if (error) process.exitCode = 1;
}
