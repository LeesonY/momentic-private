import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  contractNames,
  getValidator,
  parseContract,
  validateContract,
  ContractValidationError,
  getRootValidator,
  getToolResultValidator,
  toolMetadata,
  getApiValidator,
  publicOperationIds,
  internalOperationIds,
  ERROR_HTTP_STATUS,
  ERROR_CODES,
  isErrorCode,
  CONFIG_KEYS,
  CONFIG_KEY_NAMES,
} from '../dist/index.js';

const load = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const domain = load('../../../docs/contracts/domain.schema.json');
const api = load('../../../docs/contracts/openapi.json');
const report = load('../../../docs/examples/report.sample.json');
const oracle = new Ajv2020({
  strict: false,
  strictNumbers: true,
  allErrors: true,
  allowUnionTypes: true,
});
addFormats(oracle, { mode: 'full' });
oracle.addSchema(domain, 'source');
const uuid = '00000000-0000-4000-8000-000000000001';

// Shape samples exercise every definition. They are fictional contract data, not
// browser/API results. Runtime/source comparison also mutates each top-level field.
function sample(schema) {
  if (schema.$ref) return sample(domain.$defs[schema.$ref.split('/').at(-1)]);
  if ('const' in schema) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf || schema.anyOf)
    return sample((schema.oneOf ?? schema.anyOf)[0]);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'null') return null;
  if (type === 'boolean') return true;
  if (type === 'integer' || type === 'number') return schema.minimum ?? 0;
  if (type === 'array')
    return Array.from({ length: schema.minItems ?? 0 }, () =>
      sample(schema.items),
    );
  if (type === 'string') {
    const formats = {
      uuid,
      'date-time': '2026-10-02T04:00:00Z',
      email: 'qa@example.test',
      uri: 'https://example.test/',
      'uri-reference': '/api/v1/example',
    };
    if (schema.format) return formats[schema.format];
    if (schema.pattern?.includes('{64}')) return 'a'.repeat(64);
    if (schema.pattern === '^[1-9][0-9]*$') return '1';
    if (schema.pattern?.includes('@')) return 'sample@1';
    if (schema.pattern?.startsWith('^[A-Z]')) return 'SAMPLE';
    return 'sample'.padEnd(schema.minLength ?? 0, 'x');
  }
  if (type === 'object' || schema.properties) {
    const data = Object.fromEntries(
      (schema.required ?? []).map((key) => [
        key,
        sample(schema.properties[key]),
      ]),
    );
    for (const condition of schema.allOf ?? []) {
      if (condition.if) {
        const then = oracle.compile({
          ...condition.if,
          $defs: domain.$defs,
        })(data)
          ? condition.then
          : condition.else;
        if (!then) continue;
        for (const key of then.required ?? [])
          if (!(key in data))
            data[key] = sample(
              then.properties?.[key] ?? schema.properties[key],
            );
        for (const [key, override] of Object.entries(then.properties ?? {})) {
          if (!(key in data)) continue;
          if (override.not) continue;
          if (
            override.required &&
            !override.type &&
            !override.$ref &&
            !override.properties
          ) {
            for (const required of override.required)
              data[key][required] = 'sample';
          } else data[key] = sample(override);
        }
      }
    }
    return data;
  }
  return {};
}

let comparisons = 0;
for (const name of contractNames) {
  test(`source/runtime equivalence: ${name}`, () => {
    const source = oracle.getSchema(`source#/$defs/${name}`);
    const runtime = getValidator(name);
    const baseline = sample(domain.$defs[name]);
    assert(
      source(baseline),
      `${name} baseline: ${oracle.errorsText(source.errors)}`,
    );
    assert(runtime(baseline));
    const candidates = [
      baseline,
      null,
      '',
      ' ',
      0,
      -1,
      true,
      [],
      {},
      NaN,
      Infinity,
      { extra: true },
    ];
    if (baseline && typeof baseline === 'object' && !Array.isArray(baseline)) {
      for (const key of Object.keys(baseline)) {
        const omitted = structuredClone(baseline);
        delete omitted[key];
        candidates.push(omitted);
        for (const value of [
          null,
          '',
          ' ',
          0,
          -1,
          true,
          [],
          {},
          '🧪'.repeat(130),
        ])
          candidates.push({ ...baseline, [key]: value });
      }
      candidates.push({ ...baseline, unknown: true });
    }
    for (const candidate of candidates) {
      assert.equal(runtime(candidate), source(candidate), `${name} mismatch`);
      comparisons++;
    }
  });
}
test('comparison evidence', () => {
  console.log(
    JSON.stringify({
      definitionTests: contractNames.length,
      sourceRuntimeComparisons: comparisons,
    }),
  );
  assert(comparisons > 5000);
});

