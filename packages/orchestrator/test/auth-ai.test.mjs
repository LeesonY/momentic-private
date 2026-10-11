import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authRecognitionPayload,
  validateAuthRecognition,
} from '../dist/auth-ai.js';
import { parseContract } from '@localqa/contracts';

const node = (id, role, name, text = name, visible = true) => ({
  nodeId: id,
  frameId: 'main',
  role,
  name,
  text,
  visible,
  enabled: true,
  bounds: { left: 0, top: 0, width: 120, height: 24 },
});
const before = {
  snapshotId: 'a1111111-1111-4111-8111-111111111111',
  pageId: 'a2222222-2222-4222-8222-222222222222',
  displayUrl: 'https://app.test/login',
  title: 'Login',
  responseStatus: 200,
  nodes: [
    node('u', 'text', '用户名'),
    node('p', 'password', '密码', '[redacted]'),
    node('b', 'button', '登录'),
    node('brand', 'h1', 'App'),
  ],
};
const payloadNodes = (snap) =>
  JSON.parse(
    authRecognitionPayload(snap, 'username').messages[1].content[0].text,
  ).nodes;
const answer = (snap, name, state = 'found') => ({
  state,
  nodeId: payloadNodes(snap).find((n) => n.name === name).nodeId,
});

test('AI form accepts login URL only while legacy manual form still requires locators', () => {
  assert.deepEqual(
    parseContract('FormConfig', {
      loginUrl: 'https://app.test/login',
      detectionMode: 'ai',
    }),
    { loginUrl: 'https://app.test/login', detectionMode: 'ai' },
  );
  assert.throws(() =>
    parseContract('FormConfig', { loginUrl: 'https://app.test/login' }),
  );
  assert.throws(() =>
    parseContract('FormConfig', {
      loginUrl: 'https://app.test/login',
      detectionMode: 'manual',
    }),
  );
});

test('AI receives opaque candidates and redacted field text, never known credentials', () => {
  const username = 'private-test-account';
  const password = 'private-test-password';
  const snap = {
    ...before,
    title: `Welcome ${username}`,
    nodes: [node('real_' + password, 'text', username, password)],
  };
  const payload = authRecognitionPayload(snap, 'username', [
    username,
    password,
  ]);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(username));
  assert.ok(!serialized.includes(password));
  assert.ok(serialized.includes('candidate-0'));
  assert.ok(!serialized.includes('real_'));
});

test('AI selections are resolved to observed current page targets and validated per slot', () => {
  assert.deepEqual(
    validateAuthRecognition(before, 'username', answer(before, '用户名'))
      .target,
    {
      snapshotId: before.snapshotId,
      pageId: before.pageId,
      frameId: 'main',
      nodeId: 'u',
    },
  );
  assert.throws(() =>
    validateAuthRecognition(before, 'username', answer(before, '密码')),
  );
  assert.throws(() =>
    validateAuthRecognition(before, 'password', answer(before, '用户名')),
  );
  assert.throws(() =>
    validateAuthRecognition(before, 'submit', answer(before, '用户名')),
  );
  assert.throws(() =>
    validateAuthRecognition(before, 'username', {
      state: 'found',
      nodeId: 'candidate-999',
    }),
  );
  assert.equal(
    validateAuthRecognition(before, 'otp', { state: 'missing', nodeId: null })
      .target,
    null,
  );
});

test('login success needs a new visible business marker and no remaining password form', () => {
  const after = {
    ...before,
    snapshotId: 'a3333333-3333-4333-8333-333333333333',
    displayUrl: 'https://app.test/dashboard',
    nodes: [node('brand', 'h1', 'App'), node('exit', 'link', '退出登录')],
  };
  const selected = validateAuthRecognition(
    after,
    'success',
    answer(after, '退出登录', 'authenticated'),
    before,
  );
  assert.equal(selected.criterion.kind, 'element_visible');
  assert.equal(selected.criterion.sourceKind, 'inferred');
  assert.equal(selected.target.snapshotId, after.snapshotId);
  assert.equal(
    validateAuthRecognition(
      after,
      'success',
      answer(after, 'App', 'authenticated'),
      before,
    ).target,
    null,
  );
  const stillLogin = {
    ...after,
    nodes: [...after.nodes, node('p', 'password', '密码')],
  };
  assert.equal(
    validateAuthRecognition(
      stillLogin,
      'success',
      answer(stillLogin, '退出登录', 'authenticated'),
      before,
    ).target,
    null,
  );
  assert.equal(
    validateAuthRecognition(
      { ...after, responseStatus: 403 },
      'success',
      answer(after, '退出登录', 'authenticated'),
      before,
    ).target,
    null,
  );
  for (const pending of [
    { ...node('p', 'textbox', 'Password'), inputType: 'password' },
    node('code', 'tel', '短信验证码'),
  ]) {
    const incomplete = { ...after, nodes: [...after.nodes, pending] };
    assert.equal(
      validateAuthRecognition(
        incomplete,
        'success',
        answer(incomplete, '退出登录', 'authenticated'),
        before,
      ).target,
      null,
    );
  }
});

test('registration and destructive buttons cannot be accepted as login submit', () => {
  for (const name of [
    '注册',
    '删除用户',
    '取消',
    '支付',
    'Register',
    'Delete',
  ]) {
    const snap = { ...before, nodes: [node('bad', 'button', name)] };
    assert.throws(() =>
      validateAuthRecognition(snap, 'submit', answer(snap, name)),
    );
  }
});
