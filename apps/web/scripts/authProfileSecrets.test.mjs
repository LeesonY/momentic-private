// Offline credential replacement: real form/page handlers and mock client,
// without a browser, network, database or stored credential values.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import * as secrets from '../src/components/environments/authProfileSecrets.ts';
import { MockApiClient } from '../src/mocks/mockClient.ts';
import { HttpApiClient } from '../src/api/client.ts';
import { MOCK_PROJECT_ID, mockAuthProfiles } from '../src/mocks/data.ts';

const formProfile = (overrides = {}) => ({
  id: '10000000-0000-4000-8000-000000000001',
  projectId: MOCK_PROJECT_ID,
  environmentId: null,
  name: '测试登录配置',
  mode: 'form',
  allowedOrigins: ['http://localhost:8080'],
  sharingPolicy: 'exclusive_run',
  hasSecret: true,
  version: 4,
  status: 'active',
  formConfig: { loginUrl: 'http://localhost:8080/login', detectionMode: 'ai' },
  ...overrides,
});
const agentProfile = (overrides = {}) =>
  formProfile({
    mode: 'agent',
    formConfig: null,
    agentConfig: {
      instructions: '使用 ACCOUNT 和 SECRET 登录，选择 TENANT。',
      variables: [
        { name: 'ACCOUNT', sensitive: false, note: '登录账号' },
        { name: 'SECRET', sensitive: true, note: '登录密码' },
        { name: 'TENANT', sensitive: false },
      ],
    },
    ...overrides,
  });
const suppliedVariables = (profile = agentProfile()) =>
  secrets
    .emptyAgentVariables(profile.agentConfig.variables)
    .map((variable, i) => ({
      ...variable,
      value: `fresh-test-value-${i}`,
    }));
const environment = {
  id: '20000000-0000-4000-8000-000000000001',
  projectId: MOCK_PROJECT_ID,
  name: '测试环境',
  baseUrl: 'http://localhost:8080',
  allowedOrigins: ['http://localhost:8080'],
  defaultAuthProfileId: null,
  version: 2,
};

test('agent drafts copy public metadata and always start with empty values', () => {
  const profile = agentProfile();
  const drafts = secrets.emptyAgentVariables(profile.agentConfig.variables);
  assert.deepEqual(drafts, [
    { name: 'ACCOUNT', sensitive: false, note: '登录账号', value: '' },
    { name: 'SECRET', sensitive: true, note: '登录密码', value: '' },
    { name: 'TENANT', sensitive: false, note: '', value: '' },
  ]);
  assert.ok(
    profile.agentConfig.variables.every((variable) => !('value' in variable)),
  );
});

test('only active agent/form profiles with existing configuration are editable', () => {
  assert.equal(secrets.canEditAuthSecrets(agentProfile()), true);
  assert.equal(secrets.canEditAuthSecrets(formProfile()), true);
  for (const status of ['revoked', 'disabled', 'pending']) {
    assert.equal(secrets.canEditAuthSecrets(formProfile({ status })), false);
    assert.equal(secrets.canEditAuthSecrets(agentProfile({ status })), false);
  }
  for (const mode of ['none', 'storage_state'])
    assert.equal(secrets.canEditAuthSecrets(formProfile({ mode })), false);
  assert.equal(
    secrets.canEditAuthSecrets(formProfile({ formConfig: null })),
    false,
  );
  assert.equal(
    secrets.canEditAuthSecrets(agentProfile({ agentConfig: null })),
    false,
  );
});

test('agent replacement sends exactly declared values and the opened version', () => {
  const profile = agentProfile();
  const before = structuredClone(profile);
  const patch = secrets.authSecretPatch(
    profile,
    suppliedVariables(profile),
    '',
    '',
  );
  assert.deepEqual(patch, {
    expectedVersion: 4,
    secretInput: {
      ACCOUNT: 'fresh-test-value-0',
      SECRET: 'fresh-test-value-1',
      TENANT: 'fresh-test-value-2',
    },
  });
  assert.deepEqual(profile, before);
});

test('every agent value is required; blank never means keep the old value', () => {
  const profile = agentProfile();
  for (let index = 0; index < profile.agentConfig.variables.length; index++) {
    const variables = suppliedVariables(profile);
    variables[index].value = '';
    assert.throws(() => secrets.authSecretPatch(profile, variables, '', ''));
  }
});

