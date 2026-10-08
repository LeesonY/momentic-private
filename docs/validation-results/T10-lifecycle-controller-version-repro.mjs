import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fetchSavedCaseVersionsAcrossPages } from '../../apps/web/src/utils/savedCaseVersionPagination.ts';
const caseId = 'a1111111-a111-4111-8111-a11111111111';
const document = { schemaVersion: 1, kind: 'localqa/test', id: 'root-paged-version', name: 'Root paged version', criteria: [{ id: 'ok', kind: 'http_status', description: 'HTTP status', sourceKind: 'user_spec', sourceRef: 'root', expectedValue: 200 }], steps: [{ kind: 'assert', criterionId: 'ok' }] };
const base = { id: 'b1111111-b111-4111-8111-b11111111111', caseId, version: 1, document, sha256: 'a'.repeat(64), reviewStatus: 'draft', createdBy: 'c1111111-c111-4111-8111-c11111111111', createdAt: '2026-10-07T00:00:00.000Z', reviewedBy: null, reviewedAt: null };
const approved = { ...base, id: 'b2222222-b222-4222-8222-b22222222222', version: 101, reviewStatus: 'approved', reviewedBy: base.createdBy, reviewedAt: base.createdAt };
const cases = [];
async function check(name, action) { try { await action(); cases.push({ name, passed: true }); } catch (error) { cases.push({ name, passed: false, message: error.message }); } }
await check('actual helper finds approved metadata on the later page without inventing v1', async () => {
  const queries = [];
  const records = await fetchSavedCaseVersionsAcrossPages({ async listSavedCaseVersions(id, query) { queries.push({ id, ...query }); return query.cursor ? { items: [approved], nextCursor: null } : { items: [base], nextCursor: 'later' }; } }, caseId.toUpperCase());
  assert.equal(queries.length, 2);
  assert.equal(queries[0].limit, 100);
  assert.equal(queries[1].cursor, 'later');
  assert.equal(records.find(item => item.id === approved.id).version, 101);
  assert.equal(records[0].sha256, base.sha256); // Keep stored digest, do not recompute history.
});
await check('actual helper rejects foreign-case and malformed page data', async () => {
  for (const body of [{ items: [{ ...base, caseId: 'd1111111-d111-4111-8111-d11111111111' }], nextCursor: null }, { items: [base], nextCursor: null, extra: true }])
    await assert.rejects(fetchSavedCaseVersionsAcrossPages({ async listSavedCaseVersions() { return body; } }, caseId));
});
await check('duplicate UUID casing is deduplicated when canonical content agrees', async () => {
  const upper = { ...base, id: base.id.toUpperCase(), caseId: caseId.toUpperCase(), createdBy: base.createdBy.toUpperCase() };
  const records = await fetchSavedCaseVersionsAcrossPages({ async listSavedCaseVersions(_id, query) { return query.cursor ? { items: [upper, approved], nextCursor: null } : { items: [base], nextCursor: 'later' }; } }, caseId);
  assert.equal(records.length, 2);
});
await check('same version identity with conflicting document is rejected', async () => {
  await assert.rejects(fetchSavedCaseVersionsAcrossPages({ async listSavedCaseVersions(_id, query) { return query.cursor ? { items: [{ ...base, document: { ...document, name: 'changed' } }], nextCursor: null } : { items: [base], nextCursor: 'later' }; } }, caseId), error => error.code === 'CONTENT_CONFLICT');
});
await check('repeated cursor is rejected promptly', async () => {
  let count = 0;
  await assert.rejects(fetchSavedCaseVersionsAcrossPages({ async listSavedCaseVersions() { count++; return { items: [], nextCursor: 'same' }; } }, caseId), error => error.code === 'REPEATED_CURSOR');
  assert.ok(count <= 3);
});
await check('search cap is distinct from genuine exhausted empty history', async () => {
  await assert.rejects(fetchSavedCaseVersionsAcrossPages({ async listSavedCaseVersions() { return { items: [], nextCursor: 'more' }; } }, caseId, 1), error => error.code === 'SEARCH_LIMIT');
  assert.deepEqual(await fetchSavedCaseVersionsAcrossPages({ async listSavedCaseVersions() { return { items: [], nextCursor: null }; } }, caseId), []);
});
const result = { at: new Date().toISOString(), rootIndependent: true, cases, scope: 'Actual version-page helper, injected canonical pages; no browser/PG/provider', P0Passed: false };
if (process.env.ROOT_RESULT_FILE) writeFileSync(process.env.ROOT_RESULT_FILE, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
if (cases.some(item => !item.passed)) process.exitCode = 1;
