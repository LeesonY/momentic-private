import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGateway, createOpenAIAdapter } from '../dist/index.js';
import { DECISION_SCHEMA } from '../../agents/dist/index.js';

const profileId = 'f3111111-1111-4111-8111-111111111111';
const taskId = 'f3222222-2222-4222-8222-222222222222';
const uuid = '11111111-1111-4111-8111-111111111111';

function profile(responseFormat) {
  return {
    id: profileId,
    version: 1,
    name: 'g3f',
    endpoint: 'https://model.g3f.test/v1',
    configuredModelId: 'g3f-model',
    kind: 'openai_compatible',
    dataBoundary: 'external',
    capabilities: {
      structuredOutput: true,
      nativeTools: true,
      imageInput: false,
    },
    responseFormat,
    status: 'ready',
    encryptedApiKey: 'slot',
    approvedFallbackIds: [],
  };
}

function schema(format) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { value: { type: 'string', format } },
  };
}

function completion(content) {
  return new Response(
    JSON.stringify({
      id: 'local',
      model: 'g3f-model',
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function harness(responseFormat, contents) {
  const bodies = [];
  let sent = 0;
  const gateway = createGateway({
    profiles: [profile(responseFormat)],
    decryptKey: () => 'local-test-key',
    adapter: createOpenAIAdapter(async (_url, init) => {
      sent += 1;
      bodies.push(JSON.parse(init.body));
      const content = contents[Math.min(sent - 1, contents.length - 1)];
      return completion(content);
    }),
  });
  return { gateway, bodies, sent: () => sent };
}

function decide(gateway, outputSchema, extra = {}) {
  return gateway.generateDecision({
    taskId,
    profileId,
    contextVersion: 1,
    role: 'executor',
    promptVersion: 'g3f',
    purpose: 'decide',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'repro' }] }],
    approvedImageIds: [],
    toolSchemas: extra.toolSchemas ?? [],
    outputSchema,
    timeoutMs: 1000,
    maxOutputTokens: 200,
    maxInputTokens: 4000,
    knownEvidenceIds: [],
  });
}

test('uuid and uri formats reject not-valid and accept a real value', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((item) => String(item)).join(' '));
  };
  try {
    for (const format of ['uuid', 'uri']) {
      const bad = harness('json_schema', [
        JSON.stringify({ value: 'not-valid' }),
      ]);
      const rejected = await decide(bad.gateway, schema(format));
      assert.equal(bad.sent(), 2);
      assert.equal(rejected.requestResult, 'malformed');
      assert.equal(rejected.errorCode, 'VALIDATION_ERROR');
      assert.equal(rejected.data, null);
      assert.equal(rejected.providerCalls, 2);
      assert.equal(rejected.repairCount, 1);
      assert.equal(rejected.requests, 2);
      assert.equal(rejected.inputTokens, 8);
      assert.equal(rejected.outputTokens, 4);
      assert.equal(rejected.usageSource, 'reported');
      assert.equal(bad.bodies[0].response_format.type, 'json_schema');
      assert.equal(bad.bodies[0].response_format.json_schema.strict, true);

      const goodValue = format === 'uuid' ? uuid : 'https://example.com/a';
      const good = harness('json_schema', [
        JSON.stringify({ value: goodValue }),
      ]);
      const accepted = await decide(good.gateway, schema(format));
      assert.equal(good.sent(), 1);
      assert.equal(accepted.requestResult, 'ok');
      assert.equal(accepted.errorCode, null);
      assert.deepEqual(accepted.data, { value: goodValue });
      assert.equal(accepted.providerCalls, 1);
      assert.equal(accepted.repairCount, 0);
      assert.equal(accepted.requests, 1);
    }
    assert.equal(
      warnings.some((line) => line.includes('unknown format')),
      false,
    );
  } finally {
    console.warn = original;
  }
});

