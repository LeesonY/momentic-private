import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolicyInterceptor, isNavigationKey, isNonInputInteraction } from '../dist/index.js';

const target = { nodeId: 'password', role: 'password', name: '密码' };
const press = (policy, args, page = 'https://app.test/login') =>
  policy.checkAction({ name: 'press', args }, target, page);

test('focus and navigation keys share the grant/browser non-input classification', () => {
  const policy = new PolicyInterceptor({ mode: 'non_submitting' });
  assert.equal(isNonInputInteraction({ name: 'click', args: { target } }), true);
  assert.equal(policy.checkAction({ name: 'click', args: { target } }, target).allowed, true);
  for (const key of ['Tab', 'Shift+Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(isNavigationKey(key), true);
    assert.equal(isNonInputInteraction({ name: 'press', args: { target, key } }), true);
    assert.equal(press(policy, { target, key }).allowed, true);
  }
  for (const key of ['a', 'Control+V', 'Space', 'Control+Enter', 'Shift+ArrowLeft'])
    assert.equal(isNonInputInteraction({ name: 'press', args: { target, key } }), false);
});

test('a plain Enter with a target is judged by its button, not refused here', () => {
  const policy = new PolicyInterceptor({ mode: 'non_submitting' });
  assert.equal(press(policy, { target, key: 'Enter' }).allowed, true);
  // Without a target the focus is unknown.
  assert.equal(press(policy, { key: 'Enter' }).allowed, false);
  // Space and modifier combinations are not the form's default activation.
  assert.equal(press(policy, { target, key: 'Space' }).allowed, false);
  assert.equal(press(policy, { target, key: 'Control+Enter' }).allowed, false);
  assert.equal(press(policy, { target, key: 'Shift+Enter' }).allowed, false);
  // Other keys keep their old allowance.
  assert.equal(press(policy, { target, key: 'Tab' }).allowed, true);
  assert.equal(press(policy, { target, key: 'Shift+Tab' }).allowed, true);
  assert.equal(press(policy, { target, key: 'Escape' }).allowed, true);
});

test('approved workflows outside the write scope still judge a plain Enter by its button', () => {
  const policy = new PolicyInterceptor({
    mode: 'approved_workflows',
    allowedOrigins: ['https://app.test'],
    writeScope: ['https://app.test/org'],
  });
  assert.equal(
    press(policy, { target, key: 'Enter' }, 'https://app.test/settings')
      .allowed,
    true,
  );
  assert.equal(
    press(policy, { target, key: 'Control+Enter' }, 'https://app.test/settings')
      .allowed,
    false,
  );
});

test('restrictsActivation matches exactly the old Enter refusal scope', () => {
  const nonSubmitting = new PolicyInterceptor({ mode: 'non_submitting' });
  assert.equal(nonSubmitting.restrictsActivation('https://app.test/'), true);

  const approved = new PolicyInterceptor({
    mode: 'approved_workflows',
    allowedOrigins: ['https://app.test'],
    writeScope: ['https://app.test/org'],
  });
  assert.equal(approved.restrictsActivation('https://app.test/org/new'), false);
  assert.equal(approved.restrictsActivation('https://app.test/settings'), true);

  const full = new PolicyInterceptor({ mode: 'full' });
  assert.equal(full.restrictsActivation('https://app.test/'), false);
  const exploration = new PolicyInterceptor({ mode: 'exploration' });
  assert.equal(exploration.restrictsActivation('https://app.test/'), false);
});
