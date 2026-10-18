// The planner may ask to see a page *without* signing in (the login page itself,
// a signed-out guard) while everything else is explored from the signed-in app.
// The two lists stay apart: a page seen signed out does not stop it from being
// explored signed in later, which is the point of the split.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContract } from '@localqa/contracts';
import { reviewSessionProposal } from '../dist/session-planning.js';

const context = (overrides = {}) => ({
  targetUrl: 'https://fixture.test/',
  allowedOrigins: ['https://fixture.test'],
  protectedOrigins: [],
  remainingCases: 1,
  remainingPages: 2,
  sources: [],
  existingCases: [],
  exploredUrls: [],
  signedOutExploredUrls: [],
  ...overrides,
});
const decision = (overrides = {}) => ({
  action: 'dispatch',
  rationale: '先看登录页，再看登录后的首页',
  cases: [],
  exploreTargets: [],
  coverageGaps: [],
  ...overrides,
});

test('a signed-out explore target is accepted next to the signed-in ones', () => {
  const accepted = reviewSessionProposal(
    decision({
      exploreTargets: ['https://fixture.test/home'],
      signedOutExploreTargets: ['https://fixture.test/login'],
    }),
    context(),
  );
  assert.deepEqual(accepted.exploreTargets, ['https://fixture.test/home']);
  assert.deepEqual(accepted.signedOutExploreTargets, [
    'https://fixture.test/login',
  ]);
});

test('the two lists dedupe against their own history, not each other', () => {
  // /login was already seen signed out: asking again is skipped...
  const repeated = reviewSessionProposal(
    decision({ signedOutExploreTargets: ['https://fixture.test/login'] }),
    context({ signedOutExploredUrls: ['https://fixture.test/login'] }),
  );
  assert.deepEqual(repeated.signedOutExploreTargets, []);
  // ...but asking for it signed in afterwards is a different observation.
  const signedIn = reviewSessionProposal(
    decision({ exploreTargets: ['https://fixture.test/login'] }),
    context({ signedOutExploredUrls: ['https://fixture.test/login'] }),
  );
  assert.deepEqual(signedIn.exploreTargets, ['https://fixture.test/login']);
});

test('one URL cannot be both, and the page budget covers both lists', () => {
  const both = reviewSessionProposal(
    decision({ signedOutExploreTargets: ['https://fixture.test/login'] }),
    context({ exploreTargets: [] }),
  );
  assert.deepEqual(both.signedOutExploreTargets, [
    'https://fixture.test/login',
  ]);
  const conflict = reviewSessionProposal(
    decision({
      exploreTargets: ['https://fixture.test/login'],
      signedOutExploreTargets: ['https://fixture.test/login'],
    }),
    context(),
  );
  assert.deepEqual(conflict.exploreTargets, ['https://fixture.test/login']);
  assert.deepEqual(conflict.signedOutExploreTargets, []);
  assert.ok(
    conflict.coverageGaps.some((gap) => gap.includes('未登录探索')),
    JSON.stringify(conflict.coverageGaps),
  );
  const overBudget = reviewSessionProposal(
    decision({
      exploreTargets: ['https://fixture.test/a'],
      signedOutExploreTargets: [
        'https://fixture.test/b',
        'https://fixture.test/c',
      ],
    }),
    context({ remainingPages: 2 }),
  );
  assert.deepEqual(overBudget.signedOutExploreTargets, [
    'https://fixture.test/b',
  ]);
  assert.ok(
    overBudget.coverageGaps.some((gap) => gap.includes('页面预算不足')),
  );
});

test('an out-of-scope signed-out target is refused, not silently explored', () => {
  assert.throws(
    () =>
      reviewSessionProposal(
        decision({ signedOutExploreTargets: ['https://other.test/login'] }),
        context(),
      ),
    (error) => error.code === 'TARGET_NOT_ALLOWED',
  );
});

test('an old decision without the field still validates and explores signed in', () => {
  const parsed = parseContract(
    'SessionDecision',
    decision({ exploreTargets: [] }),
  );
  assert.equal(parsed.signedOutExploreTargets, undefined);
  const accepted = reviewSessionProposal(
    decision({ exploreTargets: ['https://fixture.test/home'] }),
    context(),
  );
  assert.deepEqual(accepted.signedOutExploreTargets, []);
  // Non-dispatch rounds may not smuggle explore requests of either kind.
  for (const action of ['finish', 'ask']) {
    assert.throws(
      () =>
        reviewSessionProposal(
          decision({
            action,
            signedOutExploreTargets: ['https://fixture.test/login'],
            ...(action === 'ask' ? { question: '要继续吗？' } : {}),
          }),
          context(),
        ),
      (error) => error.code === 'VALIDATION_ERROR',
    );
  }
});

test('a malformed signed-out list is dropped with a note, not a failed round', () => {
  const accepted = reviewSessionProposal(
    decision({ signedOutExploreTargets: 'https://fixture.test/login' }),
    context(),
  );
  assert.deepEqual(accepted.signedOutExploreTargets, []);
  assert.ok(
    accepted.coverageGaps.some((gap) =>
      gap.includes('signedOutExploreTargets'),
    ),
  );
});