test('agent replacement cannot add, drop or rename existing variables', () => {
  const profile = agentProfile();
  const variables = suppliedVariables(profile);
  for (const changed of [
    variables.slice(1),
    [...variables, { name: 'EXTRA', sensitive: false, note: '', value: 'new' }],
    variables.map((variable, i) =>
      i === 0 ? { ...variable, name: 'RENAMED' } : variable,
    ),
  ])
    assert.throws(() => secrets.authSecretPatch(profile, changed, '', ''));
});

test('shared agent validation covers names, duplicates and list boundaries', () => {
  const draft = (name) => ({ name, value: 'new', sensitive: false, note: '' });
  for (const name of ['A', 'A_1', 'A'.repeat(64)])
    assert.deepEqual(Object.keys(secrets.agentSecretInput([draft(name)])), [
      name,
    ]);
  for (const name of ['', '1A', 'lower', 'A-B', '账号', 'A'.repeat(65)])
    assert.throws(() => secrets.agentSecretInput([draft(name)]));
  assert.throws(() => secrets.agentSecretInput([]));
  assert.throws(() => secrets.agentSecretInput([draft('A'), draft(' A ')]));
  const twenty = Array.from({ length: 20 }, (_, i) => draft(`V${i}`));
  assert.equal(Object.keys(secrets.agentSecretInput(twenty)).length, 20);
  assert.throws(() => secrets.agentSecretInput([...twenty, draft('EXTRA')]));
});

test('form replacement requires both username and password', () => {
  for (const [username, password] of [
    ['', ''],
    ['new-account', ''],
    ['', 'new-value'],
  ])
    assert.throws(() =>
      secrets.authSecretPatch(formProfile(), [], username, password),
    );
  assert.deepEqual(
    secrets.authSecretPatch(formProfile(), [], 'new-account', 'new-value'),
    {
      expectedVersion: 4,
      secretInput: { username: 'new-account', password: 'new-value' },
    },
  );
});

test('AI and manual forms reuse the same secret input without changing locators', () => {
  for (const detectionMode of ['ai', 'manual']) {
    const profile = formProfile({
      formConfig: { ...formProfile().formConfig, detectionMode },
    });
    const before = structuredClone(profile);
    assert.deepEqual(
      Object.keys(secrets.authSecretPatch(profile, [], 'new', 'value')),
      ['expectedVersion', 'secretInput'],
    );
    assert.deepEqual(profile, before);
  }
});

test('secret values preserve whitespace, Unicode and special characters verbatim', () => {
  const username = ' 新账号+@ ';
  const password = ' 新值 &<>"\\\n ';
  assert.deepEqual(secrets.formSecretInput(username, password), {
    username,
    password,
  });
  assert.deepEqual(
    secrets.agentSecretInput([{ name: 'TOKEN', value: password }]),
    {
      TOKEN: password,
    },
  );
  assert.deepEqual(secrets.formSecretInput(' ', ' '), {
    username: ' ',
    password: ' ',
  });
});

test('secret length boundaries match the contract for creation and replacement', () => {
  const limit = 'x'.repeat(secrets.MAX_AUTH_SECRET_LENGTH);
  assert.equal(
    secrets.formSecretInput('u', limit).password.length,
    limit.length,
  );
  assert.equal(
    secrets.agentSecretInput([{ name: 'TOKEN', value: limit }]).TOKEN.length,
    limit.length,
  );
  assert.throws(() => secrets.formSecretInput('u', `${limit}x`));
  assert.throws(() => secrets.formSecretInput(`${limit}x`, 'p'));
  assert.throws(() =>
    secrets.agentSecretInput([{ name: 'TOKEN', value: `${limit}x` }]),
  );
});

test('conflicts are localized and every other diagnostic is suppressed', () => {
  for (const reason of [
    { code: 'VERSION_CONFLICT' },
    { status: 409 },
    new Error('VERSION_CONFLICT'),
  ])
    assert.equal(
      secrets.authSecretUpdateError(reason),
      '配置已被修改，请刷新后重试',
    );
  for (const reason of [
    null,
    'unsafe diagnostic',
    new Error('unsafe diagnostic'),
    { status: 500 },
  ]) {
    const message = secrets.authSecretUpdateError(reason);
    assert.equal(message, '保存失败，请完整填写所有新值后重试。');
    assert.ok(!message.includes('unsafe diagnostic'));
  }
});

