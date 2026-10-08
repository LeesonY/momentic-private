// Saved-case roots are outside the module invocation stack.
import assert from 'node:assert/strict';
import { hashPayload } from '../../packages/storage/dist/index.js';
import { compileRegression } from '../../packages/orchestrator/dist/index.js';
import { validateModuleTemplateStatic } from '../../apps/api/src/moduleTemplate.ts';
const projectId = 'a1111111-a111-4111-8111-a11111111111';
const doc = (id, steps) => ({ schemaVersion: 1, kind: 'localqa/test', id, name: id, criteria: [{ id: 'ok', kind: 'http_status', description: 'HTTP status', sourceKind: 'user_spec', sourceRef: 'root', expectedValue: 200 }], steps });
const modules = new Map();
for (let i = 9; i >= 1; i--) {
  const document = doc(`depth-${i}`, i === 9 ? [{ kind: 'assert', criterionId: 'ok' }] : [{ kind: 'module', ref: `depth-${i + 1}@1` }]);
  modules.set(`depth-${i}`, { projectId, name: `depth-${i}`, version: 1, reviewStatus: 'approved', document, sha256: hashPayload(document) });
}
const resolver = name => modules.get(name);
const compilerOptions = { projectId, allowedOrigins: ['https://fixture.invalid'], env: {}, maxExpandedSteps: 100, resolveModule: resolver };
const cases = [];
function check(name, action) { try { action(); cases.push({ name, passed: true }); } catch (error) { cases.push({ name, passed: false, message: error.message }); } }
check('saved case allows eight module invocations consistent with runtime compiler', () => {
  const root = doc('case-root-eight', [{ kind: 'module', ref: 'depth-2@1' }]);
  assert.equal(compileRegression(root, compilerOptions).length, 1);
  validateModuleTemplateStatic(root, resolver, 0);
});
check('saved case rejects the ninth invocation', () => {
  const root = doc('case-root-nine', [{ kind: 'module', ref: 'depth-1@1' }]);
  assert.throws(() => compileRegression(root, compilerOptions), error => error.code === 'MODULE_DEPTH');
  assert.throws(() => validateModuleTemplateStatic(root, resolver, 0));
});
check('registration still counts the template itself as one future module invocation', () => {
  validateModuleTemplateStatic(modules.get('depth-2').document, resolver);
  assert.throws(() => validateModuleTemplateStatic(modules.get('depth-1').document, resolver));
});
console.log(JSON.stringify({ rootIndependent: true, cases, scope: 'Pure actual compiler and API static helper; no PG, browser or provider', P0Passed: false }, null, 2));
if (cases.some(item => !item.passed)) process.exitCode = 1;
