import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import pg from 'pg';
import {
  AccountsRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  SecretVault,
  StorageError,
  migrate,
} from '@localqa/storage';
import {
  BoundModel,
  createWorkerModelOptions,
} from '../../../packages/orchestrator/dist/index.js';
import { createApiContext, createApiServer } from '../dist/index.js';

const tag = randomUUID().slice(0, 8);
const container = `localqa-g3e-pg-${tag}`;
const dir = `/tmp/localqa-g3e-${tag}`;
const artifactsDir = `${dir}/artifacts`;
const password = randomBytes(24).toString('hex');
const apiKey = `g3e-${randomUUID()}`;
const workerId = 'g3e-worker';
const criterionId = 'g3e.current';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** 1x1 baseline JPEG: SOF0, SOS, and EOI. Not a start-of-image marker alone. */
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+mKKKK/Kz/QA/9k=',
  'base64',
);
const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const jpegSoi = Buffer.from([0xff, 0xd8, 0xff]);
const jpegNoSof = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const gif = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
]);

function pngChunk(name, data) {
  const body = Buffer.concat([Buffer.from(name), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, sum]);
}

function bulkyPng() {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk('buNk', Buffer.alloc(48 * 1024)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const bulky = bulkyPng();
const tooBig = 25 * 1024 * 1024 + 1;

function rgbaHeader(colorType = 6) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = colorType;
  return header;
}

function wrappedPng(header, idat) {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const legalPixel = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
const badColor = wrappedPng(rgbaHeader(99), legalPixel);
const badZlib = wrappedPng(rgbaHeader(6), Buffer.from('not-a-zlib-stream'));
const badFilter = wrappedPng(
  rgbaHeader(6),
  deflateSync(Buffer.from([9, 0, 0, 0, 0])),
);
const badRows = wrappedPng(rgbaHeader(6), deflateSync(Buffer.from([0, 1, 2])));

mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(
  `${dir}/pg.env`,
  `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
  { mode: 0o600 },
);
writeFileSync(
  `${dir}/kek.json`,
  JSON.stringify({
    activeVersion: 1,
    keys: { 1: randomBytes(32).toString('base64') },
  }),
  { mode: 0o600 },
);
writeFileSync(`${dir}/outside.png`, png, { mode: 0o600 });

const calls = [];
let connection;
let raw;
let db;
let vault;
let models;
let api;
let server;
let port = 0;
let created = false;
let admin;
let project;
let visionId = '';
let blindId = '';
let frozenVersion = 0;
const runs = {};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function limits(extra = {}) {
  return {
    maxCases: 8,
    maxPages: 6,
    maxDepth: 2,
    maxActiveSeconds: 600,
    maxActionsPerCase: 12,
    maxActions: 120,
    maxModelCalls: 20,
    maxReproductions: 3,
    concurrency: 2,
    maxTotalTokens: 300000,
    ...extra,
  };
}

function used(extra = {}) {
  return {
    activeSeconds: 0,
    actions: 0,
    modelCalls: 0,
    reproductions: 0,
    totalTokens: 0,
    ...extra,
  };
}

function configFor(profileId, budget) {
  const binding = { profileId, version: frozenVersion };
  return {
    allowedOrigins: ['https://fixture.g3e.test'],
    actionPolicy: 'non_submitting',
    budget,
    environmentVersion: null,
    authProfileVersion: null,
    knowledgeVersionIds: [],
    models: {
      coordinator: binding,
      explorer: binding,
      executor: binding,
      assertion: binding,
      reproducer: binding,
    },
  };
}

function judgmentSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['criterionId', 'result', 'evidenceRefs'],
    properties: {
      criterionId: { type: 'string' },
      result: { type: 'string' },
      reason: { type: 'string' },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
    },
  };
}

function criterionRow(extra = {}) {
  return {
    id: criterionId,
    kind: 'semantic',
    description: 'Frozen criterion checked against the current lease case.',
    sourceKind: 'user_spec',
    sourceRef: 'g3e-fixture',
    ...extra,
  };
}

function judgmentCompletion(modelId, payload) {
  return JSON.stringify({
    model: modelId,
    choices: [
      {
        message: {
          role: 'assistant',
          content: JSON.stringify(payload),
        },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 4 },
  });
}

function callsFor(marker) {
  return calls.filter((call) => JSON.stringify(call.body).includes(marker));
}

function same(left, right) {
  return (
    typeof left === 'string' && left.length === right.length && left === right
  );
}

function imageUrls(body) {
  const urls = [];
  for (const message of body?.messages ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image_url' && typeof part.image_url?.url === 'string')
        urls.push(part.image_url.url);
    }
  }
  return urls;
}

function outboundText(body) {
  const parts = [];
  for (const message of body?.messages ?? []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n');
}

function place(runId, artifactId, bytes) {
  const directory = `${artifactsDir}/${project.id}/${runId}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(`${directory}/${artifactId}`, bytes, { mode: 0o600 });
}

async function seedRun(spec) {
  const runId = randomUUID();
  const taskId = randomUUID();
  const token = `g3e-${randomUUID()}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const budget = spec.budget ?? limits();
  const until = new Date(Date.now() + 600_000);
  const caseId = randomUUID();
  const task = {
    id: taskId,
    runId,
    role: 'executor',
    status: 'running',
    caseId,
    attempt: 1,
    summary: 'assert',
    elapsedSeconds: 0,
  };
  await raw.query(
    `INSERT INTO runs(id,project_id,creator_id,display_url,status,phase,completion,context_version,version,effective_config,budget_used)
     VALUES($1,$2,$3,'https://fixture.g3e.test/',$4,'execute','none',$5,1,$6,$7)`,
    [
      runId,
      project.id,
      admin.id,
      spec.runStatus ?? 'running',
      spec.contextVersion ?? 1,
      configFor(spec.profileId, budget),
      used(),
    ],
  );
  await raw.query(
    'INSERT INTO run_budgets(project_id,run_id,limits,used,reserved) VALUES($1,$2,$3,$4,$5)',
    [project.id, runId, spec.rowLimits ?? budget, spec.rowUsed ?? used(), {}],
  );
  await raw.query(
    `INSERT INTO run_cases(id,project_id,run_id,document,criteria_hash,frozen)
     VALUES($1,$2,$3,$4,$5,true)`,
    [
      caseId,
      project.id,
      runId,
      {
        id: caseId,
        runId,
        projectId: project.id,
        version: 1,
        title: 'g3e criterion',
        summary: 'approved image check',
        preconditions: [],
        outline: ['observe the current case'],
        criteria: [criterionRow(spec.criterionExtra)],
      },
      createHash('sha256').update(caseId).digest('hex'),
    ],
  );
  await raw.query(
    `INSERT INTO jobs(id,project_id,run_id,case_id,unique_key,role,status,attempt,document,worker_id,lease_until,fencing_token)
     VALUES($1,$2,$3,$4,$5,'executor','running',1,$6,$7,$8,1)`,
    [taskId, project.id, runId, caseId, `g3e-${taskId}`, task, workerId, until],
  );
  await raw.query(
    `INSERT INTO task_leases(id,project_id,task_id,worker_id,fencing_token,token_hash,lease_until,released_at)
     VALUES($1,$2,$3,$4,1,$5,$6,null)`,
    [randomUUID(), project.id, taskId, workerId, hash, until],
  );
  return { runId, taskId, token, caseId, profileId: spec.profileId };
}

async function insertArtifact(run, spec) {
  const artifactId = spec.id ?? randomUUID();
  const taskId = spec.taskId ?? run.taskId;
  await raw.query(
    `INSERT INTO artifacts(id,project_id,run_id,task_id,case_id,document,retain_until)
     VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 day')`,
    [
      artifactId,
      project.id,
      run.runId,
      taskId,
      spec.caseId === undefined ? run.caseId : spec.caseId,
      {
        id: artifactId,
        projectId: project.id,
        runId: run.runId,
        taskId,
        stepId: null,
        caseId: spec.caseId === undefined ? run.caseId : spec.caseId,
        snapshotId: null,
        kind: 'screenshot',
        status: spec.status ?? 'available',
        bytes: spec.bytes,
        sha256: spec.sha256,
        contentUrl: `/api/artifacts/${artifactId}`,
        redaction: spec.redaction ?? 'not_needed',
        error: null,
      },
    ],
  );
  return artifactId;
}

async function siblingTask(run) {
  const taskId = randomUUID();
  const until = new Date(Date.now() + 600_000);
  const task = {
    id: taskId,
    runId: run.runId,
    role: 'executor',
    status: 'running',
    caseId: null,
    attempt: 1,
    summary: 'other task',
    elapsedSeconds: 0,
  };
  await raw.query(
    `INSERT INTO jobs(id,project_id,run_id,case_id,unique_key,role,status,attempt,document,worker_id,lease_until,fencing_token)
     VALUES($1,$2,$3,null,$4,'executor','running',1,$5,$6,$7,1)`,
    [taskId, project.id, run.runId, `g3e-sib-${taskId}`, task, workerId, until],
  );
  return taskId;
}

function imageMessage(marker, artifactId) {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: marker },
        { type: 'image', artifactId },
      ],
    },
  ];
}

