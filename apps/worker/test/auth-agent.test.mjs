// Pure Node agent (Mo-style) sign-in: the real runAuthFlow, the real AUTH-5
// private port, the real auth adapters and the real model driver run over a
// FakeBrowser and an explicitly labeled Fake Runtime / fake model call. No
// Chromium, PostgreSQL or provider is involved, and no assertion below claims
// a server-verified gate or a real model decision.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivateAuthPort } from '@localqa/browser';
import { AGENT_LOGIN_CRITERION } from '@localqa/domain';
import { runAuthFlow } from '../dist/auth-flow.js';
import { createAuthAdapters } from '../dist/auth-adapters.js';
import {
  agentObservation,
  createAgentLoginDriver,
  parseAgentDecision,
} from '../dist/auth-agent.js';

const user = 'agent-user-7c@example.test';
const secret = 'agent-password-7c';
const otp = '482913';
const origin = 'http://localhost:8080';
const loginUrl = `${origin}/login`;
const nowIso = '2026-10-11T00:00:00.000Z';
const deadline = '2026-10-11T00:30:00.000Z';
const expiresAt = '2026-10-12T00:00:00.000Z';
const materialExpiresAt = '2026-10-11T00:10:00.000Z';
const pageId = '22222222-2222-4222-8222-222222222222';

const binding = {
  sessionId: 'sess-7c',
  projectId: 'proj-7c',
  runId: 'run-7c',
  taskId: 'task-7c',
  workerId: 'worker-7c',
  fencingToken: 4,
  contextVersion: 2,
  contextId: 'ctx-7c',
  profileId: 'profile-7c',
  profileVersion: 1,
  authEpoch: 1,
  purpose: 'initializer',
  status: 'active',
  expiresAt,
};

const variables = [
  { name: 'QA_USERNAME', sensitive: false, note: '登录账号' },
  { name: 'QA_PASSWORD', sensitive: true },
];

function agentProfile(overrides = {}) {
  return {
    id: binding.profileId,
    projectId: binding.projectId,
    environmentId: null,
    name: 'Agent sign-in fixture',
    mode: 'agent',
    allowedOrigins: [origin],
    sharingPolicy: 'exclusive_run',
    hasSecret: true,
    version: binding.profileVersion,
    status: 'active',
    formConfig: null,
    agentConfig: {
      loginUrl,
      instructions: '用户名填 QA_USERNAME，密码填 QA_PASSWORD，点击登录。',
      variables,
    },
    ...overrides,
  };
}

function node(nodeId, role, name, extra = {}) {
  return {
    nodeId,
    frameId: 'main',
    role,
    name,
    text: '',
    visible: true,
    enabled: true,
    bounds: { left: 0, top: 0, width: 10, height: 10 },
    ...extra,
  };
}

let seed = 0;
function snapshot(
  page,
  extraNodes = [],
  otpVisible = false,
  truncated = false,
) {
  seed += 1;
  const login = [
    node('user-field', 'email', '邮箱'),
    node('pass-field', 'password', '密码'),
    ...(otpVisible ? [node('otp-field', 'text', '验证码')] : []),
    node('submit', 'button', '登录'),
  ];
  const dashboard = [
    node('menu', 'button', `当前用户 ${user}`),
    node('logout', 'link', '退出登录'),
  ];
  return {
    snapshotId: `11111111-1111-4111-8111-${String(seed).padStart(12, '0')}`,
    pageId,
    frameIds: ['main'],
    displayUrl: page === 'login' ? loginUrl : `${origin}/dashboard`,
    title: page,
    responseStatus: 200,
    capturedAt: nowIso,
    stateVersion: seed,
    viewport: { width: 800, height: 600 },
    nodes: [...(page === 'login' ? login : dashboard), ...extraNodes],
    screenshotRef: null,
    networkSummary: [],
    consoleSummary: [],
    truncated,
    redacted: false,
  };
}

