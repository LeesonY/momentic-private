import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRrwebScript } from '../dist/rrweb-script.js';

test('the rrweb recorder bundle is read from the installed package', () => {
  const script = getRrwebScript();
  assert.ok(script.length > 100_000, 'the UMD bundle is substantial');
  assert.match(script, /rrweb/);
  assert.match(script, /record/);
});
