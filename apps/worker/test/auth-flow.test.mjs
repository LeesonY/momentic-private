// Pure Node with a FakeBrowser (synthetic primitives) and an explicitly labeled
// Fake Runtime: it calls the real runAuthFlow and the real AUTH-5 private port.
// The real Coordinator capture CAS / OTP service is NOT implemented here, so no
// assertion below claims a service-verified ticket or a distributed capture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivateAuthPort } from '@localqa/browser';
import { runAuthFlow } from '../dist/auth-flow.js';

const user = 'vault-username-6a';
const secret = 'vault-password-6a';
const otp = 'vault-otp-6a';
const ticket = 'capture-ticket-6a';
const stateRef = 'state-ref-6a';
const origin = 'http://localhost:8080';
const permitUrl = `${origin}/permit-login`;
const profileLoginUrl = `${origin}/profile-login`;
const nowIso = '2026-10-07T00:00:00.000Z';
const deadline = '2026-10-07T00:30:00.000Z';
const expiresAt = '2026-10-08T00:00:00.000Z';
const materialExpiresAt = '2026-10-07T00:10:00.000Z';

const binding = {
  sessionId: 'sess-6a',
  projectId: 'proj-6a',
  runId: 'run-6a',
  taskId: 'task-6a',
  workerId: 'worker-6a',
  fencingToken: 4,
  contextVersion: 2,
  contextId: 'ctx-6a',
  profileId: 'profile-6a',
  profileVersion: 3,
  authEpoch: 1,
  purpose: 'initializer',
  status: 'active',
  expiresAt,
};

const locators = {
  usernameTarget: { by: 'label', value: 'user-field' },
  passwordTarget: { by: 'label', value: 'pass-field' },
  submitTarget: { by: 'role', value: 'button', name: 'Sign in' },
  otpTarget: { by: 'label', value: 'otp-field' },
};

/**
 * The exact shape apps/api/test/t10-auth-runtime.test.mjs stores through
 * ConfigurationRepository and LeaseRepository.resolveAuth hands back.
 */
function secretInputFixture(overrides = {}) {
  return JSON.stringify({
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
        ...overrides.cookie,
      },
    ],
    origins: overrides.origins ?? [],
  });
}

function formProfile(overrides = {}) {
  return {
    id: 'profile-6a',
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
      loginUrl: profileLoginUrl,
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
    ...overrides,
  };
}

function storageProfile(overrides = {}) {
  return formProfile({
    mode: 'storage_state',
    formConfig: null,
    ...overrides,
  });
}

const criterion = {
  id: 'captured-state-ok',
  kind: 'url_matches',
  description: 'Landed on the frozen target',
  sourceKind: 'generic_smoke',
  sourceRef: 'fixture',
  expectedValue: permitUrl,
};

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
    screenshotRef: 'shot-6a',
    networkSummary: [],
    consoleSummary: [],
    truncated: false,
    redacted: true,
  };
}