async function post(run, marker, extra = {}) {
  const response = await fetch(
    `http://127.0.0.1:${port}/internal/v1/model/complete`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lease-token': run.token,
      },
      body: JSON.stringify({
        taskId: run.taskId,
        profileId: run.profileId,
        contextVersion: extra.contextVersion ?? 1,
        purpose: 'assert',
        messages: extra.messages ?? [
          { role: 'user', content: [{ type: 'text', text: marker }] },
        ],
        maxOutputTokens: 100,
        outputSchema: judgmentSchema(),
        criterionId,
      }),
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    text,
  };
}

async function ledger(taskId) {
  const reservations = (
    await raw.query(
      'SELECT kind,status,reserved,charged FROM budget_reservations WHERE task_id=$1 ORDER BY status',
      [taskId],
    )
  ).rows;
  const requests = (
    await raw.query(
      'SELECT status,redacted_diagnostic FROM model_requests WHERE task_id=$1',
      [taskId],
    )
  ).rows;
  return { reservations, requests };
}

function expectDenied(result, marker, status, code) {
  const problems = [];
  if (callsFor(marker).length !== 0)
    problems.push(`fetches ${callsFor(marker).length}`);
  if (result.status !== status) problems.push(`status ${result.status}`);
  if (result.body?.code !== code)
    problems.push(`code ${result.body?.code ?? 'none'}`);
  assert.deepEqual(problems, [], marker);
}

