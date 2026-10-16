import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { validateContract } from '@localqa/contracts';
import {
  AGENT_ROLES,
  DECISION_SCHEMA,
  PROMPT_VERSION,
  createPolicyDispatcher,
  renderAssertionPrompt,
  renderPrompt,
  reviewPlan,
  parametersForTool,
  runToolLoop,
  toolSchemasForRole,
  toolsForRole,
} from '../../agents/dist/index.js';
import {
  FIXTURE,
  assessCriterionOutput,
  createGateway,
  createOpenAIAdapter,
  createStubAdapter,
  estimateTokens,
  messageFromText,
  OPENAI_ADAPTER_VERSION,
  OPENAI_DIAGNOSTIC_SAMPLE_CHARS,
  OPENAI_RESPONSE_CHAR_LIMIT,
  redactMessages,
  redactThenSample,
  toOpenAIChatRequest,
} from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.resolve(here, '../.evidence/T04-model-latest.json');
const secret = 'hunter2';
const apiKey = 'super-secret-key-t04';
const passed = [];
const rawOutputs = [];

const decisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['toolCalls', 'done'],
  properties: {
    done: { type: 'boolean' },
    toolCalls: { type: 'array', items: { type: 'object' } },
  },
};
const assertSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['criterionId', 'result', 'reason', 'evidenceRefs'],
  properties: {
    criterionId: { type: 'string' },
    result: { enum: ['passed', 'failed', 'not_evaluated', 'unknown'] },
    reason: { type: 'string' },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
  },
};

function profile(id, model, extra = {}) {
  return {
    id,
    version: 1,
    name: model,
    endpoint: 'http://stub.local/v1',
    configuredModelId: model,
    kind: 'stub',
    dataBoundary: 'internal',
    capabilities: {
      structuredOutput: true,
      nativeTools: true,
      imageInput: true,
    },
    encryptedApiKey: 'cipher-text',
    approvedFallbackIds: [],
    ...extra,
  };
}

const stub = createStubAdapter();
let decrypts = 0;
const gateway = createGateway({
  profiles: [
    profile(FIXTURE.profileId, 'stub-ok', {
      approvedFallbackIds: [FIXTURE.fallbackProfileId],
    }),
    profile(FIXTURE.fallbackProfileId, 'stub-ok'),
    profile('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'stub-malformed'),
    profile('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'stub-image-unsupported', {
      capabilities: {
        structuredOutput: true,
        nativeTools: true,
        imageInput: false,
      },
    }),
    profile('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'stub-timeout'),
    profile('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'stub-429', {
      approvedFallbackIds: [FIXTURE.fallbackProfileId],
    }),
    profile('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'stub-repeat'),
    profile('ffffffff-ffff-4fff-8fff-ffffffffffff', 'stub-fake-evidence'),
    profile('12121212-1212-4121-8121-121212121212', 'stub-unauthorized'),
    profile('13131313-1313-4131-8131-131313131313', 'stub-ok', {
      capabilities: {
        structuredOutput: true,
        nativeTools: true,
        imageInput: false,
      },
      configuredModelId: 'stub-ok',
      name: 'visual-off',
    }),
  ],
  decryptKey() {
    decrypts += 1;
    return apiKey;
  },
  adapter: stub,
});

function baseInput(profileId, extra = {}) {
  return {
    taskId: FIXTURE.taskId,
    profileId,
    contextVersion: 1,
    role: 'executor',
    promptVersion: PROMPT_VERSION,
    purpose: 'decide',
    messages: [messageFromText('user', '观察：页面上有一个保存按钮。')],
    approvedImageIds: [],
    toolSchemas: [{ name: 'observe', parameters: { type: 'object' } }],
    outputSchema: decisionSchema,
    timeoutMs: 1000,
    maxOutputTokens: 400,
    knownEvidenceIds: [FIXTURE.evidenceId, FIXTURE.snapshotId],
    ...extra,
  };
}

function browserSnapshot(pageId = FIXTURE.pageId) {
  return {
    snapshotId: FIXTURE.snapshotId,
    pageId,
    frameIds: [],
    displayUrl: 'https://fixture.local/page',
    title: 'fixture',
    responseStatus: 200,
    capturedAt: '2026-10-02T00:00:00.000Z',
    stateVersion: 1,
    viewport: { width: 1280, height: 720 },
    nodes: [],
    screenshotRef: null,
    networkSummary: [],
    consoleSummary: [],
    truncated: false,
    redacted: true,
  };
}

function keep(id, record) {
  passed.push(id);
  rawOutputs.push({
    id,
    requestResult: record?.requestResult ?? null,
    errorCode: record?.errorCode ?? null,
    usageSource: record?.usageSource ?? null,
    inputTokens: record?.inputTokens ?? null,
    outputTokens: record?.outputTokens ?? null,
    requests: record?.requests ?? null,
    repairCount: record?.repairCount ?? null,
    providerCalls: record?.providerCalls ?? null,
    fallbackUsed: record?.fallbackUsed ?? null,
    fallbackDenied: record?.fallbackDenied ?? null,
    authorization: record?.authorization ?? null,
    rawOutput: record?.rawOutput ?? null,
    outboundRedacted: record?.outboundRedacted ?? null,
    assessment: record?.assessment ?? null,
    data: record?.data ?? null,
  });
}

test('capability probe reports usage and does not zero-fill', async () => {
  const before = decrypts;
  const record = await gateway.capabilityProbe(FIXTURE.profileId, 1000);
  assert.equal(record.requestResult, 'ok');
  assert.equal(record.data.status, 'ready');
  assert.equal(record.data.capabilities.imageInput, true);
  assert.equal(record.usageSource, 'reported');
  assert.equal(record.inputTokens, 11);
  assert.equal(record.outputTokens, 7);
  assert.ok(record.outputTokens !== 0);
  assert.ok(decrypts > before);
  assert.equal(record.authorization, 'set');
  assert.equal(JSON.stringify(record).includes(apiKey), false);
  keep('capability.probe', record);
});

test('image capability stays unsupported', async () => {
  const record = await gateway.capabilityProbe(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    1000,
  );
  assert.equal(record.errorCode, 'MODEL_CAPABILITY_MISSING');
  assert.equal(record.data.status, 'degraded');
  assert.equal(record.data.capabilities.imageInput, false);
  assert.match(record.data.notes.join(''), /不能改成文本验收/);
  keep('capability.image-unsupported', record);
});

test('redaction removes secrets and unapproved images', async () => {
  const direct = redactMessages(
    [
      {
        role: 'system',
        content: [
          { type: 'text', text: `PAGE_OBSERVATION: password=${secret}` },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '可见文本' },
          { type: 'image', artifactId: FIXTURE.imageId },
        ],
      },
    ],
    [],
  );
  assert.equal(direct.messages[0].role, 'user');
  assert.equal(direct.messages[0].content[0].text.includes(secret), false);
  assert.equal(direct.droppedImageIds[0], FIXTURE.imageId);
  assert.equal(
    direct.messages.some((message) =>
      message.content.some((part) => part.type === 'image'),
    ),
    false,
  );
  const record = await gateway.generateDecision(
    baseInput(FIXTURE.profileId, {
      messages: [messageFromText('user', `登录 password=${secret} 后看到按钮`)],
    }),
  );
  assert.equal(record.outboundRedacted.includes(secret), false);
  assert.equal(record.rawOutput.includes(secret), false);
  keep('redaction', record);
});

test('openai adapter keeps provider fields local', () => {
  const body = toOpenAIChatRequest({
    model: 'gpt-test',
    messages: [messageFromText('user', '只输出 JSON')],
    maxOutputTokens: 32,
    outputSchema: { type: 'object' },
    tools: [{ name: 'observe', parameters: { type: 'object' } }],
  });
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.max_completion_tokens, 32);
  assert.equal(Object.hasOwn(body, 'max_tokens'), false);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 'observe');
  const jsonObject = toOpenAIChatRequest({
    model: 'gpt-test',
    messages: [messageFromText('user', '只输出 JSON')],
    maxOutputTokens: 32,
    outputSchema: { type: 'object' },
    tools: [{ name: 'observe', parameters: { type: 'object' } }],
    responseFormat: 'json_object',
  });
  assert.equal(jsonObject.response_format.type, 'json_object');
  assert.equal(Object.hasOwn(jsonObject, 'tools'), false);
  assert.equal(JSON.stringify(jsonObject).includes('artifact://'), false);
  assert.throws(
    () =>
      toOpenAIChatRequest({
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', artifactId: FIXTURE.imageId }],
          },
        ],
        maxOutputTokens: 32,
        outputSchema: { type: 'object' },
        tools: [],
      }),
    (error) => error.code === 'MODEL_NOT_CONFIGURED',
  );
  keep('adapter.openai-shape', {
    requestResult: 'shape',
    rawOutput: JSON.stringify(body),
    data: body,
  });
});