/** Stateful FakeBrowser: clicking `submit` signs in; nothing is real. */
function fakeBrowser(config = {}) {
  const calls = [];
  let page = 'login';
  let current = snapshot(page, [], config.otpVisible, config.truncated);
  const observe = () =>
    (current = snapshot(
      page,
      config.extraNodes?.(page),
      config.otpVisible,
      config.truncated,
    ));
  return {
    calls,
    session: {
      async resolveRegressionLocator() {
        throw Object.assign(new Error('not used'), {
          code: 'VALIDATION_ERROR',
        });
      },
      async getSnapshot(options) {
        return options?.forceFresh ? observe() : current;
      },
    },
    primitives: {
      async navigate(url) {
        calls.push({ kind: 'navigate', url });
        page = 'login';
        return observe();
      },
      async fill(target, value) {
        calls.push({ kind: 'fill', nodeId: target.nodeId, value });
        return observe();
      },
      async submit(target) {
        calls.push({ kind: 'click', nodeId: target.nodeId });
        if (target.nodeId === 'submit' && !config.loginFails) {
          if (config.loginNavigationDelayMs)
            setTimeout(() => {
              page = 'dashboard';
            }, config.loginNavigationDelayMs);
          else page = 'dashboard';
        }
        return observe();
      },
      async prepareState() {
        throw new Error('not used');
      },
      async exportState() {
        calls.push({ kind: 'export_state' });
        return { cookies: [], origins: [] };
      },
    },
  };
}

/** Fake Runtime: no Coordinator, gate CAS or OTP ticket service. */
function fakeRuntime(config = {}) {
  const log = { grants: [], criteria: [], finishes: [], otp: 0, observed: [] };
  let grantSeed = 0;
  return {
    log,
    runtime: {
      async material() {
        return {
          mode: 'agent',
          material: config.material ?? {
            QA_USERNAME: user,
            QA_PASSWORD: secret,
          },
          expiresAt: materialExpiresAt,
        };
      },
      async grantAuth(request) {
        log.grants.push(request);
        grantSeed += 1;
        return {
          grantId: `permit-${grantSeed}`,
          ...binding,
          deadline,
          action: request.action,
          slot: request.slot,
          ...(request.target ? { target: { ...request.target } } : {}),
          ...(request.action === 'navigate_auth' ? { url: loginUrl } : {}),
        };
      },
      async recordAuth() {},
      async recordAuthObservation(observed) {
        log.observed.push(observed);
      },
      async pauseForOtp() {
        log.otp += 1;
        return { code: otp };
      },
      async recordAuthCriterion(_snapshot, result) {
        log.criteria.push(result);
      },
      async issueCaptureGrant() {
        return {
          grantId: 'capture-7c',
          ...binding,
          deadline,
          kind: 'capture_auth_state',
          captureTicket: 'capture-ticket-7c',
        };
      },
      async captureAuthState() {
        return { stateRef: 'state-ref-7c' };
      },
      async finishAuth(ref) {
        log.finishes.push(ref);
      },
    },
  };
}

/** A scripted model: each call returns the next step for the given input. */
function scriptedModel(steps) {
  const requests = [];
  let index = 0;
  return {
    requests,
    call: async (messages, outputSchema) => {
      requests.push({ messages, outputSchema });
      const input = JSON.parse(messages[1].content[0].text);
      const step = steps[Math.min(index++, steps.length - 1)];
      const data = typeof step === 'function' ? step(input) : step;
      return {
        requestResult: data.requestResult ?? 'ok',
        errorCode: data.errorCode ?? null,
        data: data.requestResult ? null : data,
      };
    },
  };
}

function nodeIdFor(input, role) {
  return input.observation.nodes.find((entry) => entry.role === role)?.nodeId;
}

