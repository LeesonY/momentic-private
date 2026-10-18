// Pure Node: the real Coordinator.grantAction policy over the SQL-aware
// session/auth fixture. No PostgreSQL, Chromium or model provider runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
import { DomainError } from '@localqa/domain';
import { StorageError, hashPayload } from '@localqa/storage';
import { evaluateTargetGrant } from '../dist/action-grant.js';
import {
  SAVED_VALUE_CONTAINMENT_MIN,
  inputValueOf,
  isHiddenInput,
  isSensitiveInput,
  matchesSavedCredential,
} from '../dist/signed-out-input.js';
import { savedValuesFromMaterial } from '../dist/auth-profile.js';
import { authProfileFixture } from './fixtures/auth-profile.mjs';

const savedPassword = 'SavedPass_123';
const savedUsername = 'qa-user@example.test';

function snapshotNode(overrides = {}) {
  return {
    nodeId: 'password-field',
    frameId: 'main',
    role: 'password',
    inputType: 'password',
    sensitive: true,
    name: '密码',
    text: '[redacted]',
    visible: true,
    enabled: true,
    bounds: { left: 0, top: 0, width: 100, height: 30 },
    ...overrides,
  };
}

function addSnapshot(fixture, nodes) {
  const snapshot = parseContract('BrowserSnapshot', {
    snapshotId: randomUUID(),
    pageId: randomUUID(),
    frameIds: ['main'],
    displayUrl: 'https://fixture.test/login',
    title: 'Login',
    responseStatus: 200,
    capturedAt: new Date().toISOString(),
    stateVersion: 1,
    viewport: { width: 800, height: 600 },
    nodes,
    screenshotRef: null,
    networkSummary: [],
    consoleSummary: [],
    truncated: false,
    redacted: true,
  });
  fixture.auth.snapshots.set(snapshot.snapshotId, snapshot);
  return snapshot;
}

const targetFor = (snapshot, nodeId) => ({
  snapshotId: snapshot.snapshotId,
  pageId: snapshot.pageId,
  nodeId,
  frameId: 'main',
});

function savedFixture({
  executionMode = 'smoke',
  material,
  realTx = true,
} = {}) {
  // Run the real Coordinator.tx error mapping: a DomainError thrown inside the
  // grant used to be rewritten to VALIDATION_ERROR, hiding the refusal code.
  const fixture = authProfileFixture({ executionMode, realTx });
  fixture.auth.versions.get(1).material = material ?? {
    username: savedUsername,
    password: savedPassword,
  };
  return fixture;
}

function signedOutFixture(options) {
  const fixture = savedFixture(options);
  fixture.state.cases.get(fixture.task.case_id).requiresLogin = false;
  return fixture;
}

function importedAuth(fixture) {
  fixture.auth.scope = {
    status: 'granted',
    current_state_id: randomUUID(),
    context_version: fixture.run.contextVersion,
    auth_epoch: 1,
    auth_profile_id: fixture.auth.profileId,
    auth_profile_version: 1,
  };
}

function signedInAuth(fixture) {
  importedAuth(fixture);
  fixture.auth.sessions.set(randomUUID(), {
    task_id: fixture.task.id,
    fencing_token: String(fixture.proof.fencingToken),
    context_version: fixture.run.contextVersion,
    context_id: fixture.task.result.authContextId,
    auth_profile_id: fixture.auth.profileId,
    auth_profile_version: 1,
    auth_epoch: 1,
    status: 'ended',
    end_reason: 'signed_in',
  });
}

const typed = (fixture, snapshot, text, nodeId = 'password-field') =>
  fixture.coordinator.grantAction(fixture.scope, fixture.proof, {
    name: 'type_text',
    args: { target: targetFor(snapshot, nodeId), text },
  });

const credentialRead = (fixture) =>
  fixture.auth.queries.some(({ sql }) => sql.includes('AS frozen_version'));

