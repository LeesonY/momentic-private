// Pure Node: the real bridge, the real AUTH-6 flow and the real AUTH-5 private
// port over synthetic primitives, with a labeled Fake RuntimeClient and labeled
// Fake private services. The real beginAuthExecution / capture CAS / OTP service
// wiring is NOT implemented, so nothing here claims a service-verified capture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivateAuthPort } from '@localqa/browser';
import { runAuthFlow } from '../dist/auth-flow.js';
import { createAuthRuntimeBridge } from '../dist/auth-runtime.js';

const user = 'vault-username-6b';
const secret = 'vault-password-6b';
const otp = 'vault-otp-6b';
const ticket = 'capture-ticket-6b';
const stateRef = 'state-ref-6b';
const leaseToken = 'lease-token-6b-private';
const origin = 'http://localhost:8080';
const permitUrl = `${origin}/permit-login`;
const nowIso = '2026-10-07T00:00:00.000Z';
const deadline = '2026-10-07T00:30:00.000Z';
const expiresAt = '2026-10-08T00:00:00.000Z';
const materialExpiresAt = '2026-10-07T00:10:00.000Z';

const binding = {
  sessionId: 'sess-6b',
  projectId: 'proj-6b',
  runId: 'run-6b',
  taskId: 'task-6b',
  workerId: 'worker-6b',
  fencingToken: 4,
  contextVersion: 2,
  contextId: 'ctx-6b',
  profileId: 'profile-6b',
  profileVersion: 3,
  authEpoch: 1,
  purpose: 'initializer',
  status: 'active',
  expiresAt,
};
const proof = {
  taskId: binding.taskId,
  fencingToken: binding.fencingToken,
  leaseToken,
  contextVersion: binding.contextVersion,
};

const locators = {
  usernameTarget: { by: 'label', value: 'user-field' },
  passwordTarget: { by: 'label', value: 'pass-field' },
  submitTarget: { by: 'role', value: 'button', name: 'Sign in' },
  otpTarget: { by: 'label', value: 'otp-field' },
};

function formProfile() {
  return {
    id: binding.profileId,
    projectId: binding.projectId,
    environmentId: null,
    name: 'Fixture auth profile',
    mode: 'form',
    allowedOrigins: [origin],
    sharingPolicy: 'exclusive_run',
    hasSecret: true,
    version: binding.profileVersion,
    status: 'active',
    formConfig: {
      loginUrl: `${origin}/profile-login`,
      ...locators,
      successCriterion: {
        id: 'logged-in',
        kind: 'element_visible',
        description: 'Account menu is visible',
        sourceKind: 'user_spec',
        sourceRef: 'fixture',
        locator: { by: 'test_id', value: 'account-menu' },
      },
    },
  };
}

let snapshotSeed = 0;
function snapshot(label) {
  snapshotSeed += 1;
  return {
    snapshotId: `11111111-1111-4111-8111-${String(snapshotSeed).padStart(12, '0')}`,
    pageId: '22222222-2222-4222-8222-222222222222',
    frameIds: ['main'],
    displayUrl: permitUrl,
    title: label,
    responseStatus: 200,
    capturedAt: nowIso,
    stateVersion: snapshotSeed,
    viewport: { width: 800, height: 600 },
    nodes: [
      {
        nodeId: 'user-field',
        frameId: 'main',
        role: 'textbox',
        name: 'User',
        text: 'User',
        visible: true,
        enabled: true,
        bounds: { left: 0, top: 0, width: 10, height: 10 },
      },
    ],
    screenshotRef: 'shot-6b',
    networkSummary: [],
    consoleSummary: [],
    truncated: false,
    redacted: true,
  };
}

