// The decision schema requires `note` so the model is instructed to annotate
// every action (the activity list shows it), but an annotation must never cost a
// repair round or discard an otherwise valid decision: the gateway fills
// `note: null` before validating. Everything else stays as strict as before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnthropicAdapter, createGateway } from '../dist/index.js';
import { DECISION_SCHEMA } from '../../agents/dist/index.js';

const id = 'f4111111-1111-4111-8111-111111111111';
const taskId = 'f4222222-2222-4222-8222-222222222222';
const profile = {
  id,
  version: 1,
  name: 'private local fixture',
  endpoint: 'https://fixture-model.invalid',
  configuredModelId: 'MiniMax-M3',
  kind: 'anthropic_messages',
  dataBoundary: 'external',
  capabilities: {
    structuredOutput: false,
    nativeTools: false,
    imageInput: false,
  },
  responseFormat: 'json_object',
  status: 'untested',
  encryptedApiKey: 'dummy-test-secret',
  approvedFallbackIds: [],
};

const decisionCall = (outputSchema) => ({
  taskId,
  profileId: id,
  contextVersion: 1,
  role: 'executor',
  promptVersion: 'note',
  purpose: 'decide',
  approvedImageIds: [],
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Return the next decision' }],
    },
  ],
  toolSchemas: [],
  maxInputTokens: 12000,
  maxOutputTokens: 400,
  timeoutMs: 300,
  outputSchema,
});

function envelope(text) {
  return new Response(
    JSON.stringify({
      type: 'message',
      model: 'MiniMax-M3',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 57, output_tokens: 40 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fixture(responses) {
  let calls = 0;
  const sent = [];
  const adapter = createAnthropicAdapter(async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return responses[Math.min(calls++, responses.length - 1)]();
  });
  return {
    gateway: createGateway({
      profiles: [profile],
      decryptKey: () => 'never-echo-test-key',
      adapter,
    }),
    calls: () => calls,
    sent,
  };
}

test('the decision schema asks for a note and allows a null one', () => {
  assert.deepEqual(DECISION_SCHEMA.required, ['toolCalls', 'done', 'note']);
  assert.deepEqual(DECISION_SCHEMA.properties.note.type, ['string', 'null']);
  // No maxLength: a long note is truncated before persistence, not rejected.
  assert.equal(DECISION_SCHEMA.properties.note.maxLength, undefined);
});

test('a decision without a note executes instead of being repaired or dropped', async () => {
  const h = fixture([() => envelope('{"done":false,"toolCalls":[]}')]);
  const out = await h.gateway.generateDecision(decisionCall(DECISION_SCHEMA));
  assert.equal(out.requestResult, 'ok');
  assert.equal(out.errorCode, null);
  assert.equal(out.repairCount, 0, 'no repair round for a missing annotation');
  assert.equal(h.calls(), 1);
  assert.deepEqual(out.data, { done: false, toolCalls: [], note: null });
});

test('a written note is kept as the model sent it', async () => {
  const h = fixture([
    () =>
      envelope(
        '{"done":false,"toolCalls":[],"note":"打开登录页，先确认表单是否渲染"}',
      ),
  ]);
  const out = await h.gateway.generateDecision(decisionCall(DECISION_SCHEMA));
  assert.equal(out.requestResult, 'ok');
  assert.equal(
    out.data.note,
    '打开登录页，先确认表单是否渲染',
    'the annotation reaches the step record',
  );
});

test('an empty note is filled too, and other schema breaches still repair', async () => {
  const empty = fixture([
    () => envelope('{"done":true,"toolCalls":[],"note":null}'),
  ]);
  const kept = await empty.gateway.generateDecision(
    decisionCall(DECISION_SCHEMA),
  );
  assert.equal(kept.requestResult, 'ok');
  assert.equal(kept.data.note, null);
  assert.equal(empty.calls(), 1);

  // Without `done` the decision is still invalid: one repair, then malformed.
  const h = fixture([
    () => envelope('{"toolCalls":[]}'),
    () => envelope('{"toolCalls":[]}'),
  ]);
  const out = await h.gateway.generateDecision(decisionCall(DECISION_SCHEMA));
  assert.equal(out.requestResult, 'malformed');
  assert.equal(out.errorCode, 'VALIDATION_ERROR');
  assert.equal(out.validationFailureKind, 'schema_mismatch');
  assert.equal(out.repairCount, 1);
  assert.equal(h.calls(), 2);
  // The rewrite instruction names the note, or the model would omit it again.
  const repair = JSON.stringify(h.sent.at(-1));
  assert.match(repair, /note/);
  assert.match(repair, /一句话说明这一步做什么/);
});

test('a schema without a note requirement is untouched', async () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['done', 'toolCalls'],
    properties: {
      done: { type: 'boolean' },
      toolCalls: { type: 'array' },
    },
  };
  const h = fixture([() => envelope('{"done":true,"toolCalls":[]}')]);
  const out = await h.gateway.generateDecision(decisionCall(schema));
  assert.equal(out.requestResult, 'ok');
  assert.equal('note' in out.data, false, 'nothing is invented');
});
