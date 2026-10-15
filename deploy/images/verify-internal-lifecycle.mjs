#!/usr/bin/env node
/**
 * Real end-to-end lifecycle over the authenticated internal boundary.
 *
 * Proves a legitimate peer can drive a real task: it logs in like a normal user,
 * admits a run through the public API, then claims the lease, heartbeats,
 * uploads evidence and completes the task using only signed `/internal/v1/*`
 * requests. State is read back from PostgreSQL to confirm the writes landed.
 *
 * The admin password is read from a protected file and never printed.
 *
 * Usage:
 *   node verify-internal-lifecycle.mjs <apiBase> <keyRingFile> <projectId> \
 *        <targetUrl> <adminPasswordFile> <databaseUrlFile>
 */
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { InternalServiceSigner, parseServiceIdentityDocument } from '@localqa/service-identity';
import { hashPayload } from '@localqa/storage';

const [
  apiBase,
  keyRingFile,
  projectId,
  targetUrl,
  adminPasswordFile,
  databaseUrlFile,
] = process.argv.slice(2);
if (!apiBase || !keyRingFile || !projectId || !targetUrl || !adminPasswordFile || !databaseUrlFile) {
  console.error(
    'usage: verify-internal-lifecycle.mjs <apiBase> <keyRingFile> <projectId> <targetUrl> <adminPasswordFile> <databaseUrlFile>',
  );
  process.exit(2);
}

const report = {
  apiBase,
  projectId,
  targetUrl,
  steps: [],
  created: { runIds: [], taskIds: [], artifactIds: [] },
  ok: false,
};

const step = (name, detail) => {
  report.steps.push({ name, ...detail });
};

let doc;
try {
  doc = parseServiceIdentityDocument(
    JSON.parse(await readFile(keyRingFile, 'utf8')),
  );
} catch (error) {
  console.error(`cannot load key ring: ${error?.message ?? error}`);
  process.exit(2);
}
const entry = doc.get('worker');
const signer = new InternalServiceSigner({
  serviceId: 'worker',
  keyVersion: entry.activeVersion,
  secret: entry.keys.get(entry.activeVersion),
});

const databaseUrl = (await readFile(databaseUrlFile, 'utf8')).trim();
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();

async function signed(path, body, extraHeaders = {}, contentType) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? {}));
  const headers = {
    ...signer.sign({ method: 'POST', path, rawBody: raw }).headers,
    ...extraHeaders,
    'content-type': contentType ?? 'application/json',
  };
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers,
    body: raw,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 204 */
  }
  return { status: response.status, json, text };
}

// ---- 1. normal user login ---------------------------------------------------
const adminPassword = (await readFile(adminPasswordFile, 'utf8')).trim();
const login = await fetch(`${apiBase}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'admin@localqa.internal',
    password: adminPassword,
  }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
step('user_login', { status: login.status, hasSessionCookie: cookie.startsWith('session=') });
if (login.status !== 200 || !cookie.startsWith('session=')) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

const workerId = `p0-01-lifecycle-${randomUUID().slice(0, 8)}`;
let lease = null;
let runId = null;

// ---- 2. admit a run, then claim its lease with a signed request -------------
for (let attempt = 1; attempt <= 5 && !lease; attempt += 1) {
  const create = await fetch(`${apiBase}/api/v1/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `p0-01-lifecycle-${randomUUID()}`,
      cookie,
    },
    body: JSON.stringify({ projectId, targetUrl, taskIntent: 'flow' }),
  });
  const created = await create.json().catch(() => null);
  step(`create_run_attempt_${attempt}`, {
    status: create.status,
    runId: created?.id ?? null,
    runStatus: created?.status ?? null,
  });
  if (create.status !== 202 || !created?.id) break;
  runId = created.id;
  report.created.runIds.push(runId);

  // Claim immediately: the scheduler may hand the job to the resident worker.
  const claim = await signed(
    `/internal/v1/leases/claim?projectId=${projectId}`,
    { workerId, capabilities: ['chromium', 'images', 'recording'] },
  );
  step(`signed_claim_attempt_${attempt}`, {
    status: claim.status,
    taskId: claim.json?.task?.id ?? null,
    role: claim.json?.task?.role ?? null,
    scope: claim.json?.task?.summary ?? null,
  });
  if (claim.status === 200 && claim.json?.task?.id) lease = claim.json;
  else report.created.runIds.pop();
}

if (!lease) {
  step('claim_result', {
    ok: false,
    reason: 'the resident worker won every lease; write access was not fabricated',
  });
  await db.end();
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}
report.created.taskIds.push(lease.task.id);
step('lease_claimed', {
  ok: true,
  taskId: lease.task.id,
  role: lease.task.role,
  fencingToken: lease.fencingToken,
  contextVersion: lease.contextVersion,
  leaseUntil: lease.leaseUntil,
});

const proof = {
  taskId: lease.task.id,
  leaseToken: lease.leaseToken,
  fencingToken: lease.fencingToken,
  contextVersion: lease.contextVersion,
};
const proofHeaders = {
  'x-lease-token': proof.leaseToken,
  'x-worker-id': workerId,
  'x-project-id': projectId,
  'x-fencing-token': String(proof.fencingToken),
  'x-context-version': String(proof.contextVersion),
};

