import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContract } from '@localqa/contracts';
import { SESSION_AGENT_PROMPT } from '@localqa/agents';
import { Worker } from '../../../apps/worker/dist/index.js';
import { loginReportText } from '../dist/session-agent.js';
import { sessionModelContext } from '../dist/session-schemas.js';
import { sessionFixture } from './fixtures/session.mjs';

test('session and model contexts have no run-level login, even with an old auth job', async () => {
  const fixture = sessionFixture();
  fixture.addJob(null, {
    stage: 'auth',
    status: 'failed',
    result: {
      loginBlocked: { reasonCode: 'AUTH_FAILED', detail: '旧登录结果' },
    },
  });
  const context = await fixture.agent.context(fixture.client, fixture.run);
  assert.equal('login' in context, false);
  for (const purpose of ['plan', 'summarize'])
    assert.equal('login' in sessionModelContext(context, purpose), false);
  assert.ok(
    !fixture.state.queries.some(({ sql }) =>
      sql.includes("document->>'summary'='auth'"),
    ),
  );
  assert.match(SESSION_AGENT_PROMPT, /执行代理开工前由平台用该账号自动登录/);
  assert.match(SESSION_AGENT_PROMPT, /actionPolicy=non_submitting/);
  assert.match(SESSION_AGENT_PROMPT, /requiresLogin 设为 false/);
  assert.match(SESSION_AGENT_PROMPT, /账号被占用.*不要反复重跑/);
  assert.match(SESSION_AGENT_PROMPT, /action=ask/);
  assert.match(SESSION_AGENT_PROMPT, /环境与认证/);
  assert.match(SESSION_AGENT_PROMPT, /retryCaseIds/);
  assert.match(
    SESSION_AGENT_PROMPT,
    /signIn\.configured=true 时不要向用户要账号/,
  );
  assert.match(SESSION_AGENT_PROMPT, /至少一条 requiresLogin=true 的用例/);
  assert.match(SESSION_AGENT_PROMPT, /本轮已有 requiresLogin=true 的用例时/);
  assert.match(SESSION_AGENT_PROMPT, /如果本轮用例全是 requiresLogin=false/);
  assert.match(
    SESSION_AGENT_PROMPT,
    /至少补一条最小的 requiresLogin=true 用例/,
  );
  assert.match(SESSION_AGENT_PROMPT, /反向焦点顺序用 press key=Shift\+Tab/);
  assert.match(SESSION_AGENT_PROMPT, /signIn\.configured=false/);
  assert.match(SESSION_AGENT_PROMPT, /signIn\.succeeded\/failed/);
  assert.match(SESSION_AGENT_PROMPT, /sharingPolicy=exclusive_run/);
  assert.doesNotMatch(SESSION_AGENT_PROMPT, /login 是本次账号的登录结果/);
});

test('signIn context exposes the bound profile and self sign-in summary without secrets', async () => {
  const secret = 'fixture-password-9f2c';
  const fixture = sessionFixture(
    {},
    {
      authProfile: {
        name: '114 本地测试账号 localqa-mo01',
        sharingPolicy: 'exclusive_run',
        mode: 'form',
        status: 'active',
        version: 3,
        secret,
        formConfig: { loginUrl: 'https://fixture.test/login' },
      },
      authSessions: [{ endReason: 'signed_in' }, { endReason: 'signed_in' }],
      signInFailures: ['登录代理调用模型超时，没能完成登录。'],
    },
  );
  const context = await fixture.agent.context(fixture.client, fixture.run);
  assert.deepEqual(context.signIn, {
    configured: true,
    profileName: '114 本地测试账号 localqa-mo01',
    sharingPolicy: 'exclusive_run',
    succeeded: 2,
    failed: 1,
    lastFailure: '登录代理调用模型超时，没能完成登录。',
  });
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('fixture.test/login'), false);
  for (const purpose of ['plan', 'summarize'])
    assert.deepEqual(
      sessionModelContext(context, purpose).signIn,
      context.signIn,
    );
});

test('signIn context stays unconfigured without a usable profile', async () => {
  for (const options of [
    {},
    {
      authProfile: {
        name: '已撤销账号',
        sharingPolicy: 'shared_state',
        mode: 'form',
        status: 'revoked',
        version: 1,
      },
    },
    {
      authProfile: {
        name: '匿名配置',
        sharingPolicy: 'shared_state',
        mode: 'none',
        status: 'active',
        version: 1,
      },
    },
  ]) {
    const fixture = sessionFixture({}, options);
    const context = await fixture.agent.context(fixture.client, fixture.run);
    assert.deepEqual(context.signIn, {
      configured: false,
      profileName: null,
      sharingPolicy: null,
      succeeded: 0,
      failed: 0,
      lastFailure: null,
    });
  }
});

