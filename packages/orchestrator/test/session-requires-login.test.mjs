import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getValidator } from '@localqa/contracts';
import {
  reviewSessionProposal,
  sessionCaseFingerprint,
} from '../dist/session-planning.js';
import {
  sessionModelContext,
  sessionOutputSchema,
} from '../dist/session-schemas.js';
import { retrySessionCases } from '../dist/session-retries.js';
import { authProfileFixture } from './fixtures/auth-profile.mjs';
import { candidate, proposal, sessionFixture } from './fixtures/session.mjs';

const planningContext = {
  targetUrl: 'https://fixture.test/',
  allowedOrigins: ['https://fixture.test'],
  protectedOrigins: [],
  remainingCases: 30,
  remainingPages: 30,
  sources: [],
  existingCases: [],
  exploredUrls: [],
};

test('requiresLogin is optional boolean in proposals and stored cases, with legacy true semantics', () => {
  const schema = sessionOutputSchema('SessionDecision').$defs.SessionCase;
  assert.equal(schema.properties.requiresLogin.type, 'boolean');
  assert.equal(schema.properties.requiresLogin.default, true);
  assert.equal(schema.required.includes('requiresLogin'), false);
  for (const value of [undefined, true, false]) {
    const c = {
      ...candidate(),
      ...(value === undefined ? {} : { requiresLogin: value }),
    };
    assert.ok(getValidator('SessionDecision')(proposal({ cases: [c] })));
    const accepted = reviewSessionProposal(
      proposal({ cases: [c] }),
      planningContext,
    ).cases[0];
    assert.equal(accepted.requiresLogin, value);
    const { entryUrl: _url, ...candidateDoc } = accepted;
    assert.ok(getValidator('CandidateCase')(candidateDoc));
  }
  for (const value of [null, 0, 1, 'false', '', [], {}])
    assert.equal(
      getValidator('SessionDecision')(
        proposal({ cases: [{ ...candidate(), requiresLogin: value }] }),
      ),
      false,
    );
});

test('planning persists requiresLogin and exposes it in both manager contexts', async () => {
  for (const value of [undefined, true, false]) {
    const fixture = sessionFixture();
    const c = {
      ...candidate(),
      ...(value === undefined ? {} : { requiresLogin: value }),
    };
    await fixture.agent.applyPlan(
      fixture.client,
      fixture.run,
      fixture.manager,
      proposal({ cases: [c] }),
    );
    const definition = [...fixture.state.cases.values()][0];
    assert.equal(definition.requiresLogin, value);
    const context = await fixture.agent.context(fixture.client, fixture.run);
    for (const purpose of ['plan', 'summarize'])
      assert.equal(
        sessionModelContext(context, purpose).cases[0].requiresLogin,
        value !== false,
      );
  }
});

test('signed-out and signed-in cases are distinct, while missing and true remain duplicates', () => {
  const c = candidate();
  const signedOut = { ...c, requiresLogin: false };
  assert.equal(
    sessionCaseFingerprint(c, planningContext.targetUrl),
    sessionCaseFingerprint(
      { ...c, requiresLogin: true },
      planningContext.targetUrl,
    ),
  );
  assert.notEqual(
    sessionCaseFingerprint(c, planningContext.targetUrl),
    sessionCaseFingerprint(signedOut, planningContext.targetUrl),
  );
  const accepted = reviewSessionProposal(
    proposal({ cases: [c, signedOut] }),
    planningContext,
  );
  assert.equal(accepted.cases.length, 2);
  const duplicate = reviewSessionProposal(
    proposal({ cases: [{ ...c, requiresLogin: true }] }),
    { ...planningContext, existingCases: accepted.cases },
  );
  assert.equal(duplicate.cases.length, 0);
});

test('work dispatches signIn only when requiresLogin is not false, and signed-out cases execute withoutSignIn', async () => {
  for (const requiresLogin of [undefined, true, false]) {
    const fixture = authProfileFixture();
    const definition = fixture.state.cases.get(fixture.task.case_id);
    if (requiresLogin !== undefined) definition.requiresLogin = requiresLogin;
    const work = await fixture.coordinator.work(fixture.scope, fixture.proof);
    if (requiresLogin === false) {
      assert.equal(work.signIn, undefined);
      assert.equal(work.withoutSignIn, true);
      assert.equal(work.authStateId, null);
      await assert.rejects(
        fixture.coordinator.allocateAuthSession(fixture.scope, fixture.proof),
        (e) => e?.code === 'POLICY_DENIED',
      );
      const grant = await fixture.coordinator.grantAction(
        fixture.scope,
        fixture.proof,
        { name: 'observe', args: {} },
      );
      assert.equal(grant.call.name, 'observe');
      assert.equal(fixture.auth.sessions.size, 0);
    } else {
      assert.equal(work.signIn, true);
      assert.equal(work.withoutSignIn, undefined);
      assert.equal(work.authStateId, null);
    }
  }
});

test('retried cases and reproductions keep the original requiresLogin setting', async () => {
  const fixture = authProfileFixture();
  const definition = fixture.state.cases.get(fixture.task.case_id);
  definition.requiresLogin = false;
  fixture.addAttempt(definition, { job: fixture.task, outcome: 'blocked' });
  fixture.task.status = 'succeeded';
  const retries = await retrySessionCases(
    fixture.client,
    fixture.coordinator,
    fixture.run,
    [fixture.currentCase(definition)],
    [definition.id],
  );
  assert.deepEqual(retries.caseIds, [definition.id]);
  const retryTask = fixture.state.enqueued[0];
  retryTask.status = 'running';
  fixture.bindTask(retryTask);
  const retryWork = await fixture.coordinator.work(
    fixture.scope,
    fixture.proof,
  );
  assert.equal(retryWork.signIn, undefined);
  assert.equal(retryWork.withoutSignIn, true);

  const reproducer = fixture.addJob(definition.id, {
    role: 'reproducer',
    stage: 'reproduce',
    status: 'running',
  });
  fixture.bindTask(reproducer);
  const reproWork = await fixture.coordinator.work(
    fixture.scope,
    fixture.proof,
  );
  assert.equal(reproWork.signIn, undefined);
  assert.equal(reproWork.withoutSignIn, true);
});
