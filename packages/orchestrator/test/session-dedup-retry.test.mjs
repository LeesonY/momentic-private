import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getValidator, parseContract } from '@localqa/contracts';
import { taskKey } from '@localqa/domain';
import { runDTO } from '@localqa/storage';
import { SESSION_AGENT_PROMPT } from '@localqa/agents';
import {
  reviewSessionProposal,
  parseSessionDecision,
} from '../dist/session-planning.js';
import { mergeSessionFindings } from '../dist/session-findings.js';
import {
  CASE_RETRY_LIMIT,
  readCaseRetries,
  retrySessionCases,
} from '../dist/session-retries.js';
import {
  sessionModelContext,
  sessionOutputSchema,
} from '../dist/session-schemas.js';
import { SESSION_ROUND_LIMIT } from '../dist/session-agent.js';
import { candidate, proposal, sessionFixture } from './fixtures/session.mjs';

const planningContext = {
  targetUrl: 'https://fixture.test/',
  allowedOrigins: ['https://fixture.test'],
  protectedOrigins: [],
  remainingCases: 30,
  remainingPages: 30,
  existingCases: [],
  exploredUrls: [],
  sources: [],
};
const mergeEntry = (source, target) => ({
  findingId: source.id,
  sameAs: target.id,
  reason: '同一入口渲染为 404，是同一个问题',
});
const findings = (fixture) =>
  [...fixture.state.findings.values()].map((row) => row.document);
const jobs = (fixture) => [...fixture.state.jobs.values()];

// A: the manager owns fuzzy overlap; the platform keeps deterministic guards.
test('session contracts add optional review/retry fields and duplicateOf without breaking legacy decisions', () => {
  assert.ok(getValidator('SessionDecision')(proposal()));
  const entry = {
    findingId: randomUUID(),
    sameAs: randomUUID(),
    reason: 'same failure',
  };
  const decision = proposal({
    duplicateFindings: [entry],
    retryCaseIds: [randomUUID()],
  });
  assert.ok(getValidator('SessionDecision')(decision));
  assert.equal(
    getValidator('SessionDecision')({ ...decision, retryCaseIds: ['invalid'] }),
    false,
  );
  assert.equal(
    getValidator('SessionDecision')({
      ...decision,
      duplicateFindings: [{ ...entry, reason: '' }],
    }),
    false,
  );
  const schema = sessionOutputSchema('SessionDecision');
  assert.equal(
    schema.properties.duplicateFindings.items.$ref,
    '#/$defs/SessionDuplicateFinding',
  );
  assert.ok(schema.$defs.SessionDuplicateFinding.required.includes('sameAs'));
  assert.ok(schema.properties.retryCaseIds);
  assert.match(SESSION_AGENT_PROMPT, /同一批/);
  assert.match(SESSION_AGENT_PROMPT, /多个验收条件/);
  assert.match(SESSION_AGENT_PROMPT, /duplicateFindings/);
  assert.match(SESSION_AGENT_PROMPT, /retryCaseIds/);
  assert.match(SESSION_AGENT_PROMPT, /requiresLogin=false/);
  assert.match(SESSION_AGENT_PROMPT, /WrongPwd_123/);
  assert.match(SESSION_AGENT_PROMPT, /不能使用真实账号密码/);
});

test('same entry and normalized title are rejected across rounds and leave an explicit record', () => {
  const old = candidate('Dashboard： 404　兜底页！');
  const initial = reviewSessionProposal(
    proposal({ cases: [old] }),
    planningContext,
  );
  const { entryUrl, ...definition } = initial.cases[0];
  const reviewed = reviewSessionProposal(
    proposal({
      cases: [
        candidate(
          'dashboard404兜底页',
          `${entryUrl}?ignored=1#fragment`,
          '换一组验证步骤',
        ),
        candidate('订单审批', 'https://fixture.test/approve', '点击审批'),
      ],
    }),
    {
      ...planningContext,
      existingCases: [
        {
          ...definition,
          outline: [`Navigate ${entryUrl}`, ...definition.outline],
        },
      ],
    },
  );
  assert.equal(reviewed.cases.length, 1);
  assert.equal(reviewed.cases[0].title, '订单审批');
  assert.ok(
    reviewed.coverageGaps.some(
      (gap) =>
        gap.includes('同一入口及规范化标题') &&
        gap.includes('dashboard404兜底页'),
    ),
  );
});