function fakeBrowser() {
  const calls = [];
  return {
    calls,
    primitives: {
      async navigate(url) {
        calls.push('navigate');
        assert.equal(url, permitUrl);
        return snapshot('login');
      },
      async fill(target) {
        calls.push(`fill:${target.nodeId}`);
        return snapshot('filled');
      },
      async submit() {
        calls.push('submit');
        return snapshot('submitted');
      },
      async prepareState() {
        calls.push('prepare_state');
      },
      async exportState() {
        calls.push('export_state');
        return {
          cookies: [
            {
              name: 'auth',
              value: secret,
              domain: 'localhost',
              path: '/',
              expires: -1,
              httpOnly: true,
              secure: false,
              sameSite: 'Lax',
            },
          ],
        };
      },
    },
  };
}

/**
 * Fake RuntimeClient: mirrors the real facade signatures
 * (proof, sessionId, grantId, receipt, outcome) but talks to no service.
 * The ordinary `grant`/`record` channel exists only to prove it stays unused.
 */
function fakeClient(config = {}) {
  const log = {
    proofs: [],
    grantAuth: [],
    begin: [],
    record: [],
    observation: [],
    ordinary: [],
  };
  let grantSeed = 0;
  let beginSeed = 0;
  // `*Error` is a static error; `on*` is a per-call hook returning an error.
  const note = (method, proofValue) => {
    log.proofs.push(proofValue);
    const error = config[`${method}Error`];
    return error ?? null;
  };
  const client = {
    async grantAuth(proofValue, request) {
      log.grantAuth.push({ request });
      const hookError = config.onGrantAuth?.(log.grantAuth.length) ?? null;
      if (hookError) throw hookError;
      const error = note('grantAuth', proofValue);
      if (error) throw error;
      grantSeed += 1;
      return {
        grantId: `permit-${grantSeed}`,
        ...binding,
        deadline,
        action: request.action,
        slot: request.slot,
        ...(request.target ? { target: { ...request.target } } : {}),
        ...(request.action === 'navigate_auth' ? { url: permitUrl } : {}),
        ...(config.tamperPermit?.(request) ?? {}),
      };
    },
    async recordAuthObservation(proofValue, sessionId, snapshotValue) {
      log.observation.push({ sessionId, snapshotId: snapshotValue.snapshotId });
      const error = note('observation', proofValue);
      if (error) throw error;
      return snapshotValue;
    },
    async beginAuthExecution(proofValue, sessionId, grantId) {
      log.begin.push({ sessionId, grantId });
      const hookError = config.onBegin?.(log.begin.length, grantId) ?? null;
      if (hookError) throw hookError;
      const error = note('begin', proofValue);
      if (error) throw error;
      beginSeed += 1;
      return {
        grantId,
        executionId: `exec-${beginSeed}`,
        startedAt: nowIso,
      };
    },
    async recordAuth(proofValue, sessionId, grantId, receipt, outcome) {
      log.record.push({ sessionId, grantId, receipt, outcome });
      const hookError = config.onRecord?.(log.record.length) ?? null;
      if (hookError) throw hookError;
      const error = note('record', proofValue);
      if (error) throw error;
    },
    // Ordinary channels that auth intents must never use.
    async grant() {
      log.ordinary.push('grant');
      throw new Error('ordinary grant must not be used');
    },
    async record() {
      log.ordinary.push('record');
      throw new Error('ordinary record must not be used');
    },
  };
  return { client, log };
}

/** Fake private services: the real ones are NOT implemented in this batch. */
function fakeServices(config = {}) {
  const log = {
    material: 0,
    otp: 0,
    criterion: [],
    captureGrant: 0,
    export: [],
    capture: [],
    finish: [],
  };
  const services = {
    async material() {
      log.material += 1;
      return (
        config.material ?? {
          mode: 'form',
          material: { username: user, password: secret },
          expiresAt: materialExpiresAt,
        }
      );
    },
    async pauseForOtp() {
      log.otp += 1;
      return { code: otp };
    },
    async recordAuthCriterion(_snapshot, result) {
      log.criterion.push(result.result);
    },
    async issueCaptureGrant() {
      log.captureGrant += 1;
      return {
        grantId: 'capture-6b',
        ...binding,
        deadline,
        kind: 'capture_auth_state',
        captureTicket: ticket,
      };
    },
    async authorizeExport(grant) {
      log.export.push(grant.grantId);
      if (config.exportError) throw config.exportError;
    },
    async captureAuthState(grant, state) {
      log.capture.push({
        grantId: grant.grantId,
        cookies: state.cookies?.length ?? 0,
      });
      return { stateRef };
    },
    async finishAuth(ref) {
      log.finish.push(ref);
    },
  };
  for (const name of config.missing ?? []) delete services[name];
  return { services, log };
}