async function expectQuiet(run, marker, status, code, extra) {
  const result = await post(run, marker, extra);
  expectDenied(result, marker, status, code);
  const book = await ledger(run.taskId);
  assert.equal(book.reservations.length, 0, marker);
  assert.equal(book.requests.length, 0, marker);
  return result;
}

before(async () => {
  const run = spawnSync('docker', [
    'run',
    '--detach',
    '--name',
    container,
    '--publish',
    '127.0.0.1::5432',
    '--env-file',
    `${dir}/pg.env`,
    'postgres:18-alpine',
  ]);
  assert.equal(run.status, 0, 'docker run failed');
  created = true;
  const mapped = spawnSync('docker', ['port', container, '5432/tcp'], {
    encoding: 'utf8',
  });
  const mappedPort = mapped.stdout.trim().split(':').at(-1);
  assert.equal(mappedPort === '5432', false);
  assert.equal(mappedPort === '8085', false);
  console.log(`G3E container ${container} port ${mappedPort}`);
  connection = `postgresql://localqa:${password}@127.0.0.1:${mappedPort}/localqa`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = spawnSync('docker', [
      'exec',
      container,
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-U',
      'localqa',
      '-d',
      'localqa',
    ]);
    if (probe.status === 0) {
      try {
        const client = new pg.Client({ connectionString: connection });
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        ready = true;
        break;
      } catch {
        /* TCP not ready yet */
      }
    }
    await delay(250);
  }
  assert.equal(ready, true);
  const applied = await migrate(
    connection,
    new URL('../../../packages/storage/migrations/', import.meta.url),
  );
  assert.equal(applied.includes('001_core.sql'), true);
  vault = await SecretVault.fromProtectedFile(`${dir}/kek.json`);
  db = new Database(connection);
  const accounts = new AccountsRepository(db);
  const projects = new ProjectRepository(db);
  models = new ModelRepository(db, vault);
  admin = await accounts.bootstrap({
    email: `g3e-admin-${tag}@localqa.test`,
    displayName: 'G3E Admin',
    password: 'G3e-admin-password',
  });
  project = await projects.create({ userId: admin.id }, { name: `g3e-${tag}` });
  async function probeProfile(name, imageInput) {
    const createdProfile = await models.create(
      { userId: admin.id },
      {
        name: `${name}-${tag}`,
        endpoint: 'https://model.g3e.test/v1',
        configuredModelId: `${name}-v1`,
        adapter: 'openai_compatible',
        dataBoundary: 'external',
        responseFormat: 'json_schema',
        apiKey,
      },
    );
    const probed = await models.recordProbe(
      { userId: admin.id },
      createdProfile.id,
      1,
      {
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput,
        },
        status: 'degraded',
      },
    );
    assert.equal(probed.version, 2);
    assert.equal(probed.capabilities.imageInput, imageInput);
    await models.grant({ userId: admin.id }, project.id, createdProfile.id);
    return createdProfile.id;
  }
  visionId = await probeProfile('g3e-vision', true);
  blindId = await probeProfile('g3e-blind', false);
  frozenVersion = 2;
  raw = new pg.Client({ connectionString: connection });
  await raw.connect();
  const specs = {
    png: { profileId: visionId, criterionExtra: { kind: 'visual' } },
    jpeg: { profileId: visionId },
    pngSig: { profileId: visionId },
    badColor: { profileId: visionId },
    badZlib: { profileId: visionId },
    badFilter: { profileId: visionId },
    badRows: { profileId: visionId },
    jpegSoi: { profileId: visionId },
    jpegNoSof: { profileId: visionId },
    meta: { profileId: visionId },
    empty: { profileId: visionId, criterionExtra: { kind: 'visual' } },
    noImage: { profileId: visionId, criterionExtra: { kind: 'visual' } },
    badHash: { profileId: visionId },
    badMime: { profileId: visionId },
    missing: { profileId: visionId },
    degraded: { profileId: visionId },
    failed: { profileId: visionId },
    redaction: { profileId: visionId },
    foreign: { profileId: visionId },
    context: { profileId: visionId, contextVersion: 2 },
    cancelled: { profileId: visionId, runStatus: 'cancelled' },
    tooBig: { profileId: visionId },
    bulky: { profileId: visionId },
    exhausted: {
      profileId: visionId,
      budget: limits({ maxModelCalls: 1 }),
      rowLimits: limits({ maxModelCalls: 1 }),
      rowUsed: used({ modelCalls: 1 }),
    },
    blind: { profileId: blindId },
    call: { profileId: visionId },
    noReader: { profileId: visionId },
  };
  for (const [name, spec] of Object.entries(specs))
    runs[name] = await seedRun(spec);
  async function ownedImage(name, bytes, extra = {}) {
    const digest = sha256(bytes);
    const artifactId = await insertArtifact(runs[name], {
      bytes: extra.bytes ?? bytes.length,
      sha256: extra.sha256 ?? digest,
      status: extra.status,
      redaction: extra.redaction,
      taskId: extra.taskId,
      caseId: extra.caseId,
    });
    runs[name].artifactId = artifactId;
    runs[name].contentUrl = `/api/artifacts/${artifactId}`;
    if (extra.link) {
      const directory = `${artifactsDir}/${project.id}/${runs[name].runId}`;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      symlinkSync(`${dir}/outside.png`, `${directory}/${artifactId}`);
    } else if (extra.skipFile !== true) {
      place(runs[name].runId, artifactId, bytes);
    }
    return artifactId;
  }
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal(jpeg.at(-2), 0xff);
  assert.equal(jpeg.at(-1), 0xd9);
  assert.equal(jpeg.includes(Buffer.from([0xff, 0xc0])), true);
  await ownedImage('png', png, { redaction: 'not_needed' });
  await ownedImage('jpeg', jpeg, { redaction: 'applied' });
  await ownedImage('pngSig', pngSignature);
  await ownedImage('badColor', badColor);
  await ownedImage('badZlib', badZlib);
  await ownedImage('badFilter', badFilter);
  await ownedImage('badRows', badRows);
  await ownedImage('jpegSoi', jpegSoi);
  await ownedImage('jpegNoSof', jpegNoSof);
  await ownedImage('meta', png);
  await ownedImage('empty', png);
  await ownedImage('badHash', png, { sha256: 'ab'.repeat(32) });
  await ownedImage('badMime', gif);
  await ownedImage('missing', png, { status: 'missing' });
  await ownedImage('degraded', png, { status: 'degraded' });
  await ownedImage('failed', png, { status: 'failed' });
  await ownedImage('redaction', png, { redaction: 'failed' });
  const sibling = await siblingTask(runs.foreign);
  await ownedImage('foreign', png, { taskId: sibling, caseId: null });
  await ownedImage('context', png, { sha256: 'ab'.repeat(32) });
  await ownedImage('cancelled', png, { sha256: 'ab'.repeat(32) });
  await ownedImage('tooBig', png, { bytes: tooBig, sha256: sha256(png) });
  await ownedImage('bulky', bulky);
  await ownedImage('exhausted', png);
  await ownedImage('blind', png, { sha256: 'cd'.repeat(32) });
  await ownedImage('noReader', png, { sha256: 'ef'.repeat(32) });
  const otherTask = randomUUID();
  await raw.query('ALTER TABLE artifacts DISABLE TRIGGER artifact_binding');
  try {
    await raw.query(
      `UPDATE artifacts SET document = jsonb_set(document, '{taskId}', to_jsonb($2::text)) WHERE id=$1`,
      [runs.meta.artifactId, otherTask],
    );
  } finally {
    await raw.query('ALTER TABLE artifacts ENABLE TRIGGER artifact_binding');
  }
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    const authorization = init.headers?.authorization ?? '';
    calls.push({
      body,
      authorized: same(authorization, `Bearer ${apiKey}`),
      leaked: JSON.stringify(body).includes(apiKey),
    });
    const text = outboundText(body);
    const claim = {
      criterionId,
      result: 'passed',
      reason: 'provider claims pass',
      evidenceRefs: [],
    };
    const pass = [
      ['G3E-PNG', runs.png.artifactId],
      ['G3E-JPEG', runs.jpeg.artifactId],
    ];
    for (const [marker, artifactId] of pass) {
      if (text.includes(marker)) {
        return new Response(
          judgmentCompletion(body.model, {
            ...claim,
            evidenceRefs: [artifactId],
          }),
          { status: 200 },
        );
      }
    }
    if (text.includes('G3E-EMPTY') || text.includes('G3E-CALL')) {
      return new Response(judgmentCompletion(body.model, claim), {
        status: 200,
      });
    }
    return new Response(judgmentCompletion(body.model, claim), { status: 200 });
  };
  api = createApiContext({
    connectionString: connection,
    vault,
    artifactsDir,
    serviceActor: { userId: admin.id },
    modelTransport: transport,
  });
  server = createApiServer(api);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  assert.equal(port === 8085, false);
});

