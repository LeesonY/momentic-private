// T10-AUTH-2 independent counterexamples. Unique PG + FakeBrowser.
// Does not edit product code, does not call a provider, worker-entry, or Playwright.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Database,
  migrate,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  ConfigurationRepository,
  SecretVault,
} from '../../packages/storage/dist/index.js';
import { RuntimeClient } from '../../packages/orchestrator/dist/index.js';
import { DEFAULT_LIMITS } from '../../packages/domain/dist/index.js';
import { createApiContext, createApiServer } from '../../apps/api/dist/index.js';
import { Worker } from '../../apps/worker/dist/index.js';

const tag = randomUUID().slice(0, 8);
const sentinel = `T10AUTH2-SENTINEL-${tag}`;
const containerName = `localqa-auth2-${tag}`;
const dir = mkdtempSync(join(tmpdir(), 'localqa-auth2-'));
const evidence = {
  task: 'T10-AUTH-2',
  tag,
  date: '2026-10-06',
  P0Passed: false,
  G3Passed: false,
  liveModelCalled: false,
  playwrightLaunched: false,
  workerEntry: false,
  cases: [],
  ownership: { directory: dir, containerName },
};
let containerId;
let db;
let vault;
let context;
let server;
let actor;
let project;
let cookie;
let origin;
let connection;

class FakeBrowserPort {
  contexts = [];
  events = [];
  lastSessionOptions = null;
  async createSession(options) {
    this.lastSessionOptions = {
      allowedOrigins: options.allowedOrigins ?? null,
      hasApprovedAuthState: Object.hasOwn(options, 'approvedAuthState'),
      approvedAuthState: options.approvedAuthState ?? null,
    };
    const pageId = randomUUID();
    const state = {
      id: options.sessionId,
      pageId,
      text: 'initial',
      url: 'http://localhost:8080/',
      closed: false,
      snapshot: null,
    };
    this.contexts.push(state);
    const fresh = () =>
      (state.snapshot = {
        snapshotId: randomUUID(),
        pageId,
        frameIds: ['main'],
        displayUrl: state.url,
        title: 'AUTH-2 FakeBrowser',
        responseStatus: 200,
        capturedAt: new Date().toISOString(),
        stateVersion: 1,
        viewport: { width: 800, height: 600 },
        nodes: [
          {
            nodeId: 'testid_input',
            frameId: 'main',
            role: 'textbox',
            name: 'Input',
            text: state.text,
            visible: true,
            enabled: true,
            bounds: { left: 0, top: 0, width: 100, height: 20 },
          },
        ],
        screenshotRef: null,
        networkSummary: [],
        consoleSummary: [],
        truncated: false,
        redacted: true,
      });
    return {
      id: state.id,
      taskId: options.taskId,
      activePageId: pageId,
      get isClosed() {
        return state.closed;
      },
      getSnapshot: async ({ forceFresh } = {}) =>
        forceFresh || !state.snapshot ? fresh() : state.snapshot,
      resolveRegressionLocator: async (locator, signal) => {
        if (signal?.aborted) throw new Error('cancelled');
        const snapshot = state.snapshot;
        return {
          snapshotId: snapshot.snapshotId,
          pageId,
          nodeId: 'testid_input',
          frameId: 'main',
        };
      },
      executeTool: async (call, { signal } = {}) => {
        assert.equal(signal?.aborted, false);
        this.events.push({ runId: options.runId, call });
        if (call.name === 'navigate') state.url = call.args.url;
        if (call.name === 'type_text') state.text = call.args.text;
        if (call.name === 'click') state.text = 'done';
        let data;
        if (call.name === 'capture') {
          const bytes = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
          );
          const path = join(options.artifactsDir, `${randomUUID()}.bin`);
          mkdirSync(options.artifactsDir, { recursive: true });
          writeFileSync(path, bytes);
          data = {
            id: randomUUID(),
            projectId: options.projectId,
            runId: options.runId,
            kind: 'screenshot',
            status: 'available',
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            contentUrl: pathToFileURL(path).toString(),
            redaction: 'not_needed',
            error: null,
            createdAt: new Date().toISOString(),
            taskId: options.taskId,
            stepId: null,
            caseId: null,
            snapshotId: null,
          };
        } else data = fresh();
        return {
          requestId: randomUUID(),
          actionId: null,
          status: 'succeeded',
          data,
          reasonCode: null,
          evidenceRefs: [],
        };
      },
      close: async () => {
        state.closed = true;
      },
      cancel: async () => {},
      captureScreenshot: async () => {
        throw new Error('not used');
      },
    };
  }
  async close() {
    for (const state of this.contexts) state.closed = true;
  }
}