function adapters() {
  return {
    async locate(snapshotValue, locator) {
      const nodeId =
        locator.value === locators.submitTarget.value
          ? 'submit-button'
          : locator.value;
      return {
        snapshotId: snapshotValue.snapshotId,
        pageId: snapshotValue.pageId,
        frameId: 'main',
        nodeId,
      };
    },
    async evaluate(_snapshotValue, criterion) {
      return {
        criterionId: criterion.id,
        result: 'passed',
        reason: 'synthetic criterion result',
        evidenceRefs: [],
      };
    },
  };
}

function scenario(config = {}) {
  const client = fakeClient(config.client);
  const services = fakeServices(config.services);
  const bridge = createAuthRuntimeBridge({
    client: client.client,
    proof,
    binding,
    services: services.services,
  });
  const browser = fakeBrowser();
  const port = createPrivateAuthPort({
    binding,
    gate: bridge.gate,
    primitives: browser.primitives,
    allowedOrigins: [origin],
    now: () => Date.parse(nowIso),
  });
  let seed = 0;
  const options = {
    profile: config.profile ?? formProfile(),
    binding,
    runtime: bridge.runtime,
    port,
    adapters: adapters(),
    newRequestId: () => `request-${(seed += 1)}`,
    now: () => Date.parse(nowIso),
  };
  return {
    bridge,
    client,
    services,
    browser,
    port,
    options,
    run: (signal = new AbortController().signal) =>
      runAuthFlow(options, signal),
  };
}

test('the bridge forwards the frozen proof and keeps the lease token private', async () => {
  const world = scenario();
  const outcome = await world.run();
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.stateRef, stateRef);

  // Every service call used the same frozen copy of the proof.
  assert.ok(world.client.log.proofs.length >= 8);
  for (const forwarded of world.client.log.proofs) {
    assert.equal(forwarded, world.client.log.proofs[0]);
    assert.equal(Object.isFrozen(forwarded), true);
    assert.deepEqual(forwarded, proof);
  }
  for (const call of [
    ...world.client.log.grantAuth,
    ...world.client.log.begin,
    ...world.client.log.record,
    ...world.client.log.observation,
  ]) {
    assert.equal(call.sessionId ?? binding.sessionId, binding.sessionId);
  }
  // beginAuthExecution runs before the matching browser effect and the receipt
  // reaches exactly one recordAuth call.
  assert.equal(world.client.log.begin.length, 6);
  assert.deepEqual(
    world.client.log.begin.map((call) => call.grantId),
    world.client.log.record.map((call) => call.grantId),
  );
  assert.deepEqual(
    world.client.log.record.map((call) => call.receipt.executionId),
    ['exec-1', 'exec-2', 'exec-3', 'exec-4', 'exec-5', 'exec-6'],
  );
  assert.equal(
    world.client.log.record.every(
      (call) => call.receipt.grantId === call.grantId,
    ),
    true,
  );
  assert.equal(
    world.client.log.record.every(
      (call) => call.outcome.status === 'succeeded',
    ),
    true,
  );
  // The receipt and the token never enter the outcome or an enumerable return.
  const exposed = JSON.stringify({
    outcome,
    bridge: Object.keys(world.bridge),
    runtime: Object.keys(world.bridge.runtime),
    gate: Object.keys(world.bridge.gate),
  });
  assert.equal(exposed.includes(leaseToken), false);
  assert.equal(exposed.includes('exec-'), false);
  assert.equal(exposed.includes(ticket), false);
  assert.equal(exposed.includes(secret), false);
  assert.equal(exposed.includes(user), false);
  // No ordinary grant/record channel was touched, and the capture ran once.
  assert.deepEqual(world.client.log.ordinary, []);
  assert.deepEqual(world.services.log.export, ['capture-6b']);
  assert.deepEqual(world.services.log.finish, [stateRef]);
  assert.equal(world.services.log.otp, 1);
  assert.deepEqual(world.services.log.criterion, ['passed']);
  assert.deepEqual(world.browser.calls, [
    'navigate',
    'fill:user-field',
    'fill:pass-field',
    'submit',
    'fill:otp-field',
    'submit',
    'export_state',
  ]);
});