test('date-time and uri-reference have positive and negative samples', async () => {
  const cases = [
    ['date-time', '2026-10-05T00:00:00Z', 'not-valid'],
    ['uri-reference', '/docs/readme', 'http://exa mple.com/a'],
  ];
  for (const [format, goodValue, badValue] of cases) {
    const bad = harness('json_schema', [JSON.stringify({ value: badValue })]);
    const rejected = await decide(bad.gateway, schema(format));
    assert.equal(rejected.requestResult, 'malformed');
    assert.equal(rejected.errorCode, 'VALIDATION_ERROR');
    assert.equal(rejected.data, null);
    assert.equal(rejected.providerCalls, 2);
    assert.equal(rejected.repairCount, 1);
    assert.equal(bad.sent(), 2);

    const good = harness('json_schema', [JSON.stringify({ value: goodValue })]);
    const accepted = await decide(good.gateway, schema(format));
    assert.equal(accepted.requestResult, 'ok');
    assert.equal(accepted.errorCode, null);
    assert.deepEqual(accepted.data, { value: goodValue });
    assert.equal(accepted.providerCalls, 1);
    assert.equal(good.sent(), 1);
  }
});

test('one successful repair matches the two reported usage attempts', async () => {
  const run = harness('json_schema', [
    JSON.stringify({ value: 'not-valid' }),
    JSON.stringify({ value: uuid }),
  ]);
  const record = await decide(run.gateway, schema('uuid'));
  assert.equal(run.sent(), 2);
  assert.equal(record.requestResult, 'repaired');
  assert.equal(record.errorCode, null);
  assert.deepEqual(record.data, { value: uuid });
  assert.equal(record.repairCount, 1);
  assert.equal(record.providerCalls, 2);
  assert.equal(record.requests, 2);
  assert.equal(record.inputTokens, 8);
  assert.equal(record.outputTokens, 4);
  assert.equal(record.usageSource, 'reported');
});

test('const default examples and enum object fields are instance data', async () => {
  const label = { format: 'business-label', kind: 'invoice' };
  const schemas = [
    { type: 'object', const: label },
    { type: 'object', default: label },
    { type: 'object', examples: [label] },
    { type: 'object', enum: [label] },
    {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        label: { type: 'object' },
      },
      const: { id: uuid, label },
    },
  ];
  for (const outputSchema of schemas) {
    const payload = outputSchema.const ?? label;
    const run = harness('json_schema', [JSON.stringify(payload)]);
    const record = await decide(run.gateway, outputSchema);
    assert.equal(run.sent(), 1);
    assert.equal(record.requestResult, 'ok');
    assert.equal(record.errorCode, null);
    assert.deepEqual(record.data, payload);
    assert.equal(record.providerCalls, 1);
    assert.equal(record.repairCount, 0);
  }
});

test('unknown format nested in schema keywords sends nothing', async () => {
  const nested = { type: 'string', format: 'business-label' };
  const schemas = [
    { type: 'object', properties: { value: nested } },
    { type: 'array', items: nested },
    { type: 'array', items: [{ type: 'string', format: 'uuid' }, nested] },
    { type: 'array', additionalItems: nested },
    { type: 'array', contains: nested },
    { $defs: { Row: { properties: { id: nested } } }, $ref: '#/$defs/Row' },
    { definitions: { Row: { properties: { id: nested } } } },
    { patternProperties: { '^id$': nested } },
    { allOf: [{ type: 'object' }, { properties: { id: nested } }] },
    { anyOf: [{ type: 'string' }, nested] },
    { oneOf: [{ properties: { id: nested } }] },
    { not: nested },
    { if: { type: 'object' }, then: { properties: { id: nested } } },
    {
      dependencies: {
        a: { properties: { b: nested } },
        name: ['a'],
      },
    },
  ];
  for (const outputSchema of schemas) {
    const run = harness('json_schema', [JSON.stringify({ value: 'x' })]);
    const record = await decide(run.gateway, outputSchema);
    assert.equal(run.sent(), 0);
    assert.equal(record.providerCalls, 0);
    assert.equal(record.repairCount, 0);
    assert.equal(record.requestResult, 'malformed');
    assert.equal(record.errorCode, 'VALIDATION_ERROR');
    assert.equal(record.data, null);
  }
});