const signIn = [
  (input) => ({
    action: 'fill',
    variable: 'QA_USERNAME',
    nodeId: nodeIdFor(input, 'email'),
  }),
  (input) => ({
    action: 'fill',
    variable: 'QA_PASSWORD',
    nodeId: nodeIdFor(input, 'password'),
  }),
  (input) => ({ action: 'click', nodeId: nodeIdFor(input, 'button') }),
  { action: 'done' },
];

function run(config = {}) {
  const browser = fakeBrowser(config.browser);
  const runtime = fakeRuntime(config.runtime);
  const model = scriptedModel(config.steps ?? signIn);
  const port = createPrivateAuthPort({
    binding,
    gate: { async authorize() {}, async authorizeExport() {} },
    primitives: browser.primitives,
    allowedOrigins: [origin],
    now: () => Date.parse(nowIso),
  });
  const adapters = createAuthAdapters({
    session: browser.session,
    binding,
    criterion: AGENT_LOGIN_CRITERION,
    ownedEvidence: (observed) => [observed.snapshotId],
  });
  if (config.preflightTarget) adapters.preflightTarget = config.preflightTarget;
  return {
    browser,
    runtime,
    model,
    outcome: runAuthFlow(
      {
        profile: config.profile ?? agentProfile(),
        binding,
        runtime: runtime.runtime,
        port,
        adapters,
        criterion: AGENT_LOGIN_CRITERION,
        agent:
          'agent' in config
            ? config.agent
            : createAgentLoginDriver({ call: model.call }),
        settleMs: 0,
        postSubmitPollMs: config.postSubmitPollMs ?? 0,
        newRequestId: (() => {
          let n = 0;
          return () => `request-${(n += 1)}`;
        })(),
        now: () => Date.parse(nowIso),
      },
      new AbortController().signal,
    ),
  };
}

test('agent sign-in fills named variables, clicks, and captures on the oracle', async () => {
  const { browser, runtime, outcome } = run();
  const result = await outcome;
  assert.equal(result.status, 'succeeded', result.reasonCode);
  assert.equal(result.stateRef, 'state-ref-7c');
  assert.deepEqual(
    runtime.log.grants.map((grant) => `${grant.action}:${grant.slot}`),
    [
      'navigate_auth:login_url',
      'fill_credential:variable',
      'fill_credential:variable',
      'submit_auth:submit',
    ],
  );
  // Values are substituted inside the private port, into the chosen nodes.
  assert.deepEqual(
    browser.calls.filter((call) => call.kind === 'fill'),
    [
      { kind: 'fill', nodeId: 'user-field', value: user },
      { kind: 'fill', nodeId: 'pass-field', value: secret },
    ],
  );
  assert.equal(runtime.log.criteria.length, 1);
  assert.equal(runtime.log.criteria[0].criterionId, AGENT_LOGIN_CRITERION.id);
  assert.equal(runtime.log.criteria[0].result, 'passed');
  assert.deepEqual(runtime.log.finishes, ['state-ref-7c']);
});

test('the model never receives a variable value, only names and notes', async () => {
  const { model, runtime, outcome } = run();
  assert.equal((await outcome).status, 'succeeded');
  assert.equal(model.requests.length, 4);
  for (const request of model.requests) {
    const text = JSON.stringify(request.messages);
    assert.ok(!text.includes(secret), 'password reached the model');
    assert.ok(!text.includes(user), 'account value reached the model');
    assert.ok(text.includes('QA_PASSWORD'));
  }
  // Registered observations are scrubbed of every filled value as well.
  for (const observed of runtime.log.observed) {
    const text = JSON.stringify(observed);
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(user));
  }
  // The structured output never has a field that could carry a value.
  assert.deepEqual(
    Object.keys(model.requests[0].outputSchema.properties).sort(),
    ['action', 'frameId', 'nodeId', 'reason', 'variable'],
  );
});