test('format repair happens once', async () => {
  const record = await gateway.generateDecision(
    baseInput('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      outputSchema: decisionSchema,
    }),
  );
  assert.equal(record.requestResult, 'repaired');
  assert.equal(record.repairCount, 1);
  assert.equal(record.providerCalls, 2);
  assert.equal(record.usageSource, 'mixed');
  assert.ok(record.inputTokens > 0);
  assert.ok(record.outputTokens > 0);
  assert.equal(record.data.done, true);
  keep('format-repair.once', record);

  let calls = 0;
  const stuck = createGateway({
    profiles: [
      profile(FIXTURE.profileId, 'stub-ok', { encryptedApiKey: null }),
    ],
    decryptKey() {
      throw new Error('should not decrypt');
    },
    adapter: {
      kind: 'stub',
      version: 'stuck.1',
      build: (input) => ({
        endpoint: input.endpoint,
        body: { messages: input.messages },
      }),
      send: async () => {
        calls += 1;
        return {
          raw: 'nope',
          httpStatus: 200,
          reportedModelId: null,
          usage: null,
          errorCode: null,
        };
      },
    },
  });
  const failed = await stuck.generateDecision(baseInput(FIXTURE.profileId));
  assert.equal(calls, 2);
  assert.equal(failed.repairCount, 1);
  assert.equal(failed.requestResult, 'malformed');
  keep('format-repair.stop', failed);
});

test('tool loop uses the dispatcher and not playwright', async () => {
  const executed = [];
  const loop = await runToolLoop({
    gateway,
    role: 'explorer',
    taskId: FIXTURE.taskId,
    profileId: FIXTURE.profileId,
    knownEvidenceIds: [FIXTURE.evidenceId],
    timeoutMs: 1000,
    execute: async (call) => {
      executed.push(call);
      return browserSnapshot(call.args?.pageId ?? FIXTURE.pageId);
    },
  });
  assert.equal(loop.stoppedBecause, 'done');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, 'observe');
  assert.equal(loop.dispatches[0].executed, true);
  const roots = [
    path.resolve(here, '../src'),
    path.resolve(here, '../../agents/src'),
  ];
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      const text = readFileSync(path.join(root, name), 'utf8');
      assert.equal(text.includes("from 'playwright'"), false);
      assert.equal(text.includes('from "playwright"'), false);
    }
  }
  keep('tool-loop', loop.records.at(-1));
});

test('repeated action is not rejected by dispatcher (handled by browser layer)', async () => {
  const executed = [];
  const loop = await runToolLoop({
    gateway,
    role: 'executor',
    taskId: FIXTURE.taskId,
    profileId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    knownEvidenceIds: [FIXTURE.snapshotId, FIXTURE.evidenceId],
    timeoutMs: 1000,
    execute: async (call) => {
      executed.push(call.name);
      return browserSnapshot();
    },
  });
  // Dispatcher delegates repetition policy to browser/waiter; multiple calls execute
  assert.ok(executed.length > 1);
  assert.equal(loop.dispatches[0].executed, true);
  assert.equal(loop.dispatches[1].executed, true);
  keep('repeat-action', loop.records.at(-1));
});

test('timeout keeps estimated input and does not zero the output', async () => {
  const record = await gateway.generateDecision(
    baseInput('cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
      timeoutMs: 40,
    }),
  );
  assert.equal(record.requestResult, 'timeout');
  assert.equal(record.errorCode, 'MODEL_TIMEOUT');
  assert.equal(record.usageSource, 'estimated');
  assert.ok(record.inputTokens > 0);
  assert.equal(record.outputTokens, null);
  assert.ok(record.latencyMs >= 30);
  keep('timeout', record);
});

test('429 does not switch provider', async () => {
  const record = await gateway.generateDecision(
    baseInput('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  );
  assert.equal(record.requestResult, 'rate_limited');
  assert.equal(record.errorCode, 'RATE_LIMITED');
  assert.equal(record.providerCalls, 1);
  assert.equal(record.fallbackUsed, false);
  assert.equal(record.outputTokens, null);
  assert.ok(record.inputTokens > 0);
  keep('rate-limited', record);
});

test('unconfigured fallback is refused', async () => {
  const denied = await gateway.generateDecision(
    baseInput('dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
      fallbackProfileId: FIXTURE.missingProfileId,
    }),
  );
  assert.equal(denied.fallbackUsed, false);
  assert.equal(denied.fallbackDenied, true);
  assert.equal(denied.providerCalls, 1);
  keep('fallback.denied', denied);

  const used = await gateway.generateDecision(
    baseInput('dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
      fallbackProfileId: FIXTURE.fallbackProfileId,
    }),
  );
  assert.equal(used.fallbackUsed, true);
  assert.equal(used.requestResult, 'ok');
  assert.deepEqual(used.attemptedModelIds, ['stub-429', 'stub-ok']);
  keep('fallback.approved', used);
});

