// Root calls actual client and Mock methods; injected HTTP only, no browser.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { MockApiClient } from '../../apps/web/src/mocks/mockClient.ts';
import { HttpApiClient } from '../../apps/web/src/api/client.ts';
import { validateContract } from '../../packages/contracts/dist/index.js';
const cases = [];
async function check(name, action) {
  try { await action(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, message: error.message }); }
}
const mock = new MockApiClient();
const project = (await mock.listProjects()).items[0];
const source = (await mock.listSavedCases(project.id, { status: 'all' })).items[0];
const version = (await mock.listSavedCaseVersions(source.id)).items[0];
const fetchBefore = globalThis.fetch;
const client = new HttpApiClient('https://synthetic.invalid/api/v1');
const synthetic = { ...source, status: 'archived', version: 2 };
await check('archive response must increment entity version exactly once', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(synthetic), { status: 200 });
  await assert.rejects(client.archiveSavedCase(source.id, { expectedVersion: 2 }));
});
await check('restore response must increment entity version exactly once', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ...synthetic, status: 'active' }), { status: 200 });
  await assert.rejects(client.restoreSavedCase(source.id, { expectedVersion: 2 }));
});
await check('duplicate response starts at entity version one', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ...synthetic, id: '99999999-9999-4999-8999-999999999999', status: 'active', currentApprovedVersionId: null, slug: 'root-copy', name: 'Root copy', version: 8 }), { status: 201 });
  await assert.rejects(client.duplicateSavedCase(source.id, { sourceVersionId: version.id, targetProjectId: project.id, newSlug: 'root-copy', newName: 'Root copy' }));
});
await check('list response rejects records belonging to another project', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [{ ...source, projectId: '99999999-9999-4999-8999-999999999999' }], nextCursor: null }), { status: 200 });
  await assert.rejects(client.listSavedCases(project.id, { status: 'all' }));
});
globalThis.fetch = fetchBefore;
await check('Mock list honors limit and successive cursor', async () => {
  const first = await mock.listSavedCases(project.id, { status: 'all', limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await mock.listSavedCases(project.id, { status: 'all', limit: 1, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].id, second.items[0].id);
});
await check('Mock repeated archive reports VERSION_CONFLICT 409', async () => {
  const fresh = new MockApiClient();
  const archived = (await fresh.listSavedCases(project.id, { status: 'archived' })).items[0];
  await assert.rejects(fresh.archiveSavedCase(archived.id, { expectedVersion: archived.version }), error => error.status === 409 || error.statusCode === 409);
});
await check('Mock PG integer overflow is rejected before mutation', async () => {
  const fresh = new MockApiClient();
  const record = fresh.savedCases.find(item => item.status === 'active');
  record.version = 2147483647; // Owned synthetic fixture only.
  await assert.rejects(fresh.archiveSavedCase(record.id, { expectedVersion: record.version }), error => error.status === 422 || error.statusCode === 422);
  assert.equal(record.version, 2147483647);
  assert.equal(record.status, 'active');
});
await check('Mock UUID identity is case insensitive', async () => {
  const fresh = new MockApiClient();
  const original = (await fresh.listSavedCases(project.id, { status: 'all' })).items[0];
  const oldId = original.id;
  original.id = 'ab111111-ab11-4111-8111-ab1111111111';
  fresh.savedCaseVersions[original.id] = fresh.savedCaseVersions[oldId].map(item => ({ ...item, caseId: original.id }));
  const input = { expectedVersion: original.version };
  const updated = original.status === 'active'
    ? await fresh.archiveSavedCase(original.id.toUpperCase(), input)
    : await fresh.restoreSavedCase(original.id.toUpperCase(), input);
  assert.ok(validateContract('SavedCase', updated).success);
});
await check('Mock explicit source version UUID is case insensitive', async () => {
  const fresh = new MockApiClient();
  const selected = fresh.savedCases.find(item => item.status === 'active');
  const selectedVersion = fresh.savedCaseVersions[selected.id][0];
  selectedVersion.id = 'ab222222-ab22-4222-8222-ab2222222222';
  const copied = await fresh.duplicateSavedCase(selected.id, { sourceVersionId: selectedVersion.id.toUpperCase(), targetProjectId: project.id.toUpperCase(), newSlug: 'root-casing-copy', newName: 'Root casing copy' });
  assert.equal(copied.currentApprovedVersionId, null);
});
await check('Mock copying rejects nonempty fixture references', async () => {
  const fresh = new MockApiClient();
  const selected = (await fresh.listSavedCases(project.id, { status: 'all' })).items[0];
  const selectedVersion = fresh.savedCaseVersions[selected.id][0];
  selectedVersion.document.fixtureRefs = [{ id: 'd1111111-d111-4111-8111-d11111111111', version: 1 }];
  await assert.rejects(fresh.duplicateSavedCase(selected.id, { sourceVersionId: selectedVersion.id, newSlug: 'root-fixture-copy', newName: 'Root fixture copy' }));
});
const result = { at: new Date().toISOString(), rootIndependent: true, cases, scope: 'Actual Mock and generated HTTP methods, synthetic transport/data; no browser or DOM hydration', P0Passed: false };
if (process.env.ROOT_RESULT_FILE) writeFileSync(process.env.ROOT_RESULT_FILE, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
if (cases.some(item => !item.passed)) process.exitCode = 1;
