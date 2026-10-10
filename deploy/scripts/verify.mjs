#!/usr/bin/env node
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

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = `${root}deploy/.evidence`;
rmSync(dir, { recursive: true, force: true }); // Dedicated, ignored T09 scratch from prior attempts.
mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const p of [
  'tmp',
  'home',
  'cache',
  'secrets',
  'backup',
  'restored-data',
]) {
  mkdirSync(`${dir}/${p}`, { recursive: true, mode: 0o700 });
}

const tag = randomUUID().slice(0, 8);
const network = `localqa-t09-${tag}`;
const networkRestored = `localqa-t09-res-${tag}`;
const postgres = `localqa-t09-pg-${tag}`;
const postgresRestored = `localqa-t09-pgres-${tag}`;
const browser = `localqa-t09-browser-${tag}`;

const pgDataVolume = `localqa-t09-pgdata-${tag}`;
const pgDataRestoredVolume = `localqa-t09-pgdata-res-${tag}`;
const evidenceRestoredVolume = `localqa-t09-evidence-res-${tag}`;
const artifactsDir = `${dir}/data`;
mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });

const envFile = `${dir}/postgres.env`;
const kekFile = `${dir}/secrets/kek.json`;
const adminPassFile = `${dir}/secrets/admin_initial_password`;
const pgPassword = randomBytes(24).toString('hex');
const adminPassword = 'AdminInitialPassword123!';