function containsSentinel(value) {
  return JSON.stringify(value).includes(sentinel);
}

async function api(path, body, key) {
  const res = await fetch(`${origin}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

async function setup() {
  const password = randomBytes(24).toString('hex');
  const pgEnv = join(dir, 'pg.env');
  writeFileSync(
    pgEnv,
    `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  const launch = spawnSync(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      containerName,
      '--env-file',
      pgEnv,
      '--publish',
      '127.0.0.1::5432',
      'postgres:18-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(launch.status, 0, launch.stderr);
  containerId = launch.stdout.trim();
  evidence.ownership.containerId = containerId;
  const owned = JSON.parse(
    spawnSync('docker', ['inspect', containerId], { encoding: 'utf8' }).stdout,
  )[0];
  evidence.ownership.volumes = owned.Mounts.filter((x) => x.Type === 'volume').map(
    (x) => x.Name,
  );
  const port = Number(
    spawnSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' })
      .stdout.trim()
      .split(':')
      .at(-1),
  );
  evidence.ownership.pgPort = port;
  connection = `postgresql://localqa:${password}@127.0.0.1:${port}/localqa`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      await migrate(
        connection,
        new URL('../../packages/storage/migrations/', import.meta.url),
      );
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, 'migrations');
  const kek = join(dir, 'kek.json');
  writeFileSync(
    kek,
    JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    }),
    { mode: 0o600 },
  );
  vault = await SecretVault.fromProtectedFile(kek);
  db = new Database(connection);
  const user = await new AccountsRepository(db).bootstrap({
    email: `auth2-${tag}@localqa.test`,
    displayName: 'AUTH-2',
    password: 'Auth2Password123456!',
  });
  actor = { userId: user.id };
  project = await new ProjectRepository(db).create(actor, {
    name: `AUTH-2 ${tag}`,
  });
  const model = await new ModelRepository(db, vault).create(actor, {
    name: 'No provider',
    endpoint: 'https://auth2.invalid/v1',
    configuredModelId: 'unused',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
  });
  project = await new ProjectRepository(db).update(actor, project.id, {
    expectedVersion: 1,
    defaultModelProfileId: model.id,
  });
  const artifactsDir = join(dir, 'store');
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
  context = createApiContext({
    connectionString: connection,
    vault,
    artifactsDir,
    serviceActor: actor,
    publicOrigin: 'http://localhost',
  });
  server = createApiServer(context);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' ? addr.port : addr}`;
  evidence.ownership.apiOrigin = origin;
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: user.email,
      password: 'Auth2Password123456!',
    }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie.length > 10);
}

