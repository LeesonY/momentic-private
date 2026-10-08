// Pure Node: the real auth-services adapter, the real AUTH-6B bridge, the real
// AUTH-6 flow and the real AUTH-5 private port, over synthetic primitives and a
// labeled Fake service client that mirrors the real RuntimeClient signatures and
// the documented server semantics. No PG, no browser, no Coordinator.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivateAuthPort } from '@localqa/browser';
import { runAuthFlow } from '../dist/auth-flow.js';
import { createAuthRuntimeBridge } from '../dist/auth-runtime.js';
import { createAuthServices } from '../dist/auth-services.js';

const user = 'vault-username-7b';
const secret = 'vault-password-7b';
const otp = 'vault-otp-7b';
const ticket = 'capture-ticket-7b';
const authStateId = 'auth-state-id-7b';
const leaseToken = 'lease-token-7b-private';
const origin = 'http://localhost:8080';
const permitUrl = `${origin}/permit-login`;
const nowIso = '2026-10-08T00:00:00.000Z';
const deadline = '2026-10-08T00:30:00.000Z';
const expiresAt = '2026-10-09T00:00:00.000Z';
const materialExpiresAt = '2026-10-08T00:10:00.000Z';

const binding = {
  sessionId: 'sess-7b',
  projectId: 'proj-7b',
  runId: 'run-7b',
  taskId: 'task-7b',
  workerId: 'worker-7b',
  fencingToken: 4,
  contextVersion: 2,
  contextId: 'ctx-7b',
  profileId: 'profile-7b',
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

function formProfile({ withOtp = false } = {}) {
  const config = {
    loginUrl: `${origin}/profile-login`,
    usernameTarget: locators.usernameTarget,
    passwordTarget: locators.passwordTarget,
    submitTarget: locators.submitTarget,
    successCriterion: {
      id: 'logged-in',
      kind: 'element_visible',
      description: 'Account menu is visible',
      sourceKind: 'user_spec',
      sourceRef: 'fixture',
      locator: { by: 'test_id', value: 'account-menu' },
    },
    ...(withOtp ? { otpTarget: locators.otpTarget } : {}),
  };
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
    formConfig: config,
  };
}

function storageProfile() {
  return { ...formProfile(), mode: 'storage_state', formConfig: null };
}

const storageCriterion = {
  id: 'captured-state-ok',
  kind: 'url_matches',
  description: 'Landed on the frozen target',
  sourceKind: 'generic_smoke',
  sourceRef: 'fixture',
  expectedValue: permitUrl,
};

const secretInputFixture = JSON.stringify({
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
  origins: [],
});

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
    screenshotRef: 'shot-7b',
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
 * Fake service client: mirrors the five real RuntimeClient signatures and the
 * documented server semantics (only a passed frozen criterion issues a gate,
 * storage_state refuses the capture gate, the ticket is bound to its grant).
 */