test('the saved-credential match rule is exact and bounded', () => {
  assert.equal(matchesSavedCredential('', [savedPassword]), false);
  assert.equal(matchesSavedCredential(savedPassword, [savedPassword]), true);
  assert.equal(
    matchesSavedCredential(`x-${savedPassword}-y`, [savedPassword]),
    true,
  );
  assert.equal(matchesSavedCredential(savedPassword, ['other', 'x']), false);
  // Case sensitive: a different casing is not the saved password.
  assert.equal(
    matchesSavedCredential(savedPassword.toLowerCase(), [savedPassword]),
    false,
  );
  // A short saved value only matches by equality, never as a substring.
  assert.equal(matchesSavedCredential('ab', ['ab']), true);
  assert.equal(matchesSavedCredential('xaby', ['ab']), false);
  assert.equal(
    matchesSavedCredential('x'.repeat(SAVED_VALUE_CONTAINMENT_MIN - 1), [
      'x'.repeat(SAVED_VALUE_CONTAINMENT_MIN - 1),
    ]),
    true,
  );
  assert.equal(
    matchesSavedCredential(`a${'y'.repeat(SAVED_VALUE_CONTAINMENT_MIN)}b`, [
      'y'.repeat(SAVED_VALUE_CONTAINMENT_MIN),
    ]),
    true,
  );
});

test('node classification and input extraction cover every released tool', () => {
  assert.equal(isHiddenInput({ inputType: 'hidden' }), true);
  assert.equal(isHiddenInput({ role: 'hidden' }), true);
  assert.equal(isHiddenInput({ inputType: 'password' }), false);
  assert.equal(isSensitiveInput({ sensitive: true }), true);
  assert.equal(isSensitiveInput({ inputType: 'password' }), true);
  assert.equal(isSensitiveInput({ inputType: 'text' }), false);
  assert.equal(
    inputValueOf({ name: 'type_text', args: { target: {}, text: 'abc' } }),
    'abc',
  );
  assert.equal(
    inputValueOf({ name: 'select_option', args: { target: {}, value: 'v' } }),
    'v',
  );
  assert.equal(inputValueOf({ name: 'click', args: { target: {} } }), null);
  assert.equal(
    inputValueOf({ name: 'press', args: { target: {}, key: 'Tab' } }),
    null,
  );
});

test('material values are flattened, including a JSON storage state', () => {
  assert.deepEqual(
    savedValuesFromMaterial({
      username: savedUsername,
      password: savedPassword,
    }),
    [savedUsername, savedPassword],
  );
  assert.deepEqual(savedValuesFromMaterial({ VAR: 'v1', OTHER: 'v2' }), [
    'v1',
    'v2',
  ]);
  const state = JSON.stringify({
    cookies: [{ name: 'sid', value: 'cookie-value' }],
    origins: [
      {
        origin: 'https://fixture.test',
        localStorage: [{ name: 'k', value: 'stored' }],
      },
    ],
  });
  const values = savedValuesFromMaterial({ storageState: state });
  assert.ok(values.includes(state));
  assert.ok(values.includes('cookie-value'));
  assert.ok(values.includes('stored'));
  assert.deepEqual(savedValuesFromMaterial(null), []);
  assert.deepEqual(savedValuesFromMaterial({ empty: '' }), []);
});

test('a signed-out session case may type a fictional test value into a password box', async () => {
  const fixture = signedOutFixture();
  const snapshot = addSnapshot(fixture, [snapshotNode()]);
  const grant = await typed(fixture, snapshot, 'WrongPwd_123');
  assert.equal(grant.call.name, 'type_text');
  assert.equal(grant.call.args.text, 'WrongPwd_123');
  assert.ok(credentialRead(fixture), 'saved values must be compared first');
});

test('a signed-out session case may click a password box but not a hidden input', async () => {
  const fixture = signedOutFixture();
  const snapshot = addSnapshot(fixture, [
    snapshotNode(),
    snapshotNode({
      nodeId: 'hidden-field',
      inputType: 'hidden',
      sensitive: false,
    }),
  ]);
  const grant = await fixture.coordinator.grantAction(
    fixture.scope,
    fixture.proof,
    { name: 'click', args: { target: targetFor(snapshot, 'password-field') } },
  );
  assert.equal(grant.call.name, 'click');
  await assert.rejects(
    fixture.coordinator.grantAction(fixture.scope, fixture.proof, {
      name: 'type_text',
      args: {
        target: targetFor(snapshot, 'hidden-field'),
        text: 'WrongPwd_123',
      },
    }),
    (error) => error.code === 'HIDDEN_INPUT_FORBIDDEN',
  );
});