test('unsupported and revoked profiles cannot produce a replacement patch', () => {
  for (const profile of [
    formProfile({ mode: 'none' }),
    formProfile({ mode: 'storage_state' }),
    agentProfile({ status: 'revoked' }),
  ])
    assert.throws(() =>
      secrets.authSecretPatch(profile, suppliedVariables(), 'new', 'value'),
    );
});

const assertNoSecrets = (client, profile, values) => {
  for (const field of [
    'secretInput',
    'expectedVersion',
    'revoke',
    'username',
    'password',
  ])
    assert.equal(field in profile, false);
  const serialized = JSON.stringify(client);
  for (const value of values) assert.ok(!serialized.includes(value));
};

test('mock fixtures use the current project and contain public metadata only', () => {
  for (const profile of mockAuthProfiles) {
    assert.equal(profile.projectId, MOCK_PROJECT_ID);
    assert.equal('secretInput' in profile, false);
    assert.equal('password' in profile, false);
  }
});

test('mock replacement persists the same id at version +1 without retaining values', async () => {
  const client = new MockApiClient();
  const before = (await client.listAuthProfiles(MOCK_PROJECT_ID)).items;
  const profile = before.find((item) => item.mode === 'form');
  const values = ['fresh-mock-account', 'fresh-mock-value'];
  const saved = await client.updateAuthProfile(profile.id, {
    expectedVersion: profile.version,
    secretInput: { username: values[0], password: values[1] },
  });
  assert.equal(saved.id, profile.id);
  assert.equal(saved.version, profile.version + 1);
  assert.equal(saved.hasSecret, true);
  assert.deepEqual(saved.formConfig, profile.formConfig);
  assert.deepEqual(saved.allowedOrigins, profile.allowedOrigins);
  const listed = (await client.listAuthProfiles(MOCK_PROJECT_ID)).items;
  assert.equal(listed.length, before.length);
  assert.deepEqual(
    listed.find((item) => item.id === saved.id),
    saved,
  );
  assertNoSecrets(client, saved, values);
});

test('mock conflict preserves the latest version and exposes a structured code', async () => {
  const client = new MockApiClient();
  const profile = (await client.listAuthProfiles(MOCK_PROJECT_ID)).items.find(
    (item) => item.mode === 'form',
  );
  await client.updateAuthProfile(profile.id, {
    expectedVersion: profile.version,
    name: '新名称',
  });
  await assert.rejects(
    client.updateAuthProfile(profile.id, {
      expectedVersion: profile.version,
      secretInput: { username: 'new', password: 'value' },
    }),
    (reason) =>
      reason.code === 'VERSION_CONFLICT' &&
      reason.status === 409 &&
      secrets.authSecretUpdateError(reason) === '配置已被修改，请刷新后重试',
  );
  const listed = (await client.listAuthProfiles(MOCK_PROJECT_ID)).items.find(
    (item) => item.id === profile.id,
  );
  assert.equal(listed.version, profile.version + 1);
  assert.equal(listed.name, '新名称');
});

test('mock agent creation retains declarations, not values, and can be edited', async () => {
  const client = new MockApiClient();
  const source = agentProfile();
  const variables = suppliedVariables(source);
  const created = await client.createAuthProfile(MOCK_PROJECT_ID, {
    name: source.name,
    mode: 'agent',
    allowedOrigins: source.allowedOrigins,
    agentConfig: source.agentConfig,
    secretInput: secrets.agentSecretInput(variables),
  });
  assert.equal(created.hasSecret, true);
  assert.deepEqual(created.agentConfig, source.agentConfig);
  const saved = await client.updateAuthProfile(
    created.id,
    secrets.authSecretPatch(created, variables, '', ''),
  );
  assert.equal(saved.version, 2);
  assert.equal(saved.id, created.id);
  assertNoSecrets(
    client,
    saved,
    variables.map((variable) => variable.value),
  );
});

test('mock metadata updates and revocation never re-expose or erase a secret flag', async () => {
  const client = new MockApiClient();
  const profile = (await client.listAuthProfiles(MOCK_PROJECT_ID)).items.find(
    (item) => item.mode === 'form',
  );
  const saved = await client.updateAuthProfile(profile.id, {
    expectedVersion: profile.version,
    revoke: true,
  });
  assert.equal(saved.version, profile.version + 1);
  assert.equal(saved.status, 'revoked');
  assert.equal(saved.hasSecret, profile.hasSecret);
  assertNoSecrets(client, saved, []);
  await assert.rejects(
    client.updateAuthProfile(saved.id, {
      expectedVersion: saved.version,
      secretInput: { username: 'new', password: 'value' },
    }),
    /认证配置已撤销/,
  );
});

