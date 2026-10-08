import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from '../../../packages/storage/node_modules/pg/lib/index.js';
import {
  Database,
  migrate,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
  hashPayload,
} from '@localqa/storage';
import { RuntimeClient, createWorkerModelOptions } from '@localqa/orchestrator';
import { createApiContext, createApiServer } from '../../api/dist/index.js';
import { Worker } from '../dist/index.js';
import { smokeCase, criteriaHash } from '@localqa/domain';

const tag = randomUUID().slice(0, 8),
  name = `localqa-b5-${tag}`,
  dir = mkdtempSync(join(tmpdir(), 'localqa-b5-'));
let db, context, server, actor, project, cookie, url;
async function switchProject(name) {
  const modelId = project.defaultModelProfileId;
  assert.ok(modelId);
  const repository = new ProjectRepository(db);
  project = await repository.create(actor, { name });
  project = await repository.update(actor, project.id, {
    expectedVersion: project.version,
    defaultModelProfileId: modelId,
  });
  return project;
}
function newContext() {
  assert.ok(connection && vault && actor);
  const artifactsDir = join(dir, 'store');
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
  return createApiContext({
    connectionString: connection,
    vault,
    artifactsDir,
    serviceActor: actor,
    publicOrigin: 'http://localhost',
  });
}
let connection, vault;
async function api(path, body, key) {
  const res = await fetch(`${url}/api/v1${path}`, {
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
before(async () => {
  const password = randomBytes(24).toString('hex');
  const env = join(dir, 'pg.env');
  writeFileSync(
    env,
    `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  const launch = spawnSync(
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
      'postgres:16-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(launch.status, 0, launch.stderr);
  const port = spawnSync('docker', ['port', name, '5432/tcp'], {
    encoding: 'utf8',
  })
    .stdout.trim()
    .split(':')
    .at(-1);
  connection = `postgres://localqa:${password}@127.0.0.1:${port}/localqa`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      await migrate(
        connection,
        new URL('../../../packages/storage/migrations/', import.meta.url),
      );
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready);
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
    email: `b5-${tag}@localqa.test`,
    displayName: 'B5',
    password: 'B5Password123456!',
  });
  actor = { userId: user.id };
  const projectActor = { userId: user.id };
  project = await new ProjectRepository(db).create(projectActor, {
    name: `FakeBrowser B5 ${tag}`,
  });
  const model = await new ModelRepository(db, vault).create(projectActor, {
    name: 'No model calls',
    endpoint: 'https://unused.example.test/v1',
    configuredModelId: 'unused',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
  });
  project = await new ProjectRepository(db).update(actor, project.id, {
    expectedVersion: 1,
    defaultModelProfileId: model.id,
  });
  context = newContext();
  server = createApiServer(context);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' ? addr.port : addr.split(':').at(-1)}`;
  const login = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'B5Password123456!' }),
  });
  const loginBody = await login.json().catch(() => null);
  if (login.status !== 200) {
    throw new Error(
      `Login failed ${login.status}: ${JSON.stringify(loginBody)}`,
    );
  }
  const setCookie = login.headers.get('set-cookie');
  cookie = setCookie?.split(';')[0] ?? '';
  assert.ok(cookie.length > 10, `login set-cookie missing: ${login.status}`);
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await context?.db.close();
  await db?.close();
  spawnSync('docker', ['rm', '--force', '--volumes', name]);
  rmSync(dir, { recursive: true, force: true });
});

