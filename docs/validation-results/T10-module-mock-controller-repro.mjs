// Root verification of actual Mock public methods; no network/browser.
import assert from 'node:assert/strict';
import { MockApiClient } from '../../apps/web/src/mocks/mockClient.ts';
import { validateContract } from '../../packages/contracts/dist/index.js';
import { hashPayload } from '../../packages/storage/dist/crypto.js';

const mock = new MockApiClient();
const project = (await mock.listProjects()).items[0];
const document = {
  schemaVersion: 1, kind: 'localqa/test', id: 'root-module-mock', name: 'Root module mock',
  criteria: [{ id: 'ok', kind: 'http_status', description: 'Status', sourceKind: 'user_spec', sourceRef: 'root', expectedValue: 200 }],
  steps: [{ kind: 'navigate', url: '{{env.BASE_URL}}' }, { kind: 'assert', criterionId: 'ok' }],
};
const cases = [];
async function check(name, action) {
  try { await action(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, message: error.message }); }
}
const first = await mock.createRegressionModule(project.id, { name: 'root-public-module', document });
await check('created record matches canonical contract and document SHA', () => {
  assert.ok(validateContract('RegressionModuleRecord', first).success);
  assert.equal(first.sha256, hashPayload(first.document));
});
await check('existing module requires explicit expectedVersion, no silent append', async () => {
  const before = (await mock.listRegressionModuleVersions(project.id, first.name)).items.length;
  await assert.rejects(mock.createRegressionModule(project.id, { name: first.name, document }));
  assert.equal((await mock.listRegressionModuleVersions(project.id, first.name)).items.length, before);
});
const versions = (await mock.listRegressionModuleVersions(project.id, first.name)).items;
const max = Math.max(...versions.map(item => item.version));
const next = await mock.createRegressionModule(project.id, { name: first.name, document, expectedVersion: max });
await check('project page includes every version sorted by name ASC/version DESC', async () => {
  const page = await mock.listRegressionModules(project.id);
  assert.ok(validateContract('RegressionModuleRecordPage', page).success);
  const selected = page.items.filter(item => item.name === first.name);
  assert.equal(selected.length, (await mock.listRegressionModuleVersions(project.id, first.name)).items.length);
  assert.equal(selected[0].version, next.version);
  assert.deepEqual(page.items.map(item => [item.name, item.version]), [...page.items].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : b.version - a.version).map(item => [item.name, item.version]));
});
await check('pagination limit/cursor expose distinct successive records', async () => {
  const page1 = await mock.listRegressionModules(project.id, { limit: 1 });
  assert.equal(page1.items.length, 1);
  assert.ok(page1.nextCursor);
  const page2 = await mock.listRegressionModules(project.id, { limit: 1, cursor: page1.nextCursor });
  assert.equal(page2.items.length, 1);
  assert.notDeepEqual([page1.items[0].name, page1.items[0].version], [page2.items[0].name, page2.items[0].version]);
});
await check('new project sees its own module and does not see original project fixtures', async () => {
  const independent = await mock.createProject({ name: 'Root independent project' });
  assert.equal((await mock.listRegressionModules(independent.id)).items.length, 0);
  const created = await mock.createRegressionModule(independent.id, { name: 'root-independent-module', document });
  assert.equal(created.projectId, independent.id);
  assert.equal((await mock.listRegressionModules(independent.id)).items.length, 1);
  assert.equal((await mock.listRegressionModules(project.id)).items.some(item => item.name === created.name), false);
});
await check('unknown project rejects creation', async () => {
  await assert.rejects(mock.createRegressionModule('22222222-2222-4222-8222-222222222222', { name: 'unknown', document }));
});
console.log(JSON.stringify({ rootIndependent: true, cases, scope: 'Actual public Mock methods and canonical shared contract/hash; no browser/network', P0Passed: false }, null, 2));
if (cases.some(item => !item.passed)) process.exitCode = 1;
