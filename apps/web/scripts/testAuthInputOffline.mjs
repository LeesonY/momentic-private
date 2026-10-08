// T10-AUTH-5 Offline Verification for InputRequestBar, RunStore & WorkbenchPage Input Response Wiring
// Zero browser execution, zero networking, Ego paused, 100% offline.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL(resolve('apps/web/package.json')));
const viteRequire = createRequire(require.resolve('vite'));
const { build, transformSync } = viteRequire('esbuild');

console.log('================================================================');
console.log(
  ' T10-AUTH-5 Input Boundary, SSR, RunStore & Callback Verification',
);
console.log('================================================================');

let passedTests = 0;
let totalTests = 0;

async function check(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ✗ [FAIL] ${name}: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Suite 1: Static SSR & Component Markup Verification
// ---------------------------------------------------------------------------
console.log('\n--- Suite 1: Static SSR & Component Markup Verification ---');

const ssrTempDir = await mkdtemp(resolve('apps/web/.offline-auth-input-ssr-'));
const ssrBundleFile = join(ssrTempDir, 'render-auth-input.mjs');

let ssrModule;
try {
  await build({
    stdin: {
      contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InputRequestBar } from './src/components/workbench/InputRequestBar.tsx';

// 1. SSR InputRequestBar with kind: 'auth_profile'
export const authProfileHtml = renderToStaticMarkup(
  React.createElement(InputRequestBar, {
    request: {
      id: 'req-auth-001',
      runId: 'run-auth-001',
      kind: 'auth_profile',
      status: 'pending',
      prompt: '请提供测试环境登录凭据',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    },
    onRespond: async () => {},
  })
);

// 2. SSR InputRequestBar with kind: 'one_time_code'
export const oneTimeCodeHtml = renderToStaticMarkup(
  React.createElement(InputRequestBar, {
    request: {
      id: 'req-otp-002',
      runId: 'run-auth-001',
      kind: 'one_time_code',
      status: 'pending',
      prompt: '请输入短信/邮件验证码',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    },
    onRespond: async () => {},
  })
);

// 3. SSR InputRequestBar with kind: 'clarification'
export const clarificationHtml = renderToStaticMarkup(
  React.createElement(InputRequestBar, {
    request: {
      id: 'req-clar-003',
      runId: 'run-auth-001',
      kind: 'clarification',
      status: 'pending',
      prompt: '请确认是否允许创建新测试用例文件？',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    },
    onRespond: async () => {},
  })
);
`,
      resolveDir: resolve('apps/web'),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: ssrBundleFile,
    external: ['react', 'react-dom/server', '@localqa/contracts'],
    define: { 'import.meta.env': '{}' },
  });

  ssrModule = await import(pathToFileURL(ssrBundleFile).href);
} finally {
  await rm(ssrTempDir, { recursive: true, force: true }).catch(() => {});
}

await check(
  'auth_profile SSR renders blocked state, only allows reject, and omits credentials input',
  () => {
    const html = ssrModule.authProfileHtml;
    assert.ok(
      html.includes('data-testid="input-request-bar"'),
      'Must render input-request-bar',
    );
    assert.ok(
      html.includes('auth-blocked-notice'),
      'Must render auth-blocked-notice element',
    );
    assert.ok(
      html.includes('认证受阻') || html.includes('Authentication Blocked'),
      'Must display blocked title',
    );
    assert.ok(html.includes('尚未接入'), 'Must indicate un-wired state');
    assert.ok(
      !html.includes('data-testid="input-request-input"'),
      'Must NOT render text input for credentials',
    );
    assert.ok(
      html.includes('仅支持拒绝操作 (Reject)'),
      'Must render reject-only option',
    );
    assert.ok(
      html.includes('拒绝此请求 (Reject)'),
      'Must render reject submit button',
    );
  },
);

await check(
  'one_time_code SSR renders blocked state, only allows reject, and omits OTP text input',
  () => {
    const html = ssrModule.oneTimeCodeHtml;
    assert.ok(
      html.includes('data-testid="input-request-bar"'),
      'Must render input-request-bar',
    );
    assert.ok(
      html.includes('auth-blocked-notice'),
      'Must render auth-blocked-notice element',
    );
    assert.ok(html.includes('one_time_code'), 'Must display kind');
    assert.ok(
      !html.includes('data-testid="input-request-input"'),
      'Must NOT render text input for OTP',
    );
    assert.ok(
      html.includes('仅支持拒绝操作 (Reject)'),
      'Must render reject-only option',
    );
    assert.ok(
      html.includes('拒绝此请求 (Reject)'),
      'Must render reject submit button',
    );
  },
);

await check(
  'clarification SSR preserves existing flow with text input and all decision options',
  () => {
    const html = ssrModule.clarificationHtml;
    assert.ok(
      html.includes('data-testid="input-request-bar"'),
      'Must render input-request-bar',
    );
    assert.ok(
      !html.includes('auth-blocked-notice'),
      'Must NOT render auth-blocked-notice for clarification',
    );
    assert.ok(
      html.includes('data-testid="input-request-input"'),
      'Must render text input for clarification',
    );
    assert.ok(html.includes('value="approve"'), 'Must render approve option');
    assert.ok(html.includes('value="provide"'), 'Must render provide option');
    assert.ok(html.includes('value="reject"'), 'Must render reject option');
    assert.ok(
      html.includes('提交答复并恢复执行'),
      'Must render normal submit button',
    );
  },
);

// ---------------------------------------------------------------------------
// Suite 2: Actual InputRequestBar Callback Logic & Invariant Tests
// ---------------------------------------------------------------------------
console.log(
  '\n--- Suite 2: Actual InputRequestBar Callback Logic & Mutable Ref Invariants ---',
);

const barSource = readFileSync(
  new URL('../src/components/workbench/InputRequestBar.tsx', import.meta.url),
  'utf8',
);
const barStart = barSource.indexOf('  const handleSubmit = ');
const barEnd = barSource.indexOf('\n  return (', barStart);
assert.ok(
  barStart >= 0 && barEnd > barStart,
  'Find handleSubmit in InputRequestBar.tsx',
);
const barSnippet = barSource.slice(barStart, barEnd);

function barHarness(
  initialRequest,
  initialDecision = undefined,
  initialText = '',
) {
  let req = { ...initialRequest };
  const inFlightRef = { current: false };
  const requestEpochRef = { current: 1 };
  const currentIdentityRef = {
    current: {
      requestId: req.id,
      runId: req.runId,
      kind: req.kind,
      version: req.version,
      epoch: requestEpochRef.current,
    },
  };

  const state = {
    decision:
      initialDecision ??
      (req.kind === 'auth_profile' || req.kind === 'one_time_code'
        ? 'reject'
        : 'approve'),
    responseText: initialText,
    submitting: false,
    error: null,
    calls: [],
  };

  const context = {
    get request() {
      return req;
    },
    get decision() {
      return state.decision;
    },
    get responseText() {
      return state.responseText;
    },
    get submitting() {
      return state.submitting;
    },
    get error() {
      return state.error;
    },
    inFlightRef,
    requestEpochRef,
    currentIdentityRef,
    setDecision: (val) => {
      state.decision = val;
    },
    setResponseText: (val) => {
      state.responseText = val;
    },
    setSubmitting: (val) => {
      state.submitting = val;
    },
    setError: (val) => {
      state.error = val;
    },
    onRespond: async (decision, text) => {
      state.calls.push({ decision, text });
    },
  };

  const compiled = transformSync(
    `function getCallback(context) {
       let { inFlightRef, requestEpochRef, currentIdentityRef, setDecision, setResponseText, setSubmitting, setError } = context;
       let request = context.request;
       let decision = context.decision;
       let responseText = context.responseText;
       let submitting = context.submitting;
       let error = context.error;
       let onRespond = context.onRespond;
       ${barSnippet};
       return {
         handleSubmit: () => {
           request = context.request;
           decision = context.decision;
           responseText = context.responseText;
           submitting = context.submitting;
           error = context.error;
           onRespond = context.onRespond;
           return handleSubmit();
         },
       };
     }`,
    { loader: 'ts', target: 'esnext' },
  ).code;

  const fn = new Function(
    'context',
    compiled + '\nreturn getCallback(context);',
  );
  const instance = fn(context);

  const simulateRequestSwitch = (newRequest) => {
    req = { ...newRequest };
    requestEpochRef.current += 1;
    currentIdentityRef.current = {
      requestId: req.id,
      runId: req.runId,
      kind: req.kind,
      version: req.version,
      epoch: requestEpochRef.current,
    };
    inFlightRef.current = false;
    state.decision =
      req.kind === 'auth_profile' || req.kind === 'one_time_code'
        ? 'reject'
        : 'approve';
    state.responseText = '';
    state.submitting = false;
    state.error = null;
  };

  return {
    state,
    context,
    inFlightRef,
    requestEpochRef,
    currentIdentityRef,
    instance,
    simulateRequestSwitch,
  };
}

await check(
  'auth_profile callback strictly submits reject with no plaintext credentials',
  async () => {
    const req = {
      id: 'req-auth-101',
      runId: 'run-auth-101',
      kind: 'auth_profile',
      status: 'pending',
      prompt: 'Login required',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    };
    const h = barHarness(req, 'reject', 'secret-password-123');

    await h.instance.handleSubmit();

    assert.equal(h.state.calls.length, 1);
    assert.equal(h.state.calls[0].decision, 'reject', 'Must submit reject');
    assert.equal(
      h.state.calls[0].text,
      undefined,
      'Must NEVER submit text for auth kind',
    );
    assert.equal(h.state.submitting, false, 'Must reset submitting state');
    assert.equal(h.inFlightRef.current, false, 'inFlightRef must reset');
    assert.equal(h.state.error, null);
  },
);

await check(
  'one_time_code callback strictly submits reject with no plaintext OTP',
  async () => {
    const req = {
      id: 'req-otp-102',
      runId: 'run-auth-101',
      kind: 'one_time_code',
      status: 'pending',
      prompt: 'Enter OTP',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    };
    const h = barHarness(req, 'reject', '123456');

    await h.instance.handleSubmit();

    assert.equal(h.state.calls.length, 1);
    assert.equal(h.state.calls[0].decision, 'reject', 'Must submit reject');
    assert.equal(
      h.state.calls[0].text,
      undefined,
      'Must NEVER submit text for OTP',
    );
    assert.equal(h.state.submitting, false);
  },
);

await check(
  'auth kind rejects any illegal decision override before dispatch',
  async () => {
    const req = {
      id: 'req-auth-103',
      runId: 'run-auth-101',
      kind: 'auth_profile',
      status: 'pending',
      prompt: 'Login required',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    };
    // Simulate illegal decision override
    const h = barHarness(req, 'approve');
    await h.instance.handleSubmit();
    assert.equal(h.state.calls.length, 1);
    assert.equal(
      h.state.calls[0].decision,
      'reject',
      'Auth kind must be forced to reject',
    );
  },
);

await check(
  'clarification callback properly submits approve, provide, or reject with text',
  async () => {
    const req = {
      id: 'req-clar-104',
      runId: 'run-auth-101',
      kind: 'clarification',
      status: 'pending',
      prompt: 'Please confirm',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    };

    // 1. Approve without text
    const h1 = barHarness(req, 'approve');
    await h1.instance.handleSubmit();
    assert.equal(h1.state.calls.length, 1);
    assert.equal(h1.state.calls[0].decision, 'approve');
    assert.equal(h1.state.calls[0].text, undefined);

    // 2. Provide with text
    const h2 = barHarness(req, 'provide', 'Yes, create the directory');
    await h2.instance.handleSubmit();
    assert.equal(h2.state.calls.length, 1);
    assert.equal(h2.state.calls[0].decision, 'provide');
    assert.equal(h2.state.calls[0].text, 'Yes, create the directory');

    // 3. Reject (must not send text key)
    const h3 = barHarness(req, 'reject', 'rejected text');
    await h3.instance.handleSubmit();
    assert.equal(h3.state.calls.length, 1);
    assert.equal(h3.state.calls[0].decision, 'reject');
    assert.equal(h3.state.calls[0].text, undefined, 'Reject must omit text');
  },
);

await check(
  'duplicate submit prevention blocks same-tick concurrent onRespond calls via inFlightRef',
  async () => {
    const req = {
      id: 'req-clar-105',
      runId: 'run-auth-101',
      kind: 'clarification',
      status: 'pending',
      prompt: 'Confirm',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    };
    const h = barHarness(req, 'approve');
    let finish;
    h.context.onRespond = async (decision, text) => {
      h.state.calls.push({ decision, text });
      return new Promise((resolve) => {
        finish = resolve;
      });
    };

    const firstPromise = h.instance.handleSubmit();
    assert.equal(
      h.inFlightRef.current,
      true,
      'inFlightRef must be true synchronously',
    );

    // Call again in same tick while in-flight
    const secondPromise = h.instance.handleSubmit();

    finish();
    await Promise.all([firstPromise, secondPromise]);

    assert.equal(
      h.state.calls.length,
      1,
      'Concurrent submission must be blocked by inFlightRef',
    );
    assert.equal(h.inFlightRef.current, false, 'inFlightRef must reset');
  },
);

await check(
  'late response guard does not mutate state when request changed during deferred promise',
  async () => {
    const reqA = {
      id: 'req-A-106',
      runId: 'run-auth-101',
      kind: 'clarification',
      status: 'pending',
      prompt: 'Prompt A',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    };
    const h = barHarness(reqA, 'approve');
    let finishA;
    h.context.onRespond = async (decision, text) => {
      h.state.calls.push({ decision, text });
      return new Promise((resolve) => {
        finishA = resolve;
      });
    };

    const promiseA = h.instance.handleSubmit();
    assert.equal(h.inFlightRef.current, true);

    // Request switches to reqB while reqA is in-flight
    h.simulateRequestSwitch({
      id: 'req-B-107',
      runId: 'run-auth-101',
      kind: 'auth_profile',
      status: 'pending',
      prompt: 'Prompt B',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    });

    // Verify request B is clean
    assert.equal(h.state.decision, 'reject', 'Req B must default to reject');
    assert.equal(h.state.responseText, '');
    assert.equal(h.inFlightRef.current, false);

    // Set req B to active submission
    h.state.submitting = true;

    // Resolve old request A
    finishA();
    await promiseA;

    // Old request A completion must NOT clear submitting on req B
    assert.equal(
      h.state.submitting,
      true,
      'Old request A must not clear req B submitting',
    );
    assert.equal(h.state.decision, 'reject', 'Decision must remain req B');
  },
);

await check(
  'late response error guard does not set error on a superseded request during deferred promise',
  async () => {
    const reqA = {
      id: 'req-A-108',
      runId: 'run-auth-101',
      kind: 'clarification',
      status: 'pending',
      prompt: 'Prompt A',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    };
    const h = barHarness(reqA, 'approve');
    let failA;
    h.context.onRespond = async () =>
      new Promise((_, reject) => {
        failA = reject;
      });

    const promiseA = h.instance.handleSubmit();

    // Switch to req B
    h.simulateRequestSwitch({
      id: 'req-B-109',
      runId: 'run-auth-101',
      kind: 'auth_profile',
      status: 'pending',
      prompt: 'Prompt B',
      expiresAt: '2026-10-07T12:00:00.000Z',
      version: 1,
    });

    // Reject old request A
    failA(new Error('Network error on old request A'));
    await promiseA;

    assert.equal(
      h.state.error,
      null,
      'Error from old request A must NOT be assigned to req B',
    );
  },
);

// ---------------------------------------------------------------------------
// Suite 3: Actual RunStore respondInput Logic & Ref Tracking Tests
// ---------------------------------------------------------------------------
console.log(
  '\n--- Suite 3: Actual RunStore respondInput Logic & Ref Tracking Tests ---',
);

const storeSource = readFileSync(
  new URL('../src/state/RunStore.tsx', import.meta.url),
  'utf8',
);
const storeStart = storeSource.indexOf('  const respondInput = ');
const storeEnd = storeSource.indexOf('\n  const retrySse = ', storeStart);
assert.ok(
  storeStart >= 0 && storeEnd > storeStart,
  'Find respondInput in RunStore.tsx',
);
const storeSnippet = storeSource.slice(storeStart, storeEnd);

function storeHarness(initialRunId, initialRequest) {
  const runIdRef = { current: initialRunId };
  const activeInputRequestRef = {
    current: initialRequest ? { ...initialRequest } : null,
  };
  const respondingInputRef = { current: false };

  const state = {
    activeInputRequest: initialRequest ? { ...initialRequest } : null,
    apiCalls: [],
  };

  const defaultApiClient = {
    respondToInput: async (runId, inputId, payload) => {
      state.apiCalls.push({ runId, inputId, payload });
      return {
        id: inputId,
        runId,
        status: payload.decision === 'reject' ? 'rejected' : 'resolved',
        version: payload.expectedVersion + 1,
      };
    },
  };

  const context = {
    runIdRef,
    activeInputRequestRef,
    respondingInputRef,
    defaultApiClient,
    setActiveInputRequest: (val) => {
      state.activeInputRequest = val;
      activeInputRequestRef.current = val;
    },
  };

  const compiled = transformSync(
    `function getCallback(context) {
       let { runIdRef, activeInputRequestRef, respondingInputRef, defaultApiClient, setActiveInputRequest } = context;
       ${storeSnippet};
       return { respondInput };
     }`,
    { loader: 'ts', target: 'esnext' },
  ).code;

  const fn = new Function(
    'context',
    compiled + '\nreturn getCallback(context);',
  );
  const instance = fn(context);

  return {
    state,
    context,
    runIdRef,
    activeInputRequestRef,
    respondingInputRef,
    defaultApiClient,
    instance,
  };
}

await check(
  'RunStore respondInput normal resolution clears activeInputRequest without fabricating running state',
  async () => {
    const req = { id: 'req-store-001', kind: 'clarification', version: 1 };
    const h = storeHarness('run-001', req);

    await h.instance.respondInput('approve', 'approved');

    assert.equal(h.state.apiCalls.length, 1);
    assert.equal(h.state.apiCalls[0].runId, 'run-001');
    assert.equal(h.state.apiCalls[0].inputId, 'req-store-001');
    assert.equal(h.state.apiCalls[0].payload.decision, 'approve');
    assert.equal(h.state.apiCalls[0].payload.text, 'approved');
    assert.equal(
      h.state.activeInputRequest,
      null,
      'activeInputRequest must be cleared on match',
    );
    assert.equal(
      h.respondingInputRef.current,
      false,
      'respondingInputRef must reset',
    );
  },
);

await check(
  'RunStore respondInput reject strictly omits text key in payload',
  async () => {
    const req = { id: 'req-store-002', kind: 'auth_profile', version: 2 };
    const h = storeHarness('run-002', req);

    await h.instance.respondInput('reject', 'should-not-be-sent');

    assert.equal(h.state.apiCalls.length, 1);
    assert.equal(h.state.apiCalls[0].payload.decision, 'reject');
    assert.equal(
      'text' in h.state.apiCalls[0].payload,
      false,
      'Payload must NOT have text key on reject',
    );
    assert.equal(h.state.activeInputRequest, null);
  },
);

await check(
  'RunStore respondInput blocks same-tick concurrent calls via respondingInputRef',
  async () => {
    const req = { id: 'req-store-003', kind: 'clarification', version: 1 };
    const h = storeHarness('run-003', req);

    let finish;
    h.defaultApiClient.respondToInput = async (runId, inputId, payload) => {
      h.state.apiCalls.push({ runId, inputId, payload });
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            id: inputId,
            runId,
            version: payload.expectedVersion + 1,
            status: 'resolved',
          });
      });
    };

    const p1 = h.instance.respondInput('approve');
    assert.ok(
      h.respondingInputRef.current,
      'respondingInputRef must be set synchronously',
    );

    // Second call in same tick
    const p2 = h.instance.respondInput('provide', 'call2');

    finish();
    await Promise.all([p1, p2]);

    assert.equal(
      h.state.apiCalls.length,
      1,
      'Only one API call must be executed',
    );
    assert.equal(h.respondingInputRef.current, false);
  },
);

await check(
  'RunStore respondInput rejects un-incremented response version and retains active request',
  async () => {
    const req = { id: 'req-store-004', kind: 'clarification', version: 1 };
    const h = storeHarness('run-004', req);

    // Return same version (not incremented)
    h.defaultApiClient.respondToInput = async (runId, inputId) => ({
      id: inputId,
      runId,
      version: 1, // should be 2
      status: 'resolved',
    });

    await assert.rejects(
      () => h.instance.respondInput('approve'),
      /INVALID_INPUT_RESPONSE_VERSION/,
    );
    assert.equal(
      h.state.activeInputRequest?.id,
      'req-store-004',
      'Active request must remain intact on version mismatch',
    );
  },
);

await check(
  'RunStore respondInput allows new run submission while old run response remains pending',
  async () => {
    const reqA = { id: 'req-store-A', kind: 'clarification', version: 1 };
    const h = storeHarness('run-A', reqA);

    let finishA;
    h.defaultApiClient.respondToInput = async (runId, inputId, payload) => {
      h.state.apiCalls.push({ runId, inputId, payload });
      if (runId === 'run-A') {
        return new Promise((resolve) => {
          finishA = () =>
            resolve({
              id: inputId,
              runId,
              version: payload.expectedVersion + 1,
              status: payload.decision === 'reject' ? 'rejected' : 'resolved',
            });
        });
      }
      return {
        id: inputId,
        runId,
        version: payload.expectedVersion + 1,
        status: payload.decision === 'reject' ? 'rejected' : 'resolved',
      };
    };

    const pA = h.instance.respondInput('approve');
    assert.ok(h.respondingInputRef.current, 'Run A lock acquired');

    // Switch to run B
    h.runIdRef.current = 'run-B';
    const reqB = { id: 'req-store-B', kind: 'one_time_code', version: 1 };
    h.activeInputRequestRef.current = reqB;
    h.state.activeInputRequest = reqB;

    // Run B submission must NOT be blocked by Run A's in-flight request
    await h.instance.respondInput('reject');
    assert.equal(h.state.apiCalls.length, 2, 'Run B submission must proceed');

    finishA();
    await pA;
  },
);

await check(
  'RunStore respondInput late response does not clear new request when request changed during deferred promise',
  async () => {
    const reqA = { id: 'req-store-A', kind: 'clarification', version: 1 };
    const h = storeHarness('run-005', reqA);

    let finishA;
    h.defaultApiClient.respondToInput = async (runId, inputId, payload) => {
      h.state.apiCalls.push({ runId, inputId, payload });
      return new Promise((resolve) => {
        finishA = () =>
          resolve({
            id: inputId,
            runId,
            version: payload.expectedVersion + 1,
            status: 'resolved',
          });
      });
    };

    const promiseA = h.instance.respondInput('approve');

    // While pending, SSE delivers new request B
    const reqB = { id: 'req-store-B', kind: 'auth_profile', version: 1 };
    h.activeInputRequestRef.current = reqB;
    h.state.activeInputRequest = reqB;

    // Resolve old request A
    finishA();
    await promiseA;

    // activeInputRequest must NOT be cleared because it now holds reqB!
    assert.equal(
      h.state.activeInputRequest?.id,
      'req-store-B',
      'New request B must not be cleared by old request A response',
    );
  },
);

await check(
  'RunStore respondInput late response does not clear request when run changed during deferred promise',
  async () => {
    const reqA = { id: 'req-store-A', kind: 'clarification', version: 1 };
    const h = storeHarness('run-A', reqA);

    let finishA;
    h.defaultApiClient.respondToInput = async (runId, inputId, payload) => {
      h.state.apiCalls.push({ runId, inputId, payload });
      return new Promise((resolve) => {
        finishA = () =>
          resolve({
            id: inputId,
            runId,
            version: payload.expectedVersion + 1,
            status: 'resolved',
          });
      });
    };

    const promiseA = h.instance.respondInput('approve');

    // User switched run to run-B
    h.runIdRef.current = 'run-B';
    const reqB = {
      id: 'req-store-in-run-B',
      kind: 'one_time_code',
      version: 1,
    };
    h.activeInputRequestRef.current = reqB;
    h.state.activeInputRequest = reqB;

    // Resolve old run-A call
    finishA();
    await promiseA;

    assert.equal(
      h.state.activeInputRequest?.id,
      'req-store-in-run-B',
      'Run B request must not be cleared by run A response',
    );
  },
);

// ---------------------------------------------------------------------------
// Suite 4: Actual WorkbenchPage handleRespondInput Boundary Wiring Tests
// ---------------------------------------------------------------------------
console.log(
  '\n--- Suite 4: Actual WorkbenchPage handleRespondInput Boundary Wiring Tests ---',
);

const wbSource = readFileSync(
  new URL('../src/pages/WorkbenchPage.tsx', import.meta.url),
  'utf8',
);
const wbStart = wbSource.indexOf('  const handleRespondInput = ');
const wbEnd = wbSource.indexOf('\n  const handleSendMessage = ', wbStart);
assert.ok(
  wbStart >= 0 && wbEnd > wbStart,
  'Find handleRespondInput in WorkbenchPage.tsx',
);
const wbSnippet = wbSource.slice(wbStart, wbEnd);

function wbHarness(initialRun, initialRequest) {
  let r = initialRun ? { ...initialRun } : null;
  let req = initialRequest ? { ...initialRequest } : null;

  const inputRespondingRef = { current: false };
  const scopeEpochRef = { current: 1 };
  const activeInputScopeRef = {
    current:
      req && r
        ? { runId: r.id, requestId: req.id, epoch: scopeEpochRef.current }
        : null,
  };

  const state = {
    inputResponding: false,
    calls: [],
  };

  const context = {
    get run() {
      return r;
    },
    get activeInputRequest() {
      return req;
    },
    get inputResponding() {
      return state.inputResponding;
    },
    inputRespondingRef,
    activeInputScopeRef,
    scopeEpochRef,
    setInputResponding: (val) => {
      state.inputResponding = val;
    },
    respondInput: async (decision, text) => {
      state.calls.push({ decision, text });
    },
    useCallback: (fn) => fn,
  };

  const compiled = transformSync(
    `function getCallback(context) {
       let { inputRespondingRef, activeInputScopeRef, scopeEpochRef, setInputResponding, respondInput, useCallback } = context;
       let run = context.run;
       let activeInputRequest = context.activeInputRequest;
       let inputResponding = context.inputResponding;
       ${wbSnippet};
       return {
         handleRespondInput: (decision, text) => {
           run = context.run;
           activeInputRequest = context.activeInputRequest;
           inputResponding = context.inputResponding;
           respondInput = context.respondInput;
           return handleRespondInput(decision, text);
         },
       };
     }`,
    { loader: 'ts', target: 'esnext' },
  ).code;

  const fn = new Function(
    'context',
    compiled + '\nreturn getCallback(context);',
  );
  const instance = fn(context);

  const simulateScopeSwitch = (newRun, newRequest) => {
    r = newRun ? { ...newRun } : null;
    req = newRequest ? { ...newRequest } : null;
    scopeEpochRef.current += 1;
    if (req && r) {
      activeInputScopeRef.current = {
        runId: r.id,
        requestId: req.id,
        epoch: scopeEpochRef.current,
      };
    } else {
      activeInputScopeRef.current = null;
    }
    inputRespondingRef.current = false;
    state.inputResponding = false;
  };

  return {
    state,
    context,
    inputRespondingRef,
    activeInputScopeRef,
    scopeEpochRef,
    instance,
    simulateScopeSwitch,
  };
}

await check(
  'WorkbenchPage handleRespondInput allows reject and strips credentials for auth_profile',
  async () => {
    const run = { id: 'run-wb-001' };
    const req = { id: 'req-wb-001', kind: 'auth_profile', version: 1 };
    const h = wbHarness(run, req);

    await h.instance.handleRespondInput('reject', 'should-be-stripped');

    assert.equal(h.state.calls.length, 1);
    assert.equal(h.state.calls[0].decision, 'reject');
    assert.equal(
      h.state.calls[0].text,
      undefined,
      'Credentials text must be stripped at page boundary',
    );
    assert.equal(h.state.inputResponding, false);
  },
);

await check(
  'WorkbenchPage handleRespondInput throws if approve is attempted on auth_profile',
  async () => {
    const run = { id: 'run-wb-002' };
    const req = { id: 'req-wb-002', kind: 'auth_profile', version: 1 };
    const h = wbHarness(run, req);

    await assert.rejects(
      () => h.instance.handleRespondInput('approve', undefined),
      /仅允许拒绝操作/,
      'Must reject approve on auth_profile',
    );
    assert.equal(h.state.calls.length, 0, 'No API call made');
  },
);

await check(
  'WorkbenchPage handleRespondInput prevents same-tick concurrent submissions',
  async () => {
    const run = { id: 'run-wb-003' };
    const req = { id: 'req-wb-003', kind: 'clarification', version: 1 };
    const h = wbHarness(run, req);

    let finish;
    h.context.respondInput = async (decision, text) => {
      h.state.calls.push({ decision, text });
      return new Promise((resolve) => {
        finish = resolve;
      });
    };

    const p1 = h.instance.handleRespondInput('approve');
    assert.equal(h.inputRespondingRef.current, true);

    // Second call in same tick
    const p2 = h.instance.handleRespondInput('provide', 'concurrent call');

    finish();
    await Promise.all([p1, p2]);

    assert.equal(h.state.calls.length, 1, 'Only one call should proceed');
    assert.equal(h.inputRespondingRef.current, false);
  },
);

await check(
  'WorkbenchPage handleRespondInput ignores late response when run/request switches during deferred promise',
  async () => {
    const runA = { id: 'run-A' };
    const reqA = { id: 'req-A', kind: 'clarification', version: 1 };
    const h = wbHarness(runA, reqA);

    let finishA;
    h.context.respondInput = async (decision, text) => {
      h.state.calls.push({ decision, text });
      return new Promise((resolve) => {
        finishA = resolve;
      });
    };

    const promiseA = h.instance.handleRespondInput('approve');
    assert.equal(h.inputRespondingRef.current, true);

    // Switch to runB / reqB
    h.simulateScopeSwitch(
      { id: 'run-B' },
      { id: 'req-B', kind: 'auth_profile', version: 1 },
    );

    // Simulate new busy state on new scope
    h.state.inputResponding = true;

    finishA();
    await promiseA;

    // Old response must NOT clear inputResponding on the new scope
    assert.equal(
      h.state.inputResponding,
      true,
      'New scope inputResponding must not be cleared by old response',
    );
    assert.equal(h.state.calls.length, 1);
  },
);

console.log(
  '\n================================================================',
);
console.log(` Summary: ${passedTests}/${totalTests} T10-AUTH-5 checks PASSED`);
console.log('================================================================');
console.log(
  JSON.stringify(
    {
      totalTests,
      passedTests,
      authBlockedNoticeRendered: true,
      credentialsTextOmitted: true,
      rejectOnlyEnforced: true,
      clarificationPreserved: true,
      sameTickConcurrencyGuarded: true,
      runStoreIdentityGuarded: true,
      lateResponseGuarded: true,
      noArbitraryRunningStatus: true,
      browserExecuted: false,
      egoPaused: true,
      P0Passed: false,
    },
    null,
    2,
  ),
);