test('typing the saved password, an echoed account or a value containing it is refused', async (t) => {
  const warn = t.mock.method(console, 'warn');
  for (const text of [
    savedPassword,
    `prefix-${savedPassword}-suffix`,
    savedUsername,
  ]) {
    const fixture = signedOutFixture();
    const snapshot = addSnapshot(fixture, [snapshotNode()]);
    await assert.rejects(typed(fixture, snapshot, text), (error) => {
      assert.equal(error.code, 'SAVED_CREDENTIAL_INPUT');
      assert.ok(!JSON.stringify(error).includes(text));
      return true;
    });
  }
  assert.ok(warn.mock.calls.length >= 3);
  const logged = warn.mock.calls
    .map((call) => String(call.arguments[0]))
    .join('\n');
  assert.match(logged, /SAVED_CREDENTIAL_INPUT/);
  assert.ok(!logged.includes(savedPassword));
  assert.ok(!logged.includes(savedUsername));
});

test('a short saved value only refuses equality, never a substring match', async () => {
  const fixture = signedOutFixture({
    material: { username: 'u', password: 'ab' },
  });
  const snapshot = addSnapshot(fixture, [snapshotNode()]);
  await assert.rejects(
    typed(fixture, snapshot, 'ab'),
    (error) => error.code === 'SAVED_CREDENTIAL_INPUT',
  );
  const grant = await typed(fixture, snapshot, 'xaby');
  assert.equal(grant.call.args.text, 'xaby');
});

test('both the current profile version and the frozen run version are compared', async () => {
  const fixture = signedOutFixture();
  fixture.auth.head = 2;
  fixture.auth.versions.set(2, {
    document: { ...fixture.auth.versions.get(1).document, version: 2 },
    secret_id: randomUUID(),
    secret_version: 1,
    material: {
      username: 'current-user@example.test',
      password: 'CurrentPass_2',
    },
  });
  const snapshot = addSnapshot(fixture, [snapshotNode()]);
  await assert.rejects(
    typed(fixture, snapshot, 'CurrentPass_2'),
    (error) => error.code === 'SAVED_CREDENTIAL_INPUT',
  );
  await assert.rejects(
    typed(fixture, snapshot, savedPassword),
    (error) => error.code === 'SAVED_CREDENTIAL_INPUT',
  );
  const grant = await typed(fixture, snapshot, 'WrongPwd_123');
  assert.equal(grant.call.name, 'type_text');
});

test('a signed-in case, an explorer and a regression run still refuse password input', async () => {
  // Signed-in case of the same session smoke run.
  const signedIn = savedFixture();
  signedInAuth(signedIn);
  const signedInSnapshot = addSnapshot(signedIn, [snapshotNode()]);
  await assert.rejects(
    typed(signedIn, signedInSnapshot, 'WrongPwd_123'),
    (error) => error.code === 'SENSITIVE_INPUT_FORBIDDEN',
  );
  assert.equal(credentialRead(signedIn), false);

  // A signed-out exploration: the explorer is anonymous here (a signed-in one
  // signs in itself), so it still may not type a password.
  const explorer = savedFixture();
  importedAuth(explorer);
  explorer.bindTask(
    explorer.addJob(null, {
      role: 'explorer',
      stage: 'explore',
      status: 'running',
      result: { signedOut: true },
    }),
  );
  const explorerSnapshot = addSnapshot(explorer, [snapshotNode()]);
  await assert.rejects(
    typed(explorer, explorerSnapshot, 'WrongPwd_123'),
    (error) => error.code === 'SENSITIVE_INPUT_FORBIDDEN',
  );
  assert.equal(credentialRead(explorer), false);

  // Regression run: session-managed smoke runs are the only released lane.
  const regression = signedOutFixture({ executionMode: 'regression' });
  importedAuth(regression);
  const regressionSnapshot = addSnapshot(regression, [snapshotNode()]);
  await assert.rejects(
    typed(regression, regressionSnapshot, 'WrongPwd_123'),
    (error) => error.code === 'SENSITIVE_INPUT_FORBIDDEN',
  );
  assert.equal(credentialRead(regression), false);
});

