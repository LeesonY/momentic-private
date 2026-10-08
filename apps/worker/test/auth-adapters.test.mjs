// Pure Node: the real auth-adapters and the real evaluateTechnical source, the
// real AUTH-6 flow and the real AUTH-5 private port, over a labeled FakeSession
// and synthetic primitives. No Playwright launch, no browser, no model call.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPrivateAuthPort } from '@localqa/browser';
import { runAuthFlow } from '../dist/auth-flow.js';
import { createAuthAdapters } from '../dist/auth-adapters.js';

const user = 'vault-username-8b';
const secret = 'vault-password-8b';
const otp = 'vault-otp-8b';
const stateRef = 'state-ref-8b';
const origin = 'http://localhost:8080';
const permitUrl = `${origin}/permit-login`;
const nowIso = '2026-10-08T00:00:00.000Z';
const deadline = '2026-10-08T00:30:00.000Z';
const expiresAt = '2026-10-09T00:00:00.000Z';
const materialExpiresAt = '2026-10-08T00:10:00.000Z';
const pageId = '22222222-2222-4222-8222-222222222222';
const ownedRef = '11111111-1111-4111-8111-111111111111';

const binding = {
  sessionId: 'sess-8b',
  projectId: 'proj-8b',
  runId: 'run-8b',
  taskId: 'task-8b',
  workerId: 'worker-8b',
  fencingToken: 4,
  contextVersion: 2,
  contextId: 'ctx-8b',
  profileId: 'profile-8b',
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

const successCriterion = {
  id: 'logged-in',
  kind: 'element_visible',
  description: 'Account menu is visible',
  sourceKind: 'user_spec',
  sourceRef: 'fixture',
  locator: { by: 'test_id', value: 'account-menu' },
};

function formProfile(overrides = {}) {
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
      successCriterion,
    },
    ...overrides,
  };
}

let snapshotSeed = 0;
function snapshot({
  nodes,
  title = 'Login',
  responseStatus = 200,
  truncated = false,
} = {}) {
  snapshotSeed += 1;
  return {
    snapshotId: `11111111-1111-4111-8111-${String(snapshotSeed).padStart(12, '0')}`,
    pageId,
    frameIds: ['main'],
    displayUrl: permitUrl,
    title,
    responseStatus,
    capturedAt: nowIso,
    stateVersion: snapshotSeed,
    viewport: { width: 800, height: 600 },
    nodes: nodes ?? allNodes(),
    screenshotRef: 'shot-8b',
    networkSummary: [],
    consoleSummary: [],
    truncated,
    redacted: false,
  };
}

function node(nodeId, overrides = {}) {
  return {
    nodeId,
    frameId: 'main',
    role: 'textbox',
    name: nodeId,
    text: nodeId,
    visible: true,
    enabled: true,
    bounds: { left: 0, top: 0, width: 10, height: 10 },
    ...overrides,
  };
}

function allNodes() {
  return [
    node('user-field'),
    node('pass-field'),
    node('button'),
    node('otp-field'),
    node('testid_account-menu'),
  ];
}

/**
 * FakeSession mirroring the real resolveRegressionLocator / getSnapshot
 * signatures. The locator resolves against `observed`, and `getSnapshot` reads
 * that same cached observation, exactly like the real session does.
 */
function fakeSession(config = {}) {
  const calls = [];
  const observed = config.observed ?? snapshot();
  const session = {
    async resolveRegressionLocator(locator, signal) {
      calls.push({ value: locator.value, aborted: signal?.aborted ?? false });
      if (signal?.aborted) {
        throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      }
      const plan = config.plan?.(locator, calls.length) ?? {};
      if (plan.error) {
        throw Object.assign(new Error('locator'), { code: plan.error });
      }
      return {
        snapshotId: plan.snapshotId ?? observed.snapshotId,
        pageId: plan.pageId ?? observed.pageId,
        frameId: plan.frameId ?? 'main',
        nodeId: plan.nodeId ?? locator.value,
      };
    },
  };
  if (config.withSnapshotRead !== false) {
    session.getSnapshot = async () => config.readSnapshot ?? observed;
  }
  return { session, calls, observed };
}

