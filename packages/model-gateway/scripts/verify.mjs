import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AGENT_ROLES,
  PROMPT_VERSION,
  renderAssertionPrompt,
  renderPrompt,
  reviewPlan,
  runToolLoop,
  toolsForRole,
} from '../../agents/dist/index.js';
import {
  FIXTURE,
  assessCriterionOutput,
  createGateway,
  createOpenAIAdapter,
  createStubAdapter,
  messageFromText,
  redactMessages,
  toOpenAIChatRequest,
} from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.resolve(here, '../../../docs/validation-results/T04-model.json');
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
    capabilities: { structuredOutput: true, nativeTools: true, imageInput: true },
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
      capabilities: { structuredOutput: true, nativeTools: true, imageInput: false },
    }),
    profile('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'stub-timeout'),
    profile('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'stub-429', {
      approvedFallbackIds: [FIXTURE.fallbackProfileId],
    }),
    profile('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'stub-repeat'),
    profile('ffffffff-ffff-4fff-8fff-ffffffffffff', 'stub-fake-evidence'),
    profile('12121212-1212-4121-8121-121212121212', 'stub-unauthorized'),
    profile('13131313-1313-4131-8131-131313131313', 'stub-ok', {
      capabilities: { structuredOutput: true, nativeTools: true, imageInput: false },
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
  const record = await gateway.capabilityProbe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1000);
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
        content: [{ type: 'text', text: `PAGE_OBSERVATION: password=${secret}` }],
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
  assert.equal(direct.messages.some((message) => message.content.some((part) => part.type === 'image')), false);
  const record = await gateway.generateDecision(baseInput(FIXTURE.profileId, {
    messages: [messageFromText('user', `登录 password=${secret} 后看到按钮`)],
  }));
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
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 'observe');
  keep('adapter.openai-shape', { requestResult: 'shape', rawOutput: JSON.stringify(body), data: body });
});

test('format repair happens once', async () => {
  const record = await gateway.generateDecision(baseInput('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
    outputSchema: decisionSchema,
  }));
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
    profiles: [profile(FIXTURE.profileId, 'stub-ok', { encryptedApiKey: null })],
    decryptKey() {
      throw new Error('should not decrypt');
    },
    adapter: {
      kind: 'stub',
      version: 'stuck.1',
      build: (input) => ({ endpoint: input.endpoint, body: { messages: input.messages } }),
      send: async () => {
        calls += 1;
        return { raw: 'nope', httpStatus: 200, reportedModelId: null, usage: null, errorCode: null };
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
      return { observed: true };
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

test('repeated action is rejected', async () => {
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
      return { clicked: true };
    },
  });
  assert.deepEqual(executed, ['click']);
  assert.equal(loop.stoppedBecause, 'REPEAT_ACTION');
  assert.equal(loop.dispatches.at(-1).executed, false);
  keep('repeat-action', loop.records.at(-1));
});

test('timeout keeps estimated input and does not zero the output', async () => {
  const record = await gateway.generateDecision(baseInput('cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
    timeoutMs: 40,
  }));
  assert.equal(record.requestResult, 'timeout');
  assert.equal(record.errorCode, 'MODEL_TIMEOUT');
  assert.equal(record.usageSource, 'estimated');
  assert.ok(record.inputTokens > 0);
  assert.equal(record.outputTokens, null);
  assert.ok(record.latencyMs >= 30);
  keep('timeout', record);
});

