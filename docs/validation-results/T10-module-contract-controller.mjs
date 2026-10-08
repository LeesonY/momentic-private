// Root boundary checks of generated contracts; no browser or external transport.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateContract, getApiValidator, publicOperationIds } from '../../packages/contracts/dist/index.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const document = {
  schemaVersion: 1, kind: 'localqa/test', id: 'root-module-contract', name: '模块模板',
  criteria: [{ id: 'page', kind: 'http_status', description: '页面响应', sourceKind: 'user_spec', sourceRef: 'root-module-contract', expectedValue: 200 }],
  steps: [{ kind: 'navigate', url: '{{env.BASE_URL}}' }, { kind: 'assert', criterionId: 'page' }],
};
const results = [];
function check(name, action) {
  try { action(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message }); }
}
const valid = (name, value) => validateContract(name, value).success;
check('unbound vars/env template schema admitted as draft input', () => {
  assert.ok(valid('RegressionModuleCreate', { name: 'auth/login', expectedVersion: 0, document }));
});
check('operator input cannot supply approval state or reviewer metadata', () => {
  for (const extra of [{ reviewStatus: 'approved' }, { reviewedBy: projectId }, { sha256: 'a'.repeat(64) }])
    assert.equal(valid('RegressionModuleCreate', { name: 'auth/login', document, ...extra }), false);
});
check('invalid, traversal and control-character module names rejected', () => {
  for (const name of ['', '.', '..', '../login', 'auth/../login', 'auth/.', '/auth', 'auth/', 'auth//login', 'auth@1', 'auth\n'])
    assert.equal(valid('RegressionModuleCreate', { name, document }), false, JSON.stringify(name));
});
check('version request stays inside PostgreSQL integer bounds', () => {
  for (const expectedVersion of [-1, 0.5, 2147483648, '1'])
    assert.equal(valid('RegressionModuleCreate', { name: 'auth/login', document, expectedVersion }), false);
  assert.ok(valid('RegressionModuleCreate', { name: 'auth/login', document, expectedVersion: 2147483647 }));
});
check('full 120-character module name and PostgreSQL version fit reference/source contracts', () => {
  const name = 'a'.repeat(120);
  const reference = `${name}@2147483647`;
  assert.equal(reference.length, 131);
  assert.ok(valid('RegressionModuleCreate', { name, document }));
  assert.ok(valid('RegressionDocument', { ...document, steps: [{ kind: 'module', ref: reference }] }));
  assert.ok(valid('RegressionStepSource', { documentId: document.id, stepIndex: 0, modulePath: [{ ref: reference, sha256: 'a'.repeat(64), invocationStepIndex: 0 }] }));
});
check('legacy snapshot shape retained and management metadata can be unknown', () => {
  const snapshot = { projectId, name: '../legacy', version: 1, sha256: 'a'.repeat(64), document, reviewStatus: 'approved' };
  assert.ok(valid('RegressionModuleVersion', snapshot));
  assert.ok(valid('RegressionModuleRecord', { ...snapshot, createdBy: null, createdAt: null, reviewedBy: null, reviewedAt: null }));
  assert.equal(valid('RegressionModuleVersion', { ...snapshot, createdBy: null }), false);
});
check('preview binds a composite target and document SHA instead of UUID versionId', () => {
  const preview = { projectId, moduleName: 'auth/login', version: 1, documentSha256: 'a'.repeat(64), expectedVersion: 1, decision: 'approve', reason: '确认标准', diff: 'draft', risks: [], confirmationToken: 'opaque-token', expiresAt: '2026-10-06T00:00:00Z' };
  assert.ok(valid('RegressionModuleReviewPreview', preview));
  assert.equal(valid('RegressionModuleReviewPreview', { ...preview, versionId: projectId }), false);
  assert.equal(valid('RegressionModuleReviewPreview', { ...preview, documentSha256: 'wrong' }), false);
});
check('module path has encoded-name string, bounded numeric version and UUID project', () => {
  const validator = getApiValidator('previewRegressionModuleReview', { kind: 'parameters', location: 'path' });
  assert.ok(validator({ projectId, moduleName: 'auth/login', version: 1 }));
  assert.equal(validator({ projectId, moduleName: 'auth/login', version: 2147483648 }), false);
  assert.equal(validator({ projectId: 'not-a-uuid', moduleName: 'auth/login', version: 1 }), false);
});
check('five operations included in the canonical 77-public operation surface', () => {
  assert.equal(publicOperationIds.length, 77);
  for (const operation of ['createRegressionModule', 'listRegressionModules', 'listRegressionModuleVersions', 'previewRegressionModuleReview', 'reviewRegressionModuleVersion'])
    assert.ok(publicOperationIds.includes(operation));
});
const domain = JSON.parse(await readFile(new URL('../contracts/domain.schema.json', import.meta.url), 'utf8'));
const openapi = JSON.parse(await readFile(new URL('../contracts/openapi.json', import.meta.url), 'utf8'));
console.log(JSON.stringify({ rootIndependent: true, counts: { definitions: Object.keys(domain.$defs).length, operations: Object.values(openapi.paths).reduce((total, methods) => total + Object.keys(methods).length, 0), publicOperations: publicOperationIds.length }, results, backendImplemented: false, uiImplemented: false, browserExecuted: false, P0Passed: false }, null, 2));
if (results.some(item => !item.passed)) process.exitCode = 1;
