import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Coordinator } from '../dist/core.js';
import { SessionAgent } from '../dist/session-agent.js';

const makeRun = () => ({
  id: randomUUID(),
  projectId: randomUUID(),
  phase: 'auth',
  targetUrl: 'https://approved.example.test/login',
  effectiveConfig: {
    allowedOrigins: ['https://approved.example.test'],
    budget: { maxCases: 1, maxPages: 1 },
  },
});
const makeCoordinator = () => {
  const coordinator = new Coordinator({
    db: {},
    vault: {},
    serviceActor: { userId: randomUUID() },
  });
  const events = [];
  coordinator.change = async (_client, run, status, phase) => {
    events.push({ action: 'phase', phase });
    return { ...run, status, phase };
  };
  coordinator.enqueue = async (
    _client,
    _run,
    role,
    stage,
    _key,
    id,
    _attempt,
    extra,
  ) => {
    events.push({ action: 'enqueue', role, stage, caseId: id, extra });
  };
  coordinator.insertCase = async (_client, definition) => {
    events.push({ action: 'case', definition });
  };
  return { coordinator, events };
};

test('trusted smoke skips AI explorer/planner and executes frozen case directly', async () => {
  const run = makeRun();
  const frozenCase = {
    id: randomUUID(),
    runId: run.id,
    projectId: run.projectId,
    version: 1,
    outline: ['Navigate https://approved.example.test/login'],
    criteria: [{ id: 'http', sourceKind: 'generic_smoke' }],
  };
  const { coordinator, events } = makeCoordinator();
  const client = { query: async () => ({ rows: [{ document: frozenCase }] }) };
  const updated = await coordinator.startSmokeAfterAuth(client, run);
  assert.equal(updated.phase, 'execute');
  assert.deepEqual(
    events.map((e) => e.action),
    ['phase', 'enqueue'],
  );
  assert.equal(events[1].role, 'executor');
  assert.equal(events[1].caseId, frozenCase.id);
  assert.equal(events[1].extra.entryUrl, run.targetUrl);
});

test('an AI session without frozen cases still enters its normal explore path', async () => {
  const run = makeRun();
  const { coordinator, events } = makeCoordinator();
  coordinator.sessions.read = async () => null;
  const client = { query: async () => ({ rows: [] }) };
  const updated = await coordinator.startSmokeAfterAuth(client, run);
  assert.equal(updated.phase, 'explore');
  assert.equal(events[1].role, 'explorer');
});

test('an unverifiable AI citation keeps the session agent case, marked inferred', async () => {
  const run = { ...makeRun(), phase: 'plan' };
  const { coordinator, events } = makeCoordinator();
  const agent = new SessionAgent(coordinator);
  const session = {
    round: 1,
    status: 'planning',
    objective: 'Check login',
    plan: '',
    caseIds: [],
    exploredUrls: [],
    coverageGaps: [],
    summary: '',
    history: [],
  };
  agent.context = async () => ({
    session,
    sources: [{ kind: 'user_spec', ref: 'brief:owned', text: 'Check login' }],
    observations: [],
    cases: [],
    findings: [],
    remainingCases: 1,
    remainingPages: 1,
    actionPolicy: 'non_submitting',
    assertionCapabilities: {
      structuredOutput: true,
      nativeTools: false,
      imageInput: false,
    },
  });
  agent.write = async (_client, _run, document) => {
    events.push({ action: 'session', document });
  };
  const invalid = {
    action: 'dispatch',
    rationale: 'Bad source',
    coverageGaps: [],
    exploreTargets: [],
    cases: [
      {
        entryUrl: run.targetUrl,
        title: 'Unsupported business claim',
        summary: 'Not sourced',
        preconditions: [],
        outline: ['Observe'],
        criteria: [
          {
            id: 'invented',
            kind: 'semantic',
            description: 'User is logged in',
            sourceKind: 'user_spec',
            sourceRef: 'brief:invented',
            sourceQuote: 'not in user request',
            locator: null,
            expectedValue: null,
          },
        ],
      },
    ],
  };
  const client = { query: async () => ({ rows: [{ run_id: run.id }] }) };
  await agent.applyPlan(
    client,
    run,
    { role: 'coordinator', result: { stage: 'plan', sessionRound: 1 } },
    invalid,
  );
  // Mo-style: the session agent's case runs; its unverifiable citation is
  // only not claimed as a sourced business rule.
  const c = events.find((e) => e.action === 'case')?.definition;
  assert.ok(c);
  assert.equal(c.title, 'Unsupported business claim');
  assert.deepEqual(
    c.criteria.map((x) => [x.sourceKind, x.sourceRef]),
    [['inferred', 'session:planner']],
  );
  assert.equal(events.filter((e) => e.action === 'enqueue').length, 1);
  const documented = events.find((e) => e.action === 'session').document;
  assert.equal(documented.caseIds.length, 1);
  assert.equal(documented.status, 'working');
});

test('truncated Planner output may only create fixed technical smoke, not invented business cases', async () => {
  const run = { ...makeRun(), phase: 'plan' };
  const { coordinator, events } = makeCoordinator();
  const agent = new SessionAgent(coordinator);
  agent.context = async () => ({
    session: {
      round: 1,
      status: 'planning',
      objective: 'Check login',
      plan: '',
      caseIds: [],
      exploredUrls: [],
      coverageGaps: [],
      summary: '',
      history: [],
    },
    sources: [],
    observations: [],
    cases: [],
    findings: [],
    remainingCases: 1,
    remainingPages: 1,
    actionPolicy: 'non_submitting',
    assertionCapabilities: {
      structuredOutput: true,
      nativeTools: false,
      imageInput: false,
    },
  });
  agent.write = async (_client, _run, document) => {
    events.push({ action: 'session', document });
  };
  const client = { query: async () => ({ rows: [{ run_id: run.id }] }) };
  const job = {
    role: 'coordinator',
    result: { stage: 'plan', sessionRound: 1 },
  };
  await agent.applyPlan(client, run, job, undefined, 'MODEL_OUTPUT_TRUNCATED');
  const c = events.find((e) => e.action === 'case')?.definition;
  assert.deepEqual(
    c.criteria.map((v) => v.id),
    ['smoke.http', 'smoke.visible'],
  );
  assert.equal(events.filter((e) => e.action === 'enqueue').length, 1);
  const report = events.find((e) => e.action === 'session').document;
  assert.equal(report.status, 'finalizing');
  assert.match(report.coverageGaps.join(' '), /业务用例未得到确认/);
  const originalCount = events.length;
  await assert.rejects(
    agent.applyPlan(client, run, job, undefined, 'SERVICE_UNAVAILABLE'),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    agent.applyPlan(
      client,
      run,
      job,
      { action: 'finish' },
      'MODEL_OUTPUT_TRUNCATED',
    ),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.equal(events.length, originalCount);
});

test('fallback finalization preserves independent reproduction before report', async () => {
  const run = { ...makeRun(), phase: 'execute' };
  const { coordinator, events } = makeCoordinator();
  const agent = new SessionAgent(coordinator);
  agent.read = async () => ({
    status: 'finalizing',
    caseIds: ['a'],
    coverageGaps: ['AI plan rejected'],
  });
  coordinator.enqueueReproductions = async () => 1;
  const processed = await agent.advance(
    { query: async () => ({ rows: [] }) },
    run,
    [],
  );
  assert.equal(processed, true);
  assert.deepEqual(events, [{ action: 'phase', phase: 'reproduce' }]);
});
