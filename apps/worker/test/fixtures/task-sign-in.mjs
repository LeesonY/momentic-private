// Pure Node: real auth flow, private port and browser session over fake
// Playwright primitives and a scripted Runtime. No Chromium, DB or provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrowserManager, BrowserSessionImpl } from '@localqa/browser';

export const account = 'fixture-private-account@example.test';
export const password = 'fixture-private-password';
export const loginOrigin = 'https://login.example.test';
export const appOrigin = 'https://app.example.test';

export function signInFixture(config = {}) {
  mkdirSync('.localqa-t01', { recursive: true });
  const scratch = mkdtempSync(resolve('.localqa-t01/pi1-sign-in-'));
  const proof = {
    taskId: randomUUID(),
    fencingToken: 3,
    contextVersion: 1,
    leaseToken: 'fixture-private-lease',
  };
  const role = config.role ?? 'executor';
  const runId = randomUUID();
  const contextId = randomUUID();
  const profile = {
    id: randomUUID(),
    projectId: randomUUID(),
    version: 1,
    status: 'active',
    mode: 'agent',
    allowedOrigins: [loginOrigin],
    sharingPolicy: 'exclusive_run',
    hasSecret: true,
    formConfig: null,
    agentConfig: {
      loginUrl: `${loginOrigin}/login`,
      instructions: '填写账号和密码，然后登录。',
      variables: [
        { name: 'QA_USERNAME', sensitive: false },
        { name: 'QA_PASSWORD', sensitive: true },
      ],
    },
  };
  const allocated = {
    sessionId: randomUUID(),
    projectId: profile.projectId,
    runId,
    taskId: proof.taskId,
    workerId: 'fixture-worker',
    fencingToken: proof.fencingToken,
    contextVersion: proof.contextVersion,
    contextId,
    profileId: profile.id,
    profileVersion: profile.version,
    authEpoch: 1,
    purpose: 'initializer',
    status: 'allocated',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const active = { ...allocated, status: 'active', ...config.active };
  const history = [];
  const observations = [];
  const models = [];
  const finishes = [];
  const creates = [];
  const ends = [];
  const fields = new Map();
  let signedIn = false;
  let gate = false;
  let authRound = 0;
  const context = new EventEmitter();
  context.routes = new Map();
  context.route = async (pattern, handler) => {
    history.push('route:install');
    context.routes.set(handler, pattern);
  };
  context.unroute = async (pattern, handler) => {
    history.push('route:remove');
    assert.equal(context.routes.get(handler), pattern);
    if (config.cleanupError) throw new Error(password);
    context.routes.delete(handler);
  };
  context.close = async () => {
    history.push('browser:close');
    context.routes.clear();
  };
  context.storageState = async () =>
    assert.fail('self sign-in must not export state');
  context.addCookies = async () =>
    assert.fail('self sign-in must not import state');
  context.tracing = { start: async () => assert.fail('trace must stay off') };
  const page = new EventEmitter();
  let url = 'about:blank';
  let session;
  const rawNodes = () =>
    [
      {
        nodeId: 'testid_username',
        role: 'email',
        name: '账号',
        text: account,
        inputType: 'email',
      },
      {
        nodeId: 'testid_password',
        role: 'password',
        name: '密码',
        text: password,
        inputType: 'password',
      },
      { nodeId: 'testid_submit', role: 'button', name: '登录', text: '登录' },
      {
        nodeId: 'testid_content',
        role: 'main',
        name: '工作台',
        text: `Welcome ${account}`,
      },
    ].map((node) => ({
      ...node,
      frameId: 'main',
      visible: true,
      enabled: true,
      isSensitive: false,
      bounds: { left: 0, top: 0, width: 10, height: 10 },
    }));
  page.url = () => url;
  page.isClosed = () => session?.isClosed ?? false;
  page.title = async () => `Welcome ${account}`;
  page.viewportSize = () => ({ width: 800, height: 600 });
  page.frames = () => [page];
  page.mainFrame = () => page;
  page.evaluate = async () => ({ results: rawNodes(), truncated: false });
  page.evaluateHandle = async () => ({
    evaluate: async () => false,
    dispose: async () => {},
  });
  page.screenshot = async () => {
    assert.equal(signedIn, true, 'no screenshot during authentication');
    assert.equal(context.routes.size, 0);
    history.push('capture');
    return Buffer.from('fixture-screenshot-bytes');
  };
  page.goto = async (next) => {
    history.push('navigate');
    url = next;
    page.emit('console', {
      type: () => 'log',
      text: () => `Welcome ${account} ${password}`,
    });
    page.emit('request', {
      url: () => `${next}/${account}`,
      method: () => 'GET',
      resourceType: () => 'document',
    });
    return { status: () => 200 };
  };
  page.locator = (selector) => ({
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    elementHandle: async () => ({ dispose: async () => {} }),
    fill: async (value) => {
      fields.set(selector, value);
      history.push('fill');
    },
    click: async () => {
      history.push('submit');
      signedIn = true;
      // Deliberately browser-local: no storageState capture can reproduce it.
      context.sessionStorage = { signedIn: true };
      url = `${loginOrigin}/home`;
    },
  });
  page.getByRole = () => page.locator('role');
  page.getByLabel = () => page.locator('label');
  page.getByText = () => page.locator('text');
  page.getByPlaceholder = () => page.locator('placeholder');
  const browser = new BrowserManager();
  browser.createSession = async (options) => {
    creates.push(options);
    session = new BrowserSessionImpl(
      options.sessionId,
      options,
      context,
      page,
      randomUUID(),
    );
    return session;
  };
  const newSession = () =>
    browser.createSession({
      sessionId: contextId,
      projectId: profile.projectId,
      runId,
      taskId: proof.taskId,
      allowedOrigins: [appOrigin, loginOrigin],
      mode: 'non_submitting',
      enableTrace: false,
      artifactsDir: resolve(scratch, proof.taskId),
    });
  const noCapture = async () =>
    assert.fail('task sign-in must not use run state');
  const runtime = {
    async allocateAuthSession() {
      history.push('allocate');
      if (config.allocateError) throw config.allocateError;
      return allocated;
    },
    async issueAuthActivationTicket() {
      history.push('ticket');
      config.onTicket?.();
      return { activationTicket: 'fixture-private-ticket' };
    },
    async activateAuthSession() {
      history.push('activate');
      return active;
    },
    async authSession() {
      return active;
    },
    async authMaterial() {
      history.push('material');
      return {
        mode: 'agent',
        material: { QA_USERNAME: account, QA_PASSWORD: password },
        expiresAt: allocated.expiresAt,
      };
    },
    async grantAuth(_proof, request) {
      return {
        ...active,
        grantId: randomUUID(),
        deadline: active.expiresAt,
        action: request.action,
        slot: request.slot,
        ...(request.target ? { target: request.target } : {}),
        ...(request.action === 'navigate_auth'
          ? { url: profile.agentConfig.loginUrl }
          : {}),
      };
    },
    async beginAuthExecution(_proof, _id, grantId) {
      return { grantId, executionId: randomUUID() };
    },
    async recordAuth() {},
    async recordAuthObservation(_proof, _id, observed) {
      observations.push(observed);
      return observed;
    },
    async recordAuthCriterion() {
      history.push('criterion');
      gate = true;
      return { gateId: randomUUID() };
    },
    issueCaptureGrant: noCapture,
    beginAuthCapture: noCapture,
    captureAuthState: noCapture,
    finishAuth: noCapture,
    async endAuthSession(_proof, id, reason) {
      assert.equal(id, allocated.sessionId);
      history.push(`end:${reason}`);
      if (reason === 'signed_in') {
        assert.equal(
          gate,
          true,
          'success must follow the registered criterion',
        );
        assert.equal(signedIn, true, 'scripted login must have completed');
        if (config.endError) throw config.endError;
      }
      ends.push(reason);
      return { ...active, status: 'ended' };
    },
    async model(_proof, usedRole, request) {
      models.push({ role: usedRole, request });
      const system = request.messages[0].content[0].text;
      if (system.includes('role=auth_agent')) {
        history.push('model:auth');
        assert.equal(
          page.listenerCount('console'),
          1,
          'no live diagnostics during login',
        );
        assert.ok(!history.includes('capture'), 'no live frames during login');
        config.onAuthModel?.();
        if (config.modelError) throw config.modelError;
        const observation = JSON.parse(
          request.messages[1].content[0].text,
        ).observation;
        const node = (type) =>
          observation.nodes.find((item) => item.role === type).nodeId;
        const steps = [
          { action: 'fill', variable: 'QA_USERNAME', nodeId: node('email') },
          { action: 'fill', variable: 'QA_PASSWORD', nodeId: node('password') },
          { action: 'click', nodeId: node('button') },
          { action: 'done' },
        ];
        return {
          requestResult: 'ok',
          data: config.blockedReason
            ? { action: 'blocked', reason: config.blockedReason }
            : steps[Math.min(authRound++, steps.length - 1)],
        };
      }
      assert.equal(signedIn, true);
      assert.equal(
        context.routes.size,
        0,
        'private guard must end before execution',
      );
      history.push('model:work');
      return { requestResult: 'ok', data: { done: true, toolCalls: [] } };
    },
  };
  const definition = {
    id: randomUUID(),
    title: '工作台可见',
    summary: '查看工作台',
    preconditions: [],
    outline: ['打开工作台'],
    criteria: [
      {
        id: 'dashboard',
        kind: 'semantic',
        description: '工作台内容可见',
        sourceKind: 'user_spec',
        sourceRef: 'fixture',
      },
    ],
  };
  const work = {
    stage: role === 'reproducer' ? 'reproduce' : 'execute',
    task: { id: proof.taskId, role },
    contextId,
    targetUrl: `${appOrigin}/home`,
    signIn: true,
    definition,
    tlsPolicy: 'strict',
    run: {
      id: runId,
      projectId: profile.projectId,
      executionMode: 'smoke',
      effectiveConfig: {
        authProfileVersion: 1,
        allowedOrigins: [appOrigin],
        actionPolicy: 'non_submitting',
        writeScope: [],
        budget: { maxActionsPerCase: 1, maxPages: 2, maxDepth: 1 },
      },
    },
  };
  Object.assign(runtime, {
    async claim() {
      return { task: work.task, ...proof };
    },
    async work() {
      return work;
    },
    async authProfile() {
      return profile;
    },
    async requireAnonymousOrInput() {
      assert.fail('must not use the anonymous gate');
    },
    async grant() {
      return { step: { id: randomUUID() } };
    },
    async record(_proof, _grant, status, observed) {
      history.push(`record:${status}`);
      if (observed) observations.push(observed);
    },
    async upload(_proof, artifact, bytes) {
      assert.ok(bytes.length > 0);
      return artifact;
    },
    async finish(_proof, result, criteria, code) {
      history.push('finish');
      finishes.push({ result, criteria, code });
    },
    async stop(_proof, reason) {
      history.push(`stop:${reason}`);
    },
    async heartbeat() {
      return { contextVersion: proof.contextVersion, cancelRequested: false };
    },
  });
  return {
    proof,
    profile,
    browser,
    runtime,
    work,
    scratch,
    newSession,
    context,
    page,
    history,
    observations,
    models,
    finishes,
    creates,
    ends,
    fields,
    get session() {
      return session;
    },
    async cleanup() {
      await session?.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