class FakeBrowserPort {
  malformedObservation = false;
  responseStatus = 200;
  emptyText = false;
  denyCapture = false;
  contexts = [];
  events = [];
  async createSession(options) {
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
        title: 'FakeBrowser fixture',
        responseStatus: this.responseStatus,
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
    const session = {
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
        if (!['role', 'label', 'test_id', 'text', 'css'].includes(locator.by))
          throw new Error('bad locator');
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
        this.events.push({ runId: options.runId, contextId: state.id, call });
        if (call.name === 'navigate') state.url = call.args.url;
        if (call.name === 'type_text' || call.name === 'click') {
          assert.equal(call.args.target.pageId, pageId);
          assert.equal(call.args.target.snapshotId, state.snapshot.snapshotId);
          if (call.name === 'type_text') state.text = call.args.text;
          else state.text = this.emptyText ? '' : 'done';
        }
        let data;
        if (call.name === 'capture') {
          if (this.denyCapture)
            return {
              requestId: randomUUID(),
              actionId: null,
              status: 'denied',
              data: null,
              reasonCode: 'CAPTURE_UNAVAILABLE',
              evidenceRefs: [],
            };
          // Synthetic valid one-pixel PNG; this is not a real browser screenshot.
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
        } else data = this.malformedObservation ? {} : fresh();
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
    return session;
  }
  async close() {
    for (const state of this.contexts) state.closed = true;
  }
}
async function createRun(
  expected = 'done',
  budget,
  unused = false,
  kind = 'text_equals',
  module = false,
  authProfileId,
) {
  const doc = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: `case-${randomUUID()}`,
    name: 'B5 actual Worker.once FakeBrowser',
    variables: { TEXT: 'typed' },
    criteria: [
      {
        id: 'result',
        kind,
        description: 'Exact text after click',
        sourceKind: 'user_spec',
        sourceRef: 'owner',
        locator: { by: 'test_id', value: 'input' },
        expectedValue: expected,
      },
    ],
    steps: [
      { kind: 'navigate', url: 'http://localhost:8080/' },
      {
        kind: 'type_text',
        locator: { by: 'label', value: 'Input' },
        text: '{{vars.TEXT}}',
      },
      { kind: 'click', locator: { by: 'css', value: 'input' } },
      { kind: 'assert', criterionId: 'result' },
    ],
  };
  if (unused) doc.criteria.push({ ...doc.criteria[0], id: 'unused' });
  if (kind === 'ai') {
    doc.criteria[0].kind = 'text_equals';
    doc.steps = [
      {
        kind: 'ai_action',
        goal: 'Frozen bounded goal',
        criteriaIds: ['result'],
      },
      { kind: 'navigate', url: 'http://localhost:8080/' },
    ];
  }
  if (budget)
    doc.steps.unshift(
      ...Array.from({ length: 6 }, () => ({
        kind: 'navigate',
        url: 'http://localhost:8080/',
      })),
    );
  if (module) {
    const child = structuredClone(doc);
    child.id = `child-${randomUUID()}`;
    const name = `module-${randomUUID()}`;
    // Seed this owned fixture through the privileged test connection. The app
    // must create drafts and review them; the module API suite checks that path.
    const seedClient = new pg.Client({ connectionString: connection });
    await seedClient.connect();
    try {
      await seedClient.query(
        "INSERT INTO regression_module_versions(project_id,name,version,sha256,document,review_status) VALUES($1,$2,1,$3,$4,'approved')",
        [project.id, name, hashPayload(child), child],
      );
    } finally {
      await seedClient.end();
    }
    doc.steps = [
      { kind: 'module', ref: `${name}@1`, arguments: { TEXT: 'moduletyped' } },
      { kind: 'assert', criterionId: 'result' },
    ];
  }
  const saved = await api(`/projects/${project.id}/saved-cases`, {
    slug: `b5-${randomUUID()}`,
    name: doc.name,
    document: doc,
  });
  assert.equal(saved.status, 201, JSON.stringify(saved));
  const version = (await api(`/saved-cases/${saved.body.id}/versions`)).body
    .items[0];
  const input = {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'FakeBrowser regression fixture',
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
  const run = await api(
    '/regression-runs',
    {
      projectId: project.id,
      caseVersionIds: [version.id],
      ...(budget ? { budget } : {}),
      ...(authProfileId ? { authProfileId } : {}),
    },
    randomUUID(),
  );
  assert.equal(run.status, 202, JSON.stringify(run));
  return run.body;
}
async function retire(runId) {
  await db.actor(actor, async (client) => {
    await client.query(
      "UPDATE jobs SET status='cancelled' WHERE run_id=$1 AND status='queued'",
      [runId],
    );
    await client.query(
      "UPDATE runs SET status='cancelled',phase='finalize',termination_reason='user_cancel',version=version+1 WHERE id=$1",
      [runId],
    );
  });
}
function worker(browser, patch = {}) {
  const { fakeAssessment, modelOptions, ...workerPatch } = patch;
  const runtime = new RuntimeClient(
    context.coordinator,
    { projectId: project.id, workerId: `b5-${randomUUID()}` },
    context.artifacts,
    modelOptions ?? {},
  );
  // Every model call is forbidden in this technical-oracle fixture.
  if (fakeAssessment || !modelOptions)
    runtime.model =
      fakeAssessment ??
      (async () => {
        throw new Error('Unexpected model call');
      });
  return new Worker({
    runtime,
    browser,
    scratch: join(dir, 'scratch'),
    pollMs: 10,
    heartbeatMs: 1000,
    ...workerPatch,
  });
}
async function localOnlyModelOptions(reply) {
  const repository = new ModelRepository(db, vault);
  const key = `b5-fixture-${randomUUID()}`;
  const created = await repository.create(actor, {
    name: `Local injected model ${randomUUID()}`,
    endpoint: 'https://b5-fixture.invalid/v1',
    configuredModelId: 'b5-fixture-model',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
    apiKey: key,
  });
  // Explicit synthetic capability fixture, not a real provider probe.
  const frozen = await repository.recordProbe(
    actor,
    created.id,
    created.version,
    {
      status: 'ready',
      capabilities: {
        structuredOutput: true,
        nativeTools: false,
        imageInput: true,
      },
    },
  );
  project = await new ProjectRepository(db).update(actor, project.id, {
    expectedVersion: project.version,
    defaultModelProfileId: frozen.id,
  });
  let sends = 0;
  const options = createWorkerModelOptions({
    load: (id, version) =>
      repository.readVersion(actor, id, version, project.id),
    transport: async (url, init) => {
      assert.equal(new URL(url).hostname, 'b5-fixture.invalid');
      assert.equal(init.headers.authorization === `Bearer ${key}`, true);
      const body = JSON.parse(init.body);
      assert.equal(body.model, frozen.configuredModelId);
      sends++;
      const data = reply(body);
      return new Response(
        JSON.stringify({
          id: `b5-response-${randomUUID()}`,
          model: body.model,
          choices: [
            {
              message: { content: JSON.stringify(data) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  return { options, frozen, sends: () => sends };
}
function modelContext(body) {
  for (const message of body.messages) {
    if (message.role !== 'user') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
    try {
      const value = JSON.parse(text);
      if (value.goal || value.criterion) return value;
    } catch {
      /* Gateway may append separate, non-JSON frozen-criterion guidance. */
    }
  }
  throw new Error('Actual worker model request lost its frozen action context');
}
async function executeCase(run, browser, patch = {}) {
  const instance = worker(browser, patch);
  const signal = new AbortController().signal;
  assert.equal(await instance.once(signal), true);
  await context.coordinator.tick(project.id);
  assert.equal(await instance.once(signal), true);
  const attempts = await db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          "SELECT a.id FROM case_attempts a JOIN jobs j ON j.id=a.task_id WHERE a.run_id=$1 AND j.role='executor' AND j.status='succeeded' AND a.attempt_number=1 ORDER BY a.id DESC LIMIT 1",
          [run.id],
        )
      ).rows,
  );
  assert.equal(attempts.length, 1, 'executor attempt must succeed');
  const verdict = await db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          'SELECT v.document FROM verdicts v JOIN case_attempts a ON a.id=v.attempt_id WHERE a.run_id=$1',
          [run.id],
        )
      ).rows[0]?.document,
  );
  assert.ok(
    verdict,
    JSON.stringify({
      events: browser.events.map((e) => e.call.name),
      jobs: await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              'SELECT role,status,result FROM jobs WHERE run_id=$1',
              [run.id],
            )
          ).rows,
      ),
    }),
  );
  return { instance, verdict };
}

test('FakeBrowser: approved API -> real Worker.once -> budget/Step/verdict/report; two contexts, no explore or model', async () => {
  const browser = new FakeBrowserPort();
  for (let i = 0; i < 2; i++) {
    const run = await createRun();
    const { verdict } = await executeCase(run, browser);
    assert.equal(verdict.status, 'passed', JSON.stringify(verdict));
    const actions = browser.events
      .filter((event) => event.runId === run.id)
      .map((event) => event.call.name);
    assert.deepEqual(actions, [
      'navigate',
      'observe',
      'type_text',
      'observe',
      'click',
      'observe',
      'capture',
    ]);
    const rows = await db.actor(
      actor,
      async (client) =>
        (
          await client.query(
            'SELECT document FROM steps WHERE run_id=$1 ORDER BY seq',
            [run.id],
          )
        ).rows,
    );
    assert.ok(rows.every((row) => row.document.regressionSource));
    assert.equal(rows.at(-1).document.regressionSource.stepIndex, 3);
    const used = await db.actor(
      actor,
      async (client) =>
        (
          await client.query('SELECT used FROM run_budgets WHERE run_id=$1', [
            run.id,
          ])
        ).rows[0].used,
    );
    assert.equal(used.actions, actions.length);
    const linked = await db.actor(
      actor,
      async (client) =>
        (
          await client.query(
            "SELECT a.document artifact,p.document snapshot FROM artifacts a JOIN page_snapshots p ON p.id=(a.document->>'snapshotId')::uuid AND p.project_id=a.project_id AND p.run_id=a.run_id AND p.task_id=a.task_id WHERE a.run_id=$1",
            [run.id],
          )
        ).rows,
    );
    assert.equal(linked.length, 1);
    assert.equal(linked[0].artifact.snapshotId, linked[0].snapshot.snapshotId);
    assert.equal(linked[0].snapshot.nodes[0].text, 'done');
    assert.equal(
      verdict.criterionResults[0].evidenceRefs[0],
      linked[0].artifact.id,
    );
    const jobs = await db.actor(
      actor,
      async (client) =>
        (await client.query('SELECT role FROM jobs WHERE run_id=$1', [run.id]))
          .rows,
    );
    assert.ok(!jobs.some((job) => ['explorer', 'planner'].includes(job.role)));
    // Complete finalizer without starting a worker loop or browser process.
    await context.coordinator.tick(project.id);
    await worker(browser).once(new AbortController().signal);
    await context.coordinator.tick(project.id);
    const report = await api(`/runs/${run.id}/report`);
    assert.equal(report.status, 200, JSON.stringify(report));
    assert.equal(report.body.cases[0].verdict.status, 'passed');
    assert.ok(report.body.cases[0].definition.regression.sourceDocumentSha256);
  }
  assert.equal(browser.contexts.length, 2);
  assert.notEqual(browser.contexts[0].id, browser.contexts[1].id);
  assert.notEqual(browser.contexts[0].pageId, browser.contexts[1].pageId);
  assert.ok(browser.contexts.every((state) => state.closed));
});

test('FakeBrowser: intentionally failed assertion and unused criterion cannot pass', async () => {
  const browser = new FakeBrowserPort();
  const failed = await createRun('wrong');
  const { verdict } = await executeCase(failed, browser);
  assert.equal(verdict.status, 'issue_found', JSON.stringify(verdict));
  // Isolate negative scenarios: retire only this fixture run after recording its verdict.
  await retire(failed.id);
  const unused = await createRun('done', undefined, true);
  const second = await executeCase(unused, browser);
  assert.notEqual(second.verdict.status, 'passed');
  assert.ok(
    second.verdict.criterionResults.some(
      (result) => result.result === 'not_evaluated',
    ),
  );
  await retire(unused.id);
});

test('FakeBrowser: approved module source and arguments survive actual Worker.once and Step records', async () => {
  const browser = new FakeBrowserPort();
  const run = await createRun('done', undefined, false, 'text_equals', true);
  const { verdict } = await executeCase(run, browser);
  assert.equal(verdict.status, 'passed');
  assert.equal(
    browser.events.find((event) => event.call.name === 'type_text').call.args
      .text,
    'moduletyped',
  );
  const steps = await db.actor(actor, async (client) =>
    (
      await client.query(
        'SELECT document FROM steps WHERE run_id=$1 ORDER BY seq',
        [run.id],
      )
    ).rows.map((row) => row.document),
  );
  assert.equal(steps[0].regressionSource.modulePath.length, 1);
  assert.match(
    steps[0].regressionSource.modulePath[0].sha256,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(steps.at(-1).regressionSource.modulePath.length, 0);
  assert.equal(verdict.criterionResults.length, 2);
  await retire(run.id);
});

test('FakeBrowser/FakeAssessment: semantic observation and visual image message use assessment, never raw result', async () => {
  for (const kind of ['semantic', 'visual']) {
    const browser = new FakeBrowserPort();
    const run = await createRun('unused', undefined, false, kind);
    let calls = 0;
    const fakeAssessment = async (_proof, _role, payload, criterionId) => {
      calls++;
      const message = payload.messages.find(
        (message) => message.role === 'user',
      );
      const context = JSON.parse(
        message.content.find((part) => part.type === 'text').text,
      );
      assert.ok(context.observation.nodes.some((node) => node.text === 'done'));
      assert.equal(context.observation.redacted, true);
      if (kind === 'visual')
        assert.equal(
          message.content.find((part) => part.type === 'image').artifactId,
          context.ownedEvidence[0],
        );
      else assert.ok(!message.content.some((part) => part.type === 'image'));
      return {
        requestResult: 'ok',
        errorCode: null,
        data: { result: 'passed' },
        assessment:
          kind === 'semantic'
            ? {
                criterionId,
                criterionResult: 'failed',
                reasonCode: 'FAKE_ASSESSMENT_FAILURE',
                acceptedEvidenceRefs: context.ownedEvidence,
              }
            : null,
      };
    };
    const { verdict } = await executeCase(run, browser, { fakeAssessment });
    assert.equal(calls, 1);
    assert.notEqual(verdict.status, 'passed');
    assert.equal(
      verdict.criterionResults[0].result,
      kind === 'semantic' ? 'failed' : 'unknown',
    );
    await retire(run.id);
  }
  // Fresh project isolates semantic/AI/lease checks from prior terminal runs.
  await switchProject(`B5 model checks ${tag}`);
});

test('FakeBrowser: missing observation text or capture cannot produce a semantic pass or model call', async () => {
  for (const missing of ['text', 'capture']) {
    const browser = new FakeBrowserPort();
    browser.emptyText = missing === 'text';
    browser.denyCapture = missing === 'capture';
    const run = await createRun('unused', undefined, false, 'semantic');
    let calls = 0;
    const { verdict } = await executeCase(run, browser, {
      fakeAssessment: async () => {
        calls++;
        return {
          requestResult: 'ok',
          data: { result: 'passed' },
          assessment: null,
        };
      },
    });
    assert.equal(calls, 0);
    assert.notEqual(verdict.status, 'passed');
    await retire(run.id);
  }
});

test('FakeBrowser: default AI failure cannot skip into later fixed steps', async () => {
  const browser = new FakeBrowserPort();
  const run = await createRun('unused', undefined, false, 'ai');
  const { verdict } = await executeCase(run, browser, {
    fakeAssessment: async () => ({
      requestResult: 'inconclusive',
      data: { done: true, toolCalls: [] },
    }),
  });
  assert.notEqual(verdict.status, 'passed');
  assert.deepEqual(
    browser.events.map((event) => event.call.name),
    ['observe'],
  );
  const result = await db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          "SELECT result FROM jobs WHERE run_id=$1 AND role='executor'",
          [run.id],
        )
      ).rows[0].result,
  );
  assert.equal(result.regressionReplay.reasonCode, 'MODEL_FAILURE');
  await retire(run.id);
});