test('mock rejects unknown patch fields without retaining them', async () => {
  const client = new MockApiClient();
  const profile = (await client.listAuthProfiles(MOCK_PROJECT_ID)).items.find(
    (item) => item.mode === 'form',
  );
  await assert.rejects(
    client.updateAuthProfile(profile.id, {
      expectedVersion: profile.version,
      password: 'unexpected-write-only-value',
    }),
  );
  assertNoSecrets(client, profile, ['unexpected-write-only-value']);
});

const require = createRequire(new URL('../package.json', import.meta.url));
const { transformSync } = createRequire(require.resolve('vite'))('esbuild');

/** Evaluate the real TSX with inert UI wrappers and deterministic React hooks. */
const componentHarness = (
  path,
  exportName,
  imports,
  initialState = [],
  props = {},
) => {
  const hooks = [...initialState];
  let cursor = 0;
  let root;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in hooks))
      hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks[index],
      (value) => {
        hooks[index] =
          typeof value === 'function' ? value(hooks[index]) : value;
      },
    ];
  };
  const React = {
    Fragment: 'Fragment',
    createElement: (type, attributes, ...children) => ({
      type,
      props: { ...attributes, children },
    }),
    useState,
    useRef: (value) => useState(() => ({ current: value }))[0],
    useEffect: () => {},
  };
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(
    (specifier) => {
      if (specifier === 'react') return React;
      if (!(specifier in imports))
        throw new Error(`Unexpected offline import: ${specifier}`);
      return imports[specifier];
    },
    module,
    module.exports,
  );
  const render = () => {
    cursor = 0;
    root = module.exports[exportName](props);
    return root;
  };
  const nodes = () => {
    const result = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object' || !('type' in node)) return;
      result.push(node);
      walk(node.props.children);
      walk(node.props.footer);
    };
    walk(root);
    return result;
  };
  const find = (predicate) => {
    const found = nodes().filter(predicate);
    assert.equal(found.length, 1, 'expected exactly one matching element');
    return found[0];
  };
  const fireSubmit = () => {
    find((node) => node.type === 'form').props.onSubmit({
      preventDefault() {},
    });
    render();
  };
  render();
  return {
    render,
    nodes,
    find,
    fireSubmit,
    change: (selector, value) => {
      const node = find(
        typeof selector === 'string'
          ? (node) => node.props.id === selector
          : selector,
      );
      assert.notEqual(node.props.readOnly, true);
      assert.notEqual(node.props.disabled, true);
      node.props.onChange({ target: { value, checked: value } });
      render();
    },
    submit: async () => {
      fireSubmit();
      await nextTurn();
      render();
    },
    settle: async () => {
      await nextTurn();
      render();
    },
  };
};

const dialogHarness = (
  profile = formProfile(),
  client = {},
  overrides = {},
) => {
  const saved = [];
  const closed = [];
  const imports = {
    '../../api/index.ts': { defaultApiClient: client },
    './authProfileSecrets.ts': secrets,
    ...Object.fromEntries(
      ['Modal', 'Field', 'Alert', 'AppIcon'].map((name) => [
        `../ui/${name}.tsx`,
        { [name]: name },
      ]),
    ),
  };
  const harness = componentHarness(
    '../src/components/environments/AuthProfileDialog.tsx',
    'AuthProfileDialog',
    imports,
    [],
    {
      projectId: MOCK_PROJECT_ID,
      profile,
      onSaved: (...args) => saved.push(args),
      onClose: () => closed.push(true),
      ...overrides,
    },
  );
  return Object.assign(harness, { saved, closed });
};
const field = (id) => (node) => node.props.id === id;
const valueField = (name) => (node) =>
  node.props['aria-label'] === `${name} 的值`;