after(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  if (api) await api.db.close().catch(() => {});
  vault?.dispose?.();
  if (db) await db.close().catch(() => {});
  if (raw) await raw.end().catch(() => {});
  if (created) spawnSync('docker', ['rm', '--force', '--volumes', container]);
  rmSync(dir, { recursive: true, force: true });
});

async function expectPassed(name, marker, mediaType, bytes) {
  const run = runs[name];
  const result = await post(run, marker, {
    messages: imageMessage(marker, run.artifactId),
  });
  const seen = callsFor(marker);
  assert.equal(seen.length, 1, marker);
  assert.equal(seen[0].authorized, true, marker);
  assert.equal(seen[0].leaked, false, marker);
  const payload = bytes.toString('base64');
  const urls = imageUrls(seen[0].body);
  assert.deepEqual(urls, [`data:${mediaType};base64,${payload}`], marker);
  const serialized = JSON.stringify(seen[0].body);
  assert.equal(serialized.includes('artifact://'), false, marker);
  assert.equal(serialized.includes(run.contentUrl), false, marker);
  assert.equal(result.status, 200, marker);
  assert.equal(result.body?.data?.criterionId, criterionId, marker);
  assert.equal(result.body?.data?.result, 'passed', marker);
  assert.equal(result.body?.data?.reason, 'OBSERVED', marker);
  assert.deepEqual(result.body?.data?.evidenceRefs, [run.artifactId], marker);
  assert.equal(result.text.includes(payload), false, marker);
  assert.equal(result.text.includes('provider claims pass'), false, marker);
  assert.equal(result.text.includes(apiKey), false, marker);
  const sent = outboundText(seen[0].body);
  assert.equal(
    sent.includes('"kind":"visual"') || name !== 'png',
    true,
    marker,
  );
  assert.equal(sent.includes('"sourceRef":"g3e-fixture"'), true, marker);
  const book = await ledger(run.taskId);
  assert.equal(book.reservations.length, 1, marker);
  assert.equal(book.reservations[0].status, 'settled', marker);
  assert.equal(book.reservations[0].charged.modelCalls, 1, marker);
  assert.equal(book.reservations[0].charged.totalTokens, 15, marker);
  assert.equal(book.requests.length, 1, marker);
  assert.equal(book.requests[0].status, 'settled', marker);
  assert.equal(
    book.requests[0].redacted_diagnostic.usageSource,
    'reported',
    marker,
  );
  assert.equal(book.requests[0].redacted_diagnostic.inputTokens, 11, marker);
  assert.equal(book.requests[0].redacted_diagnostic.outputTokens, 4, marker);
  const bookText = JSON.stringify(book);
  assert.equal(bookText.includes(payload), false, marker);
  assert.equal(bookText.includes(apiKey), false, marker);
  assert.equal(bookText.includes('artifact://'), false, marker);
}

