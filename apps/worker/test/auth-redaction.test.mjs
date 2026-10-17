// Pure Node: the real AUTH-6 flow and the real AUTH-5 private port over a
// synthetic browser that echoes the credentials back on the very first
// navigation (an auto-filled login page). Proves the pre-navigation priming
// keeps the secret out of the first observation, the recorded evidence, and the
// outcome — and that a `none` profile never primes anything.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivateAuthPort } from '@localqa/browser';
import { runAuthFlow } from '../dist/auth-flow.js';
import { textChanges } from '../dist/observation-text-diff.js';

const user = 'vault-username-8c';
const secret = 'vault-password-8c';
const origin = 'http://localhost:8080';
const permitUrl = `${origin}/permit-login`;
const nowIso = '2026-10-08T00:00:00.000Z';
const deadline = '2026-10-08T00:30:00.000Z';
const expiresAt = '2026-10-09T00:00:00.000Z';
const materialExpiresAt = '2026-10-08T00:10:00.000Z';
const pageId = '22222222-2222-4222-8222-222222222222';

const binding = {
  sessionId: 'sess-8c',
  projectId: 'proj-8c',
  runId: 'run-8c',
  taskId: 'task-8c',
  workerId: 'worker-8c',
  fencingToken: 4,
  contextVersion: 2,
  contextId: 'ctx-8c',
  profileId: 'profile-8c',
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
};

function profile(mode = 'form') {
  return {
    id: binding.profileId,
    projectId: binding.projectId,
    environmentId: null,
    name: 'Fixture auth profile',
    mode,
    allowedOrigins: [origin],
    sharingPolicy: 'exclusive_run',
    hasSecret: true,
    version: binding.profileVersion,
    status: 'active',
    formConfig:
      mode === 'form'
        ? {
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
          }
        : null,
  };
}

let snapshotSeed = 0;
function snapshot({ title, displayUrl, nodes }) {
  snapshotSeed += 1;
  return {
    snapshotId: `11111111-1111-4111-8111-${String(snapshotSeed).padStart(12, '0')}`,
    pageId,
    frameIds: ['main'],
    displayUrl,
    title,
    responseStatus: 200,
    capturedAt: nowIso,
    stateVersion: snapshotSeed,
    viewport: { width: 800, height: 600 },
    nodes,
    screenshotRef: 'shot-8c',
    networkSummary: [{ url: displayUrl, summary: title }],
    consoleSummary: [title],
    truncated: false,
    redacted: false,
  };
}

function node(nodeId, name, text, value) {
  return {
    nodeId,
    frameId: 'main',
    role: 'textbox',
    name,
    text,
    // A control's current content and its placeholder hint are snapshot fields
    // of their own now; the auto-filled login page carries the credentials
    // through all of them.
    ...(value !== undefined ? { value, placeholder: value } : {}),
    visible: true,
    enabled: true,
    bounds: { left: 0, top: 0, width: 10, height: 10 },
  };
}