test('FakeBrowser/FakeDecision: default AI shares owned targets, action budget, source records and post-action criterion', async () => {
  const browser = new FakeBrowserPort();
  const run = await createRun('done', undefined, false, 'ai');
  let calls = 0;
  const { verdict } = await executeCase(run, browser, {
    fakeAssessment: async (_proof, role, payload) => {
      assert.equal(role, 'executor');
      assert.equal(payload.purpose, 'decide');
      const input = JSON.parse(
        payload.messages.find((message) => message.role === 'user').content[0]
          .text,
      );
      assert.equal(input.goal, 'Frozen bounded goal');
      assert.equal(input.criteria[0].expectedValue, 'done');
      const observation = input.observation;
      const node = observation.nodes[0];
      calls++;
      return {
        requestResult: 'ok',
        data:
          calls === 1
            ? {
                done: false,
                toolCalls: [
                  {
                    name: 'click',
                    args: {
                      target: {
                        snapshotId: observation.snapshotId,
                        pageId: observation.pageId,
                        nodeId: node.nodeId,
                        frameId: node.frameId,
                      },
                    },
                  },
                ],
              }
            : { done: true, toolCalls: [] },
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(verdict.status, 'passed', JSON.stringify(verdict));
  assert.deepEqual(
    browser.events.map((event) => event.call.name),
    ['observe', 'click', 'observe', 'observe', 'capture', 'navigate'],
  );
  const rows = await db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          'SELECT document FROM steps WHERE run_id=$1 ORDER BY seq',
          [run.id],
        )
      ).rows,
  );
  assert.deepEqual(
    rows.map((row) => row.document.regressionSource.stepIndex),
    [0, 0, 0, 0, 0, 1],
  );
  const used = await db.actor(
    actor,
    async (client) =>
      (
        await client.query('SELECT used FROM run_budgets WHERE run_id=$1', [
          run.id,
        ])
      ).rows[0].used,
  );
  assert.equal(used.actions, 6);
  assert.ok(browser.contexts.every((state) => state.closed));
  await retire(run.id);
});

test('FakeBrowser/FakeDecision: AI round cap stops replay and freezes remaining criterion as not evaluated', async () => {
  const browser = new FakeBrowserPort();
  const run = await createRun('done', undefined, false, 'ai');
  let calls = 0;
  const { verdict } = await executeCase(run, browser, {
    fakeAssessment: async () => {
      calls++;
      return {
        requestResult: 'ok',
        data: { done: false, toolCalls: [{ name: 'observe', args: {} }] },
      };
    },
  });
  assert.equal(calls, 4);
  assert.notEqual(verdict.status, 'passed');
  assert.deepEqual(
    browser.events.map((event) => event.call.name),
    Array(8).fill('observe'),
  );
  assert.equal(verdict.criterionResults[0].result, 'not_evaluated');
  const result = await db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          "SELECT result FROM jobs WHERE run_id=$1 AND role='executor'",
          [run.id],
        )
      ).rows[0].result,
  );
  assert.equal(result.regressionReplay.reasonCode, 'AI_STEP_LIMIT');
  await retire(run.id);
});

