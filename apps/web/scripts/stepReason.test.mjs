import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepReasonText } from '../src/components/session/stepReason.ts';

test('a failed browser step names its cause in Chinese', () => {
  assert.equal(stepReasonText('VERSION_CONFLICT'), '快照已过期');
  assert.equal(stepReasonText('REPEATED_ACTION_LIMIT'), '重复动作已拦截');
  assert.equal(stepReasonText('POLICY_DENIED'), '策略拒绝');
  assert.equal(stepReasonText('TARGET_NOT_FOUND'), '目标不存在');
  assert.equal(stepReasonText('BROWSER_FAILED'), '浏览器执行失败');
});

test('a missing or unknown reason stays untranslated instead of inventing one', () => {
  assert.equal(stepReasonText(null), null);
  assert.equal(stepReasonText(undefined), null);
  assert.equal(stepReasonText(''), null);
  assert.equal(stepReasonText('SOMETHING_NEW'), null);
});