function fakeRuntime() {
  const log = {
    material: 0,
    otp: 0,
    criteria: [],
    grants: [],
    observations: [],
    finishes: [],
  };
  let seed = 0;
  return {
    log,
    runtime: {
      async material() {
        log.material += 1;
        return {
          mode: 'form',
          material: { username: user, password: secret },
          expiresAt: materialExpiresAt,
        };
      },
      async grantAuth(request) {
        log.grants.push({ action: request.action, slot: request.slot });
        seed += 1;
        return {
          grantId: `permit-${seed}`,
          ...binding,
          deadline,
          action: request.action,
          slot: request.slot,
          ...(request.target ? { target: { ...request.target } } : {}),
          ...(request.action === 'navigate_auth' ? { url: permitUrl } : {}),
        };
      },
      async recordAuth() {},
      async recordAuthObservation(value) {
        log.observations.push(value);
      },
      async pauseForOtp() {
        log.otp += 1;
        return { code: otp };
      },
      async recordAuthCriterion(_snapshot, result) {
        log.criteria.push({ result: result.result, reason: result.reason });
      },
      async issueCaptureGrant() {
        return {
          grantId: 'capture-8b',
          ...binding,
          deadline,
          kind: 'capture_auth_state',
          captureTicket: 'capture-ticket-8b',
        };
      },
      async captureAuthState() {
        return { stateRef };
      },
      async finishAuth(ref) {
        log.finishes.push(ref);
      },
    },
  };
}

function scenario(config = {}) {
  const session = fakeSession(config.session);
  const adapters = createAuthAdapters({
    session: session.session,
    binding,
    criterion: config.criterion ?? successCriterion,
    ...(config.ownedEvidence ? { ownedEvidence: config.ownedEvidence } : {}),
  });
  const browser = { calls: [], snapshots: [] };
  const primitives = {
    async navigate() {
      const landed = snapshot({ title: 'Login page' });
      browser.calls.push({ kind: 'navigate' });
      browser.snapshots.push(landed);
      return landed;
    },
    async fill(target) {
      browser.calls.push({ kind: 'fill', target: { ...target } });
      return snapshot({ title: 'After fill' });
    },
    async submit() {
      browser.calls.push({ kind: 'submit' });
      return snapshot({ title: 'After submit' });
    },
    async prepareState() {
      browser.calls.push({ kind: 'prepare_state' });
    },
    async exportState() {
      browser.calls.push({ kind: 'export_state' });
      return {
        cookies: [
          { name: 'auth', value: secret, domain: 'localhost', path: '/' },
        ],
      };
    },
  };
  const port = createPrivateAuthPort({
    binding,
    gate: { authorize: async () => {}, authorizeExport: async () => {} },
    primitives,
    allowedOrigins: [origin],
    now: () => Date.parse(nowIso),
  });
  const runtime = fakeRuntime();
  let requestSeed = 0;
  const options = {
    profile: config.profile ?? formProfile(),
    binding,
    runtime: runtime.runtime,
    port,
    adapters,
    newRequestId: () => `request-${(requestSeed += 1)}`,
    now: () => Date.parse(nowIso),
  };
  return {
    adapters,
    session,
    browser,
    port,
    runtime,
    options,
    run: (signal = new AbortController().signal) =>
      runAuthFlow(options, signal),
  };
}

function signal() {
  return new AbortController().signal;
}

test('a target is never rewritten onto another snapshot', async () => {
  // The session resolved against its own observation; the flow holds another.
  // Same page, same node name: still refused.
  const foreign = snapshot();
  const held = snapshot();
  assert.equal(foreign.pageId, held.pageId);
  const world = scenario({ session: { observed: foreign } });
  await assert.rejects(
    world.adapters.locate(held, locators.usernameTarget, signal()),
    (error) => error.code === 'TARGET_NOT_FOUND',
  );

  // Without the cached snapshot read there is no handshake at all: construction
  // is refused, so no run can grant or touch the browser.
  assert.throws(
    () =>
      createAuthAdapters({
        session: fakeSession({ observed: foreign, withSnapshotRead: false })
          .session,
        binding,
        criterion: successCriterion,
        ownedEvidence: () => [ownedRef],
      }),
    (error) => error.code === 'VALIDATION_ERROR',
  );

  // A target that already belongs to the flow's snapshot passes through.
  const same = snapshot();
  const passthrough = scenario({ session: { observed: same } });
  const target = await passthrough.adapters.locate(
    same,
    locators.usernameTarget,
    signal(),
  );
  assert.equal(target.snapshotId, same.snapshotId);
  assert.equal(target.pageId, same.pageId);
  assert.equal(target.nodeId, 'user-field');
});

