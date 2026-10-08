// G3 真实模型 Gate 的可复用入口。
// 默认只打印上限并退出。--inject 用注入的 Response 走产品 gateway，不联网。
// --execute 只拒绝：本文件不读取环境、不读取密钥、不发送。
import assert from 'node:assert/strict';
import { createGateway, createOpenAIAdapter } from '../../packages/model-gateway/dist/index.js';

const KEY = 'g3-gate-inject-not-a-credential';
const ENDPOINT = 'https://model.g3-gate.test/v1';
const PROFILE_ID = 'a3111111-1111-4111-8111-111111111111';
const TASK_ID = 'a3222222-2222-4222-8222-222222222222';
const IMAGE_ID = 'a3333333-3333-4333-8333-333333333333';
const OWNED_REF = 'a3444444-4444-4444-8444-444444444444';
const SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444';
const PAGE_ID = '33333333-3333-4333-8333-333333333333';

export const BOUNDS = {
  maxHttpAttempts: 4,
  maxDecisions: 2,
  maxOutputTokensEach: 64,
  maxCompletionTokensTotal: 256,
  productRepairBudget: 1,
  imageHttpCalls: 0,
  chinesePageCalls: 0,
  browser: false,
  postgres: false,
  fallbackProfiles: 0,
  stopOnHttp: [401, 403, 429],
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const clickParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['target'],
  properties: {
    target: {
      type: 'object',
      additionalProperties: false,
      required: ['snapshotId', 'pageId', 'nodeId'],
      properties: {
        snapshotId: { type: 'string', format: 'uuid' },
        pageId: { type: 'string', format: 'uuid' },
        nodeId: { type: 'string', maxLength: 120 },
      },
    },
  },
};

const decisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['toolCalls', 'done'],
  properties: {
    done: { type: 'boolean' },
    toolCalls: {
      type: 'array',
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'args'],
        properties: {
          name: { const: 'click' },
          args: clickParameters,
        },
      },
    },
  },
};

function profile(extra) {
  return {
    id: PROFILE_ID,
    version: 1,
    name: 'g3-gate-preflight',
    endpoint: ENDPOINT,
    configuredModelId: 'configured-not-sent-live',
    kind: 'openai_compatible',
    dataBoundary: 'external',
    capabilities: {
      structuredOutput: true,
      nativeTools: false,
      imageInput: false,
    },
    status: 'ready',
    encryptedApiKey: 'slot',
    approvedFallbackIds: [],
    ...extra,
  };
}