test('unsupported format and an illegal schema send nothing', async () => {
  const unknown = harness('json_schema', [JSON.stringify({ value: uuid })]);
  const unknownRecord = await decide(unknown.gateway, schema('not-a-format'));
  assert.equal(unknown.sent(), 0);
  assert.equal(unknownRecord.providerCalls, 0);
  assert.equal(unknownRecord.repairCount, 0);
  assert.equal(unknownRecord.requests, 0);
  assert.equal(unknownRecord.requestResult, 'malformed');
  assert.equal(unknownRecord.errorCode, 'VALIDATION_ERROR');
  assert.equal(unknownRecord.data, null);

  const illegal = harness('json_schema', [JSON.stringify({ value: 'x' })]);
  const illegalRecord = await decide(illegal.gateway, {
    type: 'object',
    required: { not: 'an array' },
  });
  assert.equal(illegal.sent(), 0);
  assert.equal(illegalRecord.providerCalls, 0);
  assert.equal(illegalRecord.repairCount, 0);
  assert.equal(illegalRecord.requestResult, 'malformed');
  assert.equal(illegalRecord.errorCode, 'VALIDATION_ERROR');
});

test('json_schema and native_tools keep their request shapes and the same format gate', async () => {
  const tools = [{ name: 'observe', parameters: { type: 'object' } }];
  for (const mode of ['json_schema', 'native_tools']) {
    const bad = harness(mode, [JSON.stringify({ value: 'not-valid' })]);
    const rejected = await decide(bad.gateway, schema('uuid'), {
      toolSchemas: tools,
    });
    assert.equal(rejected.requestResult, 'malformed');
    assert.equal(rejected.providerCalls, 2);
    assert.equal(bad.bodies[0].tools[0].function.name, 'observe');
    if (mode === 'json_schema') {
      assert.equal(bad.bodies[0].response_format.type, 'json_schema');
      assert.equal(bad.bodies[0].response_format.json_schema.strict, true);
    } else {
      assert.equal(Object.hasOwn(bad.bodies[0], 'response_format'), false);
    }

    const good = harness(mode, [JSON.stringify({ value: uuid })]);
    const accepted = await decide(good.gateway, schema('uuid'), {
      toolSchemas: tools,
    });
    assert.equal(accepted.requestResult, 'ok');
    assert.deepEqual(accepted.data, { value: uuid });
    assert.equal(accepted.providerCalls, 1);
    if (mode === 'native_tools') {
      assert.equal(Object.hasOwn(good.bodies[0], 'response_format'), false);
    }
  }
});

test('canonical ToolCall check still rejects a non-uuid after a schema without formats', async () => {
  const call = {
    done: false,
    toolCalls: [
      {
        name: 'click',
        args: {
          target: {
            snapshotId: 'not-valid',
            pageId: 'not-valid',
            nodeId: 'n1',
          },
        },
      },
    ],
  };
  const loose = harness('json_schema', [JSON.stringify(call)]);
  const rejected = await decide(loose.gateway, { type: 'object' });
  assert.equal(loose.sent(), 1);
  assert.equal(rejected.requestResult, 'malformed');
  assert.equal(rejected.errorCode, 'VALIDATION_ERROR');
  assert.equal(rejected.data, null);
  assert.equal(rejected.providerCalls, 1);
  assert.equal(rejected.repairCount, 0);

  const valid = {
    done: false,
    toolCalls: [
      {
        name: 'click',
        args: {
          target: { snapshotId: uuid, pageId: uuid, nodeId: 'n1' },
        },
      },
    ],
  };
  const accepted = harness('json_schema', [JSON.stringify(valid)]);
  const record = await decide(accepted.gateway, DECISION_SCHEMA);
  assert.equal(record.requestResult, 'ok');
  assert.equal(record.errorCode, null);
  assert.equal(record.providerCalls, 1);
  assert.deepEqual(record.data, valid);

  const formatted = harness('json_schema', [JSON.stringify(call)]);
  const stillBad = await decide(formatted.gateway, DECISION_SCHEMA);
  assert.equal(formatted.sent(), 2);
  assert.equal(stillBad.requestResult, 'malformed');
  assert.equal(stillBad.errorCode, 'VALIDATION_ERROR');
  assert.equal(stillBad.data, null);
  assert.equal(stillBad.repairCount, 1);
  assert.equal(stillBad.providerCalls, 2);
});