test('SessionAgent persists normalized-title rejection in session.updated while dispatching valid sibling work', async () => {
  const fixture = sessionFixture();
  fixture.addCase('passed', { title: 'Dashboard： 404 页！' });
  await fixture.agent.applyPlan(
    fixture.client,
    fixture.run,
    fixture.manager,
    proposal({
      cases: [
        candidate(
          'dashboard404页',
          'https://fixture.test/orders',
          '换一种验证方式',
        ),
        candidate('订单审批', 'https://fixture.test/approve', '点击审批'),
      ],
    }),
  );
  assert.equal(fixture.state.cases.size, 2);
  assert.equal(fixture.state.enqueued.length, 1);
  const rejection = fixture.state.session.coverageGaps.find((gap) =>
    gap.includes('同一入口及规范化标题'),
  );
  assert.ok(rejection);
  assert.ok(
    fixture.state.events.some(
      (event) =>
        event.type === 'session.updated' &&
        event.payload.coverageGaps.includes(rejection),
    ),
  );
});

test('normalized-title dedup also guards siblings in one batch but is not fuzzy matching', () => {
  const reviewed = reviewSessionProposal(
    proposal({
      cases: [
        candidate('Dashboard — 404', 'https://fixture.test/orders', '检查正文'),
        candidate(
          ' dashboard404！ ',
          'https://fixture.test/orders',
          '检查导航',
        ),
        candidate('dashboard404', 'https://fixture.test/other', '检查其他页'),
        candidate(
          'dashboard 导航缺失',
          'https://fixture.test/orders',
          '验证菜单',
        ),
      ],
    }),
    planningContext,
  );
  assert.equal(reviewed.cases.length, 3);
  assert.equal(
    reviewed.coverageGaps.filter((gap) => gap.includes('重复用例')).length,
    1,
  );
});

test('malformed optional entries are individually ignored, bounded and recorded without rejecting valid work', () => {
  const valid = {
    findingId: randomUUID(),
    sameAs: randomUUID(),
    reason: 'same symptom',
  };
  const caseId = randomUUID();
  const input = proposal({
    cases: [candidate()],
    duplicateFindings: [null, {}, { ...valid, reason: ' ' }, valid],
    retryCaseIds: [null, 12, 'bad', caseId.toUpperCase()],
  });
  const reviewed = reviewSessionProposal(input, planningContext);
  assert.equal(reviewed.cases.length, 1);
  assert.deepEqual(reviewed.duplicateFindings, [valid]);
  assert.deepEqual(reviewed.retryCaseIds, [caseId]);
  assert.equal(
    reviewed.coverageGaps.filter((gap) => gap.includes('已忽略')).length,
    6,
  );
  const bounded = parseSessionDecision(
    proposal({
      duplicateFindings: 'wrong',
      retryCaseIds: Array(31).fill(caseId),
    }),
  );
  assert.equal(bounded.decision.duplicateFindings.length, 0);
  assert.equal(bounded.decision.retryCaseIds.length, 30);
  assert.equal(bounded.notes.length, 2);
});

test('non-dispatch retry requests leave a note and do not prevent an otherwise valid finding review', () => {
  for (const action of ['finish', 'ask']) {
    const reviewed = reviewSessionProposal(
      proposal({
        action,
        question: '请补充有效账号',
        retryCaseIds: [randomUUID()],
      }),
      planningContext,
    );
    assert.deepEqual(reviewed.retryCaseIds, []);
    assert.ok(
      reviewed.coverageGaps.some((gap) =>
        gap.includes('只允许 action=dispatch'),
      ),
    );
  }
});

