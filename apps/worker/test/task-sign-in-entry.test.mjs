// Entry regression uses the real Worker/auth flow/browser session with the
// existing synthetic Playwright/Runtime fixture; no real login or provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from '../dist/index.js';
import {
  signInFixture,
  appOrigin,
  loginOrigin,
} from './fixtures/task-sign-in.mjs';

function workerFor(fixture) {
  const worker = new Worker({
    runtime: fixture.runtime,
    browser: fixture.browser,
    scratch: fixture.scratch,
    heartbeatMs: 10000,
  });
  worker.agentReport = async () => ({
    status: 'passed',
    summary: '工作台可见',
    verified: ['工作台可见'],
    gaps: [],
    criteria: [
      { criterionId: 'dashboard', result: 'passed', reason: '内容可见' },
    ],
    bug: null,
  });
  return worker;
}

function firstWorkInput(fixture) {
  const call = fixture.models.find(
    ({ request }) =>
      !request.messages[0].content[0].text.includes('role=auth_agent'),
  );
  assert.ok(call, 'execution model must be called');
  return JSON.parse(call.request.messages[1].content[0].text);
}

function assertSignedInInstruction(input) {
  assert.match(input.authentication, /平台已经用测试账号为你登录.*已登录/);
  assert.match(input.authentication, /不要再尝试登录/);
  assert.match(input.authentication, /不要在登录表单里输入账号或密码/);
  assert.match(input.authentication, /会话过期.*登录状态失效/);
  assert.match(input.authentication, /blocked.*summary\/gaps/);
}

test('self-signed-in executor observes the current page instead of returning to the login entry', async () => {
  const fixture = signInFixture();
  fixture.work.targetUrl = `${loginOrigin}/login`;
  try {
    assert.equal(await workerFor(fixture).once(), true);
    assert.deepEqual(fixture.navigations, [`${loginOrigin}/login`]);
    assert.equal(fixture.grants[0].name, 'observe');
    assert.equal(
      fixture.grants.filter((call) => call.name === 'navigate').length,
      0,
    );
    const input = firstWorkInput(fixture);
    assert.equal(input.observation.url, `${loginOrigin}/home`);
    assertSignedInInstruction(input);
    assert.equal(fixture.finishes[0].result.agentReport.status, 'passed');
    assert.equal(fixture.session.isClosed, true);
  } finally {
    await fixture.cleanup();
  }
});

test('login entry comparison ignores query, hash and trailing slash for a reproducer too', async () => {
  const fixture = signInFixture({
    role: 'reproducer',
    loginUrl: `${loginOrigin}/login/?next=home#form`,
  });
  fixture.work.targetUrl = `${loginOrigin}/login?different=1#entry`;
  try {
    assert.equal(await workerFor(fixture).once(), true);
    assert.equal(fixture.navigations.length, 1);
    assert.equal(fixture.grants[0].name, 'observe');
    assertSignedInInstruction(firstWorkInput(fixture));
    assert.equal(fixture.finishes[0].result.stage, 'reproduce');
  } finally {
    await fixture.cleanup();
  }
});