test('an approved png is sent as a data URL on the shared budget', async () => {
  await expectPassed('png', 'G3E-PNG', 'image/png', png);
});

test('an approved jpeg is sent as a data URL', async () => {
  await expectPassed('jpeg', 'G3E-JPEG', 'image/jpeg', jpeg);
});

test('empty evidence refs stay not_evaluated after a real image is sent', async () => {
  const marker = 'G3E-EMPTY';
  const result = await post(runs.empty, marker, {
    messages: imageMessage(marker, runs.empty.artifactId),
  });
  const seen = callsFor(marker);
  assert.equal(seen.length, 1);
  assert.equal(
    imageUrls(seen[0].body)[0]?.startsWith('data:image/png;base64,'),
    true,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body?.data?.result, 'not_evaluated');
  assert.equal(result.body?.data?.reason, 'NO_OBSERVATION_REF');
  assert.deepEqual(result.body?.data?.evidenceRefs, []);
  assert.equal(result.text.includes('provider claims pass'), false);
});

test('visual without an image does not call the provider', async () => {
  await expectQuiet(
    runs.noImage,
    'G3E-NOIMAGE',
    500,
    'MODEL_CAPABILITY_MISSING',
  );
});

test('a bad hash fails before the provider', async () => {
  await expectQuiet(runs.badHash, 'G3E-HASH', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-HASH', runs.badHash.artifactId),
  });
});

