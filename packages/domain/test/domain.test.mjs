import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  transition,
  PHASES,
  TERMINAL,
  reserve,
  DEFAULT_LIMITS,
  SESSION_DEFAULT_LIMITS,
  EMPTY_USED,
  validateTarget,
  validateBrowserTool,
  summarize,
  completion,
  smokeCase,
  verdictStatus,
  evaluateTechnical,
  criteriaHash,
  canonicalHash,
  PageGraph,
  AGENT_LOGIN_CRITERION,
  authCriterionFor,
  evaluateAgentLogin,
  evaluateAuthCriterion,
} from '../dist/index.js';
import { parseContract } from '@localqa/contracts';
const statuses = [
  'draft',
  'queued',
  'running',
  'awaiting_input',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
];
const allowed = {
  draft: ['queued', 'cancelled'],
  queued: ['running', 'cancelling', 'failed'],
  running: ['awaiting_input', 'cancelling', 'completed', 'failed'],
  awaiting_input: ['running', 'cancelling', 'completed', 'failed'],
  cancelling: ['cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
};
for (const from of statuses)
  test(`status matrix: ${from}`, () => {
    for (const to of statuses) {
      const phase = TERMINAL.has(to) ? 'finalize' : 'execute';
      const work = () =>
        transition({ status: from, phase: 'execute' }, to, phase);
      if (!TERMINAL.has(from) && (from === to || allowed[from].includes(to)))
        assert.doesNotThrow(work);
      else assert.throws(work);
    }
  });
test('all phase ordering and saved waiting phase', () => {
  for (const from of PHASES)
    for (const to of PHASES) {
      const work = () =>
        transition({ status: 'running', phase: from }, 'running', to);
      if (PHASES.indexOf(to) >= PHASES.indexOf(from)) assert.doesNotThrow(work);
      else assert.throws(work);
    }
  assert.throws(() =>
    transition(
      { status: 'awaiting_input', phase: 'execute' },
      'running',
      'reproduce',
    ),
  );
  assert.throws(() =>
    transition({ status: 'running', phase: 'execute' }, 'completed'),
  );
});
test('session defaults widen only tokens, calls and wall-clock; regression keeps the old limits', () => {
  assert.deepEqual(SESSION_DEFAULT_LIMITS, {
    ...DEFAULT_LIMITS,
    maxActiveSeconds: 1800,
    maxModelCalls: 300,
    maxTotalTokens: 1500000,
  });
  for (const key of Object.keys(DEFAULT_LIMITS))
    if (!['maxActiveSeconds', 'maxModelCalls', 'maxTotalTokens'].includes(key))
      assert.equal(SESSION_DEFAULT_LIMITS[key], DEFAULT_LIMITS[key], key);
  // The shared contract still allows the raised values.
  assert.ok(SESSION_DEFAULT_LIMITS.maxTotalTokens <= 5000000);
  assert.ok(SESSION_DEFAULT_LIMITS.maxModelCalls <= 500);
  assert.ok(SESSION_DEFAULT_LIMITS.maxActiveSeconds <= 3600);
});
test('reservation boundary: exact limit, over limit, held reservations, negative/noninteger/unknown', () => {
  assert.equal(
    reserve(DEFAULT_LIMITS, EMPTY_USED, { modelCalls: 99 }, { modelCalls: 1 })
      .modelCalls,
    100,
  );
  assert.throws(() =>
    reserve(DEFAULT_LIMITS, EMPTY_USED, { modelCalls: 100 }, { modelCalls: 1 }),
  );
  assert.throws(() =>
    reserve(
      DEFAULT_LIMITS,
      { ...EMPTY_USED, actions: 119 },
      { actions: 1 },
      { actions: 1 },
    ),
  );
  for (const amount of [
    { actions: -1 },
    { actions: 0.5 },
    { actions: NaN },
    { unknown: 1 },
  ])
    assert.throws(() => reserve(DEFAULT_LIMITS, EMPTY_USED, {}, amount));
  assert.deepEqual(reserve(DEFAULT_LIMITS, EMPTY_USED, {}, {}), {});
});
test('exact scheme/host/port scope and no userinfo/metadata/side effects/arbitrary tools', () => {
  const origins = ['http://localhost:8080'];
  assert.equal(
    validateTarget('http://localhost:8080/a?q=1', origins).pathname,
    '/a',
  );
  for (const url of [
    'http://localhost:8081/',
    'https://localhost:8080/',
    'http://u:p@localhost:8080/',
    'http://169.254.169.254/',
    'file:///etc/passwd',
  ])
    assert.throws(() => validateTarget(url, origins));
  for (const call of [
    { name: 'shell', args: {} },
    { name: 'observe', args: { runId: randomUUID() } },
    {
      name: 'click',
      args: {
        target: { pageId: randomUUID(), snapshotId: randomUUID(), nodeId: 'x' },
      },
    },
    { name: 'navigate', args: { url: 'http://localhost:8080/api/delete' } },
  ])
    assert.throws(() => validateBrowserTool('executor', call, origins));
  assert.throws(() =>
    validateBrowserTool('coordinator', { name: 'observe', args: {} }, origins),
  );
});
const run = { id: randomUUID(), projectId: randomUUID() };
const definition = smokeCase(run, 'http://localhost:8080/');
test('criteria hashes canonical key ordering and retain all original criteria', () => {
  assert.equal(criteriaHash(definition), canonicalHash(definition.criteria));
  const changed = structuredClone(definition);
  changed.criteria[0].expectedValue = { min: 200, max: 499 };
  assert.notEqual(criteriaHash(definition), criteriaHash(changed));
});
test('verdict semantics: all passed, credible failed, blocked, unknown and fake evidence', () => {
  const evidence = randomUUID();
  const results = definition.criteria.map((c) => ({
    criterionId: c.id,
    result: 'passed',
    reason: 'Observed',
    evidenceRefs: [evidence],
  }));
  const known = new Set([evidence]);
  assert.equal(verdictStatus(definition, results, known), 'passed');
  assert.equal(
    verdictStatus(
      definition,
      [{ ...results[0], result: 'failed' }, results[1]],
      known,
    ),
    'issue_found',
  );
  assert.equal(
    verdictStatus(
      definition,
      [{ ...results[0], result: 'not_evaluated' }, results[1]],
      known,
    ),
    'blocked',
  );
  assert.equal(
    verdictStatus(
      definition,
      [{ ...results[0], result: 'unknown' }, results[1]],
      known,
    ),
    'inconclusive',
  );
  assert.throws(() => verdictStatus(definition, results, new Set()));
  assert.throws(() =>
    verdictStatus(definition, [results[0], results[0]], known),
  );
  assert.throws(() => verdictStatus(definition, [results[0]], known));
  const inferred = structuredClone(definition);
  inferred.criteria[0].sourceKind = 'inferred';
  assert.equal(
    verdictStatus(
      inferred,
      [{ ...results[0], result: 'failed' }, results[1]],
      known,
    ),
    'inconclusive',
  );
  assert.throws(() => parseContract('Verdict', { status: 'not_run' }));
});
test('all result counts and zero denominators; completion independent of success', () => {
  const summary = summarize([
    'passed',
    'issue_found',
    'blocked',
    'inconclusive',
    'not_run',
  ]);
  assert.deepEqual(summary, {
    passed: 1,
    issueFound: 1,
    blocked: 1,
    inconclusive: 1,
    notRun: 1,
    planned: 5,
    attempted: 4,
    evaluated: 2,
    passRate: 0.5,
    attemptRate: 0.8,
  });
  assert.equal(summarize([]).passRate, null);
  assert.equal(summarize([]).attemptRate, null);
  assert.equal(completion('normal', summarize(['issue_found'])), 'complete');
  assert.equal(completion('budget_limit', summary), 'partial');
  assert.equal(completion('normal', summarize(['not_run'])), 'none');
});
test('truncated, unsupported and child-frame observations cannot prove a sourced main-frame failure or pass', () => {
  const c = structuredClone(definition);
  c.criteria = [
    {
      ...c.criteria[1],
      kind: 'element_visible',
      sourceKind: 'user_spec',
      sourceRef: 'fixed:user-criterion',
      locator: { by: 'role', value: 'main' },
    },
  ];
  const evidence = [randomUUID()];
  const snapshot = { truncated: false, nodes: [] };
  assert.equal(
    evaluateTechnical(c, snapshot, 200, evidence)[0].result,
    'failed',
  );
  assert.equal(
    evaluateTechnical(c, { ...snapshot, truncated: true }, 200, evidence)[0]
      .result,
    'unknown',
  );
  c.criteria[0].locator = { by: 'css', value: '#unknown' };
  assert.equal(
    evaluateTechnical(c, snapshot, 200, evidence)[0].result,
    'unknown',
  );
  c.criteria[0].locator = { by: 'role', value: 'main' };
  assert.equal(
    evaluateTechnical(
      c,
      {
        ...snapshot,
        nodes: [{ frameId: 'iframe-1', visible: true, role: 'main' }],
      },
      200,
      evidence,
    )[0].result,
    'failed',
  );
  assert.equal(
    evaluateTechnical(
      c,
      {
        ...snapshot,
        nodes: [{ frameId: 'main', visible: true, role: 'main' }],
      },
      200,
      evidence,
    )[0].result,
    'passed',
  );
});
test('graph URL/structure dedup, maxPages and maxDepth', () => {
  const graph = new PageGraph({ maxPages: 2, maxDepth: 1 });
  const snapshot = { nodes: [{ role: 'main', name: 'main', text: 'hello' }] };
  assert.equal(graph.visit('http://localhost:8080/', 0, snapshot), true);
  assert.equal(graph.visit('http://localhost:8080/?x=1', 0, snapshot), false);
  assert.equal(graph.visit('http://localhost:8080/a', 2, { nodes: [] }), false);
  assert.equal(graph.visit('http://localhost:8080/a', 1, { nodes: [] }), true);
  assert.equal(graph.canNavigate('http://localhost:8080/b', 1), false);
});

test('agent sign-in: the sign-in agent decides, the server keeps no page heuristics', () => {
  const evidence = [randomUUID()];
  const field = (role, visible = true) => ({
    nodeId: `${role}-1`,
    frameId: 'main',
    role,
    name: role,
    text: '',
    visible,
    enabled: true,
    bounds: { left: 0, top: 0, width: 1, height: 1 },
  });
  const page = (nodes, responseStatus = 200) => ({ nodes, responseStatus });
  // The agent's "signed in" decision stands even where the old oracle
  // second-guessed it (a password field on a dashboard, an error status).
  for (const snapshot of [
    page([field('link')]),
    page([field('password')]),
    page([field('link')], 500),
  ])
    assert.equal(evaluateAgentLogin(snapshot, evidence).result, 'passed');
  // Without a registered observation there is nothing to tie it to.
  assert.equal(evaluateAgentLogin(page([]), evidence).result, 'unknown');
  assert.equal(evaluateAgentLogin(page([field('link')]), []).result, 'unknown');
  const passed = evaluateAgentLogin(page([field('link')]), evidence);
  assert.equal(passed.criterionId, AGENT_LOGIN_CRITERION.id);
  assert.deepEqual(passed.evidenceRefs, evidence);
});

test('each auth mode has exactly one frozen criterion and evaluator', () => {
  const success = parseContract('Criterion', {
    id: 'login_success',
    kind: 'element_visible',
    description: 'menu',
    sourceKind: 'user_spec',
    sourceRef: 'auth_profile',
    locator: { by: 'test_id', value: 'menu' },
  });
  assert.equal(authCriterionFor({ mode: 'none' }), null);
  assert.equal(authCriterionFor({ mode: 'agent' }), AGENT_LOGIN_CRITERION);
  assert.equal(
    authCriterionFor({
      mode: 'form',
      formConfig: { successCriterion: success },
    }),
    success,
  );
  assert.equal(
    authCriterionFor({ mode: 'storage_state', storageCriterion: success }),
    success,
  );
  assert.equal(authCriterionFor({ mode: 'form', formConfig: null }), null);
  // An agent profile cannot borrow another criterion to authorize capture.
  const snapshot = { nodes: [], responseStatus: 200, truncated: false };
  assert.equal(
    evaluateAuthCriterion({ mode: 'agent' }, success, snapshot, [randomUUID()]),
    undefined,
  );
  assert.ok(parseContract('Criterion', AGENT_LOGIN_CRITERION));
});