test('edit form renders empty, required, write-only fields and no configuration controls', () => {
  const harness = dialogHarness();
  const modal = harness.find((node) => node.type === 'Modal');
  assert.equal(modal.props.title, '修改账号/密码');
  assert.equal(modal.props.testId, 'edit-auth-profile-dialog');
  for (const id of ['auth-username', 'auth-password']) {
    const input = harness.find(field(id));
    assert.equal(input.props.value, '');
    assert.equal(input.props.required, true);
    assert.equal(input.props.maxLength, secrets.MAX_AUTH_SECRET_LENGTH);
  }
  assert.equal(harness.find(field('auth-password')).props.type, 'password');
  assert.equal(
    harness.find(field('auth-password')).props.autoComplete,
    'new-password',
  );
  for (const id of [
    'auth-profile-name',
    'auth-profile-mode',
    'auth-login-url',
    'auth-profile-origins',
    'auth-success-value',
  ])
    assert.ok(!harness.nodes().some(field(id)));
  const hint = harness.find(
    (node) => node.props['data-testid'] === 'auth-secret-replacement-hint',
  );
  assert.ok(hint.props.children.join('').includes('留空不能保留旧值'));
});

test('edit agent locks names, notes and sensitivity while rendering every blank value', () => {
  const profile = agentProfile();
  const harness = dialogHarness(profile);
  for (const variable of profile.agentConfig.variables) {
    const value = harness.find(valueField(variable.name));
    assert.equal(value.props.value, '');
    assert.equal(value.props.type, variable.sensitive ? 'password' : 'text');
    assert.equal(value.props.required, true);
  }
  for (const input of harness
    .nodes()
    .filter((node) => ['变量名', '备注'].includes(node.props['aria-label'])))
    assert.equal(input.props.readOnly, true);
  for (const input of harness
    .nodes()
    .filter((node) => node.type === 'input' && node.props.type === 'checkbox'))
    assert.equal(input.props.disabled, true);
  assert.ok(
    !harness
      .nodes()
      .some((node) => node.props['data-testid'] === 'agent-variable-add'),
  );
  assert.ok(!harness.nodes().some(field('agent-instructions')));
  assert.ok(!harness.nodes().some((node) => node.props.title === '删除变量'));
});

test('real form submission replaces the same id, blocks duplicates and clears before the response', async () => {
  const profile = formProfile();
  const calls = [];
  let resolveRequest;
  const harness = dialogHarness(profile, {
    updateAuthProfile: (id, patch) => {
      calls.push({ id, patch });
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    },
  });
  harness.change('auth-username', 'fresh-dialog-account');
  harness.change('auth-password', 'fresh-dialog-value');
  harness.fireSubmit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, profile.id);
  assert.deepEqual(calls[0].patch, {
    expectedVersion: profile.version,
    secretInput: {
      username: 'fresh-dialog-account',
      password: 'fresh-dialog-value',
    },
  });
  for (const id of ['auth-username', 'auth-password']) {
    assert.equal(harness.find(field(id)).props.value, '');
    assert.equal(harness.find(field(id)).props.disabled, true);
  }
  harness.fireSubmit();
  assert.equal(calls.length, 1);
  harness.find((node) => node.type === 'Modal').props.onClose();
  assert.equal(harness.closed.length, 0);
  resolveRequest({ ...profile, version: profile.version + 1 });
  await harness.settle();
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0][0].version, profile.version + 1);
  assert.equal(harness.saved[0][1], null);
  assert.equal(harness.saved[0][2], secrets.AUTH_SECRET_SAVED_NOTICE);
  assert.equal(harness.find(field('auth-password')).props.value, '');
});

test('real agent submission uses original declarations and clears every entered value', async () => {
  const profile = agentProfile();
  const calls = [];
  const harness = dialogHarness(profile, {
    updateAuthProfile: async (id, patch) => {
      calls.push({ id, patch });
      return { ...profile, version: profile.version + 1 };
    },
  });
  const variables = suppliedVariables(profile);
  for (const variable of variables)
    harness.change(valueField(variable.name), variable.value);
  await harness.submit();
  assert.equal(calls[0].id, profile.id);
  assert.deepEqual(
    calls[0].patch,
    secrets.authSecretPatch(profile, variables, '', ''),
  );
  assert.equal(harness.saved[0][0].id, profile.id);
  for (const variable of variables)
    assert.equal(harness.find(valueField(variable.name)).props.value, '');
});