// B: immutable confirmations survive merges; references are copied, not reassigned.
test('confirmed findings merge case/evidence references, preserve both statuses and emit both updates', async () => {
  const fixture = sessionFixture();
  const root = fixture.addFinding(fixture.addCase('issue_found'), {
    status: 'confirmed',
    reproductionRef: randomUUID(),
    evidenceRefs: Array.from({ length: 30 }, () => randomUUID()),
  });
  const source = fixture.addFinding(fixture.addCase('issue_found'), {
    status: 'confirmed',
    reproductionRef: randomUUID(),
    evidenceRefs: Array.from({ length: 30 }, () => randomUUID()),
  });
  const reproductionEvidence = randomUUID();
  fixture.state.artifacts.set(reproductionEvidence, {
    projectId: fixture.run.projectId,
    runId: fixture.run.id,
  });
  fixture.state.reproductionEvidence.set(source.id, [reproductionEvidence]);
  const notes = await mergeSessionFindings(fixture.client, fixture.run, [
    mergeEntry(source, root),
  ]);
  const retained = fixture.state.findings.get(root.id).document;
  const duplicate = fixture.state.findings.get(source.id).document;
  assert.deepEqual(
    new Set(retained.caseIds),
    new Set([...root.caseIds, ...source.caseIds]),
  );
  assert.equal(
    retained.evidenceRefs.length,
    61,
    'aggregate evidence must not silently truncate at the former 30-ref cap',
  );
  assert.equal(retained.status, 'confirmed');
  assert.equal(retained.reproductionRef, root.reproductionRef);
  assert.equal(duplicate.status, 'confirmed');
  assert.equal(duplicate.reproductionRef, source.reproductionRef);
  assert.equal(duplicate.triageDisposition, 'duplicate');
  assert.equal(duplicate.duplicateOf, root.id);
  assert.equal(retained.version, 2);
  assert.equal(duplicate.version, 2);
  assert.equal(
    fixture.state.events.filter((event) => event.type === 'finding.updated')
      .length,
    2,
  );
  assert.ok(
    fixture.state.references.some(
      (ref) =>
        ref.findingId === root.id &&
        ref.evidenceRefs.includes(reproductionEvidence),
    ),
  );
  assert.ok(notes.some((note) => note.includes('缺陷已合并')));
  assert.ok(getValidator('Finding')({ ...duplicate, duplicateOf: null }));
  assert.equal(
    getValidator('Finding')({ ...duplicate, reproductionRef: null }),
    false,
  );
});

test('illegal merge entries are ignored independently while legal merges and unrelated new work proceed', async () => {
  const fixture = sessionFixture();
  const root = fixture.addFinding(fixture.addCase('issue_found'));
  const source = fixture.addFinding(fixture.addCase('issue_found'));
  const alias = fixture.addFinding(fixture.addCase('issue_found'), {
    triageDisposition: 'duplicate',
    duplicateOf: root.id,
  });
  const foreign = fixture.addFinding(fixture.addCase('issue_found'), {
    runId: randomUUID(),
  });
  await fixture.agent.applyPlan(
    fixture.client,
    fixture.run,
    fixture.manager,
    proposal({
      cases: [
        candidate('审批列表', 'https://fixture.test/approve', '点击审批'),
      ],
      duplicateFindings: [
        mergeEntry(source, foreign),
        mergeEntry(foreign, root),
        mergeEntry(root, root),
        mergeEntry(source, alias),
        mergeEntry(alias, root),
        mergeEntry(source, root),
      ],
    }),
  );
  assert.equal(
    fixture.state.findings.get(source.id).document.duplicateOf,
    root.id,
  );
  assert.equal(fixture.state.findings.get(foreign.id).document.version, 1);
  assert.equal(
    fixture.state.enqueued.filter((job) => job.role === 'executor').length,
    1,
  );
  assert.equal(
    fixture.state.session.coverageGaps.filter((gap) =>
      gap.includes('缺陷合并已忽略'),
    ).length,
    5,
  );
  assert.ok(
    fixture.state.session.coverageGaps.some((gap) =>
      gap.includes('缺陷已合并'),
    ),
  );
  assert.ok(
    fixture.state.events.some((event) => event.type === 'session.updated'),
  );
});

test('a sameAs root cannot be a duplicate or form a cycle; re-merging a root redirects existing aliases', async () => {
  const fixture = sessionFixture();
  const a = fixture.addFinding(fixture.addCase('issue_found'));
  const b = fixture.addFinding(fixture.addCase('issue_found'));
  const c = fixture.addFinding(fixture.addCase('issue_found'));
  const notes = await mergeSessionFindings(fixture.client, fixture.run, [
    mergeEntry(a, b),
    mergeEntry(b, c),
    mergeEntry(c, a),
    mergeEntry(a, c),
  ]);
  assert.equal(fixture.state.findings.get(a.id).document.duplicateOf, c.id);
  assert.equal(fixture.state.findings.get(b.id).document.duplicateOf, c.id);
  assert.equal(
    fixture.state.findings.get(c.id).document.duplicateOf,
    undefined,
  );
  assert.equal(fixture.state.findings.get(c.id).document.caseIds.length, 3);
  assert.equal(notes.filter((note) => note.includes('已忽略')).length, 2);
});

