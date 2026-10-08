// Actual page callbacks, transpiled from current source with owned closure state.
// This verifies async callback logic, not DOM/hydration or React event dispatch.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LifecycleScopeGuard, isSameCaseId } from '../../apps/web/src/utils/lifecycleScope.ts';
import { isSameProjectId } from '../../apps/web/src/utils/moduleRoles.ts';
import { fetchSavedCaseVersionsAcrossPages } from '../../apps/web/src/utils/savedCaseVersionPagination.ts';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const viteRequire = createRequire(require.resolve('vite/package.json'));
const { transformSync } = viteRequire('esbuild');
const source = readFileSync(new URL('../../apps/web/src/pages/SavedCasesPage.tsx', import.meta.url), 'utf8');
function extract(startName, endMarker) {
  const start = source.indexOf(`  const ${startName} = `);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Find actual callback ${startName}`);
  return source.slice(start, end);
}
const snippets = [extract('fetchCases', '\n  const loadMoreCases'), extract('loadMoreCases', '\n  // Project switch'), extract('handleCreateCase', '\n  const handleArchiveCase'), extract('handleArchiveCase', '\n  const handleRestoreCase')];
function harness() {
  const state = { busy: {}, routes: [], cases: [], versionsMap: {}, createLoading: false, loading: false, loadingMore: false, error: null, scope: { projectId: 'a1111111-a111-4111-8111-a11111111111', statusFilter: 'all' } };
  const guard = new LifecycleScopeGuard();
  guard.resetScope(state.scope);
  const noop = () => {};
  const context = {
    useCallback: callback => callback,
    isSameCaseId, isSameProjectId, fetchSavedCaseVersionsAcrossPages,
    currentProject: { id: state.scope.projectId }, statusFilter: state.scope.statusFilter,
    scopeGuardRef: { current: guard }, isReadOnly: false,
    nextCursor: 'synthetic-page-2', loadingMore: false, loading: false,
    newSlug: 'root-created', newName: 'Root created',
    setLoading: value => { state.loading = value; }, setError: value => { state.error = value; },
    setLoadingMore: value => { state.loadingMore = value; },
    setCases: update => { state.cases = typeof update === 'function' ? update(state.cases) : update; },
    setVersionsMap: update => { state.versionsMap = typeof update === 'function' ? update(state.versionsMap) : update; },
    setNextCursor: noop, setMembers: noop,
    setCreatingCase: noop, setNewSlug: noop, setNewName: noop,
    setCreateLoading: value => { state.createLoading = value; },
    setActionLoadingMap: update => { state.busy = typeof update === 'function' ? update(state.busy) : update; },
    setRoute: (...args) => { state.routes.push(args); },
    defaultApiClient: {
      async listSavedCases() { return { items: [], nextCursor: null }; },
      async listMembers() { return { items: [], nextCursor: null }; },
      async listSavedCaseVersions() { return { items: [], nextCursor: null }; },
      async archiveSavedCase(id, input) { return { id, projectId: state.scope.projectId, slug: 'root-owned', name: 'Root owned', status: 'archived', currentApprovedVersionId: null, version: input.expectedVersion + 1, createdAt: new Date().toISOString() }; },
      async createSavedCase() { return { id: 'b1111111-b111-4111-8111-b11111111111', projectId: state.scope.projectId, slug: 'root-created', name: 'Root created', status: 'active', currentApprovedVersionId: null, version: 1, createdAt: new Date().toISOString() }; },
    },
  };
  const names = Object.keys(context);
  const code = `const { ${names.join(',')} } = context;\n${snippets.join('\n')}\nreturn { fetchCases, loadMoreCases, handleArchiveCase, handleCreateCase };`;
  const compiled = transformSync(`function getCallbacks(context) { ${code} }`, { loader: 'ts', target: 'esnext' }).code;
  return { state, context, guard, actions: new Function('context', compiled + '\nreturn getCallbacks(context);')(context) };
}
const cases = [];
async function check(name, action) { try { await action(); cases.push({ name, passed: true }); } catch (error) { cases.push({ name, passed: false, message: error.message }); } }
await check('actual archive callback clears busy after its successful same-scope refresh', async () => {
  const h = harness();
  await h.actions.handleArchiveCase({ id: 'b1111111-b111-4111-8111-b11111111111', slug: 'root-owned', version: 1 });
  assert.deepEqual(h.state.busy, {});
});
await check('actual create callback still navigates and clears busy after successful refresh', async () => {
  const h = harness();
  await h.actions.handleCreateCase({ preventDefault() {} });
  assert.equal(h.state.createLoading, false);
  assert.equal(h.state.routes.length, 1);
  assert.equal(h.state.routes[0][0], 'saved-case-detail');
});
await check('actual delayed archive never refreshes the old project after a scope switch', async () => {
  const h = harness();
  let finish;
  let refreshes = 0;
  h.context.defaultApiClient.archiveSavedCase = () => new Promise(resolve => { finish = resolve; });
  h.context.defaultApiClient.listSavedCases = async () => { refreshes++; return { items: [], nextCursor: null }; };
  const result = h.actions.handleArchiveCase({ id: 'b1111111-b111-4111-8111-b11111111111', slug: 'root-owned', version: 1 });
  h.guard.resetScope({ projectId: 'c1111111-c111-4111-8111-c11111111111', statusFilter: 'all' });
  finish({}); await result;
  assert.equal(refreshes, 0);
  assert.equal(h.state.routes.length, 0);
});
await check('actual two same-scope archive callbacks both clear their own busy state', async () => {
  const h = harness();
  const pending = new Map();
  h.context.defaultApiClient.archiveSavedCase = id => new Promise(resolve => { pending.set(id, resolve); });
  const firstId = 'b1111111-b111-4111-8111-b11111111111';
  const secondId = 'b2222222-b222-4222-8222-b22222222222';
  const first = h.actions.handleArchiveCase({ id: firstId, slug: 'root-first', version: 1 });
  const second = h.actions.handleArchiveCase({ id: secondId, slug: 'root-second', version: 1 });
  pending.get(firstId)({}); await first;
  assert.equal(h.state.busy[firstId], undefined);
  assert.equal(h.state.busy[secondId], 'archiving');
  pending.get(secondId)({}); await second;
  assert.deepEqual(h.state.busy, {});
});
await check('actual load-more finally clears busy when superseded by same-scope refresh', async () => {
  const h = harness();
  let finishMore;
  h.context.defaultApiClient.listSavedCases = async (_pid, query) => {
    if (query.cursor) return new Promise(resolve => { finishMore = resolve; });
    return { items: [], nextCursor: null };
  };
  const more = h.actions.loadMoreCases();
  assert.equal(h.state.loadingMore, true);
  await h.actions.fetchCases();
  finishMore({ items: [], nextCursor: null }); await more;
  assert.equal(h.state.loadingMore, false);
});
await check('actual delayed create cannot route or clear new-project activity', async () => {
  const h = harness();
  let finish;
  h.context.defaultApiClient.createSavedCase = () => new Promise(resolve => { finish = resolve; });
  const created = h.actions.handleCreateCase({ preventDefault() {} });
  h.guard.resetScope({ projectId: 'c1111111-c111-4111-8111-c11111111111', statusFilter: 'all' });
  h.state.createLoading = true; // Owned simulation of activity in the new page.
  finish({ id: 'd1111111-d111-4111-8111-d11111111111' }); await created;
  assert.equal(h.state.routes.length, 0);
  assert.equal(h.state.createLoading, true);
});
await check('actual list loader retains approved version metadata from a later history page', async () => {
  const h = harness();
  const id = 'b1111111-b111-4111-8111-b11111111111';
  const approvedId = 'd1111111-d111-4111-8111-d11111111111';
  const document = { schemaVersion: 1, kind: 'localqa/test', id: 'root-paged-case', name: 'Root paged case', criteria: [{ id: 'ok', kind: 'http_status', description: 'HTTP status', sourceKind: 'user_spec', sourceRef: 'root', expectedValue: 200 }], steps: [{ kind: 'assert', criterionId: 'ok' }] };
  const base = { id: 'c1111111-c111-4111-8111-c11111111111', caseId: id, version: 1, document, sha256: 'a'.repeat(64), reviewStatus: 'draft', createdBy: h.state.scope.projectId, createdAt: '2026-10-07T00:00:00.000Z', reviewedBy: null, reviewedAt: null };
  const approved = { ...base, id: approvedId, version: 101, reviewStatus: 'approved', reviewedBy: base.createdBy, reviewedAt: base.createdAt };
  const record = { id, projectId: h.state.scope.projectId, slug: 'root-paged-case', name: 'Root paged case', status: 'active', currentApprovedVersionId: approvedId, version: 108, createdAt: base.createdAt };
  h.context.defaultApiClient.listSavedCases = async () => ({ items: [record], nextCursor: null });
  let historyRequests = 0;
  h.context.defaultApiClient.listSavedCaseVersions = async (_id, query) => { historyRequests++; return query?.cursor ? { items: [approved], nextCursor: null } : { items: [base], nextCursor: 'second-history-page' }; };
  await h.actions.fetchCases();
  assert.equal(historyRequests, 2);
  assert.equal(h.state.versionsMap[id].find(item => item.id === approvedId).version, 101);
  assert.equal(h.state.loading, false);
});
const result = { at: new Date().toISOString(), rootIndependent: true, cases, scope: 'Actual SavedCasesPage callbacks transpiled with injected closure state and real LifecycleScopeGuard; no browser, DOM/hydration or provider', P0Passed: false };
if (process.env.ROOT_RESULT_FILE) writeFileSync(process.env.ROOT_RESULT_FILE, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
if (cases.some(item => !item.passed)) process.exitCode = 1;
