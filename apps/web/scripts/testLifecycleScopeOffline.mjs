import assert from 'node:assert/strict';
import {
  LifecycleScopeGuard,
  findCaseAcrossPages,
} from '../src/utils/lifecycleScope.ts';

const projectId = 'a1111111-a111-4111-8111-a11111111111';
const caseId = 'b1111111-b111-4111-8111-b11111111111';
const otherProject = 'c1111111-c111-4111-8111-c11111111111';
const targetProjectId = 'd1111111-d111-4111-8111-d11111111111';

const scope = { projectId, caseId, statusFilter: 'all', targetProjectId };

function check(name, action) {
  return Promise.resolve()
    .then(action)
    .then(() => ({ name, passed: true }))
    .catch((error) => ({ name, passed: false, message: error.message }));
}

const cases = [];
cases.push(
  await check('capture stays valid across a same-scope read refresh', () => {
    const guard = new LifecycleScopeGuard();
    guard.resetScope(scope);
    const mutation = guard.captureScope({
      projectId: projectId.toUpperCase(),
      caseId: caseId.toUpperCase(),
      statusFilter: 'all',
      targetProjectId: targetProjectId.toUpperCase(),
    });
    const firstRead = guard.startRequest(scope);
    const secondRead = guard.startRequest(scope);
    assert.equal(firstRead.isValid(), false);
    assert.equal(secondRead.isValid(), true);
    assert.equal(mutation.isValid(), true);
    assert.deepEqual(guard.getCurrentScope(), scope);
  }),
);
cases.push(
  await check('two captured mutations do not invalidate each other', () => {
    const guard = new LifecycleScopeGuard();
    guard.resetScope(scope);
    const first = guard.captureScope(scope);
    const second = guard.captureScope({ ...scope });
    guard.startRequest(scope);
    assert.equal(first.isValid(), true);
    assert.equal(second.isValid(), true);
    second.isValid();
    assert.equal(first.isValid(), true);
  }),
);
cases.push(
  await check(
    'reset and a previous scope invalidate captures and reads',
    () => {
      const guard = new LifecycleScopeGuard();
      guard.resetScope(scope);
      const read = guard.startRequest(scope);
      const mutation = guard.captureScope(scope);
      const stale = { projectId: otherProject, caseId, statusFilter: 'all' };
      guard.startRequest(stale);
      assert.deepEqual(guard.getCurrentScope(), scope);
      assert.equal(read.isValid(), true);
      assert.equal(mutation.isValid(), true);
      guard.resetScope({
        projectId: otherProject,
        caseId,
        statusFilter: 'all',
      });
      assert.equal(read.isValid(), false);
      assert.equal(mutation.isValid(), false);
      assert.equal(guard.captureScope(scope).isValid(), false);
      guard.resetScope(null);
      assert.equal(guard.getCurrentScope(), null);
      assert.equal(guard.startRequest(scope).isValid(), false);
    },
  ),
);
cases.push(
  await check(
    'optional scope fields do not match when one side omits them',
    () => {
      const guard = new LifecycleScopeGuard();
      guard.resetScope({ projectId, statusFilter: 'archived' });
      assert.equal(
        guard
          .captureScope({ projectId, caseId, statusFilter: 'archived' })
          .isValid(),
        false,
      );
      assert.equal(guard.startRequest({ projectId }).isValid(), false);
      assert.equal(
        guard.startRequest({ projectId, statusFilter: 'archived' }).isValid(),
        true,
      );
    },
  ),
);
cases.push(
  await check(
    'finder reports search limit and repeated cursor without inventing a case',
    async () => {
      const record = {
        id: caseId,
        projectId,
        slug: 'kept',
        name: 'Kept',
        status: 'archived',
        currentApprovedVersionId: null,
        version: 4,
        createdAt: '2026-10-07T00:00:00.000Z',
      };
      await assert.rejects(
        findCaseAcrossPages(
          {
            async listSavedCases() {
              return { items: [], nextCursor: 'more' };
            },
          },
          projectId,
          caseId,
          1,
        ),
        (error) => error.code === 'SEARCH_LIMIT',
      );
      let requests = 0;
      await assert.rejects(
        findCaseAcrossPages(
          {
            async listSavedCases() {
              requests += 1;
              return { items: [], nextCursor: 'same-cursor' };
            },
          },
          projectId,
          caseId,
        ),
        (error) => error.code === 'REPEATED_CURSOR',
      );
      assert.equal(requests, 2);
      const found = await findCaseAcrossPages(
        {
          async listSavedCases(_pid, query) {
            return query.cursor
              ? { items: [record], nextCursor: null }
              : { items: [], nextCursor: 'page-2' };
          },
        },
        projectId,
        caseId,
      );
      assert.equal(found.status, 'archived');
      assert.equal(found.version, 4);
      assert.equal(found.currentApprovedVersionId, null);
    },
  ),
);

const failed = cases.filter((item) => !item.passed);
console.log(JSON.stringify({ cases, P0Passed: false }, null, 2));
if (failed.length) process.exitCode = 1;
