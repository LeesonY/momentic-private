import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPayload } from '@localqa/storage';
import {
  compileRegression,
  regressionDocumentSha256,
} from '../dist/regression-compiler.js';

// Simulate a JSONB/transport roundtrip without changing any array order.
function reorderObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reorderObjectKeys(child)]),
    );
  }
  return value;
}

test('canonical module SHA survives deep key reordering but rejects step order and value changes', () => {
  const original = doc(
    'child',
    [navigate, { kind: 'assert', criterionId: 'visible' }],
    { FIRST: 'one', SECOND: 'two' },
  );
  const reordered = reorderObjectKeys(original);
  assert.deepEqual(reordered, original);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(original));
  assert.notEqual(
    JSON.stringify(reordered.criteria[0].locator),
    JSON.stringify(original.criteria[0].locator),
  );
  const sha = hashPayload(original);
  assert.equal(regressionDocumentSha256(original), sha);
  assert.equal(regressionDocumentSha256(reordered), sha);
  const root = doc('root', [use('child@1')]);
  const compiled = compileRegression(
    root,
    options({ 'child@1': module('child', reordered, { sha256: sha }) }),
  );
  assert.deepEqual(
    compiled.map(({ step }) => step),
    original.steps,
  );
  assert.equal(compiled[0].source.modulePath[0].sha256, sha);
  const reversed = structuredClone(reordered);
  reversed.steps.reverse();
  assert.notEqual(regressionDocumentSha256(reversed), sha);
  rejects(
    root,
    'MODULE_SHA',
    options({ 'child@1': module('child', reversed, { sha256: sha }) }),
  );
  const changed = structuredClone(reordered);
  changed.criteria[0].locator.value = 'main';
  assert.notEqual(regressionDocumentSha256(changed), sha);
  rejects(
    root,
    'MODULE_SHA',
    options({ 'child@1': module('child', changed, { sha256: sha }) }),
  );
});

const criterion = {
  id: 'visible',
  kind: 'element_visible',
  description: 'Visible',
  sourceKind: 'generic_smoke',
  sourceRef: 'fixture',
  locator: { by: 'css', value: 'body' },
};
function doc(id, steps, variables = {}) {
  return {
    schemaVersion: 1,
    kind: 'localqa/test',
    id,
    name: id,
    variables,
    criteria: [structuredClone(criterion)],
    steps,
  };
}
function module(name, document, patch = {}) {
  return {
    projectId: 'p',
    name,
    version: 1,
    reviewStatus: 'approved',
    document,
    sha256: regressionDocumentSha256(document),
    ...patch,
  };
}
function options(modules = {}, patch = {}) {
  return {
    projectId: 'p',
    allowedOrigins: ['https://fixture.test'],
    env: {},
    maxExpandedSteps: 100,
    resolveModule: (name, version) => modules[`${name}@${version}`],
    ...patch,
  };
}
function rejects(document, code, opts = options()) {
  assert.throws(
    () => compileRegression(document, opts),
    (e) => e.code === code,
  );
}
const navigate = { kind: 'navigate', url: 'https://fixture.test/' };
const use = (ref, args) => ({
  kind: 'module',
  ref,
  ...(args ? { arguments: args } : {}),
});

