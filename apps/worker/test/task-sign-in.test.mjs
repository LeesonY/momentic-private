import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Worker } from '../dist/index.js';
import { initializeBrowserAuthentication } from '../dist/auth-initialize-task.js';
import { DomainError } from '@localqa/domain';
import {
  signInFixture,
  account,
  password,
  appOrigin,
  loginOrigin,
} from './fixtures/task-sign-in.mjs';

function initialize(fixture, session, signal = new AbortController().signal) {
  return initializeBrowserAuthentication(
    {
      runtime: fixture.runtime,
      browser: fixture.browser,
      proof: fixture.proof,
      profile: fixture.profile,
      projectId: fixture.profile.projectId,
      runId: fixture.work.run.id,
      session,
      role: fixture.work.task.role,
    },
    signal,
  );
}

function assertPrivate(value) {
  const text = JSON.stringify(value);
  for (const secret of [account, password, encodeURIComponent(account)])
    assert.ok(
      !text.includes(secret),
      'private auth material reached ordinary output',
    );
}

test('in-place sign-in ends private authority but retains the same browser-local session', async () => {
  const fixture = signInFixture();
  try {
    const session = await fixture.newSession();
    const outcome = await initialize(fixture, session);
    assert.equal(outcome.status, 'succeeded', outcome.reasonCode);
    assert.equal(outcome.stateRef, null);
    assert.equal(fixture.creates.length, 1);
    assert.equal(session.isClosed, false);
    assert.deepEqual(fixture.ends, ['signed_in']);
    assert.equal(fixture.context.routes.size, 0);
    assert.equal(fixture.context.sessionStorage.signedIn, true);
    assertPrivate(outcome);
    assertPrivate(fixture.models);
    assertPrivate(fixture.observations);
    const result = await session.executeTool({
      name: 'navigate',
      args: { url: `${appOrigin}/home` },
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(fixture.context.sessionStorage.signedIn, true);
    assertPrivate(result);
    assertPrivate(await session.getSnapshot());
    assertPrivate(session.recorder.getSnapshotSummaries());
  } finally {
    await fixture.cleanup();
  }
});

test('reproducer signs in with its own model role and no captured state', async () => {
  const fixture = signInFixture({ role: 'reproducer' });
  try {
    const outcome = await initialize(fixture, await fixture.newSession());
    assert.equal(outcome.status, 'succeeded');
    assert.ok(fixture.models.length > 0);
    assert.ok(fixture.models.every((call) => call.role === 'reproducer'));
    assert.deepEqual(fixture.ends, ['signed_in']);
  } finally {
    await fixture.cleanup();
  }
});
test('blocked login scrubs even forged credential echoes and ends the auth session', async () => {
  const fixture = signInFixture({
    blockedReason: `账号被拒绝 ${account} ${password}`,
  });
  try {
    const session = await fixture.newSession();
    const outcome = await initialize(fixture, session);
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.reasonCode, 'AGENT_LOGIN_BLOCKED');
    assert.match(outcome.detail, /账号被拒绝/);
    assertPrivate(outcome);
    assert.deepEqual(fixture.ends, ['failed']);
    assert.equal(fixture.context.routes.size, 0);
    assert.equal(session.isClosed, false);
    assert.ok(!fixture.history.includes('criterion'));
  } finally {
    await fixture.cleanup();
  }
});

test('allocation rate limit explains exclusive account contention without private authority', async () => {
  const fixture = signInFixture({
    allocateError: new DomainError('RATE_LIMITED'),
  });
  try {
    const outcome = await initialize(fixture, await fixture.newSession());
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.reasonCode, 'RATE_LIMITED');
    assert.match(outcome.detail, /账号.*占用/);
    assert.deepEqual(fixture.history, ['allocate']);
    assert.deepEqual(fixture.ends, []);
  } finally {
    await fixture.cleanup();
  }
});
test('cancel after ticket issuance never activates and ends the allocated session as cancelled', async () => {
  const controller = new AbortController();
  const fixture = signInFixture({ onTicket: () => controller.abort() });
  try {
    const session = await fixture.newSession();
    const outcome = await initialize(fixture, session, controller.signal);
    assert.equal(outcome.status, 'cancelled');
    assert.deepEqual(fixture.history, ['allocate', 'ticket', 'end:cancelled']);
    assert.equal(session.isClosed, false);
  } finally {
    await fixture.cleanup();
  }
});