test('429 does not switch provider', async () => {
  const record = await gateway.generateDecision(baseInput('dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
  assert.equal(record.requestResult, 'rate_limited');
  assert.equal(record.errorCode, 'RATE_LIMITED');
  assert.equal(record.providerCalls, 1);
  assert.equal(record.fallbackUsed, false);
  assert.equal(record.outputTokens, null);
  assert.ok(record.inputTokens > 0);
  keep('rate-limited', record);
});

test('unconfigured fallback is refused', async () => {
  const denied = await gateway.generateDecision(baseInput('dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
    fallbackProfileId: FIXTURE.missingProfileId,
  }));
  assert.equal(denied.fallbackUsed, false);
  assert.equal(denied.fallbackDenied, true);
  assert.equal(denied.providerCalls, 1);
  keep('fallback.denied', denied);

  const used = await gateway.generateDecision(baseInput('dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
    fallbackProfileId: FIXTURE.fallbackProfileId,
  }));
  assert.equal(used.fallbackUsed, true);
  assert.equal(used.requestResult, 'ok');
  assert.deepEqual(used.attemptedModelIds, ['stub-429', 'stub-ok']);
  keep('fallback.approved', used);
});

test('missing profile and openai without a key do not call out', async () => {
  const missing = await gateway.generateDecision(baseInput(FIXTURE.missingProfileId));
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
        capabilities: { structuredOutput: true, nativeTools: true, imageInput: true },
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
  const record = await gateway.evaluateCriterion(baseInput('ffffffff-ffff-4fff-8fff-ffffffffffff', {
    purpose: 'assert',
    role: 'assertion',
    outputSchema: assertSchema,
    criterion: { id: FIXTURE.criterionId, kind: 'semantic' },
    knownEvidenceIds: [FIXTURE.evidenceId],
  }));
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
  keep('assertion.no-ref', { requestResult: 'inconclusive', assessment, rawOutput: JSON.stringify(assessment) });
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
    criteria: [{ id: 'c1', sourceKind: 'user_spec', description: '没有来源引用' }],
  });
  assert.equal(rejected.accepted, false);
  const accepted = reviewPlan({
    criteria: [{
      id: 'c1',
      kind: 'element_visible',
      sourceKind: 'generic_smoke',
      sourceRef: 'smoke:visible',
    }],
  });
  assert.equal(accepted.accepted, true);
  keep('planner.sources', {
    requestResult: accepted.reason,
    rawOutput: JSON.stringify({ rejected, accepted }),
    data: { rejected, accepted },
  });
});

test('visual criterion is not rewritten as a text pass', async () => {
  const record = await gateway.evaluateCriterion(baseInput('13131313-1313-4131-8131-131313131313', {
    purpose: 'assert',
    outputSchema: assertSchema,
    criterion: { id: FIXTURE.criterionId, kind: 'visual' },
    knownEvidenceIds: [FIXTURE.evidenceId],
  }));
  assert.equal(record.assessment.verdictStatus, 'blocked');
  assert.equal(record.assessment.reasonCode, 'MODEL_CAPABILITY_MISSING');
  assert.notEqual(record.assessment.verdictStatus, 'passed');
  keep('visual.not-downgraded', record);
});

test('oversized context is not sent', async () => {
  const before = stub.calls;
  const record = await gateway.generateDecision(baseInput(FIXTURE.profileId, {
    maxInputTokens: 5,
    messages: [messageFromText('user', '超大页面'.repeat(200))],
  }));
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
  const invalid = await gateway.complete({ taskId: 'not-a-uuid' }, {
    role: 'executor',
    promptVersion: PROMPT_VERSION,
    approvedImageIds: [],
    toolSchemas: [],
    timeoutMs: 1000,
  });
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
  assert.equal(scopes.executor.includes('finish_case'), true);
  assert.equal(scopes.executor.includes('submit_case'), false);
  assert.equal(scopes.reproducer.includes('complete_reproduction'), true);
  assert.equal(scopes.explorer.includes('assert_criterion'), false);
  const assertion = renderAssertionPrompt();
  assert.match(assertion.text, /criterionId/);
  assert.match(assertion.text, /inconclusive/);
  keep('roles.prompts', { requestResult: 'ok', rawOutput: JSON.stringify(scopes), data: scopes });
});

