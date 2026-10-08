// Root verification of actual public methods; injected transport, no browser/network.
import assert from 'node:assert/strict';
import { MockApiClient } from '../../apps/web/src/mocks/mockClient.ts';
import { HttpApiClient } from '../../apps/web/src/api/client.ts';
import { validateContract } from '../../packages/contracts/dist/index.js';
import { hashPayload } from '../../packages/storage/dist/crypto.js';

const results = [];
async function check(name, action) {
  try { await action(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message }); }
}
const mock = new MockApiClient();
const project = (await mock.listProjects()).items[0];
const saved = await mock.importSavedCaseYaml(project.id, {
  slug: 'root-yaml-final-fixture', name: 'Root 当前项目中文', yaml: 'kind: localqa/test\n',
});
const versions = (await mock.listSavedCaseVersions(saved.id)).items;
await check('new import matches SavedCase contract', () => assert.ok(validateContract('SavedCase', saved).success));
await check('queryable synthetic draft matches SavedCaseVersion', () => {
  assert.equal(versions.length, 1);
  assert.equal(versions[0].reviewStatus, 'draft');
  assert.ok(validateContract('SavedCaseVersion', versions[0]).success);
});
await check('import remains in selected project list with queryable versions', async () => {
  assert.equal(saved.projectId, project.id);
  assert.ok((await mock.listSavedCases(project.id)).items.some(item => item.id === saved.id));
  assert.equal(versions[0].caseId, saved.id);
});
await check('draft SHA equals canonical stored document SHA', () => assert.equal(versions[0].sha256, hashPayload(versions[0].document)));
await check('export mirrors selected stored version ID and SHA', async () => {
  const exported = await mock.exportSavedCaseYaml(versions[0].id);
  assert.equal(exported.versionId, versions[0].id);
  assert.equal(exported.sourceDocumentSha256, versions[0].sha256);
});
await check('unknown project rejected without case persistence', async () => {
  const before = (await mock.listSavedCases(project.id)).items.length;
  await assert.rejects(mock.importSavedCaseYaml('11111111-1111-4111-8111-111111111111', {
    slug: 'root-unknown-project', name: 'Root', yaml: 'kind: localqa/test\n',
  }));
  assert.equal((await mock.listSavedCases(project.id)).items.length, before);
});
await check('legacy project compatibility returns canonical identity and stays queryable', async () => {
  const legacy = 'proj_mock_ecommerce_01';
  const item = await mock.importSavedCaseYaml(legacy, {
    slug: 'root-legacy-fixture', name: 'Root legacy', yaml: 'kind: localqa/test\n',
  });
  assert.equal(item.projectId, project.id);
  assert.ok(validateContract('SavedCase', item).success);
  assert.ok((await mock.listSavedCases(legacy)).items.some(value => value.id === item.id));
  assert.ok((await mock.listSavedCases(project.id)).items.some(value => value.id === item.id));
});
for (const method of ['listSchedules', 'listApiKeys']) {
  await check(`${method} existing fixtures visible after canonical project switch`, async () => {
    const legacy = (await mock[method]('proj_mock_ecommerce_01')).items;
    const canonical = (await mock[method](project.id)).items;
    assert.ok(legacy.length > 0, 'Baseline legacy fixture exists');
    assert.equal(canonical.length, legacy.length);
    assert.deepEqual(canonical.map(item => item.id), legacy.map(item => item.id));
  });
}
for (const [mode, value] of [
  ['missing WebCrypto', undefined],
  ['digest rejection', { subtle: { async digest() { throw new Error('injected digest failure'); } } }],
]) {
  await check(`${mode} rejects import without persistence or fake SHA`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const before = (await mock.listSavedCases(project.id)).items.length;
    try {
      Object.defineProperty(globalThis, 'crypto', { value, writable: true, configurable: true });
      await assert.rejects(mock.importSavedCaseYaml(project.id, {
        slug: 'root-hash-failure', name: 'Root hash failure', yaml: 'kind: localqa/test\n',
      }));
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else delete globalThis.crypto;
    }
    assert.equal((await mock.listSavedCases(project.id)).items.length, before);
  });
}
await check('generated export client rejects another version response', async () => {
  const requested = '22222222-2222-4222-8222-222222222222';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    versionId: '33333333-3333-4333-8333-333333333333', sourceDocumentSha256: 'a'.repeat(64), yaml: 'kind: localqa/test\n',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try { await assert.rejects(new HttpApiClient('https://local-fixture.invalid/api/v1').exportSavedCaseYaml(requested)); }
  finally { globalThis.fetch = originalFetch; }
});
console.log(JSON.stringify({ rootIndependent: true, results, scope: 'Actual public methods and shared backend hash oracle; browser/network not used', P0Passed: false }, null, 2));
if (results.some(item => !item.passed)) process.exitCode = 1;
