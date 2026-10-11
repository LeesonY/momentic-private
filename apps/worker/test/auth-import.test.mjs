import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { runAuthImport } from '../dist/auth-import.js';

// Actual importer + private port; Fake service/primitive capabilities only.
// No real PG, browser, provider, Worker.once or admission release.
function world(patch = {}) {
  const id = () => randomUUID(),
    expiry = new Date(Date.now() + 60000).toISOString();
  const binding = {
    sessionId: id(),
    projectId: id(),
    runId: id(),
    taskId: id(),
    workerId: 'fake-import-worker',
    fencingToken: 3,
    contextVersion: 1,
    contextId: id(),
    profileId: id(),
    profileVersion: 1,
    authEpoch: 1,
    purpose: 'importer',
    status: 'active',
    expiresAt: expiry,
  };
  const proof = {
    taskId: binding.taskId,
    fencingToken: 3,
    contextVersion: 1,
    leaseToken: 'root-synthetic-private-lease',
  };
  const profile = {
    id: binding.profileId,
    projectId: binding.projectId,
    version: 1,
    status: 'active',
    mode: 'form',
    allowedOrigins: ['http://localhost:8181'],
  };
  const grant = {
    ...binding,
    grantId: id(),
    authStateId: id(),
    kind: 'import_auth_state',
    deadline: expiry,
  };
  const state = {
    cookies: [
      {
        name: 'sid',
        value: 'root-synthetic-cookie',
        domain: 'localhost',
        path: '/',
      },
    ],
    origins: [],
  };
  const receipt = {
    grantId: grant.grantId,
    executionId: randomBytes(32).toString('hex'),
    startedAt: new Date().toISOString(),
  };
  const log = [],
    proofs = [];
  let effects = 0;
  const abort = new AbortController();
  const failure = (name) => {
    if (patch.fail === name) {
      const error = Error('root-private-diagnostic');
      error.code = patch.code ?? 'LEASE_EXPIRED';
      throw error;
    }
  };
  const client = {
    async grantAuthImport(p, s) {
      log.push('grant');
      proofs.push(p);
      assert.equal(s, binding.sessionId);
      failure('grant');
      return { ...grant, ...patch.grant };
    },
    async prepareAuthImport(p, s, g) {
      log.push('prepare');
      proofs.push(p);
      assert.equal(s, binding.sessionId);
      assert.equal(g, grant.grantId);
      failure('prepare');
      patch.afterPrepare?.();
      return {
        grant: { ...grant, ...patch.preparedGrant },
        state: patch.state ?? state,
      };
    },
    async beginAuthImport(p, s, g) {
      log.push('begin');
      proofs.push(p);
      assert.equal(s, binding.sessionId);
      assert.equal(g, grant.grantId);
      failure('begin');
      return { ...receipt, ...patch.receipt };
    },
    async recordAuthImport(p, s, g, r, outcome) {
      log.push(`record:${outcome.status}`);
      proofs.push(p);
      assert.equal(s, binding.sessionId);
      assert.equal(g, grant.grantId);
      assert.equal(r.executionId, receipt.executionId);
      failure('record');
    },
  };
  const forbidden = async () => {
    assert.fail('Forbidden browser primitive reached');
  };
  const primitives = {
    navigate: forbidden,
    fill: forbidden,
    submit: forbidden,
    exportState: forbidden,
    async prepareState(value) {
      log.push('effect');
      effects++;
      assert.equal(value.cookies[0].value, state.cookies[0].value);
      patch.duringEffect?.();
      failure('effect');
    },
  };
  const options = {
    client,
    proof,
    binding,
    profile,
    authStateId: grant.authStateId,
    primitives,
  };
  return {
    options,
    log,
    proofs,
    binding,
    proof,
    grant,
    state,
    abort,
    effects: () => effects,
    run: () => runAuthImport(options, abort.signal),
  };
}

test('Actual importer follows grant/prepare/begin/effect/record using one frozen proof and private outcome', async () => {
  const w = world();
  const result = await w.run();
  assert.deepEqual(result, { status: 'imported', reasonCode: 'AUTH_IMPORTED' });
  assert.deepEqual(w.log, [
    'grant',
    'prepare',
    'begin',
    'effect',
    'record:succeeded',
  ]);
  assert.equal(w.effects(), 1);
  assert.ok(w.proofs.every((p) => p === w.proofs[0] && Object.isFrozen(p)));
  for (const secret of [
    w.proof.leaseToken,
    w.state.cookies[0].value,
    'root-synthetic-private-receipt',
  ])
    assert.equal(JSON.stringify(result).includes(secret), false);
});
test('Every failed service step blocks without repeating it or advancing to a later effect', async () => {
  for (const fail of ['grant', 'prepare', 'begin', 'record']) {
    const w = world({ fail });
    const result = await w.run();
    assert.equal(result.status, 'blocked');
    assert.equal(result.reasonCode, 'LEASE_EXPIRED');
    assert.equal(w.effects(), fail === 'record' ? 1 : 0);
    assert.equal(
      w.log.filter((v) => v === fail || v.startsWith(`${fail}:`)).length,
      1,
    );
  }
});
test('An ambiguous injection failure is recorded unknown once and never imported', async () => {
  const w = world({ fail: 'effect', code: 'unknown-private-code' });
  const result = await w.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'VALIDATION_ERROR');
  assert.deepEqual(w.log, [
    'grant',
    'prepare',
    'begin',
    'effect',
    'record:unknown',
  ]);
  assert.equal(w.effects(), 1);
  assert.equal(
    JSON.stringify(result).includes('root-private-diagnostic'),
    false,
  );
});
test('Server grant or prepare tuple/state/identity/deadline substitution reaches no injection', async () => {
  const changes = [
    { purpose: 'initializer' },
    { contextId: randomUUID() },
    { authEpoch: 2 },
    { profileVersion: 2 },
    { workerId: 'other-worker' },
    { authStateId: randomUUID() },
    { deadline: '2000-01-01T00:00:00.000Z' },
  ];
  for (const change of changes)
    for (const where of ['grant', 'preparedGrant']) {
      const w = world({ [where]: change });
      const result = await w.run();
      assert.equal(result.status, 'blocked');
      assert.equal(w.effects(), 0);
      assert.equal(w.log.includes('begin'), false);
    }
  const w = world({ preparedGrant: { grantId: randomUUID() } });
  assert.equal((await w.run()).status, 'blocked');
  assert.equal(w.effects(), 0);
});
test('Malformed state is rejected before begin or any primitive', async () => {
  const w = world({
    state: {
      cookies: [
        { name: 'sid', value: 'x', domain: 'foreign.example', path: '/' },
      ],
      origins: [],
    },
  });
  assert.equal((await w.run()).status, 'blocked');
  assert.equal(w.effects(), 0);
  assert.equal(w.log.includes('begin'), false);
});