test('real form validation blocks partial replacement and clears submitted drafts', async () => {
  for (const profile of [formProfile(), agentProfile()]) {
    let calls = 0;
    const harness = dialogHarness(profile, {
      updateAuthProfile: async () => {
        calls++;
      },
    });
    harness.change(
      profile.mode === 'agent' ? valueField('ACCOUNT') : 'auth-username',
      'new',
    );
    await harness.submit();
    assert.equal(calls, 0);
    assert.equal(harness.saved.length, 0);
    const error = harness.find((node) => node.type === 'Alert');
    assert.equal(
      error.props.children[0],
      '保存失败，请完整填写所有新值后重试。',
    );
    assert.equal(
      harness.find(
        profile.mode === 'agent'
          ? valueField('ACCOUNT')
          : field('auth-username'),
      ).props.value,
      '',
    );
  }
});

test('real conflict response is localized, leaves the dialog open and clears fields', async () => {
  const harness = dialogHarness(formProfile(), {
    updateAuthProfile: async () => {
      throw { code: 'VERSION_CONFLICT', message: 'unsafe diagnostic' };
    },
  });
  harness.change('auth-username', 'new');
  harness.change('auth-password', 'value');
  await harness.submit();
  const error = harness.find((node) => node.type === 'Alert');
  assert.equal(error.props.testId, 'auth-secret-edit-error');
  assert.equal(error.props.children[0], '配置已被修改，请刷新后重试');
  assert.equal(harness.saved.length, 0);
  assert.equal(harness.find(field('auth-password')).props.value, '');
});

test('real unexpected response never displays raw server diagnostics', async () => {
  const harness = dialogHarness(formProfile(), {
    updateAuthProfile: async () => {
      throw new Error('unsafe diagnostic');
    },
  });
  harness.change('auth-username', 'new');
  harness.change('auth-password', 'value');
  await harness.submit();
  assert.equal(
    harness.find((node) => node.type === 'Alert').props.children[0],
    '保存失败，请完整填写所有新值后重试。',
  );
  assert.equal(harness.find(field('auth-password')).props.value, '');
});

test('cancel clears values without making an API request', () => {
  const harness = dialogHarness(agentProfile());
  harness.change(valueField('SECRET'), 'fresh-cancel-value');
  harness.find((node) => node.type === 'Modal').props.onClose();
  harness.render();
  assert.equal(harness.closed.length, 1);
  assert.equal(harness.find(valueField('SECRET')).props.value, '');
});

test('real submission rejects a stale project selection before calling the API', async () => {
  let called = false;
  const harness = dialogHarness(
    formProfile(),
    {
      updateAuthProfile: async () => {
        called = true;
      },
    },
    { projectId: 'other-project' },
  );
  harness.change('auth-username', 'new');
  harness.change('auth-password', 'value');
  await harness.submit();
  assert.equal(called, false);
  assert.equal(harness.saved.length, 0);
  assert.equal(harness.find(field('auth-password')).props.value, '');
});

test('creation still uses AI form fields and assigns the first credential as default', async () => {
  let config;
  let environmentPatch;
  const created = formProfile({ version: 1, environmentId: environment.id });
  const harness = dialogHarness(
    undefined,
    {
      createAuthProfile: async (_projectId, input) => {
        config = input;
        return created;
      },
      updateEnvironment: async (id, patch) => {
        assert.equal(id, environment.id);
        environmentPatch = patch;
        return {
          ...environment,
          version: environment.version + 1,
          defaultAuthProfileId: created.id,
        };
      },
    },
    { profile: undefined, environment },
  );
  harness.change('auth-profile-mode', 'form');
  harness.change('auth-login-url', 'http://localhost:8080/login');
  harness.change('auth-username', 'fresh-created-account');
  harness.change('auth-password', 'fresh-created-value');
  await harness.submit();
  assert.deepEqual(config.secretInput, {
    username: 'fresh-created-account',
    password: 'fresh-created-value',
  });
  assert.equal(config.formConfig.detectionMode, 'ai');
  assert.deepEqual(environmentPatch, {
    expectedVersion: environment.version,
    defaultAuthProfileId: created.id,
  });
  assert.equal(harness.saved[0][1].defaultAuthProfileId, created.id);
  assert.equal(harness.find(field('auth-password')).props.value, '');
});

