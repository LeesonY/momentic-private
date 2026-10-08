// Actual mock and generated client, injected transport only; no browser/network.
import { MockApiClient } from '../../apps/web/src/mocks/mockClient.ts';
import { HttpApiClient } from '../../apps/web/src/api/client.ts';
import { validateContract } from '../../packages/contracts/dist/index.js';

const results = [];
const mock = new MockApiClient();
const saved = await mock.importSavedCaseYaml('11111111-1111-4111-8111-111111111111', {
  slug: 'root-yaml-fixture', name: 'Root Mock', yaml: 'kind: localqa/test\n',
});
results.push({ case: 'new mock SavedCase matches the contract', passed: validateContract('SavedCase', saved).success });
const versions = await mock.listSavedCaseVersions(saved.id);
results.push({ case: 'new mock import has a canonical synthetic draft version', passed: versions.items.length === 1 && versions.items[0].reviewStatus === 'draft' && validateContract('SavedCaseVersion', versions.items[0]).success });
let sourceChecked = false;
for (const project of (await mock.listProjects()).items) {
  for (const savedCase of (await mock.listSavedCases(project.id)).items) {
    const items = (await mock.listSavedCaseVersions(savedCase.id)).items;
    if (!items.length) continue;
    const version = items[0], data = await mock.exportSavedCaseYaml(version.id);
    results.push({ case: 'export preserves selected stored source SHA', passed: data.sourceDocumentSha256 === version.sha256 });
    sourceChecked = true;
    break;
  }
  if (sourceChecked) break;
}
if (!sourceChecked) results.push({ case: 'stored source version fixture exists', passed: false });
const requested = '22222222-2222-4222-8222-222222222222';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ versionId: '33333333-3333-4333-8333-333333333333', sourceDocumentSha256: 'a'.repeat(64), yaml: 'kind: localqa/test\n' }), { status: 200, headers: { 'content-type': 'application/json' } });
let rejected = false;
try { await new HttpApiClient('https://local-fixture.invalid/api/v1').exportSavedCaseYaml(requested); }
catch { rejected = true; }
finally { globalThis.fetch = originalFetch; }
results.push({ case: 'export client rejects another version response', passed: rejected });
console.log(JSON.stringify({ results, scope: 'Actual methods with injected response; no browser/network', P0Passed: false }, null, 2));
if (results.some(item => !item.passed)) process.exitCode = 1;