test('the fresh handshake registers the actual observation before the grant', async () => {
  const world = scenario({ ownedEvidence: () => [ownedRef] });
  const outcome = await world.run();
  assert.equal(outcome.status, 'succeeded');

  // The observation registered for the first fill is the session's own fresh
  // snapshot, redacted by the port — never the raw copy.
  const fresh = world.session.observed;
  const registered = world.runtime.log.observations.find(
    (item) => item.snapshotId === fresh.snapshotId,
  );
  assert.ok(registered);
  assert.equal(registered.redacted, true);
  assert.equal(registered.screenshotRef, null);
  assert.notEqual(registered, fresh);

  // The fill carries the fresh snapshot id — not a rewritten one.
  const fill = world.browser.calls.find((call) => call.kind === 'fill');
  assert.equal(fill.target.snapshotId, fresh.snapshotId);
  assert.equal(fill.target.pageId, fresh.pageId);
  assert.equal(fill.target.frameId, 'main');
  assert.equal(
    world.runtime.log.observations.some(
      (item) => item.snapshotId === fill.target.snapshotId,
    ),
    true,
  );
});

test('the fresh observation carries no known credential', async () => {
  // The page echoes the credentials back in the fresh observation.
  const echoed = snapshot({
    title: `Welcome ${user}`,
    nodes: [
      node('user-field', user, secret),
      node('pass-field', secret, secret),
    ],
  });
  echoed.displayUrl = `${permitUrl}?u=${encodeURIComponent(secret)}`;
  const world = scenario({ session: { observed: echoed } });
  await world.run();
  const registered = world.runtime.log.observations.find(
    (item) => item.snapshotId === echoed.snapshotId,
  );
  assert.ok(registered);
  const json = JSON.stringify(registered);
  assert.equal(json.includes(user), false);
  assert.equal(json.includes(secret), false);
  assert.equal(json.includes(encodeURIComponent(secret)), false);
  assert.equal(json.includes('•'), true);
  // The raw observation itself was never handed to the runtime.
  assert.equal(world.runtime.log.observations.includes(echoed), false);
});

test('missing, ambiguous, hidden and foreign targets keep stable codes', async () => {
  const held = snapshot();
  const cases = [
    {
      name: 'ambiguous',
      config: { session: { plan: () => ({ error: 'LOCATOR_NOT_UNIQUE' }) } },
      code: 'TARGET_AMBIGUOUS',
    },
    {
      name: 'unknown failure',
      config: { session: { plan: () => ({ error: 'SOMETHING_ELSE' }) } },
      code: 'RESOLVER_ERROR',
    },
    {
      name: 'cancelled',
      config: { session: { plan: () => ({ error: 'CANCELLED' }) } },
      code: 'CANCELLED',
    },
    {
      name: 'foreign page',
      config: {
        session: {
          plan: () => ({ pageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
        },
      },
      code: 'TARGET_NOT_FOUND',
    },
    {
      name: 'node absent from the snapshot',
      config: { session: { plan: () => ({ nodeId: 'ghost-node' }) } },
      code: 'TARGET_NOT_FOUND',
    },
  ];
  for (const scenarioCase of cases) {
    const world = scenario(scenarioCase.config);
    await assert.rejects(
      world.adapters.locate(
        world.session.observed,
        locators.usernameTarget,
        signal(),
      ),
      (error) => error.code === scenarioCase.code,
      scenarioCase.name,
    );
  }

  // An explicit "not present" is the only signal that becomes null.
  const absent = scenario({
    session: { plan: () => ({ error: 'LOCATOR_NOT_FOUND' }) },
  });
  assert.equal(
    await absent.adapters.locate(held, locators.usernameTarget, signal()),
    null,
  );

  // Hidden nodes are refused as hidden, not as missing.
  const hiddenSnapshot = snapshot({
    nodes: [node('hidden-node', { visible: false })],
  });
  const hidden = scenario({
    session: {
      observed: hiddenSnapshot,
      plan: () => ({ nodeId: 'hidden-node' }),
    },
  });
  await assert.rejects(
    hidden.adapters.locate(hiddenSnapshot, locators.usernameTarget, signal()),
    (error) => error.code === 'TARGET_HIDDEN',
  );

  // An already aborted signal never reaches the session.
  const aborted = scenario();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    aborted.adapters.locate(held, locators.usernameTarget, controller.signal),
    (error) => error.code === 'CANCELLED',
  );
  assert.deepEqual(aborted.session.calls, []);

  // Through the flow: an ambiguous required target blocks with that code and
  // no browser effect happens.
  const flow = scenario({
    session: { plan: () => ({ error: 'LOCATOR_NOT_UNIQUE' }) },
  });
  const outcome = await flow.run();
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.reasonCode, 'TARGET_AMBIGUOUS');
  assert.equal(
    flow.browser.calls.some((call) => call.kind === 'fill'),
    false,
  );
});