test('agent creation still offers editable declarations and clears all values', async () => {
  let config;
  const created = agentProfile({ version: 1 });
  const harness = dialogHarness(
    undefined,
    {
      createAuthProfile: async (_projectId, input) => {
        config = input;
        return created;
      },
    },
    {
      profile: undefined,
      environment: { ...environment, defaultAuthProfileId: 'existing-default' },
    },
  );
  assert.ok(
    harness
      .nodes()
      .some((node) => node.props['data-testid'] === 'agent-variable-add'),
  );
  harness.change(valueField('QA_USERNAME'), 'fresh-created-account');
  harness.change(valueField('QA_PASSWORD'), 'fresh-created-value');
  await harness.submit();
  assert.deepEqual(config.secretInput, {
    QA_USERNAME: 'fresh-created-account',
    QA_PASSWORD: 'fresh-created-value',
  });
  assert.equal(harness.saved[0][1], null);
  assert.equal(harness.find(valueField('QA_PASSWORD')).props.value, '');
});

test('a failed default assignment still reports creation success without retaining values', async () => {
  const created = agentProfile({ version: 1 });
  const harness = dialogHarness(
    undefined,
    {
      createAuthProfile: async () => created,
      updateEnvironment: async () => {
        throw new Error('offline failure');
      },
    },
    { profile: undefined, environment },
  );
  harness.change(valueField('QA_USERNAME'), 'new');
  harness.change(valueField('QA_PASSWORD'), 'value');
  await harness.submit();
  assert.equal(harness.saved[0][0], created);
  assert.equal(harness.saved[0][1], null);
  assert.ok(harness.saved[0][2].includes('凭据已保存，设为环境默认登录失败'));
  assert.equal(harness.find(valueField('QA_PASSWORD')).props.value, '');
});

const pageHarness = (profiles, canConfigure = true) => {
  const context = {
    currentProject: { id: MOCK_PROJECT_ID },
    currentUser: { id: 'owner', globalRole: 'admin' },
  };
  const imports = {
    '../api/index.ts': { defaultApiClient: {} },
    '../state/AppContext.tsx': { useAppContext: () => context },
    '../components/environments/authProfileSecrets.ts': secrets,
    '../components/layout/Page.tsx': { Page: 'Page' },
    ...Object.fromEntries(
      ['Alert', 'EmptyState', 'AppIcon', 'Modal'].map((name) => [
        `../components/ui/${name}.tsx`,
        { [name]: name },
      ]),
    ),
    ...Object.fromEntries(
      ['EnvironmentDialog', 'AuthProfileDialog'].map((name) => [
        `../components/environments/${name}.tsx`,
        { [name]: name },
      ]),
    ),
  };
  const harness = componentHarness(
    '../src/pages/EnvironmentsPage.tsx',
    'EnvironmentsPage',
    imports,
    [
      [{ ...environment, excludedPaths: [], tlsPolicy: 'strict' }],
      profiles,
      false,
      canConfigure,
      '',
    ],
  );
  return Object.assign(harness, { context });
};
const editButton = (id) => (node) =>
  node.props['data-testid'] === `btn-edit-auth-secret-${id}`;

test('page exposes credential editing only for supported active profiles', () => {
  const profiles = [
    formProfile({ id: 'form' }),
    agentProfile({ id: 'agent' }),
    formProfile({ id: 'revoked', status: 'revoked' }),
    agentProfile({ id: 'pending', status: 'pending' }),
    formProfile({ id: 'state', mode: 'storage_state' }),
    formProfile({ id: 'none', mode: 'none' }),
    agentProfile({ id: 'missing-agent', agentConfig: null }),
    formProfile({ id: 'missing-form', formConfig: null }),
  ];
  const harness = pageHarness(profiles);
  for (const id of ['form', 'agent'])
    assert.ok(harness.nodes().some(editButton(id)));
  for (const id of [
    'revoked',
    'pending',
    'state',
    'none',
    'missing-agent',
    'missing-form',
  ])
    assert.ok(!harness.nodes().some(editButton(id)));
});

test('page does not expose editing to users without configuration permission', () => {
  const profile = formProfile();
  assert.ok(
    !pageHarness([profile], false).nodes().some(editButton(profile.id)),
  );
});

test('page opens the existing unassigned profile with its id and version snapshot', () => {
  const profile = formProfile();
  const harness = pageHarness([profile]);
  harness.find(editButton(profile.id)).props.onClick();
  harness.render();
  const dialog = harness.find((node) => node.type === 'AuthProfileDialog');
  assert.equal(dialog.props.profile, profile);
  assert.equal(dialog.props.projectId, MOCK_PROJECT_ID);
  assert.equal(dialog.props.environment, undefined);
});