test('an unreadable bound secret fails closed instead of allowing the input', async () => {
  const fixture = signedOutFixture();
  fixture.auth.versions.get(1).secret_id = null;
  fixture.auth.versions.get(1).secret_version = null;
  const snapshot = addSnapshot(fixture, [snapshotNode()]);
  // No secret on either version means no saved credential at all: allowed.
  const grant = await typed(fixture, snapshot, 'WrongPwd_123');
  assert.equal(grant.call.name, 'type_text');

  const missing = signedOutFixture();
  missing.auth.missingSecrets.add(missing.auth.versions.get(1).secret_id);
  const missingSnapshot = addSnapshot(missing, [snapshotNode()]);
  await assert.rejects(
    typed(missing, missingSnapshot, 'WrongPwd_123'),
    (error) => error.code === 'AUTH_FAILED',
  );
});

test('ordinary text fields and observe keep their existing allowance', async () => {
  const fixture = signedOutFixture();
  const snapshot = addSnapshot(fixture, [
    snapshotNode({
      nodeId: 'user-field',
      role: 'textbox',
      inputType: 'text',
      sensitive: false,
    }),
  ]);
  const grant = await typed(fixture, snapshot, savedUsername, 'user-field');
  assert.equal(grant.call.name, 'type_text');
  // The released lane is about password/sensitive nodes: a text field never
  // triggers a credential read (unchanged behavior).
  assert.equal(credentialRead(fixture), false);
});

test('a stale target snapshot is a version conflict, not a policy denial', async () => {
  const fixture = signedOutFixture();
  const nodes = [
    snapshotNode({
      nodeId: 'account-field',
      role: 'text',
      inputType: 'text',
      sensitive: false,
      name: '账号',
    }),
    snapshotNode(),
  ];
  const observed = addSnapshot(fixture, nodes);
  const afterAccount = addSnapshot(fixture, nodes);
  const account = await typed(
    fixture,
    observed,
    'WrongUser_123',
    'account-field',
  );
  assert.equal(account.call.name, 'type_text');
  // The account action advanced the ledger to its post-action snapshot.
  fixture.auth.latestSnapshot = afterAccount;
  await assert.rejects(
    typed(fixture, observed, 'WrongPwd_123', 'password-field'),
    (error) => {
      assert.equal(error.code, 'VERSION_CONFLICT');
      assert.deepEqual(error.denial, { role: 'password', name: '密码' });
      assert.equal(JSON.stringify(error).includes('WrongPwd_123'), false);
      return true;
    },
  );
  // A fresh observation makes the same action valid again.
  const observedAgain = addSnapshot(fixture, nodes);
  fixture.auth.latestSnapshot = observedAgain;
  const retry = await typed(
    fixture,
    observedAgain,
    'WrongPwd_123',
    'password-field',
  );
  assert.equal(retry.call.args.text, 'WrongPwd_123');
});