function fakeServiceClient(config = {}) {
  const log = {
    material: [],
    criterion: [],
    grant: [],
    begin: [],
    capture: [],
    finish: [],
    proofs: [],
  };
  let gateSeed = 0;
  let grantSeed = 0;
  const client = {
    async authMaterial(proofValue, sessionId) {
      log.material.push({ sessionId });
      log.proofs.push(proofValue);
      if (config.materialError) throw config.materialError;
      return (
        config.material ?? {
          mode: 'form',
          material: { username: user, password: secret },
          expiresAt: materialExpiresAt,
        }
      );
    },
    async recordAuthCriterion(
      proofValue,
      sessionId,
      criterionResult,
      snapshotId,
    ) {
      log.criterion.push({ sessionId, criterionResult, snapshotId });
      log.proofs.push(proofValue);
      const hookError = config.onCriterion?.(log.criterion.length) ?? null;
      if (hookError) throw hookError;
      if (config.criterionError) throw config.criterionError;
      // Server semantics: a capture gate exists only for a form profile with a
      // passed, frozen criterion.
      if ((config.profileMode ?? 'form') !== 'form') {
        throw Object.assign(new Error('denied'), { code: 'POLICY_DENIED' });
      }
      if (criterionResult.result !== 'passed') {
        throw Object.assign(new Error('denied'), { code: 'POLICY_DENIED' });
      }
      gateSeed += 1;
      return {
        gateId:
          config.gateFor?.(log.criterion.length) ??
          config.gateId ??
          `gate-${gateSeed}`,
      };
    },
    async issueCaptureGrant(proofValue, sessionId, gateId) {
      log.grant.push({ sessionId, gateId });
      log.proofs.push(proofValue);
      if (config.grantError) throw config.grantError;
      grantSeed += 1;
      return {
        grant: {
          grantId: `capture-${grantSeed}`,
          ...binding,
          deadline,
          kind: 'capture_auth_state',
          captureTicket: config.ticket ?? ticket,
        },
        captureTicket: config.ticket ?? ticket,
      };
    },
    async beginAuthCapture(proofValue, sessionId, grantId, ticketValue) {
      log.begin.push({ sessionId, grantId, ticket: ticketValue });
      log.proofs.push(proofValue);
      if (config.beginError) throw config.beginError;
    },
    async captureAuthState(proofValue, sessionId, grantId, ticketValue, state) {
      log.capture.push({ sessionId, grantId, ticket: ticketValue, state });
      log.proofs.push(proofValue);
      if (config.captureError) throw config.captureError;
      return {
        authStateId: config.authStateId ?? authStateId,
        runId: config.refRunId ?? binding.runId,
        authEpoch: config.refAuthEpoch ?? binding.authEpoch,
        capturedAt: nowIso,
      };
    },
    async finishAuth(proofValue, sessionId, authStateIdValue) {
      log.finish.push({ sessionId, authStateId: authStateIdValue });
      log.proofs.push(proofValue);
      if (config.finishError) throw config.finishError;
    },
  };
  if (config.noFinishMethod) delete client.finishAuth;
  return { client, log };
}