test('FakeBrowser/FakeDecision: malformed and unowned AI targets reach no browser action or later DSL step', async () => {
  for (const invalid of ['schema', 'ownership']) {
    const browser = new FakeBrowserPort();
    const run = await createRun('done', undefined, false, 'ai');
    const { verdict } = await executeCase(run, browser, {
      fakeAssessment: async () => ({
        requestResult: 'ok',
        data: {
          done: false,
          toolCalls:
            invalid === 'schema'
              ? [{ name: 'invented_tool', args: {} }]
              : [
                  {
                    name: 'click',
                    args: {
                      target: {
                        snapshotId: randomUUID(),
                        pageId: randomUUID(),
                        nodeId: 'testid_input',
                        frameId: 'main',
                      },
                    },
                  },
                ],
        },
      }),
    });
    assert.notEqual(verdict.status, 'passed');
    assert.deepEqual(
      browser.events.map((event) => event.call.name),
      ['observe'],
    );
    await retire(run.id);
  }
});

test('FakeBrowser/InjectedResponse: real RuntimeClient -> frozen BoundModel -> transport/ledger for AI and visual assessment', async () => {
  for (const mode of ['ai', 'visual', 'empty-visual']) {
    const local = await localOnlyModelOptions((body) => {
      const input = modelContext(body);
      if (mode === 'ai') {
        const snapshot = input.observation;
        const node = snapshot.nodes[0];
        return node.text === 'done'
          ? { done: true, toolCalls: [] }
          : {
              done: false,
              toolCalls: [
                {
                  name: 'click',
                  args: {
                    target: {
                      snapshotId: snapshot.snapshotId,
                      pageId: snapshot.pageId,
                      nodeId: node.nodeId,
                      frameId: node.frameId,
                    },
                  },
                },
              ],
            };
      }
      assert.ok(
        body.messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                part.type === 'image_url' &&
                part.image_url.url.startsWith('data:image/png;base64,'),
            ),
        ),
      );
      return {
        criterionId: input.criterion.id,
        result: 'passed',
        reason: 'Injected local claim',
        evidenceRefs: mode === 'empty-visual' ? [] : input.ownedEvidence,
      };
    });
    const browser = new FakeBrowserPort();
    const run = await createRun(
      'done',
      undefined,
      false,
      mode === 'ai' ? 'ai' : 'visual',
    );
    assert.equal(
      run.effectiveConfig.models.executor.version,
      local.frozen.version,
    );
    assert.equal(
      run.effectiveConfig.models.assertion.profileId,
      local.frozen.id,
    );
    const { verdict } = await executeCase(run, browser, {
      modelOptions: local.options,
    });
    assert.equal(local.sends(), mode === 'ai' ? 2 : 1);
    assert.equal(
      verdict.status === 'passed',
      mode !== 'empty-visual',
      JSON.stringify(verdict),
    );
    const ledger = await db.actor(
      actor,
      async (client) =>
        (
          await client.query(
            'SELECT status,redacted_diagnostic FROM model_requests WHERE run_id=$1',
            [run.id],
          )
        ).rows,
    );
    assert.equal(ledger.length, local.sends());
    assert.ok(
      ledger.every(
        (row) =>
          row.status === 'settled' &&
          row.redacted_diagnostic.profileId === local.frozen.id &&
          row.redacted_diagnostic.profileVersion === local.frozen.version,
      ),
    );
    const used = await db.actor(
      actor,
      async (client) =>
        (
          await client.query('SELECT used FROM run_budgets WHERE run_id=$1', [
            run.id,
          ])
        ).rows[0].used,
    );
    assert.equal(used.modelCalls, local.sends());
    assert.equal(used.totalTokens, local.sends() * 15);
    assert.ok(browser.contexts.every((state) => state.closed));
    await retire(run.id);
  }
});