test('foreign evidence and aggregate field limits prevent only the affected merge and leave records untouched', async () => {
  const fixture = sessionFixture();
  const root = fixture.addFinding(fixture.addCase('issue_found'));
  const source = fixture.addFinding(fixture.addCase('issue_found'));
  fixture.state.artifacts.set(source.evidenceRefs[0], {
    projectId: fixture.run.projectId,
    runId: randomUUID(),
  });
  const invalidEvidence = await mergeSessionFindings(
    fixture.client,
    fixture.run,
    [mergeEntry(source, root)],
  );
  assert.match(invalidEvidence[0], /证据不属于本运行/);
  assert.equal(fixture.state.updates.length, 0);
  const largeRoot = fixture.addFinding(fixture.addCase('issue_found'), {
    evidenceRefs: Array.from({ length: 600 }, () => randomUUID()),
  });
  const largeSource = fixture.addFinding(fixture.addCase('issue_found'), {
    evidenceRefs: Array.from({ length: 600 }, () => randomUUID()),
  });
  const invalidSize = await mergeSessionFindings(fixture.client, fixture.run, [
    mergeEntry(largeSource, largeRoot),
  ]);
  assert.match(invalidSize[0], /超出契约限制/);
  assert.equal(fixture.state.findings.get(largeRoot.id).document.version, 1);
  assert.equal(
    fixture.state.findings.get(largeSource.id).document.triageDisposition,
    'open',
  );
});

test('ask applies finding merges and records the decision before releasing the manager into waiting', async () => {
  const fixture = sessionFixture();
  const root = fixture.addFinding(fixture.addCase('issue_found'));
  const source = fixture.addFinding(fixture.addCase('issue_found'));
  const decision = proposal({
    action: 'ask',
    question: '请提供有效账号',
    options: ['账号已修正', '稍后处理'],
    duplicateFindings: [mergeEntry(source, root)],
  });
  const input = await fixture.coordinator.waitForInput(
    { projectId: fixture.run.projectId, workerId: 'fixture-worker' },
    {
      taskId: fixture.manager.id,
      fencingToken: 1,
      leaseToken: 'fixture',
      contextVersion: 1,
    },
    'clarification',
    decision.question,
    300000,
    decision.options,
    decision,
  );
  assert.equal(
    fixture.state.findings.get(source.id).document.duplicateOf,
    root.id,
  );
  assert.equal(fixture.state.session.status, 'reviewing');
  assert.equal(fixture.manager.status, 'waiting');
  assert.deepEqual(input.options, decision.options);
  assert.ok(
    fixture.state.events.findIndex(
      (event) => event.type === 'finding.updated',
    ) <
      fixture.state.events.findIndex(
        (event) => event.type === 'input.requested',
      ),
  );
});

test('a browser child cannot apply a session finding review through an input request', async () => {
  const fixture = sessionFixture();
  const root = fixture.addFinding(fixture.addCase('issue_found'));
  const source = fixture.addFinding(fixture.addCase('issue_found'));
  fixture.manager.role = 'executor';
  fixture.manager.result.stage = 'execute';
  const decision = proposal({
    action: 'ask',
    question: '请补充信息',
    duplicateFindings: [mergeEntry(source, root)],
  });
  await assert.rejects(
    fixture.coordinator.waitForInput(
      { projectId: fixture.run.projectId, workerId: 'fixture-worker' },
      {
        taskId: fixture.manager.id,
        fencingToken: 1,
        leaseToken: 'fixture',
        contextVersion: 1,
      },
      'clarification',
      decision.question,
      300000,
      [],
      decision,
    ),
    (error) => error.code === 'FORBIDDEN',
  );
  assert.equal(fixture.state.updates.length, 0);
  assert.equal(fixture.state.inputs.length, 0);
});

