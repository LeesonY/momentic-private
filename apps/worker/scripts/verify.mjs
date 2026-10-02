import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = `${root}apps/worker/.evidence`;
mkdirSync(dir, { recursive: true });
for (const path of ['tmp', 'home', 'cache'])
  mkdirSync(`${dir}/${path}`, { recursive: true, mode: 0o700 });
mkdirSync(`${root}packages/orchestrator/.artifacts`, {
  recursive: true,
  mode: 0o700,
});
const tag = randomUUID().slice(0, 8),
  network = `localqa-t05-${tag}`,
  postgres = `localqa-t05-pg-${tag}`,
  browser = `localqa-t05-browser-${tag}`;
const envFile = `${dir}/postgres.env`,
  kekFile = `${dir}/kek.json`;
const password = randomBytes(24).toString('hex');
writeFileSync(
  envFile,
  `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\nPGHOST=${postgres}\n`,
  { mode: 0o600 },
);
writeFileSync(
  kekFile,
  JSON.stringify({
    activeVersion: 1,
    keys: { 1: randomBytes(32).toString('base64') },
  }),
  { mode: 0o600 },
);
rmSync(`${dir}/facts.json`, { force: true });
const commands = [],
  volumes = [],
  containers = [];
let result = false,
  failure = null;
function run(command, args, allowFailure = false, timeout = 240000) {
  const r = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  const entry = {
    command: [command, ...args].join(' '),
    exitCode: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
  commands.push(entry);
  console.log(JSON.stringify(entry));
  if (!allowFailure && r.status !== 0)
    throw new Error(`Command failed: ${command} ${args.slice(0, 3).join(' ')}`);
  return r;
}
const readonly = JSON.parse(
  readFileSync(`${dir}/readonly-baseline.json`, 'utf8'),
);
let readOnlyChecks,
  functionalPassed = false;
function compiledDependencies() {
  const output = {};
  const walk = (path) => {
    if (!existsSync(`${root}${path}`)) return;
    for (const e of readdirSync(`${root}${path}`, { withFileTypes: true })) {
      const child = `${path}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else
        output[child] = createHash('sha256')
          .update(readFileSync(`${root}${child}`))
          .digest('hex');
    }
  };
  for (const pkg of [
    'contracts',
    'storage',
    'browser',
    'model-gateway',
    'agents',
  ])
    walk(`packages/${pkg}/dist`);
  return output;
}
const compiledBefore = compiledDependencies();
try {
  for (const pkg of ['domain', 'orchestrator', 'worker'])
    for (const script of ['build', 'typecheck', 'lint', 'format:check'])
      run('npx', [
        '--yes',
        'pnpm@10.34.0',
        '--filter',
        `@localqa/${pkg}`,
        script,
      ]);
  run('node', ['--test', 'packages/domain/test/domain.test.mjs']);
  run('node', ['--test', 'packages/orchestrator/test/boundary.test.mjs']);
  run('docker', [
    'image',
    'inspect',
    'postgres:18-alpine',
    'mcr.microsoft.com/playwright:v1.63.0-noble',
    '--format',
    '{{.Id}} {{json .RepoDigests}}',
  ]);
  run('docker', ['network', 'create', network]);
  run('docker', [
    'run',
    '--detach',
    '--name',
    postgres,
    '--network',
    network,
    '--env-file',
    envFile,
    'postgres:18-alpine',
  ]);
  containers.push(postgres);
  const mounts = JSON.parse(
    run('docker', ['inspect', postgres, '--format', '{{json .Mounts}}']).stdout,
  );
  volumes.push(...mounts.filter((x) => x.Type === 'volume').map((x) => x.Name));
  let ready = false;
  for (let n = 0; n < 80; n++) {
    const probe = run(
      'docker',
      ['exec', postgres, 'pg_isready', '-U', 'localqa', '-d', 'localqa'],
      true,
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    spawnSync('node', ['-e', 'setTimeout(()=>{},100)']);
  }
  if (!ready) throw new Error('Postgres readiness deadline');
  const runtimeArgs = [
    'run',
    '--name',
    browser,
    '--network',
    network,
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--cap-add=SYS_ADMIN',
    '--shm-size=256m',
    '--memory=2g',
    '--cpus=2',
    '--pids-limit=512',
    '--volume',
    `${root}:/work:ro`,
    '--volume',
    `${dir}:/work/apps/worker/.evidence:rw`,
    '--volume',
    `${root}packages/orchestrator/.artifacts:/work/packages/orchestrator/.artifacts:rw`,
    '--env',
    'HOME=/work/apps/worker/.evidence/home',
    '--env',
    'TMPDIR=/work/apps/worker/.evidence/tmp',
    '--env',
    'XDG_CACHE_HOME=/work/apps/worker/.evidence/cache',
    '--env',
    'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
    '--workdir',
    '/work',
    'mcr.microsoft.com/playwright:v1.63.0-noble',
    'node',
    '--test',
    '--test-timeout=120000',
    'apps/worker/test/integration.test.mjs',
  ];
  containers.push(browser);
  const tests = run('docker', runtimeArgs, true);
  writeFileSync(`${dir}/integration-output.log`, tests.stdout + tests.stderr);
  if (tests.status !== 0)
    throw new Error('Real PostgreSQL/browser integration suite failed');
  functionalPassed = true;
  result = true;
} catch (error) {
  failure = String(error);
  console.error(failure);
} finally {
  const cleanup = {
    containers: [],
    volumes: [],
    network: null,
    credentialsAbsent: false,
  };
  for (const name of containers) {
    run('docker', ['logs', name], true);
    run('docker', ['rm', '--force', '--volumes', name], true);
    const inspect = run('docker', ['inspect', name], true);
    const absent =
      inspect.status !== 0 && inspect.stderr.includes('no such object');
    cleanup.containers.push({ name, absent });
    if (!absent) {
      result = false;
      failure = 'Container cleanup failed';
    }
  }
  for (const name of volumes) {
    const inspect = run('docker', ['volume', 'inspect', name], true);
    const absent =
      inspect.status !== 0 && inspect.stderr.includes('no such volume');
    cleanup.volumes.push({ name, absent });
    if (!absent) {
      result = false;
      failure = 'Volume cleanup failed';
    }
  }
  run('docker', ['network', 'rm', network], true);
  const inspect = run('docker', ['network', 'inspect', network], true);
  cleanup.network = {
    name: network,
    absent: inspect.status !== 0 && inspect.stderr.includes('not found'),
  };
  if (!cleanup.network.absent) {
    result = false;
    failure = 'Network cleanup unverified';
  }
  rmSync(envFile, { force: true });
  rmSync(kekFile, { force: true });
  cleanup.credentialsAbsent = ![envFile, kekFile].some(existsSync);
  readOnlyChecks = Object.entries(readonly).map(([path, before]) => ({
    path,
    before,
    after: existsSync(`${root}${path}`)
      ? createHash('sha256')
          .update(readFileSync(`${root}${path}`))
          .digest('hex')
      : null,
  }));
  if (readOnlyChecks.some((x) => x.before !== x.after)) {
    result = false;
    failure = 'Read-only package baseline changed';
  }
  const sources = [];
  function walk(path) {
    for (const entry of readdirSync(`${root}${path}`, {
      withFileTypes: true,
    })) {
      if (
        ['node_modules', 'dist', '.evidence', '.artifacts'].includes(entry.name)
      )
        continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else
        sources.push({
          path: child,
          sha256: createHash('sha256')
            .update(readFileSync(`${root}${child}`))
            .digest('hex'),
        });
    }
  }
  for (const path of [
    'packages/domain',
    'packages/orchestrator',
    'apps/worker',
  ])
    walk(path);
  const facts = existsSync(`${dir}/facts.json`)
    ? JSON.parse(readFileSync(`${dir}/facts.json`, 'utf8'))
    : null;
  const compiledAfter = compiledDependencies();
  const compiledStable =
    JSON.stringify(compiledBefore) === JSON.stringify(compiledAfter);
  if (!compiledStable) {
    result = false;
    failure = 'Runtime dependency dist changed during verification';
  }
  const summary = (stdout) =>
    Object.fromEntries(
      ['tests', 'pass', 'fail', 'skipped'].map((key) => [
        key,
        Number(
          stdout.match(new RegExp(`(?:#|ℹ)\\s+${key}\\s+(\\d+)`))?.[1] ?? NaN,
        ),
      ]),
    );
  const unitResults = commands
    .filter((x) => x.command.startsWith('node --test'))
    .map((x) => ({
      command: x.command,
      exitCode: x.exitCode,
      counts: summary(x.stdout),
    }));
  const boundaryChanged = readOnlyChecks.filter((x) => x.before !== x.after);
  if (boundaryChanged.length)
    writeFileSync(
      `${dir}/boundary-change.json`,
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          response:
            'Kept original baseline; no rollback or attribution; owner must confirm accepted prerequisite version',
          files: boundaryChanged,
        },
        null,
        2,
      ) + '\n',
    );
  const record = {
    task: 'T05',
    recordedAt: new Date().toISOString(),
    result: result
      ? 'verified first vertical slice and selected faults'
      : 'failed',
    P0Passed: false,
    G2Passed: false,
    realModel: 'blocked; only T04 fixed stub used',
    failure,
    scopedEngineering: {
      functionalPassed,
      units: unitResults,
      integration: commands
        .filter((x) => x.command.startsWith(`docker run --name ${browser}`))
        .map((x) => ({ exitCode: x.exitCode, counts: summary(x.stdout) })),
      boundaryBlocked: boundaryChanged.length > 0,
    },
    logs: [
      'apps/worker/.evidence/integration-output.log',
      'apps/worker/.evidence/install.log',
      'apps/worker/.evidence/boundary-change.json',
    ],
    commands,
    installation: {
      command: 'npx --yes pnpm@10.34.0 install',
      stdout: readFileSync(`${dir}/install.log`, 'utf8'),
      rootLockfile:
        'Updated by explicitly requested root install; integration owner reviews it; no direct root source edits',
      pnpmLockfileSha256: createHash('sha256')
        .update(readFileSync(`${root}pnpm-lock.yaml`))
        .digest('hex'),
      toolCaches:
        'npm/npx default user cache permitted; pnpm cache/settings inherited from root .npmrc; application temporary/evidence/material files stay inside the project',
    },
    facts,
    runtimeDependencies: {
      unchangedDuringVerification: compiledStable,
      before: compiledBefore,
      after: compiledAfter,
    },
    sourceFiles: sources,
    readonlyPackages: {
      unchanged: readOnlyChecks.every((x) => x.before === x.after),
      files: readOnlyChecks,
    },
    cleanup,
    prerequisites: [
      'Linux Chromium non-root, chromiumSandbox:true, no --no-sandbox; SYS_ADMIN required on this T00 host.',
      'Node 24 runtime from Playwright container; host typecheck/build Node ' +
        process.version,
    ],
    unverified: [
      'No public/internal HTTP API, SSE/download authorization, UI or complete G2/P0 gate; T06/T07 own integration.',
      'Arbitrary business/visual semantic oracles, automatic link discovery, form/storage_state authentication and exclusive auth-account leases are not enabled; configured authentication fails closed to input.',
      'Only a bounded read-only tool subset observe/navigate/capture enabled until T03 freezes request/redirect/popup guards and screenshot redaction/cleanup results.',
      'Full production report/cleanup/rrweb/trace and evidence-orphan reconciliation remain integrations, not claimed complete.',
      'Real provider quality and real credential revocation/deployment service identity/TLS blocked. Timeout/429/full eight-stub matrix not exercised. Real SIGKILL and ignored-abort late-return unknown settlement are exercised.',
      'No performance/load/chaos DB restart/storage-full testing; selected functional fault tests only.',
    ],
    upstreamRequests: [
      'T03: exact origin including scheme/port; redirect/network/popup guards before requests; screenshots with reliable masking plus bytes/stream upload, not file URLs; close/cancel outcome visible. BrowserSnapshot needs link href/content-completeness signal for safe wider exploration.',
      'T04: confirm accepted signature/version after observed source drift; supported AbortSignal/transport budget hook freeze still needs joint review. T05 wraps ProviderAdapter to reserve EVERY send including repair; planner/finalizer map to coordinator profile because RoleModels lacks those fields.',
      'T02: dedicated least-privileged coordinator identity and recovery-final-verdict primitive. T05 currently uses server-only admin Actor under forced-RLS app role and new recovery attempt rather than inserting verdict under expired lease.',
    ],
  };
  writeFileSync(
    `${root}docs/validation-results/T05-domain.json`,
    JSON.stringify(record, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      result,
      failure,
      evidence: 'docs/validation-results/T05-domain.json',
    }),
  );
}
if (!result) process.exitCode = 1;
