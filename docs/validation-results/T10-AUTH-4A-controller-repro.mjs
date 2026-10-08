// Root verifies the actual package export with owned synthetic inputs.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { validateApprovedAuthState } from '../../packages/browser/dist/index.js';
const approved = ['https://fixture.invalid', 'https://other.invalid'];
const cookie = (name = 'sid', value = 'synthetic-only') => ({ name, value, domain: 'fixture.invalid', path: '/' });
const checks = [];
async function check(name, action) {
  try { checks.push({ name, passed: true, ...await action() }); }
  catch (error) { checks.push({ name, passed: false, message: error.message }); }
}
await check('plain alias sharing matches equivalent JSON semantics', () => {
  const shared = [];
  const input = { origins: [{ origin: approved[0], localStorage: shared }, { origin: approved[1], localStorage: shared }] };
  const direct = validateApprovedAuthState(input, approved);
  const parsed = validateApprovedAuthState(JSON.stringify(input), approved);
  assert.deepEqual(direct, parsed);
  assert.notEqual(direct.origins, input.origins);
  assert.notEqual(direct.origins[0].localStorage, direct.origins[1].localStorage);
  return { objectAccepted: true, stringAccepted: true };
});
await check('non-index array accessor rejected without invocation', () => {
  let getterCalls = 0;
  for (const key of ['01', '00', '4294967295']) {
    const array = [cookie()];
    Object.defineProperty(array, key, { enumerable: true, get() { getterCalls++; return 'synthetic'; } });
    assert.throws(() => validateApprovedAuthState({ cookies: array }, approved), error => error.code === 'VALIDATION_ERROR');
  }
  assert.equal(getterCalls, 0);
  return { rejected: true, getterCalls };
});
await check('string input also enforces serialized output UTF8 cap', () => {
  const input = { cookies: Array.from({ length: 8 }, (_, i) => cookie(`s${i}`, '\uD800'.repeat(1365))) };
  const raw = JSON.stringify(input).replaceAll('\\ud800', '\uD800');
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  const resultBytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  assert.ok(rawBytes < 65536);
  assert.ok(resultBytes > 65536);
  assert.throws(() => validateApprovedAuthState(raw, approved), error => error.code === 'VALIDATION_ERROR' && error.message === 'VALIDATION_ERROR');
  assert.throws(() => validateApprovedAuthState(input, approved), error => error.code === 'VALIDATION_ERROR');
  return { rejected: true, rawBytes, serializedCandidateBytes: resultBytes };
});
await check('oversized sparse array rejected without reading a value accessor', () => {
  const array = new Array(1000000);
  let getterCalls = 0;
  Object.defineProperty(array, '0', { enumerable: true, get() { getterCalls++; return cookie(); } });
  assert.throws(() => validateApprovedAuthState({ cookies: array }, approved), error => error.code === 'VALIDATION_ERROR');
  assert.equal(getterCalls, 0);
  return { getterCalls };
});
await check('detached nested values stay unchanged after source mutation', () => {
  const input = { cookies: [cookie()], origins: [{ origin: approved[0], localStorage: [{ name: 'session', value: 'synthetic' }] }] };
  const result = validateApprovedAuthState(input, approved);
  input.cookies[0].value = 'changed';
  input.origins[0].localStorage[0].value = 'changed';
  assert.equal(result.cookies[0].value, 'synthetic-only');
  assert.equal(result.origins[0].localStorage[0].value, 'synthetic');
});
const result = { at: new Date().toISOString(), rootIndependent: true, checks, scope: 'Actual exported pure validator; no browser/provider/PG', P0Passed: false };
if (process.env.ROOT_RESULT_FILE) writeFileSync(process.env.ROOT_RESULT_FILE, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
if (checks.some(item => !item.passed)) process.exitCode = 1;