test('all five fictional examples validate; four root schemas match domain schemas', () => {
  const examples = [
    ['RunCreate', 'run-create.json'],
    ['Report', 'report.sample.json'],
    ['ToolCall', 'tool-call.json'],
    ['RunEvent', 'event.sample.json'],
    ['RegressionDocument', 'regression.case.json'],
  ];
  for (const [name, file] of examples)
    assert(
      validateContract(name, load(`../../../docs/examples/${file}`)).success,
    );
  for (const [root, name, value] of [
    ['report', 'Report', report],
    ['tools', 'ToolCall', load('../../../docs/examples/tool-call.json')],
    ['events', 'RunEvent', load('../../../docs/examples/event.sample.json')],
    [
      'regression',
      'RegressionDocument',
      load('../../../docs/examples/regression.case.json'),
    ],
  ]) {
    for (const data of [value, { ...value, unknown: true }, {}, null])
      assert.equal(getRootValidator(root)(data), getValidator(name)(data));
  }
});
test('unknown input fields reject, defaults/coercion/stripping never mutate inputs', () => {
  const value = { projectId: uuid, targetUrl: 'https://example.test/' };
  const before = structuredClone(value);
  assert.equal(parseContract('RunCreate', value), value);
  assert.deepEqual(value, before);
  assert.equal(
    validateContract('RunCreate', { ...value, unknown: 1 }).success,
    false,
  );
  const budget = {};
  assert(validateContract('BudgetOverrides', budget).success);
  assert.deepEqual(budget, {});
  assert.equal(
    validateContract('BudgetOverrides', { maxCases: '8' }).success,
    false,
  );
});
test('ProjectDeleteConfirm mirrors the DELETE route: positive version and exact name only', () => {
  assert(
    validateContract('ProjectDeleteConfirm', {
      expectedVersion: 1,
      confirmName: 'P',
    }).success,
  );
  for (const bad of [
    { expectedVersion: 0, confirmName: 'P' },
    { expectedVersion: 1.5, confirmName: 'P' },
    { expectedVersion: 1, confirmName: '' },
    { expectedVersion: 1, confirmName: 'x'.repeat(121) },
    { expectedVersion: 1 },
    { expectedVersion: 1, confirmName: 'P', force: true },
  ])
    assert.equal(validateContract('ProjectDeleteConfirm', bad).success, false);
});
test('all budget fields: minimum, maximum, fractional, outside bounds, all optional/default absence', () => {
  for (const [key, schema] of Object.entries(
    domain.$defs.BudgetOverrides.properties,
  )) {
    for (const value of [schema.minimum, schema.maximum, schema.default])
      assert(getValidator('BudgetOverrides')({ [key]: value }), key);
    for (const value of [
      schema.minimum - 1,
      schema.maximum + 1,
      schema.minimum + 0.5,
      null,
      '',
      false,
    ])
      assert.equal(
        getValidator('BudgetOverrides')({ [key]: value }),
        false,
        key,
      );
  }
});
test('Unicode maxLength follows JSON Schema code points; URL, email, UUID and date formats', () => {
  assert(getValidator('ProjectCreate')({ name: '🧪'.repeat(120) }));
  assert.equal(
    getValidator('ProjectCreate')({ name: '🧪'.repeat(121) }),
    false,
  );
  for (const targetUrl of ['ftp://example.test/', 'not a url', ''])
    assert.equal(
      getValidator('RunCreate')({ projectId: uuid, targetUrl }),
      false,
    );
  assert.equal(
    getValidator('LoginInput')({
      email: 'invalid',
      password: 'valid-password',
    }),
    false,
  );
  assert.equal(
    getValidator('RunCreate')({
      projectId: 'invalid',
      targetUrl: 'https://example.test/',
    }),
    false,
  );
  const event = load('../../../docs/examples/event.sample.json');
  assert.equal(
    getValidator('RunEvent')({ ...event, at: '2026-02-30T12:00:00Z' }),
    false,
  );
});
test('Criterion conditionally requires locator and expectedValue; business typing is not invented', () => {
  const criterion = {
    id: 'main',
    kind: 'semantic',
    description: 'Main content',
    sourceKind: 'generic_smoke',
    sourceRef: 'smoke:v1',
  };
  assert(getValidator('Criterion')(criterion));
  assert.equal(
    getValidator('Criterion')({ ...criterion, kind: 'element_visible' }),
    false,
  );
  assert.equal(
    getValidator('Criterion')({ ...criterion, kind: 'http_status' }),
    false,
  );
  assert(
    getValidator('Criterion')({
      ...criterion,
      kind: 'http_status',
      expectedValue: 'business layer must check this',
    }),
  );
});
test('form and storage state auth conditional requirements', () => {
  const auth = {
    name: 'QA',
    mode: 'none',
    allowedOrigins: ['https://example.test/'],
  };
  assert(getValidator('AuthProfileCreate')(auth));
  assert.equal(
    getValidator('AuthProfileCreate')({ ...auth, mode: 'form' }),
    false,
  );
  assert.equal(
    getValidator('AuthProfileCreate')({
      ...auth,
      mode: 'storage_state',
      secretInput: {},
    }),
    false,
  );
  assert(
    getValidator('AuthProfileCreate')({
      ...auth,
      mode: 'storage_state',
      secretInput: { storageState: '{}' },
      storageCriterion: sample(domain.$defs.Criterion),
    }),
  );
  const formConfig = sample(domain.$defs.FormConfig);
  assert.equal(
    getValidator('AuthProfileCreate')({
      ...auth,
      mode: 'form',
      formConfig,
      secretInput: { username: 'qa' },
    }),
    false,
  );
  assert(
    getValidator('AuthProfileCreate')({
      ...auth,
      mode: 'form',
      formConfig,
      secretInput: { username: 'qa', password: 'test-only' },
    }),
  );
});
test('functional confirmed needs an independent reproduction and evidence', () => {
  const finding = report.findings[0];
  assert(getValidator('Finding')(finding));
  for (const patch of [{ reproductionRef: null }, { evidenceRefs: [] }])
    assert.equal(getValidator('Finding')({ ...finding, ...patch }), false);
  // As in Mo, the reproduction confirms it whatever the expectation's source.
  assert(getValidator('Finding')({ ...finding, expectedSource: 'inferred' }));
  assert.equal(
    getValidator('Reproduction')({
      ...report.reproductions[0],
      freshContext: false,
    }),
    false,
  );
});
test('every declared event type validates its matching payload and rejects mismatches', () => {
  const event = load('../../../docs/examples/event.sample.json');
  for (const condition of domain.$defs.RunEvent.allOf) {
    const type = condition.if.properties.type.const;
    const payload = sample(condition.then.properties.payload);
    assert(getValidator('RunEvent')({ ...event, type, payload }), type);
    assert.equal(
      getValidator('RunEvent')({ ...event, type, payload: { wrong: true } }),
      false,
      type,
    );
  }
  // Equality id=seq is a domain invariant, not expressed in the JSON Schema.
  assert(getValidator('RunEvent')({ ...event, id: '2', seq: 1 }));
});
test('all tools and result metadata resolve; unknown/shell/eval tools reject', () => {
  assert.equal(Object.keys(toolMetadata).length, 16);
  for (const tool of domain.$defs.ToolCall.oneOf) {
    const name = tool.properties.name.const;
    assert(getValidator('ToolCall')(sample(tool)), name);
    assert(toolMetadata[name].roles.length > 0);
    assert(
      getToolResultValidator(name)(
        sample(domain.$defs[toolMetadata[name].resultContract]),
      ),
      name,
    );
    assert.equal(
      getValidator('ToolCall')({ name, args: { unknown: true } }),
      false,
      name,
    );
  }
  for (const name of ['shell', 'eval', 'fill_secret', 'triage', 'unknown'])
    assert.equal(getValidator('ToolCall')({ name, args: {} }), false);
});
test('recursive JsonValue, nullable fields and oneOf rejection', () => {
  assert(getValidator('JsonValue')({ a: [null, { b: true }, 1.5] }));
  assert.equal(getValidator('JsonValue')({ a: undefined }), false);
  assert.equal(
    getValidator('ModelPart')({
      type: 'text',
      text: 'hello',
      artifactId: uuid,
    }),
    false,
  );
  assert(getValidator('CaseRecord')(report.cases.at(-1)));
});
test('parse errors contain no input password and retain detached errors', () => {
  const first = validateContract('LoginInput', {
    email: 'invalid',
    password: 'sensitive',
  });
  assert.equal(first.success, false);
  const saved = structuredClone(first.errors);
  getValidator('LoginInput')({});
  assert.deepEqual(first.errors, saved);
  assert.throws(
    () =>
      parseContract('LoginInput', { email: 'invalid', password: 'sensitive' }),
    (error) =>
      error instanceof ContractValidationError &&
      error.code === 'VALIDATION_ERROR' &&
      !JSON.stringify(error).includes('sensitive'),
  );
});
test('every OpenAPI request, response, media and parameter validator compiles; Internal opt-in', () => {
  let count = 0;
  for (const methods of Object.values(api.paths))
    for (const op of Object.values(methods)) {
      const options = { internal: op.tags.includes('Internal') };
      for (const location of ['path', 'query', 'header']) {
        assert(
          getApiValidator(
            op.operationId,
            { kind: 'parameters', location },
            options,
          ),
        );
        count++;
      }
      for (const mediaType of Object.keys(op.requestBody?.content ?? {})) {
        assert(
          getApiValidator(
            op.operationId,
            { kind: 'request', mediaType },
            options,
          ),
        );
        count++;
      }
      for (const [status, response] of Object.entries(op.responses))
        for (const mediaType of Object.keys(response.content ?? {})) {
          assert(
            getApiValidator(
              op.operationId,
              { kind: 'response', status, mediaType },
              options,
            ),
          );
          count++;
        }
    }
  assert.equal(publicOperationIds.length, 98);
  assert.equal(internalOperationIds.length, 8);
  for (const id of internalOperationIds)
    assert.throws(() =>
      getApiValidator(id, { kind: 'parameters', location: 'path' }),
    );
  console.log(
    JSON.stringify({
      compiledRuntimeApiValidators: count,
      publicOperations: publicOperationIds.length,
      internalOperations: internalOperationIds.length,
    }),
  );
});
test('API input/output/query constraints follow OpenAPI without implicit coercion', () => {
  const request = getApiValidator('createRun', { kind: 'request' });
  assert(request(load('../../../docs/examples/run-create.json')));
  assert.equal(
    request({
      projectId: uuid,
      targetUrl: 'https://example.test/',
      unexpected: true,
    }),
    false,
  );
  assert(
    getApiValidator('getReport', { kind: 'response', status: '200' })(report),
  );
  const query = getApiValidator('listRuns', {
    kind: 'parameters',
    location: 'query',
  });
  assert(query({ projectId: uuid, limit: 100 }));
  for (const data of [
    {},
    { projectId: uuid, limit: 0 },
    { projectId: uuid, limit: 101 },
    { projectId: uuid, limit: '20' },
    { projectId: uuid, status: 'invalid' },
  ])
    assert.equal(query(data), false);
  assert.throws(() =>
    getApiValidator('downloadArtifact', { kind: 'response', status: '200' }),
  );
  assert(
    getApiValidator('downloadArtifact', {
      kind: 'response',
      status: '200',
      mediaType: 'application/octet-stream',
    })('binary transport annotation'),
  );
  assert(
    getApiValidator('healthReady', { kind: 'response', status: '503' })({
      status: 'not_ready',
      version: '1.0.0',
    }),
  );
  const error = {
    code: 'VALIDATION_ERROR',
    message: 'Invalid request',
    requestId: uuid,
  };
  assert(
    getApiValidator('createRun', { kind: 'response', status: 'default' })(
      error,
    ),
  );
});
test('error registry exactly covers documented §7 codes; does not tighten Error.code', () => {
  const text = readFileSync(
    new URL('../../../docs/03-data-and-api.md', import.meta.url),
    'utf8',
  )
    .split('## 7.')[1]
    .split('## 8.')[0];
  const documented = [
    ...text.matchAll(/^\| ([A-Z_]+(?: \/ [A-Z_]+)*) \|/gm),
  ].flatMap((match) => match[1].split(' / '));
  assert.deepEqual([...ERROR_CODES].sort(), documented.sort());
  assert.equal(ERROR_HTTP_STATUS.LEASE_EXPIRED, 409);
  assert.equal(ERROR_HTTP_STATUS.AUTH_REQUIRED, null);
  assert(isErrorCode('EVENTS_EXPIRED'));
  assert.equal(isErrorCode('toString'), false);
  assert(
    getValidator('Error')({
      code: 'PROVIDER_FUTURE_CODE',
      message: '',
      requestId: uuid,
    }),
  );
});
test('frozen deployment registry covers §12 inputs and documented defaults', () => {
  for (const key of [
    'DATABASE_URL',
    'PUBLIC_ORIGIN',
    'DATA_DIR',
    'MASTER_KEY_FILE',
    'WORKER_IDENTITY_FILE',
    'BROWSER_SLOTS',
    'JOB_LEASE_SECONDS',
    'JOB_HEARTBEAT_SECONDS',
    'INPUT_WAIT_TIMEOUT_SECONDS',
    'REPORT_RETENTION_DAYS',
    'ARTIFACT_RETENTION_DAYS',
    'AUDIT_RETENTION_DAYS',
  ])
    assert(CONFIG_KEY_NAMES.includes(key));
  assert.equal(CONFIG_KEYS.JOB_LEASE_SECONDS.default, 45);
  assert.equal(CONFIG_KEYS.JOB_HEARTBEAT_SECONDS.default, 10);
  assert.equal(CONFIG_KEYS.INPUT_WAIT_TIMEOUT_SECONDS.default, 300);
  assert.equal(CONFIG_KEYS.REPORT_RETENTION_DAYS.default, 90);
  assert.equal(CONFIG_KEYS.ARTIFACT_RETENTION_DAYS.default, 30);
  assert.equal(CONFIG_KEYS.AUDIT_RETENTION_DAYS.default, 180);
  assert(Object.isFrozen(CONFIG_KEYS));
});