/** FakeBrowser: synthetic primitives, no real browser and no Playwright. */
function fakeBrowser(hooks = {}) {
  const calls = [];
  return {
    calls,
    primitives: {
      async navigate(url) {
        calls.push({ kind: 'navigate', url });
        return snapshot('login');
      },
      async fill(target, value) {
        calls.push({ kind: 'fill', nodeId: target.nodeId, value });
        hooks.afterFill?.();
        return snapshot('filled');
      },
      async submit(target) {
        calls.push({ kind: 'submit', nodeId: target.nodeId });
        return snapshot('submitted');
      },
      async prepareState(state) {
        calls.push({
          kind: 'prepare_state',
          cookies: state.cookies?.length ?? 0,
        });
      },
      async exportState() {
        calls.push({ kind: 'export_state' });
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
 * Fake Runtime: stands in for the trusted Worker-facing service boundary.
 * beginAuthExecution / capture CAS / OTP tickets are NOT implemented.
 */
function fakeRuntime(config = {}) {
  const log = {
    material: 0,
    grants: [],
    records: [],
    observations: 0,
    otp: 0,
    criteria: [],
    captureGrants: 0,
    captures: [],
    finishes: [],
    gate: [],
  };
  let grantSeed = 0;
  const fail = (key, index = 0) => {
    const value = config[key];
    if (typeof value === 'function') return value(index);
    return value ?? null;
  };
  const runtime = {
    async material() {
      log.material += 1;
      const error = fail('materialError');
      if (error) throw error;
      return (
        config.material ?? {
          mode: 'form',
          material: { username: user, password: secret },
          expiresAt: materialExpiresAt,
        }
      );
    },
    async grantAuth(request) {
      log.grants.push(request);
      const error = fail('grantError');
      if (error) throw error;
      grantSeed += 1;
      return {
        grantId: config.grantId ?? `permit-${grantSeed}`,
        ...binding,
        deadline,
        action: request.action,
        slot: request.slot,
        ...(request.target ? { target: { ...request.target } } : {}),
        ...(request.action === 'navigate_auth'
          ? { url: config.permitUrl ?? permitUrl }
          : {}),
        ...(config.permitOverrides ?? {}),
      };
    },
    async recordAuth(permit, outcome) {
      log.records.push({ grantId: permit.grantId, outcome: { ...outcome } });
      const error = fail('recordError', log.records.length);
      if (error) throw error;
    },
    async recordAuthObservation() {
      log.observations += 1;
      const error = fail('observationError');
      if (error) throw error;
    },
    async pauseForOtp() {
      log.otp += 1;
      const error = fail('otpError');
      if (error) throw error;
      return { code: otp };
    },
    async recordAuthCriterion(_snapshot, result) {
      log.criteria.push({ ...result });
      const error = fail('criterionRecordError');
      if (error) throw error;
    },
    async issueCaptureGrant() {
      log.captureGrants += 1;
      const error = fail('captureGrantError');
      if (error) throw error;
      return (
        config.captureGrant ?? {
          grantId: 'capture-6a',
          ...binding,
          deadline,
          kind: 'capture_auth_state',
          captureTicket: ticket,
        }
      );
    },
    async captureAuthState(grant, state) {
      log.captures.push({ grantId: grant.grantId, state });
      const error = fail('captureError');
      if (error) throw error;
      return { stateRef: config.stateRef ?? stateRef };
    },
    async finishAuth(ref) {
      log.finishes.push(ref);
      const error = fail('finishError');
      if (error) throw error;
    },
  };
  return { runtime, log };
}

function fakeGate(config = {}) {
  const log = [];
  return {
    log,
    gate: {
      async authorize({ permit }) {
        log.push({ kind: 'authorize', grantId: permit.grantId });
        if (config.rejectAuthorize) throw new Error('synthetic gate denial');
      },
      async authorizeExport({ grant }) {
        log.push({ kind: 'authorizeExport', grantId: grant.grantId });
        if (config.rejectExport) throw new Error('synthetic gate denial');
      },
    },
  };
}

function adapters(config = {}) {
  const calls = { locate: 0, evaluate: 0 };
  return {
    calls,
    adapters: {
      async locate(snapshotValue, locator) {
        calls.locate += 1;
        if (config.locateError) throw config.locateError;
        const nodeId =
          config.resolve === false
            ? null
            : (Object.entries(locators).find(
                ([key, value]) =>
                  key !== 'submitTarget' && value.value === locator.value,
              )?.[1].value ??
              (locator.value === locators.submitTarget.value
                ? 'submit-button'
                : locator.value));
        if (!nodeId) return null;
        if (config.foreignSnapshot) {
          return {
            snapshotId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            pageId: snapshotValue.pageId,
            frameId: 'main',
            nodeId,
          };
        }
        return {
          snapshotId: snapshotValue.snapshotId,
          pageId: snapshotValue.pageId,
          frameId: 'main',
          nodeId,
        };
      },
      async evaluate(snapshotValue, configured) {
        calls.evaluate += 1;
        if (config.evaluateError) throw config.evaluateError;
        const result =
          typeof config.result === 'function'
            ? config.result(snapshotValue)
            : (config.result ?? 'passed');
        return {
          criterionId: config.criterionIdOverride ?? configured.id,
          result,
          reason: 'synthetic criterion result',
          evidenceRefs: [],
        };
      },
    },
  };
}

function newPort(config = {}) {
  const browser = fakeBrowser(config.hooks);
  const gate = fakeGate(config.gate);
  const port = createPrivateAuthPort({
    binding,
    gate: gate.gate,
    primitives: browser.primitives,
    allowedOrigins: [origin],
    now: () => Date.parse(nowIso),
  });
  return { port, browser, gateLog: gate.log };
}

function options(overrides = {}) {
  const runtime = overrides.runtime ?? fakeRuntime(overrides.runtimeConfig);
  const adapter = overrides.adapter ?? adapters(overrides.adapterConfig);
  return {
    value: {
      profile: overrides.profile ?? formProfile(),
      binding,
      runtime: runtime.runtime,
      port: 'port' in overrides ? overrides.port : undefined,
      adapters: adapter.adapters,
      criterion: overrides.criterion,
      newRequestId: (() => {
        let seed = 0;
        return () => `request-${(seed += 1)}`;
      })(),
      now: () => Date.parse(nowIso),
    },
    runtime,
    adapter,
  };
}

async function assertClosed(port) {
  await assert.rejects(
    port.executeAuth(
      {
        grantId: 'probe-after-flow',
        ...binding,
        deadline,
        action: 'navigate_auth',
        slot: 'login_url',
        url: permitUrl,
      },
      { kind: 'navigate' },
      new AbortController().signal,
    ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
}

test('form flow runs the fixed order once through the fake runtime', async () => {
  const { port, browser, gateLog } = newPort();
  const { value, runtime, adapter } = options({ port });
  const outcome = await runAuthFlow(value, new AbortController().signal);

  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.reasonCode, 'AUTH_SUCCEEDED');
  assert.equal(outcome.stateRef, stateRef);
  assert.deepEqual(
    outcome.steps.map((step) => [step.action, step.slot, step.status]),
    [
      ['navigate_auth', 'login_url', 'succeeded'],
      ['fill_credential', 'username', 'succeeded'],
      ['fill_credential', 'password', 'succeeded'],
      ['submit_auth', 'submit', 'succeeded'],
      ['fill_credential', 'otp', 'succeeded'],
      ['submit_auth', 'submit', 'succeeded'],
    ],
  );
  assert.deepEqual(
    browser.calls.map((call) => call.kind),
    ['navigate', 'fill', 'fill', 'submit', 'fill', 'submit', 'export_state'],
  );
  // The permit URL wins; the profile loginUrl is never used as a navigation.
  assert.equal(browser.calls[0].url, permitUrl);
  assert.equal(JSON.stringify(browser.calls).includes(profileLoginUrl), false);
  assert.deepEqual(
    runtime.log.grants.map((request) => [request.action, request.slot]),
    [
      ['navigate_auth', 'login_url'],
      ['fill_credential', 'username'],
      ['fill_credential', 'password'],
      ['submit_auth', 'submit'],
      ['fill_credential', 'otp'],
      ['submit_auth', 'submit'],
    ],
  );
  for (const request of runtime.log.grants) {
    assert.deepEqual(
      Object.keys(request).sort(),
      [
        'action',
        'requestId',
        'sessionId',
        'slot',
        ...(request.target ? ['target'] : []),
      ].sort(),
    );
    assert.equal(request.sessionId, binding.sessionId);
  }
  assert.equal(runtime.log.material, 1);
  assert.equal(runtime.log.otp, 1);
  assert.equal(runtime.log.observations, 6);
  assert.equal(runtime.log.records.length, 6);
  assert.equal(runtime.log.criteria.length, 1);
  assert.equal(runtime.log.criteria[0].result, 'passed');
  assert.equal(runtime.log.captureGrants, 1);
  assert.equal(runtime.log.captures.length, 1);
  assert.deepEqual(runtime.log.finishes, [stateRef]);
  assert.deepEqual(
    gateLog.map((entry) => entry.kind),
    [...Array(6).fill('authorize'), 'authorizeExport'],
  );
  assert.equal(adapter.calls.locate, 5);

  // Material reaches the fill primitive only; the outcome, the grant requests,
  // and the private record ledger carry codes and ids, never material.
  assert.deepEqual(
    browser.calls
      .filter((call) => call.kind === 'fill')
      .map((call) => call.value),
    [user, secret, otp],
  );
  const evidence = JSON.stringify({
    outcome,
    records: runtime.log.records,
    grants: runtime.log.grants,
  });
  for (const material of [user, secret, otp]) {
    assert.equal(evidence.includes(material), false);
  }
  assert.equal(
    browser.calls.some((call) => call.kind === 'type_text'),
    false,
  );
  assert.equal(evidence.includes('ToolCall'), false);
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(Object.isFrozen(outcome.steps), true);
  for (const record of runtime.log.records) {
    assert.equal(record.outcome.status, 'succeeded');
    assert.equal(record.outcome.reasonCode, 'AUTH_ACTION_SUCCEEDED');
  }
  const captured = runtime.log.captures[0].state;
  assert.equal(captured.cookies[0].name, 'auth');
  await assertClosed(port);
});

test('one OTP at most, and never a second wait after a criterion failure', async () => {
  const withoutOtp = formProfile();
  withoutOtp.formConfig = { ...withoutOtp.formConfig };
  delete withoutOtp.formConfig.otpTarget;
  const skipped = options({
    profile: withoutOtp,
    adapterConfig: { result: 'failed' },
  });
  skipped.value.port = newPort().port;
  const noOtpOutcome = await runAuthFlow(
    skipped.value,
    new AbortController().signal,
  );
  assert.equal(skipped.runtime.log.otp, 0);
  assert.equal(
    skipped.runtime.log.grants.filter(
      (request) => request.action === 'submit_auth',
    ).length,
    1,
  );
  assert.equal(noOtpOutcome.status, 'blocked');
  assert.equal(noOtpOutcome.reasonCode, 'CRITERION_FAILED');

  // otpTarget configured but not resolvable in the current snapshot: no wait.
  const unresolved = options({ adapterConfig: { result: 'failed' } });
  unresolved.value.port = newPort().port;
  const unresolvedAdapters = unresolved.value.adapters;
  unresolved.value.adapters = {
    ...unresolvedAdapters,
    locate: async (snapshotValue, locator) =>
      locator.value === locators.otpTarget.value
        ? null
        : unresolvedAdapters.locate(snapshotValue, locator),
  };
  const unresolvedOutcome = await runAuthFlow(
    unresolved.value,
    new AbortController().signal,
  );
  assert.equal(unresolved.runtime.log.otp, 0);
  assert.equal(unresolvedOutcome.reasonCode, 'CRITERION_FAILED');
  assert.equal(
    unresolved.runtime.log.grants.filter(
      (request) => request.action === 'submit_auth',
    ).length,
    1,
  );

  // Criterion fails after the OTP submit: no loop, no second OTP, no capture.
  const failed = options({ adapterConfig: { result: 'failed' } });
  failed.value.port = newPort().port;
  const failedOutcome = await runAuthFlow(
    failed.value,
    new AbortController().signal,
  );
  assert.equal(failedOutcome.status, 'blocked');
  assert.equal(failedOutcome.reasonCode, 'CRITERION_FAILED');
  assert.equal(failed.runtime.log.otp, 1);
  assert.equal(failed.runtime.log.captureGrants, 0);
  assert.equal(failed.runtime.log.finishes.length, 0);
  assert.equal(failedOutcome.stateRef, null);
  assert.equal(
    failed.runtime.log.grants.filter(
      (request) => request.action === 'submit_auth',
    ).length,
    2,
  );
  await assertClosed(failed.value.port);
});

test('storage_state prepares without navigating, then navigates once', async () => {
  const { port, browser } = newPort();
  const { value, runtime } = options({
    port,
    profile: storageProfile(),
    criterion,
    runtimeConfig: {
      material: {
        mode: 'storage_state',
        material: { storageState: secretInputFixture() },
        expiresAt: materialExpiresAt,
      },
    },
  });
  const outcome = await runAuthFlow(value, new AbortController().signal);
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(
    browser.calls.map((call) => call.kind),
    ['prepare_state', 'navigate', 'export_state'],
  );
  // Zero navigation before the prepare, and no fill/submit anywhere.
  assert.equal(
    browser.calls.findIndex((call) => call.kind === 'navigate'),
    1,
  );
  assert.equal(
    browser.calls.some((call) => call.kind === 'fill'),
    false,
  );
  assert.equal(
    browser.calls.some((call) => call.kind === 'submit'),
    false,
  );
  assert.deepEqual(
    runtime.log.grants.map((request) => [request.action, request.slot]),
    [
      ['import_storage_state', 'storage_state'],
      ['navigate_auth', 'login_url'],
    ],
  );
  assert.equal(runtime.log.observations, 1);
  assert.equal(runtime.log.criteria.length, 1);
  assert.deepEqual(runtime.log.finishes, [stateRef]);
  assert.equal(JSON.stringify(outcome).includes(secret), false);
  await assertClosed(port);
});

test('record, observation, capture and finish failures never yield success', async () => {
  const cases = [
    {
      config: {
        recordError: (index) => (index === 3 ? new Error('ledger down') : null),
      },
      code: 'RECORD_FAILED',
      actions: 3,
      captures: 0,
    },
    {
      config: { observationError: new Error('observation rejected') },
      code: 'OBSERVATION_FAILED',
      actions: 2,
      captures: 0,
    },
    {
      config: { criterionRecordError: new Error('criterion record rejected') },
      code: 'CRITERION_RECORD_FAILED',
      actions: 6,
      captures: 0,
    },
    {
      config: { captureGrantError: new Error('grant refused') },
      code: 'CAPTURE_GRANT_FAILED',
      actions: 6,
      captures: 0,
    },
    {
      config: { captureError: new Error('capture rejected') },
      code: 'CAPTURE_FAILED',
      actions: 6,
      captures: 1,
    },
    {
      config: { finishError: new Error('finish rejected') },
      code: 'FINISH_FAILED',
      actions: 6,
      captures: 1,
    },
  ];
  for (const scenario of cases) {
    const port = newPort();
    const { value, runtime } = options({
      port: port.port,
      runtimeConfig: scenario.config,
    });
    const outcome = await runAuthFlow(value, new AbortController().signal);
    assert.notEqual(outcome.status, 'succeeded', scenario.code);
    assert.equal(outcome.reasonCode, scenario.code);
    assert.equal(outcome.stateRef, null);
    const performed = runtime.log.records.filter(
      (record) => record.outcome.status === 'succeeded',
    ).length;
    assert.ok(performed <= scenario.actions, `${scenario.code}: ${performed}`);
    assert.equal(runtime.log.captures.length, scenario.captures, scenario.code);
    assert.equal(
      runtime.log.finishes.length,
      scenario.code === 'FINISH_FAILED' ? 1 : 0,
      scenario.code,
    );
    await assertClosed(port.port);
  }

  // A gate denial stops before any browser effect and yields no success.
  const denied = newPort({ gate: { rejectAuthorize: true } });
  const deniedRun = options({ port: denied.port });
  const deniedOutcome = await runAuthFlow(
    deniedRun.value,
    new AbortController().signal,
  );
  assert.equal(deniedOutcome.status, 'blocked');
  assert.deepEqual(denied.browser.calls, []);
  assert.equal(deniedOutcome.stateRef, null);

  // A rejected capture gate: no export, no capture, no finish.
  const deniedExport = newPort({ gate: { rejectExport: true } });
  const exportRun = options({ port: deniedExport.port });
  const exportOutcome = await runAuthFlow(
    exportRun.value,
    new AbortController().signal,
  );
  assert.equal(exportOutcome.status, 'blocked');
  assert.equal(
    deniedExport.browser.calls.filter((call) => call.kind === 'export_state')
      .length,
    0,
  );
  assert.equal(exportRun.runtime.log.captures.length, 0);
  assert.equal(exportRun.runtime.log.finishes.length, 0);
});

test('missing or unsupported configuration is blocked, never passed', async () => {
  const failures = [
    {
      name: 'no resolver',
      build: () => {
        const built = options();
        built.value.port = newPort().port;
        built.value.adapters = { evaluate: built.value.adapters.evaluate };
        return built;
      },
      code: 'RESOLVER_UNAVAILABLE',
    },
    {
      name: 'target not resolvable',
      build: () => {
        const built = options({ adapterConfig: { resolve: false } });
        built.value.port = newPort().port;
        return built;
      },
      code: 'TARGET_NOT_RESOLVED',
    },
    {
      name: 'foreign snapshot target',
      build: () => {
        const built = options({ adapterConfig: { foreignSnapshot: true } });
        built.value.port = newPort().port;
        return built;
      },
      code: 'TARGET_NOT_IN_SNAPSHOT',
    },
    {
      name: 'criterion missing',
      build: () => {
        const built = options({
          profile: storageProfile(),
          runtimeConfig: {
            material: {
              mode: 'storage_state',
              material: { storageState: secretInputFixture() },
              expiresAt: materialExpiresAt,
            },
          },
        });
        built.value.port = newPort().port;
        return built;
      },
      code: 'CRITERION_NOT_CONFIGURED',
    },
    {
      name: 'criterion result unknown',
      build: () => {
        const built = options({ adapterConfig: { result: 'unknown' } });
        built.value.port = newPort().port;
        return built;
      },
      code: 'CRITERION_UNKNOWN',
    },
    {
      name: 'criterion not evaluated',
      build: () => {
        const built = options({ adapterConfig: { result: 'not_evaluated' } });
        built.value.port = newPort().port;
        return built;
      },
      code: 'CRITERION_NOT_EVALUATED',
    },
    {
      name: 'criterion result for another criterion',
      build: () => {
        const built = options({
          adapterConfig: { criterionIdOverride: 'other' },
        });
        built.value.port = newPort().port;
        return built;
      },
      code: 'CRITERION_RESULT_MISMATCH',
    },
    {
      name: 'form config missing',
      build: () => {
        const built = options({ profile: formProfile({ formConfig: null }) });
        built.value.port = newPort().port;
        return built;
      },
      code: 'FORM_CONFIG_MISSING',
    },
    {
      name: 'material mode mismatch',
      build: () => {
        const built = options({
          runtimeConfig: {
            material: {
              mode: 'none',
              material: {},
              expiresAt: materialExpiresAt,
            },
          },
        });
        built.value.port = newPort().port;
        return built;
      },
      code: 'MATERIAL_MODE_MISMATCH',
    },
    {
      name: 'material expired',
      build: () => {
        const built = options({
          runtimeConfig: {
            material: {
              mode: 'form',
              material: { username: user, password: secret },
              expiresAt: '2026-10-06T00:00:00.000Z',
            },
          },
        });
        built.value.port = newPort().port;
        return built;
      },
      code: 'MATERIAL_EXPIRED',
    },
    {
      name: 'grant outside the session',
      build: () => {
        const built = options({
          runtimeConfig: { permitOverrides: { sessionId: 'sess-other' } },
        });
        built.value.port = newPort().port;
        return built;
      },
      code: 'GRANT_MISMATCH',
    },
    {
      name: 'grant for another action',
      build: () => {
        const built = options({
          runtimeConfig: { permitOverrides: { action: 'submit_auth' } },
        });
        built.value.port = newPort().port;
        return built;
      },
      code: 'GRANT_MISMATCH',
    },
    {
      name: 'grant for another target',
      build: () => {
        const built = options({
          runtimeConfig: {
            permitOverrides: {
              target: {
                snapshotId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                pageId: '22222222-2222-4222-8222-222222222222',
                frameId: 'main',
                nodeId: 'other-node',
              },
            },
          },
        });
        built.value.port = newPort().port;
        return built;
      },
      code: 'GRANT_MISMATCH',
    },
    {
      name: 'capture grant outside the session',
      build: () => {
        const built = options({
          runtimeConfig: {
            captureGrant: {
              grantId: 'capture-6a',
              ...binding,
              sessionId: 'sess-other',
              deadline,
              kind: 'capture_auth_state',
              captureTicket: ticket,
            },
          },
        });
        const port = newPort();
        built.value.port = port.port;
        return built;
      },
      code: 'CAPTURE_GRANT_MISMATCH',
      noExport: true,
    },
    {
      name: 'active session missing',
      build: () => {
        const built = options();
        built.value.port = newPort().port;
        built.value.binding = { ...binding, status: 'ended' };
        return built;
      },
      code: 'SESSION_NOT_ACTIVE',
    },
    {
      name: 'no private port',
      build: () => options({ port: null }),
      code: 'PRIVATE_PORT_MISSING',
    },
  ];
  for (const scenario of failures) {
    const built = scenario.build();
    const outcome = await runAuthFlow(
      built.value,
      new AbortController().signal,
    );
    assert.equal(outcome.status, 'blocked', scenario.name);
    assert.equal(outcome.reasonCode, scenario.code, scenario.name);
    assert.equal(outcome.stateRef, null, scenario.name);
  }
});

test('unknown, raw, or getter-throwing codes fall back to constants', async () => {
  const raw = () => {
    const error = new Error(`synthetic failure ${secret}`);
    error.code = `AUTH_${secret}`;
    return error;
  };
  const throwingGetter = () => {
    const error = new Error('synthetic');
    Object.defineProperty(error, 'code', {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    return error;
  };
  const scenarios = [
    { config: { grantError: raw() }, code: 'GRANT_FAILED' },
    {
      config: { materialError: throwingGetter() },
      code: 'MATERIAL_UNAVAILABLE',
    },
    { config: { otpError: raw() }, code: 'OTP_UNAVAILABLE' },
    { config: { finishError: throwingGetter() }, code: 'FINISH_FAILED' },
    {
      config: {
        grantError: Object.assign(new Error('known'), { code: 'RATE_LIMITED' }),
      },
      code: 'RATE_LIMITED',
    },
    {
      config: {
        grantError: Object.assign(new Error('known'), {
          code: 'LEASE_EXPIRED',
        }),
      },
      code: 'LEASE_EXPIRED',
    },
  ];
  for (const scenario of scenarios) {
    const built = options({ runtimeConfig: scenario.config });
    built.value.port = newPort().port;
    const outcome = await runAuthFlow(
      built.value,
      new AbortController().signal,
    );
    assert.equal(outcome.status, 'blocked', scenario.code);
    assert.equal(outcome.reasonCode, scenario.code);
    const evidence = JSON.stringify(outcome);
    assert.equal(evidence.includes(secret), false);
    assert.match(outcome.reasonCode, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(evidence.includes('synthetic failure'), false);
  }
});

test('none never touches material, the port, or the adapters', async () => {
  const port = newPort();
  const built = options({
    port: port.port,
    profile: formProfile({ mode: 'none', formConfig: null }),
  });
  const outcome = await runAuthFlow(built.value, new AbortController().signal);
  assert.equal(outcome.status, 'not_required');
  assert.equal(outcome.reasonCode, 'AUTH_MODE_NONE');
  assert.equal(outcome.stateRef, null);
  assert.deepEqual(outcome.steps, []);
  assert.equal(built.runtime.log.material, 0);
  assert.equal(
    Object.values(built.runtime.log)
      .filter((value) => Array.isArray(value))
      .every((value) => value.length === 0),
    true,
  );
  assert.equal(built.adapter.calls.locate, 0);
  assert.equal(built.adapter.calls.evaluate, 0);
  assert.deepEqual(port.browser.calls, []);
  // The port was not closed either: the flow never used it.
  await port.port.executeAuth(
    {
      grantId: 'probe-none',
      ...binding,
      deadline,
      action: 'navigate_auth',
      slot: 'login_url',
      url: permitUrl,
    },
    { kind: 'navigate' },
    new AbortController().signal,
  );
  assert.deepEqual(
    port.browser.calls.map((call) => call.kind),
    ['navigate'],
  );
});

test('abort cancels the flow without any success or capture', async () => {
  const preAborted = options();
  preAborted.value.port = newPort().port;
  const controller = new AbortController();
  controller.abort();
  const stopped = await runAuthFlow(preAborted.value, controller.signal);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.reasonCode, 'CANCELLED');
  assert.equal(stopped.stateRef, null);

  // Abort from inside a primitive: the port binds methods at construction, so
  // the hook has to be wired before the port is created.
  const midController = new AbortController();
  const midFlight = newPort({
    hooks: { afterFill: () => midController.abort() },
  });
  const built = options({ port: midFlight.port });
  const outcome = await runAuthFlow(built.value, midController.signal);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.reasonCode, 'CANCELLED');
  assert.equal(built.runtime.log.captureGrants, 0);
  assert.equal(built.runtime.log.finishes.length, 0);
  await assertClosed(midFlight.port);
});

test('the private ticket and capture material stay out of the outcome', async () => {
  const port = newPort();
  const built = options({ port: port.port });
  const outcome = await runAuthFlow(built.value, new AbortController().signal);
  const evidence = JSON.stringify(outcome);
  assert.equal(evidence.includes(ticket), false);
  assert.equal(evidence.includes(secret), false);
  assert.equal(evidence.includes('capture-6a'), false);
  // The ticket crosses only the gate boundary, as the private port requires.
  assert.deepEqual(
    port.gateLog.filter((entry) => entry.kind === 'authorizeExport'),
    [{ kind: 'authorizeExport', grantId: 'capture-6a' }],
  );
});

test('storage_state material takes only the canonical resolveAuth shape', async () => {
  const storageRun = (material) => {
    const port = newPort();
    const built = options({
      port: port.port,
      profile: storageProfile(),
      criterion,
      runtimeConfig: {
        material: {
          mode: 'storage_state',
          material,
          expiresAt: materialExpiresAt,
        },
      },
    });
    return { ...built, port };
  };

  // Positive: the same JSON string resolveAuth hands back.
  const canonical = storageRun({ storageState: secretInputFixture() });
  const canonicalOutcome = await runAuthFlow(
    canonical.value,
    new AbortController().signal,
  );
  assert.equal(canonicalOutcome.status, 'succeeded');
  assert.deepEqual(
    canonical.port.browser.calls.map((call) => call.kind),
    ['prepare_state', 'navigate', 'export_state'],
  );

  // Positive: a plain approved object is accepted by the same validator.
  const objectRun = storageRun({
    storageState: JSON.parse(secretInputFixture()),
  });
  const objectOutcome = await runAuthFlow(
    objectRun.value,
    new AbortController().signal,
  );
  assert.equal(objectOutcome.status, 'succeeded');

  // Negative: the key must be `storageState`; a legacy/alias key is refused
  // before the port is even asked, so no prepare and no navigation happen.
  const legacy = storageRun({ state: JSON.parse(secretInputFixture()) });
  const legacyOutcome = await runAuthFlow(
    legacy.value,
    new AbortController().signal,
  );
  assert.equal(legacyOutcome.status, 'blocked');
  assert.equal(legacyOutcome.reasonCode, 'MATERIAL_INVALID');
  assert.equal(legacy.runtime.log.grants.length, 0);
  assert.deepEqual(legacy.port.browser.calls, []);

  class StateHolder {
    constructor() {
      Object.assign(this, JSON.parse(secretInputFixture()));
    }
  }
  const shapes = [
    { name: 'number', material: { storageState: 42 } },
    { name: 'array', material: { storageState: [] } },
    { name: 'null', material: { storageState: null } },
    { name: 'empty string', material: { storageState: '' } },
    { name: 'class instance', material: { storageState: new StateHolder() } },
    { name: 'form keys only', material: { username: user, password: secret } },
  ];
  for (const scenario of shapes) {
    const built = storageRun(scenario.material);
    const outcome = await runAuthFlow(
      built.value,
      new AbortController().signal,
    );
    assert.equal(outcome.status, 'blocked', scenario.name);
    assert.equal(outcome.reasonCode, 'MATERIAL_INVALID', scenario.name);
    assert.deepEqual(built.port.browser.calls, [], scenario.name);
  }

  // Negative: the real port validator rejects malformed JSON and foreign
  // origins without ever invoking a browser primitive.
  const rejected = [
    {
      name: 'malformed json',
      material: { storageState: '{"cookies":' },
      code: 'VALIDATION_ERROR',
    },
    {
      name: 'unknown fields',
      material: {
        storageState: JSON.stringify({ cookies: [], origins: [], extra: 1 }),
      },
      code: 'VALIDATION_ERROR',
    },
    {
      name: 'foreign cookie domain',
      material: {
        storageState: secretInputFixture({ cookie: { domain: 'evil.test' } }),
      },
      code: 'TARGET_NOT_ALLOWED',
    },
    {
      name: 'foreign origin entry',
      material: {
        storageState: secretInputFixture({
          origins: [{ origin: 'http://evil.test', localStorage: [] }],
        }),
      },
      code: 'TARGET_NOT_ALLOWED',
    },
  ];
  for (const scenario of rejected) {
    const built = storageRun(scenario.material);
    const outcome = await runAuthFlow(
      built.value,
      new AbortController().signal,
    );
    assert.equal(outcome.status, 'blocked', scenario.name);
    assert.equal(outcome.reasonCode, scenario.code, scenario.name);
    assert.deepEqual(built.port.browser.calls, [], scenario.name);
    assert.equal(built.runtime.log.captures.length, 0, scenario.name);
    assert.equal(
      JSON.stringify(outcome).includes(secret),
      false,
      scenario.name,
    );
  }

  // Negative: an accessor is rejected without being invoked or normalized.
  let accessed = 0;
  const accessorState = {};
  Object.defineProperty(accessorState, 'cookies', {
    enumerable: true,
    get() {
      accessed += 1;
      return [];
    },
  });
  const accessor = storageRun({ storageState: accessorState });
  const accessorOutcome = await runAuthFlow(
    accessor.value,
    new AbortController().signal,
  );
  assert.equal(accessorOutcome.status, 'blocked');
  assert.equal(accessorOutcome.reasonCode, 'VALIDATION_ERROR');
  assert.equal(accessed, 0);
  assert.deepEqual(accessor.port.browser.calls, []);
});

test('the port must belong to the same session as the binding', async () => {
  const port = newPort();
  const built = options({ port: port.port });
  built.value.binding = { ...binding, sessionId: 'sess-other' };
  const outcome = await runAuthFlow(built.value, new AbortController().signal);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.reasonCode, 'SESSION_MISMATCH');
  assert.equal(built.runtime.log.material, 0);
  assert.deepEqual(port.browser.calls, []);
});