test('FakeBrowser/InjectedResponse: exhausted model budget denies the default AI before provider or action', async () => {
  const local = await localOnlyModelOptions(() => {
    throw new Error('Exhausted budget must not send');
  });
  const browser = new FakeBrowserPort();
  const run = await createRun('done', undefined, false, 'ai');
  await db.actor(actor, (client) =>
    client.query(
      "UPDATE run_budgets SET used=jsonb_set(used,'{modelCalls}',limits->'maxModelCalls') WHERE run_id=$1",
      [run.id],
    ),
  );
  const instance = worker(browser, { modelOptions: local.options });
  await instance.once(new AbortController().signal);
  await context.coordinator.tick(project.id);
  await instance.once(new AbortController().signal);
  assert.equal(local.sends(), 0);
  assert.deepEqual(
    browser.events.map((event) => event.call.name),
    ['observe'],
  );
  const rows = await db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          'SELECT status FROM model_requests WHERE run_id=$1',
          [run.id],
        )
      ).rows,
  );
  assert.equal(rows.length, 0);
  assert.ok(browser.contexts.every((state) => state.closed));
  await retire(run.id);
});

test('FakeBrowser: stored smoke -> saved draft -> approval -> regression preserves the original smoke oracle', async () => {
  // Synthetic stored source definition; no prior real smoke/browser execution claimed.
  const source = await api(
    '/runs',
    { projectId: project.id, targetUrl: 'http://localhost:8080/' },
    randomUUID(),
  );
  assert.equal(source.status, 202);
  const definition = smokeCase(source.body, 'http://localhost:8080/');
  await db.actor(actor, (client) =>
    client.query(
      'INSERT INTO run_cases(id,project_id,run_id,document,criteria_hash) VALUES($1,$2,$3,$4,$5)',
      [
        definition.id,
        project.id,
        source.body.id,
        definition,
        criteriaHash(definition),
      ],
    ),
  );
  await retire(source.body.id);
  const saved = await api(`/projects/${project.id}/saved-cases`, {
    slug: `saved-smoke-${randomUUID()}`,
    name: 'Original smoke criteria',
    sourceRunCaseId: definition.id,
  });
  assert.equal(saved.status, 201);
  const version = (await api(`/saved-cases/${saved.body.id}/versions`)).body
    .items[0];
  assert.deepEqual(version.document.criteria, definition.criteria);
  const review = {
    expectedVersion: version.version,
    decision: 'approve',
    reason: 'Controlled stored-source regression',
  };
  const preview = await api(
    `/saved-case-versions/${version.id}/review-preview`,
    review,
  );
  assert.equal(preview.status, 200);
  assert.equal(
    (
      await api(`/saved-case-versions/${version.id}/review`, {
        ...review,
        confirmationToken: preview.body.confirmationToken,
      })
    ).status,
    200,
  );
  for (const status of [200, 503]) {
    const created = await api(
      '/regression-runs',
      { projectId: project.id, caseVersionIds: [version.id] },
      randomUUID(),
    );
    assert.equal(created.status, 202);
    const browser = new FakeBrowserPort();
    browser.responseStatus = status;
    const { verdict } = await executeCase(created.body, browser);
    assert.equal(
      verdict.status === 'passed',
      status === 200,
      JSON.stringify(verdict),
    );
    if (status === 503)
      assert.ok(
        verdict.criterionResults.every(
          (criterion) => criterion.result === 'not_evaluated',
        ),
      );
    assert.ok(browser.contexts.every((state) => state.closed));
    await retire(created.body.id);
  }
  const stored = await db.actor(
    actor,
    async (client) =>
      (
        await client.query('SELECT document FROM run_cases WHERE id=$1', [
          definition.id,
        ])
      ).rows[0].document,
  );
  assert.deepEqual(stored, definition);
});

