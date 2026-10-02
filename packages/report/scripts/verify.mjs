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
const dir = `${root}packages/report/.evidence`;
mkdirSync(dir, { recursive: true });
for (const path of ['tmp', 'home', 'cache', 'scratch']) {
  mkdirSync(`${dir}/${path}`, { recursive: true, mode: 0o700 });
}
mkdirSync(`${root}packages/report/.artifacts`, {
  recursive: true,
  mode: 0o700,
});

const tag = randomUUID().slice(0, 8);
const network = `localqa-t08-${tag}`;
const postgres = `localqa-t08-pg-${tag}`;
const browser = `localqa-t08-browser-${tag}`;

const envFile = `${dir}/postgres.env`;
const kekFile = `${dir}/kek.json`;
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
const commands = [];
const volumes = [];
const containers = [];
let result = false;
let failure = null;

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
  if (!allowFailure && r.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.slice(0, 3).join(' ')}`);
  }
  return r;
}

function snapshotBaseline() {
  const output = {};
  for (const pkg of [
    'packages/contracts',
    'packages/storage',
    'packages/browser',
    'packages/model-gateway',
    'packages/agents',
    'packages/domain',
    'packages/orchestrator',
    'packages/test-fixture',
  ]) {
    const walk = (dirpath) => {
      if (!existsSync(`${root}${dirpath}`)) return;
      for (const e of readdirSync(`${root}${dirpath}`, {
        withFileTypes: true,
      })) {
        if (
          ['node_modules', 'dist', '.evidence', '.artifacts'].includes(e.name)
        )
          continue;
        const child = `${dirpath}/${e.name}`;
        if (e.isDirectory()) walk(child);
        else
          output[child] = createHash('sha256')
            .update(readFileSync(`${root}${child}`))
            .digest('hex');
      }
    };
    walk(pkg);
  }
  return output;
}

const readonly = snapshotBaseline();
writeFileSync(
  `${dir}/readonly-baseline.json`,
  JSON.stringify(readonly, null, 2) + '\n',
);
let readOnlyChecks;
let functionalPassed = false;

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
    'domain',
    'orchestrator',
  ]) {
    walk(`packages/${pkg}/dist`);
  }
  return output;
}

const compiledBefore = compiledDependencies();

try {
  // 1. Build, typecheck, lint, format for @localqa/report
  for (const script of ['build', 'typecheck', 'lint', 'format:check']) {
    run('npx', [
      '--yes',
      'pnpm@10.34.0',
      '--filter',
      '@localqa/report',
      script,
    ]);
  }

  // 2. Unit tests on host
  run('node', ['--test', 'packages/report/test/unit.test.mjs']);

  // 3. Inspect docker images
  run('docker', [
    'image',
    'inspect',
    'postgres:18-alpine',
    'mcr.microsoft.com/playwright:v1.63.0-noble',
    '--format',
    '{{.Id}} {{json .RepoDigests}}',
  ]);

  // 4. Create docker network
  run('docker', ['network', 'create', network]);

  // 5. Start postgres container
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

  // 6. Run integration test suite in Playwright container
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
    `${dir}:/work/packages/report/.evidence:rw`,
    '--volume',
    `${root}packages/report/.artifacts:/work/packages/report/.artifacts:rw`,
    '--env',
    'HOME=/work/packages/report/.evidence/home',
    '--env',
    'TMPDIR=/work/packages/report/.evidence/tmp',
    '--env',
    'XDG_CACHE_HOME=/work/packages/report/.evidence/cache',
    '--env',
    'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
    '--workdir',
    '/work',
    'mcr.microsoft.com/playwright:v1.63.0-noble',
    'node',
    '--test',
    '--test-timeout=120000',
    'packages/report/test/integration.test.mjs',
  ];
  containers.push(browser);
  const tests = run('docker', runtimeArgs, true);
  writeFileSync(`${dir}/integration-output.log`, tests.stdout + tests.stderr);
  if (tests.status !== 0) {
    throw new Error('Real PostgreSQL/browser integration suite failed');
  }

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
    if (!existsSync(`${root}${path}`)) return;
    for (const entry of readdirSync(`${root}${path}`, {
      withFileTypes: true,
    })) {
      if (
        ['node_modules', 'dist', '.evidence', '.artifacts'].includes(entry.name)
      ) {
        continue;
      }
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
  walk('packages/report');

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
  if (boundaryChanged.length) {
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
  }

  const record = {
    task: 'T08',
    recordedAt: new Date().toISOString(),
    result: result
      ? 'verified report builder, artifact store, export ZIP and retention GC'
      : 'failed',
    P0Passed: false,
    G2Passed: false,
    failure,
    scopedEngineering: {
      functionalPassed,
      units: unitResults,
      integration: commands
        .filter((x) => x.command.startsWith(`docker run --name ${browser}`))
        .map((x) => ({ exitCode: x.exitCode, counts: summary(x.stdout) })),
      boundaryBlocked: boundaryChanged.length > 0,
    },
    logs: ['packages/report/.evidence/integration-output.log'],
    commands,
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
      'PostgreSQL 18 on aarch64 container with full migrations 001-004 applied.',
    ],
    contractFollowUp: {
      recordedAt: new Date().toISOString(),
      cleanupStatus:
        'Report cleanupStatus is taken from jobs.result.cleanupStatus on finalizer rows and is not written back to runs.status or jobs.status.',
      manifestStatus:
        'Export manifest status uses Artifact.status (available|degraded|missing|failed). Oversized and redaction-failed entries are failed with a specific error and no relativePath. degraded stays degraded.',
      whyPreviousWriteWasRejected:
        'mapDatabaseError turns SQLSTATE 23514 into VALIDATION_ERROR. runs.status only allows draft|queued|running|awaiting_input|cancelling|completed|cancelled|failed, so writing cleanup succeeded|pending|not_required|manual_required onto runs.status fails the CHECK. jobs.status rejects pending|not_required|manual_required. artifacts.document is checked by guard_artifact_document (id/project/run/task/step/case/snapshot must match the columns) and reject_secret_keys; replacing that document with a manifest entry, or using status too_large|redacted, is not a valid artifact write. This fix keeps the new values on the in-memory Report and manifest only. exports.report_snapshot is not under reject_secret_keys, and the Export document does not carry the manifest status.',
    },
    unverified: [
      'No public/internal HTTP API routes or SSE endpoints implemented in T08; T06 owns fastify routing integration.',
      'S3CompatibleArtifactStore is designed with standard interfaces; remote cloud S3/R2 live credentials not tested in offline harness.',
      'No performance/stress/chaos DB restart testing; selected deterministic functional and fault-handling tests only.',
      'No claim of P0 or G2 pass; scoped engineering verification for T08 only.',
    ],
    upstreamRequests: [
      'T06: import @localqa/report (ArtifactStore, ReportBuilder, ExportService, GarbageCollector) directly in apps/api routes without pulling full orchestrator internals.',
      'T03: ensure trace and rrweb recordings export valid zip/json blobs with explicit redaction status when available.',
    ],
  };

  writeFileSync(
    `${root}docs/validation-results/T08-report.json`,
    JSON.stringify(record, null, 2) + '\n',
  );

  console.log(
    JSON.stringify({
      result,
      failure,
      evidence: 'docs/validation-results/T08-report.json',
    }),
  );
}

if (!result) process.exitCode = 1;
