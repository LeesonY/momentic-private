import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContract } from '@localqa/contracts';
import { Router } from '../dist/router.js';
import { registerRepairProposalRoutes } from '../dist/routes/repairProposals.js';

// HTTP-handler and wire-contract test with explicit in-memory SQL stubs.
// It is NOT the PostgreSQL/RLS integration test, which needs a running PG 18.
const ids = {
  alpha: '00000000-0000-4000-8000-000000000001',
  beta: '00000000-0000-4000-8000-000000000002',
  caseA: '00000000-0000-4000-8000-000000000003',
  caseB: '00000000-0000-4000-8000-000000000004',
  sourceA: '00000000-0000-4000-8000-000000000005',
  run: '00000000-0000-4000-8000-000000000006',
  task: '00000000-0000-4000-8000-000000000007',
  screenshot: '00000000-0000-4000-8000-000000000008',
  page: '00000000-0000-4000-8000-000000000009',
};
const suggestion = {
  kind: 'locator_name_variation',
  source: { documentId: ids.sourceA, stepIndex: 2, modulePath: [] },
  original: { by: 'role', value: 'button', name: 'Complete Order' },
  proposed: { by: 'role', value: 'button', name: 'COMPLETE ORDER' },
  reasonCode: 'LOCATOR_NOT_FOUND',
  snapshotId: ids.screenshot,
  pageId: ids.page,
  observedOrigin: 'https://fixture.test',
  reviewRequired: true,
  verification: 'not_run',
};
const router = new Router();
registerRepairProposalRoutes(router);
const handler = router.match(
  'GET',
  `/api/v1/saved-cases/${ids.caseA}/repair-proposals`,
).handler;

function fixture({ role = 'viewer', scenario = 'valid' } = {}) {
  const sqlCalls = [];
  const client = {
    async query(sql, values = []) {
      sqlCalls.push({ sql, values });
      if (sql.includes('FROM saved_cases WHERE id=$1')) {
        if (values[0] === ids.caseA && role !== 'outsider')
          return {
            rows: [{ id: ids.caseA, project_id: ids.alpha, status: 'active' }],
          };
        return { rows: [] };
      }
      if (sql.includes('FROM projects WHERE id=$1'))
        return { rows: [{ role }] };
      if (sql.includes('FROM repair_proposals')) return { rows: [] };
      if (sql.includes('FROM jobs j')) {
        // Every candidate must be backed by the immutable DB regression
        // binding, not just result JSON whose sourceVersionId may be forged.
        assert.match(sql, /JOIN run_case_regression_bindings b/);
        assert.match(sql, /b\.project_id=j\.project_id/);
        assert.match(sql, /b\.run_id=j\.run_id AND b\.case_id=j\.case_id/);
        assert.match(
          sql,
          /b\.source_sha256=j\.result->>'sourceDocumentSha256'/,
        );
        assert.match(
          sql,
          /v\.id=b\.source_version_id AND v\.sha256=b\.source_sha256/,
        );
        assert.match(sql, /v\.review_status='approved'/);
        assert.match(sql, /j\.role='executor'/);
        assert.match(sql, /j\.result->'regressionReplay'->>'status'='failed'/);
        assert.match(
          sql,
          /j\.result->'regressionReplay'->>'reasonCode'='LOCATOR_NOT_FOUND'/,
        );
        assert.deepEqual(values, [ids.alpha, ids.caseA]);
        if (scenario === 'no-binding' || scenario === 'foreign-source')
          return { rows: [] };
        return {
          rows: [
            {
              id: ids.task,
              run_id: ids.run,
              source_version_id: ids.sourceA,
              hints: [
                scenario === 'malformed'
                  ? { ...suggestion, reviewRequired: false }
                  : suggestion,
              ],
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const ctx = {
    params: { caseId: ids.caseA },
    query: { limit: '20' },
    method: 'GET',
    headers: { cookie: 'session=test-fixture-cookie' },
    res: { statusCode: 200 },
    api: {
      accountsRepo: {
        authenticate: async () => ({ id: ids.run, globalRole: 'member' }),
      },
      db: { actor: async (_actor, callback) => callback(client) },
    },
    actor: null,
    user: null,
  };
  return { ctx, sqlCalls };
}

test('approved and case-bound failed locator is readable as an inert suggestion by a viewer', async () => {
  const { ctx, sqlCalls } = fixture();
  const output = parseContract('RepairProposalPage', await handler(ctx));
  assert.equal(ctx.res.statusCode, 200);
  assert.deepEqual(output.items, []);
  assert.equal(output.repairSuggestions.length, 1);
  assert.equal(output.repairSuggestions[0].sourceVersionId, ids.sourceA);
  assert.equal(output.repairSuggestions[0].suggestion.verification, 'not_run');
  assert.equal(output.repairSuggestions[0].suggestion.reviewRequired, true);
  assert.ok(sqlCalls.some((call) => call.sql.includes('FROM jobs j')));
});

test('foreign project reader cannot infer the saved case or its suggestions', async () => {
  const { ctx, sqlCalls } = fixture({ role: 'outsider' });
  await assert.rejects(handler(ctx), (error) => error.code === 'NOT_FOUND');
  assert.equal(
    sqlCalls.some((call) => call.sql.includes('FROM jobs j')),
    false,
  );
});

test('missing authoritative binding or foreign source has no suggestion', async () => {
  for (const scenario of ['no-binding', 'foreign-source']) {
    const { ctx } = fixture({ scenario });
    const result = await handler(ctx);
    assert.deepEqual(result.repairSuggestions, []);
  }
});

test('malformed result JSON fails closed instead of being serialized into API response', async () => {
  const { ctx } = fixture({ scenario: 'malformed' });
  const result = await handler(ctx);
  assert.deepEqual(result.repairSuggestions, []);
});
