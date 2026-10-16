// Pure Node: the real SessionAgent state machine over a SQL-free fake
// coordinator. It exercises plan acceptance/retry semantics, not PostgreSQL,
// providers or the Worker.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  INVALID_PLAN_STREAK_LIMIT,
  SessionAgent,
} from '../dist/session-agent.js';
import { sessionModelContext } from '../dist/session-schemas.js';
import { candidate, proposal } from './fixtures/session.mjs';

const marker = 'RAW MODEL OUTPUT MUST NOT LEAK';
const explored = ['https://fixture.test/'];

function fixture(sessionOverrides = {}, contextOverrides = {}) {
  const run = {
    id: randomUUID(),
    projectId: randomUUID(),
    phase: 'plan',
    targetUrl: 'https://fixture.test/',
    effectiveConfig: {
      allowedOrigins: ['https://fixture.test'],
      budget: { maxCases: 5, maxPages: 5 },
      taskIntent: 'flow',
      actionPolicy: 'non_submitting',
    },
  };
  const events = [];
  const coordinator = {
    protectedOrigins: [],
    change: async (_client, current, status, phase) => ({
      ...current,
      status,
      phase,
    }),
    enqueue: async (_client, _run, role, stage, key, id, attempt, extra) => {
      events.push({ action: 'enqueue', role, stage, caseId: id, extra });
    },
    insertCase: async (_client, definition) => {
      events.push({ action: 'case', definition });
    },
    enqueueReproductions: async () => 0,
  };
  const agent = new SessionAgent(coordinator);
  const state = {
    session: {
      objective: 'Check login',
      round: 2,
      status: 'planning',
      plan: '',
      caseIds: [],
      exploredUrls: [...explored],
      coverageGaps: [],
      summary: '',
      history: [],
      ...sessionOverrides,
    },
  };
  agent.context = async () => ({
    session: state.session,
    targetUrl: run.targetUrl,
    sources: [{ kind: 'user_spec', ref: 'brief:owned', text: 'Check login' }],
    observations: [],
    cases: [],
    findings: [],
    remainingCases: 4,
    remainingPages: 1,
    actionPolicy: 'non_submitting',
    taskIntent: 'flow',
    writeScope: [],
    assertionCapabilities: {
      structuredOutput: true,
      nativeTools: false,
      imageInput: false,
    },
    ...contextOverrides,
  });
  agent.write = async (_client, _run, document) => {
    Object.assign(state.session, document);
    events.push({ action: 'session', document });
  };
  agent.read = async () => state.session;
  const client = { query: async () => ({ rows: [{ run_id: run.id }] }) };
  const job = {
    id: randomUUID(),
    role: 'coordinator',
    status: 'succeeded',
    document: { summary: 'plan' },
    result: { stage: 'plan', sessionRound: state.session.round },
  };
  const plannerJob = () => ({ ...job, result: { ...job.result } });
  const enqueued = (role) =>
    events.filter((event) => event.action === 'enqueue' && event.role === role);
  return { agent, client, run, job, plannerJob, events, state, enqueued };
}

const invalid = (agent, client, run, job, hint) =>
  agent.applyPlan(client, run, job, undefined, 'VALIDATION_ERROR', hint);

test('an invalid planner round keeps the session reviewable and re-plans without new results', async () => {
  // An existing case means no fixed technical smoke is dispatched, so this
  // round leaves nothing in flight and the next round starts immediately.
  const f = fixture({}, { cases: [{ definition: candidate() }] });
  await invalid(f.agent, f.client, f.run, f.job, ['/cases/*:required:id']);
  const written = f.events.find((event) => event.action === 'session').document;
  assert.equal(written.status, 'reviewing');
  assert.equal(written.planningStopped, false);
  assert.equal(written.invalidPlanStreak, 1);
  assert.deepEqual(written.lastPlanFailure, {
    reasonCode: 'VALIDATION_ERROR',
    schemaErrors: ['/cases/*:required:id'],
  });
  assert.match(written.coverageGaps.join(' '), /规划输出不合格/);
  assert.ok(!written.coverageGaps.some((gap) => gap.includes('停止重复派工')));
  // No business case and no fixed technical smoke when exploration is possible.
  assert.deepEqual(
    f.events.filter((event) => event.action === 'case'),
    [],
  );
  assert.deepEqual(
    f.events.filter((event) => event.action === 'enqueue'),
    [],
  );
  await f.agent.advance(f.client, f.run, [f.plannerJob()]);
  assert.deepEqual(
    f.events
      .filter((event) => event.action === 'enqueue')
      .map((event) => [event.role, event.stage]),
    [['coordinator', 'plan']],
  );
  assert.equal(f.state.session.round, 3);
  assert.equal(f.state.session.status, 'reviewing');
});

test('three consecutive invalid rounds stop planning and finalize; an accepted round clears the streak', async () => {
  const f = fixture();
  for (const round of [1, 2, INVALID_PLAN_STREAK_LIMIT]) {
    await invalid(f.agent, f.client, f.run, f.job, ['/rationale:required']);
    assert.equal(f.state.session.invalidPlanStreak, round);
  }
  assert.equal(f.state.session.planningStopped, true);
  assert.equal(f.state.session.status, 'finalizing');
  assert.match(
    f.state.session.coverageGaps.join(' '),
    /连续 3 轮规划输出不合格/,
  );
  const before = f.events.length;
  await f.agent.advance(f.client, f.run, [f.plannerJob()]);
  assert.deepEqual(f.enqueued('coordinator'), []);
  assert.deepEqual(f.enqueued('finalizer').length, 1);
  assert.ok(f.events.length > before);

  const acceptedFixture = fixture({
    invalidPlanStreak: 2,
    lastPlanFailure: {
      reasonCode: 'VALIDATION_ERROR',
      schemaErrors: ['/rationale:required'],
    },
  });
  await acceptedFixture.agent.applyPlan(
    acceptedFixture.client,
    acceptedFixture.run,
    acceptedFixture.job,
    proposal({ cases: [candidate()] }),
  );
  assert.equal(acceptedFixture.state.session.invalidPlanStreak, 0);
  assert.equal(acceptedFixture.state.session.lastPlanFailure, null);
  assert.equal(acceptedFixture.state.session.status, 'working');
  assert.equal(acceptedFixture.state.session.planningStopped, false);
  assert.equal(acceptedFixture.enqueued('executor').length, 1);
});