test('ordered expansion, bound variables, provenance, frozen scoped criteria and unchanged root', () => {
  const child = doc(
    'child',
    [
      {
        kind: 'type_text',
        locator: { by: 'label', value: '{{vars.LABEL}}' },
        text: '{{vars.VALUE}}',
      },
      { kind: 'assert', criterionId: 'visible' },
    ],
    { LABEL: 'Input', VALUE: 'default' },
  );
  const root = doc(
    'root',
    [
      { kind: 'navigate', url: '{{env.ORIGIN}}/{{vars.PATH}}' },
      use('child@1', { VALUE: '{{vars.VALUE}}' }),
      { kind: 'ai_action', goal: 'Observe', criteriaIds: ['visible'] },
    ],
    { PATH: 'home', VALUE: 'bound' },
  );
  const before = JSON.stringify(root);
  const childBefore = JSON.stringify(child);
  const result = compileRegression(
    root,
    options(
      { 'child@1': module('child', child) },
      { env: { ORIGIN: 'https://fixture.test' } },
    ),
  );
  assert.deepEqual(
    result.map((x) => x.step.kind),
    ['navigate', 'type_text', 'assert', 'ai_action'],
  );
  assert.equal(result[0].step.url, 'https://fixture.test/home');
  assert.equal(result[1].step.text, 'bound');
  assert.equal(result[1].step.locator.value, 'Input');
  assert.equal(result[2].criteria[0].id, 'visible');
  assert.deepEqual(result[1].source.modulePath, [
    {
      ref: 'child@1',
      sha256: regressionDocumentSha256(child),
      invocationStepIndex: 1,
    },
  ]);
  assert.equal(result[1].source.stepIndex, 0);
  assert.equal(JSON.stringify(root), before);
  assert.equal(JSON.stringify(child), childBefore);
  assert.ok(Object.isFrozen(result[2].criteria[0].locator));
  assert.throws(() => {
    result[1].step.text = 'tamper';
  }, TypeError);
});

test('missing/illegal expressions, secrets, dangerous keys, URL and locator validation', () => {
  rejects(
    doc('x', [{ kind: 'navigate', url: '{{env.MISSING}}' }]),
    'MISSING_VARIABLE',
  );
  rejects(
    doc('x', [{ kind: 'navigate', url: '{{vars.MISSING}}' }]),
    'MISSING_VARIABLE',
  );
  rejects(
    doc('x', [{ kind: 'navigate', url: '{{shell.RUN}}' }]),
    'INVALID_EXPRESSION',
  );
  rejects(
    doc('x', [{ kind: 'navigate', url: '{{env.SECRET}}' }]),
    'SECRET_INTERPOLATION',
    options(
      {},
      { env: { SECRET: { value: 'https://fixture.test', secret: true } } },
    ),
  );
  rejects(
    doc(
      'x',
      [
        {
          kind: 'type_text',
          locator: { by: 'css', value: 'body' },
          text: '{{vars.SECRET}}',
        },
      ],
      { SECRET: 'hidden' },
    ),
    'SECRET_INTERPOLATION',
    options({}, { secretVars: ['SECRET'] }),
  );
  const dangerous = doc('x', [navigate]);
  dangerous.variables = JSON.parse('{"__proto__":"bad"}');
  rejects(dangerous, 'DANGEROUS_KEY');
  rejects(
    doc('x', [{ kind: 'navigate', url: '{{env.URL}}' }]),
    'TARGET_NOT_ALLOWED',
    options({}, { env: { URL: 'https://outside.test/' } }),
  );
  rejects(
    doc('x', [{ kind: 'navigate', url: 'javascript:alert(1)' }]),
    'TARGET_NOT_ALLOWED',
  );
  rejects(
    doc('x', [{ kind: 'navigate', url: 'https://user:pass@fixture.test/' }]),
    'TARGET_NOT_ALLOWED',
  );
  rejects(
    doc(
      'x',
      [{ kind: 'click', locator: { by: 'css', value: '{{vars.SELECTOR}}' } }],
      { SELECTOR: '   ' },
    ),
    'INVALID_LOCATOR',
  );
  assert.throws(
    () => compileRegression(doc('x', [navigate], { VALUE: [] }), options()),
    { name: 'ContractValidationError' },
  );
});

test('sibling reuse is legal and resolver version snapshot is reused', () => {
  const child = module('child', doc('child', [navigate]));
  let calls = 0;
  const result = compileRegression(
    doc('root', [use('child@1'), use('child@1')]),
    options(
      {},
      {
        resolveModule: () => {
          calls++;
          return child;
        },
      },
    ),
  );
  assert.equal(result.length, 2);
  assert.equal(calls, 1);
  assert.equal(result[0].source.modulePath[0].invocationStepIndex, 0);
  assert.equal(result[1].source.modulePath[0].invocationStepIndex, 1);
});