function adapters() {
  return {
    async locate(snapshotValue, locator) {
      return {
        snapshotId: snapshotValue.snapshotId,
        pageId: snapshotValue.pageId,
        frameId: 'main',
        nodeId:
          locator.value === locators.submitTarget.value
            ? 'submit-button'
            : locator.value,
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
  const services = fakeServiceClient(config.services);
  const realServices = createAuthServices({
    client: services.client,
    proof,
    binding,
    ...(config.unimplementedServices
      ? { unimplementedServices: config.unimplementedServices }
      : {}),
  });
  const bridge = createAuthRuntimeBridge({
    client: {
      async grantAuth(_proof, request) {
        return {
          grantId: `permit-${request.slot}-${Math.random().toString(16).slice(2, 8)}`,
          ...binding,
          deadline,
          action: request.action,
          slot: request.slot,
          ...(request.target ? { target: { ...request.target } } : {}),
          ...(request.action === 'navigate_auth' ? { url: permitUrl } : {}),
        };
      },
      async recordAuthObservation(_proof, _sessionId, value) {
        return value;
      },
      async beginAuthExecution(_proof, _sessionId, grantId) {
        return { grantId, executionId: `exec-${grantId}`, startedAt: nowIso };
      },
      async recordAuth() {},
    },
    proof,
    binding,
    services: realServices,
  });
  const browser = fakeBrowser();
  const port = createPrivateAuthPort({
    binding,
    gate: bridge.gate,
    primitives: browser.primitives,
    allowedOrigins: [origin],
    now: () => Date.parse(nowIso),
  });
  const adapter = config.adapterResult
    ? {
        ...adapters(),
        evaluate: async (_s, criterion) => ({
          criterionId: criterion.id,
          result: config.adapterResult,
          reason: 'synthetic',
          evidenceRefs: [],
        }),
      }
    : adapters();
  let seed = 0;
  const options = {
    profile: config.profile ?? formProfile(),
    binding,
    runtime: bridge.runtime,
    port,
    adapters: adapter,
    criterion: config.criterion,
    newRequestId: () => `request-${(seed += 1)}`,
    now: () => Date.parse(nowIso),
  };
  return {
    services: realServices,
    client: services,
    browser,
    port,
    run: (signal = new AbortController().signal) =>
      runAuthFlow(options, signal),
  };
}

test('the real services carry the flow through capture and finish', async () => {
  const world = scenario();
  const outcome = await world.run();

  // Capture and finish both ran through the real service calls.
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.reasonCode, 'AUTH_SUCCEEDED');
  assert.equal(outcome.stateRef, authStateId);
  assert.deepEqual(world.browser.calls, [
    'navigate',
    'fill:user-field',
    'fill:pass-field',
    'submit',
    'export_state',
  ]);
  assert.deepEqual(
    world.client.log.material.map((call) => call.sessionId),
    [binding.sessionId],
  );
  // The gate that authorizes the grant comes from the passed criterion.
  assert.equal(world.client.log.criterion.length, 1);
  assert.equal(world.client.log.criterion[0].criterionResult.result, 'passed');
  assert.equal(typeof world.client.log.criterion[0].snapshotId, 'string');
  assert.deepEqual(
    world.client.log.grant.map((call) => call.gateId),
    ['gate-1'],
  );
  // The CAS and the capture both use the grant and the ticket of that grant.
  assert.equal(world.client.log.begin.length, 1);
  assert.equal(world.client.log.begin[0].grantId, 'capture-1');
  assert.equal(world.client.log.begin[0].ticket, ticket);
  assert.equal(world.client.log.capture.length, 1);
  assert.equal(world.client.log.capture[0].grantId, 'capture-1');
  assert.equal(world.client.log.capture[0].ticket, ticket);
  assert.equal(world.client.log.capture[0].state.cookies[0].name, 'auth');
  assert.equal(world.client.log.capture[0].state.cookies[0].value, secret);

  // Private handles never reach the outcome or an enumerable return. The state
  // ref is the one intended business handle, reported only on success.
  const exposed = JSON.stringify({
    outcome,
    services: Object.keys(world.services),
  });
  for (const materialValue of [leaseToken, ticket, secret, user, 'gate-1']) {
    assert.equal(exposed.includes(materialValue), false, materialValue);
  }
  assert.equal(outcome.stateRef, authStateId);
  assert.equal(
    Object.keys(world.services).sort().join(','),
    [
      'authorizeExport',
      'captureAuthState',
      'finishAuth',
      'issueCaptureGrant',
      'material',
      'recordAuthCriterion',
    ].join(','),
  );
});

test('injected stubs are explicit, and their absence still blocks', async () => {
  // A form profile with an OTP target: no OTP service exists in this batch.
  const withoutOtp = scenario({ profile: formProfile({ withOtp: true }) });
  const blockedAtOtp = await withoutOtp.run();
  assert.equal(blockedAtOtp.status, 'blocked');
  assert.equal(blockedAtOtp.reasonCode, 'SERVICE_UNAVAILABLE');
  assert.deepEqual(withoutOtp.browser.calls, [
    'navigate',
    'fill:user-field',
    'fill:pass-field',
    'submit',
  ]);
  assert.equal(withoutOtp.client.log.grant.length, 0);

  // An explicit OTP stub lets the flow pass that step; finish is still missing.
  const withStub = scenario({
    profile: formProfile({ withOtp: true }),
    unimplementedServices: { pauseForOtp: async () => ({ code: otp }) },
  });
  const outcome = await withStub.run();
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.stateRef, authStateId);
  assert.deepEqual(withStub.browser.calls, [
    'navigate',
    'fill:user-field',
    'fill:pass-field',
    'submit',
    'fill:otp-field',
    'submit',
    'export_state',
  ]);

  // A stub cannot replace the real finish method.
  let stubbed = 0;
  const stubbedFinish = scenario({
    unimplementedServices: {
      finishAuth: async () => {
        stubbed += 1;
      },
    },
  });
  const stubbedOutcome = await stubbedFinish.run();
  assert.equal(stubbed, 0);
  assert.equal(stubbedFinish.client.log.finish.length, 1);
  assert.equal(stubbedOutcome.status, 'succeeded');

  // The real finish is called with the frozen proof/session and the state ref
  // the capture returned.
  const finishing = scenario();
  const finishingOutcome = await finishing.run();
  assert.deepEqual(finishing.client.log.finish, [
    { sessionId: binding.sessionId, authStateId },
  ]);
  assert.equal(finishingOutcome.status, 'succeeded');
  assert.equal(finishingOutcome.stateRef, authStateId);
  const exposed = JSON.stringify(finishingOutcome);
  for (const material of [leaseToken, ticket, secret, user, 'gate-1']) {
    assert.equal(exposed.includes(material), false, material);
  }

  // A refusing finish blocks the run without a success or a state ref.
  const refusedFinish = scenario({
    services: {
      finishError: Object.assign(new Error('expired'), {
        code: 'LEASE_EXPIRED',
      }),
    },
  });
  const refusedOutcome = await refusedFinish.run();
  assert.equal(refusedOutcome.status, 'blocked');
  assert.equal(refusedOutcome.reasonCode, 'LEASE_EXPIRED');
  assert.equal(refusedOutcome.stateRef, null);

  // Without the method on the client the step stays unavailable: no fallback.
  const noFinish = scenario({ services: { noFinishMethod: true } });
  const noFinishOutcome = await noFinish.run();
  assert.equal(noFinishOutcome.status, 'blocked');
  assert.equal(noFinishOutcome.reasonCode, 'SERVICE_UNAVAILABLE');
  assert.equal(noFinishOutcome.stateRef, null);
  assert.deepEqual(noFinish.client.log.finish, []);
});

test('a capture grant is refused without a passed, same-session gate', async () => {
  // Directly: no criterion has been recorded yet.
  const direct = scenario();
  await assert.rejects(
    direct.services.issueCaptureGrant(),
    (error) => error.code === 'AUTH_FAILED',
  );
  assert.deepEqual(direct.client.log.grant, []);

  // A failed criterion never issues a gate, and no grant is attempted.
  const failed = scenario({ adapterResult: 'failed' });
  const outcome = await failed.run();
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.reasonCode, 'CRITERION_FAILED');
  assert.deepEqual(failed.client.log.criterion, []);
  assert.deepEqual(failed.client.log.grant, []);
  assert.deepEqual(failed.client.log.begin, []);
  assert.deepEqual(failed.client.log.capture, []);
  assert.equal(failed.browser.calls.includes('export_state'), false);
});

