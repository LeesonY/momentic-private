// Root checks the actual helper used by the saved-case pages.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { findCaseAcrossPages, LifecycleScopeGuard } from '../../apps/web/src/utils/lifecycleScope.ts';
const projectId = 'a1111111-a111-4111-8111-a11111111111';
const caseId = 'b1111111-b111-4111-8111-b11111111111';
const foreignProject = 'c1111111-c111-4111-8111-c11111111111';
const record = { id: caseId, projectId, slug: 'root-scoped-case', name: 'Root scoped case', status: 'archived', currentApprovedVersionId: null, version: 4, createdAt: '2026-10-07T00:00:00.000Z' };
const cases = [];
async function check(name, action) { try { await action(); cases.push({ name, passed: true }); } catch (error) { cases.push({ name, passed: false, message: error.message }); } }
await check('actual finder follows nextCursor and preserves actual archived head', async () => {
  const queries = [];
  const found = await findCaseAcrossPages({ async listSavedCases(pid, query) { queries.push({ pid, ...query }); return query.cursor ? { items: [record], nextCursor: null } : { items: [], nextCursor: 'page-2' }; } }, projectId.toUpperCase(), caseId.toUpperCase());
  assert.deepEqual(found, record);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].status, 'all');
  assert.equal(queries[1].cursor, 'page-2');
});
await check('actual finder rejects foreign-project records even with the requested case id', async () => {
  await assert.rejects(findCaseAcrossPages({ async listSavedCases() { return { items: [{ ...record, projectId: foreignProject }], nextCursor: null }; } }, projectId, caseId));
});
await check('actual finder rejects malformed page contract', async () => {
  await assert.rejects(findCaseAcrossPages({ async listSavedCases() { return { items: [record], nextCursor: null, unexpected: true }; } }, projectId, caseId));
});
await check('actual finder distinguishes exhausted pages from search bounds', async () => {
  const end = await findCaseAcrossPages({ async listSavedCases() { return { items: [], nextCursor: null }; } }, projectId, caseId);
  assert.equal(end, null);
  await assert.rejects(findCaseAcrossPages({ async listSavedCases() { return { items: [], nextCursor: 'more-data' }; } }, projectId, caseId, 1));
});
await check('actual finder rejects a repeated cursor promptly', async () => {
  let requests = 0;
  await assert.rejects(findCaseAcrossPages({ async listSavedCases() { requests++; return { items: [], nextCursor: 'same-cursor' }; } }, projectId, caseId));
  assert.ok(requests <= 3, 'Repeated cursor must not cause twenty unnecessary requests');
});
await check('actual read token is invalid after project switch and unmount', () => {
  const guard = new LifecycleScopeGuard();
  guard.resetScope({ projectId, caseId });
  const old = guard.startRequest({ projectId, caseId });
  guard.resetScope({ projectId: foreignProject, caseId });
  assert.equal(old.isValid(), false);
  const current = guard.startRequest({ projectId: foreignProject, caseId });
  guard.resetScope(null);
  assert.equal(current.isValid(), false);
});
const result = { at: new Date().toISOString(), rootIndependent: true, cases, scope: 'Actual pagination and scope helpers with injected pages/promises; no DOM/hydration, browser or provider', P0Passed: false };
if (process.env.ROOT_RESULT_FILE) writeFileSync(process.env.ROOT_RESULT_FILE, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
if (cases.some(item => !item.passed)) process.exitCode = 1;