// ---- 3. heartbeat -----------------------------------------------------------
const heartbeat = await signed(
  `/internal/v1/tasks/${proof.taskId}/heartbeat`,
  { fencingToken: proof.fencingToken, contextVersion: proof.contextVersion },
  proofHeaders,
);
step('heartbeat', {
  ok: heartbeat.status === 200,
  status: heartbeat.status,
  cancelRequested: heartbeat.json?.cancelRequested ?? null,
});

// ---- 4. action reservation reaches policy ----------------------------------
const reserve = await signed(
  '/internal/v1/actions/reserve',
  {
    taskId: proof.taskId,
    fencingToken: proof.fencingToken,
    contextVersion: proof.contextVersion,
    toolCall: { name: 'navigate', args: { url: `${targetUrl}` } },
  },
  proofHeaders,
);
step('action_reserve', {
  // A denial is a policy answer, not an authentication failure.
  ok: reserve.status === 200,
  status: reserve.status,
  permitted: reserve.json?.permitted ?? null,
  reasonCode: reserve.json?.reasonCode ?? null,
  actionId: reserve.json?.actionId ?? null,
});
if (reserve.status === 200 && reserve.json?.permitted && reserve.json?.actionId) {
  const outcome = { outcome: 'succeeded', summary: 'navigate acknowledged for boundary verification' };
  const result = await signed(
    `/internal/v1/actions/${reserve.json.actionId}/result`,
    {
      outcome: 'succeeded',
      summary: outcome.summary,
      evidenceRefs: [],
      resultHash: hashPayload(outcome),
    },
    proofHeaders,
  );
  step('action_result', { ok: result.status === 200, status: result.status });
}

// ---- 5. artifact upload over the signed multipart route --------------------
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const boundary = `----p0verifier${Date.now().toString(16)}`;
const multipart = Buffer.concat([
  Buffer.from(
    `--${boundary}\r\ncontent-disposition: form-data; name="taskId"\r\n\r\n${proof.taskId}\r\n` +
      `--${boundary}\r\ncontent-disposition: form-data; name="kind"\r\n\r\nscreenshot\r\n` +
      `--${boundary}\r\ncontent-disposition: form-data; name="redaction"\r\n\r\napplied\r\n` +
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="evidence.png"\r\ncontent-type: image/png\r\n\r\n`,
  ),
  pngBytes,
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);
const upload = await signed(
  '/internal/v1/artifacts',
  multipart,
  proofHeaders,
  `multipart/form-data; boundary=${boundary}`,
);
if (upload.json?.id) report.created.artifactIds.push(upload.json.id);
step('artifact_upload', {
  ok: upload.status === 201,
  status: upload.status,
  artifactId: upload.json?.id ?? null,
  bytes: upload.json?.bytes ?? null,
  redaction: upload.json?.redaction ?? null,
});
report.created.artifactIds = report.created.artifactIds.filter(Boolean);

// ---- 6. complete the task ---------------------------------------------------
const expected = await db.query(
  "SELECT result->>'stage' AS stage FROM jobs WHERE id=$1 AND project_id=$2",
  [proof.taskId, projectId],
);
const stage = expected.rows[0]?.stage;
step('expected_stage_read', { stage: stage ?? null });

const completionResult = { stage, checked: true };
const completion = {
  fencingToken: proof.fencingToken,
  status: 'succeeded',
  result: completionResult,
  // `leases.complete` recomputes hashPayload(result) and refuses a mismatch, so
  // the client cannot submit an inconsistent receipt.
  resultHash: hashPayload(completionResult),
};
const complete = await signed(
  `/internal/v1/tasks/${proof.taskId}/complete`,
  completion,
  proofHeaders,
);
step('task_complete', {
  ok: complete.status === 200,
  status: complete.status,
  taskStatus: complete.json?.status ?? null,
  code: complete.json?.code ?? null,
  message: complete.json?.message ?? null,
  sent: completion,
});

// ---- 7. read the writes back from the database -----------------------------
const jobRow = await db.query(
  'SELECT status, started_at, finished_at, worker_id, fencing_token FROM jobs WHERE id=$1',
  [proof.taskId],
);
const artifactRow = await db.query(
  "SELECT id, document->>'status' AS status, document->>'redaction' AS redaction, document->>'kind' AS kind FROM artifacts WHERE task_id=$1",
  [proof.taskId],
);
const eventRow = await db.query(
  "SELECT count(*)::int AS n FROM run_events WHERE run_id=$1",
  [runId],
);
step('database_readback', {
  job: jobRow.rows[0] ?? null,
  artifacts: artifactRow.rows,
  runEventCount: eventRow.rows[0]?.n ?? null,
});

// ---- 8. a valid credential on a foreign task must be refused ---------------
const foreign = await signed(
  '/internal/v1/tasks/00000000-0000-0000-0000-000000000000/complete',
  completion,
  proofHeaders,
);
step('foreign_task_refused', { ok: foreign.status !== 200, status: foreign.status });

// ---- 9. evidence integrity -------------------------------------------------
const localSha = createHash('sha256').update(pngBytes).digest('hex');
step('evidence_hash_matches_upload', {
  ok: upload.json?.sha256 === localSha,
  uploaded: upload.json?.sha256 ?? null,
  local: localSha,
});

await db.end();

const failed = report.steps.filter((s) => s.ok === false);
report.failedSteps = failed.map((s) => s.name);
report.ok = failed.length === 0;
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
