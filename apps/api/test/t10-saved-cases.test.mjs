import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseContract } from '@localqa/contracts';
import {
  Database,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
  migrate,
  hashToken,
  hashPayload,
  newToken,
} from '../../../packages/storage/dist/index.js';
import { createApiContext, createApiServer } from '../../api/dist/index.js';
import {
  smokeCase,
  criteriaHash,
} from '../../../packages/domain/dist/index.js';

const tag = randomUUID().slice(0, 8);
const pgContainer = `localqa-t10-pg-${tag}`;
const dir = mkdtempSync(join(tmpdir(), 'localqa-t10-'));
const envFile = join(dir, 'pg.env');
const kekFile = join(dir, 'kek.json');
const pgPassword = randomBytes(24).toString('hex');

writeFileSync(
  envFile,
  `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${pgPassword}\n`,
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

let db,
  vault,
  apiContext,
  apiServer,
  baseUrl,
  adminCookie,
  operatorCookie,
  viewerCookie,
  otherOwnerCookie;
let adminUser,
  operatorUser,
  viewerUser,
  otherOwnerUser,
  project,
  model,
  runId,
  sourceCase;
const facts = { task: 'T10', tests: [], passed: 0, failed: 0 };

function record(name, ok, details = {}) {
  facts.tests.push({ name, ok, details });
  if (ok) facts.passed++;
  else facts.failed++;
}

async function api(method, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body && !headers['Content-Type'])
    headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = res.headers.get('content-type')?.includes('application/json')
    ? await res.json().catch(() => null)
    : null;
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  const sock = net.createServer();
  await new Promise((r) => sock.listen(0, '127.0.0.1', r));
  const port = sock.address().port;
  await new Promise((r) => sock.close(r));
  const runRes = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      pgContainer,
      '-p',
      `127.0.0.1:${port}:5432`,
      '--env-file',
      envFile,
      'postgres:18-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(runRes.status, 0, runRes.stderr);
  const pgConnection = `postgresql://localqa:${pgPassword}@127.0.0.1:${port}/localqa`;
  for (let i = 0; i < 60; i++) {
    try {
      await migrate(
        pgConnection,
        new URL('../../../packages/storage/migrations/', import.meta.url),
      );
      break;
    } catch {
      await delay(250);
    }
  }
  vault = await SecretVault.fromProtectedFile(kekFile);
  db = new Database(pgConnection);
  adminUser = await new AccountsRepository(db).bootstrap({
    email: 'admin@t10.localqa',
    displayName: 'Admin',
    password: 'AdminSuperPassword123!',
  });
  const accounts = new AccountsRepository(db);
  operatorUser = await accounts.create(
    { userId: adminUser.id },
    {
      email: 'op@t10.localqa',
      displayName: 'Op',
      password: 'OperatorPass123!',
      globalRole: 'member',
    },
  );
  viewerUser = await accounts.create(
    { userId: adminUser.id },
    {
      email: 'view@t10.localqa',
      displayName: 'View',
      password: 'ViewerPass123!',
      globalRole: 'member',
    },
  );
  otherOwnerUser = await accounts.create(
    { userId: adminUser.id },
    {
      email: 'owner2@t10.localqa',
      displayName: 'Owner 2',
      password: 'OwnerTwoPass123!',
      globalRole: 'member',
    },
  );
  project = await new ProjectRepository(db).create(
    { userId: adminUser.id },
    { name: 'T10 project' },
  );
  model = await new ModelRepository(db, vault).create(
    { userId: adminUser.id },
    {
      name: 'T10 stub',
      endpoint: 'https://stub.example.test/v1',
      configuredModelId: 'stub-normal',
      adapter: 'openai_compatible',
      dataBoundary: 'internal',
    },
  );
  await new ProjectRepository(db).update({ userId: adminUser.id }, project.id, {
    expectedVersion: project.version,
    defaultModelProfileId: model.id,
  });
  await new ProjectRepository(db).replaceMembers(
    { userId: adminUser.id },
    project.id,
    {
      expectedVersion: 2,
      members: [
        { userId: adminUser.id, role: 'owner' },
        { userId: operatorUser.id, role: 'operator' },
        { userId: viewerUser.id, role: 'viewer' },
        { userId: otherOwnerUser.id, role: 'owner' },
      ],
    },
  );
  const artifactsDir = join(dir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
  apiContext = createApiContext({
    connectionString: pgConnection,
    vault,
    artifactsDir,
    serviceActor: { userId: adminUser.id },
    publicOrigin: 'http://localhost',
  });
  apiServer = createApiServer(apiContext);
  await new Promise((resolve) =>
    apiServer.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${apiServer.address().port}`;
      resolve();
    }),
  );
  const login = await api('POST', '/api/v1/auth/login', {
    body: { email: 'admin@t10.localqa', password: 'AdminSuperPassword123!' },
  });
  adminCookie = login.headers.get('set-cookie').split(';')[0];
  const opLogin = await api('POST', '/api/v1/auth/login', {
    body: { email: 'op@t10.localqa', password: 'OperatorPass123!' },
  });
  operatorCookie = opLogin.headers.get('set-cookie').split(';')[0];
  const viewLogin = await api('POST', '/api/v1/auth/login', {
    body: { email: 'view@t10.localqa', password: 'ViewerPass123!' },
  });
  viewerCookie = viewLogin.headers.get('set-cookie').split(';')[0];
  const ownerLogin = await api('POST', '/api/v1/auth/login', {
    body: { email: 'owner2@t10.localqa', password: 'OwnerTwoPass123!' },
  });
  otherOwnerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
  // create a run to source a smoke case from; cases appear as the run advances
  // Source the smoke case directly from the run's trusted input rather than
  // waiting for the workflow to materialize cases (that path depends on the
  // full worker/orchestrator loop, which is out of scope for T10 unit tests).
  const sourceRun = await api('POST', '/api/v1/runs', {
    cookie: adminCookie,
    headers: { 'Idempotency-Key': randomUUID() },
    body: { projectId: project.id, targetUrl: 'http://localhost:8080/' },
  });
  assert.equal(sourceRun.status, 202, JSON.stringify(sourceRun.json));
  runId = sourceRun.json.id;
  sourceCase = smokeCase(sourceRun.json, 'http://localhost:8080/', 0);
  await db.actor({ userId: adminUser.id }, (client) =>
    client.query(
      'INSERT INTO run_cases(id,project_id,run_id,document,criteria_hash) VALUES($1,$2,$3,$4,$5)',
      [sourceCase.id, project.id, runId, sourceCase, criteriaHash(sourceCase)],
    ),
  );
});

after(async () => {
  if (apiServer) await new Promise((r) => apiServer.close(r));
  if (apiContext?.db) await apiContext.db.close().catch(() => {});
  if (db) await db.close().catch(() => {});
  spawnSync('docker', ['rm', '--force', '--volumes', pgContainer]);
  rmSync(dir, { recursive: true, force: true });
});

test('save document, review, approve, create queued regression run', async () => {
  const regressionDoc = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: 'smoke-home',
    name: 'Smoke home',
    variables: {},
    criteria: sourceCase.criteria,
    steps: [
      { kind: 'navigate', url: 'http://localhost:8080/' },
      ...sourceCase.criteria.map((c) => ({
        kind: 'assert',
        criterionId: c.id,
      })),
    ],
  };
  const create = await api(
    'POST',
    `/api/v1/projects/${project.id}/saved-cases`,
    {
      cookie: adminCookie,
      body: { slug: 'smoke-home', name: 'Smoke home', document: regressionDoc },
    },
  );
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const saved = parseContract('SavedCase', create.json);
  record('save_from_smoke', true);

  const versions = await api(
    'GET',
    `/api/v1/saved-cases/${saved.id}/versions`,
    { cookie: adminCookie },
  );
  assert.equal(versions.status, 200);
  const v1 = parseContract('SavedCaseVersion', versions.json.items[0]);
  assert.equal(v1.reviewStatus, 'draft');
  record('list_versions', true);

  const preview = await api(
    'POST',
    `/api/v1/saved-case-versions/${v1.id}/review-preview`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: v1.version,
        decision: 'approve',
        reason: 'verified smoke criteria',
      },
    },
  );
  assert.equal(
    preview.status,
    200,
    JSON.stringify({ status: preview.status, json: preview.json }),
  );
  const commit = await api(
    'POST',
    `/api/v1/saved-case-versions/${v1.id}/review`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: v1.version,
        decision: 'approve',
        reason: 'verified smoke criteria',
        confirmationToken: preview.json.confirmationToken,
      },
    },
  );
  assert.equal(commit.status, 200, JSON.stringify(commit.json));
  assert.equal(commit.json.reviewStatus, 'approved');
  record('review_approve', true);

  const regression = await api('POST', '/api/v1/regression-runs', {
    cookie: adminCookie,
    headers: { 'Idempotency-Key': randomUUID() },
    body: { projectId: project.id, caseVersionIds: [v1.id] },
  });
  assert.equal(regression.status, 202, JSON.stringify(regression.json));
  assert.equal(regression.json.status, 'queued');
  record('regression_run', true);
});

test('valid baseline; isolated unknown field, step, variable and unresolved module rejection', async () => {
  const badDoc = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: 'x',
    name: 'x',
    criteria: [
      {
        id: 'c1',
        kind: 'element_visible',
        description: 'd',
        sourceKind: 'generic_smoke',
        sourceRef: 'r',
        locator: { by: 'css', value: 'body' },
      },
    ],
    steps: [{ kind: 'navigate', url: 'http://localhost:8080/' }],
    extraField: true,
  };
  const baseline = { ...badDoc };
  delete baseline.extraField;
  const valid = await api(
    'POST',
    `/api/v1/projects/${project.id}/saved-cases`,
    {
      cookie: adminCookie,
      body: {
        slug: 'validation-baseline',
        name: 'Valid baseline',
        document: baseline,
      },
    },
  );
  assert.equal(valid.status, 201, JSON.stringify(valid.json));
  const bad = await api('POST', `/api/v1/projects/${project.id}/saved-cases`, {
    cookie: adminCookie,
    body: { slug: 'bad1', name: 'bad', document: badDoc },
  });
  assert.equal(bad.status, 422);
  record('reject_unknown_field', true);

  const badStepDoc = {
    ...baseline,
    steps: [{ kind: 'teleport', url: 'http://localhost:8080/' }],
  };
  delete badStepDoc.extraField;
  const badStep = await api(
    'POST',
    `/api/v1/projects/${project.id}/saved-cases`,
    {
      cookie: adminCookie,
      body: { slug: 'bad2', name: 'bad', document: badStepDoc },
    },
  );
  assert.equal(badStep.status, 422);
  record('reject_unknown_step', true);

  const badVarDoc = {
    ...baseline,
    steps: [{ kind: 'navigate', url: 'http://localhost:8080/{{shell.id}}' }],
  };
  delete badVarDoc.extraField;
  const badVar = await api(
    'POST',
    `/api/v1/projects/${project.id}/saved-cases`,
    {
      cookie: adminCookie,
      body: { slug: 'bad3', name: 'bad', document: badVarDoc },
    },
  );
  assert.equal(badVar.status, 422);
  record('reject_illegal_variable', true);

  const unresolvedDoc = {
    ...baseline,
    steps: [{ kind: 'module', ref: 'unregistered@1' }],
  };
  const unresolved = await api(
    'POST',
    `/api/v1/projects/${project.id}/saved-cases`,
    {
      cookie: adminCookie,
      body: { slug: 'bad4', name: 'bad', document: unresolvedDoc },
    },
  );
  assert.equal(unresolved.status, 422);
  record('reject_unresolved_module', true, {
    limitation:
      'Registry/expansion absent; sibling reuse and true graph cycles not verified',
  });
});

test('version immutability: new draft does not overwrite approved', async () => {
  const create = await api(
    'POST',
    `/api/v1/projects/${project.id}/saved-cases`,
    {
      cookie: adminCookie,
      body: {
        slug: 'immutable-test',
        name: 'Immutable',
        document: {
          schemaVersion: 1,
          kind: 'localqa/test',
          id: 'immutable-test',
          name: 'Immutable',
          criteria: [
            {
              id: 'c1',
              kind: 'element_visible',
              description: 'd',
              sourceKind: 'generic_smoke',
              sourceRef: 'r',
              locator: { by: 'css', value: 'body' },
            },
          ],
          steps: [{ kind: 'navigate', url: 'http://localhost:8080/' }],
        },
      },
    },
  );
  assert.equal(create.status, 201);
  const saved = create.json;
  const versions1 = await api(
    'GET',
    `/api/v1/saved-cases/${saved.id}/versions`,
    { cookie: adminCookie },
  );
  const v1 = versions1.json.items[0];
  const preview = await api(
    'POST',
    `/api/v1/saved-case-versions/${v1.id}/review-preview`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: v1.version,
        decision: 'approve',
        reason: 'approved by owner',
      },
    },
  );
  assert.equal(
    preview.status,
    200,
    JSON.stringify({ status: preview.status, json: preview.json }),
  );
  const commit = await api(
    'POST',
    `/api/v1/saved-case-versions/${v1.id}/review`,
    {
      cookie: adminCookie,
      body: {
        expectedVersion: v1.version,
        decision: 'approve',
        reason: 'approved by owner',
        confirmationToken: preview.json.confirmationToken,
      },
    },
  );
  assert.equal(
    commit.status,
    200,
    JSON.stringify({
      status: commit.status,
      json: commit.json,
      preview: preview.json,
    }),
  );
  assert.equal(commit.json.reviewStatus, 'approved');
  // create a new draft
  const current = (
    await api('GET', `/api/v1/projects/${project.id}/saved-cases`, {
      cookie: adminCookie,
    })
  ).json.items.find((c) => c.id === saved.id);
  const v2Res = await api('POST', `/api/v1/saved-cases/${saved.id}/versions`, {
    cookie: adminCookie,
    body: {
      expectedVersion: current.version,
      document: { ...v1.document, name: 'Immutable v2' },
    },
  });
  assert.equal(v2Res.status, 201);
  assert.equal(v2Res.json.reviewStatus, 'draft');
  const versions2 = await api(
    'GET',
    `/api/v1/saved-cases/${saved.id}/versions`,
    { cookie: adminCookie },
  );
  assert.equal(versions2.json.items.length, 2);
  assert.equal(versions2.json.items[0].reviewStatus, 'approved');
  assert.equal(versions2.json.items[1].reviewStatus, 'draft');
  record('version_immutable', true);
});

function validDocument(slug) {
  return {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: slug,
    name: slug,
    variables: {},
    criteria: [
      {
        id: 'visible',
        kind: 'element_visible',
        description: 'Body is visible',
        sourceKind: 'generic_smoke',
        sourceRef: 'controlled-fixture',
        locator: { by: 'css', value: 'body' },
      },
    ],
    steps: [
      { kind: 'navigate', url: 'http://localhost:8080/' },
      { kind: 'assert', criterionId: 'visible' },
    ],
  };
}

async function createDraft(label) {
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await api(
    'POST',
    `/api/v1/projects/${project.id}/saved-cases`,
    {
      cookie: adminCookie,
      body: { slug, name: label, document: validDocument(slug) },
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const listed = await api(
    'GET',
    `/api/v1/saved-cases/${created.json.id}/versions`,
    { cookie: adminCookie },
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.json));
  assert.deepEqual(listed.json.items[0].document, validDocument(slug));
  assert.equal(listed.json.items[0].sha256, hashPayload(validDocument(slug)));
  assert.equal(
    listed.json.items[0].sha256,
    hashPayload(listed.json.items[0].document),
  );
  return { saved: created.json, version: listed.json.items[0] };
}

async function getPreview(version, input, cookie = adminCookie) {
  const preview = await api(
    'POST',
    `/api/v1/saved-case-versions/${version.id}/review-preview`,
    { cookie, body: input },
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.expectedVersion, input.expectedVersion);
  assert.equal(preview.json.decision, input.decision);
  assert.equal(preview.json.reason, input.reason);
  return preview.json;
}

async function approvedDraft(label) {
  const draft = await createDraft(label);
  const input = {
    expectedVersion: draft.version.version,
    decision: 'approve',
    reason: 'controlled regression fixture',
  };
  const preview = await getPreview(draft.version, input);
  const approved = await api(
    'POST',
    `/api/v1/saved-case-versions/${draft.version.id}/review`,
    {
      cookie: adminCookie,
      body: { ...input, confirmationToken: preview.confirmationToken },
    },
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  return { ...draft, version: approved.json };
}

test('multiple approved versions create cases in one run in requested order', async () => {
  const a = await approvedDraft('multi-a');
  const b = await approvedDraft('multi-b');
  const created = await api('POST', '/api/v1/regression-runs', {
    cookie: adminCookie,
    headers: { 'Idempotency-Key': randomUUID() },
    body: {
      projectId: project.id,
      caseVersionIds: [b.version.id, a.version.id],
    },
  });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  const cases = await api('GET', `/api/v1/runs/${created.json.id}/cases`, {
    cookie: adminCookie,
  });
  assert.equal(cases.status, 200, JSON.stringify(cases.json));
  assert.equal(cases.json.items.length, 2);
  assert.deepEqual(
    cases.json.items.map((item) => item.definition.title).sort(),
    [b.version.document.name, a.version.document.name].sort(),
  );
  assert.ok(
    cases.json.items.every((item) => item.definition.runId === created.json.id),
  );
  const events = await db.actor({ userId: adminUser.id }, (client) =>
    client.query(
      "SELECT payload FROM run_events WHERE project_id=$1 AND run_id=$2 AND type='case.created' ORDER BY seq",
      [project.id, created.json.id],
    ),
  );
  assert.deepEqual(
    events.rows.map((row) => row.payload.title),
    [b.version.document.name, a.version.document.name],
  );
});

test('retrying a regression request preserves its run; changed versions conflict', async () => {
  const a = await approvedDraft('retry-a');
  const b = await approvedDraft('retry-b');
  const options = {
    cookie: adminCookie,
    headers: { 'Idempotency-Key': randomUUID() },
    body: { projectId: project.id, caseVersionIds: [a.version.id] },
  };
  const first = await api('POST', '/api/v1/regression-runs', options);
  assert.equal(first.status, 202, JSON.stringify(first.json));
  const second = await api('POST', '/api/v1/regression-runs', options);
  assert.equal(second.status, 202, JSON.stringify(second.json));
  assert.equal(second.json.id, first.json.id);
  const changed = await api('POST', '/api/v1/regression-runs', {
    ...options,
    body: { ...options.body, caseVersionIds: [b.version.id] },
  });
  assert.equal(changed.status, 409, JSON.stringify(changed.json));
  assert.equal(changed.json.code, 'IDEMPOTENCY_CONFLICT');
});

test('sourceRunCaseId saves a real stored source into a draft without changing it', async () => {
  const before = await api('GET', `/api/v1/cases/${sourceCase.id}`, {
    cookie: adminCookie,
  });
  assert.equal(before.status, 200, JSON.stringify(before.json));
  const created = await api(
    'POST',
    `/api/v1/projects/${project.id}/saved-cases`,
    {
      cookie: adminCookie,
      body: {
        slug: `source-${tag}`,
        name: 'Stored source',
        sourceRunCaseId: sourceCase.id,
      },
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.currentApprovedVersionId, null);
  const versions = await api(
    'GET',
    `/api/v1/saved-cases/${created.json.id}/versions`,
    { cookie: adminCookie },
  );
  assert.equal(versions.json.items[0].reviewStatus, 'draft');
  assert.deepEqual(
    versions.json.items[0].document.criteria,
    sourceCase.criteria,
  );
  const afterSource = await api('GET', `/api/v1/cases/${sourceCase.id}`, {
    cookie: adminCookie,
  });
  assert.deepEqual(afterSource.json, before.json);
  const otherProject = await new ProjectRepository(db).create(
    { userId: adminUser.id },
    { name: `Cross-project source ${tag}` },
  );
  const wrongProject = await api(
    'POST',
    `/api/v1/projects/${otherProject.id}/saved-cases`,
    {
      cookie: adminCookie,
      body: {
        slug: `wrong-source-${tag}`,
        name: 'Wrong project',
        sourceRunCaseId: sourceCase.id,
      },
    },
  );
  assert.equal(wrongProject.status, 404, JSON.stringify(wrongProject.json));
  const unauthorized = await api(
    'POST',
    `/api/v1/projects/${project.id}/saved-cases`,
    {
      cookie: viewerCookie,
      body: {
        slug: `viewer-source-${tag}`,
        name: 'Viewer source',
        sourceRunCaseId: sourceCase.id,
      },
    },
  );
  assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized.json));
  const inaccessible = await api(
    'GET',
    `/api/v1/projects/${otherProject.id}/saved-cases`,
    { cookie: otherOwnerCookie },
  );
  assert.equal(inaccessible.status, 404, JSON.stringify(inaccessible.json));
});

test('review rejects changed content, actor, target and version; the matching token is consumed once', async () => {
  const a = await createDraft('bound-review');
  const b = await createDraft('other-target');
  const input = {
    expectedVersion: a.version.version,
    decision: 'approve',
    reason: 'exact bound decision',
  };
  const preview = await getPreview(a.version, input);
  const commit = { ...input, confirmationToken: preview.confirmationToken };
  const endpoint = `/api/v1/saved-case-versions/${a.version.id}/review`;
  for (const body of [
    { ...commit, decision: 'reject' },
    { ...commit, reason: 'changed reason' },
  ]) {
    const changed = await api('POST', endpoint, { cookie: adminCookie, body });
    assert.equal(changed.status, 422, JSON.stringify(changed.json));
  }
  assert.equal(
    (await api('POST', endpoint, { cookie: otherOwnerCookie, body: commit }))
      .status,
    403,
  );
  assert.equal(
    (
      await api('POST', `/api/v1/saved-case-versions/${b.version.id}/review`, {
        cookie: adminCookie,
        body: commit,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api('POST', endpoint, {
        cookie: adminCookie,
        body: { ...commit, expectedVersion: commit.expectedVersion + 1 },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await api(
        'POST',
        `/api/v1/saved-case-versions/${a.version.id}/review-preview`,
        { cookie: operatorCookie, body: input },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api(
        'POST',
        `/api/v1/saved-case-versions/${a.version.id}/review-preview`,
        { cookie: viewerCookie, body: input },
      )
    ).status,
    403,
  );
  const accepted = await api('POST', endpoint, {
    cookie: adminCookie,
    body: commit,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.reviewStatus, 'approved');
  assert.equal(
    (await api('POST', endpoint, { cookie: adminCookie, body: commit })).status,
    409,
  );
});

test('reject preview stays a rejection; expired and altered previews cannot authorize', async () => {
  const rejected = await createDraft('reject-review');
  const rejectInput = {
    expectedVersion: rejected.version.version,
    decision: 'reject',
    reason: 'this draft is not approved',
  };
  const rejectPreview = await getPreview(rejected.version, rejectInput);
  const rejectResult = await api(
    'POST',
    `/api/v1/saved-case-versions/${rejected.version.id}/review`,
    {
      cookie: adminCookie,
      body: {
        ...rejectInput,
        confirmationToken: rejectPreview.confirmationToken,
      },
    },
  );
  assert.equal(rejectResult.status, 200, JSON.stringify(rejectResult.json));
  assert.equal(rejectResult.json.reviewStatus, 'rejected');
  const draft = await createDraft('expired-review');
  const input = {
    expectedVersion: draft.version.version,
    decision: 'approve',
    reason: 'expires without approval',
  };
  const preview = await getPreview(draft.version, input);
  await assert.rejects(
    () =>
      db.actor({ userId: adminUser.id }, (client) =>
        client.query(
          "UPDATE saved_case_review_previews SET expires_at = clock_timestamp() + interval '1 day' WHERE token_hash = $1",
          [hashToken(preview.confirmationToken)],
        ),
      ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  const expiredToken = newToken();
  await db.actor({ userId: adminUser.id }, (client) =>
    client.query(
      `INSERT INTO saved_case_review_previews(id,project_id,version_id,actor_id,expected_version,body_hash,token_hash,expires_at,approved_body)
     SELECT $1,project_id,version_id,actor_id,expected_version,body_hash,$2,clock_timestamp()-interval '1 second',approved_body
     FROM saved_case_review_previews WHERE token_hash=$3`,
      [
        randomUUID(),
        hashToken(expiredToken),
        hashToken(preview.confirmationToken),
      ],
    ),
  );
  const expired = await api(
    'POST',
    `/api/v1/saved-case-versions/${draft.version.id}/review`,
    {
      cookie: adminCookie,
      body: { ...input, confirmationToken: expiredToken },
    },
  );
  assert.equal(expired.status, 409, JSON.stringify(expired.json));
});

test('database preserves version document/hash and rejects a draft or another case as baseline', async () => {
  const a = await createDraft('db-immutable');
  const b = await createDraft('db-other-case');
  await assert.rejects(
    () =>
      db.actor({ userId: adminUser.id }, (client) =>
        client.query(
          "UPDATE saved_case_versions SET document=jsonb_set(document,'{name}','\"tampered\"') WHERE id=$1",
          [a.version.id],
        ),
      ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    () =>
      db.actor({ userId: adminUser.id }, (client) =>
        client.query('UPDATE saved_case_versions SET sha256=$2 WHERE id=$1', [
          a.version.id,
          '0'.repeat(64),
        ]),
      ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    () =>
      db.actor({ userId: adminUser.id }, (client) =>
        client.query(
          'UPDATE saved_cases SET current_approved_version_id=$2 WHERE id=$1',
          [a.saved.id, a.version.id],
        ),
      ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  const input = {
    expectedVersion: b.version.version,
    decision: 'approve',
    reason: 'approved only for the other case',
  };
  const preview = await getPreview(b.version, input);
  assert.equal(
    (
      await api('POST', `/api/v1/saved-case-versions/${b.version.id}/review`, {
        cookie: adminCookie,
        body: { ...input, confirmationToken: preview.confirmationToken },
      })
    ).status,
    200,
  );
  await assert.rejects(
    () =>
      db.actor({ userId: adminUser.id }, (client) =>
        client.query(
          'UPDATE saved_cases SET current_approved_version_id=$2 WHERE id=$1',
          [a.saved.id, b.version.id],
        ),
      ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  const after = await api('GET', `/api/v1/saved-cases/${a.saved.id}/versions`, {
    cookie: adminCookie,
  });
  assert.deepEqual(after.json.items[0].document, a.version.document);
  assert.equal(after.json.items[0].sha256, a.version.sha256);
});