test('each grant refusal carries its own reason code', async () => {
  const fixture = signedOutFixture();
  const snapshot = addSnapshot(fixture, [
    snapshotNode({
      nodeId: 'account-field',
      role: 'text',
      inputType: 'text',
      sensitive: false,
      name: '账号',
    }),
    snapshotNode(),
    snapshotNode({
      nodeId: 'hidden-field',
      inputType: 'hidden',
      sensitive: false,
    }),
    snapshotNode({
      nodeId: 'invisible-node',
      role: 'text',
      inputType: 'text',
      sensitive: false,
      name: '不可见',
      visible: false,
    }),
    snapshotNode({
      nodeId: 'disabled-node',
      role: 'text',
      inputType: 'text',
      sensitive: false,
      name: '禁用',
      enabled: false,
    }),
    snapshotNode({
      nodeId: 'submit-node',
      role: 'button',
      inputType: 'submit',
      sensitive: false,
      name: '登录',
      text: '登录',
    }),
  ]);
  const deny = async (call, code) => {
    await assert.rejects(
      fixture.coordinator.grantAction(fixture.scope, fixture.proof, call),
      (error) => {
        assert.equal(error.code, code);
        return true;
      },
    );
  };
  const target = (nodeId) => targetFor(snapshot, nodeId);
  await deny(
    { name: 'type_text', args: { target: target('missing'), text: 'x' } },
    'TARGET_NOT_FOUND',
  );
  await deny(
    {
      name: 'type_text',
      args: {
        target: { ...target('account-field'), pageId: randomUUID() },
        text: 'x',
      },
    },
    'TARGET_NOT_FOUND',
  );
  await deny(
    {
      name: 'type_text',
      args: { target: target('invisible-node'), text: 'x' },
    },
    'TARGET_HIDDEN',
  );
  await deny(
    { name: 'type_text', args: { target: target('disabled-node'), text: 'x' } },
    'TARGET_DISABLED',
  );
  await deny(
    { name: 'type_text', args: { target: target('hidden-field'), text: 'x' } },
    'HIDDEN_INPUT_FORBIDDEN',
  );
  await deny(
    { name: 'press', args: { target: target('account-field'), key: 'Enter' } },
    'OUT_OF_SCOPE_MUTATION',
  );
  await deny(
    { name: 'click', args: { target: target('submit-node') } },
    'OUT_OF_SCOPE_MUTATION',
  );
  // A signed-in case keeps the original sensitive-input refusal.
  const signedIn = savedFixture();
  signedInAuth(signedIn);
  const signedInSnapshot = addSnapshot(signedIn, [snapshotNode()]);
  await assert.rejects(
    typed(signedIn, signedInSnapshot, 'WrongPwd_123'),
    (error) => error.code === 'SENSITIVE_INPUT_FORBIDDEN',
  );
});