test('cancel during login closes private routes and never sends signed_in', async () => {
  const controller = new AbortController();
  const fixture = signInFixture({ onAuthModel: () => controller.abort() });
  try {
    const outcome = await initialize(
      fixture,
      await fixture.newSession(),
      controller.signal,
    );
    assert.equal(outcome.status, 'cancelled');
    assert.deepEqual(fixture.ends, ['cancelled']);
    assert.equal(fixture.context.routes.size, 0);
    assert.ok(!fixture.history.includes('criterion'));
  } finally {
    await fixture.cleanup();
  }
});

test('model, success-ending and private-route cleanup exceptions all fail closed', async () => {
  for (const config of [
    { modelError: new Error(password) },
    { endError: new DomainError('AUTH_FAILED') },
    { cleanupError: true },
  ]) {
    const fixture = signInFixture(config);
    try {
      const outcome = await initialize(fixture, await fixture.newSession());
      assert.equal(outcome.status, 'blocked');
      assertPrivate(outcome);
      assert.equal(fixture.session.isClosed, false);
      if (!config.cleanupError) assert.deepEqual(fixture.ends, ['failed']);
      else assert.deepEqual(fixture.ends, ['signed_in']);
    } finally {
      await fixture.cleanup();
    }
  }
});
test('worker signs in once, then executes in that exact context without a live frame or trace', async () => {
  const fixture = signInFixture();
  const worker = new Worker({
    runtime: fixture.runtime,
    browser: fixture.browser,
    scratch: fixture.scratch,
    heartbeatMs: 10000,
  });
  let worked;
  worker.agentReport = async (_proof, _role, _work, snapshot) => {
    worked = worker.browser === fixture.browser && fixture.session;
    assert.equal(fixture.context.routes.size, 0);
    assert.equal(fixture.context.sessionStorage.signedIn, true);
    assertPrivate(snapshot);
    return {
      status: 'passed',
      summary: '工作台可见',
      verified: ['工作台可见'],
      gaps: [],
      criteria: [
        { criterionId: 'dashboard', result: 'passed', reason: '内容可见' },
      ],
      bug: null,
    };
  };
  try {
    assert.equal(await worker.once(), true);
    assert.equal(worked, fixture.session);
    assert.equal(fixture.creates.length, 1);
    assert.deepEqual(fixture.creates[0].allowedOrigins, [
      appOrigin,
      loginOrigin,
    ]);
    assert.equal(fixture.creates[0].enableTrace, false);
    assert.ok(
      fixture.history.indexOf('end:signed_in') <
        fixture.history.indexOf('model:work'),
    );
    assert.equal(fixture.finishes.length, 1);
    assert.equal(fixture.finishes[0].result.agentReport.status, 'passed');
    assert.equal(fixture.session.isClosed, true);
    assertPrivate(fixture.observations);
    assert.ok(!fixture.history.some((entry) => entry.startsWith('stop:')));
  } finally {
    await fixture.cleanup();
  }
});
test('worker login failure blocks only its case and normally finishes the task', async () => {
  for (const config of [
    { blockedReason: '页面提示账号已停用' },
    { allocateError: new DomainError('RATE_LIMITED') },
    { modelError: new Error(password) },
    { cleanupError: true },
    { role: 'reproducer', blockedReason: '页面提示账号已停用' },
  ]) {
    const fixture = signInFixture(config);
    try {
      const worker = new Worker({
        runtime: fixture.runtime,
        browser: fixture.browser,
        scratch: fixture.scratch,
        heartbeatMs: 10000,
      });
      assert.equal(await worker.once(), true);
      assert.equal(fixture.finishes.length, 1);
      const { result, criteria, code } = fixture.finishes[0];
      assert.equal(result.stage, fixture.work.stage);
      assert.equal(result.agentReport.status, 'blocked');
      assert.equal(result.agentReport.bug, null);
      assert.equal(code, 'AUTH_FAILED');
      assert.match(result.agentReport.gaps[0], /登录未成功，没有执行/);
      if (config.allocateError)
        assert.match(result.agentReport.gaps[0], /账号.*占用/);
      if (config.blockedReason)
        assert.match(result.agentReport.summary, /账号已停用/);
      assert.ok(
        criteria.every((criterion) => criterion.result === 'not_evaluated'),
      );
      assert.ok(!fixture.history.includes('model:work'));
      assert.ok(!fixture.history.includes('capture'));
      assert.ok(!fixture.history.some((entry) => entry.startsWith('stop:')));
      assert.equal(fixture.session.isClosed, true);
      assert.equal(fixture.context.routes.size, 0);
      assertPrivate(fixture.finishes);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('substituted browser binding is rejected before any material or private route', async () => {
  const fixture = signInFixture({ active: { contextId: randomUUID() } });
  try {
    const outcome = await initialize(fixture, await fixture.newSession());
    assert.equal(outcome.status, 'blocked');
    assert.deepEqual(fixture.history, [
      'allocate',
      'ticket',
      'activate',
      'end:failed',
    ]);
    assert.ok(!fixture.history.includes('material'));
    assert.equal(fixture.session.isClosed, false);
  } finally {
    await fixture.cleanup();
  }
});

test('login primitives refuse origins outside the profile even when the task allows them', async () => {
  const fixture = signInFixture();
  fixture.profile.agentConfig.loginUrl = `${appOrigin}/not-an-approved-login`;
  try {
    const outcome = await initialize(fixture, await fixture.newSession());
    assert.equal(outcome.status, 'blocked');
    assert.ok(!fixture.history.includes('navigate'));
    assert.deepEqual(fixture.ends, ['failed']);
    assert.equal(fixture.context.routes.size, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('blocked settlement failure is not replayed or mistaken for a second login report', async () => {
  const fixture = signInFixture({ blockedReason: '账号已停用' });
  let settlements = 0;
  fixture.runtime.finish = async () => {
    settlements++;
    throw new Error('unknown settlement outcome');
  };
  try {
    const worker = new Worker({
      runtime: fixture.runtime,
      browser: fixture.browser,
      scratch: fixture.scratch,
      heartbeatMs: 10000,
    });
    assert.equal(await worker.once(), true);
    assert.equal(settlements, 1);
    assert.ok(fixture.history.some((entry) => entry.startsWith('stop:')));
    assert.equal(fixture.session.isClosed, true);
    assert.equal(fixture.context.routes.size, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('cancellation and run budget exhaustion never become an ordinary blocked login', async () => {
  for (const code of ['CANCELLED', 'BUDGET_EXCEEDED']) {
    const fixture = signInFixture({ modelError: new DomainError(code) });
    try {
      const worker = new Worker({
        runtime: fixture.runtime,
        browser: fixture.browser,
        scratch: fixture.scratch,
        heartbeatMs: 10000,
      });
      assert.equal(await worker.once(), true);
      assert.deepEqual(fixture.finishes, []);
      assert.ok(fixture.history.some((entry) => entry.startsWith('stop:')));
      assert.equal(fixture.session.isClosed, true);
      assert.equal(fixture.context.routes.size, 0);
      assert.ok(!fixture.ends.includes('signed_in'));
    } finally {
      await fixture.cleanup();
    }
  }
});