function scenario({ withOtp = false } = {}) {
  const observed = [];
  const calls = [];
  const primitives = {
    async navigate(url) {
      calls.push({ kind: 'navigate', url });
      // The login page comes back already carrying both credentials.
      return snapshot({
        title: `Sign in as ${user}`,
        displayUrl: `${permitUrl}?filled=${encodeURIComponent(secret)}`,
        nodes: [
          node('user-field', user, user, user),
          node('pass-field', 'Password', secret, secret),
        ],
      });
    },
    async fill(target, value) {
      calls.push({ kind: 'fill', nodeId: target.nodeId, value });
      return snapshot({
        title: 'Filled',
        displayUrl: permitUrl,
        nodes: [node('user-field', 'User', 'User')],
      });
    },
    async submit() {
      calls.push({ kind: 'submit' });
      return snapshot({
        title: 'Welcome',
        displayUrl: `${origin}/home`,
        nodes: [node('testid_account-menu', 'Account', 'Account')],
      });
    },
    async prepareState() {
      calls.push({ kind: 'prepare_state' });
    },
    async exportState() {
      calls.push({ kind: 'export_state' });
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
  const priming = [];
  const originalPrime = port.primeSensitiveValues.bind(port);
  port.primeSensitiveValues = (values) => {
    priming.push([...values]);
    return originalPrime(values);
  };
  let seed = 0;
  const runtime = {
    async material() {
      return {
        mode: 'form',
        material: { username: user, password: secret },
        expiresAt: materialExpiresAt,
      };
    },
    async grantAuth(request) {
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
      observed.push(value);
    },
    async pauseForOtp() {
      throw new Error('no OTP service in this batch');
    },
    async recordAuthCriterion() {},
    async issueCaptureGrant() {
      return {
        grantId: 'capture-8c',
        ...binding,
        deadline,
        kind: 'capture_auth_state',
        captureTicket: 'capture-ticket-8c',
      };
    },
    async captureAuthState() {
      return { stateRef: 'state-ref-8c' };
    },
    async finishAuth() {},
  };
  const adapters = {
    async locate(current, locator) {
      return {
        snapshotId: current.snapshotId,
        pageId: current.pageId,
        frameId: 'main',
        nodeId: locator.value,
      };
    },
    async evaluate(_current, criterion) {
      return {
        criterionId: criterion.id,
        result: 'passed',
        reason: 'synthetic',
        evidenceRefs: [],
      };
    },
  };
  const configured = profile();
  if (withOtp) {
    configured.formConfig = { ...configured.formConfig };
  }
  return {
    observed,
    calls,
    priming,
    port,
    options: {
      profile: configured,
      binding,
      runtime,
      port,
      adapters,
      newRequestId: (() => {
        let count = 0;
        return () => `request-${(count += 1)}`;
      })(),
      now: () => Date.parse(nowIso),
    },
  };
}

test('the first observation after an auto-filled navigation carries no secret', async () => {
  const world = scenario();
  const outcome = await runAuthFlow(
    world.options,
    new AbortController().signal,
  );

  // The form flow primes exactly the known credentials before any effect.
  assert.deepEqual(world.priming, [[user, secret]]);
  assert.equal(world.calls[0].kind, 'navigate');

  // The very first observation is already redacted, in title, url and nodes.
  const first = world.observed[0];
  assert.equal(first.redacted, true);
  const firstJson = JSON.stringify(first);
  assert.equal(firstJson.includes(secret), false);
  assert.equal(firstJson.includes(encodeURIComponent(secret)), false);
  assert.equal(firstJson.includes(user), false);
  assert.equal(firstJson.includes('•'), true);
  // The filled controls' current values are secrets too.
  const filled = (nodeId) => first.nodes.find((n) => n.nodeId === nodeId);
  assert.equal(filled('user-field').value, '•');
  assert.equal(filled('pass-field').value, '•');
  assert.equal(filled('user-field').placeholder, '•');

  // No later observation, step, or outcome shows the material either.
  for (const observation of world.observed) {
    const json = JSON.stringify(observation);
    assert.equal(json.includes(secret), false);
    assert.equal(json.includes(user), false);
  }
  const outcomeJson = JSON.stringify(outcome);
  assert.equal(outcomeJson.includes(secret), false);
  assert.equal(outcomeJson.includes(user), false);
  assert.equal(outcomeJson.includes('•'), false);

  // "New text" derived from those observations cannot reintroduce them either.
  const changes = textChanges(world.observed[0], world.observed[1]);
  const changesJson = JSON.stringify(changes);
  assert.equal(changesJson.includes(secret), false);
  assert.equal(changesJson.includes(user), false);

  // The credentials still reach the fill primitive, which is their only channel.
  assert.deepEqual(
    world.calls
      .filter((call) => call.kind === 'fill')
      .map((call) => call.value),
    [user, secret],
  );
  assert.equal(outcome.status, 'succeeded');
});

test('a none profile never fetches material and never primes the port', async () => {
  const world = scenario();
  let materialCalls = 0;
  const originalMaterial = world.options.runtime.material;
  world.options.runtime.material = async () => {
    materialCalls += 1;
    return originalMaterial();
  };
  world.options.profile = profile('none');
  const outcome = await runAuthFlow(
    world.options,
    new AbortController().signal,
  );
  assert.equal(outcome.status, 'not_required');
  assert.equal(outcome.reasonCode, 'AUTH_MODE_NONE');
  assert.equal(materialCalls, 0);
  assert.deepEqual(world.priming, []);
  assert.deepEqual(world.observed, []);
  assert.deepEqual(world.calls, []);
  // The port was not closed either: it never belonged to this flow.
  assert.equal(world.port.sessionId, binding.sessionId);
});