test('FakeBrowser: malformed successful browser data closes the Step and reservation as unknown', async () => {
  const browser = new FakeBrowserPort();
  browser.malformedObservation = true;
  const run = await createRun();
  const { verdict } = await executeCase(run, browser);
  assert.notEqual(verdict.status, 'passed');
  assert.deepEqual(
    browser.events.map((event) => event.call.name),
    ['navigate'],
  );
  const facts = await db.actor(actor, async (client) => {
    const intent = (
      await client.query('SELECT outcome FROM action_intents WHERE run_id=$1', [
        run.id,
      ])
    ).rows[0];
    const step = (
      await client.query('SELECT document FROM steps WHERE run_id=$1', [run.id])
    ).rows[0].document;
    const reservation = (
      await client.query(
        "SELECT status,charged FROM budget_reservations WHERE run_id=$1 AND kind='action'",
        [run.id],
      )
    ).rows[0];
    const used = (
      await client.query('SELECT used FROM run_budgets WHERE run_id=$1', [
        run.id,
      ])
    ).rows[0].used;
    return { intent, step, reservation, used };
  });
  assert.equal(facts.intent.outcome, 'unknown');
  assert.equal(facts.step.status, 'unknown');
  assert.ok(facts.step.finishedAt);
  assert.equal(facts.reservation.status, 'unknown');
  assert.equal(facts.reservation.charged.actions, 1);
  assert.equal(facts.used.actions, 1);
  assert.ok(browser.contexts.every((state) => state.closed));
  await retire(run.id);
});