test('gif bytes are an unknown MIME and are not guessed from kind', async () => {
  await expectQuiet(runs.badMime, 'G3E-MIME', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-MIME', runs.badMime.artifactId),
  });
});

test('a png signature without chunks is not a real image', async () => {
  await expectQuiet(runs.pngSig, 'G3E-PNGSIG', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-PNGSIG', runs.pngSig.artifactId),
  });
});

test('a crc-valid png with color type 99 is not sent', async () => {
  await expectQuiet(runs.badColor, 'G3E-COLOR', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-COLOR', runs.badColor.artifactId),
  });
});

test('a crc-valid png whose IDAT is not zlib is not sent', async () => {
  await expectQuiet(runs.badZlib, 'G3E-ZLIB', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-ZLIB', runs.badZlib.artifactId),
  });
});

test('a decoded png with an illegal filter byte is not sent', async () => {
  await expectQuiet(runs.badFilter, 'G3E-FILTER', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-FILTER', runs.badFilter.artifactId),
  });
});

test('a decoded png with the wrong scanline length is not sent', async () => {
  await expectQuiet(runs.badRows, 'G3E-ROWS', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-ROWS', runs.badRows.artifactId),
  });
});

test('a jpeg start marker without a frame is not a real image', async () => {
  await expectQuiet(runs.jpegSoi, 'G3E-JSOI', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-JSOI', runs.jpegSoi.artifactId),
  });
});