test('sessions review new reports before reproducing and never schedule a merged duplicate', async () => {
  const fixture = sessionFixture();
  const root = fixture.addFinding(fixture.addCase('issue_found'));
  const source = fixture.addFinding(fixture.addCase('issue_found'));
  fixture.manager.status = 'succeeded';
  // The first finding was already reviewed, but a fresh sibling report must
  // still get a merge review before either finding is sent to reproduction.
  fixture.state.session.reviewedTaskIds = [
    fixture.state.findings.get(root.id).original_task_id,
  ];
  assert.equal(
    await fixture.coordinator.enqueueReproductions(
      fixture.client,
      fixture.run,
      jobs(fixture),
      [],
    ),
    0,
  );
  await fixture.agent.advance(fixture.client, fixture.run, jobs(fixture));
  const reviewJob = fixture.state.enqueued.find(
    (job) => job.role === 'coordinator',
  );
  assert.ok(reviewJob);
  assert.equal(
    fixture.state.enqueued.filter((job) => job.role === 'reproducer').length,
    0,
  );
  await fixture.agent.applyPlan(
    fixture.client,
    fixture.run,
    reviewJob,
    proposal({
      action: 'finish',
      duplicateFindings: [mergeEntry(source, root)],
    }),
  );
  reviewJob.status = 'succeeded';
  await fixture.agent.advance(fixture.client, fixture.run, jobs(fixture));
  const reproductions = fixture.state.enqueued.filter(
    (job) => job.role === 'reproducer',
  );
  assert.equal(reproductions.length, 1);
  assert.equal(reproductions[0].result.findingId, root.id);
  assert.equal(fixture.state.budget.reserved.reproductions, 1);
});

test('round-limit fallback still reproduces pending unique findings without an unavailable manager review', async () => {
  const fixture = sessionFixture();
  const root = fixture.addFinding(fixture.addCase('issue_found'));
  fixture.manager.status = 'succeeded';
  fixture.state.session.round = SESSION_ROUND_LIMIT;
  fixture.state.session.reviewedTaskIds = [];
  await fixture.agent.advance(fixture.client, fixture.run, jobs(fixture));
  assert.equal(
    fixture.state.enqueued.filter((job) => job.role === 'coordinator').length,
    0,
  );
  assert.equal(
    fixture.state.enqueued.find((job) => job.role === 'reproducer').result
      .findingId,
    root.id,
  );
  assert.equal(fixture.state.session.planningStopped, true);
});

test('runDTO finding counts exclude confirmed and suspected duplicates while retaining ordinary findings', async () => {
  const fixture = sessionFixture();
  const record = fixture.addCase('issue_found');
  const root = fixture.addFinding(record, {
    status: 'confirmed',
    reproductionRef: randomUUID(),
  });
  fixture.addFinding(record, {
    status: 'confirmed',
    reproductionRef: randomUUID(),
    triageDisposition: 'duplicate',
    duplicateOf: root.id,
  });
  fixture.addFinding(record, {
    triageDisposition: 'duplicate',
    duplicateOf: root.id,
  });
  fixture.addFinding(record, {
    status: 'blocked',
    triageDisposition: 'closed',
  });
  const dto = await runDTO(
    fixture.client,
    fixture.run.projectId,
    fixture.run.id,
  );
  assert.equal(dto.stats.findings, 2);
  assert.equal(
    findings(fixture).length,
    4,
    'aliases remain available for audit and API details',
  );
});

// C: explicit retries use immutable case IDs, new fenced jobs and a hard cap.
for (const outcome of ['blocked', 'inconclusive'])
  test(`retryCaseIds legally redispatches ${outcome} without creating or rewriting a case`, async () => {
    const fixture = sessionFixture();
    const record = fixture.addCase(outcome);
    const oldVerdict = structuredClone(record.verdict);
    const result = await retrySessionCases(
      fixture.client,
      fixture.coordinator,
      fixture.run,
      [record],
      [record.definition.id],
    );
    assert.deepEqual(result.caseIds, [record.definition.id]);
    assert.equal(fixture.state.enqueued.length, 1);
    const job = fixture.state.enqueued[0];
    assert.equal(job.case_id, record.definition.id);
    assert.equal(job.attempt, 2);
    assert.equal(job.document.attempt, 2);
    assert.equal(job.result.stage, 'execute');
    assert.equal(job.result.entryUrl, 'https://fixture.test/orders');
    assert.equal(job.result.previousAttemptId, oldVerdict.attemptId);
    assert.equal(
      job.unique_key,
      taskKey(
        fixture.run.id,
        'executor',
        `execute:${record.definition.id}:v1`,
        2,
        fixture.run.contextVersion,
      ),
    );
    assert.deepEqual(record.verdict, oldVerdict);
    assert.equal(fixture.state.cases.size, 1);
    assert.ok(
      !fixture.state.queries.some(({ sql }) =>
        /UPDATE verdicts|INSERT INTO run_cases/.test(sql),
      ),
    );
  });

