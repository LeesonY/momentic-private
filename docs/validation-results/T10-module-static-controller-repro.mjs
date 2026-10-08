// Root checks actual static guard and execution compiler; no PG/browser/network.
import assert from 'node:assert/strict';
import { validateModuleTemplateStatic } from '../../apps/api/src/moduleTemplate.ts';
import { hashPayload } from '../../packages/storage/dist/crypto.js';
import { compileRegression } from '../../packages/orchestrator/dist/index.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const base = {
  schemaVersion: 1, kind: 'localqa/test', id: 'root-static-fixture', name: 'Root static',
  criteria: [{ id: 'ok', kind: 'semantic', description: 'Expected', sourceKind: 'user_spec', sourceRef: 'root', expectedValue: 'expected' }],
  steps: [{ kind: 'navigate', url: '{{env.BASE_URL}}' }, { kind: 'assert', criterionId: 'ok' }], fixtureRefs: [],
};
const cases = [];
function check(name, action) {
  try { action(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, message: error.message }); }
}
const rejects = (doc, lookup = () => undefined) => assert.throws(() => validateModuleTemplateStatic(doc, lookup));
check('unclosed expression rejected', () => rejects({ ...base, steps: [{ kind: 'navigate', url: '{{env.BASE_URL' }] }));
check('unmatched closing expression rejected', () => rejects({ ...base, steps: [{ kind: 'navigate', url: 'https://fixture.invalid/}}' }] }));
check('illegal expression nested inside expectedValue rejected', () => rejects({ ...base, criteria: [{ ...base.criteria[0], expectedValue: { nested: ['{{javascript.exec}}'] } }] }));
check('approved legacy child with invalid criterion rejected', () => {
  const child = { ...base, id: 'child', steps: [{ kind: 'assert', criterionId: 'undeclared' }] };
  rejects({ ...base, steps: [{ kind: 'module', ref: 'child@1' }] }, () => ({ document: child, sha256: hashPayload(child), reviewStatus: 'approved' }));
});
const template = { ...base, criteria: [{ ...base.criteria[0], expectedValue: '{{vars.VALUE}}' }] };
check('valid unbound vars/env admitted statically', () => validateModuleTemplateStatic(template, () => undefined));
check('unbound vars remain rejected by execution compilation', () => {
  assert.throws(() => compileRegression(template, {
    projectId, allowedOrigins: ['https://fixture.invalid'], env: { BASE_URL: 'https://fixture.invalid/' }, maxExpandedSteps: 100, resolveModule: () => undefined,
  }), error => error.code === 'MISSING_VARIABLE');
});
function chain(length) {
  const registry = new Map();
  for (let index = length; index >= 1; index--) {
    const doc = { ...base, id: `layer-${index}`, steps: index === length ? [{ kind: 'assert', criterionId: 'ok' }] : [{ kind: 'module', ref: `layer${index + 1}@1` }] };
    registry.set(`layer${index}@1`, { projectId, name: `layer${index}`, version: 1, document: doc, sha256: hashPayload(doc), reviewStatus: 'approved' });
  }
  return registry;
}
check('eight total module layers admitted statically and by actual compiler', () => {
  const registry = chain(8);
  validateModuleTemplateStatic(registry.get('layer1@1').document, (name, version) => registry.get(`${name}@${version}`));
  const root = { ...base, steps: [{ kind: 'module', ref: 'layer1@1' }] };
  assert.equal(compileRegression(root, { projectId, allowedOrigins: [], env: {}, maxExpandedSteps: 100, resolveModule: (name, version) => registry.get(`${name}@${version}`) }).length, 1);
});
check('ninth total module layer rejected statically and by actual compiler', () => {
  const registry = chain(9);
  rejects(registry.get('layer1@1').document, (name, version) => registry.get(`${name}@${version}`));
  assert.throws(() => compileRegression({ ...base, steps: [{ kind: 'module', ref: 'layer1@1' }] }, { projectId, allowedOrigins: [], env: {}, maxExpandedSteps: 100, resolveModule: (name, version) => registry.get(`${name}@${version}`) }), error => error.code === 'MODULE_DEPTH');
});
check('same sibling module may repeat within global step bound', () => {
  const leaf = { ...base, steps: [{ kind: 'assert', criterionId: 'ok' }] };
  validateModuleTemplateStatic({ ...base, steps: [{ kind: 'module', ref: 'leaf@1' }, { kind: 'module', ref: 'leaf@1' }] }, () => ({ document: leaf, sha256: hashPayload(leaf), reviewStatus: 'approved' }));
});
check('static global bound rejects 102 steps expanded from repeated child', () => {
  const leaf = { ...base, steps: Array.from({ length: 51 }, () => ({ kind: 'assert', criterionId: 'ok' })) };
  rejects({ ...base, steps: [{ kind: 'module', ref: 'leaf@1' }, { kind: 'module', ref: 'leaf@1' }] }, () => ({ document: leaf, sha256: hashPayload(leaf), reviewStatus: 'approved' }));
});
check('120-character registered name at max PG version compiles without truncated source', () => {
  const name = 'a'.repeat(120), version = 2147483647, ref = `${name}@${version}`;
  const leaf = { ...base, steps: [{ kind: 'assert', criterionId: 'ok' }] };
  const registered = { projectId, name, version, document: leaf, sha256: hashPayload(leaf), reviewStatus: 'approved' };
  const root = { ...base, steps: [{ kind: 'module', ref }] };
  validateModuleTemplateStatic(root, () => registered);
  const compiled = compileRegression(root, { projectId, allowedOrigins: [], env: {}, maxExpandedSteps: 100, resolveModule: () => registered });
  assert.equal(compiled[0].source.modulePath[0].ref, ref);
  assert.equal(compiled[0].source.modulePath[0].ref.length, 131);
});
console.log(JSON.stringify({ rootIndependent: true, cases, scope: 'Actual moduleTemplate.ts and compiler, no PG/browser/network', P0Passed: false }, null, 2));
if (cases.some(item => !item.passed)) process.exitCode = 1;