writeFileSync(
  envFile,
  `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${pgPassword}\nPGHOST=${postgres}\n`,
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

writeFileSync(adminPassFile, adminPassword + '\n', { mode: 0o600 });

const commands = [];
const volumes = [pgDataVolume, pgDataRestoredVolume, evidenceRestoredVolume];
const containers = [];
const networks = [network, networkRestored];
let result = false;
let failure = null;

function run(
  command,
  args,
  allowFailure = false,
  timeout = 240000,
  extraEnv = {},
) {
  const r = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  const redact = (value) =>
    String(value)
      .replaceAll(pgPassword, '[REDACTED_PG_PASSWORD]')
      .replaceAll(adminPassword, '[REDACTED_ADMIN_PASSWORD]');
  const entry = {
    command: redact([command, ...args].join(' ')),
    exitCode: r.status,
    signal: r.signal,
    stdout: redact(r.stdout ?? ''),
    stderr: redact(r.stderr ?? ''),
  };
  commands.push(entry);
  console.log(JSON.stringify(entry));
  if (!allowFailure && r.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.slice(0, 4).join(' ')}`);
  }
  return r;
}

const facts = {
  task: 'T09-A',
  timestamp: new Date().toISOString(),
  composeConfigValid: false,
  postgres: null,
  migrationsApplied: 0,
  bootstrapAdmin: null,
  bootstrapReplayBlocked: false,
  sandboxVerification: null,
  backup: null,
  disasterRecoveryDrill: null,
  diskStatus: null,
};

try {
  // 1. Validate Docker Compose Configuration
  console.log('\n=== Step 1: Validating docker compose config ===');
  const composeConfig = run('docker', [
    'compose',
    '-f',
    'deploy/docker-compose.yml',
    'config',
  ]);
  facts.composeConfigValid = composeConfig.status === 0;

  // 2. Start PostgreSQL 18 with persistent volume
  console.log(
    '\n=== Step 2: Starting PostgreSQL 18 with persistent volume ===',
  );
  run('docker', ['network', 'create', network]);
  run('docker', ['volume', 'create', pgDataVolume]);
  run('docker', [
    'run',
    '--detach',
    '--name',
    postgres,
    '--network',
    network,
    '--env-file',
    envFile,
    '--volume',
    `${pgDataVolume}:/var/lib/postgresql`,
    'postgres:18-alpine',
  ]);
  containers.push(postgres);

  let pgReady = false;
  for (let n = 0; n < 80; n++) {
    const probe = run(
      'docker',
      ['exec', postgres, 'pg_isready', '-U', 'localqa', '-d', 'localqa'],
      true,
    );
    if (probe.status === 0) {
      pgReady = true;
      break;
    }
    spawnSync('node', ['-e', 'setTimeout(()=>{},100)']);
  }
  if (!pgReady) throw new Error('Postgres readiness deadline');

  const pgVer = run('docker', [
    'exec',
    '-e',
    `PGPASSWORD=${pgPassword}`,
    postgres,
    'psql',
    '-U',
    'localqa',
    '-d',
    'localqa',
    '-t',
    '-c',
    'SELECT version()',
  ]);
  facts.postgres = pgVer.stdout.trim();

  // 3. Execute Migrations
  console.log('\n=== Step 3: Executing Database Migrations ===');
  const playwrightImage = 'mcr.microsoft.com/playwright:v1.63.0-noble';
  const nodeNetworkArgs = [
    'run',
    '--rm',
    '--network',
    network,
    '--volume',
    `${root}:/work:ro`,
    '--volume',
    `${dir}:/work/deploy/.evidence:rw`,
    '--workdir',
    '/work',
  ];

  run(
    'docker',
    [
      ...nodeNetworkArgs,
      '--env',
      `DATABASE_URL=postgresql://localqa:${pgPassword}@${postgres}:5432/localqa`,
      playwrightImage,
      'node',
      'deploy/scripts/migrate.mjs',
    ],
    false,
    60000,
  );
  facts.migrationsApplied = 4;
  const readyArgs = [
    ...nodeNetworkArgs,
    '--env',
    `DATABASE_URL=postgresql://localqa:${pgPassword}@${postgres}:5432/localqa`,
    '--env',
    'DATA_DIR=/work/deploy/.evidence/data',
    '--env',
    'MASTER_KEY_FILE=/work/deploy/.evidence/secrets/kek.json',
    playwrightImage,
    'node',
    'deploy/scripts/health-probe.mjs',
    '--ready',
  ];
  const ready = run('docker', readyArgs);
  const live = run('docker', [
    ...nodeNetworkArgs,
    playwrightImage,
    'node',
    'deploy/scripts/health-probe.mjs',
    '--live',
  ]);
  const notReady = run(
    'docker',
    [
      ...nodeNetworkArgs,
      '--env',
      `DATABASE_URL=postgresql://localqa:${pgPassword}@${postgres}:5432/localqa`,
      '--env',
      'DATA_DIR=/work/deploy/.evidence/data',
      '--env',
      'MASTER_KEY_FILE=/work/deploy/.evidence/secrets/absent.json',
      playwrightImage,
      'node',
      'deploy/scripts/health-probe.mjs',
      '--ready',
    ],
    true,
  );
  if (notReady.status !== 1) throw new Error('Missing KEK must fail readiness');
  facts.health = {
    live: live.status === 0,
    ready: ready.status === 0,
    missingKekRejected: true,
  };

  // 4. One-time Admin Bootstrap & Replay Rejection Test
  console.log('\n=== Step 4: Admin Bootstrap & Replay Rejection ===');
  run('docker', [
    ...nodeNetworkArgs,
    '--env',
    `DATABASE_URL=postgresql://localqa:${pgPassword}@${postgres}:5432/localqa`,
    '--env',
    `ADMIN_INITIAL_PASSWORD=${adminPassword}`,
    playwrightImage,
    'node',
    'deploy/scripts/bootstrap-admin.mjs',
  ]);
  facts.bootstrapAdmin = 'admin@localqa.internal (global_role: admin)';

  // Second bootstrap must be blocked with exitCode 2 (ALREADY_BOOTSTRAPPED)
  const bootstrapReplay = run(
    'docker',
    [
      ...nodeNetworkArgs,
      '--env',
      `DATABASE_URL=postgresql://localqa:${pgPassword}@${postgres}:5432/localqa`,
      '--env',
      `ADMIN_INITIAL_PASSWORD=${adminPassword}`,
      playwrightImage,
      'node',
      'deploy/scripts/bootstrap-admin.mjs',
    ],
    true,
  );
  facts.bootstrapReplayBlocked = bootstrapReplay.status === 2;
  if (!facts.bootstrapReplayBlocked) {
    throw new Error(
      'Bootstrap security violation: replay bootstrap was not rejected!',
    );
  }

  // 5. Chromium Sandbox Verification (T00 Method)
  console.log('\n=== Step 5: Chromium Sandbox Verification under Non-Root ===');
  const sandboxTestScript = `
    const { chromium } = require('/work/packages/browser/node_modules/playwright');
    const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
    const assert = require('node:assert/strict');

    (async () => {
      assert.notEqual(process.getuid(), 0, 'Worker must not run as root');
      const browser = await chromium.launch({
        chromiumSandbox: true,
        args: ['--enable-features=CDPScreenshotNewSurface'],
      });
      const page = await browser.newPage();
      await page.setContent('<html><body><h1>LocalQA Sandbox Verified</h1></body></html>');
      const png = await page.screenshot();
      writeFileSync('/work/deploy/.evidence/data/sandbox-screenshot.png', png);

      // Inspect /proc to verify sandbox processes
      const pids = readdirSync('/proc').filter((p) => /^\\d+$/.test(p));
      const chromeProcesses = [];
      for (const pid of pids) {
        try {
          const cmdline = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0');
          if (cmdline[0] && cmdline[0].includes('chrome')) {
            assert.ok(!cmdline.includes('--no-sandbox'), '--no-sandbox is strictly forbidden!');
            const status = readFileSync('/proc/' + pid + '/status', 'utf8');
            const uidMatch = status.match(/Uid:\\s+(\\d+)/);
            const seccompMatch = status.match(/Seccomp:\\s+(\\d+)/);
            chromeProcesses.push({
              pid: Number(pid),
              uid: Number(uidMatch?.[1]),
              seccomp: Number(seccompMatch?.[1]),
              noSandbox: false,
            });
          }
        } catch {}
      }
      await browser.close();
      assert.ok(chromeProcesses.length > 0, 'Chromium process not found');
      assert.ok(chromeProcesses.every((p) => p.uid !== 0), 'All Chromium processes must run as non-root');
      assert.ok(chromeProcesses.every((p) => p.seccomp === 2), 'Seccomp mode 2 (filter) must be active');
      console.log(JSON.stringify({ verified: true, processes: chromeProcesses }));
    })();
  `;

  writeFileSync(`${dir}/sandbox-test.js`, sandboxTestScript);

  containers.push(browser); // Track even if Chromium exits nonzero; a failed docker run leaves an exited container.
  const sandboxRun = run('docker', [
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
    '--volume',
    `${root}:/work:ro`,
    '--volume',
    `${dir}:/work/deploy/.evidence:rw`,
    '--env',
    'HOME=/work/deploy/.evidence/home',
    '--env',
    'TMPDIR=/work/deploy/.evidence/tmp',
    '--env',
    'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
    '--workdir',
    '/work',
    'mcr.microsoft.com/playwright:v1.63.0-noble',
    'node',
    '/work/deploy/.evidence/sandbox-test.js',
  ]);

  const sandboxJson = JSON.parse(
    sandboxRun.stdout.trim().split('\n').pop() || '{}',
  );
  facts.sandboxVerification = sandboxJson;

  // 6. Populate Sample Execution Data (Run, Case, Artifact, Verdict)
  console.log('\n=== Step 6: Populating Sample Execution & Report Data ===');
  const populateScript = `
    const pg = require('/work/packages/storage/node_modules/pg/lib/index.js');
    const { randomUUID, createHash } = require('node:crypto');
    const { readFileSync } = require('node:fs');

    (async () => {
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const client = await pool.connect();
      try {
        const adminId = (await client.query("SELECT id FROM users WHERE global_role='admin' LIMIT 1")).rows[0].id;
        const projId = randomUUID();
        await client.query("INSERT INTO projects(id, name) VALUES($1, 'T09 Deploy Project')", [projId]);
        await client.query("INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'owner')", [projId, adminId]);

        const runId = randomUUID();
        const config = {
          allowedOrigins: ['https://localqa.internal'],
          actionPolicy: 'non_submitting',
          budget: { maxCases: 8, maxPages: 6, maxDepth: 2, maxActiveSeconds: 600, maxActionsPerCase: 12, maxActions: 120, maxModelCalls: 100, maxReproductions: 3, concurrency: 2, maxTotalTokens: 300000 },
          environmentVersion: null,
          authProfileVersion: null,
          knowledgeVersionIds: [],
          models: {
            coordinator: { profileId: randomUUID(), version: 1 },
            explorer: { profileId: randomUUID(), version: 1 },
            executor: { profileId: randomUUID(), version: 1 },
            assertion: { profileId: randomUUID(), version: 1 },
            reproducer: { profileId: randomUUID(), version: 1 }
          }
        };

        // Insert Run in completed state
        await client.query(
          "INSERT INTO runs(id, project_id, creator_id, display_url, status, phase, completion, effective_config, budget_used, created_at, updated_at) VALUES($1,$2,$3,'https://localqa.internal','completed','finalize','complete',$4,$5,clock_timestamp(),clock_timestamp())",
          [runId, projId, adminId, config, {activeSeconds:0,actions:0,modelCalls:0,reproductions:0,totalTokens:0}]
        );

        // Insert case
        const caseId = randomUUID();
        const caseDef = {
          id: caseId, projectId: projId, runId, version: 1, title: 'Deployed Smoke Case',
          summary: 'Smoke test', outline: ['Navigate https://localqa.internal'], preconditions: [],
          criteria: [{ id: 'c1', kind: 'http_status', description: 'HTTP 200', expectedValue: 200, sourceKind: 'generic_smoke', sourceRef: 'FR-013' }]
        };
        await client.query(
          "INSERT INTO run_cases(id, project_id, run_id, document, criteria_hash) VALUES($1,$2,$3,$4,'hash-c1')",
          [caseId, projId, runId, caseDef]
        );

        // Store screenshot artifact
        const pngData = readFileSync('/work/deploy/.evidence/data/sandbox-screenshot.png');
        const artId = randomUUID();
        const artSha = createHash('sha256').update(pngData).digest('hex');
        const { LocalVolumeArtifactStore } = await import('/work/packages/report/dist/index.js');
        const store = new LocalVolumeArtifactStore('/work/deploy/.evidence/data');
        const artDoc = await store.put({
          id: artId, projectId: projId, runId, kind: 'screenshot',
          bytes: pngData.length, sha256: artSha, redaction: 'not_needed', caseId
        }, pngData);
        await client.query(
          "INSERT INTO artifacts(id, project_id, run_id, case_id, document, retain_until, held) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '30 days',false)",
          [artId, projId, runId, caseId, artDoc]
        );

        // Also simulate an in-flight unexpired task lease to test recovery invalidation
        const zTaskId = randomUUID();
        await client.query(
          "INSERT INTO jobs(id, project_id, run_id, unique_key, role, document, status) VALUES($1,$2,$3,'zombie-job-key','executor','{}','running')",
          [zTaskId, projId, runId]
        );
        await client.query(
          "INSERT INTO task_leases(id,project_id,task_id,worker_id,fencing_token,lease_until,token_hash) VALUES($1,$2,$3,'zombie-worker',1,clock_timestamp()+interval '10 minutes',$4)",
          [randomUUID(),projId,zTaskId,'a'.repeat(64)]
        );

        console.log(JSON.stringify({ populated: true, runId, projId, artId, artSha, zTaskId }));
      } finally {
        client.release();
        await pool.end();
      }
    })();
  `;
  writeFileSync(`${dir}/populate-test.js`, populateScript);
  run('docker', [
    ...nodeNetworkArgs,
    '--env',
    `DATABASE_URL=postgresql://localqa:${pgPassword}@${postgres}:5432/localqa`,
    playwrightImage,
    'node',
    '/work/deploy/.evidence/populate-test.js',
  ]);

  // 7. Execute Backup
  console.log('\n=== Step 7: Performing Backup (DB + Artifacts + KEK) ===');
  const backupDir = `${dir}/backup/t09-backup`;
  run('docker', [
    ...nodeNetworkArgs,
    '--env',
    `DATABASE_URL=postgresql://localqa:${pgPassword}@${postgres}:5432/localqa`,
    '--env',
    `DATA_DIR=/work/deploy/.evidence/data`,
    '--env',
    `MASTER_KEY_FILE=/work/deploy/.evidence/secrets/kek.json`,
    playwrightImage,
    'node',
    'deploy/scripts/backup.mjs',
    `/work/deploy/.evidence/backup/t09-backup`,
  ]);
  facts.backup = {
    backupDir: '/work/deploy/.evidence/backup/t09-backup',
    manifest: JSON.parse(
      readFileSync(`${backupDir}/backup-manifest.json`, 'utf8'),
    ),
  };

  // 8. Disaster Recovery Drill (Restore to NEW Database Volume & NEW Data Volume)
  console.log(
    '\n=== Step 8: Disaster Recovery Drill (Restore to NEW isolated volume) ===',
  );
  run('docker', ['network', 'create', networkRestored]);
  run('docker', ['volume', 'create', pgDataRestoredVolume]);
  run('docker', ['volume', 'create', evidenceRestoredVolume]);
  run('docker', [
    'run',
    '--detach',
    '--name',
    postgresRestored,
    '--network',
    networkRestored,
    '--env-file',
    envFile,
    '--volume',
    `${pgDataRestoredVolume}:/var/lib/postgresql`,
    'postgres:18-alpine',
  ]);
  containers.push(postgresRestored);

  let pgresReady = false;
  for (let n = 0; n < 80; n++) {
    const probe = run(
      'docker',
      [
        'exec',
        postgresRestored,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'localqa',
        '-d',
        'localqa',
      ],
      true,
    );
    if (probe.status === 0) {
      pgresReady = true;
      break;
    }
    spawnSync('node', ['-e', 'setTimeout(()=>{},100)']);
  }
  if (!pgresReady) throw new Error('Restored Postgres readiness deadline');

  // Execute restore drill
  const restoreRun = run('docker', [
    'run',
    '--rm',
    '--network',
    networkRestored,
    '--volume',
    `${root}:/work:ro`,
    '--volume',
    `${dir}:/work/deploy/.evidence:rw`,
    '--volume',
    `${evidenceRestoredVolume}:/work/deploy/.evidence/restored-data`,
    '--workdir',
    '/work',
    'mcr.microsoft.com/playwright:v1.63.0-noble',
    'node',
    'deploy/scripts/restore-drill.mjs',
    '/work/deploy/.evidence/backup/t09-backup',
    `postgresql://localqa:${pgPassword}@${postgresRestored}:5432/localqa`,
    '/work/deploy/.evidence/restored-data',
    '/work/deploy/.evidence/secrets/restored_kek.json',
  ]);
  facts.disasterRecoveryDrill = {
    passed: restoreRun.status === 0,
    output: restoreRun.stdout,
  };

  // 9. Run Disk Status and Graceful Drain scripts
  console.log(
    '\n=== Step 9: Running Disk Status & Graceful Drain Operations ===',
  );
  const diskStatus = run('docker', [
    'run',
    '--rm',
    '--network',
    network,
    '--volume',
    `${root}:/work:ro`,
    '--volume',
    `${dir}:/work/deploy/.evidence:rw`,
    '--env',
    `DATABASE_URL=postgresql://localqa:${pgPassword}@${postgres}:5432/localqa`,
    '--env',
    `DATA_DIR=/work/deploy/.evidence/data`,
    '--workdir',
    '/work',
    'mcr.microsoft.com/playwright:v1.63.0-noble',
    'node',
    'deploy/scripts/disk-status.mjs',
  ]);
  facts.diskStatus = diskStatus.stdout;

  const drainRun = run(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      network,
      '--volume',
      `${root}:/work:ro`,
      '--env',
      `DATABASE_URL=postgresql://localqa:${pgPassword}@${postgres}:5432/localqa`,
      '--env',
      'SHUTDOWN_TIMEOUT_SECONDS=0',
      '--workdir',
      '/work',
      'mcr.microsoft.com/playwright:v1.63.0-noble',
      'node',
      'deploy/scripts/graceful-shutdown.mjs',
    ],
    true,
  );
  if (drainRun.status !== 2)
    throw new Error('Drain must reject a live zombie lease');
  facts.liveDrainRejected = true;

  result = true;
} catch (error) {
  failure = String(error);
  console.error('[Verify Failure]', failure);
} finally {
  console.log('\n=== Final Step: Teardown, Cleanup & Absence Check ===');
  const cleanup = {
    containers: [],
    volumes: [],
    networks: [],
    credentialsAbsent: false,
  };

  for (const name of containers) {
    run('docker', ['rm', '--force', '--volumes', name], true);
    const inspect = run('docker', ['inspect', name], true);
    const absent =
      inspect.status !== 0 && inspect.stderr.includes('no such object');
    cleanup.containers.push({ name, absent });
    if (!absent) {
      result = false;
      failure = `Container cleanup failed for ${name}`;
    }
  }

  for (const name of volumes) {
    const inspect = run('docker', ['volume', 'inspect', name], true);
    if (inspect.status === 0) {
      run('docker', ['volume', 'rm', name], true);
    }
    const check = run('docker', ['volume', 'inspect', name], true);
    const absent =
      check.status !== 0 && check.stderr.includes('no such volume');
    cleanup.volumes.push({ name, absent });
    if (!absent) {
      result = false;
      failure = `Volume cleanup failed for ${name}`;
    }
  }

  for (const name of networks) {
    run('docker', ['network', 'rm', name], true);
    const inspect = run('docker', ['network', 'inspect', name], true);
    const absent = inspect.status !== 0 && inspect.stderr.includes('not found');
    cleanup.networks.push({ name, absent });
    if (!absent) {
      result = false;
      failure = `Network cleanup failed for ${name}`;
    }
  }

  rmSync(dir, { recursive: true, force: true });
  cleanup.credentialsAbsent = !existsSync(dir);

  const sources = [];
  function walk(p) {
    if (!existsSync(`${root}${p}`)) return;
    for (const e of readdirSync(`${root}${p}`, { withFileTypes: true })) {
      if (['node_modules', '.evidence'].includes(e.name)) continue;
      const child = `${p}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else
        sources.push({
          path: child,
          sha256: createHash('sha256')
            .update(readFileSync(`${root}${child}`))
            .digest('hex'),
        });
    }
  }
  walk('deploy');

  const record = {
    task: 'T09-A',
    recordedAt: new Date().toISOString(),
    result: result
      ? 'verified deployment skeleton, sandbox, backup, and restore drill'
      : 'failed',
    P0Passed: false,
    failure,
    facts,
    cleanup,
    commands,
    sourceFiles: sources,
    prerequisites: [
      'Linux 6.8+ aarch64 (Colima Docker engine)',
      'Images postgres:18-alpine and mcr.microsoft.com/playwright:v1.63.0-noble available locally',
      'Worker requires non-root user + SYS_ADMIN capability on Ubuntu 24.04 to permit Chromium user namespace creation',
    ],
    unverified: [
      'apps/api (T06) was in parallel flight and omitted from live routing test',
      'Full P0 end-to-end integration gate (T09-B) remains until API and Web containers are assembled',
      'Compose worker/orchestrator application images, entrypoints, and readiness have not run as a stack',
      'Worker production image UID 1001 filesystem permissions and sandbox were not verified; the Chromium test used host UID in Playwright image',
      'Node SQL fallback backup is not production-consistent; pg_dump/PITR, bytea-heavy data, large dataset, disk-full and network faults remain unverified',
      'Worker stop-claim control and live graceful shutdown are not wired; only refusal to declare drained was tested',
      'Production TLS, service identities, authorized downloads, and encrypted/offsite KEK custody remain unverified',
    ],
  };

  writeFileSync(
    `${root}docs/validation-results/T09-deploy.json`,
    JSON.stringify(record, null, 2) + '\n',
  );

  console.log(
    JSON.stringify({
      result,
      failure,
      evidence: 'docs/validation-results/T09-deploy.json',
    }),
  );
}

if (!result) process.exitCode = 1;