for (const outcome of ['passed', 'issue_found', 'not_run'])
  test(`retryCaseIds rejects a latest ${outcome} result with a recorded reason`, async () => {
    const fixture = sessionFixture();
    const record = fixture.addCase(outcome);
    const result = await retrySessionCases(
      fixture.client,
      fixture.coordinator,
      fixture.run,
      [record],
      [record.definition.id],
    );
    assert.deepEqual(result.caseIds, []);
    assert.equal(fixture.state.enqueued.length, 0);
    assert.match(result.notes[0], new RegExp(`最近一次结论为 ${outcome}`));
  });

test('queued/running/waiting executors or reproducers all block a retry', async () => {
  for (const role of ['executor', 'reproducer'])
    for (const status of ['queued', 'running', 'waiting']) {
      const fixture = sessionFixture();
      const record = fixture.addCase('blocked');
      fixture.addJob(record.definition.id, {
        role,
        status,
        stage: role === 'executor' ? 'execute' : 'reproduce',
      });
      const result = await retrySessionCases(
        fixture.client,
        fixture.coordinator,
        fixture.run,
        [record],
        [record.definition.id],
      );
      assert.equal(result.caseIds.length, 0, `${role}/${status}`);
      assert.match(result.notes[0], /仍有排队、运行或等待中的任务/);
      assert.ok(
        fixture.state.queries.some(
          ({ sql }) =>
            sql.includes('SELECT id FROM runs') && sql.includes('FOR UPDATE'),
        ),
      );
      assert.ok(
        !fixture.state.queries.some(
          ({ sql }) =>
            sql.includes('SELECT * FROM jobs') && sql.includes('FOR UPDATE'),
        ),
        'retry must not invert the child-job → run lock order',
      );
    }
});

test('foreign, unknown and repeated retry IDs do not stop a valid sibling retry', async () => {
  const fixture = sessionFixture();
  const record = fixture.addCase('blocked');
  const foreign = fixture.addCase('blocked', { runId: randomUUID() });
  const result = await retrySessionCases(
    fixture.client,
    fixture.coordinator,
    fixture.run,
    [record, foreign],
    [
      foreign.definition.id,
      randomUUID(),
      record.definition.id,
      record.definition.id,
    ],
  );
  assert.deepEqual(result.caseIds, [record.definition.id]);
  assert.equal(
    result.notes.filter((note) => note.includes('已忽略')).length,
    3,
  );
  assert.equal(fixture.state.enqueued.length, 1);
});

test('three retries are allowed and the fourth is rejected even if worker result flags are false', async () => {
  const fixture = sessionFixture();
  const record = fixture.addCase('blocked');
  for (let retry = 1; retry <= CASE_RETRY_LIMIT; retry++) {
    const latest = fixture.currentCase(record.definition);
    const result = await retrySessionCases(
      fixture.client,
      fixture.coordinator,
      fixture.run,
      [latest],
      [record.definition.id],
    );
    assert.deepEqual(result.caseIds, [record.definition.id]);
    const job = fixture.state.enqueued.at(-1);
    assert.equal(job.attempt, retry + 1);
    job.status = 'succeeded';
    job.result.retry = false;
    fixture.addAttempt(record.definition, { job, outcome: 'blocked' });
  }
  const counts = await readCaseRetries(fixture.client, fixture.run);
  assert.deepEqual(counts[record.definition.id], {
    retries: 3,
    lastAttempt: 4,
  });
  const refused = await retrySessionCases(
    fixture.client,
    fixture.coordinator,
    fixture.run,
    [fixture.currentCase(record.definition)],
    [record.definition.id],
  );
  assert.equal(fixture.state.enqueued.length, 3);
  assert.equal(refused.caseIds.length, 0);
  assert.match(refused.notes[0], /3 次重跑上限/);
});

