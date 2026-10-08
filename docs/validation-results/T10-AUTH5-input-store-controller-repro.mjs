// Actual RunStore callback; synthetic HTTP and mutable render references only.
// No React DOM/hydration or browser execution.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const viteRequire = createRequire(require.resolve('vite/package.json'));
const { transformSync } = viteRequire('esbuild');
const source = readFileSync(new URL('../../apps/web/src/state/RunStore.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const respondInput = ');
const end = source.indexOf('\n  const retrySse = ', start);
assert.ok(start >= 0 && end > start);
const snippet = transformSync(source.slice(start, end), { loader: 'ts' }).code;
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }
const request = (id, runId) => ({ id, runId, version: 1, kind: 'clarification', status: 'pending' });
function harness() {
  const state = { active: request('owned-a', 'owned-run-a'), calls: [], writes: [] };
  const context = { runIdRef: { current: 'owned-run-a' }, activeInputRequestRef: { current: state.active }, respondingInputRef: { current: false }, defaultApiClient: { respondToInput: async (runId, inputId, payload) => { state.calls.push({ runId, inputId, payload }); return { id: inputId, runId, version: payload.expectedVersion + 1, status: payload.decision === 'reject' ? 'rejected' : 'resolved' }; } }, setActiveInputRequest: value => { state.active = value; state.writes.push(value); } };
  const callback = new Function('context', `with (context) { ${snippet}; return respondInput; }`)(context);
  return { state, context, callback, switchTo(id, runId) { state.active = request(id, runId); context.runIdRef.current = runId; context.activeInputRequestRef.current = state.active; } };
}
const checks = [];
async function check(name, fn) { try { await fn(); checks.push({ name, passed: true }); } catch (error) { checks.push({ name, passed: false, code: error.code ?? 'ASSERTION_FAILED', message: error.message }); } }
await check('Incorrect response version cannot clear the active request', async () => {
  const h = harness();
  h.context.defaultApiClient.respondToInput = async () => ({ id: 'owned-a', runId: 'owned-run-a', version: 1, status: 'resolved' });
  await h.callback('approve').catch(() => {});
  assert.equal(h.state.active?.id, 'owned-a');
});
await check('New run can submit its own request while an old run response remains pending', async () => {
  const h = harness();
  const first = deferred();
  h.context.defaultApiClient.respondToInput = async (runId, inputId, payload) => { h.state.calls.push({ runId, inputId, payload }); if (runId === 'owned-run-a') return first.promise; return { id: inputId, runId, version: 2, status: 'resolved' }; };
  const a = h.callback('approve');
  h.switchTo('owned-b', 'owned-run-b');
  await h.callback('approve');
  first.resolve({ id: 'owned-a', runId: 'owned-run-a', version: 2, status: 'resolved' });
  await a;
  assert.equal(h.state.calls.length, 2);
});
await check('Same-request same-tick submissions remain single flight', async () => {
  const h = harness();
  const wait = deferred();
  h.context.defaultApiClient.respondToInput = async () => { h.state.calls.push('sent'); return wait.promise; };
  const a = h.callback('approve');
  await h.callback('approve');
  wait.resolve({ id: 'owned-a', runId: 'owned-run-a', version: 2, status: 'resolved' });
  await a;
  assert.equal(h.state.calls.length, 1);
});
await check('Late old response does not clear the new run request', async () => {
  const h = harness();
  const wait = deferred();
  h.context.defaultApiClient.respondToInput = () => wait.promise;
  const a = h.callback('approve');
  h.switchTo('owned-b', 'owned-run-b');
  wait.resolve({ id: 'owned-a', runId: 'owned-run-a', version: 2, status: 'resolved' });
  await a;
  assert.equal(h.state.active.id, 'owned-b');
});
await check('Reject payload omits ordinary text', async () => {
  const h = harness();
  await h.callback('reject', 'SyntheticMaterialOnly');
  assert.equal('text' in h.state.calls[0].payload, false);
});
const result = { scope: 'Extracted actual RunStore callback; synthetic transport and render refs only', sourceSha256: createHash('sha256').update(source).digest('hex'), checks, summary: { passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length }, browserPaused: true, P0Passed: false };
writeFileSync(new URL('./T10-AUTH5-input-store-controller-current.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (result.summary.failed) process.exitCode = 1;
