// Pure Node: actual current TypeScript module with synthetic primitives.
// This does not launch a browser or prove the service execution gate is wired.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const viteRequire = createRequire(require.resolve('vite/package.json'));
const { transformSync } = viteRequire('esbuild');
const sourceUrl = new URL('../../packages/browser/src/private-auth.ts', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
const validatorUrl = new URL('../../packages/browser/dist/auth-state.js', import.meta.url).href;
const code = transformSync(source, { loader: 'ts', format: 'esm' }).code.replace("'./auth-state.js'", JSON.stringify(validatorUrl)).replace('"./auth-state.js"', JSON.stringify(validatorUrl));
const { createPrivateAuthPort } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const now = Date.now();
const origin = 'https://owned-auth.test';
const binding = { sessionId: 'owned-session', projectId: 'owned-project', runId: 'owned-run', taskId: 'owned-task', workerId: 'owned-worker', fencingToken: 1, contextVersion: 1, contextId: 'owned-context', profileId: 'owned-profile', profileVersion: 1, authEpoch: 1, purpose: 'initializer', status: 'active', expiresAt: new Date(now + 60000).toISOString() };
const target = { snapshotId: '11111111-1111-4111-8111-111111111111', pageId: '22222222-2222-4222-8222-222222222222', frameId: 'main', nodeId: 'credential' };
function permit(grantId, extra = {}) { return { ...binding, grantId, deadline: binding.expiresAt, action: 'navigate_auth', slot: 'login_url', url: origin + '/login', ...extra }; }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function snapshot(material = 'ordinary') { return { snapshotId: target.snapshotId, pageId: target.pageId, frameIds: ['main'], displayUrl: origin + '/login', title: 'Account ' + material, responseStatus: 200, capturedAt: new Date(now).toISOString(), stateVersion: 1, viewport: { width: 100, height: 100 }, nodes: [{ nodeId: target.nodeId, frameId: 'main', role: 'textbox', name: material, text: material, visible: true, enabled: true, bounds: { left: 0, top: 0, width: 10, height: 10 } }], screenshotRef: null, networkSummary: [{ summary: material }], consoleSummary: [material], truncated: false, redacted: false }; }
function primitives(extra = {}) { return { navigate: async () => snapshot(), fill: async () => snapshot(), submit: async () => snapshot(), prepareState: async () => {}, exportState: async () => ({ cookies: [] }), ...extra }; }
function port(gate, adapter) { return createPrivateAuthPort({ binding, gate: { authorizeExport: async () => {}, ...gate }, primitives: adapter, allowedOrigins: [origin], now: () => now }); }
let exportSeq = 0;
function exportGrant(extra = {}) { return { ...binding, grantId: 'owned-export-' + (++exportSeq), deadline: binding.expiresAt, kind: 'capture_auth_state', captureTicket: 'OwnedSyntheticCaptureTicket', ...extra }; }
const results = [];
async function check(name, fn) { try { await fn(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, code: error.code ?? 'ASSERTION_FAILED', message: error.message }); } }
const signal = new AbortController().signal;
await check('Permit mutated during async gate cannot change the approved navigation', async () => {
  const gate = deferred();
  const navigations = [];
  const p = port({ authorize: () => gate.promise }, primitives({ navigate: async url => { navigations.push(url); return snapshot(); } }));
  const approved = permit('owned-navigation');
  const execution = p.executeAuth(approved, { kind: 'navigate' }, signal);
  approved.url = 'https://unapproved-auth.test/';
  gate.resolve();
  await execution.catch(() => {});
  assert.equal(navigations.includes('https://unapproved-auth.test/'), false);
  await p.close();
});
await check('Credential snapshot metadata is redacted on fill', async () => {
  const material = 'SyntheticAuthMaterialOnly';
  const p = port({ authorize: async () => {} }, primitives({ fill: async () => snapshot(material) }));
  const result = await p.executeAuth(permit('owned-fill', { action: 'fill_credential', slot: 'username', target }), { kind: 'fill', secret: material }, signal);
  assert.equal(JSON.stringify(result.snapshot).includes(material), false);
  await p.close();
});
await check('Later submit snapshot retains redaction of previously filled credentials', async () => {
  const material = 'SyntheticAuthMaterialOnly';
  const p = port({ authorize: async () => {} }, primitives({ fill: async () => snapshot('ordinary'), submit: async () => snapshot(material) }));
  await p.executeAuth(permit('owned-fill-for-submit', { action: 'fill_credential', slot: 'password', target }), { kind: 'fill', secret: material }, signal);
  const result = await p.executeAuth(permit('owned-submit', { action: 'submit_auth', slot: 'submit', target }), { kind: 'submit' }, signal);
  assert.equal(JSON.stringify(result.snapshot).includes(material), false);
  await p.close();
});
await check('Export started before close cannot return state after the instance is closed', async () => {
  const exported = deferred();
  const p = port({ authorize: async () => {} }, primitives({ exportState: () => exported.promise }));
  const pending = p.exportAuthState(exportGrant(), signal);
  await p.close();
  exported.resolve({ cookies: [] });
  await assert.rejects(pending);
});