test('service failures keep their constant codes and stop the flow', async () => {
  const scenarios = [
    {
      name: 'material refused',
      config: {
        services: {
          materialError: Object.assign(new Error('expired'), {
            code: 'LEASE_EXPIRED',
          }),
        },
      },
      code: 'LEASE_EXPIRED',
      calls: [],
    },
    {
      name: 'criterion gate refused',
      config: {
        services: {
          criterionError: Object.assign(new Error('denied'), {
            code: 'POLICY_DENIED',
          }),
        },
      },
      code: 'POLICY_DENIED',
      calls: ['navigate', 'fill:user-field', 'fill:pass-field', 'submit'],
    },
    {
      name: 'capture ticket CAS refused',
      config: {
        services: {
          beginError: Object.assign(new Error('expired'), {
            code: 'LEASE_EXPIRED',
          }),
        },
      },
      code: 'LEASE_EXPIRED',
      calls: ['navigate', 'fill:user-field', 'fill:pass-field', 'submit'],
    },
    {
      name: 'capture conflict',
      config: {
        services: {
          captureError: Object.assign(new Error('conflict'), {
            code: 'IDEMPOTENCY_CONFLICT',
          }),
        },
      },
      code: 'IDEMPOTENCY_CONFLICT',
      calls: [
        'navigate',
        'fill:user-field',
        'fill:pass-field',
        'submit',
        'export_state',
      ],
    },
    {
      name: 'grant refused',
      config: {
        services: {
          grantError: Object.assign(new Error('rate'), {
            code: 'RATE_LIMITED',
          }),
        },
      },
      code: 'RATE_LIMITED',
      calls: ['navigate', 'fill:user-field', 'fill:pass-field', 'submit'],
    },
  ];
  for (const scenarioCase of scenarios) {
    const world = scenario(scenarioCase.config);
    const outcome = await world.run();
    assert.equal(outcome.status, 'blocked', scenarioCase.name);
    assert.equal(outcome.reasonCode, scenarioCase.code, scenarioCase.name);
    assert.equal(outcome.stateRef, null, scenarioCase.name);
    assert.deepEqual(
      world.browser.calls,
      scenarioCase.calls,
      scenarioCase.name,
    );
  }
});

