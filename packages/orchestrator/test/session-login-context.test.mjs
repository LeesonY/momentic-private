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
  assert.match(SESSION_AGENT_PROMPT, /自己的浏览器里登录/);
  assert.match(SESSION_AGENT_PROMPT, /action=ask/);
  assert.match(SESSION_AGENT_PROMPT, /环境与认证/);
  assert.match(SESSION_AGENT_PROMPT, /用户确认已修正后，用 retryCaseIds/);
  assert.doesNotMatch(SESSION_AGENT_PROMPT, /login 是本次账号的登录结果/);
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
