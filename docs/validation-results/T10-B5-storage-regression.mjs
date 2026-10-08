// Run the existing storage integration suite in a uniquely owned PostgreSQL.
// Redirect only its two filesystem permission fixtures to our temporary dir.
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { migrate } from '../../packages/storage/dist/index.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'localqa-root-storage-'));
const tag = randomUUID().slice(0, 8);
const name = `localqa-root-storage-${tag}`;
const sourcePath = join(repo, 'packages/storage/test/integration.test.mjs');
const scriptPath = join(repo, `packages/storage/test/.root-storage-${tag}.mjs`);
const facts = {
  tag,
  scope: 'Existing real PostgreSQL storage suite; no browser or provider',
  containerId: null,
};
try {
  const password = randomBytes(24).toString('hex');
  const env = join(dir, 'pg.env');
  await writeFile(
    env,
    `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  const launched = spawnSync(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      name,
      '--env-file',
      env,
      '--publish',
      '127.0.0.1::5432',
      'postgres:18-alpine',
    ],
    { encoding: 'utf8' },
  );
  if (launched.status !== 0)
    throw new Error('Unique PostgreSQL could not start');
  facts.containerId = launched.stdout.trim();
  const port = spawnSync('docker', ['port', facts.containerId, '5432/tcp'], {
    encoding: 'utf8',
  })
    .stdout.trim()
    .split(':')
    .at(-1);
  const connection = `postgres://localqa:${password}@127.0.0.1:${port}/localqa`;
  let applied;
  for (let i = 0; i < 80; i++) {
    try {
      applied = await migrate(
        connection,
        new URL('../../packages/storage/migrations/', import.meta.url),
      );
      break;
    } catch {
      await delay(100);
    }
  }
  if (!applied)
    throw new Error('Unique PostgreSQL/migrations did not become ready');
  facts.migrations = applied;
  const key1 = randomBytes(32).toString('base64'),
    key2 = randomBytes(32).toString('base64');
  const kek = join(dir, 'kek.json'),
    next = join(dir, 'kek-next.json');
  await writeFile(
    kek,
    JSON.stringify({ activeVersion: 1, keys: { 1: key1 } }),
    { mode: 0o600 },
  );
  await writeFile(
    next,
    JSON.stringify({ activeVersion: 2, keys: { 1: key1, 2: key2 } }),
    { mode: 0o600 },
  );
  const source = await readFile(sourcePath, 'utf8');
  facts.sourceSha256 = createHash('sha256').update(source).digest('hex');
  const anchor = "new URL('../.evidence/', import.meta.url)";
  if (!source.includes(anchor))
    throw new Error(
      'Storage filesystem fixture location changed; inspect before running',
    );
  await writeFile(
    scriptPath,
    source.replace(
      anchor,
      `new URL(${JSON.stringify(pathToFileURL(`${dir}/`).href)})`,
    ),
  );
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-reporter=tap', scriptPath],
      {
        cwd: repo,
        env: {
          ...process.env,
          LOCALQA_TEST_DATABASE_URL: connection,
          LOCALQA_TEST_KEK: kek,
          LOCALQA_TEST_NEXT_KEK: next,
        },
      },
    );
    let log = '';
    child.stdout.on('data', (bytes) => {
      log += bytes;
    });
    child.stderr.on('data', (bytes) => {
      log += bytes;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, log }));
  });
  await writeFile(
    join(repo, 'docs/validation-results/T10-B5-storage-regression.log'),
    result.log,
  );
  facts.exitCode = result.exitCode;
  facts.testSummary = result.log
    .split('\n')
    .filter((line) => /^# (tests|pass|fail|skipped|duration_ms) /.test(line));
  if (result.exitCode !== 0) {
    console.log(result.log);
    process.exitCode = 1;
  }
} finally {
  if (facts.containerId) {
    const removed = spawnSync('docker', [
      'rm',
      '--force',
      '--volumes',
      facts.containerId,
    ]);
    const absent = spawnSync('docker', ['inspect', facts.containerId]);
    facts.containerRemoved = removed.status === 0 && absent.status !== 0;
    if (!facts.containerRemoved) process.exitCode = 1;
  }
  await rm(scriptPath, { force: true });
  await rm(dir, { recursive: true, force: true });
  facts.temporaryFilesRemoved = true;
  await writeFile(
    join(repo, 'docs/validation-results/T10-B5-storage-regression.json'),
    JSON.stringify(facts, null, 2) + '\n',
  );
  console.log(JSON.stringify(facts, null, 2));
}