test('permits and port bindings are re-verified against the frozen binding', async () => {
  const tampering = [
    { name: 'sessionId', patch: { sessionId: 'sess-other' } },
    { name: 'taskId', patch: { taskId: 'task-other' } },
    { name: 'runId', patch: { runId: 'run-other' } },
    { name: 'projectId', patch: { projectId: 'proj-other' } },
    { name: 'workerId', patch: { workerId: 'worker-other' } },
    { name: 'fencingToken', patch: { fencingToken: 9 } },
    { name: 'contextVersion', patch: { contextVersion: 7 } },
    { name: 'contextId', patch: { contextId: 'ctx-other' } },
    { name: 'profileId', patch: { profileId: 'profile-other' } },
    { name: 'profileVersion', patch: { profileVersion: 8 } },
    { name: 'authEpoch', patch: { authEpoch: 2 } },
    { name: 'purpose', patch: { purpose: 'importer' } },
    { name: 'action', patch: { action: 'submit_auth' } },
    { name: 'slot', patch: { slot: 'otp' } },
  ];
  for (const scenarioCase of tampering) {
    const world = scenario({
      client: { tamperPermit: () => scenarioCase.patch },
    });
    const outcome = await world.run();
    assert.equal(outcome.status, 'blocked', scenarioCase.name);
    assert.equal(outcome.reasonCode, 'LEASE_EXPIRED', scenarioCase.name);
    assert.deepEqual(world.browser.calls, [], scenarioCase.name);
    assert.deepEqual(world.client.log.begin, [], scenarioCase.name);
  }

  // A port belonging to another session cannot authorize either.
  const world = scenario();
  await assert.rejects(
    world.bridge.gate.authorize({
      binding: { ...binding, sessionId: 'sess-other' },
      permit: {
        grantId: 'permit-x',
        ...binding,
        deadline,
        action: 'navigate_auth',
        slot: 'login_url',
        url: permitUrl,
      },
    }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.deepEqual(world.client.log.begin, []);
});

test('receipts cannot be borrowed, replayed, or settled twice', async () => {
  const world = scenario();
  const begin = world.bridge.gate.authorize.bind(world.bridge.gate);
  const goodPermit = {
    grantId: 'permit-a',
    ...binding,
    deadline,
    action: 'navigate_auth',
    slot: 'login_url',
    url: permitUrl,
  };
  await begin({ binding, permit: goodPermit });
  assert.equal(world.client.log.begin.length, 1);

  // Second begin for the same grant is refused locally.
  await assert.rejects(
    begin({ binding, permit: goodPermit }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.equal(world.client.log.begin.length, 1);

  // A grant without a receipt cannot be settled.
  await assert.rejects(
    world.bridge.runtime.recordAuth(
      { ...goodPermit, grantId: 'permit-never-begun' },
      { status: 'succeeded', reasonCode: 'AUTH_ACTION_SUCCEEDED' },
    ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  // A receipt from another session cannot settle this session's permit.
  await assert.rejects(
    world.bridge.runtime.recordAuth(
      { ...goodPermit, sessionId: 'sess-other' },
      { status: 'succeeded', reasonCode: 'AUTH_ACTION_SUCCEEDED' },
    ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  // A receipt for permit-a cannot settle permit-b.
  await assert.rejects(
    world.bridge.runtime.recordAuth(
      { ...goodPermit, grantId: 'permit-b' },
      { status: 'succeeded', reasonCode: 'AUTH_ACTION_SUCCEEDED' },
    ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.deepEqual(world.client.log.record, []);

  // The legitimately begun grant settles through its own receipt.
  await world.bridge.runtime.recordAuth(goodPermit, {
    status: 'succeeded',
    reasonCode: 'AUTH_ACTION_SUCCEEDED',
  });
  assert.equal(world.client.log.record.length, 1);
  assert.equal(world.client.log.record[0].grantId, 'permit-a');
  assert.equal(world.client.log.record[0].receipt.executionId, 'exec-1');
  assert.deepEqual(world.client.log.record[0].outcome, { status: 'succeeded' });

  // Concurrent begins for one grant: exactly one reaches the service.
  const racing = scenario();
  const racingPermit = { ...goodPermit, grantId: 'permit-race' };
  const results = await Promise.allSettled([
    racing.bridge.gate.authorize({ binding, permit: racingPermit }),
    racing.bridge.gate.authorize({ binding, permit: racingPermit }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(racing.client.log.begin.length, 1);
});

test('expiry, revocation, and service failures stop the flow without caching', async () => {
  // beginAuthExecution refuses mid-flow: no browser effect may follow.
  const expired = scenario({
    client: {
      onBegin: (index) =>
        index === 3
          ? Object.assign(new Error('expired'), { code: 'LEASE_EXPIRED' })
          : null,
    },
  });
  const expiredOutcome = await expired.run();
  assert.equal(expiredOutcome.status, 'blocked');
  assert.equal(expiredOutcome.reasonCode, 'LEASE_EXPIRED');
  assert.equal(expiredOutcome.stateRef, null);
  assert.deepEqual(expired.browser.calls, ['navigate', 'fill:user-field']);
  assert.equal(expired.services.log.captureGrant, 0);

  // grantAuth refused: the flow stops before any browser effect.
  const refused = scenario({
    client: {
      grantAuthError: Object.assign(new Error('rate'), {
        code: 'RATE_LIMITED',
      }),
    },
  });
  const refusedOutcome = await refused.run();
  assert.equal(refusedOutcome.status, 'blocked');
  assert.equal(refusedOutcome.reasonCode, 'RATE_LIMITED');
  assert.deepEqual(refused.browser.calls, []);

  // No cached "active" value: a later call still reaches the service.
  const before = refused.client.log.grantAuth.length;
  await assert.rejects(
    refused.bridge.runtime.grantAuth({
      requestId: 'request-after-expiry',
      sessionId: binding.sessionId,
      action: 'navigate_auth',
      slot: 'login_url',
    }),
    (error) => error.code === 'RATE_LIMITED',
  );
  assert.equal(refused.client.log.grantAuth.length, before + 1);

  // The private ledger refuses the settle: never a success.
  const ledgerDown = scenario({
    client: {
      onRecord: (index) =>
        index === 2
          ? Object.assign(new Error('denied'), { code: 'POLICY_DENIED' })
          : null,
    },
  });
  const ledgerOutcome = await ledgerDown.run();
  assert.equal(ledgerOutcome.status, 'blocked');
  assert.equal(ledgerOutcome.reasonCode, 'POLICY_DENIED');
  assert.equal(ledgerOutcome.stateRef, null);
  assert.equal(ledgerDown.services.log.captureGrant, 0);
  assert.equal(ledgerDown.services.log.finish.length, 0);

  // A rejected export gate keeps the capture from running.
  const deniedExport = scenario({
    services: {
      exportError: Object.assign(new Error('ticket'), {
        code: 'POLICY_DENIED',
      }),
    },
  });
  const deniedOutcome = await deniedExport.run();
  assert.equal(deniedOutcome.status, 'blocked');
  assert.deepEqual(
    deniedExport.browser.calls.filter((call) => call === 'export_state'),
    [],
  );
  assert.equal(deniedExport.services.log.capture.length, 0);
  assert.equal(deniedExport.services.log.finish.length, 0);
});

test('a missing service blocks instead of fabricating a capture', async () => {
  // The export has to happen before the capture can fail, so only the steps up
  // to the capture-ticket gate must stay free of any export.
  const missing = [
    { name: 'material', exports: 0 },
    { name: 'pauseForOtp', exports: 0 },
    { name: 'recordAuthCriterion', exports: 0 },
    { name: 'issueCaptureGrant', exports: 0 },
    { name: 'authorizeExport', exports: 0 },
    { name: 'captureAuthState', exports: 1 },
    { name: 'finishAuth', exports: 1 },
  ];
  for (const scenarioCase of missing) {
    const world = scenario({ services: { missing: [scenarioCase.name] } });
    const outcome = await world.run();
    assert.equal(outcome.status, 'blocked', scenarioCase.name);
    assert.equal(outcome.stateRef, null, scenarioCase.name);
    // The capture-ticket gate is the one place the port only accepts three
    // codes, so a missing CAS service surfaces as VALIDATION_ERROR there.
    assert.equal(
      outcome.reasonCode,
      scenarioCase.name === 'authorizeExport'
        ? 'VALIDATION_ERROR'
        : 'SERVICE_UNAVAILABLE',
      scenarioCase.name,
    );
    assert.equal(
      world.browser.calls.filter((call) => call === 'export_state').length,
      scenarioCase.exports,
      scenarioCase.name,
    );
    assert.equal(world.services.log.finish.length, 0, scenarioCase.name);
  }
});

test('construction refuses an incomplete client, proof, or inactive binding', async () => {
  const { client } = fakeClient();
  const { services } = fakeServices();
  const refuse = (options) =>
    assert.throws(
      () => createAuthRuntimeBridge(options),
      (error) =>
        error.code === 'VALIDATION_ERROR' &&
        error.message === 'VALIDATION_ERROR',
    );
  for (const method of [
    'grantAuth',
    'recordAuthObservation',
    'beginAuthExecution',
    'recordAuth',
  ]) {
    refuse({
      client: { ...client, [method]: undefined },
      proof,
      binding,
      services,
    });
  }
  refuse({ client, proof: { ...proof, leaseToken: '' }, binding, services });
  refuse({ client, proof, binding: { ...binding, status: 'ended' }, services });
  refuse({ client, proof, binding: { ...binding, sessionId: '' }, services });
  const built = createAuthRuntimeBridge({ client, proof, binding, services });
  assert.deepEqual(Object.keys(built).sort(), ['gate', 'runtime']);
  assert.equal(Object.keys(built.runtime).length, 10);
  await assert.rejects(
    built.runtime.finishSignIn(),
    (error) => error.code === 'SERVICE_UNAVAILABLE',
  );
});

test('service methods keep their receiver and a throwing accessor is contained', async () => {
  const world = scenario();
  const seen = [];
  for (const name of Object.keys(world.services.services)) {
    const original = world.services.services[name];
    world.services.services[name] = async function (...args) {
      seen.push([name, this === world.services.services]);
      return original.apply(this, args);
    };
  }
  const outcome = await world.run();
  assert.equal(outcome.status, 'succeeded');
  assert.ok(seen.length >= 6);
  assert.equal(
    seen.every(([, sameReceiver]) => sameReceiver),
    true,
  );

  const throwing = scenario();
  let accessed = 0;
  Object.defineProperty(throwing.services.services, 'material', {
    enumerable: true,
    get() {
      accessed += 1;
      throw new Error(secret);
    },
  });
  const throwingOutcome = await throwing.run();
  assert.equal(throwingOutcome.status, 'blocked');
  assert.equal(throwingOutcome.reasonCode, 'VALIDATION_ERROR');
  assert.equal(JSON.stringify(throwingOutcome).includes(secret), false);
  assert.deepEqual(throwing.browser.calls, []);
  // The accessor was consulted once and its failure was contained.
  assert.equal(accessed, 1);
});
