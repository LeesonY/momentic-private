import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolicyInterceptor } from '../dist/index.js';

test('business writes require the frozen page scope and never widen origins', () => {
  const policy = new PolicyInterceptor({
    mode: 'approved_workflows',
    allowedOrigins: ['https://app.test'],
    writeScope: ['https://app.test/organizations'],
  });
  const call = { name: 'click', args: {} };
  const target = {
    nodeId: 'save',
    role: 'button',
    name: '保存',
    isDangerousMutation: true,
  };
  assert.equal(
    policy.checkAction(call, target, 'https://app.test/organizations/new')
      .allowed,
    true,
  );
  for (const page of [
    'https://app.test/settings',
    'https://app.test/organizations-other',
    'https://other.test/organizations',
  ])
    assert.equal(policy.checkAction(call, target, page).allowed, false);
  assert.equal(
    policy.checkAction(
      call,
      { ...target, href: 'https://other.test/' },
      'https://app.test/organizations',
    ).allowed,
    false,
  );
});

test('browser policy allows exactly the configured origin, not same-host alternate scheme or port', () => {
  const policy = new PolicyInterceptor({
    allowedOrigins: ['https://app.example.test:8443'],
  });
  assert.equal(
    policy.checkNavigationUrl('https://app.example.test:8443/dashboard')
      .allowed,
    true,
  );
  for (const url of [
    'http://app.example.test:8443/dashboard',
    'https://app.example.test:8444/dashboard',
    'https://app.example.test/dashboard',
    'https://app.example.test.evil.test:8443/dashboard',
    'https://user:pass@app.example.test:8443/dashboard',
  ]) {
    const result = policy.checkNavigationUrl(url);
    assert.equal(result.allowed, false, url);
    assert.equal(result.reasonCode, 'TARGET_NOT_ALLOWED');
  }
});

test('localhost cannot bypass 127.0.0.1 origin and cannot change loopback port', () => {
  const policy = new PolicyInterceptor({
    allowedOrigins: ['http://127.0.0.1:8443'],
  });
  assert.equal(
    policy.checkNavigationUrl('http://127.0.0.1:8443/a').allowed,
    true,
  );
  for (const url of [
    'http://localhost:8443/a',
    'http://127.0.0.1:9000/a',
    'https://127.0.0.1:8443/a',
  ]) {
    assert.equal(policy.checkNavigationUrl(url).allowed, false, url);
  }
});