test('invalid proposals are re-asked without any grant or browser effect', async () => {
  const { browser, runtime, model, outcome } = run({
    steps: [
      { action: 'fill', variable: 'QA_TOKEN', nodeId: 'user-field' },
      { action: 'click', nodeId: 'not-on-this-page' },
      { action: 'fill', variable: 'QA_USERNAME' },
      ...signIn,
    ],
  });
  assert.equal((await outcome).status, 'succeeded');
  const issues = model.requests.map(
    (request) => JSON.parse(request.messages[1].content[0].text).issue,
  );
  assert.deepEqual(issues.slice(0, 4), [
    null,
    'UNKNOWN_VARIABLE',
    'TARGET_INVALID',
    'TARGET_MISSING',
  ]);
  assert.equal(runtime.log.grants.length, 4);
  assert.equal(browser.calls.filter((call) => call.kind === 'fill').length, 2);
});

test('stale AI login target is reobserved before any credential grant', async () => {
  let probes = 0;
  const attempt = run({
    steps: [signIn[0], signIn[0], ...signIn.slice(1)],
    preflightTarget: async () => ++probes !== 1,
  });
  const outcome = await attempt.outcome;
  assert.equal(outcome.status, 'succeeded', outcome.reasonCode);
  assert.equal(probes, 4);
  assert.equal(attempt.runtime.log.grants.length, 4);
  assert.equal(
    attempt.browser.calls.filter((x) => x.kind === 'fill').length,
    2,
  );
  const requests = attempt.model.requests.map((x) =>
    JSON.parse(x.messages[1].content[0].text),
  );
  assert.equal(requests[1].issue, 'TARGET_STALE');
  assert.notEqual(requests[0].observation.url, undefined);
  assert.ok(!JSON.stringify(requests).includes(secret));
});

test('persistently changing login DOM blocks without granting or filling', async () => {
  const attempt = run({
    steps: [signIn[0]],
    preflightTarget: async () => false,
  });
  const outcome = await attempt.outcome;
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.reasonCode, 'TARGET_STALE');
  assert.deepEqual(
    attempt.runtime.log.grants.map((g) => g.action),
    ['navigate_auth'],
  );
  assert.equal(
    attempt.browser.calls.filter((x) => x.kind === 'fill').length,
    0,
  );
  assert.equal(attempt.runtime.log.finishes.length, 0);
  assert.equal(attempt.model.requests.length, 4);
});

test('the agent decides it is signed in; no server page heuristic overrides it', async () => {
  // The page still shows the sign-in form, but the agent judged it signed in
  // (Mo-style). Its decision is recorded on the observation and captured.
  const { runtime, outcome } = run({
    browser: { loginFails: true },
    steps: [...signIn.slice(0, 3), { action: 'done' }],
  });
  const result = await outcome;
  assert.equal(result.status, 'succeeded', result.reasonCode);
  assert.equal(runtime.log.criteria.length, 1);
  assert.equal(runtime.log.criteria[0].result, 'passed');
  assert.deepEqual(runtime.log.finishes, ['state-ref-7c']);
});

test('delayed login navigation settles read-only before the next model decision', async () => {
  const attempt = run({
    browser: { loginNavigationDelayMs: 14 },
    postSubmitPollMs: 6,
  });
  const result = await attempt.outcome;
  assert.equal(result.status, 'succeeded', result.reasonCode);
  assert.equal(attempt.model.requests.length, 4);
  assert.equal(
    attempt.browser.calls.filter((x) => x.kind === 'click').length,
    1,
  );
  assert.equal(attempt.runtime.log.criteria[0].result, 'passed');
});

