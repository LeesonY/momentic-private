// Offline verification: a new session must not override the server's session
// budget defaults. The real ProjectHomePage submit handler runs against a
// stubbed API client; no browser, no network, no database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { SESSION_BUDGET_DEFAULTS } from '../src/pages/sessionBudgetDefaults.ts';

const require = createRequire(new URL('../package.json', import.meta.url));
const { transformSync } = createRequire(require.resolve('vite'))('esbuild');

/** Evaluate the real TSX with inert UI wrappers and deterministic hooks. */
const componentHarness = (path, exportName, imports, props = {}) => {
  const hooks = [];
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
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
  };
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(
    (specifier) => {
      if (specifier === 'react') return React;
      if (!(specifier in imports))
        throw new Error(`Unexpected import: ${specifier}`);
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
    };
    walk(root);
    return result;
  };
  render();
  return { render, nodes };
};

const createdRuns = [];
const stubClient = {
  listEnvironments: async () => ({ items: [], nextCursor: null }),
  listAuthProfiles: async () => ({ items: [], nextCursor: null }),
  listProjectModels: async () => ({ items: [], nextCursor: null }),
  createRun: async (input) => {
    createdRuns.push(input);
    return { id: 'run_offline_1', version: 1 };
  },
};

const homeHarness = (contextOverrides = {}) => {
  const setRouteCalls = [];
  const imports = {
    '../api/index.ts': { defaultApiClient: stubClient },
    '../state/AppContext.tsx': {
      useApp: () => ({
        currentProject: { id: 'proj-1', status: 'active' },
        currentUser: { id: 'u1', globalRole: 'admin' },
        isMock: true,
        setRoute: (...args) => setRouteCalls.push(args),
        ...contextOverrides,
      }),
    },
    '../components/ui/AppIcon.tsx': { AppIcon: 'AppIcon' },
    '../components/layout/CreateProjectDialog.tsx': {
      CreateProjectDialog: 'CreateProjectDialog',
    },
    '../components/layout/Page.tsx': { Page: 'Page' },
    '../components/ui/Popover.tsx': { Popover: 'Popover' },
    '../components/ui/Alert.tsx': { Alert: 'Alert' },
    './sessionBudgetDefaults.ts': { SESSION_BUDGET_DEFAULTS },
  };
  return Object.assign(
    componentHarness(
      '../src/pages/ProjectHomePage.tsx',
      'ProjectHomePage',
      imports,
    ),
    { setRouteCalls },
  );
};

const textarea = (harness) =>
  harness.nodes().find((node) => node.type === 'textarea');
const startForm = (harness) =>
  harness.nodes().find((node) => node.type === 'form');

test('editable session defaults mirror the server session defaults', () => {
  assert.equal(SESSION_BUDGET_DEFAULTS.maxActiveSeconds, 1800);
  assert.equal(SESSION_BUDGET_DEFAULTS.maxCases, 8);
  assert.equal(SESSION_BUDGET_DEFAULTS.maxPages, 6);
  assert.equal(SESSION_BUDGET_DEFAULTS.maxDepth, 2);
  assert.equal(SESSION_BUDGET_DEFAULTS.maxActions, 120);
  assert.equal(SESSION_BUDGET_DEFAULTS.maxActionsPerCase, 12);
  assert.equal(SESSION_BUDGET_DEFAULTS.concurrency, 2);
});

test('defaults stay within the contract ceilings shown in the inputs', async () => {
  const harness = homeHarness();
  const secondsInput = harness
    .nodes()
    .find((node) => node.props.max === 3600 && node.props.type === 'number');
  assert.ok(secondsInput, 'maxActiveSeconds input with max=3600');
  assert.ok(secondsInput.props.max >= SESSION_BUDGET_DEFAULTS.maxActiveSeconds);
  const perCaseInput = harness
    .nodes()
    .find(
      (node) =>
        node.props.max === 100 &&
        node.props.min === 1 &&
        node.props.type === 'number',
    );
  assert.ok(perCaseInput, 'maxActionsPerCase input with max=100');
  assert.ok(
    perCaseInput.props.max >= SESSION_BUDGET_DEFAULTS.maxActionsPerCase,
  );
});

test('new session sends only user-editable budget fields with 1800s default', async () => {
  const harness = homeHarness();
  textarea(harness).props.onChange({
    target: { value: '测试 https://demo.example.com/checkout 的下单流程' },
  });
  harness.render();
  startForm(harness).props.onSubmit({ preventDefault() {} });
  await nextTurn();
  harness.render();

  assert.equal(createdRuns.length, 1);
  const budget = createdRuns[0].budgetOverrides ?? {};
  assert.deepEqual(Object.keys(budget).sort(), [
    'concurrency',
    'maxActions',
    'maxActionsPerCase',
    'maxActiveSeconds',
    'maxCases',
    'maxDepth',
    'maxPages',
  ]);
  assert.equal(budget.maxActiveSeconds, 1800);
  assert.equal(budget.maxActionsPerCase, 12);
});

test('non-editable limits never reach the create request', async () => {
  const harness = homeHarness();
  textarea(harness).props.onChange({
    target: { value: '重现 https://demo.example.com/login 的问题' },
  });
  harness.render();
  startForm(harness).props.onSubmit({ preventDefault() {} });
  await nextTurn();
  const payload = JSON.stringify(createdRuns.at(-1));
  for (const forbidden of [
    'maxModelCalls',
    'maxReproductions',
    'maxTotalTokens',
  ])
    assert.ok(!payload.includes(forbidden), `${forbidden} must not be sent`);
});

test('user-edited values are still sent as overrides', async () => {
  const harness = homeHarness();
  const secondsInput = harness
    .nodes()
    .find((node) => node.props.max === 3600 && node.props.type === 'number');
  secondsInput.props.onChange({ target: { value: '3600' } });
  harness.render();
  textarea(harness).props.onChange({
    target: { value: '测试 https://demo.example.com 的搜索' },
  });
  harness.render();
  startForm(harness).props.onSubmit({ preventDefault() {} });
  await nextTurn();
  assert.equal(createdRuns.at(-1).budgetOverrides.maxActiveSeconds, 3600);
});