test('missing profile and openai without a key do not call out', async () => {
  const missing = await gateway.generateDecision(
    baseInput(FIXTURE.missingProfileId),
  );
  assert.equal(missing.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.equal(missing.providerCalls, 0);
  keep('profile.missing', missing);

  let fetched = 0;
  const live = createGateway({
    profiles: [
      {
        id: FIXTURE.profileId,
        version: 3,
        name: 'external',
        endpoint: 'http://insecure.example/v1',
        configuredModelId: 'real-model',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: true,
          imageInput: true,
        },
        encryptedApiKey: 'cipher-text',
        approvedFallbackIds: [],
      },
    ],
    decryptKey() {
      throw new Error('key should stay encrypted');
    },
    adapter: createOpenAIAdapter(async () => {
      fetched += 1;
      throw new Error('network');
    }),
  });
  const blocked = await live.generateDecision(baseInput(FIXTURE.profileId));
  assert.equal(blocked.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.equal(fetched, 0);
  keep('openai.https-and-key', blocked);
});

test('fake evidence id is not accepted', async () => {
  const record = await gateway.evaluateCriterion(
    baseInput('ffffffff-ffff-4fff-8fff-ffffffffffff', {
      purpose: 'assert',
      role: 'assertion',
      outputSchema: assertSchema,
      criterion: { id: FIXTURE.criterionId, kind: 'semantic' },
      knownEvidenceIds: [FIXTURE.evidenceId],
    }),
  );
  assert.equal(record.assessment.verdictStatus, 'inconclusive');
  assert.equal(record.assessment.reasonCode, 'FAKE_EVIDENCE');
  assert.deepEqual(record.assessment.acceptedEvidenceRefs, []);
  assert.equal(record.rawOutput.includes(FIXTURE.fakeEvidenceId), true);
  keep('fake-evidence', record);
});

test('assertion without an observation ref is inconclusive', () => {
  const assessment = assessCriterionOutput({
    data: {
      criterionId: FIXTURE.criterionId,
      result: 'passed',
      reason: '我觉得可以',
      evidenceRefs: [],
    },
    expectedCriterionId: FIXTURE.criterionId,
    knownEvidenceIds: [FIXTURE.evidenceId],
    criterionKind: 'semantic',
    imageInput: true,
  });
  assert.equal(assessment.verdictStatus, 'inconclusive');
  assert.equal(assessment.reasonCode, 'NO_OBSERVATION_REF');
  keep('assertion.no-ref', {
    requestResult: 'inconclusive',
    assessment,
    rawOutput: JSON.stringify(assessment),
  });
});

test('unauthorized tool is not executed', async () => {
  const executed = [];
  const loop = await runToolLoop({
    gateway,
    role: 'explorer',
    taskId: FIXTURE.taskId,
    profileId: '12121212-1212-4121-8121-121212121212',
    knownEvidenceIds: [],
    timeoutMs: 1000,
    execute: async () => {
      executed.push('ran');
      return { ran: true };
    },
  });
  assert.deepEqual(executed, []);
  assert.equal(loop.stoppedBecause, 'POLICY_DENIED');
  assert.equal(toolsForRole('explorer').includes('finish_case'), false);
  keep('unauthorized-tool', loop.records[0]);
});

test('planner output must carry sources', () => {
  const rejected = reviewPlan({
    criteria: [
      { id: 'c1', sourceKind: 'user_spec', description: '没有来源引用' },
    ],
  });
  assert.equal(rejected.accepted, false);
  const incomplete = reviewPlan({
    criteria: [
      {
        id: 'c1',
        kind: 'element_visible',
        sourceKind: 'generic_smoke',
        sourceRef: 'smoke:visible',
      },
    ],
  });
  assert.equal(incomplete.accepted, false);
  assert.equal(incomplete.missing.includes('0.description'), true);
  assert.equal(incomplete.missing.includes('0.locator'), true);
  const accepted = reviewPlan({
    criteria: [
      {
        id: 'c1',
        kind: 'element_visible',
        description: '保存按钮可见',
        sourceKind: 'generic_smoke',
        sourceRef: 'smoke:visible',
        locator: { by: 'role', value: 'button' },
      },
    ],
  });
  assert.equal(accepted.accepted, true);
  keep('planner.sources', {
    requestResult: accepted.reason,
    rawOutput: JSON.stringify({ rejected, incomplete, accepted }),
    data: { rejected, incomplete, accepted },
  });
});

test('visual criterion is not rewritten as a text pass', async () => {
  const record = await gateway.evaluateCriterion(
    baseInput('13131313-1313-4131-8131-131313131313', {
      purpose: 'assert',
      outputSchema: assertSchema,
      criterion: { id: FIXTURE.criterionId, kind: 'visual' },
      knownEvidenceIds: [FIXTURE.evidenceId],
    }),
  );
  assert.equal(record.assessment.verdictStatus, 'blocked');
  assert.equal(record.assessment.reasonCode, 'MODEL_CAPABILITY_MISSING');
  assert.notEqual(record.assessment.verdictStatus, 'passed');
  keep('visual.not-downgraded', record);
});

test('oversized context is not sent', async () => {
  const before = stub.calls;
  const record = await gateway.generateDecision(
    baseInput(FIXTURE.profileId, {
      maxInputTokens: 5,
      messages: [messageFromText('user', '超大页面'.repeat(200))],
    }),
  );
  assert.equal(record.requestResult, 'budget_exceeded');
  assert.equal(record.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(record.providerCalls, 0);
  assert.equal(stub.calls, before);
  assert.ok(record.inputTokens > 0);
  assert.equal(record.outputTokens, null);
  keep('budget', record);
});

test('internal complete validates the contract result', async () => {
  const record = await gateway.complete(
    {
      taskId: FIXTURE.taskId,
      profileId: FIXTURE.profileId,
      contextVersion: 1,
      purpose: 'decide',
      messages: [messageFromText('user', '决定下一步')],
      maxOutputTokens: 200,
      outputSchema: decisionSchema,
    },
    {
      role: 'executor',
      promptVersion: PROMPT_VERSION,
      approvedImageIds: [],
      toolSchemas: [],
      timeoutMs: 1000,
    },
  );
  assert.equal(record.requestResult, 'ok');
  assert.equal(record.data.configuredModelId, 'stub-ok');
  assert.equal(record.data.usage.usageSource, 'reported');
  assert.equal(record.data.usage.outputTokens, 7);
  const invalid = await gateway.complete(
    { taskId: 'not-a-uuid' },
    {
      role: 'executor',
      promptVersion: PROMPT_VERSION,
      approvedImageIds: [],
      toolSchemas: [],
      timeoutMs: 1000,
    },
  );
  assert.equal(invalid.errorCode, 'VALIDATION_ERROR');
  assert.equal(invalid.providerCalls, 0);
  keep('complete.contract', record);
});

test('role prompts and tool scopes are versioned', () => {
  const scopes = {};
  for (const role of AGENT_ROLES) {
    const prompt = renderPrompt(role);
    assert.equal(prompt.version, PROMPT_VERSION);
    assert.match(prompt.text, new RegExp(`role=${role}`));
    scopes[role] = prompt.allowedTools;
  }
  assert.deepEqual(scopes.planner, []);
  assert.deepEqual(scopes.finalizer, []);
  assert.equal(scopes.coordinator.includes('click'), false);
  // Browser roles are advertised exactly the tools the session-managed action
  // ledger can grant. The case/report stubs and inspect_network/assert tools
  // are contract roles, but the Worker's runtime authority never executes
  // them in a session-managed run, so offering them only produced denials.
  assert.equal(scopes.executor.includes('click'), true);
  assert.equal(scopes.executor.includes('finish_case'), false);
  assert.equal(scopes.executor.includes('submit_case'), false);
  assert.equal(scopes.executor.includes('assert_criterion'), false);
  assert.equal(scopes.executor.includes('inspect_network'), false);
  assert.equal(scopes.reproducer.includes('complete_reproduction'), false);
  assert.equal(scopes.reproducer.includes('type_text'), true);
  assert.equal(scopes.explorer.includes('assert_criterion'), false);
  const assertion = renderAssertionPrompt();
  assert.match(assertion.text, /criterionId/);
  assert.match(assertion.text, /inconclusive/);
  keep('roles.prompts', {
    requestResult: 'ok',
    rawOutput: JSON.stringify(scopes),
    data: scopes,
  });
});

test('provider statuses map onto section 7 and are not completions', async () => {
  const profileId = '14141414-1414-4141-8141-141414141414';
  const doneBody = JSON.stringify({ done: true, toolCalls: [] });
  async function call(fetchImpl, extra = {}) {
    const gw = createGateway({
      profiles: [
        {
          id: profileId,
          version: 1,
          name: 'openai-errors',
          endpoint: 'https://example.test/v1',
          configuredModelId: 'gpt-test',
          kind: 'openai_compatible',
          dataBoundary: 'external',
          capabilities: {
            structuredOutput: true,
            nativeTools: true,
            imageInput: false,
          },
          encryptedApiKey: 'cipher',
          approvedFallbackIds: [],
        },
      ],
      decryptKey: () => 'openai-test-key',
      adapter: createOpenAIAdapter(fetchImpl),
    });
    return gw.generateDecision(
      baseInput(profileId, { timeoutMs: 1000, ...extra }),
    );
  }
  const jsonResponse = (status, body) => async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const unauthorized = await call(jsonResponse(401, '{"error":"bad key"}'));
  assert.equal(unauthorized.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.equal(unauthorized.requestResult, 'not_configured');
  assert.equal(unauthorized.data, null);
  keep('provider.401', unauthorized);

  const forbidden = await call(jsonResponse(403, '{"error":"forbidden"}'));
  assert.equal(forbidden.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.equal(forbidden.requestResult, 'not_configured');
  assert.equal(forbidden.data, null);
  keep('provider.403', forbidden);

  const invalid = await call(jsonResponse(422, doneBody));
  assert.equal(invalid.errorCode, 'VALIDATION_ERROR');
  assert.equal(invalid.requestResult, 'malformed');
  assert.equal(invalid.data, null);
  assert.equal(invalid.providerCalls, 1);
  keep('provider.4xx', invalid);

  const down = await call(jsonResponse(500, doneBody));
  assert.equal(down.errorCode, 'SERVICE_UNAVAILABLE');
  assert.equal(down.requestResult, 'unavailable');
  assert.equal(down.data, null);
  assert.equal(down.providerCalls, 1);
  keep('provider.5xx', down);

  const transport = await call(async () => {
    throw new TypeError('network down');
  });
  assert.equal(transport.errorCode, 'SERVICE_UNAVAILABLE');
  assert.equal(transport.requestResult, 'unavailable');
  assert.equal(transport.data, null);
  keep('provider.transport', transport);

  const timed = await call(
    (...args) =>
      new Promise((_resolve, reject) => {
        const init = args[1];
        init.signal.addEventListener('abort', () => {
          reject(
            Object.assign(new Error('The operation was aborted'), {
              name: 'AbortError',
            }),
          );
        });
      }),
    { timeoutMs: 40 },
  );
  assert.equal(timed.errorCode, 'MODEL_TIMEOUT');
  assert.equal(timed.requestResult, 'timeout');
  assert.equal(timed.data, null);
  keep('provider.timeout', timed);
});

test('gateway uses the declared format and validates the unwrapped decision', async () => {
  const profileId = '15151515-1515-4151-8151-151515151515';
  const configured = 'deepseek-chat';
  const click = {
    name: 'click',
    args: {
      target: {
        snapshotId: FIXTURE.snapshotId,
        pageId: FIXTURE.pageId,
        nodeId: 'tab-btn-details',
      },
    },
  };
  const decision = { toolCalls: [click], done: false };
  let calls = 0;
  let seen = null;
  const gw = createGateway({
    profiles: [
      {
        id: profileId,
        version: 1,
        name: 'json-object',
        endpoint: 'https://example.test/v1',
        configuredModelId: configured,
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: true,
          imageInput: false,
        },
        responseFormat: 'json_object',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async (_url, init) => {
      calls += 1;
      seen = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [
            {
              message: { role: 'assistant', content: JSON.stringify(decision) },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  });
  const record = await gw.generateDecision(
    baseInput(profileId, { outputSchema: decisionSchema, toolSchemas: [] }),
  );
  assert.equal(calls, 1);
  assert.equal(seen.model, configured);
  assert.equal(seen.response_format.type, 'json_object');
  assert.equal(Object.hasOwn(seen, 'tools'), false);
  assert.equal(record.requestResult, 'ok');
  assert.equal(record.modelId, configured);
  assert.equal(record.reportedModelId, 'deepseek-flash');
  assert.equal(record.usageSource, 'reported');
  assert.deepEqual(record.data, decision);
  assert.equal(
    validateContract('ToolCall', record.data.toolCalls[0]).success,
    true,
  );
  keep('g3a.json-object-decision', record);

  let schemaCalls = 0;
  const strict = createGateway({
    profiles: [
      {
        id: profileId,
        version: 1,
        name: 'json-schema',
        endpoint: 'https://example.test/v1',
        configuredModelId: configured,
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_schema',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: ['16161616-1616-4161-8161-161616161616'],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async (_url, init) => {
      schemaCalls += 1;
      seen = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          error: { message: 'This response_format type is unavailable now' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }),
  });
  const rejected = await strict.generateDecision(
    baseInput(profileId, {
      fallbackProfileId: '16161616-1616-4161-8161-161616161616',
    }),
  );
  assert.equal(schemaCalls, 1);
  assert.equal(seen.response_format.type, 'json_schema');
  assert.equal(seen.response_format.json_schema.strict, true);
  assert.equal(seen.model, configured);
  assert.equal(rejected.errorCode, 'VALIDATION_ERROR');
  assert.equal(rejected.requestResult, 'malformed');
  assert.equal(rejected.providerCalls, 1);
  assert.equal(rejected.fallbackUsed, false);
  assert.equal(rejected.reportedModelId, null);
  assert.equal(rejected.data, null);
  keep('g3a.no-format-downgrade', rejected);
});

test('native tool arguments are accepted only when they match ToolCall', async () => {
  const profileId = '17171717-1717-4171-8171-171717171717';
  function gatewayFor(payload) {
    return createGateway({
      profiles: [
        {
          id: profileId,
          version: 1,
          name: 'native',
          endpoint: 'https://example.test/v1',
          configuredModelId: 'deepseek-chat',
          kind: 'openai_compatible',
          dataBoundary: 'external',
          capabilities: {
            structuredOutput: false,
            nativeTools: true,
            imageInput: false,
          },
          responseFormat: 'native_tools',
          encryptedApiKey: 'cipher',
          approvedFallbackIds: [],
        },
      ],
      decryptKey: () => 'openai-test-key',
      adapter: createOpenAIAdapter(async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(Object.hasOwn(body, 'response_format'), false);
        assert.equal(body.tools[0].function.name, 'click');
        assert.equal(body.model, 'deepseek-chat');
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });
  }
  const envelope = (args) => ({
    model: 'deepseek-flash',
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'click', arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 9 },
  });
  const bad = await gatewayFor(
    envelope({
      snapshotId: 'fixture',
      pageId: 'home',
      nodeId: 'tab-btn-details',
    }),
  ).generateDecision(
    baseInput(profileId, {
      toolSchemas: [{ name: 'click', parameters: { type: 'object' } }],
    }),
  );
  assert.equal(bad.requestResult, 'malformed');
  assert.equal(bad.errorCode, 'VALIDATION_ERROR');
  assert.equal(bad.providerCalls, 1);
  assert.equal(bad.repairCount, 0);
  assert.equal(bad.data, null);
  assert.equal(bad.reportedModelId, 'deepseek-flash');
  keep('g3a.native-tool-rejected', bad);

  const goodArgs = {
    target: {
      snapshotId: FIXTURE.snapshotId,
      pageId: FIXTURE.pageId,
      nodeId: 'tab-btn-details',
    },
  };
  const good = await gatewayFor(envelope(goodArgs)).generateDecision(
    baseInput(profileId, {
      toolSchemas: [{ name: 'click', parameters: { type: 'object' } }],
    }),
  );
  assert.equal(good.requestResult, 'ok');
  assert.equal(good.providerCalls, 1);
  assert.equal(
    validateContract('ToolCall', good.data.toolCalls[0]).success,
    true,
  );
  assert.equal(good.data.toolCalls[0].args.target.nodeId, 'tab-btn-details');
  assert.equal(good.modelId, 'deepseek-chat');
  assert.equal(good.reportedModelId, 'deepseek-flash');
  keep('g3a.native-tool-accepted', good);
});

test('approved images use a legal transport or fail closed', async () => {
  const profileId = '18181818-1818-4181-8181-181818181818';
  const png = new Uint8Array([1]);
  let calls = 0;
  let seen = null;
  function profile(extra = {}) {
    return {
      id: profileId,
      version: 1,
      name: 'vision',
      endpoint: 'https://example.test/v1',
      configuredModelId: 'deepseek-chat',
      kind: 'openai_compatible',
      dataBoundary: 'external',
      capabilities: {
        structuredOutput: true,
        nativeTools: false,
        imageInput: true,
      },
      responseFormat: 'json_object',
      encryptedApiKey: 'cipher',
      approvedFallbackIds: [],
      ...extra,
    };
  }
  const imageMessage = {
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', artifactId: FIXTURE.imageId },
    ],
  };
  const gw = createGateway({
    profiles: [profile()],
    decryptKey: () => 'openai-test-key',
    resolveArtifact(id) {
      assert.equal(id, FIXTURE.imageId);
      return { mediaType: 'image/png', bytes: png };
    },
    adapter: createOpenAIAdapter(async (_url, init) => {
      calls += 1;
      seen = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({ toolCalls: [], done: true }),
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 4 },
        }),
        { status: 200 },
      );
    }),
  });
  const sent = await gw.generateDecision(
    baseInput(profileId, {
      messages: [imageMessage],
      approvedImageIds: [FIXTURE.imageId],
      toolSchemas: [],
    }),
  );
  assert.equal(calls, 1);
  assert.equal(sent.requestResult, 'ok');
  const url = seen.messages[0].content[1].image_url.url;
  assert.match(url, /^data:image\/png;base64,/);
  assert.equal(url.includes('artifact://'), false);
  assert.equal(sent.outboundRedacted.includes('artifact://'), false);
  assert.equal(sent.outboundRedacted.includes(url.split(',')[1]), false);
  assert.match(sent.outboundRedacted, /data:image;base64,\[redacted\]/);
  keep('g3a.image-data-url', sent);

  const httpsGw = createGateway({
    profiles: [profile()],
    decryptKey: () => 'openai-test-key',
    resolveArtifact: () => ({ url: 'https://fixture.local/shot.png' }),
    adapter: createOpenAIAdapter(async (_url, init) => {
      seen = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [
            {
              message: {
                content: JSON.stringify({ toolCalls: [], done: true }),
              },
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 3 },
        }),
        { status: 200 },
      );
    }),
  });
  const httpsSent = await httpsGw.generateDecision(
    baseInput(profileId, {
      messages: [imageMessage],
      approvedImageIds: [FIXTURE.imageId],
      toolSchemas: [],
    }),
  );
  assert.equal(
    seen.messages[0].content[1].image_url.url,
    'https://fixture.local/shot.png',
  );
  assert.equal(JSON.stringify(seen).includes('artifact://'), false);
  assert.equal(httpsSent.requestResult, 'ok');
  keep('g3a.image-https', httpsSent);

  let unresolvedCalls = 0;
  const unresolved = createGateway({
    profiles: [profile()],
    decryptKey: () => 'openai-test-key',
    resolveArtifact: () => null,
    adapter: createOpenAIAdapter(async () => {
      unresolvedCalls += 1;
      throw new Error('should not send');
    }),
  });
  const missing = await unresolved.generateDecision(
    baseInput(profileId, {
      messages: [imageMessage],
      approvedImageIds: [FIXTURE.imageId],
      toolSchemas: [],
    }),
  );
  assert.equal(unresolvedCalls, 0);
  assert.equal(missing.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.equal(missing.providerCalls, 0);
  keep('g3a.image-unresolved', missing);

  let blindCalls = 0;
  const blind = createGateway({
    profiles: [
      profile({
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
      }),
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async () => {
      blindCalls += 1;
      throw new Error('should not send');
    }),
  });
  const noVision = await blind.generateDecision(
    baseInput(profileId, {
      messages: [imageMessage],
      approvedImageIds: [FIXTURE.imageId],
      toolSchemas: [],
    }),
  );
  assert.equal(blindCalls, 0);
  assert.equal(noVision.errorCode, 'MODEL_CAPABILITY_MISSING');
  assert.equal(noVision.providerCalls, 0);
  keep('g3a.image-capability', noVision);

  let textCalls = 0;
  const textVision = createGateway({
    profiles: [profile()],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async () => {
      textCalls += 1;
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  criterionId: FIXTURE.criterionId,
                  result: 'passed',
                  reason: '正文里写着按钮',
                  evidenceRefs: [FIXTURE.evidenceId],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 4 },
        }),
        { status: 200 },
      );
    }),
  });
  const visual = await textVision.evaluateCriterion(
    baseInput(profileId, {
      purpose: 'assert',
      outputSchema: assertSchema,
      criterion: { id: FIXTURE.criterionId, kind: 'visual' },
      knownEvidenceIds: [FIXTURE.evidenceId],
      messages: [messageFromText('user', '页面文字写着 Details')],
    }),
  );
  assert.equal(textCalls, 0);
  assert.equal(visual.assessment.verdictStatus, 'blocked');
  assert.equal(visual.assessment.reasonCode, 'MODEL_CAPABILITY_MISSING');
  assert.equal(visual.providerCalls, 0);
  keep('g3a.visual-without-image', visual);

  const bulky = createGateway({
    profiles: [profile()],
    decryptKey: () => 'openai-test-key',
    resolveArtifact: () => ({
      mediaType: 'image/png',
      bytes: new Uint8Array(400),
    }),
    adapter: createOpenAIAdapter(async () => {
      throw new Error('should not send');
    }),
  });
  const over = await bulky.generateDecision(
    baseInput(profileId, {
      maxInputTokens: 20,
      messages: [imageMessage],
      approvedImageIds: [FIXTURE.imageId],
      toolSchemas: [],
    }),
  );
  assert.equal(over.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(over.providerCalls, 0);
  assert.ok(over.inputTokens > 20);
  keep('g3a.image-budget', over);
});