await check('State accessor is rejected without being invoked or normalized into approved data',async () => {
  let accessed=0,prepared=0;
  const unsafe=Object.defineProperty({},'cookies',{enumerable:true,get(){accessed++;return[];}});
  const p=port({authorize:async()=>{}},primitives({prepareState:async()=>{prepared++;}}));
  await assert.rejects(p.executeAuth(permit('owned-accessor',{action:'import_storage_state',slot:'storage_state'}),{kind:'prepare_state',state:unsafe},signal),e=>e.code==='VALIDATION_ERROR');
  assert.equal(accessed,0);
  assert.equal(prepared,0);
});
await check('Cyclic state returns a constant validation error',async () => {
  const unsafe={};unsafe.self=unsafe;
  const p=port({authorize:async()=>{}},primitives());
  await assert.rejects(p.executeAuth(permit('owned-cycle',{action:'import_storage_state',slot:'storage_state'}),{kind:'prepare_state',state:unsafe},signal),e=>e.code==='VALIDATION_ERROR' && e.message==='VALIDATION_ERROR');
});
await check('Permit getter cannot disclose its exception or execute',async () => {
  let navigated=0;
  const p=port({authorize:async()=>{}},primitives({navigate:async()=>{navigated++;return snapshot();}}));
  const unsafe=permit('owned-getter');
  Object.defineProperty(unsafe,'url',{enumerable:true,get(){throw new Error('SyntheticAuthMaterialOnly');}});
  await assert.rejects(p.executeAuth(unsafe,{kind:'navigate'},signal),e=>e.code==='VALIDATION_ERROR' && !String(e).includes('SyntheticAuthMaterialOnly'));
  assert.equal(navigated,0);
});
await check('Trusted primitive retains its original receiver',async () => {
  const adapter=primitives();
  adapter.navigate=async function(){assert.equal(this,adapter);return snapshot();};
  const p=port({authorize:async()=>{}},adapter);
  await p.executeAuth(permit('owned-method-receiver'),{kind:'navigate'},signal);
});


await check('Factory without the private export gate is rejected',async () => {
  assert.throws(()=>createPrivateAuthPort({binding,gate:{authorize:async()=>{}},primitives:primitives(),allowedOrigins:[origin]}),e=>e.code==='VALIDATION_ERROR');
});
await check('Missing capture ticket rejects before export or service gate',async () => {
  let exports=0,gates=0;
  const p=port({authorize:async()=>{},authorizeExport:async()=>{gates++;}},primitives({exportState:async()=>{exports++;return{};}}));
  const grant=exportGrant();delete grant.captureTicket;
  await assert.rejects(p.exportAuthState(grant,signal));
  assert.equal(exports+gates,0);
});
await check('Old epoch or foreign session rejects export before the gate',async () => {
  let exports=0,gates=0;
  const p=port({authorize:async()=>{},authorizeExport:async()=>{gates++;}},primitives({exportState:async()=>{exports++;return{};}}));
  await assert.rejects(p.exportAuthState(exportGrant({authEpoch:2}),signal));
  await assert.rejects(p.exportAuthState(exportGrant({sessionId:'foreign-session'}),signal));
  assert.equal(exports+gates,0);
});
await check('Non-active binding cannot create a private port',async () => {
  for(const status of ['allocated','ended','revoked']) {
    assert.throws(()=>createPrivateAuthPort({binding:{...binding,status},gate:{authorize:async()=>{},authorizeExport:async()=>{}},primitives:primitives(),allowedOrigins:[origin]}));
  }
});
await check('Service export denial has constant errors and returns no material',async () => {
  let exports=0;
  const p=port({authorize:async()=>{},authorizeExport:async()=>{throw new Error('OwnedSyntheticCaptureTicket');}},primitives({exportState:async()=>{exports++;return{};}}));
  await assert.rejects(p.exportAuthState(exportGrant(),signal),e=>e.code==='VALIDATION_ERROR' && !String(e).includes('OwnedSyntheticCaptureTicket'));
  assert.equal(exports,0);
});
await check('Export grant is immutable across the gate and cannot be reused',async () => {
  const gate=deferred();
  let received,exports=0;
  const p=port({authorize:async()=>{},authorizeExport:async({grant})=>{received=grant;await gate.promise;}},primitives({exportState:async()=>{exports++;return{};}}));
  const grant=exportGrant();
  const original={...grant};
  const pending=p.exportAuthState(grant,signal);
  grant.captureTicket='AnotherSyntheticTicket';grant.taskId='foreign-task';
  gate.resolve();
  await pending;
  assert.equal(received.captureTicket,original.captureTicket);
  assert.equal(received.taskId,original.taskId);
  await assert.rejects(p.exportAuthState(original,signal));
  assert.equal(exports,1);
});
await check('Closing during export authorization prevents the primitive from running',async () => {
  const gate=deferred();let exports=0;
  const p=port({authorize:async()=>{},authorizeExport:()=>gate.promise},primitives({exportState:async()=>{exports++;return{};}}));
  const pending=p.exportAuthState(exportGrant(),signal);
  await p.close();gate.resolve();
  await assert.rejects(pending);
  assert.equal(exports,0);
});
await check('Deadline expiring while authorization is pending prevents state export',async () => {
  const gate=deferred();let exports=0,clock=now;
  const p=createPrivateAuthPort({binding,gate:{authorize:async()=>{},authorizeExport:()=>gate.promise},primitives:primitives({exportState:async()=>{exports++;return{};}}),allowedOrigins:[origin],now:()=>clock});
  const pending=p.exportAuthState(exportGrant(),signal);
  clock=now+61000;gate.resolve();
  await assert.rejects(pending,e=>e.code==='LEASE_EXPIRED');
  assert.equal(exports,0);
});

const report = { scope: 'Pure Node, transpiled actual source; synthetic primitives only', sourceSha256: createHash('sha256').update(source).digest('hex'), checks: results, summary: { passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length }, browserPaused: true, P0Passed: false };
writeFileSync(new URL('./T10-AUTH5-private-port-controller-current.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.summary.failed) process.exitCode = 1;