test('page saves in place, announces the new version and reopens with the latest version', () => {
  const profile = formProfile();
  const harness = pageHarness([profile]);
  harness.find(editButton(profile.id)).props.onClick();
  harness.render();
  const updated = { ...profile, version: profile.version + 1 };
  harness
    .find((node) => node.type === 'AuthProfileDialog')
    .props.onSaved(updated, null, secrets.AUTH_SECRET_SAVED_NOTICE);
  harness.render();
  assert.ok(!harness.nodes().some((node) => node.type === 'AuthProfileDialog'));
  const notice = harness.find(
    (node) => node.props.testId === 'auth-secret-saved-notice',
  );
  assert.equal(notice.props.tone, 'success');
  assert.equal(notice.props.role, 'status');
  assert.equal(notice.props.children[0], secrets.AUTH_SECRET_SAVED_NOTICE);
  const rows = harness
    .nodes()
    .filter((node) => node.props['data-testid']?.startsWith('auth-row-'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].props['data-testid'], `auth-row-${profile.id}`);
  harness.find(editButton(profile.id)).props.onClick();
  harness.render();
  assert.equal(
    harness.find((node) => node.type === 'AuthProfileDialog').props.profile
      .version,
    updated.version,
  );
});

test('page ignores a late save from another project and hides the stale dialog immediately', () => {
  const profile = formProfile();
  const harness = pageHarness([profile]);
  harness.find(editButton(profile.id)).props.onClick();
  harness.render();
  const callback = harness.find((node) => node.type === 'AuthProfileDialog')
    .props.onSaved;
  harness.context.currentProject = { id: 'other-project' };
  harness.render();
  assert.ok(!harness.nodes().some((node) => node.type === 'AuthProfileDialog'));
  callback(
    { ...profile, version: profile.version + 1 },
    null,
    secrets.AUTH_SECRET_SAVED_NOTICE,
  );
  harness.render();
  assert.ok(
    !harness
      .nodes()
      .some((node) => node.props.testId === 'auth-secret-saved-notice'),
  );
});

test('page cancel closes the editor without changing the existing version', () => {
  const profile = formProfile();
  const harness = pageHarness([profile]);
  harness.find(editButton(profile.id)).props.onClick();
  harness.render();
  harness.find((node) => node.type === 'AuthProfileDialog').props.onClose();
  harness.render();
  assert.ok(!harness.nodes().some((node) => node.type === 'AuthProfileDialog'));
  harness.find(editButton(profile.id)).props.onClick();
  harness.render();
  assert.equal(
    harness.find((node) => node.type === 'AuthProfileDialog').props.profile
      .version,
    profile.version,
  );
});

test('HTTP client sends PATCH with the version and full secret, and parses public responses', async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const profile of [formProfile(), agentProfile()]) {
      const patch = secrets.authSecretPatch(
        profile,
        suppliedVariables(),
        'fresh-http-account',
        'fresh-http-value',
      );
      const updated = { ...profile, version: profile.version + 1 };
      let requests = 0;
      globalThis.fetch = async (url, options) => {
        requests++;
        assert.equal(url, `/offline/auth-profiles/${profile.id}`);
        assert.equal(options.method, 'PATCH');
        assert.equal(options.credentials, 'include');
        assert.equal(options.headers.get('Content-Type'), 'application/json');
        assert.deepEqual(JSON.parse(options.body), patch);
        return new Response(JSON.stringify(updated), { status: 200 });
      };
      const response = await new HttpApiClient('/offline').updateAuthProfile(
        profile.id,
        patch,
      );
      assert.equal(requests, 1);
      assert.deepEqual(response, updated);
      for (const field of ['secretInput', 'password', 'username'])
        assert.equal(field in response, false);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('HTTP conflict codes are recognized and other HTTP diagnostics stay generic', async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const [status, code] of [
      [409, 'VERSION_CONFLICT'],
      [400, 'VALIDATION_ERROR'],
      [401, 'UNAUTHENTICATED'],
    ]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ code, message: 'unsafe diagnostic' }), {
          status,
        });
      await assert.rejects(
        new HttpApiClient('/offline').updateAuthProfile(formProfile().id, {
          expectedVersion: 4,
          secretInput: { username: 'new', password: 'value' },
        }),
        (reason) =>
          reason.status === status &&
          reason.code === code &&
          secrets.authSecretUpdateError(reason) ===
            (status === 409
              ? '配置已被修改，请刷新后重试'
              : '保存失败，请完整填写所有新值后重试。'),
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
