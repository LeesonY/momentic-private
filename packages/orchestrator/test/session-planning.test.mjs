import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewSessionProposal } from '../dist/session-planning.js';
import { sessionOutputSchema } from '../dist/session-schemas.js';
import { validateBrowserTool } from '@localqa/domain';

const brief = '点击查看明细后，页面应显示订单明细';
const source = { kind: 'user_spec', ref: 'brief:owned', text: brief };
const context = {
  targetUrl: 'https://fixture.test/',
  allowedOrigins: ['https://fixture.test'],
  protectedOrigins: [],
  remainingCases: 2,
  remainingPages: 2,
  sources: [source],
  existingCases: [],
  exploredUrls: [],
};
const candidate = {
  entryUrl: 'https://fixture.test/',
  title: '查看订单明细',
  summary: '检查明细入口',
  preconditions: [],
  outline: ['点击查看明细', '检查订单明细'],
  criteria: [
    {
      id: 'detail.visible',
      kind: 'semantic',
      description: brief,
      sourceKind: 'user_spec',
      sourceRef: source.ref,
      sourceQuote: brief,
      locator: null,
      expectedValue: null,
    },
  ],
};
const decision = {
  action: 'dispatch',
  rationale: '检查有明确预期的流程',
  cases: [candidate],
  exploreTargets: [],
  coverageGaps: [],
};

test('session output declares the real contract even when source-tree copies are absent', () => {
  const schema = sessionOutputSchema('SessionDecision');
  assert.ok(schema.required.includes('rationale'));
  assert.ok(schema.required.includes('coverageGaps'));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.$defs.SessionCriterion.properties.sourceQuote);
});
test('only admitted session browser roles gain interactions; legacy and coordinator permissions stay bounded', () => {
  const click = {
    name: 'click',
    args: {
      target: {
        snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        pageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        nodeId: 'n1',
      },
    },
  };
  assert.throws(() =>
    validateBrowserTool('executor', click, context.allowedOrigins),
  );
  assert.deepEqual(
    validateBrowserTool('executor', click, context.allowedOrigins, [], true),
    click,
  );
  assert.throws(() =>
    validateBrowserTool('coordinator', click, context.allowedOrigins, [], true),
  );
});

test('session planner turns sourced business proposals into executable immutable cases', () => {
  const reviewed = reviewSessionProposal(decision, context);
  assert.equal(reviewed.cases.length, 1);
  assert.equal(reviewed.cases[0].title, candidate.title);
  assert.equal(reviewed.cases[0].criteria[0].sourceKind, 'user_spec');
  assert.equal('sourceQuote' in reviewed.cases[0].criteria[0], false);
});
test('session planner deduplicates the same flow across rounds without weakening criteria', () => {
  const initial = reviewSessionProposal(decision, context);
  const reviewed = reviewSessionProposal(
    { ...decision, cases: [{ ...candidate, title: '同一流程换个标题' }] },
    { ...context, existingCases: initial.cases },
  );
  assert.equal(reviewed.cases.length, 0);
  assert.ok(reviewed.coverageGaps.length);
});
test('session planner refuses invented sources and unauthorized targets', () => {
  for (const invalid of [
    { ...candidate, entryUrl: 'https://foreign.test/' },
    {
      ...candidate,
      criteria: [{ ...candidate.criteria[0], sourceRef: 'invented' }],
    },
    {
      ...candidate,
      criteria: [
        { ...candidate.criteria[0], sourceQuote: '没有给出的业务规则' },
      ],
    },
  ])
    assert.throws(() =>
      reviewSessionProposal({ ...decision, cases: [invalid] }, context),
    );
});
test('session planner cannot disguise a business rule as a generic smoke oracle', () => {
  assert.throws(() =>
    reviewSessionProposal(
      {
        ...decision,
        cases: [
          {
            ...candidate,
            criteria: [
              {
                ...candidate.criteria[0],
                sourceKind: 'generic_smoke',
                sourceRef: 'FR-016',
              },
            ],
          },
        ],
      },
      context,
    ),
  );
});
test('session planner bounds dispatch by remaining budget and rejects a contradictory finish', () => {
  const reviewed = reviewSessionProposal(decision, {
    ...context,
    remainingCases: 0,
  });
  assert.equal(reviewed.cases.length, 0);
  assert.ok(reviewed.coverageGaps.length);
  assert.throws(() =>
    reviewSessionProposal({ ...decision, action: 'finish' }, context),
  );
});