async function exclusiveRunGap() {
  const configs = new ConfigurationRepository(db, vault);
  const profile = await configs.createAuthProfile(actor, project.id, {
    name: 'exclusive none',
    mode: 'none',
    allowedOrigins: ['http://localhost:8080'],
    sharingPolicy: 'exclusive_run',
  });
  assert.equal(profile.sharingPolicy, 'exclusive_run');
  const binding = { profileId: project.defaultModelProfileId, version: 1 };
  const config = {
    allowedOrigins: ['http://localhost:8080'],
    actionPolicy: 'non_submitting',
    environmentVersion: null,
    authProfileVersion: profile.version,
    models: Object.fromEntries(
      ['coordinator', 'explorer', 'executor', 'assertion', 'reproducer'].map(
        (role) => [role, binding],
      ),
    ),
    knowledgeVersionIds: [],
    budget: { ...DEFAULT_LIMITS },
  };
  const run1 = await context.coordinator.start(
    actor,
    {
      projectId: project.id,
      targetUrl: 'http://localhost:8080/',
      authProfileId: profile.id,
    },
    config,
    randomUUID(),
  );
  const run2 = await context.coordinator.start(
    actor,
    {
      projectId: project.id,
      targetUrl: 'http://localhost:8080/',
      authProfileId: profile.id,
    },
    config,
    randomUUID(),
  );
  const tables = await db.actor(actor, async (client) => {
    const listed = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND (
         table_name ILIKE '%auth%lock%' OR table_name ILIKE '%credential%lease%'
         OR table_name ILIKE '%exclusive%'
       )`,
    );
    const runs = await client.query(
      'SELECT id,status,auth_profile_id FROM runs WHERE id=ANY($1::uuid[])',
      [[run1.id, run2.id]],
    );
    return { lockTables: listed.rows.map((row) => row.table_name), runs: runs.rows };
  });
  await context.coordinator.cancel(actor, project.id, run1.id);
  await context.coordinator.cancel(actor, project.id, run2.id);
  await context.coordinator.tick(project.id);
  assert.notEqual(run1.id, run2.id);
  assert.equal(tables.runs.length, 2);
  assert.equal(tables.lockTables.length, 0);
  evidence.cases.push({
    name: 'exclusive_run-two-smoke-runs-both-start',
    passed: true,
    profileId: profile.id,
    sharingPolicy: profile.sharingPolicy,
    runIds: [run1.id, run2.id],
    lockTables: tables.lockTables,
    note: '同一 exclusive_run none 剖面连续两次 start 都成功。库中没有认证独占表。',
  });
}

async function typeTextPersistence() {
  const doc = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: `case-${randomUUID()}`,
    name: 'AUTH-2 type_text persistence',
    variables: {},
    criteria: [
      {
        id: 'result',
        kind: 'text_equals',
        description: 'After type',
        sourceKind: 'user_spec',
        sourceRef: 'owner',
        locator: { by: 'test_id', value: 'input' },
        expectedValue: 'done',
      },
    ],
    steps: [
      { kind: 'navigate', url: 'http://localhost:8080/' },
      {
        kind: 'type_text',
        locator: { by: 'label', value: 'Input' },
        text: sentinel,
      },
      { kind: 'click', locator: { by: 'css', value: 'input' } },
      { kind: 'assert', criterionId: 'result' },
    ],
  };
  const saved = await api(`/projects/${project.id}/saved-cases`, {
    slug: `auth2-${tag}`,
    name: doc.name,
    document: doc,
  });
  assert.equal(saved.status, 201, JSON.stringify(saved));
  const version = (await api(`/saved-cases/${saved.body.id}/versions`)).body
    .items[0];
  const input = {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'AUTH-2 persistence fixture',
  };
  const preview = await api(
    `/saved-case-versions/${version.id}/review-preview`,
    input,
  );
  assert.equal(preview.status, 200);
  assert.equal(
    (
      await api(`/saved-case-versions/${version.id}/review`, {
        ...input,
        confirmationToken: preview.body.confirmationToken,
      })
    ).status,
    200,
  );
  const created = await api(
    '/regression-runs',
    {
      projectId: project.id,
      caseVersionIds: [version.id],
    },
    randomUUID(),
  );
  assert.equal(created.status, 202, JSON.stringify(created));
  const run = created.body;
  const browser = new FakeBrowserPort();
  const runtime = new RuntimeClient(
    context.coordinator,
    { projectId: project.id, workerId: `auth2-${randomUUID()}` },
    context.artifacts,
    {},
  );
  runtime.model = async () => {
    throw new Error('Unexpected model call');
  };
  const worker = new Worker({
    runtime,
    browser,
    scratch: join(dir, 'scratch'),
    pollMs: 10,
    heartbeatMs: 1000,
  });
  const signal = new AbortController().signal;
  assert.equal(await worker.once(signal), true);
  await context.coordinator.tick(project.id);
  assert.equal(await worker.once(signal), true);
  const surfaces = await db.actor(actor, async (client) => {
    const intents = (
      await client.query(
        "SELECT tool_call FROM action_intents WHERE run_id=$1 AND tool_call->>'name'='type_text'",
        [run.id],
      )
    ).rows;
    const steps = (
      await client.query('SELECT document FROM steps WHERE run_id=$1', [run.id])
    ).rows.map((row) => row.document);
    const events = (
      await client.query('SELECT type,payload FROM run_events WHERE run_id=$1', [
        run.id,
      ])
    ).rows;
    const snapshots = (
      await client.query('SELECT document FROM page_snapshots WHERE run_id=$1', [
        run.id,
      ])
    ).rows.map((row) => row.document);
    const models = (
      await client.query(
        'SELECT request_id FROM model_requests WHERE run_id=$1',
        [run.id],
      )
    ).rowCount;
    const jobs = (
      await client.query('SELECT id,role FROM jobs WHERE run_id=$1', [run.id])
    ).rows;
    return { intents, steps, events, snapshots, models, jobs };
  });
  const executor = surfaces.jobs.find((job) => job.role === 'executor');
  const stepsHttp = executor
    ? await api(`/tasks/${executor.id}/steps`)
    : { status: 0, body: {} };
  const history = await api(`/runs/${run.id}/event-history`);
  const report = await api(`/runs/${run.id}/report`);
  await context.coordinator.cancel(actor, project.id, run.id);
  await context.coordinator.tick(project.id);
  const intentHas = surfaces.intents.some((row) => containsSentinel(row.tool_call));
  const snapshotHas = surfaces.snapshots.some((doc) => containsSentinel(doc));
  const stepHas = surfaces.steps.some((doc) => containsSentinel(doc));
  const eventHas = surfaces.events.some((row) => containsSentinel(row.payload));
  const stepsApiHas = containsSentinel(stepsHttp.body);
  const historyHas = containsSentinel(history.body);
  const reportHas = containsSentinel(report.body);
  assert.equal(intentHas, true, 'grant stores type_text in action_intents');
  assert.equal(browser.lastSessionOptions.approvedAuthState, null);
  assert.equal(browser.lastSessionOptions.hasApprovedAuthState, false);
  evidence.cases.push({
    name: 'type_text-plaintext-and-session-options',
    passed: true,
    runId: run.id,
    sentinelIn: {
      action_intents_tool_call: intentHas,
      page_snapshots_fakebrowser_node_text: snapshotHas,
      steps_document: stepHas,
      run_events_payload: eventHas,
      GET_steps: stepsApiHas,
      GET_event_history: historyHas,
      GET_report: reportHas,
      model_requests_count: surfaces.models,
    },
    workerCreateSession: browser.lastSessionOptions,
    note: 'action_intents.tool_call 保存 type_text 原文。FakeBrowser 把同一原文写进 snapshot node.text。Step/SSE 文档本身没有该字段。Worker.createSession 未传 approvedAuthState。',
  });
}

function sourceInjection() {
  const session = readFileSync(
    new URL('../../packages/browser/src/session.ts', import.meta.url),
    'utf8',
  );
  const start = session.indexOf('if (options.approvedAuthState)');
  const block = session.slice(start, session.indexOf('// 3. Optional Trace', start));
  assert.notEqual(start, -1);
  assert.match(block, /\.goto\(originEntry\.origin/);
  assert.match(block, /\.catch\(\(\) => \{\}\)/);
  assert.equal(block.includes('allowedOrigins'), false);
  evidence.cases.push({
    name: 'approvedAuthState-origins-goto-catch',
    passed: true,
    gotoPresent: true,
    catchEmpty: true,
    injectionChecksAllowedOrigins: false,
    note: '源码事实。本轮没有启动 Playwright。Worker 当前也不传入 approvedAuthState。',
  });
}

async function cleanup() {
  const cleanupState = {};
  if (server) await new Promise((resolve) => server.close(resolve));
  await context?.db.close();
  await db?.close();
  if (containerId) {
    cleanupState.removeStatus = spawnSync('docker', [
      'rm',
      '--force',
      '--volumes',
      containerId,
    ]).status;
    const inspect = spawnSync('docker', ['inspect', containerId], {
      encoding: 'utf8',
    });
    cleanupState.containerAbsent =
      inspect.status !== 0 &&
      /no such (container|object)/i.test(inspect.stderr);
    cleanupState.volumesAbsent = (evidence.ownership.volumes ?? []).map((id) => {
      const check = spawnSync('docker', ['volume', 'inspect', id], {
        encoding: 'utf8',
      });
      return {
        id,
        absent: check.status !== 0 && /no such volume/i.test(check.stderr),
      };
    });
  }
  rmSync(dir, { recursive: true, force: true });
  cleanupState.secretDirectoryRemoved = true;
  evidence.cleanup = cleanupState;
  const path = new URL(
    `./T10-AUTH-2-counterexamples-${tag}.json`,
    import.meta.url,
  );
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({ evidence: path.pathname, cases: evidence.cases.length, P0Passed: false })}\n`);
  if (containerId) {
    assert.equal(cleanupState.removeStatus, 0);
    assert.equal(cleanupState.containerAbsent, true);
    assert.ok(cleanupState.volumesAbsent.every((item) => item.absent));
  }
}

try {
  await setup();
  sourceInjection();
  await exclusiveRunGap();
  await typeTextPersistence();
} catch (error) {
  evidence.failed = String(error && error.stack ? error.stack : error);
  throw error;
} finally {
  await cleanup();
}