test('Importer accepts heartbeat renewal only after confirming the live server binding', async () => {
  const w = world();
  const firstExpiry = new Date(
    Date.parse(w.binding.expiresAt) + 1000,
  ).toISOString();
  const nextExpiry = new Date(
    Date.parse(w.binding.expiresAt) + 2000,
  ).toISOString();
  const grant = w.options.client.grantAuthImport;
  const prepare = w.options.client.prepareAuthImport;
  w.options.client.grantAuthImport = async (...args) => ({
    ...(await grant(...args)),
    expiresAt: firstExpiry,
  });
  w.options.client.prepareAuthImport = async (...args) => {
    const result = await prepare(...args);
    return { ...result, grant: { ...result.grant, expiresAt: nextExpiry } };
  };
  let confirmations = 0;
  w.options.client.authSession = async (proof, sessionId) => {
    assert.equal(proof.taskId, w.proof.taskId);
    assert.equal(sessionId, w.binding.sessionId);
    confirmations++;
    return { ...w.binding, expiresAt: nextExpiry };
  };
  assert.deepEqual(await w.run(), {
    status: 'imported',
    reasonCode: 'AUTH_IMPORTED',
  });
  assert.equal(w.effects(), 1);
  assert.ok(confirmations >= 3);
});

test('Renewed grants cannot exceed live authority or substitute its identity', async () => {
  for (const change of [
    { contextId: randomUUID() },
    { authEpoch: 2 },
    { profileVersion: 2 },
    { status: 'ended' },
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
  ]) {
    const w = world();
    const expiresAt = new Date(
      Date.parse(w.binding.expiresAt) + 1000,
    ).toISOString();
    const grant = w.options.client.grantAuthImport;
    w.options.client.grantAuthImport = async (...args) => ({
      ...(await grant(...args)),
      expiresAt,
    });
    w.options.client.authSession = async () => ({
      ...w.binding,
      expiresAt,
      ...change,
    });
    assert.equal((await w.run()).status, 'blocked');
    assert.equal(w.effects(), 0);
    assert.equal(w.log.includes('begin'), false);
  }
  const w = world();
  const grant = w.options.client.grantAuthImport;
  w.options.client.grantAuthImport = async (...args) => ({
    ...(await grant(...args)),
    expiresAt: new Date(Date.parse(w.binding.expiresAt) + 2000).toISOString(),
  });
  w.options.client.authSession = async () => ({
    ...w.binding,
    expiresAt: new Date(Date.parse(w.binding.expiresAt) + 1000).toISOString(),
  });
  assert.equal((await w.run()).status, 'blocked');
  assert.equal(w.effects(), 0);
});
test('none policy has zero service/port interaction; revoked policy blocks', async () => {
  const w = world();
  w.options.profile.mode = 'none';
  const result = await w.run();
  assert.equal(result.status, 'not_required');
  assert.deepEqual(w.log, []);
  w.options.profile.status = 'revoked';
  assert.equal((await w.run()).status, 'blocked');
  assert.deepEqual(w.log, []);
});
test('Abort before begin prevents injection; abort during injection records cancellation and cannot import', async () => {
  const before = world();
  before.abort.abort();
  assert.equal((await before.run()).status, 'cancelled');
  assert.deepEqual(before.log, []);
  let during;
  during = world({ duringEffect: () => during.abort.abort() });
  assert.equal((await during.run()).status, 'cancelled');
  assert.equal(during.effects(), 1);
  assert.equal(during.log.at(-1), 'record:cancelled');
});
test('Caller mutation after prepare cannot replace the proof used to settle failure', async () => {
  let w;
  w = world({
    fail: 'effect',
    afterPrepare: () => {
      w.options.proof.leaseToken = 'changed-token';
      w.options.binding.workerId = 'changed-worker';
    },
  });
  assert.equal((await w.run()).status, 'blocked');
  assert.ok(
    w.proofs.every(
      (p) =>
        p.leaseToken === 'root-synthetic-private-lease' && Object.isFrozen(p),
    ),
  );
  assert.equal(w.log.at(-1), 'record:unknown');
});

test('Malformed begin receipt cannot authorize any injection', async () => {
  for (const receipt of [
    { grantId: randomUUID() },
    { executionId: '' },
    { executionId: 'not-a-capability' },
    { startedAt: 'invalid-time' },
  ]) {
    const w = world({ receipt });
    assert.equal((await w.run()).status, 'blocked');
    assert.equal(w.effects(), 0);
    assert.equal(w.log.includes('record:succeeded'), false);
  }
});
