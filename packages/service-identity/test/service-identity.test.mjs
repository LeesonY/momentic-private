import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  InternalServiceSigner,
  InternalServiceVerifier,
  SERVICE_IDENTITY_HEADERS,
  computeInternalSignature,
  loadServiceClientCredential,
} from '../dist/index.js';

const workerKeyOld = Buffer.alloc(32, 1);
const workerKeyNew = Buffer.alloc(32, 2);
const orchestratorKey = Buffer.alloc(32, 3);
const workerKeyBase64 = workerKeyOld.toString('base64');
const workerKeyNewBase64 = workerKeyNew.toString('base64');
const orchestratorKeyBase64 = orchestratorKey.toString('base64');

function documentWith(workerActive, workerKeys) {
  return {
    activeVersion: 1,
    services: {
      worker: { activeVersion: workerActive, keys: workerKeys },
      orchestrator: { activeVersion: 1, keys: { 1: orchestratorKeyBase64 } },
    },
  };
}

const TEST_NOW = 1_700_000_000_000;

const signer = (key, keyVersion = 1) =>
  new InternalServiceSigner({
    serviceId: 'worker',
    keyVersion,
    secret: key,
    now: () => TEST_NOW,
  });

const body = new TextEncoder().encode('{"workerId":"w1","capabilities":["chromium"]}');
const request = {
  method: 'POST',
  path: '/internal/v1/leases/claim?projectId=00000000-0000-0000-0000-000000000001',
  rawBody: body,
};

function headersFor(key, overrides = {}, keyVersion = 1) {
  const signed = signer(key, keyVersion).sign(request);
  return { ...signed.headers, ...overrides };
}

function verify(headers, overrides = {}, doc = documentWith(1, { 1: workerKeyBase64 })) {
  const verifier = new InternalServiceVerifier(doc, { now: () => TEST_NOW });
  return verifier.verify({ ...request, ...overrides, headers });
}

test('a correctly signed internal request is accepted', () => {
  const verifier = new InternalServiceVerifier(
    documentWith(1, { 1: workerKeyBase64 }),
    { now: () => TEST_NOW },
  );
  const signed = new InternalServiceSigner({
    serviceId: 'worker',
    keyVersion: 1,
    secret: workerKeyOld,
    now: () => TEST_NOW,
  }).sign(request);
  const result = verifier.verify({ ...request, headers: signed.headers });
  assert.equal(result.serviceId, 'worker');
});

test('missing credential headers are rejected', () => {
  assert.throws(() => verify({}), /credential is required/);
  for (const header of Object.values(SERVICE_IDENTITY_HEADERS)) {
    const headers = headersFor(workerKeyOld);
    delete headers[header];
    assert.throws(
      () => verify(headers),
      /credential is required/,
      `removing ${header} must be rejected`,
    );
  }
});

test('a self-declared worker identity alone is not a credential', () => {
  assert.throws(
    () => verify({ 'x-worker-id': 'worker-forged', 'x-project-id': 'p' }),
    /credential is required/,
  );
});

test('signed with a key that is not in the ring is rejected', () => {
  const headers = headersFor(Buffer.alloc(32, 9));
  assert.throws(() => verify(headers), /signature does not match/);
});

test('signed by an unconfigured service is rejected', () => {
  const signed = new InternalServiceSigner({
    serviceId: 'attacker',
    keyVersion: 1,
    secret: workerKeyOld,
    now: () => TEST_NOW,
  }).sign(request);
  assert.throws(
    () => verify(signed.headers),
    /not recognized/,
  );
});

test('a revoked key version is rejected even with a correct signature', () => {
  // Rotation happened: version 2 is active and version 1 was revoked.
  const rotated = documentWith(2, { 2: workerKeyNewBase64 });
  const signedOld = signer(workerKeyOld, 1).sign(request);
  assert.throws(
    () => verify(signedOld.headers, {}, rotated),
    /key version is not accepted/,
  );
  // The rotated key works.
  const signedNew = signer(workerKeyNew, 2).sign(request);
  assert.equal(
    verify(signedNew.headers, {}, rotated).serviceId,
    'worker',
  );
});