test('real A-B-A active-stack cycle is rejected', () => {
  const modules = {
    'A@1': module('A', doc('A', [use('B@1')])),
    'B@1': module('B', doc('B', [use('A@1')])),
  };
  rejects(doc('root', [use('A@1')]), 'MODULE_CYCLE', options(modules));
});

test('eight module levels pass, nine fail', () => {
  function chain(count) {
    const modules = {};
    for (let i = 1; i <= count; i++)
      modules[`M${i}@1`] = module(
        `M${i}`,
        doc(`M${i}`, i === count ? [navigate] : [use(`M${i + 1}@1`)]),
      );
    return modules;
  }
  const root = doc('root', [use('M1@1')]);
  assert.equal(
    compileRegression(root, options(chain(8)))[0].source.modulePath.length,
    8,
  );
  rejects(root, 'MODULE_DEPTH', options(chain(9)));
});

test('module approval, project, exact version and SHA are validated before expansion', () => {
  const root = doc('root', [use('child@1')]);
  rejects(root, 'UNKNOWN_MODULE');
  const child = doc('child', [navigate]);
  for (const [patch, code] of [
    [{ reviewStatus: 'draft' }, 'MODULE_NOT_APPROVED'],
    [{ reviewStatus: 'rejected' }, 'MODULE_NOT_APPROVED'],
    [{ projectId: 'other' }, 'MODULE_IDENTITY'],
    [{ name: 'other' }, 'MODULE_IDENTITY'],
    [{ version: 2 }, 'MODULE_IDENTITY'],
    [{ sha256: '0'.repeat(64) }, 'MODULE_SHA'],
  ]) {
    rejects(root, code, options({ 'child@1': module('child', child, patch) }));
  }
  rejects(
    doc('root', [use('child@1', { VALUE: { arbitrary: true } })]),
    'INVALID_ARGUMENT',
    options({ 'child@1': module('child', child) }),
  );
});

test('static expansion limit is global, including repeated modules', () => {
  const modules = {
    'child@1': module('child', doc('child', [navigate, navigate])),
  };
  const root = doc('root', [use('child@1'), use('child@1')]);
  assert.equal(
    compileRegression(root, options(modules, { maxExpandedSteps: 4 })).length,
    4,
  );
  rejects(root, 'STATIC_STEP_LIMIT', options(modules, { maxExpandedSteps: 3 }));
});

test('criteria are scoped to their document, unknown assertions/actions and fixtures fail closed', () => {
  rejects(
    doc('root', [{ kind: 'assert', criterionId: 'missing' }]),
    'UNKNOWN_CRITERION',
  );
  rejects(
    doc('root', [
      { kind: 'ai_action', goal: 'Check', criteriaIds: ['missing'] },
    ]),
    'UNKNOWN_CRITERION',
  );
  const child = doc('child', [{ kind: 'assert', criterionId: 'visible' }]);
  child.criteria[0].description = 'Child criterion';
  const result = compileRegression(
    doc('root', [use('child@1'), { kind: 'assert', criterionId: 'visible' }]),
    options({ 'child@1': module('child', child) }),
  );
  assert.equal(result[0].criteria[0].description, 'Child criterion');
  assert.equal(result[1].criteria[0].description, 'Visible');
  child.criteria[0].id = 'childOnly';
  rejects(
    doc('root', [use('child@1')]),
    'UNKNOWN_CRITERION',
    options({ 'child@1': module('child', child) }),
  );
  const fixture = doc('root', [navigate]);
  fixture.fixtureRefs = [
    { id: '00000000-0000-4000-8000-000000000001', version: 1 },
  ];
  rejects(fixture, 'UNRESOLVED_FIXTURE');
});