test('a dispatched technical smoke no longer stops planning and its result can be reviewed', async () => {
  const f = fixture({ round: 2, exploredUrls: [...explored] });
  await f.agent.applyPlan(
    f.client,
    f.run,
    f.job,
    undefined,
    'MODEL_OUTPUT_TRUNCATED',
    ['/cases/*:additionalProperties:id'],
  );
  assert.equal(f.state.session.planningStopped, false);
  assert.equal(f.state.session.status, 'working');
  assert.equal(f.state.session.invalidPlanStreak, 1);
  const smoke = f.events.find((event) => event.action === 'case')?.definition;
  assert.deepEqual(
    smoke.criteria.map((criterion) => criterion.id),
    ['smoke.http', 'smoke.visible'],
  );
  assert.deepEqual(f.enqueued('executor').length, 1);
  // The smoke result is a new result: the main AI reviews it and can ask.
  const executor = {
    id: randomUUID(),
    role: 'executor',
    status: 'succeeded',
    result: { stage: 'execute' },
    document: { summary: 'execute' },
  };
  await f.agent.advance(f.client, f.run, [f.plannerJob(), executor]);
  assert.deepEqual(
    f.events
      .filter((event) => event.action === 'enqueue')
      .map((event) => [event.role, event.stage]),
    [
      ['executor', 'execute'],
      ['coordinator', 'plan'],
    ],
  );
  assert.deepEqual(f.enqueued('finalizer'), []);
});

test('a proposal the server rejects counts as an invalid round with a safe reason', async () => {
  const f = fixture();
  await f.agent.applyPlan(
    f.client,
    f.run,
    f.job,
    proposal({ cases: [candidate('订单审批', 'https://evil.test/approve')] }),
  );
  assert.equal(f.state.session.invalidPlanStreak, 1);
  assert.equal(f.state.session.planningStopped, false);
  assert.equal(f.state.session.status, 'working');
  assert.deepEqual(f.state.session.lastPlanFailure, {
    reasonCode: 'TARGET_NOT_ALLOWED',
    schemaErrors: [],
  });
  // Only the server-owned technical smoke is dispatched; the unapproved
  // business case never becomes an executable case.
  const cases = f.events
    .filter((event) => event.action === 'case')
    .map((event) => event.definition);
  assert.equal(cases.length, 1);
  assert.deepEqual(
    cases[0].criteria.map((criterion) => criterion.id),
    ['smoke.http', 'smoke.visible'],
  );
  assert.equal(cases[0].entryUrl === undefined, true);
  assert.deepEqual(f.enqueued('executor').length, 1);
  assert.equal(f.enqueued('executor')[0].extra.entryUrl, f.run.targetUrl);
});

test('the next planning context explains the rejection with schema paths only', async () => {
  const f = fixture({
    invalidPlanStreak: 2,
    lastPlanFailure: {
      reasonCode: 'VALIDATION_ERROR',
      schemaErrors: ['/cases/*:additionalProperties:id', '/rationale:required'],
    },
    plan: marker,
    coverageGaps: [marker],
  });
  const context = await f.agent.context(f.client, f.run);
  const payload = sessionModelContext(context);
  assert.deepEqual(payload.previousPlanRejected.schemaErrors, [
    '/cases/*:additionalProperties:id',
    '/rationale:required',
  ]);
  assert.equal(payload.previousPlanRejected.attempt, 2);
  assert.equal(payload.previousPlanRejected.limit, INVALID_PLAN_STREAK_LIMIT);
  assert.match(payload.previousPlanRejected.instruction, /严格按 outputSchema/);
  assert.ok(!JSON.stringify(payload.previousPlanRejected).includes(marker));
  // The summary context has no planning hint at all.
  const summary = sessionModelContext(context, 'summarize');
  assert.equal('previousPlanRejected' in summary, false);
  // A cleared streak removes the hint.
  const clean = sessionModelContext(
    await (async () => {
      f.state.session.invalidPlanStreak = 0;
      f.state.session.lastPlanFailure = null;
      return f.agent.context(f.client, f.run);
    })(),
  );
  assert.equal('previousPlanRejected' in clean, false);
});

test('unsafe failure hints are refused before any session write', async () => {
  const f = fixture();
  for (const hint of [
    [
      '/a:required',
      '/b:required',
      '/c:required',
      '/d:required',
      '/e:required',
      '/f:required',
      '/g:required',
    ],
    ['/a:required', 7],
    [`/${'x'.repeat(200)}:required`],
    ['/cases/*:additionalProperties:id name'],
    ['{"value":"secret"}'],
  ]) {
    const before = f.events.length;
    await assert.rejects(
      invalid(f.agent, f.client, f.run, f.job, hint),
      (error) => error.code === 'VALIDATION_ERROR',
    );
    assert.equal(f.events.length, before);
    assert.equal(f.state.session.invalidPlanStreak, undefined);
  }
  await assert.rejects(
    f.agent.applyPlan(f.client, f.run, f.job, undefined, undefined, [
      '/a:required',
    ]),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});