test('waiting on a stalled login page only re-observes, bounded by the step limit', async () => {
  const attempt = run({
    browser: { loginFails: true },
    steps: [...signIn.slice(0, 3), { action: 'wait' }],
  });
  const result = await attempt.outcome;
  assert.equal(result.reasonCode, 'AGENT_STEP_LIMIT');
  assert.equal(attempt.model.requests.length, 12);
  assert.equal(
    attempt.browser.calls.filter((x) => x.kind === 'click').length,
    1,
  );
  assert.deepEqual(attempt.runtime.log.finishes, []);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('a repeated submit on a stalled page is not executed; the agent then reports why', async () => {
  const attempt = run({
    browser: { loginFails: true },
    steps: [
      ...signIn.slice(0, 3),
      signIn[2],
      { action: 'blocked', reason: '页面提示：用户名或密码错误' },
    ],
  });
  const result = await attempt.outcome;
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'AGENT_LOGIN_BLOCKED');
  assert.equal(result.detail, '页面提示：用户名或密码错误');
  assert.equal(
    attempt.browser.calls.filter((x) => x.kind === 'click').length,
    1,
  );
  assert.equal(
    attempt.runtime.log.grants.filter((g) => g.action === 'submit_auth').length,
    1,
  );
  const issues = attempt.model.requests.map(
    (request) => JSON.parse(request.messages[1].content[0].text).issue,
  );
  assert.equal(issues[4], 'SUBMIT_ALREADY_TRIED');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("a blocked decision stands with the agent's own reason; no server recheck", async () => {
  const attempt = run({
    browser: { truncated: true },
    steps: [{ action: 'blocked', reason: '不确定页面结构' }, ...signIn],
  });
  const result = await attempt.outcome;
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'AGENT_LOGIN_BLOCKED');
  assert.equal(result.detail, '不确定页面结构');
  assert.equal(attempt.model.requests.length, 1);
  assert.deepEqual(
    attempt.runtime.log.grants.map((x) => x.action),
    ['navigate_auth'],
  );
  assert.deepEqual(attempt.runtime.log.finishes, []);
});

test('captcha/SSO/lock/manual blocked decisions are never rechecked or executed', async () => {
  for (const reason of [
    '需完成验证码',
    '需要第三方SSO',
    '账号已锁定',
    '需要人工确认',
  ]) {
    const attempt = run({ steps: [{ action: 'blocked', reason }, ...signIn] });
    const result = await attempt.outcome;
    assert.equal(result.reasonCode, 'AGENT_LOGIN_BLOCKED');
    assert.equal(attempt.model.requests.length, 1);
    assert.deepEqual(
      attempt.runtime.log.grants.map((x) => x.action),
      ['navigate_auth'],
    );
  }
  const challengeOnPage = run({
    browser: { otpVisible: true },
    steps: [{ action: 'blocked', reason: '无法继续' }, ...signIn],
  });
  assert.equal(
    (await challengeOnPage.outcome).reasonCode,
    'AGENT_LOGIN_BLOCKED',
  );
  assert.equal(challengeOnPage.model.requests.length, 1);
});

test('blocked after credential fill never retries or repeats a mutation', async () => {
  const attempt = run({ steps: [signIn[0], { action: 'blocked' }, ...signIn] });
  assert.equal((await attempt.outcome).reasonCode, 'AGENT_LOGIN_BLOCKED');
  assert.equal(attempt.model.requests.length, 2);
  assert.deepEqual(
    attempt.runtime.log.grants.map((x) => x.action),
    ['navigate_auth', 'fill_credential'],
  );
});

test('blocked, step limit and missing driver stop without capture', async () => {
  const blocked = run({ steps: [{ action: 'blocked' }] });
  const result = await blocked.outcome;
  assert.equal(result.reasonCode, 'AGENT_LOGIN_BLOCKED');
  assert.deepEqual(blocked.runtime.log.finishes, []);

  const looping = run({ steps: [{ action: 'wait' }] });
  const limited = await looping.outcome;
  assert.equal(limited.reasonCode, 'AGENT_STEP_LIMIT');
  assert.equal(looping.model.requests.length, 12);

  const missing = run({ agent: undefined });
  assert.equal((await missing.outcome).reasonCode, 'AGENT_DRIVER_MISSING');
  assert.equal(missing.runtime.log.grants.length, 0);
});

test('a missing variable value blocks before any navigation', async () => {
  const { browser, runtime, outcome } = run({
    runtime: { material: { QA_USERNAME: user } },
  });
  assert.equal((await outcome).reasonCode, 'MATERIAL_INVALID');
  assert.equal(browser.calls.length, 0);
  assert.equal(runtime.log.grants.length, 0);
});

test('one verification code is requested from the user, never twice', async () => {
  const withOtp = run({
    browser: { otpVisible: true },
    steps: [
      ...signIn.slice(0, 2),
      { action: 'otp', nodeId: 'otp-field' },
      ...signIn.slice(2),
    ],
  });
  assert.equal((await withOtp.outcome).status, 'succeeded');
  assert.equal(withOtp.runtime.log.otp, 1);
  assert.ok(
    withOtp.browser.calls.some(
      (call) => call.kind === 'fill' && call.value === otp,
    ),
  );
  assert.ok(withOtp.runtime.log.grants.some((grant) => grant.slot === 'otp'));

  const twice = run({
    browser: { otpVisible: true },
    steps: [
      { action: 'otp', nodeId: 'otp-field' },
      { action: 'otp', nodeId: 'otp-field' },
    ],
  });
  assert.equal((await twice.outcome).reasonCode, 'OTP_UNAVAILABLE');
  assert.equal(twice.runtime.log.otp, 1);
});

test('provider stops propagate; malformed output is re-asked', async () => {
  const stopped = run({
    steps: [{ requestResult: 'failed', errorCode: 'MODEL_NOT_CONFIGURED' }],
  });
  const result = await stopped.outcome;
  assert.equal(result.status, 'blocked');
  assert.equal(stopped.runtime.log.grants.length, 1);

  const malformed = run({
    steps: [{ requestResult: 'malformed' }, ...signIn],
  });
  assert.equal((await malformed.outcome).status, 'succeeded');
});

test('parseAgentDecision binds targets to the given snapshot only', () => {
  const observed = snapshot('login');
  assert.deepEqual(
    parseAgentDecision(
      { action: 'fill', variable: 'QA_PASSWORD', nodeId: 'pass-field' },
      { snapshot: observed, variables },
    ),
    {
      kind: 'fill',
      variable: 'QA_PASSWORD',
      target: {
        snapshotId: observed.snapshotId,
        pageId,
        nodeId: 'pass-field',
        frameId: 'main',
      },
    },
  );
  assert.deepEqual(
    parseAgentDecision(
      { action: 'done', nodeId: 'x' },
      {
        snapshot: observed,
        variables,
      },
    ),
    { kind: 'done' },
  );
  assert.deepEqual(
    parseAgentDecision(
      { action: 'blocked', reason: '需要验证码' },
      { snapshot: observed, variables },
    ),
    { kind: 'blocked', category: 'challenge', reason: '需要验证码' },
  );
  assert.deepEqual(
    parseAgentDecision(
      { action: 'blocked', reason: '页面结构不清晰' },
      { snapshot: observed, variables },
    ),
    { kind: 'blocked', category: 'unknown', reason: '页面结构不清晰' },
  );
  assert.equal(
    parseAgentDecision({ action: 'type' }, { snapshot: observed, variables })
      .kind,
    'invalid',
  );
});

test('agentObservation keeps visible nodes, interactive roles first', () => {
  const observed = snapshot('login', [
    node('hidden', 'button', 'Hidden', { visible: false }),
  ]);
  observed.nodes.unshift(node('heading', 'h1', '欢迎'));
  const view = agentObservation(observed);
  assert.equal(view.nodes[0].nodeId, 'user-field');
  assert.equal(view.nodes.at(-1).nodeId, 'heading');
  assert.ok(!view.nodes.some((entry) => entry.nodeId === 'hidden'));
});
