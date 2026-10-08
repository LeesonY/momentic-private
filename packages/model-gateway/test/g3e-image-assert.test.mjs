import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGateway, createOpenAIAdapter } from '../dist/index.js';

const profileId = 'e3e0e3e0-e3e0-43e0-83e0-e3e0e3e0e3e0';
const taskId = 'e3e1e3e1-e3e1-43e1-83e1-e3e1e3e1e3e1';
const imageId = 'e3e2e3e2-e3e2-43e2-83e2-e3e2e3e2e3e2';
const owned = 'e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function profile(imageInput = true) {
  return {
    id: profileId,
    version: 2,
    name: 'g3e',
    endpoint: 'https://model.g3e.test/v1',
    configuredModelId: 'g3e-model',
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

function imageMessage() {
  return {
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', artifactId: imageId },
    ],
  };
}

test('an unapproved image fails before the provider', async () => {
  let calls = 0;
  const gateway = createGateway({
    profiles: [profile()],
    decryptKey: () => 'local-test-key',
    resolveArtifact: () => ({ mediaType: 'image/png', bytes: png }),
    adapter: {
      kind: 'openai_compatible',
      version: 'g3e-test',
      build(input) {
        return { endpoint: input.endpoint, body: { model: input.model } };
      },
      async send() {
        calls += 1;
        throw new Error('unapproved image must not be sent');
      },
    },
  });
  const record = await gateway.generateDecision({
    taskId,
    profileId,
    contextVersion: 1,
    role: 'executor',
    promptVersion: '1.0',
    purpose: 'decide',
    messages: [imageMessage()],
    approvedImageIds: [],
    toolSchemas: [],
    outputSchema: { type: 'object' },
    timeoutMs: 1000,
    maxOutputTokens: 100,
  });
  assert.equal(calls, 0);
  assert.equal(record.providerCalls, 0);
  assert.equal(record.errorCode, 'MODEL_NOT_CONFIGURED');
  assert.equal(record.data, null);
});

test('evaluateCriterion returns the normalized judgment, not raw passed', async () => {
  const gateway = createGateway({
    profiles: [profile()],
    decryptKey: () => 'local-test-key',
    adapter: {
      kind: 'openai_compatible',
      version: 'g3e-test',
      build(input) {
        return { endpoint: input.endpoint, body: { model: input.model } };
      },
      async send() {
        return {
          raw: JSON.stringify({
            criterionId: 'g3e.current',
            result: 'passed',
            reason: 'provider claims pass',
            evidenceRefs: [],
          }),
          httpStatus: 200,
          reportedModelId: 'g3e-model',
          usage: { inputTokens: 11, outputTokens: 4 },
          errorCode: null,
        };
      },
    },
  });
  const record = await gateway.evaluateCriterion({
    taskId,
    profileId,
    contextVersion: 1,
    role: 'assertion',
    promptVersion: '1.0',
    purpose: 'assert',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'G3E-NORM' }] }],
    approvedImageIds: [],
    toolSchemas: [],
    outputSchema: judgmentSchema(),
    timeoutMs: 1000,
    maxOutputTokens: 100,
    knownEvidenceIds: [owned],
    criterion: {
      id: 'g3e.current',
      kind: 'semantic',
      description: 'Stored description.',
      sourceKind: 'user_spec',
      sourceRef: 'g3e-fixture',
    },
  });
  assert.equal(record.errorCode, null);
  assert.equal(record.requestResult, 'inconclusive');
  assert.equal(record.assessment?.reasonCode, 'NO_OBSERVATION_REF');
  assert.equal(record.assessment?.criterionResult, 'not_evaluated');
  assert.equal(record.data?.result, 'not_evaluated');
  assert.equal(record.data?.reason, 'NO_OBSERVATION_REF');
  assert.deepEqual(record.data?.evidenceRefs, []);
  assert.equal(record.data?.criterionId, 'g3e.current');
  assert.equal(Object.hasOwn(record.data, 'configuredModelId'), false);
  assert.equal(record.rawOutput.includes('passed'), true);
  assert.equal(record.rawOutput.includes('provider claims pass'), true);
  assert.equal(
    JSON.stringify(record.data).includes('provider claims pass'),
    false,
  );
});

test('a non-stub probe does not adopt a self-reported image capability', async () => {
  let calls = 0;
  const gateway = createGateway({
    profiles: [profile(false)],
    decryptKey: () => 'local-test-key',
    adapter: {
      kind: 'openai_compatible',
      version: 'g3e-test',
      build(input) {
        return { endpoint: input.endpoint, body: { model: input.model } };
      },
      async send() {
        calls += 1;
        return {
          raw: JSON.stringify({
            structuredOutput: true,
            nativeTools: true,
            imageInput: true,
          }),
          httpStatus: 200,
          reportedModelId: 'g3e-model',
          usage: { inputTokens: 4, outputTokens: 4 },
          errorCode: null,
        };
      },
    },
  });
  const record = await gateway.capabilityProbe(profileId, 1000);
  assert.equal(calls, 1);
  assert.equal(record.data?.capabilities?.imageInput, false);
  assert.equal(record.data?.capabilities?.nativeTools, false);
  assert.equal(record.data?.capabilities?.structuredOutput, true);
  assert.match(record.data?.notes?.join(''), /不采用模型自报/);
});