test('FakeBrowser: direct grant rejects old, unowned and forged targets/sources before reserving or executing', async () => {
  const browser = new FakeBrowserPort();
  const run = await createRun();
  const instance = worker(browser);
  const signal = new AbortController().signal;
  await instance.once(signal);
  await context.coordinator.tick(project.id);
  const lease = await instance.runtime.claim();
  const proof = {
    taskId: lease.task.id,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    contextVersion: lease.contextVersion,
  };
  const work = await instance.runtime.work(proof);
  const session = await browser.createSession({
    sessionId: work.contextId,
    taskId: lease.task.id,
    projectId: project.id,
    runId: run.id,
    artifactsDir: join(dir, 'direct'),
    allowedOrigins: run.effectiveConfig.allowedOrigins,
  });
  const navigation = {
    name: 'navigate',
    args: { url: 'http://localhost:8080/' },
  };
  const first = await instance.runtime.grant(
    proof,
    navigation,
    work.regressionPlan.steps[0].source,
  );
  const one = await session.executeTool(navigation, { signal });
  await instance.runtime.record(proof, first, 'succeeded', one.data);
  const forgedGrant = structuredClone(first);
  forgedGrant.step.regressionSource.documentId = 'forged';
  await assert.rejects(
    () => instance.runtime.record(proof, forgedGrant, 'succeeded', one.data),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  const observe = { name: 'observe', args: { pageId: session.activePageId } };
  const second = await instance.runtime.grant(
    proof,
    observe,
    work.regressionPlan.steps[1].source,
  );
  const two = await session.executeTool(observe, { signal });
  await instance.runtime.record(proof, second, 'succeeded', two.data);
  const source = work.regressionPlan.steps[1].source;
  const call = {
    name: 'type_text',
    args: {
      target: {
        snapshotId: one.data.snapshotId,
        pageId: session.activePageId,
        nodeId: 'testid_input',
        frameId: 'main',
      },
      text: 'typed',
    },
  };
  await assert.rejects(
    () => instance.runtime.grant(proof, call, source),
    (error) => error.code === 'VERSION_CONFLICT',
  );
  await assert.rejects(
    () =>
      instance.runtime.grant(
        proof,
        {
          ...call,
          args: {
            ...call.args,
            target: { ...call.args.target, snapshotId: randomUUID() },
          },
        },
        source,
      ),
    (error) => error.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () =>
      instance.runtime.grant(
        proof,
        {
          ...call,
          args: {
            ...call.args,
            target: {
              ...call.args.target,
              snapshotId: two.data.snapshotId,
              pageId: randomUUID(),
            },
          },
        },
        source,
      ),
    (error) => error.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () =>
      instance.runtime.grant(proof, call, { ...source, documentId: 'forged' }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    () => instance.runtime.grant(proof, call),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  const intents = await db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          'SELECT count(*)::integer n FROM action_intents WHERE task_id=$1',
          [lease.task.id],
        )
      ).rows[0].n,
  );
  assert.equal(intents, 2);
  assert.equal(browser.events.length, 2);
  const pending = await instance.runtime.grant(
    proof,
    navigation,
    work.regressionPlan.steps[0].source,
  );
  await instance.runtime.stop(proof, 'worker_failure');
  const stopped = await db.actor(
    actor,
    async (client) =>
      (
        await client.query('SELECT document FROM steps WHERE id=$1', [
          pending.step.id,
        ])
      ).rows[0].document,
  );
  assert.equal(stopped.status, 'unknown');
  assert.ok(stopped.finishedAt);
  await session.close();
  await retire(run.id);
});

