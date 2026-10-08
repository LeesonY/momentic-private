// Actual modal submit callback with owned closure/guard state; no DOM/browser.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LifecycleScopeGuard } from '../../apps/web/src/utils/lifecycleScope.ts';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { transformSync } = createRequire(require.resolve('vite/package.json'))('esbuild');
const source = readFileSync(new URL('../../apps/web/src/components/saved-cases/SavedCaseDuplicateModal.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const handleSubmit = ');
const end = source.indexOf('\n  const selectedVer', start);
assert.ok(start >= 0 && end > start);
const snippet = source.slice(start, end);
const caseRecord = { id: 'a1111111-a111-4111-8111-a11111111111', projectId: 'b1111111-b111-4111-8111-b11111111111', slug: 'root-source', name: 'Root source', status: 'active', currentApprovedVersionId: null, version: 1, createdAt: '2026-10-07T00:00:00.000Z' };
const targetProjectId = 'c1111111-c111-4111-8111-c11111111111';
function harness(allowed = true) {
  const state = { requests: [], successes: [], loading: false, error: null };
  const sourceGuard = new LifecycleScopeGuard();
  sourceGuard.resetScope({ projectId: caseRecord.projectId, caseId: caseRecord.id });
  const targetGuard = new LifecycleScopeGuard();
  // Match the actual member effect's context from source, rather than silently
  // repairing its context in this harness.
  const hasCaseInTargetEffect = /const scopeContext = \{\s*projectId: targetProjectId,\s*caseId: caseRecord(?:\?)?\.id\s*[,}]?/.test(source);
  targetGuard.resetScope(hasCaseInTargetEffect ? { projectId: targetProjectId, caseId: caseRecord.id } : { projectId: targetProjectId });
  const context = {
    caseRecord, targetProjectId, newSlug: 'root-target-copy', newName: 'Root target copy', sourceVersionId: 'd1111111-d111-4111-8111-d11111111111',
    hasTargetOperatorPlus: allowed, loading: false, loadingTargetMembers: false,
    SLUG_REGEX: /^[a-zA-Z0-9_.-]+$/,
    scopeGuardRef: { current: sourceGuard }, targetScopeGuardRef: { current: targetGuard },
    setLoading: value => { state.loading = value; }, setError: value => { state.error = value; },
    onSuccess: value => { state.successes.push(value); },
    defaultApiClient: { async duplicateSavedCase(id, input) { state.requests.push({ id, input }); return { id: 'e1111111-e111-4111-8111-e11111111111', projectId: input.targetProjectId, slug: input.newSlug, name: input.newName, status: 'active', version: 1, currentApprovedVersionId: null, createdAt: new Date().toISOString() }; } },
  };
  const compiled = transformSync(`function callbacks(context) { const { ${Object.keys(context).join(',')} } = context; ${snippet}; return handleSubmit; }`, { loader: 'ts', target: 'esnext' }).code;
  return { state, context, sourceGuard, targetGuard, action: new Function('context', compiled + '\nreturn callbacks(context);')(context) };
}
const cases = [];
async function check(name, action) { try { await action(); cases.push({ name, passed: true }); } catch (error) { cases.push({ name, passed: false, message: error.message }); } }
await check('actual modal submit with target operator permission reaches the duplicate API', async () => {
  const h = harness();
  await h.action({ preventDefault() {} });
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.requests[0].input.sourceVersionId, h.context.sourceVersionId);
  assert.equal(h.state.requests[0].input.targetProjectId, targetProjectId);
  assert.equal(h.state.successes.length, 1);
  assert.equal(h.state.loading, false);
});
await check('actual modal submit without target write permission performs no mutation', async () => {
  const h = harness(false);
  await h.action({ preventDefault() {} });
  assert.equal(h.state.requests.length, 0);
  assert.ok(h.state.error);
});
const result = { at: new Date().toISOString(), rootIndependent: true, cases, scope: 'Actual modal submit callback with context taken from actual member effect; no DOM/hydration, browser or provider', P0Passed: false };
if (process.env.ROOT_RESULT_FILE) writeFileSync(process.env.ROOT_RESULT_FILE, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
if (cases.some(item => !item.passed)) process.exitCode = 1;
