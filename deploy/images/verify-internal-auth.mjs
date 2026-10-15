#!/usr/bin/env node
/**
 * Real deployment verification for the internal service-identity boundary.
 *
 * Runs inside the compose network against the live API, so every case below is
 * a real HTTP request over the real network with the real key ring. It only
 * prints a machine-readable report.
 *
 * Usage: node verify-internal-auth.mjs <apiBaseUrl> <keyRingFile> <serviceId>
 */
import { readFile } from 'node:fs/promises';
import {
  InternalServiceSigner,
  parseServiceIdentityDocument,
} from '@localqa/service-identity';

const [apiBase, keyRingFile, serviceId = 'worker'] = process.argv.slice(2);
if (!apiBase || !keyRingFile) {
  console.error('usage: verify-internal-auth.mjs <apiBase> <keyRingFile> [serviceId]');
  process.exit(2);
}

let doc;
try {
  doc = parseServiceIdentityDocument(
    JSON.parse(await readFile(keyRingFile, 'utf8')),
  );
} catch (error) {
  console.error(
    `cannot load service identity key ring: ${error?.message ?? error}`,
  );
  process.exit(2);
}
const entry = doc.get(serviceId);
const secret = entry.keys.get(entry.activeVersion);
const signer = new InternalServiceSigner({
  serviceId,
  keyVersion: entry.activeVersion,
  secret,
});

const results = [];
const record = (name, expected, actual, extra = {}) => {
  const ok =
    typeof expected === 'function' ? expected(actual) : actual === expected;
  results.push({ name, expected: String(expected), actual, ok, ...extra });
  return ok;
};

async function call(
  path,
  { method = 'POST', body, sign = true, headers = {}, rawSigner } = {},
) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const requestHeaders = { ...headers };
  if (sign) {
    const active = rawSigner ?? signer;
    Object.assign(
      requestHeaders,
      active.sign({ method, path, rawBody: raw }).headers,
    );
  }
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...requestHeaders },
    ...(raw === undefined ? {} : { body: raw }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body (204 / html) */
  }
  return { status: response.status, json, text };
}

const claimPath = '/internal/v1/leases/claim';
const claimBody = { workerId: 'p0-01-verifier', capabilities: ['chromium'] };

// ---- 1. no credential -------------------------------------------------------
record(
  'unauthenticated_claim_rejected',
  403,
  (await call(claimPath, { body: claimBody, sign: false })).status,
);

// ---- 2. self-declared worker identity is not a credential -------------------
record(
  'self_declared_worker_id_rejected',
  403,
  (
    await call(claimPath, {
      body: claimBody,
      sign: false,
      headers: { 'x-worker-id': 'worker-node-1', 'x-project-id': 'x' },
    })
  ).status,
);

// ---- 3. user cookie must not be accepted on internal routes ----------------
record(
  'user_cookie_rejected',
  403,
  (
    await call(claimPath, {
      body: claimBody,
      sign: false,
      headers: { cookie: 'session=forged-session-token' },
    })
  ).status,
);

// ---- 4. a key outside the ring ---------------------------------------------
const forged = new InternalServiceSigner({
  serviceId,
  keyVersion: 1,
  secret: Buffer.alloc(32, 7),
});
record(
  'forged_key_rejected',
  403,
  (await call(claimPath, { body: claimBody, rawSigner: forged })).status,
);

// ---- 5. stale timestamp -----------------------------------------------------
const staleSigner = new InternalServiceSigner({
  serviceId,
  keyVersion: entry.activeVersion,
  secret,
  now: () => Date.now() - 10 * 60_000,
});
record(
  'stale_credential_rejected',
  403,
  (await call(claimPath, { body: claimBody, rawSigner: staleSigner })).status,
);

// ---- 6. cross-service key ---------------------------------------------------
const otherId = [...doc.keys()].find((id) => id !== serviceId);
if (otherId) {
  const other = doc.get(otherId);
  const crossSigner = new InternalServiceSigner({
    serviceId,
    keyVersion: 1,
    // Signed with the other service's material but claiming to be `serviceId`.
    secret: other.keys.get(other.activeVersion),
  });
  record(
    'cross_service_key_rejected',
    403,
    (await call(claimPath, { body: claimBody, rawSigner: crossSigner })).status,
  );
}

// ---- 7. replay of a valid credential ---------------------------------------
const valid = signer.sign({ method: 'POST', path: claimPath, rawBody: Buffer.from(JSON.stringify(claimBody)) });
const first = await call(claimPath, { body: claimBody, sign: false, headers: valid.headers });
const replay = await call(claimPath, { body: claimBody, sign: false, headers: valid.headers });
record('valid_credential_accepted_first_use', (s) => s !== 403, first.status);
record('replayed_credential_rejected', 403, replay.status);

// ---- 8. signed body substitution -------------------------------------------
const forSwap = signer.sign({ method: 'POST', path: claimPath, rawBody: Buffer.from(JSON.stringify(claimBody)) });
record(
  'substituted_body_rejected',
  403,
  (
    await call(claimPath, {
      body: { workerId: 'attacker', capabilities: ['chromium'] },
      sign: false,
      headers: forSwap.headers,
    })
  ).status,
);

// ---- 9. signed request for an unknown task ---------------------------------
const missingTask = '/internal/v1/tasks/00000000-0000-0000-0000-000000000000/heartbeat';
const missing = await call(missingTask, {
  body: { fencingToken: 1, contextVersion: 1 },
  headers: { 'x-lease-token': 'not-a-lease' },
});
record(
  'signed_but_unknown_task_not_found',
  404,
  missing.status,
  { note: 'authentication passed, business lookup refused' },
);

// ---- 10. wrong service id ---------------------------------------------------
const wrongService = new InternalServiceSigner({
  serviceId: 'not-a-service',
  keyVersion: 1,
  secret,
});
record(
  'unknown_service_rejected',
  403,
  (await call(claimPath, { body: claimBody, rawSigner: wrongService })).status,
);

const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify(
    {
      apiBase,
      serviceId,
      keyVersion: entry.activeVersion,
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      results,
    },
    null,
    2,
  ),
);
process.exit(failed.length === 0 ? 0 : 1);