test('FakeBrowser: shared action budget refusal stops tool execution; cancellation and stale proof have no next action', async () => {
  const browser = new FakeBrowserPort();
  const limited = await createRun('done', {
    maxActions: 10,
    maxActionsPerCase: 20,
  });
  const { verdict } = await executeCase(limited, browser);
  assert.notEqual(verdict.status, 'passed');
  assert.equal(
    browser.events.filter((event) => event.runId === limited.id).length,
    10,
  );
  await retire(limited.id);
  const cancelled = await createRun();
  const instance = worker(browser);
  await instance.once(new AbortController().signal);
  await context.coordinator.tick(project.id);
  const controller = new AbortController();
  const cancelling = worker(browser, {
    onActionIntent: async () => controller.abort(),
  });
  await cancelling.once(controller.signal);
  assert.equal(
    browser.events.filter((event) => event.runId === cancelled.id).length,
    0,
  );
  await retire(cancelled.id);
  const stale = await createRun();
  const staleWorker = worker(browser);
  await staleWorker.once(new AbortController().signal);
  await context.coordinator.tick(project.id);
  const original = staleWorker.runtime.grant.bind(staleWorker.runtime);
  staleWorker.runtime.grant = (proof, call, source) =>
    original({ ...proof, fencingToken: proof.fencingToken + 1 }, call, source);
  await staleWorker.once(new AbortController().signal);
  assert.equal(
    browser.events.filter((event) => event.runId === stale.id).length,
    0,
  );
});

test('FakeBrowser/NoneAuth: bound approved none completes Worker.once after the profile head changes', async () => {
  await switchProject(`None auth replay ${randomUUID()}`);
  const created = await api(`/projects/${project.id}/auth-profiles`, {
    name: 'Owned none profile',
    mode: 'none',
    allowedOrigins: ['http://localhost:8080'],
    sharingPolicy: 'shared_state',
  });
  assert.equal(created.status, 201);
  const profile = created.body;
  const run = await createRun(
    'done',
    undefined,
    false,
    'text_equals',
    false,
    profile.id,
  );
  assert.equal(run.effectiveConfig.authProfileVersion, 1);
  const bound = await db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          'SELECT auth_profile_id,auth_profile_version FROM runs WHERE project_id=$1 AND id=$2',
          [project.id, run.id],
        )
      ).rows[0],
  );
  assert.equal(bound.auth_profile_id, profile.id);
  assert.equal(bound.auth_profile_version, 1);
  await context.configRepo.updateAuthProfile(actor, project.id, profile.id, {
    expectedVersion: 1,
    name: 'Changed head, same frozen run',
  });
  const browser = new FakeBrowserPort();
  const { verdict } = await executeCase(run, browser);
  assert.equal(verdict.status, 'passed');
  assert.equal(browser.contexts.length, 1);
  assert.equal(browser.contexts[0].closed, true);
  const state = await db.actor(actor, async (client) => {
    const inputs = await client.query(
      'SELECT id FROM input_requests WHERE project_id=$1 AND run_id=$2',
      [project.id, run.id],
    );
    const models = await client.query(
      'SELECT request_id FROM model_requests WHERE project_id=$1 AND run_id=$2',
      [project.id, run.id],
    );
    return { inputs: inputs.rowCount, models: models.rowCount };
  });
  assert.deepEqual(state, { inputs: 0, models: 0 });
  await retire(run.id);
});

test('FakeBrowser/NoneAuth: revocation before preflight creates no browser or action intent', async () => {
  await switchProject(`Revoked none replay ${randomUUID()}`);
  const created = await api(`/projects/${project.id}/auth-profiles`, {
    name: 'Owned revocation profile',
    mode: 'none',
    allowedOrigins: ['http://localhost:8080'],
    sharingPolicy: 'shared_state',
  });
  assert.equal(created.status, 201);
  const profile = created.body;
  const run = await createRun(
    'done',
    undefined,
    false,
    'text_equals',
    false,
    profile.id,
  );
  await context.configRepo.updateAuthProfile(actor, project.id, profile.id, {
    expectedVersion: 1,
    revoke: true,
  });
  const browser = new FakeBrowserPort();
  await worker(browser).once(new AbortController().signal);
  assert.equal(browser.contexts.length, 0);
  assert.equal(browser.events.length, 0);
  const intents = await db.actor(
    actor,
    async (client) =>
      (
        await client.query(
          'SELECT id FROM action_intents WHERE project_id=$1 AND run_id=$2',
          [project.id, run.id],
        )
      ).rowCount,
  );
  assert.equal(intents, 0);
  await context.coordinator.cancel(actor, project.id, run.id);
  await context.coordinator.tick(project.id);
});