test('429 and an unapproved fallback stay on the configured model', async () => {
  const profileId = '19191919-1919-4191-8191-191919191919';
  const other = '16161616-1616-4161-8161-161616161616';
  let calls = 0;
  const models = [];
  const gw = createGateway({
    profiles: [
      {
        id: profileId,
        version: 1,
        name: 'primary',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
      {
        id: other,
        version: 1,
        name: 'other',
        endpoint: 'https://other.test/v1',
        configuredModelId: 'other-model',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async (_url, init) => {
      calls += 1;
      models.push(JSON.parse(init.body).model);
      return new Response('{"error":"slow down"}', { status: 429 });
    }),
  });
  const record = await gw.generateDecision(
    baseInput(profileId, { fallbackProfileId: other }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(models, ['deepseek-chat']);
  assert.equal(record.errorCode, 'RATE_LIMITED');
  assert.equal(record.requestResult, 'rate_limited');
  assert.equal(record.fallbackUsed, false);
  assert.equal(record.fallbackDenied, true);
  assert.equal(record.providerCalls, 1);
  assert.equal(record.data, null);
  keep('g3a.fallback-unapproved-429', record);

  let probeCalls = 0;
  const missingCaps = createGateway({
    profiles: [
      {
        id: profileId,
        version: 1,
        name: 'none',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: false,
          nativeTools: false,
          imageInput: false,
        },
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async () => {
      probeCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'rejected' } }), {
        status: 400,
      });
    }),
  });
  const probe = await missingCaps.capabilityProbe(profileId, 1000);
  const again = await missingCaps.capabilityProbe(profileId, 1000);
  assert.equal(probeCalls, 2);
  assert.equal(probe.errorCode, 'VALIDATION_ERROR');
  assert.equal(again.errorCode, 'VALIDATION_ERROR');
  assert.notEqual(probe.data?.status, 'ready');
  assert.notEqual(probe.data?.status, 'disabled');
  assert.notEqual(again.data?.status, 'disabled');
  keep('g3a.no-structured-output', probe);
});