test('rotation overlap accepts both the old and the new key', () => {
  const overlapping = documentWith(2, {
    1: workerKeyBase64,
    2: workerKeyNewBase64,
  });
  assert.equal(
    verify(signer(workerKeyOld, 1).sign(request).headers, {}, overlapping)
      .serviceId,
    'worker',
  );
  assert.equal(
    verify(signer(workerKeyNew, 2).sign(request).headers, {}, overlapping)
      .serviceId,
    'worker',
  );
});

test('a tampered body is rejected (signature covers the body)', () => {
  const headers = headersFor(workerKeyOld);
  const tampered = new TextEncoder().encode(
    '{"workerId":"w1","capabilities":["chromium"],"extra":1}',
  );
  assert.throws(
    () => verify(headers, { rawBody: tampered }),
    /signature does not match/,
  );
});

test('a tampered path or method is rejected', () => {
  const headers = headersFor(workerKeyOld);
  assert.throws(
    () => verify(headers, { path: '/internal/v1/auth/resolve' }),
    /signature does not match/,
  );
  assert.throws(
    () => verify(headers, { method: 'GET' }),
    /signature does not match/,
  );
  // Query strings are part of the signed target.
  assert.throws(
    () =>
      verify(headers, {
        path: '/internal/v1/leases/claim?projectId=00000000-0000-0000-0000-000000000002',
      }),
    /signature does not match/,
  );
});

test('a stale credential is rejected', () => {
  const verifier = new InternalServiceVerifier(
    documentWith(1, { 1: workerKeyBase64 }),
    { now: () => TEST_NOW + 10 * 60_000 },
  );
  assert.throws(
    () => verifier.verify({ ...request, headers: headersFor(workerKeyOld) }),
    /timestamp is outside the accepted window/,
  );
});

test('a clock skewed back beyond the window is rejected', () => {
  const verifier = new InternalServiceVerifier(
    documentWith(1, { 1: workerKeyBase64 }),
    { now: () => TEST_NOW - 10 * 60_000 },
  );
  assert.throws(
    () => verifier.verify({ ...request, headers: headersFor(workerKeyOld) }),
    /timestamp is outside the accepted window/,
  );
});

test('a replayed credential is rejected', () => {
  const verifier = new InternalServiceVerifier(
    documentWith(1, { 1: workerKeyBase64 }),
    { now: () => TEST_NOW },
  );
  const signed = new InternalServiceSigner({
    serviceId: 'worker',
    keyVersion: 1,
    secret: workerKeyOld,
    now: () => TEST_NOW,
  }).sign(request);
  assert.equal(verifier.verify({ ...request, headers: signed.headers }).serviceId, 'worker');
  assert.throws(
    () => verifier.verify({ ...request, headers: signed.headers }),
    /already used/,
  );
  // A replay attempt with a fresh signature and nonce still works: the gate
  // rejects reused credentials, not legitimate retries.
  const retry = signer(workerKeyOld).sign(request);
  assert.equal(verifier.verify({ ...request, headers: retry.headers }).serviceId, 'worker');
});

test('a credential signed for another request cannot be replayed on a new nonce', () => {
  const headers = headersFor(workerKeyOld);
  const verifier = new InternalServiceVerifier(
    documentWith(1, { 1: workerKeyBase64 }),
    { now: () => TEST_NOW },
  );
  // Same signature, freshly generated nonce: the HMAC binds the nonce.
  const forged = { ...headers, [SERVICE_IDENTITY_HEADERS.nonce]: 'a'.repeat(32) };
  assert.throws(
    () => verifier.verify({ ...request, headers: forged }),
    /signature does not match/,
  );
});