test('technical recovery attempts advance the fence but do not consume user retry allowance', async () => {
  const fixture = sessionFixture();
  const record = fixture.addCase('inconclusive');
  fixture.addJob(record.definition.id, {
    stage: 'recover',
    status: 'succeeded',
    attempt: 7,
  });
  assert.deepEqual(
    (await readCaseRetries(fixture.client, fixture.run))[record.definition.id],
    { retries: 0, lastAttempt: 7 },
  );
  await retrySessionCases(
    fixture.client,
    fixture.coordinator,
    fixture.run,
    [record],
    [record.definition.id],
  );
  assert.equal(fixture.state.enqueued[0].attempt, 8);
  assert.deepEqual(
    (await readCaseRetries(fixture.client, fixture.run))[record.definition.id],
    { retries: 1, lastAttempt: 8 },
  );
});

test('plan-only sessions record rejected retries; retries are not constrained by new-case quota', async () => {
  const fixture = sessionFixture();
  const record = fixture.addCase('blocked');
  fixture.run.effectiveConfig.taskIntent = 'plan';
  const refused = await retrySessionCases(
    fixture.client,
    fixture.coordinator,
    fixture.run,
    [record],
    [record.definition.id],
  );
  assert.match(refused.notes[0], /仅规划/);
  fixture.run.effectiveConfig.taskIntent = 'flow';
  fixture.run.effectiveConfig.budget.maxCases = 1;
  await fixture.agent.applyPlan(
    fixture.client,
    fixture.run,
    fixture.manager,
    proposal({ retryCaseIds: [record.definition.id] }),
  );
  assert.equal(fixture.state.enqueued.length, 1);
  assert.equal(fixture.state.session.caseIds.length, 1);
  assert.equal(fixture.state.session.status, 'working');
  assert.deepEqual(fixture.state.session.history.at(-1).caseIds, [
    record.definition.id,
  ]);
  assert.ok(
    fixture.state.session.coverageGaps.some((gap) =>
      gap.includes('用例已重跑'),
    ),
  );
});

test('retry completion replaces old context/report/statistics; later reproduction never replaces execution outcome', async () => {
  const fixture = sessionFixture();
  const record = fixture.addCase('blocked');
  await fixture.agent.applyPlan(
    fixture.client,
    fixture.run,
    fixture.manager,
    proposal({ retryCaseIds: [record.definition.id] }),
  );
  const job = fixture.state.enqueued[0];
  job.status = 'succeeded';
  const latest = fixture.addAttempt(record.definition, {
    job,
    outcome: 'passed',
    summary: '最新一次登录成功，订单明细可见',
  });
  const reproducer = fixture.addJob(record.definition.id, {
    role: 'reproducer',
    stage: 'reproduce',
    status: 'succeeded',
  });
  fixture.addAttempt(record.definition, {
    job: reproducer,
    outcome: 'blocked',
    summary: '复现受阻，不是执行结论',
  });
  const context = await fixture.agent.context(fixture.client, fixture.run);
  assert.equal(context.cases[0].outcome, 'passed');
  assert.equal(context.cases[0].verdict.id, latest.verdict.id);
  const model = sessionModelContext(context);
  assert.equal(model.cases[0].report.summary, latest.verdict.summary);
  assert.equal(model.cases[0].report.status, 'passed');
  assert.equal(model.cases[0].retryCount, 1);
  assert.equal(model.cases[0].lastAttempt, 2);
  assert.equal(model.caseRetryLimit, 3);
  assert.notEqual(model.cases[0].report.summary, record.verdict.summary);
  const dto = await runDTO(
    fixture.client,
    fixture.run.projectId,
    fixture.run.id,
  );
  assert.equal(dto.stats.passed, 1);
  assert.equal(dto.stats.blocked, 0);
});