test('Worker login blocking is persisted as a case report visible to the session AI', async () => {
  const fixture = sessionFixture();
  const record = fixture.addCase('not_run');
  const job = fixture.addJob(record.definition.id, { status: 'running' });
  const attempt = fixture.addAttempt(record.definition, { job, outcome: null });
  fixture.coordinator.validateLease = async () => ({ run: fixture.run, job });
  fixture.coordinator.authImportService.endTask = async () => null;
  fixture.coordinator.authExecution.endTaskSignIn = async () => {};
  fixture.coordinator.sessions.advance = async () => true;
  const query = fixture.client.query.bind(fixture.client);
  fixture.client.query = async (sql, params = []) => {
    if (sql.includes('SELECT j.* FROM jobs j JOIN task_leases'))
      return { rows: [job] };
    if (sql.includes('SELECT document FROM run_cases WHERE id='))
      return { rows: [{ document: record.definition }] };
    if (sql.includes('SELECT * FROM case_attempts WHERE task_id='))
      return { rows: [attempt] };
    if (sql.includes('INSERT INTO verdicts')) {
      attempt.verdict = parseContract('Verdict', params[4]);
      return { rows: [] };
    }
    if (
      sql.includes('UPDATE case_attempts SET status=') ||
      sql.includes('SELECT 1 FROM action_intents') ||
      sql.includes('SELECT id FROM artifacts')
    )
      return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE jobs SET status='succeeded'")) {
      Object.assign(job, { status: 'succeeded', result: params[1] });
      return { rows: [] };
    }
    return query(sql, params);
  };
  const scope = {
    projectId: fixture.run.projectId,
    workerId: 'fixture-worker',
  };
  const proof = { taskId: job.id, fencingToken: 1, leaseToken: 'fixture' };
  const worker = new Worker({
    runtime: {
      finish: (...args) => fixture.coordinator.finish(scope, ...args),
    },
    browser: {},
    scratch: '.',
  });
  const detail = `登录未成功，没有执行：${loginReportText({
    reasonCode: 'AUTH_FAILED',
    detail: '页面提示用户名或密码错误。',
  })}`;
  await worker.reportBlocked(
    proof,
    { stage: 'execute', definition: record.definition },
    'AUTH_FAILED',
    detail,
  );
  assert.equal(fixture.run.status, 'running');
  assert.equal(attempt.verdict.reasonCode, 'AUTH_FAILED');
  assert.equal(attempt.verdict.summary, detail);
  assert.deepEqual(attempt.verdict.gaps, [detail]);
  assert.equal(
    fixture.state.events.find((e) => e.type === 'case.result').payload.outcome,
    'blocked',
  );
  const context = await fixture.agent.context(fixture.client, fixture.run);
  for (const purpose of ['plan', 'summarize']) {
    const report = sessionModelContext(context, purpose).cases[0].report;
    assert.equal(report.status, 'blocked');
    assert.equal(report.summary, detail);
    assert.deepEqual(report.gaps, [detail]);
  }
});

test('task login report text still cleans credentials and explains failure codes', () => {
  const detail = loginReportText({
    reasonCode: 'AUTH_FAILED',
    detail: '密码=private-value，登录被拒绝',
  });
  assert.doesNotMatch(detail, /private-value/);
  assert.match(detail, /redacted/);
  for (const reasonCode of [
    'MODEL_TIMEOUT',
    'MODEL_FAILURE',
    'RATE_LIMITED',
    'AGENT_STEP_LIMIT',
    'OTP_UNAVAILABLE',
    'AUTH_INTERRUPTED',
    null,
  ])
    assert.ok(loginReportText({ reasonCode, detail: null }).length > 0);
});

test('a refused or unreachable sign-in request is explained, not just named', () => {
  assert.match(
    loginReportText({ reasonCode: 'POLICY_DENIED', detail: null }),
    /网络策略拦截/,
  );
  assert.match(
    loginReportText({ reasonCode: 'BROWSER_UNAVAILABLE', detail: null }),
    /连接失败/,
  );
  assert.match(
    loginReportText({ reasonCode: 'TARGET_NOT_ALLOWED', detail: null }),
    /域名范围/,
  );
  // A trusted primitive's bounded request label wins over the generic text.
  assert.equal(
    loginReportText({
      reasonCode: 'POLICY_DENIED',
      detail: 'POST http://192.168.111.66:9588/idp/authCenter/login',
    }),
    'POST http://192.168.111.66:9588/idp/authCenter/login',
  );
});