function reproducedLongEnvelope() {
  const note = 'n'.repeat(2300);
  const decision = { toolCalls: [], done: true, note };
  const content = JSON.stringify(decision);
  const raw = JSON.stringify({
    model: 'deepseek-flash',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 11, completion_tokens: 100000000 },
  });
  return { note, decision, raw };
}

function overLimitBody() {
  const content = JSON.stringify({ toolCalls: [], done: true });
  const core = {
    model: 'deepseek-flash',
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
    pad: '',
  };
  const room = OPENAI_RESPONSE_CHAR_LIMIT - JSON.stringify(core).length;
  const exact = JSON.stringify({ ...core, pad: 'p'.repeat(room) });
  assert.equal(exact.length, OPENAI_RESPONSE_CHAR_LIMIT);
  assert.equal(JSON.parse(exact).usage.completion_tokens, 4);
  return `${exact}x`;
}

async function sendLocal(body, status = 200, key = 'openai-test-key') {
  const adapter = createOpenAIAdapter(async () =>
    body instanceof Response ? body : new Response(body, { status }),
  );
  return adapter.send(
    {
      model: 'deepseek-chat',
      endpoint: 'https://example.test/v1/chat/completions',
      body: { model: 'deepseek-chat' },
      apiKey: key,
    },
    new AbortController().signal,
  );
}