test('a new attempt with no valid verdict is inconclusive with a null report, not an old block/pass', async () => {
  for (const invalidated of [false, true]) {
    const fixture = sessionFixture();
    const record = fixture.addCase('blocked');
    await retrySessionCases(
      fixture.client,
      fixture.coordinator,
      fixture.run,
      [record],
      [record.definition.id],
    );
    const job = fixture.state.enqueued[0];
    job.status = 'running';
    fixture.addAttempt(record.definition, {
      job,
      outcome: invalidated ? 'passed' : null,
      valid: !invalidated,
    });
    const context = await fixture.agent.context(fixture.client, fixture.run);
    assert.equal(context.cases[0].outcome, 'inconclusive');
    assert.equal(context.cases[0].verdict, null);
    assert.equal(sessionModelContext(context).cases[0].report, null);
  }
  const migration = readFileSync(
    new URL(
      '../../storage/migrations/035_latest_execution_verdicts.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(migration, /security_invoker=true/);
  assert.match(migration, /newer\.attempt_number>a\.attempt_number/);
  assert.match(migration, /newer_job\.role<>'reproducer'/);
  assert.match(migration, /verdict_invalidations/);
  assert.ok(!/CREATE OR REPLACE FUNCTION guard_confirmation/.test(migration));
});

test('large model context retains finding review fields, retry IDs/counts and latest reports when detail is trimmed', async () => {
  const fixture = sessionFixture();
  let root;
  for (let index = 0; index < 30; index++) {
    const record = fixture.addCase('blocked', {
      title: `case ${index} ${'x'.repeat(170)}`,
      summary: 'x'.repeat(4000),
      preconditions: Array(20).fill('p'.repeat(1000)),
      outline: [
        `Navigate https://fixture.test/orders/${index}`,
        ...Array(29).fill('s'.repeat(1500)),
      ],
      criteria: Array.from({ length: 3 }, (_, n) => ({
        id: `c${n}`,
        kind: 'semantic',
        description: 'd'.repeat(2000),
        sourceKind: 'inferred',
        sourceRef: 'observation:owned',
      })),
    });
    for (let attempt = 2; attempt <= 4; attempt++)
      fixture.addJob(record.definition.id, { attempt });
    const finding = fixture.addFinding(record, {
      title: `finding ${index} ${'x'.repeat(160)}`,
      expected: 'e'.repeat(4000),
      actual: 'a'.repeat(4000),
      ...(index % 2
        ? { triageDisposition: 'duplicate', duplicateOf: root.id }
        : {}),
    });
    root ??= finding;
  }
  const context = await fixture.agent.context(fixture.client, fixture.run);
  const model = sessionModelContext(context);
  assert.equal(model.cases.length, 30);
  assert.equal(model.findings.length, 30);
  for (const c of model.cases) {
    assert.equal(c.retryCount, 3);
    assert.equal(c.lastAttempt, 4);
    assert.equal(c.outcome, 'blocked');
    assert.equal(c.report.status, 'blocked');
    assert.ok(c.entryUrl.startsWith('https://fixture.test/orders/'));
    assert.ok(c.criteria.length);
  }
  for (const finding of model.findings)
    for (const field of [
      'id',
      'title',
      'expected',
      'actual',
      'status',
      'triageDisposition',
      'duplicateOf',
      'caseIds',
    ])
      assert.ok(field in finding, field);
  assert.equal(model.findingCount, 15);
  const summary = sessionModelContext(context, 'summarize');
  assert.equal(summary.findings.length, 15);
  assert.ok(summary.findings.every((f) => f.triageDisposition !== 'duplicate'));
  assert.match(model.contextNote, /经过裁剪/);
});

test('session conclusions do not list duplicate findings as unconfirmed coverage gaps', async () => {
  const fixture = sessionFixture();
  const record = fixture.addCase('passed');
  const root = fixture.addFinding(record, {
    status: 'confirmed',
    reproductionRef: randomUUID(),
  });
  fixture.addFinding(record, {
    title: '被合并的疑似项',
    triageDisposition: 'duplicate',
    duplicateOf: root.id,
  });
  await fixture.agent.conclude(fixture.client, fixture.run, {
    overview: '已完成，重复项已合并',
    caseComments: [],
    coverageGaps: [],
  });
  assert.equal(fixture.state.session.status, 'complete');
  assert.ok(
    !fixture.state.session.coverageGaps.some((gap) =>
      gap.includes('被合并的疑似项'),
    ),
  );
  assert.equal(
    parseContract('SessionReport', fixture.state.session).summary,
    '已完成，重复项已合并',
  );
});