test('a jpeg without a frame or scan is not a real image', async () => {
  await expectQuiet(runs.jpegNoSof, 'G3E-JNOSOF', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-JNOSOF', runs.jpegNoSof.artifactId),
  });
});

test('metadata for another task is not sent', async () => {
  const row = (
    await raw.query('SELECT task_id, document FROM artifacts WHERE id=$1', [
      runs.meta.artifactId,
    ])
  ).rows[0];
  assert.equal(row.task_id, runs.meta.taskId);
  assert.equal(row.document.status, 'available');
  assert.equal(row.document.redaction, 'not_needed');
  assert.notEqual(row.document.taskId, runs.meta.taskId);
  await expectQuiet(runs.meta, 'G3E-META', 404, 'NOT_FOUND', {
    messages: imageMessage('G3E-META', runs.meta.artifactId),
  });
});

test('missing, degraded, and failed artifacts are not read', async () => {
  await expectQuiet(runs.missing, 'G3E-MISSING', 404, 'NOT_FOUND', {
    messages: imageMessage('G3E-MISSING', runs.missing.artifactId),
  });
  await expectQuiet(runs.degraded, 'G3E-DEGRADED', 404, 'NOT_FOUND', {
    messages: imageMessage('G3E-DEGRADED', runs.degraded.artifactId),
  });
  await expectQuiet(runs.failed, 'G3E-FAILED', 404, 'NOT_FOUND', {
    messages: imageMessage('G3E-FAILED', runs.failed.artifactId),
  });
});

test('redaction that is not applied or not_needed fails before the provider', async () => {
  await expectQuiet(runs.redaction, 'G3E-REDACT', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-REDACT', runs.redaction.artifactId),
  });
});

test('another task artifact is not readable from this lease', async () => {
  await expectQuiet(runs.foreign, 'G3E-FOREIGN', 404, 'NOT_FOUND', {
    messages: imageMessage('G3E-FOREIGN', runs.foreign.artifactId),
  });
});

test('an unknown artifact id fails before the provider', async () => {
  await expectQuiet(runs.noImage, 'G3E-UNKNOWN', 404, 'NOT_FOUND', {
    messages: imageMessage('G3E-UNKNOWN', randomUUID()),
  });
});

test('a context change does not hash a bad file', async () => {
  await expectQuiet(runs.context, 'G3E-CONTEXT', 409, 'LEASE_EXPIRED', {
    messages: imageMessage('G3E-CONTEXT', runs.context.artifactId),
  });
});

test('a cancelled run does not send and does not hash a bad file', async () => {
  await expectQuiet(runs.cancelled, 'G3E-CANCEL', 409, 'LEASE_EXPIRED', {
    messages: imageMessage('G3E-CANCEL', runs.cancelled.artifactId),
  });
});

test('a declared oversize image fails before the file is hashed', async () => {
  await expectQuiet(runs.tooBig, 'G3E-TOOBIG', 413, 'ARTIFACT_TOO_LARGE', {
    messages: imageMessage('G3E-TOOBIG', runs.tooBig.artifactId),
  });
});

test('image bytes share the input budget and do not send when over it', async () => {
  await expectQuiet(runs.bulky, 'G3E-BULKY', 500, 'BUDGET_EXCEEDED', {
    messages: imageMessage('G3E-BULKY', runs.bulky.artifactId),
  });
});

test('an exhausted run budget sends nothing after the image is eligible', async () => {
  await expectQuiet(runs.exhausted, 'G3E-BUDGET', 500, 'BUDGET_EXCEEDED', {
    messages: imageMessage('G3E-BUDGET', runs.exhausted.artifactId),
  });
});

