// Root checks actual UI helpers; injected pages and promises, no browser/network.
import assert from 'node:assert/strict';
import { resolveLatestModuleVersion, fetchModulePage, fetchModuleVersionPage, mergeModuleRecords, RequestScopeGuard } from '../../apps/web/src/utils/modulePagination.ts';
import { validateModuleReviewPreview } from '../../apps/web/src/utils/moduleRoles.ts';
const projectId = 'a1111111-a111-4111-8111-a11111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const document = { schemaVersion: 1, kind: 'localqa/test', id: 'root-scope', name: 'Root scope', criteria: [{ id: 'ok', kind: 'http_status', description: 'Status', sourceKind: 'user_spec', sourceRef: 'root', expectedValue: 200 }], steps: [{ kind: 'assert', criterionId: 'ok' }] };
const target = { projectId, name: 'same-name', version: 1, document, sha256: 'a'.repeat(64), reviewStatus: 'draft', createdBy: null, createdAt: null, reviewedBy: null, reviewedAt: null };
const foreign = { ...target, projectId: otherId, version: 99, document: { ...document, name: 'foreign document' } };
const cases = [];
async function check(name, action) {
  try { await action(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, message: error.message }); }
}
await check('latest version and document remain in target project/module', () => {
  const local = { ...target, projectId: projectId.toUpperCase(), version: 2, document: { ...document, name: 'local v2' } };
  const result = resolveLatestModuleVersion(target, [foreign, local], [{ ...target, name: 'another-module', version: 100 }]);
  assert.equal(result.latestVersion, 2);
  assert.equal(result.latestDocument, local.document);
});
await check('actual project page rejects foreign project records', async () => {
  await assert.rejects(fetchModulePage({ async listRegressionModules() { return { items: [foreign], nextCursor: null }; } }, projectId));
});
await check('history page rejects foreign project and foreign module records', async () => {
  for (const record of [foreign, { ...target, name: 'other-module' }])
    await assert.rejects(fetchModuleVersionPage({ async listRegressionModuleVersions() { return { items: [record], nextCursor: null }; } }, projectId, target.name));
});
await check('canonical project casing is accepted and bad page shape rejected', async () => {
  const page = await fetchModulePage({ async listRegressionModules() { return { items: [{ ...target, projectId: projectId.toUpperCase() }], nextCursor: null }; } }, projectId);
  assert.equal(page.items.length, 1);
  await assert.rejects(fetchModulePage({ async listRegressionModules() { return { items: [target], nextCursor: null, unknown: true }; } }, projectId));
});
await check('merge identity includes project and canonical UUID casing', () => {
  const result = mergeModuleRecords([target], [{ ...target, projectId: projectId.toUpperCase() }, { ...foreign, version: 1 }]);
  assert.equal(result.length, 2);
});
await check('actual guard rejects delayed previous-project response and finally', async () => {
  const guard = new RequestScopeGuard();
  let finishA, finishB, state = 'initial', finalizations = 0;
  const pendingA = new Promise(resolve => { finishA = resolve; });
  const tokenA = guard.startRequest({ projectId });
  const resultA = pendingA.then(() => { if (tokenA.isValid()) state = 'A'; }).finally(() => { if (tokenA.isValid()) finalizations++; });
  guard.resetScope({ projectId: otherId });
  const pendingB = new Promise(resolve => { finishB = resolve; });
  const tokenB = guard.startRequest({ projectId: otherId });
  const resultB = pendingB.then(() => { if (tokenB.isValid()) state = 'B'; }).finally(() => { if (tokenB.isValid()) finalizations++; });
  finishB(); await resultB; finishA(); await resultA;
  assert.equal(state, 'B'); assert.equal(finalizations, 1);
});
await check('history selection or close invalidates previous request', () => {
  const guard = new RequestScopeGuard();
  const old = guard.startRequest({ projectId, moduleName: 'old' });
  const current = guard.startRequest({ projectId, moduleName: 'new' });
  assert.equal(old.isValid(), false); assert.equal(current.isValid(), true);
  guard.resetScope(null); assert.equal(current.isValid(), false);
});
await check('preview validates canonical contract and exact reason', () => {
  const expected = { projectId, moduleName: target.name, version: 1, documentSha256: target.sha256, expectedVersion: 1, decision: 'approve', reason: 'exact' };
  const preview = { ...expected, diff: 'draft', risks: [], confirmationToken: 'synthetic-token', expiresAt: new Date(Date.now() + 300000).toISOString() };
  assert.equal(validateModuleReviewPreview(preview, expected).valid, true);
  assert.equal(validateModuleReviewPreview({ ...preview, reason: ' exact ' }, expected).valid, false);
  assert.equal(validateModuleReviewPreview({ ...preview, extra: true }, expected).valid, false);
});
console.log(JSON.stringify({ rootIndependent: true, cases, scope: 'Actual helpers used by ModulesPage, injected pages/promises; no browser/network or DOM hydration', P0Passed: false }, null, 2));
if (cases.some(item => !item.passed)) process.exitCode = 1;