test('approved png bytes become a data URL and the diagnostic hides the payload', async () => {
  let seen = null;
  const gateway = createGateway({
    profiles: [profile(true)],
    decryptKey: () => 'local-test-key',
    resolveArtifact: () => ({ mediaType: 'image/png', bytes: png }),
    adapter: createOpenAIAdapter(async (_url, init) => {
      seen = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: 'g3e-model',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  criterionId: 'g3e.current',
                  result: 'passed',
                  evidenceRefs: [owned],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 4 },
        }),
        { status: 200 },
      );
    }),
  });
  const record = await gateway.evaluateCriterion({
    taskId,
    profileId,
    contextVersion: 1,
    role: 'assertion',
    promptVersion: '1.0',
    purpose: 'assert',
    messages: [imageMessage()],
    approvedImageIds: [imageId],
    toolSchemas: [],
    outputSchema: judgmentSchema(),
    timeoutMs: 1000,
    maxOutputTokens: 100,
    knownEvidenceIds: [owned],
    criterion: {
      id: 'g3e.current',
      kind: 'visual',
      description: 'Stored visual criterion.',
      sourceKind: 'user_spec',
      sourceRef: 'g3e-fixture',
    },
  });
  const payload = png.toString('base64');
  const url = seen?.messages?.[0]?.content?.[1]?.image_url?.url;
  assert.equal(record.providerCalls, 1);
  assert.equal(record.errorCode, null);
  assert.equal(record.data?.result, 'passed');
  assert.equal(url, `data:image/png;base64,${payload}`);
  assert.equal(JSON.stringify(seen).includes('artifact://'), false);
  assert.equal(record.outboundRedacted.includes(payload), false);
  assert.match(record.outboundRedacted, /data:image;base64,\[redacted\]/);
  assert.equal(record.outboundRedacted.includes('artifact://'), false);
});

test('visual text that names an artifact id does not pass', async () => {
  let calls = 0;
  const gateway = createGateway({
    profiles: [profile(true)],
    decryptKey: () => 'local-test-key',
    resolveArtifact: () => ({ mediaType: 'image/png', bytes: png }),
    adapter: createOpenAIAdapter(async () => {
      calls += 1;
      throw new Error('text must not be sent');
    }),
  });
  const record = await gateway.evaluateCriterion({
    taskId,
    profileId,
    contextVersion: 1,
    role: 'assertion',
    promptVersion: '1.0',
    purpose: 'assert',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `只看到标识 ${imageId}` }],
      },
    ],
    approvedImageIds: [imageId],
    toolSchemas: [],
    outputSchema: judgmentSchema(),
    timeoutMs: 1000,
    maxOutputTokens: 100,
    knownEvidenceIds: [imageId],
    criterion: {
      id: 'g3e.current',
      kind: 'visual',
      description: 'Stored visual criterion.',
      sourceKind: 'user_spec',
      sourceRef: 'g3e-fixture',
    },
  });
  assert.equal(calls, 0);
  assert.equal(record.providerCalls, 0);
  assert.equal(record.errorCode, 'MODEL_CAPABILITY_MISSING');
  assert.notEqual(record.data?.result, 'passed');
  assert.notEqual(record.assessment?.criterionResult, 'passed');
});

test('visual does not pass when the provider body keeps only the artifact id', async () => {
  let calls = 0;
  const gateway = createGateway({
    profiles: [profile(true)],
    decryptKey: () => 'local-test-key',
    resolveArtifact: () => ({ mediaType: 'image/png', bytes: png }),
    adapter: {
      kind: 'openai_compatible',
      version: 'g3e-test',
      build(input) {
        const text = [];
        for (const message of input.messages) {
          for (const part of message.content) {
            if (part.type === 'text') text.push(part.text);
            if (part.type === 'image') text.push(part.artifactId);
          }
        }
        return {
          endpoint: input.endpoint,
          body: { model: input.model, content: text.join('\n') },
        };
      },
      async send() {
        calls += 1;
        return {
          raw: JSON.stringify({
            criterionId: 'g3e.current',
            result: 'passed',
            evidenceRefs: [imageId],
          }),
          httpStatus: 200,
          reportedModelId: null,
          usage: { inputTokens: 1, outputTokens: 1 },
          errorCode: null,
        };
      },
    },
  });
  const record = await gateway.evaluateCriterion({
    taskId,
    profileId,
    contextVersion: 1,
    role: 'assertion',
    promptVersion: '1.0',
    purpose: 'assert',
    messages: [imageMessage()],
    approvedImageIds: [imageId],
    toolSchemas: [],
    outputSchema: judgmentSchema(),
    timeoutMs: 1000,
    maxOutputTokens: 100,
    knownEvidenceIds: [imageId],
    criterion: {
      id: 'g3e.current',
      kind: 'visual',
      description: 'Stored visual criterion.',
      sourceKind: 'user_spec',
      sourceRef: 'g3e-fixture',
    },
  });
  assert.equal(calls, 0);
  assert.equal(record.providerCalls, 0);
  assert.equal(record.errorCode, 'MODEL_CAPABILITY_MISSING');
  assert.notEqual(record.data?.result, 'passed');
  assert.notEqual(record.assessment?.criterionResult, 'passed');
});