test('origin root login entry behaves like SauceDemo rather than revisiting its form', async () => {
  const fixture = signInFixture({ loginUrl: `${loginOrigin}/` });
  fixture.work.targetUrl = `${loginOrigin}?from=case#top`;
  try {
    assert.equal(await workerFor(fixture).once(), true);
    assert.deepEqual(fixture.navigations, [`${loginOrigin}/`]);
    assert.equal(
      firstWorkInput(fixture).observation.url,
      `${loginOrigin}/home`,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('manual form login uses formConfig.loginUrl when deciding to stay on the signed-in page', async () => {
  const fixture = signInFixture({
    mode: 'form',
    loginUrl: `${loginOrigin}/login/`,
  });
  fixture.work.targetUrl = `${loginOrigin}/login#top`;
  try {
    assert.equal(await workerFor(fixture).once(), true);
    assert.deepEqual(fixture.ends, ['signed_in']);
    assert.equal(fixture.navigations.length, 1);
    assert.equal(fixture.grants[0].name, 'observe');
    assertSignedInInstruction(firstWorkInput(fixture));
  } finally {
    await fixture.cleanup();
  }
});
test('a different path or origin still navigates to the assigned entry after sign-in', async () => {
  for (const targetUrl of [`${loginOrigin}/orders`, `${appOrigin}/login`]) {
    const fixture = signInFixture();
    fixture.work.targetUrl = targetUrl;
    try {
      assert.equal(await workerFor(fixture).once(), true);
      assert.deepEqual(fixture.navigations, [
        `${loginOrigin}/login`,
        targetUrl,
      ]);
      assert.equal(fixture.grants[0].name, 'navigate');
      assert.equal(fixture.grants[0].args.url, targetUrl);
      const input = firstWorkInput(fixture);
      assert.equal(input.observation.url, targetUrl);
      assertSignedInInstruction(input);
    } finally {
      await fixture.cleanup();
    }
  }
});
test('missing loginUrl uses the first server-authorized login URL, never the final page', async () => {
  const loginStartUrl = `${loginOrigin}/start/?auth=private-opaque-token#form`;
  const fixture = signInFixture({ omitLoginUrl: true, loginStartUrl });
  fixture.work.targetUrl = `${loginOrigin}/start?from=case`;
  try {
    assert.equal(await workerFor(fixture).once(), true);
    assert.deepEqual(fixture.navigations, [loginStartUrl]);
    assert.equal(fixture.grants[0].name, 'observe');
    assert.equal(
      firstWorkInput(fixture).observation.url,
      `${loginOrigin}/home`,
    );
    assert.ok(!JSON.stringify(fixture.models).includes('private-opaque-token'));
    assert.ok(
      !JSON.stringify(fixture.finishes).includes('private-opaque-token'),
    );
  } finally {
    await fixture.cleanup();
  }
});

test('missing loginUrl does not skip a distinct per-case entry in the same origin', async () => {
  const loginStartUrl = `${loginOrigin}/start`;
  const fixture = signInFixture({ omitLoginUrl: true, loginStartUrl });
  fixture.work.targetUrl = `${loginOrigin}/reports`;
  try {
    assert.equal(await workerFor(fixture).once(), true);
    assert.deepEqual(fixture.navigations, [
      loginStartUrl,
      fixture.work.targetUrl,
    ]);
    assert.equal(fixture.grants[0].name, 'navigate');
    assertSignedInInstruction(firstWorkInput(fixture));
  } finally {
    await fixture.cleanup();
  }
});
test('without a successful task sign-in ordinary execution still navigates and has no signed-in notice', async () => {
  const fixture = signInFixture();
  fixture.work.signIn = false;
  fixture.work.withoutSignIn = true;
  fixture.work.targetUrl = `${appOrigin}/home`;
  fixture.page.screenshot = async () =>
    Buffer.from('anonymous-fixture-evidence');
  try {
    assert.equal(await workerFor(fixture).once(), true);
    assert.deepEqual(fixture.navigations, [fixture.work.targetUrl]);
    assert.equal(fixture.grants[0].name, 'navigate');
    const input = firstWorkInput(fixture);
    assert.ok(!('authentication' in input));
    assert.ok(!JSON.stringify(fixture.models).includes('平台已经用测试账号'));
    assert.deepEqual(fixture.ends, []);
  } finally {
    await fixture.cleanup();
  }
});

test('failed sign-in never dispatches execution or claims a signed-in page', async () => {
  const fixture = signInFixture({ blockedReason: '用户名或密码错误' });
  fixture.work.targetUrl = `${loginOrigin}/login`;
  try {
    assert.equal(await workerFor(fixture).once(), true);
    assert.deepEqual(fixture.grants, []);
    assert.ok(
      fixture.models.every(({ request }) =>
        request.messages[0].content[0].text.includes('role=auth_agent'),
      ),
    );
    assert.ok(!JSON.stringify(fixture.finishes).includes('平台已经用测试账号'));
    assert.equal(fixture.finishes[0].result.agentReport.status, 'blocked');
  } finally {
    await fixture.cleanup();
  }
});
