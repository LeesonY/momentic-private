import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGateway } from '../dist/index.js';

const profileId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const owned = '33333333-3333-4333-8333-333333333333';
const stranger = '44444444-4444-4444-8444-444444444444';

function profile(imageInput = false) {
  return {
    id: profileId,
    version: 2,
    name: 'g3d4',
    endpoint: 'https://model.g3d4.test/v1',
    configuredModelId: 'g3d4-model',
    kind: 'openai_compatible',
    dataBoundary: 'external',
    capabilities: {
      structuredOutput: true,
      nativeTools: false,
      imageInput,
    },
    responseFormat: 'json_schema',
    status: 'degraded',
    encryptedApiKey: 'slot',
    approvedFallbackIds: [],
  };
}

function frozenCriterion(extra = {}) {
  return {
    id: 'case.semantic',
    kind: 'semantic',
    description: 'Stored description for the frozen criterion.',
    sourceKind: 'user_spec',
    sourceRef: 'g3d4-fixture',
    expectedValue: 'stored-green',
    ...extra,
  };
}

function judgmentSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['criterionId', 'result', 'evidenceRefs'],
    properties: {
      criterionId: { type: 'string' },
      result: { type: 'string' },
      reason: { type: 'string' },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
    },
  };
}

function request() {
  return {
    taskId,
    profileId,
    contextVersion: 1,
    purpose: 'assert',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'expectedValue=message-blue' }],
      },
    ],
    maxOutputTokens: 100,
    outputSchema: judgmentSchema(),
    criterionId: 'case.semantic',
  };
}

function gatewayFor(reply, imageInput = false) {
  const seen = [];
  const gateway = createGateway({
    profiles: [profile(imageInput)],
    decryptKey: () => 'local-test-key',
    adapter: {
      kind: 'openai_compatible',
      version: 'g3d4-test',
      build(input) {
        return {
          endpoint: `${input.endpoint}/chat/completions`,
          body: {
            model: input.model,
            messages: input.messages,
          },
        };
      },
      async send(input) {
        seen.push(input.body);
        return reply(input);
      },
    },
  });
  return { gateway, seen };
}

function providerJudgment(payload) {
  return {
    raw: JSON.stringify(payload),
    httpStatus: 200,
    reportedModelId: 'g3d4-model',
    usage: { inputTokens: 11, outputTokens: 4 },
    errorCode: null,
  };
}

function publicResult(record) {
  return record.data?.data;
}

function outboundText(body) {
  const parts = [];
  for (const message of body?.messages ?? []) {
    const content = message.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === 'string') parts.push(part.text);
      }
    }
  }
  return parts.join('\n');
}

test('empty evidence refs do not leave a raw passed on complete', async () => {
  const { gateway, seen } = gatewayFor(() =>
    providerJudgment({
      criterionId: 'case.semantic',
      result: 'passed',
      reason: 'provider claims pass',
      evidenceRefs: [],
    }),
  );
  const record = await gateway.complete(request(), {
    role: 'assertion',
    promptVersion: '1.0',
    approvedImageIds: [],
    toolSchemas: [],
    timeoutMs: 30000,
    knownEvidenceIds: [owned],
    criterion: frozenCriterion(),
  });
  const sent = outboundText(seen[0]);
  assert.equal(seen.length, 1);
  assert.equal(record.requestResult, 'inconclusive');
  assert.equal(record.assessment?.reasonCode, 'NO_OBSERVATION_REF');
  assert.equal(record.errorCode, null);
  assert.equal(publicResult(record)?.result, 'not_evaluated');
  assert.equal(publicResult(record)?.reason, 'NO_OBSERVATION_REF');
  assert.deepEqual(publicResult(record)?.evidenceRefs, []);
  assert.equal(publicResult(record)?.criterionId, 'case.semantic');
  assert.equal(
    JSON.stringify(publicResult(record)).includes('provider claims pass'),
    false,
  );
  assert.equal(record.rawOutput.includes('passed'), true);
  assert.equal(sent.includes('"expectedValue":"stored-green"'), true);
  assert.equal(
    sent.includes('Stored description for the frozen criterion.'),
    true,
  );
  assert.equal(sent.includes('g3d4-fixture'), true);
  assert.equal(sent.includes('"sourceKind":"user_spec"'), true);
  assert.equal(sent.includes('"expectedValue":"message-blue"'), false);
});

test('an unknown evidence ref is not an external pass', async () => {
  const { gateway } = gatewayFor(() =>
    providerJudgment({
      criterionId: 'case.semantic',
      result: 'passed',
      reason: 'provider claims pass',
      evidenceRefs: [stranger],
    }),
  );
  const record = await gateway.complete(request(), {
    role: 'assertion',
    promptVersion: '1.0',
    approvedImageIds: [],
    toolSchemas: [],
    timeoutMs: 30000,
    knownEvidenceIds: [owned],
    criterion: frozenCriterion(),
  });
  assert.equal(record.requestResult, 'fake_evidence');
  assert.equal(record.assessment?.reasonCode, 'FAKE_EVIDENCE');
  assert.equal(record.errorCode, null);
  assert.equal(publicResult(record)?.result, 'not_evaluated');
  assert.equal(publicResult(record)?.reason, 'FAKE_EVIDENCE');
  assert.deepEqual(publicResult(record)?.evidenceRefs, []);
  assert.equal(JSON.stringify(publicResult(record)).includes(stranger), false);
  assert.equal(
    JSON.stringify(publicResult(record)).includes('provider claims pass'),
    false,
  );
});

test('an owned evidence ref can pass through the same assessment', async () => {
  const { gateway } = gatewayFor(() =>
    providerJudgment({
      criterionId: 'case.semantic',
      result: 'passed',
      reason: 'provider claims pass',
      evidenceRefs: [owned],
    }),
  );
  const record = await gateway.complete(request(), {
    role: 'assertion',
    promptVersion: '1.0',
    approvedImageIds: [],
    toolSchemas: [],
    timeoutMs: 30000,
    knownEvidenceIds: [owned],
    criterion: frozenCriterion(),
  });
  assert.equal(record.requestResult, 'passed');
  assert.equal(record.assessment?.reasonCode, 'OBSERVED');
  assert.equal(publicResult(record)?.result, 'passed');
  assert.equal(publicResult(record)?.reason, 'OBSERVED');
  assert.deepEqual(publicResult(record)?.evidenceRefs, [owned]);
  assert.equal(publicResult(record)?.criterionId, 'case.semantic');
  assert.equal(
    JSON.stringify(publicResult(record)).includes('provider claims pass'),
    false,
  );
  assert.equal(record.rawOutput.includes('passed'), true);
});

test('visual without image capability does not call the provider or pass as text', async () => {
  const { gateway, seen } = gatewayFor(() => {
    throw new Error('visual preflight must not send');
  }, false);
  const record = await gateway.complete(request(), {
    role: 'assertion',
    promptVersion: '1.0',
    approvedImageIds: [],
    toolSchemas: [],
    timeoutMs: 30000,
    knownEvidenceIds: [owned],
    criterion: frozenCriterion({ kind: 'visual', expectedValue: undefined }),
  });
  assert.equal(seen.length, 0);
  assert.equal(record.providerCalls, 0);
  assert.equal(record.errorCode, 'MODEL_CAPABILITY_MISSING');
  assert.equal(record.requestResult, 'capability_missing');
  assert.notEqual(publicResult(record)?.result, 'passed');
});