test('foreign and unknown capture handles are refused', async () => {
  const world = scenario();
  const issued = {
    grantId: 'capture-unknown',
    ...binding,
    deadline,
    kind: 'capture_auth_state',
    captureTicket: ticket,
  };
  // Never issued by this adapter: no CAS call, no capture.
  await assert.rejects(
    world.services.authorizeExport(issued),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  await assert.rejects(
    world.services.captureAuthState(issued, { cookies: [] }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.deepEqual(world.client.log.begin, []);
  assert.deepEqual(world.client.log.capture, []);

  // A grant for another session is refused even when a ticket exists.
  const other = scenario();
  await other.services.recordAuthCriterion(snapshot('landed'), {
    criterionId: 'logged-in',
    result: 'passed',
    reason: 'synthetic',
    evidenceRefs: [],
  });
  const grant = await other.services.issueCaptureGrant();
  await assert.rejects(
    other.services.authorizeExport({ ...grant, sessionId: 'sess-other' }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  await assert.rejects(
    other.services.captureAuthState(
      { ...grant, sessionId: 'sess-other' },
      { cookies: [] },
    ),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.deepEqual(other.client.log.begin, []);

  // A handle from another run or epoch is refused, and the flow stays blocked.
  const foreign = scenario({ services: { refAuthEpoch: 9 } });
  const outcome = await foreign.run();
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.reasonCode, 'LEASE_EXPIRED');
  assert.equal(outcome.stateRef, null);

  const foreignRun = scenario({ services: { refRunId: 'run-other' } });
  const runOutcome = await foreignRun.run();
  assert.equal(runOutcome.status, 'blocked');
  assert.equal(runOutcome.reasonCode, 'LEASE_EXPIRED');
  assert.equal(runOutcome.stateRef, null);
});

test('the client keeps its receiver and always receives the frozen proof', async () => {
  const world = scenario();
  const seen = [];
  for (const name of [
    'authMaterial',
    'recordAuthCriterion',
    'issueCaptureGrant',
    'beginAuthCapture',
    'captureAuthState',
  ]) {
    const original = world.client.client[name];
    world.client.client[name] = async function (...args) {
      seen.push([name, this === world.client.client]);
      return original.apply(this, args);
    };
  }
  await world.run();
  assert.ok(seen.length >= 5);
  assert.equal(
    seen.every(([, sameReceiver]) => sameReceiver),
    true,
  );
  assert.ok(world.client.log.proofs.length >= 5);
  for (const forwarded of world.client.log.proofs) {
    assert.equal(forwarded, world.client.log.proofs[0]);
    assert.equal(Object.isFrozen(forwarded), true);
    assert.deepEqual(forwarded, proof);
  }
});

test('storage_state material passes through canonically and the server refuses its gate', async () => {
  const world = scenario({
    profile: storageProfile(),
    criterion: storageCriterion,
    services: {
      profileMode: 'storage_state',
      material: {
        mode: 'storage_state',
        material: { storageState: secretInputFixture },
        expiresAt: materialExpiresAt,
      },
    },
  });
  const outcome = await world.run();
  // Injection still never navigates first, and the current server refuses a
  // capture gate for storage_state; the adapter must not paper over that.
  assert.equal(world.browser.calls[0], 'prepare_state');
  assert.equal(world.browser.calls[1], 'navigate');
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.reasonCode, 'POLICY_DENIED');
  assert.equal(outcome.stateRef, null);
  assert.deepEqual(world.client.log.grant, []);
  assert.equal(JSON.stringify(outcome).includes(secret), false);
});

test('construction refuses an incomplete or inactive adapter input', () => {
  const { client } = fakeServiceClient();
  const refuse = (options) =>
    assert.throws(
      () => createAuthServices(options),
      (error) => error.code === 'VALIDATION_ERROR',
    );
  for (const method of [
    'authMaterial',
    'recordAuthCriterion',
    'issueCaptureGrant',
    'beginAuthCapture',
    'captureAuthState',
  ]) {
    refuse({ client: { ...client, [method]: undefined }, proof, binding });
  }
  refuse({ client, proof: { ...proof, leaseToken: '' }, binding });
  refuse({ client, proof, binding: { ...binding, status: 'ended' } });
  refuse({ client, proof, binding: { ...binding, runId: '' } });
  // Absent unimplemented dependencies stay absent: the bridge blocks them.
  const services = createAuthServices({ client, proof, binding });
  assert.equal('pauseForOtp' in services, false);
  assert.equal('finishAuth' in services, true);
});

test('every criterion evaluation invalidates the previous success gate', async () => {
  const passed = {
    criterionId: 'logged-in',
    result: 'passed',
    reason: 'synthetic',
    evidenceRefs: [],
  };
  const failed = { ...passed, result: 'failed' };

  // A non-passed evaluation after a pass: the old gate must be gone.
  const afterFailure = scenario();
  const landed = snapshot('landed');
  await afterFailure.services.recordAuthCriterion(landed, passed);
  await afterFailure.services.issueCaptureGrant();
  assert.equal(afterFailure.client.log.grant.length, 1);
  await afterFailure.services.recordAuthCriterion(landed, failed);
  await assert.rejects(
    afterFailure.services.issueCaptureGrant(),
    (error) => error.code === 'AUTH_FAILED',
  );
  assert.equal(afterFailure.client.log.grant.length, 1);

  // A service failure during the next evaluation must clear it too.
  const afterServiceError = scenario({
    services: {
      onCriterion: (index) =>
        index === 2
          ? Object.assign(new Error('denied'), { code: 'POLICY_DENIED' })
          : null,
    },
  });
  await afterServiceError.services.recordAuthCriterion(landed, passed);
  await afterServiceError.services.issueCaptureGrant();
  await assert.rejects(
    afterServiceError.services.recordAuthCriterion(landed, passed),
    (error) => error.code === 'POLICY_DENIED',
  );
  await assert.rejects(
    afterServiceError.services.issueCaptureGrant(),
    (error) => error.code === 'AUTH_FAILED',
  );
  assert.equal(afterServiceError.client.log.grant.length, 1);

  // A malformed gate response must clear it as well.
  const afterBadGate = scenario({
    services: { gateFor: (index) => (index === 2 ? '' : undefined) },
  });
  await afterBadGate.services.recordAuthCriterion(landed, passed);
  await afterBadGate.services.issueCaptureGrant();
  await assert.rejects(
    afterBadGate.services.recordAuthCriterion(landed, passed),
    (error) => error.code === 'AUTH_FAILED',
  );
  await assert.rejects(
    afterBadGate.services.issueCaptureGrant(),
    (error) => error.code === 'AUTH_FAILED',
  );
  assert.equal(afterBadGate.client.log.grant.length, 1);

  // A fresh pass replaces the old gate rather than reusing it.
  const reissued = scenario();
  await reissued.services.recordAuthCriterion(landed, passed);
  await reissued.services.recordAuthCriterion(landed, passed);
  await reissued.services.issueCaptureGrant();
  assert.deepEqual(
    reissued.client.log.grant.map((call) => call.gateId),
    ['gate-2'],
  );

  // The same rule holds end to end: a failed run never captures, and the
  // adapter's gate does not leak into the next one.
  const endToEnd = scenario({ adapterResult: 'failed' });
  const outcome = await endToEnd.run();
  assert.equal(outcome.reasonCode, 'CRITERION_FAILED');
  await assert.rejects(
    endToEnd.services.issueCaptureGrant(),
    (error) => error.code === 'AUTH_FAILED',
  );
  assert.deepEqual(endToEnd.client.log.grant, []);
});