test('Coordinator.tx preserves an action-denial code instead of VALIDATION_ERROR', async () => {
  const fixture = savedFixture();
  await assert.rejects(
    fixture.coordinator.tx(async () => {
      throw new DomainError('OUT_OF_SCOPE_MUTATION');
    }),
    (error) => {
      assert.equal(error.code, 'OUT_OF_SCOPE_MUTATION');
      assert.ok(error instanceof StorageError);
      return true;
    },
  );
  // An unrelated DomainError keeps the old conservative mapping.
  await assert.rejects(
    fixture.coordinator.tx(async () => {
      throw new DomainError('SOMETHING_UNEXPECTED');
    }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});

const press = (fixture, snapshot, key = 'Enter', nodeId = 'password-field') =>
  fixture.coordinator.grantAction(fixture.scope, fixture.proof, {
    name: 'press',
    args: { target: targetFor(snapshot, nodeId), key },
  });

test('a plain Enter in a signed-out case follows the equivalent button', async () => {
  const fixture = signedOutFixture();
  const snapshot = addSnapshot(fixture, [
    snapshotNode({ enterButtonNodeId: 'login-button' }),
    snapshotNode({
      nodeId: 'login-button',
      role: 'button',
      inputType: 'button',
      sensitive: false,
      name: '登录',
      text: '登录',
    }),
  ]);
  const grant = await press(fixture, snapshot);
  assert.equal(grant.call.name, 'press');
  assert.equal(grant.call.args.key, 'Enter');
});

test('a plain Enter whose equivalent button mutates business data is refused', async () => {
  for (const button of [
    {
      nodeId: 'save-button',
      role: 'button',
      inputType: 'button',
      sensitive: false,
      name: '保存',
      text: '保存',
    },
    {
      nodeId: 'submit-button',
      role: 'button',
      inputType: 'submit',
      sensitive: false,
      name: '登录',
      text: '登录',
    },
    {
      nodeId: 'delete-button',
      role: 'button',
      inputType: 'button',
      sensitive: false,
      name: '删除',
      text: '删除',
    },
  ]) {
    const fixture = signedOutFixture();
    const snapshot = addSnapshot(fixture, [
      snapshotNode({ enterButtonNodeId: button.nodeId }),
      snapshotNode(button),
    ]);
    await assert.rejects(press(fixture, snapshot), (error) => {
      assert.equal(error.code, 'OUT_OF_SCOPE_MUTATION');
      assert.deepEqual(error.denial.enterButton, {
        role: button.role,
        name: button.name,
      });
      assert.equal(JSON.stringify(error).includes('WrongPwd'), false);
      return true;
    });
  }
});

test('a plain Enter without a usable equivalent button is refused', async () => {
  const cases = [
    // The snapshot recorded no equivalent button.
    [snapshotNode()],
    // The field points at a node that is not in the snapshot.
    [snapshotNode({ enterButtonNodeId: 'missing-button' })],
    // The recorded button is hidden.
    [
      snapshotNode({ enterButtonNodeId: 'hidden-button' }),
      snapshotNode({
        nodeId: 'hidden-button',
        role: 'button',
        inputType: 'button',
        sensitive: false,
        name: '登录',
        text: '登录',
        visible: false,
      }),
    ],
    // The recorded button is disabled.
    [
      snapshotNode({ enterButtonNodeId: 'disabled-button' }),
      snapshotNode({
        nodeId: 'disabled-button',
        role: 'button',
        inputType: 'button',
        sensitive: false,
        name: '登录',
        text: '登录',
        enabled: false,
      }),
    ],
  ];
  for (const nodes of cases) {
    const fixture = signedOutFixture();
    const snapshot = addSnapshot(fixture, nodes);
    await assert.rejects(
      press(fixture, snapshot),
      (error) => error.code === 'OUT_OF_SCOPE_MUTATION',
    );
  }
});

test('a plain Enter on a button-like target follows its own click rule', async () => {
  for (const [node, allowed] of [
    [
      {
        nodeId: 'login-button',
        role: 'button',
        inputType: 'button',
        sensitive: false,
        name: '登录',
        text: '登录',
      },
      true,
    ],
    [
      {
        nodeId: 'delete-button',
        role: 'button',
        inputType: 'button',
        sensitive: false,
        name: '删除',
        text: '删除',
      },
      false,
    ],
  ]) {
    const fixture = signedOutFixture();
    const snapshot = addSnapshot(fixture, [snapshotNode(node)]);
    const attempt = press(fixture, snapshot, 'Enter', node.nodeId);
    if (allowed) assert.equal((await attempt).call.name, 'press');
    else
      await assert.rejects(
        attempt,
        (error) => error.code === 'OUT_OF_SCOPE_MUTATION',
      );
  }
});

test('modifier combinations stay refused and Space keeps the old grant behavior', async () => {
  const fixture = signedOutFixture();
  const snapshot = addSnapshot(fixture, [
    snapshotNode({ enterButtonNodeId: 'login-button' }),
    snapshotNode({
      nodeId: 'login-button',
      role: 'button',
      inputType: 'button',
      sensitive: false,
      name: '登录',
      text: '登录',
    }),
  ]);
  const evaluate = (key) =>
    evaluateTargetGrant({
      target: targetFor(snapshot, 'password-field'),
      owned: snapshot,
      latestResultHash: hashPayload({
        status: 'succeeded',
        snapshot,
        evidence: [],
      }),
      call: {
        name: 'press',
        args: { target: targetFor(snapshot, 'password-field'), key },
      },
      signedOutCase: true,
      actionPolicy: 'non_submitting',
      writeScope: [],
    });
  assert.equal(evaluate('Control+Enter').denial, 'OUT_OF_SCOPE_MUTATION');
  assert.equal(evaluate('Shift+Enter').denial, 'OUT_OF_SCOPE_MUTATION');
  // Space is not blocked by the grant; the browser layer refuses it.
  assert.equal(evaluate('Space').denial, null);
});

test('an explorer still gets the sensitive-input refusal before the Enter rule', async () => {
  const fixture = savedFixture();
  importedAuth(fixture);
  fixture.bindTask(
    fixture.addJob(null, {
      role: 'explorer',
      stage: 'explore',
      status: 'running',
      result: { signedOut: true },
    }),
  );
  const snapshot = addSnapshot(fixture, [
    snapshotNode({ enterButtonNodeId: 'login-button' }),
    snapshotNode({
      nodeId: 'login-button',
      role: 'button',
      inputType: 'button',
      sensitive: false,
      name: '登录',
      text: '登录',
    }),
  ]);
  await assert.rejects(
    press(fixture, snapshot),
    (error) => error.code === 'SENSITIVE_INPUT_FORBIDDEN',
  );
});