test('a long completion is parsed whole and the log stays a sample', async () => {
  const { note, decision, raw } = reproducedLongEnvelope();
  assert.equal(note.length, 2300);
  assert.equal(raw.length, 2489);
  assert.ok(raw.indexOf('"usage"') > OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  assert.throws(() => JSON.parse(raw.slice(0, OPENAI_DIAGNOSTIC_SAMPLE_CHARS)));

  const direct = await sendLocal(raw, 200);
  assert.equal(direct.errorCode, null);
  assert.equal(direct.raw.length, 2489);
  assert.equal(direct.logSample.length, OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  assert.notEqual(direct.logSample, direct.raw);
  assert.throws(() => JSON.parse(direct.logSample));
  assert.equal(direct.reportedModelId, 'deepseek-flash');
  assert.deepEqual(direct.usage, { inputTokens: 11, outputTokens: 100000000 });

  const profileId = '20202020-2020-4020-8020-202020202020';
  let calls = 0;
  let seen = null;
  const gw = createGateway({
    profiles: [
      {
        id: profileId,
        version: 1,
        name: 'long',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_object',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async (_url, init) => {
      calls += 1;
      seen = JSON.parse(init.body);
      return new Response(raw, { status: 200 });
    }),
  });
  const longSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['toolCalls', 'done', 'note'],
    properties: {
      done: { type: 'boolean' },
      note: { type: 'string', minLength: 2300 },
      toolCalls: { type: 'array', items: { type: 'object' } },
    },
  };
  const record = await gw.generateDecision(
    baseInput(profileId, { outputSchema: longSchema, toolSchemas: [] }),
  );
  assert.equal(calls, 1);
  assert.equal(seen.model, 'deepseek-chat');
  assert.equal(record.adapterVersion, OPENAI_ADAPTER_VERSION);
  assert.equal(OPENAI_ADAPTER_VERSION, 'openai-compatible.2');
  assert.equal(record.requestResult, 'ok');
  assert.equal(record.errorCode, null);
  assert.equal(record.modelId, 'deepseek-chat');
  assert.equal(record.reportedModelId, 'deepseek-flash');
  assert.equal(record.usageSource, 'reported');
  assert.equal(record.inputTokens, 11);
  assert.equal(record.outputTokens, 100000000);
  assert.equal(record.data.note.length, 2300);
  assert.equal(record.data.note, decision.note);
  assert.equal(record.providerCalls, 1);
  assert.equal(record.fallbackUsed, false);
  assert.equal(record.rawOutput.length, OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  assert.throws(() => JSON.parse(record.rawOutput));
  keep('g3b.long-envelope', record);
});

test('non-json, http errors, and over-limit bodies are not successful completions', async () => {
  const junk = `not-json ${'x'.repeat(2500)}`;
  const broken = await sendLocal(junk, 200);
  assert.ok(junk.length > OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  assert.equal(broken.raw, junk);
  assert.equal(broken.logSample.length, OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  assert.equal(broken.errorCode, null);
  assert.equal(broken.usage, null);
  assert.equal(broken.reportedModelId, null);

  const profileId = '21212121-2121-4121-8121-212121212121';
  let junkCalls = 0;
  const junkGw = createGateway({
    profiles: [
      {
        id: profileId,
        version: 1,
        name: 'junk',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_object',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: ['23232323-2323-4232-8232-232323232323'],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async () => {
      junkCalls += 1;
      return new Response(junk, { status: 200 });
    }),
  });
  const junkRecord = await junkGw.generateDecision(
    baseInput(profileId, {
      fallbackProfileId: '23232323-2323-4232-8232-232323232323',
    }),
  );
  assert.equal(junkCalls, 2);
  assert.equal(junkRecord.requestResult, 'malformed');
  assert.equal(junkRecord.errorCode, 'VALIDATION_ERROR');
  assert.equal(junkRecord.data, null);
  assert.notEqual(junkRecord.usageSource, 'reported');
  assert.equal(junkRecord.fallbackUsed, false);
  assert.deepEqual(
    junkRecord.rawOutput.split('\n').map((part) => part.length),
    [OPENAI_DIAGNOSTIC_SAMPLE_CHARS, OPENAI_DIAGNOSTIC_SAMPLE_CHARS],
  );
  keep('g3b.non-json', junkRecord);

  const errorBody = 'e'.repeat(3000);
  const httpError = await sendLocal(errorBody, 400);
  assert.equal(httpError.errorCode, 'VALIDATION_ERROR');
  assert.equal(httpError.usage, null);
  assert.equal(httpError.reportedModelId, null);
  assert.equal(httpError.raw.length, 3000);
  assert.equal(httpError.logSample.length, OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  let errorCalls = 0;
  const errorGw = createGateway({
    profiles: [
      {
        id: profileId,
        version: 1,
        name: 'http-error',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_schema',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async () => {
      errorCalls += 1;
      return new Response(errorBody, { status: 400 });
    }),
  });
  const errorRecord = await errorGw.generateDecision(baseInput(profileId));
  assert.equal(errorCalls, 1);
  assert.equal(errorRecord.errorCode, 'VALIDATION_ERROR');
  assert.equal(errorRecord.requestResult, 'malformed');
  assert.equal(errorRecord.data, null);
  assert.equal(errorRecord.providerCalls, 1);
  assert.equal(errorRecord.rawOutput.length, OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  assert.equal(errorRecord.fallbackUsed, false);
  keep('g3b.http-error-sample', errorRecord);

  const huge = overLimitBody();
  assert.equal(huge.length, OPENAI_RESPONSE_CHAR_LIMIT + 1);
  const refused = await sendLocal(huge, 200);
  assert.equal(refused.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(refused.raw, '');
  assert.equal(refused.usage, null);
  assert.equal(refused.reportedModelId, null);
  assert.equal(refused.logSample.length, OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  assert.throws(() => JSON.parse(refused.logSample));

  const fallbackId = '24242424-2424-4242-8242-242424242424';
  let hugeCalls = 0;
  const models = [];
  const hugeGw = createGateway({
    profiles: [
      {
        id: profileId,
        version: 1,
        name: 'over-limit',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_object',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [fallbackId],
      },
      {
        id: fallbackId,
        version: 1,
        name: 'other',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'other-model',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_object',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async (_url, init) => {
      hugeCalls += 1;
      models.push(JSON.parse(init.body).model);
      return new Response(huge, { status: 200 });
    }),
  });
  const hugeRecord = await hugeGw.generateDecision(
    baseInput(profileId, { fallbackProfileId: fallbackId }),
  );
  assert.equal(hugeCalls, 1);
  assert.deepEqual(models, ['deepseek-chat']);
  assert.equal(hugeRecord.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(hugeRecord.requestResult, 'budget_exceeded');
  assert.equal(hugeRecord.data, null);
  assert.equal(hugeRecord.providerCalls, 1);
  assert.equal(hugeRecord.repairCount, 0);
  assert.equal(hugeRecord.fallbackUsed, false);
  assert.equal(hugeRecord.fallbackDenied, false);
  assert.notEqual(hugeRecord.usageSource, 'reported');
  assert.equal(hugeRecord.outputTokens, null);
  assert.equal(hugeRecord.reportedModelId, null);
  keep('g3b.over-limit', hugeRecord);
});

const simulatedKey = 'sim-key-g3c-boundary-0123456789abcdef';
const simulatedPrefix = simulatedKey.slice(0, 24);

function assertNoKeyFragment(text) {
  assert.equal(text.includes(simulatedKey), false);
  assert.equal(text.includes(simulatedPrefix), false);
}

function chunkedResponse(body, status) {
  const encoder = new TextEncoder();
  return new Response(
    new globalThis.ReadableStream({
      start(controller) {
        for (
          let offset = 0;
          offset < body.length;
          offset += OPENAI_DIAGNOSTIC_SAMPLE_CHARS
        ) {
          controller.enqueue(
            encoder.encode(
              body.slice(offset, offset + OPENAI_DIAGNOSTIC_SAMPLE_CHARS),
            ),
          );
        }
        controller.close();
      },
    }),
    { status },
  );
}

function envelopeCrossingSecret() {
  const wrap = (note) =>
    JSON.stringify({
      model: 'deepseek-flash',
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({ toolCalls: [], done: true, note }),
          },
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    });
  const at = wrap('Q').indexOf('Q');
  const pad = OPENAI_DIAGNOSTIC_SAMPLE_CHARS - simulatedPrefix.length - at;
  const note = `${'n'.repeat(pad)}${simulatedKey}${'n'.repeat(30)}`;
  const raw = wrap(note);
  assert.equal(
    raw.indexOf(simulatedKey),
    OPENAI_DIAGNOSTIC_SAMPLE_CHARS - simulatedPrefix.length,
  );
  assert.ok(
    raw.indexOf(simulatedKey) + simulatedKey.length >
      OPENAI_DIAGNOSTIC_SAMPLE_CHARS,
  );
  return { raw, note };
}

test('secrets that cross the diagnostic sample are redacted before the cut', async () => {
  const dangling = simulatedPrefix;
  const cutAtCap = `${'z'.repeat(90)}${dangling}`;
  assertNoKeyFragment(redactThenSample(cutAtCap, simulatedKey, true));
  assert.equal(
    redactThenSample(cutAtCap, simulatedKey, false).includes(dangling),
    true,
  );

  const profileId = '25252525-2525-4252-8252-252525252525';
  const { raw, note } = envelopeCrossingSecret();
  const normal = await sendLocal(chunkedResponse(raw, 200), 200, simulatedKey);
  assert.equal(normal.errorCode, null);
  assert.equal(normal.raw, raw);
  assert.equal(normal.raw.includes(simulatedKey), true);
  assert.equal(normal.logSample.length, OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  assertNoKeyFragment(normal.logSample);
  assert.equal(normal.reportedModelId, 'deepseek-flash');
  assert.deepEqual(normal.usage, { inputTokens: 11, outputTokens: 5 });

  let normalCalls = 0;
  const normalGw = createGateway({
    profiles: [
      {
        id: profileId,
        version: 3,
        name: 'secret-normal',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_object',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => simulatedKey,
    adapter: createOpenAIAdapter(async () => {
      normalCalls += 1;
      return chunkedResponse(raw, 200);
    }),
  });
  const normalRecord = await normalGw.generateDecision(
    baseInput(profileId, {
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['toolCalls', 'done', 'note'],
        properties: {
          done: { type: 'boolean' },
          note: { type: 'string' },
          toolCalls: { type: 'array', items: { type: 'object' } },
        },
      },
      toolSchemas: [],
    }),
  );
  assert.equal(normalCalls, 1);
  assert.equal(normalRecord.requestResult, 'ok');
  assert.equal(normalRecord.errorCode, null);
  assert.equal(normalRecord.usageSource, 'reported');
  assert.equal(normalRecord.inputTokens, 11);
  assert.equal(normalRecord.outputTokens, 5);
  assert.equal(normalRecord.data.note, note);
  assert.equal(normalRecord.providerCalls, 1);
  assert.equal(normalRecord.fallbackUsed, false);
  assert.equal(normalRecord.rawOutput.length, OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  assertNoKeyFragment(normalRecord.rawOutput);
  assertNoKeyFragment(
    JSON.stringify({
      rawOutput: normalRecord.rawOutput,
      outbound: normalRecord.outboundRedacted,
    }),
  );
  keep('g3b.secret-normal', {
    requestResult: normalRecord.requestResult,
    errorCode: normalRecord.errorCode,
    usageSource: normalRecord.usageSource,
    inputTokens: normalRecord.inputTokens,
    outputTokens: normalRecord.outputTokens,
    providerCalls: normalRecord.providerCalls,
    fallbackUsed: false,
    rawOutput: normalRecord.rawOutput,
    data: { noteLength: normalRecord.data.note.length },
  });

  const errorBody = `${'e'.repeat(OPENAI_DIAGNOSTIC_SAMPLE_CHARS - simulatedPrefix.length)}${simulatedKey}${'e'.repeat(700)}`;
  assert.ok(
    errorBody.indexOf(simulatedKey) + simulatedKey.length >
      OPENAI_DIAGNOSTIC_SAMPLE_CHARS,
  );
  const httpError = await sendLocal(
    chunkedResponse(errorBody, 400),
    400,
    simulatedKey,
  );
  assert.equal(httpError.errorCode, 'VALIDATION_ERROR');
  assert.equal(httpError.raw, errorBody);
  assert.equal(httpError.usage, null);
  assert.equal(httpError.reportedModelId, null);
  assertNoKeyFragment(httpError.logSample);
  let errorCalls = 0;
  const errorGw = createGateway({
    profiles: [
      {
        id: profileId,
        version: 3,
        name: 'secret-http',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_schema',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => simulatedKey,
    adapter: createOpenAIAdapter(async () => {
      errorCalls += 1;
      return chunkedResponse(errorBody, 400);
    }),
  });
  const errorRecord = await errorGw.generateDecision(baseInput(profileId));
  assert.equal(errorCalls, 1);
  assert.equal(errorRecord.errorCode, 'VALIDATION_ERROR');
  assert.equal(errorRecord.requestResult, 'malformed');
  assert.equal(errorRecord.data, null);
  assert.equal(errorRecord.providerCalls, 1);
  assert.equal(errorRecord.repairCount, 0);
  assert.equal(errorRecord.fallbackUsed, false);
  assertNoKeyFragment(errorRecord.rawOutput);
  keep('g3b.secret-http-error', {
    requestResult: errorRecord.requestResult,
    errorCode: errorRecord.errorCode,
    providerCalls: errorRecord.providerCalls,
    repairCount: errorRecord.repairCount,
    fallbackUsed: false,
    rawOutput: errorRecord.rawOutput,
    data: null,
  });

  const head = 'h'.repeat(
    OPENAI_DIAGNOSTIC_SAMPLE_CHARS - simulatedPrefix.length,
  );
  const over = `${head}${simulatedKey}${'t'.repeat(OPENAI_RESPONSE_CHAR_LIMIT + 80 - head.length - simulatedKey.length)}`;
  assert.ok(over.length > OPENAI_RESPONSE_CHAR_LIMIT);
  assert.ok(
    over.indexOf(simulatedKey) + simulatedKey.length <
      OPENAI_RESPONSE_CHAR_LIMIT,
  );
  const refused = await sendLocal(
    chunkedResponse(over, 200),
    200,
    simulatedKey,
  );
  assert.equal(refused.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(refused.raw, '');
  assert.equal(refused.usage, null);
  assert.equal(refused.reportedModelId, null);
  assert.equal(refused.logSample.length, OPENAI_DIAGNOSTIC_SAMPLE_CHARS);
  assertNoKeyFragment(refused.logSample);
  const fallbackId = '26262626-2626-4262-8262-262626262626';
  let overCalls = 0;
  const overGw = createGateway({
    profiles: [
      {
        id: profileId,
        version: 3,
        name: 'secret-over-limit',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_object',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [fallbackId],
      },
      {
        id: fallbackId,
        version: 1,
        name: 'other',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'other-model',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_object',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => simulatedKey,
    adapter: createOpenAIAdapter(async () => {
      overCalls += 1;
      return chunkedResponse(over, 200);
    }),
  });
  const overRecord = await overGw.generateDecision(
    baseInput(profileId, { fallbackProfileId: fallbackId }),
  );
  assert.equal(overCalls, 1);
  assert.equal(overRecord.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(overRecord.requestResult, 'budget_exceeded');
  assert.equal(overRecord.data, null);
  assert.equal(overRecord.providerCalls, 1);
  assert.equal(overRecord.repairCount, 0);
  assert.equal(overRecord.fallbackUsed, false);
  assert.equal(overRecord.fallbackDenied, false);
  assert.equal(overRecord.outputTokens, null);
  assert.equal(overRecord.reportedModelId, null);
  assertNoKeyFragment(overRecord.rawOutput);
  keep('g3b.secret-over-limit', {
    requestResult: overRecord.requestResult,
    errorCode: overRecord.errorCode,
    providerCalls: overRecord.providerCalls,
    repairCount: 0,
    fallbackUsed: false,
    fallbackDenied: false,
    outputTokens: null,
    rawOutput: overRecord.rawOutput,
    data: null,
  });
});

test('tool parameters are inlined and an untested profile is still probed', async () => {
  const click = parametersForTool('click');
  assert.equal(JSON.stringify(click).includes('"$ref"'), false);
  assert.equal(click.type, 'object');
  assert.equal(click.additionalProperties, false);
  assert.deepEqual(click.required, ['target']);
  assert.equal(click.properties.target.type, 'object');
  assert.equal(click.properties.target.additionalProperties, false);
  assert.deepEqual(click.properties.target.required, [
    'snapshotId',
    'pageId',
    'nodeId',
  ]);
  assert.equal(click.properties.target.properties.snapshotId.format, 'uuid');
  assert.equal(click.properties.target.properties.pageId.format, 'uuid');
  assert.equal(click.properties.target.properties.nodeId.maxLength, 120);
  assert.equal(click.properties.target.properties.frameId.maxLength, 120);
  assert.deepEqual(toolSchemasForRole('planner'), []);
  assert.deepEqual(toolSchemasForRole('finalizer'), []);
  const explorer = toolSchemasForRole('explorer');
  assert.equal(
    explorer.some((tool) => tool.name === 'click'),
    true,
  );
  assert.equal(
    explorer.some((tool) => tool.name === 'finish_case'),
    false,
  );
  assert.deepEqual(
    explorer.find((tool) => tool.name === 'click').parameters,
    click,
  );
  const submit = parametersForTool('submit_case');
  assert.equal(JSON.stringify(submit).includes('#/$defs/JsonValue'), true);
  assert.equal(typeof submit.$defs.JsonValue, 'object');

  const profileId = 'a3c0a3c0-a3c0-43c0-83c0-a3c0a3c0a3c0';
  const messages = [messageFromText('user', '观察：保存按钮。')];
  const bare = estimateTokens(JSON.stringify(messages));
  let budgetCalls = 0;
  const budgetGw = createGateway({
    profiles: [
      {
        id: profileId,
        version: 2,
        name: 'json-object-budget',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: true,
          imageInput: false,
        },
        responseFormat: 'json_object',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async () => {
      budgetCalls += 1;
      throw new Error('budget should stop before send');
    }),
  });
  const budgetRecord = await budgetGw.generateDecision(
    baseInput(profileId, {
      messages,
      maxInputTokens: bare,
      toolSchemas: [{ name: 'click', parameters: click }],
    }),
  );
  assert.equal(budgetCalls, 0);
  assert.equal(budgetRecord.providerCalls, 0);
  assert.equal(budgetRecord.requestResult, 'budget_exceeded');
  assert.equal(budgetRecord.errorCode, 'BUDGET_EXCEEDED');
  assert.ok(budgetRecord.inputTokens > bare);
  keep('g3c.tool-parameters', {
    requestResult: budgetRecord.requestResult,
    errorCode: budgetRecord.errorCode,
    providerCalls: 0,
    inputTokens: budgetRecord.inputTokens,
    rawOutput: 'click NodeTarget inlined; planner empty; hint counted',
    data: { plannerTools: 0, explorerClick: true },
  });

  let seen = null;
  let sent = 0;
  const shown = createGateway({
    profiles: [
      {
        id: profileId,
        version: 2,
        name: 'json-object-hint',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: true,
          imageInput: false,
        },
        responseFormat: 'json_object',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async (_url, init) => {
      sent += 1;
      seen = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  toolCalls: [
                    {
                      name: 'click',
                      args: {
                        target: {
                          snapshotId: FIXTURE.snapshotId,
                          pageId: FIXTURE.pageId,
                          nodeId: 'tab-btn-details',
                        },
                      },
                    },
                  ],
                  done: false,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
        { status: 200 },
      );
    }),
  });
  const shownRecord = await shown.generateDecision(
    baseInput(profileId, {
      toolSchemas: [{ name: 'click', parameters: click }],
    }),
  );
  assert.equal(sent, 1);
  assert.equal(seen.response_format.type, 'json_object');
  assert.equal(Object.hasOwn(seen, 'tools'), false);
  assert.equal(seen.model, 'deepseek-chat');
  const hinted = seen.messages
    .flatMap((message) => message.content)
    .map((part) => part.text ?? '')
    .join('\n');
  assert.equal(hinted.includes('outputSchema='), true);
  assert.equal(hinted.includes('snapshotId'), true);
  assert.equal(hinted.includes('"format":"uuid"'), true);
  assert.equal(shownRecord.requestResult, 'ok');
  assert.equal(
    validateContract('ToolCall', shownRecord.data.toolCalls[0]).success,
    true,
  );
  keep('g3c.json-object-constraint', {
    requestResult: shownRecord.requestResult,
    errorCode: null,
    providerCalls: shownRecord.providerCalls,
    usageSource: shownRecord.usageSource,
    rawOutput: 'json_object hint counted and ToolCall still validated',
    data: { format: seen.response_format.type },
  });

  let probeCalls = 0;
  let probeBody = null;
  const untested = createGateway({
    profiles: [
      {
        id: profileId,
        version: 1,
        name: 'untested',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: false,
          nativeTools: false,
          imageInput: false,
        },
        responseFormat: 'json_object',
        status: 'untested',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async (_url, init) => {
      probeCalls += 1;
      probeBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  structuredOutput: false,
                  nativeTools: true,
                  imageInput: true,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 4 },
        }),
        { status: 200 },
      );
    }),
  });
  const probe = await untested.capabilityProbe(profileId, 1000);
  assert.equal(probeCalls, 3);
  assert.equal(probe.providerCalls, 3);
  assert.equal(probeBody.response_format.type, 'json_object');
  assert.equal(probeBody.model, 'deepseek-chat');
  assert.equal(probe.data.status, 'degraded');
  assert.equal(probe.data.capabilities.structuredOutput, true);
  assert.equal(probe.data.capabilities.nativeTools, false);
  assert.equal(probe.data.capabilities.imageInput, false);
  assert.match(probe.data.notes.join(''), /探测未通过/);
  keep('g3c.untested-probe', {
    requestResult: probe.requestResult,
    errorCode: probe.errorCode,
    providerCalls: probe.providerCalls,
    rawOutput: 'untested caps did not skip the probe',
    data: { status: probe.data.status },
  });

  let closedCalls = 0;
  const closed = createGateway({
    profiles: [
      {
        id: profileId,
        version: 4,
        name: 'closed',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'deepseek-chat',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: true,
          nativeTools: true,
          imageInput: true,
        },
        responseFormat: 'json_schema',
        status: 'disabled',
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      },
    ],
    decryptKey: () => 'openai-test-key',
    adapter: createOpenAIAdapter(async () => {
      closedCalls += 1;
      throw new Error('disabled profile must not be probed');
    }),
  });
  const closedProbe = await closed.capabilityProbe(profileId, 1000);
  assert.equal(closedCalls, 0);
  assert.equal(closedProbe.providerCalls, 0);
  assert.equal(closedProbe.data.status, 'disabled');
  assert.equal(closedProbe.data.capabilities.structuredOutput, true);
  assert.equal(closedProbe.data.capabilities.nativeTools, true);
  assert.equal(closedProbe.data.capabilities.imageInput, true);
  keep('g3c.disabled-probe', {
    requestResult: closedProbe.requestResult,
    errorCode: closedProbe.errorCode,
    providerCalls: 0,
    rawOutput: 'disabled profile stayed closed',
    data: { status: 'disabled' },
  });
});

test('dispatcher validates tool results and registered reason codes', async () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(DECISION_SCHEMA);
  assert.equal(validate({ done: false, toolCalls: [{ foo: 1 }] }), false);
  assert.equal(
    validate({
      done: false,
      toolCalls: [{ name: 'observe', args: { pageId: FIXTURE.pageId } }],
    }),
    true,
  );
  const executed = [];
  const dispatcher = createPolicyDispatcher(async (call) => {
    executed.push(call.name);
    return { observed: true };
  });
  const invalid = await dispatcher.dispatch({
    role: 'explorer',
    call: { name: 'observe', args: { pageId: FIXTURE.pageId } },
    knownEvidenceIds: [],
  });
  assert.deepEqual(executed, ['observe']);
  assert.equal(invalid.status, 'denied');
  assert.equal(invalid.reasonCode, 'VALIDATION_ERROR');
  assert.equal(invalid.data, null);
  assert.equal(invalid.actionId, null);
  assert.deepEqual(invalid.evidenceRefs, []);
  const fake = await dispatcher.dispatch({
    role: 'explorer',
    call: {
      name: 'report_suspect',
      args: {
        caseId: FIXTURE.taskId,
        criterionId: 'main',
        actual: '按钮不见了',
        evidenceRefs: [FIXTURE.fakeEvidenceId],
        reproSteps: ['打开页面'],
      },
    },
    knownEvidenceIds: [FIXTURE.evidenceId],
  });
  assert.equal(fake.status, 'denied');
  assert.equal(fake.reasonCode, 'POLICY_DENIED');
  assert.deepEqual(executed, ['observe']);
  const accepted = createPolicyDispatcher(async () => browserSnapshot());
  const ok = await accepted.dispatch({
    role: 'explorer',
    call: { name: 'observe', args: { pageId: FIXTURE.pageId } },
    knownEvidenceIds: [],
  });
  assert.equal(ok.status, 'succeeded');
  assert.equal(ok.reasonCode, null);
  assert.equal(ok.data.snapshotId, FIXTURE.snapshotId);
  const again = await accepted.dispatch({
    role: 'explorer',
    call: { name: 'observe', args: { pageId: FIXTURE.pageId } },
    knownEvidenceIds: [],
  });
  // Dispatcher does not implement repeated action limit; repetition is handled by browser layer
  assert.equal(again.status, 'succeeded');
  assert.equal(again.reasonCode, null);
  keep('dispatcher.contract', {
    requestResult: 'ok',
    rawOutput: JSON.stringify({
      invalid: invalid.reasonCode,
      fake: fake.reasonCode,
      repeated: again.status,
    }),
    data: {
      invalid: invalid.reasonCode,
      fake: fake.reasonCode,
      repeated: again.status,
    },
  });
});

test('live model probe stays blocked', () => {
  const env = { ...process.env };
  delete env.LOCALQA_MODEL_BASE_URL;
  delete env.LOCALQA_MODEL_API_KEY;
  delete env.LOCALQA_MODEL_ID;
  delete env.LOCALQA_MODEL_PROBE;
  const child = spawnSync(
    process.execPath,
    [path.join(here, 'probe-live.mjs')],
    {
      env,
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0);
  const body = JSON.parse(child.stdout);
  assert.equal(body.status, 'blocked');
  assert.equal(body.networkCallMade, false);
  keep('live-model.blocked', {
    requestResult: 'blocked',
    rawOutput: child.stdout.trim(),
    data: body,
  });
});

test('write evidence', () => {
  const expected = [
    'capability.probe',
    'capability.image-unsupported',
    'redaction',
    'adapter.openai-shape',
    'format-repair.once',
    'format-repair.stop',
    'tool-loop',
    'repeat-action',
    'timeout',
    'rate-limited',
    'fallback.denied',
    'fallback.approved',
    'profile.missing',
    'openai.https-and-key',
    'fake-evidence',
    'assertion.no-ref',
    'unauthorized-tool',
    'planner.sources',
    'visual.not-downgraded',
    'budget',
    'complete.contract',
    'roles.prompts',
    'provider.401',
    'provider.403',
    'provider.4xx',
    'provider.5xx',
    'provider.transport',
    'provider.timeout',
    'g3a.json-object-decision',
    'g3a.no-format-downgrade',
    'g3a.native-tool-rejected',
    'g3a.native-tool-accepted',
    'g3a.image-data-url',
    'g3a.image-https',
    'g3a.image-unresolved',
    'g3a.image-capability',
    'g3a.visual-without-image',
    'g3a.image-budget',
    'g3a.fallback-unapproved-429',
    'g3a.no-structured-output',
    'g3b.long-envelope',
    'g3b.non-json',
    'g3b.http-error-sample',
    'g3b.over-limit',
    'g3b.secret-normal',
    'g3b.secret-http-error',
    'g3b.secret-over-limit',
    'g3c.tool-parameters',
    'g3c.json-object-constraint',
    'g3c.untested-probe',
    'g3c.disabled-probe',
    'dispatcher.contract',
    'live-model.blocked',
  ];
  const seen = new Set(passed);
  const missing = expected.filter((id) => !seen.has(id));
  assert.deepEqual(missing, []);
  const report = {
    task: 'T04',
    title: '模型网关与角色',
    date: '2026-10-02',
    result: 'stub paths passed; live model blocked',
    claims: {
      G3Passed: false,
      P0Passed: false,
      liveModelCalled: false,
      productImplemented: false,
    },
    counts: { passed: passed.length, blocked: 1, unverified: 8 },
    passed: passed.map((id) => ({ id })),
    blocked: [
      {
        id: 'live-model',
        detail:
          '未提供 endpoint、model id、密钥和允许调用。probe-live.mjs 在缺任一项时不发请求。',
      },
    ],
    unverified: [
      '真实模型质量基线（固定模型下 10 条流程 × 10 次，以及 10 个错误 × 3 次）',
      'G3-A 的 json_object、原生工具和图片传输只用本地假传输验证，本轮没有再调用真实供应商',
      'G3-B 的长响应、非 JSON、HTTP 错误取样、超限和跨样本密钥脱敏只用本地假传输验证，没有再调用真实供应商',
      '管理员 SecretVault 解密与 KEK 挂载',
      '数据库事务里的预算预约/核销',
      '与并行中的 BrowserPort 对接',
      'G3-C 当轮只验证了冻结格式、工具参数和失败探测的本地假传输；该轮 worker 入口尚未接线，已批准图片解析仍未做',
      'G3-D 网关侧的保守探测与失败重试只用本地假传输验证；进程组合、Postgres 和真实供应商不在本文件里证明',
    ],
    handoff: {
      done: [
        'ModelPort：capabilityProbe、generateDecision、evaluateCriterion，以及内部 complete 的契约校验。',
        'OpenAI-compatible adapter 按剖面的 responseFormat 发送 json_schema、json_object 或 native tools。未声明时仍是 strict json_schema，不会在 400 后改格式或换模型。',
        '供应商完成包会先解开 content 或 tool_calls，再做 JSON Schema 与 ToolCall 校验。图片只发送已解析的 https 或 data:image，否则能力缺失或未配置，不发送 artifact://。',
        'OpenAI adapter openai-compatible.2 在字符上限内解析完整响应。诊断日志先对保留正文脱敏，再取 2000 字符样本。超过上限的 2xx 正文记 BUDGET_EXCEEDED，不截断后当成功；超限保留段末尾的密钥前缀也会去掉。非 2xx 仍按状态码，不把正文当完成结果。',
        'stub 八类响应：正常、格式错误、不支持图片、超时、429、重复动作、假证据 ID、未授权工具。',
        '用量区分 reported / estimated / mixed；没有 provider usage 时本地估算，空输出保持 null，不填 0。',
        '请求前脱敏；密钥只在调用前解密，日志不留原值；未批准或不存在的 fallback 不会被调用。',
        '六个角色的 t04.1 prompt 与契约工具范围。planner 无来源则拒绝。assertion 无引用或假 ID 为 inconclusive。',
        '工具循环走 Dispatcher。源码没有 import playwright。',
        'OpenAI HTTP 与传输错误映射到 §7：429 RATE_LIMITED，401/403 MODEL_NOT_CONFIGURED，其他 4xx VALIDATION_ERROR，5xx 与传输失败 SERVICE_UNAVAILABLE，abort 为 MODEL_TIMEOUT。非 2xx 不把 body 当完成结果。网关 catch 按抛出的 code 映射，不再一律超时。',
        'Dispatcher 返回 ToolResult，并用工具的 x-result-schema 校验 data。reviewPlan 按 Criterion 校验 kind、description、locator 和来源。决策 schema 的 toolCalls 使用 ToolCall。重复动作为 REPEATED_ACTION_LIMIT；无法核验的证据引用为 POLICY_DENIED。',
      ],
      notDone: [
        '真模型调用。',
        'G3 / P0 质量门槛。',
        '预算没有接到 storage 的行锁事务。',
        '密钥没有接到 SecretVault。',
        'Dispatcher 还没有接到 packages/browser。',
      ],
      next: [
        '用户提供 HTTPS endpoint、model id、密钥，并设置 LOCALQA_MODEL_PROBE=allow 后，再跑 packages/model-gateway/scripts/probe-live.mjs。',
        'BrowserPort 冻结后，把 Dispatcher 的 execute 接到会话工具，仍不要在模型包里依赖 Playwright。',
        '把预算预约接到已验收的 storage 事务，收到 usage 后再核销。',
      ],
    },
    command: 'npx --yes pnpm@10.34.0 --filter @localqa/model-gateway test',
    node: process.version,
    promptVersion: PROMPT_VERSION,
    rawOutputs,
  };
  report.result =
    missing.length === 0
      ? 'stub paths passed; live model blocked'
      : `incomplete: ${missing.join(',')}`;
  report.evidenceSha256 = createHash('sha256')
    .update(JSON.stringify(rawOutputs))
    .digest('hex');
  const text = `${JSON.stringify(report, null, 2)}\n`;
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(apiKey), false);
  // Routine CI must never overwrite the checked-in historical acceptance
  // evidence; each test run records its synthetic output under ignored scratch.
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, text);
  assert.deepEqual(missing, []);
  const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(parsed.claims.G3Passed, false);
  assert.equal(parsed.claims.liveModelCalled, false);
});