test('image capability false fails before a bad hash is checked', async () => {
  const result = await expectQuiet(
    runs.blind,
    'G3E-BLIND',
    500,
    'MODEL_CAPABILITY_MISSING',
    {
      messages: imageMessage('G3E-BLIND', runs.blind.artifactId),
    },
  );
  assert.notEqual(result.body?.code, 'VALIDATION_ERROR');
  const stored = (
    await raw.query(
      'SELECT document FROM model_profile_versions WHERE profile_id=$1 AND version=2',
      [blindId],
    )
  ).rows[0].document;
  assert.equal(stored.capabilities.imageInput, false);
});

test('a symlink outside the store fails before the provider', async () => {
  const run = runs.call;
  const artifactId = randomUUID();
  await insertArtifact(run, {
    id: artifactId,
    bytes: png.length,
    sha256: sha256(png),
  });
  const directory = `${artifactsDir}/${project.id}/${run.runId}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  symlinkSync(`${dir}/outside.png`, `${directory}/${artifactId}`);
  await expectQuiet(run, 'G3E-LINK', 422, 'VALIDATION_ERROR', {
    messages: imageMessage('G3E-LINK', artifactId),
  });
});

test('BoundModel.call returns the normalized judgment instead of raw passed', async () => {
  const options = createWorkerModelOptions({
    transport: api.modelTransport,
    load: (id, version) =>
      models.readVersion({ userId: admin.id }, id, version),
    readApprovedImage: (image) => api.artifacts.readApprovedImage(image),
  });
  const bound = new BoundModel(
    api.coordinator,
    { workerId, projectId: project.id },
    options,
  );
  const record = await bound.call(
    {
      taskId: runs.call.taskId,
      leaseToken: runs.call.token,
      fencingToken: 1,
      contextVersion: 1,
    },
    'assertion',
    {
      purpose: 'assert',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'G3E-CALL' }] },
      ],
      outputSchema: judgmentSchema(),
      maxOutputTokens: 100,
    },
    criterionId,
  );
  assert.equal(callsFor('G3E-CALL').length, 1);
  assert.equal(record.errorCode, null);
  assert.equal(record.requestResult, 'inconclusive');
  assert.equal(record.data?.result, 'not_evaluated');
  assert.equal(record.data?.reason, 'NO_OBSERVATION_REF');
  assert.deepEqual(record.data?.evidenceRefs, []);
  assert.equal(record.data?.criterionId, criterionId);
  assert.equal(Object.hasOwn(record.data, 'configuredModelId'), false);
  assert.equal(Object.hasOwn(record.data, 'usage'), false);
  assert.equal(record.assessment?.criterionResult, 'not_evaluated');
  assert.equal(record.rawOutput.includes('passed'), true);
  assert.equal(
    JSON.stringify(record.data).includes('provider claims pass'),
    false,
  );
});

test('without a reader an image fails before the provider and before the hash', async () => {
  const beforeCount = calls.length;
  const options = createWorkerModelOptions({
    transport: api.modelTransport,
    load: (id, version) =>
      models.readVersion({ userId: admin.id }, id, version),
  });
  const bound = new BoundModel(
    api.coordinator,
    { workerId, projectId: project.id },
    options,
  );
  await assert.rejects(
    () =>
      bound.call(
        {
          taskId: runs.noReader.taskId,
          leaseToken: runs.noReader.token,
          fencingToken: 1,
          contextVersion: 1,
        },
        'assertion',
        {
          purpose: 'assert',
          messages: imageMessage('G3E-NOREADER', runs.noReader.artifactId),
          outputSchema: judgmentSchema(),
          maxOutputTokens: 100,
        },
        criterionId,
      ),
    (error) =>
      error instanceof StorageError && error.code === 'MODEL_NOT_CONFIGURED',
  );
  assert.equal(calls.length, beforeCount);
  const book = await ledger(runs.noReader.taskId);
  assert.equal(book.reservations.length, 0);
  assert.equal(book.requests.length, 0);
});