function completion(content, usage) {
  return new Response(
    JSON.stringify({
      id: 'local-inject',
      model: 'inject-model',
      choices: [{ message: { role: 'assistant', content } }],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function toolCompletion(args, usage) {
  return new Response(
    JSON.stringify({
      id: 'local-inject',
      model: 'inject-model',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_local',
                type: 'function',
                function: { name: 'click', arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function clickArgs(snapshotId, pageId) {
  return {
    target: { snapshotId, pageId, nodeId: 'tab-btn-details' },
  };
}

function assertNoKey(record) {
  assert.equal(record.rawOutput.includes(KEY), false);
  assert.equal(record.outboundRedacted.includes(KEY), false);
  if (record.providerCalls > 0) assert.equal(record.authorization, 'set');
}

function imageUrls(body) {
  const found = [];
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image_url' && part.image_url?.url) {
        found.push(part.image_url.url);
      }
    }
  }
  return found;
}

function summarize(name, record, seen) {
  const body = seen[0]?.body ?? null;
  const urls = body ? imageUrls(body) : [];
  return {
    name,
    providerCalls: record.providerCalls,
    repairCount: record.repairCount,
    requestResult: record.requestResult,
    errorCode: record.errorCode,
    usageSource: record.usageSource,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    requests: record.requests,
    responseFormat: body?.response_format?.type ?? null,
    toolsSent: Array.isArray(body?.tools),
    maxCompletionTokens: body?.max_completion_tokens ?? null,
    imageUrlKind: urls.length === 0 ? null : urls[0].slice(0, 'data:image/png;base64'.length),
    artifactSchemeSent: body ? JSON.stringify(body).includes('artifact://') : false,
    authorization: record.authorization,
    keyInRecord: record.rawOutput.includes(KEY) || record.outboundRedacted.includes(KEY),
    assessmentCriterionResult: record.assessment?.criterionResult ?? null,
    assessmentReason: record.assessment?.reasonCode ?? null,
    dataResult: record.data && typeof record.data === 'object' ? record.data.result ?? null : null,
  };
}

async function runCase(spec) {
  const seen = [];
  let sent = 0;
  const gateway = createGateway({
    profiles: [spec.profile],
    decryptKey: () => KEY,
    resolveArtifact: spec.resolveArtifact,
    adapter: createOpenAIAdapter(async (url, init) => {
      sent += 1;
      const headers = init.headers ?? {};
      const authorization = headers.authorization || headers.Authorization;
      assert.equal(authorization, `Bearer ${KEY}`);
      const body = JSON.parse(init.body);
      assert.equal(JSON.stringify(body).includes(KEY), false);
      assert.equal(String(url).startsWith(`${ENDPOINT}/chat/completions`), true);
      seen.push({ url: String(url), body });
      const next = spec.responses[Math.min(sent - 1, spec.responses.length - 1)];
      return next;
    }),
  });
  const record = await spec.call(gateway);
  assertNoKey(record);
  spec.check({ record, seen, sent });
  return summarize(spec.name, record, seen);
}

function decide(gateway, fields) {
  return gateway.generateDecision({
    taskId: TASK_ID,
    profileId: PROFILE_ID,
    contextVersion: 1,
    role: 'executor',
    promptVersion: 'g3-gate-preflight',
    purpose: 'decide',
    approvedImageIds: [],
    timeoutMs: 1000,
    maxOutputTokens: BOUNDS.maxOutputTokensEach,
    maxInputTokens: 4000,
    knownEvidenceIds: [],
    ...fields,
  });
}

async function inject() {
  const realFetch = globalThis.fetch;
  let globalFetchUsed = false;
  globalThis.fetch = async () => {
    globalFetchUsed = true;
    throw new Error('GLOBAL_FETCH_FORBIDDEN');
  };
  try {
    const cases = [];
    cases.push(
      await runCase({
        name: 'json-object-generateDecision',
        profile: profile({ responseFormat: 'json_object' }),
        responses: [
          completion(JSON.stringify({ choice: '详情' }), {
            prompt_tokens: 5,
            completion_tokens: 3,
          }),
        ],
        call: (gateway) =>
          decide(gateway, {
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: '中文指令：在「概览」和「详情」之间只选详情。这是文本，不是页面。',
                  },
                ],
              },
            ],
            toolSchemas: [{ name: 'click', parameters: clickParameters }],
            outputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['choice'],
              properties: { choice: { type: 'string' } },
            },
          }),
        check({ record, seen, sent }) {
          assert.equal(sent, 1);
          assert.equal(seen[0].body.response_format.type, 'json_object');
          assert.equal(seen[0].body.tools, undefined);
          assert.equal(seen[0].body.max_completion_tokens, 64);
          assert.equal(
            JSON.stringify(seen[0].body).includes('在「概览」和「详情」之间只选详情'),
            true,
          );
          assert.equal(record.requestResult, 'ok');
          assert.equal(record.errorCode, null);
          assert.deepEqual(record.data, { choice: '详情' });
          assert.equal(record.usageSource, 'reported');
          assert.equal(record.inputTokens, 5);
          assert.equal(record.outputTokens, 3);
          assert.equal(record.assessment, null);
        },
      }),
    );

    const validArgs = clickArgs(SNAPSHOT_ID, PAGE_ID);
    cases.push(
      await runCase({
        name: 'native-tool-valid-uuid',
        profile: profile({
          responseFormat: 'native_tools',
          capabilities: {
            structuredOutput: true,
            nativeTools: true,
            imageInput: false,
          },
        }),
        responses: [
          toolCompletion(validArgs, { prompt_tokens: 5, completion_tokens: 7 }),
        ],
        call: (gateway) =>
          decide(gateway, {
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: '只点 testid tab-btn-details。' }],
              },
            ],
            toolSchemas: [{ name: 'click', parameters: clickParameters }],
            outputSchema: decisionSchema,
          }),
        check({ record, seen, sent }) {
          assert.equal(sent, 1);
          assert.equal(seen[0].body.response_format, undefined);
          assert.equal(seen[0].body.tools[0].function.name, 'click');
          assert.equal(
            seen[0].body.tools[0].function.parameters.properties.target.properties
              .snapshotId.format,
            'uuid',
          );
          assert.equal(record.requestResult, 'ok');
          assert.equal(record.providerCalls, 1);
          assert.equal(record.repairCount, 0);
          assert.equal(record.data.toolCalls[0].args.target.nodeId, 'tab-btn-details');
          assert.equal(record.usageSource, 'reported');
          assert.equal(record.outputTokens, 7);
        },
      }),
    );

    const badArgs = clickArgs('fixture', 'home');
    cases.push(
      await runCase({
        name: 'native-tool-bad-uuid-repairs-once',
        profile: profile({
          responseFormat: 'native_tools',
          capabilities: {
            structuredOutput: true,
            nativeTools: true,
            imageInput: false,
          },
        }),
        responses: [
          toolCompletion(badArgs, { prompt_tokens: 5, completion_tokens: 7 }),
          toolCompletion(badArgs, { prompt_tokens: 5, completion_tokens: 7 }),
        ],
        call: (gateway) =>
          decide(gateway, {
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: '只点 testid tab-btn-details。' }],
              },
            ],
            toolSchemas: [{ name: 'click', parameters: clickParameters }],
            outputSchema: decisionSchema,
          }),
        check({ record, sent }) {
          assert.equal(sent, 2);
          assert.equal(record.providerCalls, 2);
          assert.equal(record.repairCount, 1);
          assert.equal(record.requestResult, 'malformed');
          assert.equal(record.errorCode, 'VALIDATION_ERROR');
          assert.equal(record.data, null);
          assert.equal(record.usageSource, 'reported');
          assert.equal(record.inputTokens, 10);
          assert.equal(record.outputTokens, 14);
        },
      }),
    );

    cases.push(
      await runCase({
        name: 'native-tool-contract-without-format',
        profile: profile({
          responseFormat: 'native_tools',
          capabilities: {
            structuredOutput: true,
            nativeTools: true,
            imageInput: false,
          },
        }),
        responses: [
          toolCompletion(badArgs, { prompt_tokens: 5, completion_tokens: 7 }),
        ],
        call: (gateway) =>
          decide(gateway, {
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: '只点 testid tab-btn-details。' }],
              },
            ],
            toolSchemas: [{ name: 'click', parameters: clickParameters }],
            outputSchema: { type: 'object' },
          }),
        check({ record, sent }) {
          assert.equal(sent, 1);
          assert.equal(record.providerCalls, 1);
          assert.equal(record.repairCount, 0);
          assert.equal(record.requestResult, 'malformed');
          assert.equal(record.errorCode, 'VALIDATION_ERROR');
          assert.equal(record.data, null);
        },
      }),
    );

    cases.push(
      await runCase({
        name: 'image-unapproved-zero-send',
        profile: profile({
          responseFormat: 'json_object',
          capabilities: {
            structuredOutput: true,
            nativeTools: false,
            imageInput: true,
          },
        }),
        resolveArtifact: () => ({ mediaType: 'image/png', bytes: PNG }),
        responses: [],
        call: (gateway) =>
          decide(gateway, {
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: '看图' },
                  { type: 'image', artifactId: IMAGE_ID },
                ],
              },
            ],
            approvedImageIds: [],
            toolSchemas: [],
            outputSchema: { type: 'object' },
          }),
        check({ record, sent }) {
          assert.equal(sent, 0);
          assert.equal(record.providerCalls, 0);
          assert.equal(record.errorCode, 'MODEL_NOT_CONFIGURED');
          assert.equal(record.authorization, 'unset');
        },
      }),
    );

    cases.push(
      await runCase({
        name: 'image-resolver-bytes-data-url',
        profile: profile({
          responseFormat: 'json_object',
          capabilities: {
            structuredOutput: true,
            nativeTools: false,
            imageInput: true,
          },
        }),
        resolveArtifact: (artifactId) =>
          artifactId === IMAGE_ID
            ? { mediaType: 'image/png', bytes: PNG }
            : null,
        responses: [
          completion(
            JSON.stringify({
              criterionId: 'g3.gate.visual',
              result: 'passed',
              evidenceRefs: [OWNED_REF],
            }),
            { prompt_tokens: 11, completion_tokens: 4 },
          ),
        ],
        call: (gateway) =>
          gateway.evaluateCriterion({
            taskId: TASK_ID,
            profileId: PROFILE_ID,
            contextVersion: 1,
            role: 'assertion',
            promptVersion: 'g3-gate-preflight',
            purpose: 'assert',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: '看这张已由调用方解析的图片。' },
                  { type: 'image', artifactId: IMAGE_ID },
                ],
              },
            ],
            approvedImageIds: [IMAGE_ID],
            toolSchemas: [],
            outputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['criterionId', 'result', 'evidenceRefs'],
              properties: {
                criterionId: { type: 'string' },
                result: { type: 'string' },
                evidenceRefs: { type: 'array', items: { type: 'string' } },
              },
            },
            timeoutMs: 1000,
            maxOutputTokens: BOUNDS.maxOutputTokensEach,
            maxInputTokens: 8000,
            knownEvidenceIds: [OWNED_REF],
            criterion: {
              id: 'g3.gate.visual',
              kind: 'visual',
              description: '注入用视觉准则。',
              sourceKind: 'user_spec',
              sourceRef: 'g3-gate-preflight',
            },
          }),
        check({ record, seen, sent }) {
          assert.equal(sent, 1);
          const urls = imageUrls(seen[0].body);
          assert.equal(urls.length, 1);
          assert.equal(urls[0].startsWith('data:image/png;base64,'), true);
          assert.equal(urls[0].includes(PNG.toString('base64')), true);
          assert.equal(JSON.stringify(seen[0].body).includes('artifact://'), false);
          assert.equal(record.outboundRedacted.includes(PNG.toString('base64')), false);
          assert.match(record.outboundRedacted, /data:image;base64,\[redacted\]/);
          assert.equal(record.outboundRedacted.includes('artifact://'), false);
          assert.equal(record.providerCalls, 1);
          assert.equal(record.errorCode, null);
          assert.equal(record.assessment.criterionResult, 'passed');
          assert.equal(record.assessment.reasonCode, 'OBSERVED');
          assert.equal(record.data.result, 'passed');
          assert.equal(record.usageSource, 'reported');
          assert.equal(record.inputTokens, 11);
          assert.equal(record.outputTokens, 4);
          assert.equal(seen[0].body.max_completion_tokens, 64);
        },
      }),
    );

    const report = {
      mode: 'inject',
      networkCallMade: false,
      globalFetchUsed,
      readsCredential: false,
      liveModelCalled: false,
      boundModelCalled: false,
      postgresUsed: false,
      cases,
      G3Passed: false,
      P0Passed: false,
    };
    const printed = JSON.stringify(report);
    assert.equal(printed.includes(KEY), false);
    assert.equal(printed.includes(PNG.toString('base64')), false);
    assert.equal(globalFetchUsed, false);
    process.stdout.write(`${printed}\n`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function preflight() {
  process.stdout.write(
    `${JSON.stringify({
      mode: 'preflight',
      networkCallMade: false,
      liveModelCalled: false,
      readsCredential: false,
      executeSends: false,
      bounds: BOUNDS,
      plannedLiveCalls: [
        {
          name: 'json-object-generateDecision',
          method: 'gateway.generateDecision',
          responseFormat: 'json_object',
          maxOutputTokens: BOUNDS.maxOutputTokensEach,
        },
        {
          name: 'native-tools-generateDecision',
          method: 'gateway.generateDecision',
          responseFormat: 'native_tools',
          maxOutputTokens: BOUNDS.maxOutputTokensEach,
        },
      ],
      notInThisBudget: [
        'chinese-page',
        'approved-image-live',
        'boundmodel-lease',
        'playwright',
        'worker-entry',
      ],
      G3Passed: false,
      P0Passed: false,
    })}\n`,
  );
}

function executeRefused() {
  process.stdout.write(
    `${JSON.stringify({
      mode: 'execute',
      refused: true,
      networkCallMade: false,
      liveModelCalled: false,
      readsCredential: false,
      reason:
        '本入口不读取密钥，也不发送。--execute 只确认拒绝。真实发送需要另一次明确授权，以及本脚本之外、不把明文密钥交给本文件的传输。',
      bounds: BOUNDS,
      G3Passed: false,
      P0Passed: false,
    })}\n`,
  );
}

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('--'));
const allowed = new Set(['--preflight', '--inject', '--execute']);
if (flags.some((flag) => !allowed.has(flag)) || flags.length > 1) {
  process.stdout.write(
    `${JSON.stringify({
      mode: 'rejected',
      networkCallMade: false,
      readsCredential: false,
      reason: '只接受一个：--preflight、--inject 或 --execute。',
    })}\n`,
  );
  process.exit(2);
}

if (flags[0] === '--execute') {
  executeRefused();
  process.exit(2);
}
if (flags[0] === '--inject') {
  await inject();
} else {
  preflight();
}