test('an optional OTP target is skipped only on the explicit absence signal', async () => {
  const withOtp = formProfile();
  withOtp.formConfig = { ...withOtp.formConfig, otpTarget: locators.otpTarget };

  // Absent: the flow skips the OTP wait and moves on to the criterion.
  const absent = scenario({
    profile: withOtp,
    ownedEvidence: () => [ownedRef],
    session: {
      plan: (locator) =>
        locator.value === locators.otpTarget.value
          ? { error: 'LOCATOR_NOT_FOUND' }
          : {},
    },
  });
  const skipped = await absent.run();
  assert.equal(skipped.status, 'succeeded');
  assert.equal(absent.runtime.log.otp, 0);

  // Ambiguous: refused, and no OTP wait is requested.
  const ambiguous = scenario({
    profile: withOtp,
    ownedEvidence: () => [ownedRef],
    session: {
      plan: (locator) =>
        locator.value === locators.otpTarget.value
          ? { error: 'LOCATOR_NOT_UNIQUE' }
          : {},
    },
  });
  const blocked = await ambiguous.run();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reasonCode, 'TARGET_AMBIGUOUS');
  assert.equal(ambiguous.runtime.log.otp, 0);
});

test('the criterion is frozen and evaluated by the real evaluateTechnical', async () => {
  const held = snapshot({ nodes: [node('testid_account-menu')] });
  const evidence = [ownedRef];

  // Swapping the criterion is refused before any evaluation.
  const swapped = scenario({ ownedEvidence: () => evidence });
  await assert.rejects(
    swapped.adapters.evaluate(
      held,
      { ...successCriterion, id: 'different-criterion' },
      signal(),
    ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    swapped.adapters.evaluate(
      held,
      { ...successCriterion, locator: { by: 'css', value: 'body' } },
      signal(),
    ),
    (error) => error.code === 'VALIDATION_ERROR',
  );

  // The real evaluator's own reasons appear on every path.
  const withEvidence = scenario({ ownedEvidence: () => evidence });
  const passed = await withEvidence.adapters.evaluate(
    held,
    successCriterion,
    signal(),
  );
  assert.equal(passed.result, 'passed');
  assert.equal(passed.reason, 'Visible matching node observed');
  assert.deepEqual(passed.evidenceRefs, evidence);

  // No owned evidence: a would-be pass becomes unknown, never a pass.
  const withoutEvidence = scenario();
  const unknown = await withoutEvidence.adapters.evaluate(
    held,
    successCriterion,
    signal(),
  );
  assert.equal(unknown.result, 'unknown');
  assert.equal(unknown.reason, 'Required owned evidence missing');

  // Unsupported oracle and absence of the node keep their documented results.
  const unsupportedCriterion = {
    ...successCriterion,
    locator: { by: 'label', value: 'nope' },
  };
  const unsupported = scenario({
    criterion: unsupportedCriterion,
    ownedEvidence: () => evidence,
  });
  const unsupportedResult = await unsupported.adapters.evaluate(
    held,
    unsupportedCriterion,
    signal(),
  );
  assert.equal(unsupportedResult.result, 'unknown');
  assert.equal(unsupportedResult.reason, 'Locator oracle not implemented');

  const missing = scenario({ ownedEvidence: () => evidence });
  const missingResult = await missing.adapters.evaluate(
    snapshot({ nodes: [node('other-node')] }),
    successCriterion,
    signal(),
  );
  assert.equal(missingResult.result, 'failed');
  assert.equal(
    missingResult.reason,
    'Fixed sourced locator absent from fresh observation',
  );

  const truncated = scenario({ ownedEvidence: () => evidence });
  const truncatedResult = await truncated.adapters.evaluate(
    snapshot({ nodes: [node('other-node')], truncated: true }),
    successCriterion,
    signal(),
  );
  assert.equal(truncatedResult.result, 'unknown');
  assert.equal(
    truncatedResult.reason,
    'Truncated observation cannot prove absence',
  );

  // The http_status oracle comes from the same evaluator.
  const statusCriterion = {
    id: 'entry-ok',
    kind: 'http_status',
    description: 'Entry responded',
    sourceKind: 'generic_smoke',
    sourceRef: 'fixture',
  };
  const status = scenario({
    criterion: statusCriterion,
    ownedEvidence: () => evidence,
  });
  const statusResult = await status.adapters.evaluate(
    snapshot({ responseStatus: 500 }),
    statusCriterion,
    signal(),
  );
  assert.equal(statusResult.result, 'not_evaluated');
  assert.equal(
    statusResult.reason,
    'Infrastructure/entry HTTP response blocks evaluation',
  );
});

test('a criterion swap or missing evidence blocks the flow without a capture', async () => {
  const swappedProfile = formProfile();
  swappedProfile.formConfig = {
    ...swappedProfile.formConfig,
    successCriterion: { ...successCriterion, id: 'other-criterion' },
  };
  const swapped = scenario({
    criterion: successCriterion,
    profile: swappedProfile,
    ownedEvidence: () => [ownedRef],
  });
  const swappedOutcome = await swapped.run();
  assert.equal(swappedOutcome.status, 'blocked');
  assert.equal(swappedOutcome.reasonCode, 'VALIDATION_ERROR');
  assert.equal(swappedOutcome.stateRef, null);
  assert.equal(swapped.runtime.log.finishes.length, 0);

  const noEvidence = scenario();
  const noEvidenceOutcome = await noEvidence.run();
  assert.equal(noEvidenceOutcome.status, 'blocked');
  assert.equal(noEvidenceOutcome.reasonCode, 'CRITERION_UNKNOWN');
  assert.equal(noEvidenceOutcome.stateRef, null);
  assert.deepEqual(noEvidence.runtime.log.criteria.at(-1), {
    result: 'unknown',
    reason: 'Required owned evidence missing',
  });
  assert.equal(noEvidence.runtime.log.finishes.length, 0);

  const withEvidence = scenario({ ownedEvidence: () => [ownedRef] });
  const successOutcome = await withEvidence.run();
  assert.equal(successOutcome.status, 'succeeded');
  assert.equal(successOutcome.stateRef, stateRef);
});

test('the adapter module has no model or browser-tool fallback', () => {
  const source = readFileSync(
    new URL('../src/auth-adapters.ts', import.meta.url),
    'utf8',
  );
  // Strip comments first: the module documents what it must not do.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [
    'model-gateway',
    '@localqa/agents',
    'executeTool',
    'BrowserTool',
    'ToolCall',
    'playwright',
  ]) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
  assert.equal(code.includes("from '@localqa/domain'"), true);
  // The compiled module only imports the evaluator, the contract guard, and the
  // stable reason vocabulary: no model, browser, or tool runner.
  const built = readFileSync(
    new URL('../dist/auth-adapters.js', import.meta.url),
    'utf8',
  );
  const imports = [...built.matchAll(/from '([^']+)'/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports.sort(), [
    '@localqa/browser',
    '@localqa/contracts',
    '@localqa/domain',
  ]);
});