test('provider statuses map onto section 7 and are not completions', async () => {
  const profileId = '14141414-1414-4141-8141-141414141414';
  const doneBody = JSON.stringify({ done: true, toolCalls: [] });
  async function call(fetchImpl, extra = {}) {
    const gw = createGateway({
      profiles: [{
        id: profileId,
        version: 1,
        name: 'openai-errors',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'gpt-test',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: { structuredOutput: true, nativeTools: true, imageInput: false },
        encryptedApiKey: 'cipher',
        approvedFallbackIds: [],
      }],
      decryptKey: () => 'openai-test-key',
      adapter: createOpenAIAdapter(fetchImpl),
    });
    return gw.generateDecision(baseInput(profileId, { timeoutMs: 1000, ...extra }));
  }
  const jsonResponse = (status, body) => async () =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } });

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

  const timed = await call((...args) => new Promise((_resolve, reject) => {
    const init = args[1];
    init.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    });
  }), { timeoutMs: 40 });
  assert.equal(timed.errorCode, 'MODEL_TIMEOUT');
  assert.equal(timed.requestResult, 'timeout');
  assert.equal(timed.data, null);
  keep('provider.timeout', timed);
});

test('live model probe stays blocked', () => {
  const env = { ...process.env };
  delete env.LOCALQA_MODEL_BASE_URL;
  delete env.LOCALQA_MODEL_API_KEY;
  delete env.LOCALQA_MODEL_ID;
  delete env.LOCALQA_MODEL_PROBE;
  const child = spawnSync(process.execPath, [path.join(here, 'probe-live.mjs')], {
    env,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  const body = JSON.parse(child.stdout);
  assert.equal(body.status, 'blocked');
  assert.equal(body.networkCallMade, false);
  keep('live-model.blocked', { requestResult: 'blocked', rawOutput: child.stdout.trim(), data: body });
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
    counts: { passed: passed.length, blocked: 1, unverified: 4 },
    passed: passed.map((id) => ({ id })),
    blocked: [{
      id: 'live-model',
      detail: '未提供 endpoint、model id、密钥和允许调用。probe-live.mjs 在缺任一项时不发请求。',
    }],
    unverified: [
      '真实模型质量基线（固定模型下 10 条流程 × 10 次，以及 10 个错误 × 3 次）',
      '管理员 SecretVault 解密与 KEK 挂载',
      '数据库事务里的预算预约/核销',
      '与并行中的 BrowserPort 对接',
    ],
    handoff: {
      done: [
        'ModelPort：capabilityProbe、generateDecision、evaluateCriterion，以及内部 complete 的契约校验。',
        'OpenAI-compatible adapter 单独映射 model、max_completion_tokens、json_schema 和 function tools。',
        'stub 八类响应：正常、格式错误、不支持图片、超时、429、重复动作、假证据 ID、未授权工具。',
        '用量区分 reported / estimated / mixed；没有 provider usage 时本地估算，空输出保持 null，不填 0。',
        '请求前脱敏；密钥只在调用前解密，日志不留原值；未批准或不存在的 fallback 不会被调用。',
        '六个角色的 t04.1 prompt 与契约工具范围。planner 无来源则拒绝。assertion 无引用或假 ID 为 inconclusive。',
        '工具循环走 Dispatcher。源码没有 import playwright。',
        'OpenAI HTTP 与传输错误映射到 §7：429 RATE_LIMITED，401/403 MODEL_NOT_CONFIGURED，其他 4xx VALIDATION_ERROR，5xx 与传输失败 SERVICE_UNAVAILABLE，abort 为 MODEL_TIMEOUT。非 2xx 不把 body 当完成结果。网关 catch 按抛出的 code 映射，不再一律超时。',
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
  report.result = missing.length === 0
    ? 'stub paths passed; live model blocked'
    : `incomplete: ${missing.join(',')}`;
  report.evidenceSha256 = createHash('sha256').update(JSON.stringify(rawOutputs)).digest('hex');
  const text = `${JSON.stringify(report, null, 2)}\n`;
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(apiKey), false);
  writeFileSync(reportPath, text);
  assert.deepEqual(missing, []);
  const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(parsed.claims.G3Passed, false);
  assert.equal(parsed.claims.liveModelCalled, false);
});
