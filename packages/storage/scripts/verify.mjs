import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = `${root}packages/storage/.evidence`;
mkdirSync(evidence, { recursive: true });
const commands = [];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    ...options,
  });
  const entry = {
    command: [command, ...args].join(' '),
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  commands.push(entry);
  console.log(JSON.stringify(entry));
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(`Command failed: ${command}`);
  return result;
}
const owned = Array.from(
  [
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    '.gitignore',
    'packages/test-fixture/package.json',
  ],
  (path) => ({
    path,
    hash: createHash('sha256')
      .update(readFileSync(`${root}${path}`))
      .digest('hex'),
  }),
);
const name = `localqa-t02-${randomUUID().slice(0, 8)}`;
const envPath = `${evidence}/postgres.env`,
  keyPath = `${evidence}/kek.json`,
  keyNextPath = `${evidence}/kek-next.json`;
const volumes = [];
let containerAbsent = false;
const password = randomBytes(24).toString('hex');
const key1 = randomBytes(32).toString('base64'),
  key2 = randomBytes(32).toString('base64');
writeFileSync(
  envPath,
  `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
  { mode: 0o600 },
);
writeFileSync(
  keyPath,
  JSON.stringify({ activeVersion: 1, keys: { 1: key1 } }),
  { mode: 0o600 },
);
writeFileSync(
  keyNextPath,
  JSON.stringify({ activeVersion: 2, keys: { 1: key1, 2: key2 } }),
  { mode: 0o600 },
);
let containerCreated = false,
  success = false,
  failure = null,
  server = null,
  applied = [];
try {
  for (const script of ['typecheck', 'lint', 'format:check'])
    run('npx', [
      '--yes',
      'pnpm@10.34.0',
      '--filter',
      '@localqa/storage',
      script,
    ]);
  run('npx', [
    '--yes',
    'pnpm@10.34.0',
    '--filter',
    '@localqa/storage',
    'build',
  ]);
  run('docker', ['version', '--format', '{{json .}}']);
  run('docker', [
    'image',
    'inspect',
    'postgres:18-alpine',
    '--format',
    '{{.Id}} {{json .RepoDigests}}',
  ]);
  run('docker', [
    'run',
    '--detach',
    '--name',
    name,
    '--env-file',
    envPath,
    '--publish',
    '127.0.0.1::5432',
    'postgres:18-alpine',
  ]);
  containerCreated = true;
  const mounts = JSON.parse(
    run('docker', ['inspect', name, '--format', '{{json .Mounts}}']).stdout,
  );
  volumes.push(
    ...mounts
      .filter((mount) => mount.Type === 'volume')
      .map((mount) => mount.Name),
  );
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const probe = spawnSync(
      'docker',
      [
        'exec',
        name,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'localqa',
        '-d',
        'localqa',
      ],
      { encoding: 'utf8' },
    );
    if (probe.status === 0) {
      commands.push({
        command: `docker exec ${name} pg_isready -h 127.0.0.1 -U localqa -d localqa`,
        exitCode: 0,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      ready = true;
      break;
    }
    await setTimeout(250);
  }
  if (!ready) throw new Error('Postgres readiness deadline exceeded');
  const port = run('docker', ['port', name, '5432/tcp'])
    .stdout.trim()
    .split(':')
    .at(-1);
  const connection = `postgresql://localqa:${password}@127.0.0.1:${port}/localqa`;
  const client = new pg.Client({ connectionString: connection });
  await client.connect();
  server = (await client.query('SELECT version() AS version')).rows[0];
  await client.end();
  console.log(JSON.stringify(server));
  const { migrate } = await import('../dist/index.js');
  applied = await migrate(
    connection,
    new URL('../migrations/', import.meta.url),
  );
  commands.push({
    command: 'migrate(database, packages/storage/migrations)',
    exitCode: 0,
    stdout: JSON.stringify({ applied }),
    stderr: '',
  });
  console.log(JSON.stringify({ applied }));
  const repeated = await migrate(
    connection,
    new URL('../migrations/', import.meta.url),
  );
  if (repeated.length) throw new Error('Migration not idempotent');
  commands.push({
    command: 'migrate(database) again',
    exitCode: 0,
    stdout: JSON.stringify({ applied: repeated }),
    stderr: '',
  });
  const test = run(
    'node',
    ['--test', 'packages/storage/test/integration.test.mjs'],
    {
      env: {
        ...process.env,
        LOCALQA_TEST_DATABASE_URL: connection,
        LOCALQA_TEST_KEK: keyPath,
        LOCALQA_TEST_NEXT_KEK: keyNextPath,
      },
    },
  );
  writeFileSync(`${evidence}/tests.log`, test.stdout + test.stderr);
  success = true;
} catch (error) {
  failure = String(error);
  console.error(failure);
} finally {
  if (containerCreated) {
    run('docker', ['logs', name], { allowFailure: true });
    run('docker', ['rm', '--force', '--volumes', name], { allowFailure: true });
    const inspect = run('docker', ['inspect', name], { allowFailure: true });
    containerAbsent =
      inspect.status !== 0 && inspect.stderr.includes('no such object');
    for (const volume of volumes) {
      const check = run('docker', ['volume', 'inspect', volume], {
        allowFailure: true,
      });
      if (check.status === 0) {
        success = false;
        failure = 'Volume cleanup failed';
      }
    }
    if (!containerAbsent) {
      success = false;
      failure = 'Container cleanup failed';
    }
  }
  for (const path of [
    envPath,
    keyPath,
    keyNextPath,
    `${evidence}/unsafe-kek.json`,
    `${evidence}/symlink-kek.json`,
  ])
    rmSync(path, { force: true });
  const boundaries = owned.map((item) => ({
    ...item,
    afterHash: createHash('sha256')
      .update(readFileSync(`${root}${item.path}`))
      .digest('hex'),
    unchanged:
      item.hash ===
      createHash('sha256')
        .update(readFileSync(`${root}${item.path}`))
        .digest('hex'),
  }));
  if (boundaries.some((item) => !item.unchanged)) {
    success = false;
    failure =
      'Root/fixture baseline changed during run; inspect concurrent owner changes';
  }
  const record = {
    task: 'T02',
    recordedAt: new Date().toISOString(),
    result: success ? 'storage engineering verified' : 'failed',
    P0Passed: false,
    M0Passed: false,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      pnpm: '10.34.0',
      pg: '8.23.1',
      server,
    },
    migrations: applied,
    installation: {
      command:
        'npx --yes pnpm@10.34.0 install --lockfile=false --ignore-scripts',
      rawOutput: existsSync(`${evidence}/install.log`)
        ? readFileSync(`${evidence}/install.log`, 'utf8')
        : null,
    },
    commands,
    summary: {
      tests: Number(
        commands
          .find((command) => command.command.startsWith('node --test'))
          ?.stdout.match(/ℹ tests (\d+)/)?.[1] ?? 0,
      ),
      passed: Number(
        commands
          .find((command) => command.command.startsWith('node --test'))
          ?.stdout.match(/ℹ pass (\d+)/)?.[1] ?? 0,
      ),
      migrations: applied.length,
      usesRealPostgres: true,
    },
    sourceFiles: (() => {
      const files = [];
      const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (['.evidence', 'dist', 'node_modules'].includes(entry.name))
            continue;
          const path = `${directory}/${entry.name}`;
          if (entry.isDirectory()) walk(path);
          else
            files.push({
              path: path.slice(root.length),
              sha256: createHash('sha256')
                .update(readFileSync(path))
                .digest('hex'),
            });
        }
      };
      walk(`${root}packages/storage`);
      return files;
    })(),
    boundaryIncident: existsSync(`${evidence}/boundary-change.json`)
      ? JSON.parse(readFileSync(`${evidence}/boundary-change.json`, 'utf8'))
      : null,
    earlierRuns: [
      'verify-first.log',
      'verify-second.log',
      'verify-diagnostic.log',
      'verify-third.log',
      'verify-fourth.log',
      'verify-fifth.log',
    ]
      .filter((path) => existsSync(`${evidence}/${path}`))
      .map((path) => ({
        path: `packages/storage/.evidence/${path}`,
        rawOutput: readFileSync(`${evidence}/${path}`, 'utf8'),
      })),
    artifactLocations: {
      project: root,
      transient: `packages/storage/.evidence`,
      npmNpxToolCache: '/Users/dcp/.npm',
      pnpmStore: '.cache/pnpm/store',
      pnpmCache: '.cache/pnpm/cache',
      pnpmState: '.cache/pnpm/state',
      globalPackagesInstalled: false,
    },
    boundaries,
    cleanup: {
      container: name,
      containerAbsent: containerCreated ? containerAbsent : true,
      anonymousVolumes: volumes,
      anonymousVolumesAbsent: volumes.every((volume) =>
        commands.some(
          (command) =>
            command.command === `docker volume inspect ${volume}` &&
            command.exitCode !== 0 &&
            command.stderr.includes('no such volume'),
        ),
      ),
      credentialFilesAbsent: [envPath, keyPath, keyNextPath].every(
        (path) => !existsSync(path),
      ),
      namedVolumesCreated: false,
    },
    failure,
    unverified: [
      'Node 24 LTS not run locally; actual Node 26.3.0.',
      'No HTTP API/UI/RBAC cookie/CSRF integration, browser/model or P0 release gate.',
      'T05 owns complete stage state machine, quota policies, model usage settlement, account-exclusive authentication leases and task-role result semantics.',
      'Free-form text redaction and externally uploaded material safety require shared RedactionPolicy; DB rejects known sensitive JSON keys but cannot infer arbitrary secrets.',
      'Full per-field API/CRUD/pagination/sorting suite and exhaustive combinations not exercised; tests cover storage constraints and selected repository flows.',
      'Production KEK mount, backup/restore/rotation rollout, least-privileged deployment login and platform model credential broker need T09/T04 integration.',
      'T02 used --lockfile=false and did not directly edit root files. A lockfile change was detected during an earlier run and recorded as a boundary incident; author not independently established. Integration owner must review/update lockfile and root CI (currently T01-only).',
    ],
    nextInputs: [
      '@localqa/storage uses shared @localqa/contracts DTOs; all ordinary resource lookups bind project_id and forced RLS.',
      'Database.actor/worker/auth callbacks are trusted server-only APIs. T06 must derive Actor from a verified session and WorkerScope from service identity, never user/model IDs.',
      'Deployment migration principal must be a controlled superuser/BYPASSRLS role with DDL/role creation privilege (security-definer membership functions require a bypassing owner); runtime login needs membership in localqa_app/localqa_auth/localqa_worker and must not expose a superuser connection.',
      'KEK file is protected (owner UID, no group/other access, no symlink), JSON key ring of 32-byte base64 keys; activeVersion identifies writer.',
      'Use LeaseRepository primitives with a verified project-scoped worker; poll/dispatch policy and complete role-specific verdict/result protocol belong to T05.',
    ],
  };
  writeFileSync(
    `${root}docs/validation-results/T02-storage.json`,
    JSON.stringify(record, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      success,
      failure,
      evidence: 'docs/validation-results/T02-storage.json',
    }),
  );
}
if (!success) process.exitCode = 1;