test('cross-service privilege separation holds', () => {
  // The orchestrator key cannot sign for the worker service: the service id is
  // inside the signed string.
  const headers = headersFor(orchestratorKey);
  assert.equal(headers[SERVICE_IDENTITY_HEADERS.service], 'worker');
  assert.throws(() => verify(headers), /signature does not match/);
});

test('malformed credentials fail closed', () => {
  assert.throws(
    () => verify({ ...headersFor(workerKeyOld), [SERVICE_IDENTITY_HEADERS.keyVersion]: 'x' }),
    /key version is malformed/,
  );
  assert.throws(
    () => verify({ ...headersFor(workerKeyOld), [SERVICE_IDENTITY_HEADERS.timestamp]: 'abc' }),
    /timestamp is malformed/,
  );
  assert.throws(
    () => verify({ ...headersFor(workerKeyOld), [SERVICE_IDENTITY_HEADERS.nonce]: 'short' }),
    /nonce is malformed/,
  );
  assert.throws(
    () => verify({ ...headersFor(workerKeyOld), [SERVICE_IDENTITY_HEADERS.signature]: 'beef' }),
    /signature is malformed/,
  );
});

test('the key ring document is validated strictly', () => {
  const verifierCtor = (doc) => new InternalServiceVerifier(doc);
  assert.throws(() => verifierCtor({}), /requires a services map/);
  assert.throws(
    () => verifierCtor({ services: { worker: { activeVersion: 1, keys: {} } } }),
    /has no usable keys/,
  );
  assert.throws(
    () =>
      verifierCtor({
        services: { worker: { activeVersion: 3, keys: { 1: workerKeyBase64 } } },
      }),
    /activeVersion 3 has no key material/,
  );
  assert.throws(
    () => verifierCtor({ services: { Worker: { activeVersion: 1, keys: { 1: workerKeyBase64 } } } }),
    /not a safe identifier/,
  );
  assert.throws(
    () => verifierCtor({ services: { worker: { activeVersion: 1, keys: { 1: 'short' } } } }),
    /at least 32 bytes/,
  );
});

test('the canonical string covers every security-relevant field', () => {
  const credential = {
    serviceId: 'worker',
    keyVersion: 1,
    timestampMs: 1_700_000_000_000,
    nonce: 'ab'.repeat(16),
    method: 'post',
    path: '/internal/v1/x',
    rawBody: new Uint8Array(),
  };
  const canonical = computeInternalSignature(workerKeyOld, credential);
  const baseline = createHash('sha256').digest('hex');
  assert.equal(baseline.length, 64);
  for (const changed of [
    { ...credential, serviceId: 'orchestrator' },
    { ...credential, keyVersion: 2 },
    { ...credential, timestampMs: 1_700_000_000_001 },
    { ...credential, nonce: 'cd'.repeat(16) },
    { ...credential, method: 'GET' },
    { ...credential, path: '/internal/v1/y' },
    { ...credential, rawBody: new TextEncoder().encode(' ') },
  ]) {
    assert.notEqual(computeInternalSignature(workerKeyOld, changed), canonical);
  }
});

test('the client credential loader reads the active version from a key ring file', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'svcid-'));
  const file = join(dir, 'service_identity.json');
  await writeFile(
    file,
    JSON.stringify(documentWith(2, { 1: workerKeyBase64, 2: workerKeyNewBase64 })),
    { mode: 0o600 },
  );
  const credential = await loadServiceClientCredential(file, 'worker');
  assert.equal(credential.serviceId, 'worker');
  assert.equal(credential.keyVersion, 2);
  assert.deepEqual(credential.secret, workerKeyNew);
  await assert.rejects(
    () => loadServiceClientCredential(file, 'missing'),
    /no 'missing' entry/,
  );
  await assert.rejects(
    () => loadServiceClientCredential(join(dir, 'nope.json'), 'worker'),
    /not readable JSON/,
  );
});
