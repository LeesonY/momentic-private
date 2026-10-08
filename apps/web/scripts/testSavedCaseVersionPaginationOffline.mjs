import assert from 'node:assert/strict';
import { fetchSavedCaseVersionsAcrossPages } from '../src/utils/savedCaseVersionPagination.ts';

const caseId = 'b1111111-b111-4111-8111-b11111111111';
const foreignCase = 'c1111111-c111-4111-8111-c11111111111';
const versionA = 'd1111111-d111-4111-8111-d11111111111';
const versionB = 'e1111111-e111-4111-8111-e11111111111';
const userId = 'f1111111-f111-4111-8111-f11111111111';
const reviewerId = 'a1111111-a111-4111-8111-a11111111111';
const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const document = {
  schemaVersion: 1,
  kind: 'localqa/test',
  id: 'saved-version',
  name: 'Saved version',
  criteria: [
    {
      id: 'main.visible',
      kind: 'element_visible',
      description: 'Main content is visible',
      sourceKind: 'saved_case',
      sourceRef: 'saved-version',
      locator: { by: 'role', value: 'main' },
    },
  ],
  steps: [{ kind: 'assert', criterionId: 'main.visible' }],
};

function version(overrides) {
  return {
    id: versionA,
    caseId,
    version: 1,
    document,
    sha256: shaA,
    reviewStatus: 'draft',
    createdBy: userId,
    createdAt: '2026-10-07T00:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
    ...overrides,
  };
}

const approved = version({
  id: versionB,
  version: 2,
  sha256: shaB,
  reviewStatus: 'approved',
  reviewedBy: reviewerId,
  reviewedAt: '2026-10-07T01:00:00.000Z',
});

function check(name, action) {
  return Promise.resolve()
    .then(action)
    .then(() => ({ name, passed: true }))
    .catch((error) => ({ name, passed: false, message: error.message }));
}

const cases = [];
cases.push(
  await check(
    'later page approved version is preserved and uppercase case matches',
    async () => {
      const queries = [];
      const found = await fetchSavedCaseVersionsAcrossPages(
        {
          async listSavedCaseVersions(id, query) {
            queries.push({ id, ...query });
            if (!query.cursor)
              return { items: [version()], nextCursor: 'page-2' };
            return {
              items: [{ ...approved, caseId: caseId.toUpperCase() }],
              nextCursor: null,
            };
          },
        },
        caseId.toUpperCase(),
      );
      assert.equal(queries.length, 2);
      assert.equal(queries[0].limit, 100);
      assert.equal(queries[1].cursor, 'page-2');
      assert.equal(found.length, 2);
      assert.equal(found[1].reviewStatus, 'approved');
      assert.equal(found[1].sha256, shaB);
      assert.equal(found[1].version, 2);
      assert.equal(found[1].reviewedBy, reviewerId);
      assert.deepEqual(found[0].document, document);
    },
  ),
);
cases.push(
  await check('pages aggregate and canonical version ids dedup', async () => {
    const found = await fetchSavedCaseVersionsAcrossPages(
      {
        async listSavedCaseVersions(_id, query) {
          if (!query.cursor) {
            return { items: [version()], nextCursor: 'page-2' };
          }
          return {
            items: [version({ id: versionA.toUpperCase() }), approved],
            nextCursor: null,
          };
        },
      },
      caseId,
    );
    assert.deepEqual(
      found.map((item) => item.id.toLowerCase()),
      [versionA, versionB],
    );
    assert.equal(found[0].sha256, shaA);
    assert.equal(found[1].reviewStatus, 'approved');
  }),
);
cases.push(
  await check(
    'foreign case, unknown schema, cursor loop, and page cap throw',
    async () => {
      await assert.rejects(
        fetchSavedCaseVersionsAcrossPages(
          {
            async listSavedCaseVersions() {
              return {
                items: [version({ caseId: foreignCase })],
                nextCursor: null,
              };
            },
          },
          caseId,
        ),
        (error) => error.code === 'CASE_MISMATCH',
      );
      await assert.rejects(
        fetchSavedCaseVersionsAcrossPages(
          {
            async listSavedCaseVersions() {
              return { items: [version()], nextCursor: null, unexpected: true };
            },
          },
          caseId,
        ),
      );
      let requests = 0;
      await assert.rejects(
        fetchSavedCaseVersionsAcrossPages(
          {
            async listSavedCaseVersions() {
              requests += 1;
              return { items: [], nextCursor: 'same-cursor' };
            },
          },
          caseId,
        ),
        (error) => error.code === 'REPEATED_CURSOR',
      );
      assert.equal(requests, 2);
      await assert.rejects(
        fetchSavedCaseVersionsAcrossPages(
          {
            async listSavedCaseVersions() {
              return { items: [version()], nextCursor: 'more' };
            },
          },
          caseId,
          1,
        ),
        (error) => error.code === 'SEARCH_LIMIT',
      );
      await assert.rejects(
        fetchSavedCaseVersionsAcrossPages(
          {
            async listSavedCaseVersions(_id, query) {
              if (!query.cursor)
                return { items: [version()], nextCursor: 'page-2' };
              return {
                items: [version({ id: versionA.toUpperCase(), sha256: shaB })],
                nextCursor: null,
              };
            },
          },
          caseId,
        ),
        (error) => error.code === 'CONTENT_CONFLICT',
      );
    },
  ),
);

const failed = cases.filter((item) => !item.passed);
console.log(JSON.stringify({ cases, P0Passed: false }, null, 2));
if (failed.length) process.exitCode = 1;
