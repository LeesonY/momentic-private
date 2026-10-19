// In json_object mode the prompt's description of the decision shape is the
// only place the model learns the output format, so it has to name the required
// `note` annotation — otherwise "no other fields" tells the model the opposite of
// the role prompt and every step loses its thought. Schemas that do not require a
// note must keep the previous text byte for byte.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIAdapter, createGateway } from '../dist/index.js';
import { DECISION_SCHEMA } from '../../agents/dist/index.js';

const profileId = 'f5111111-1111-4111-8111-111111111111';
const taskId = 'f5222222-2222-4222-8222-222222222222';

const profile = {
  id: profileId,
  version: 1,
  name: 'local json_object fixture',
  endpoint: 'https://test-only.invalid',
  configuredModelId: 'fixture-model',
  kind: 'openai_compatible',
  dataBoundary: 'external',
  responseFormat: 'json_object',
  status: 'untested',
  encryptedApiKey: 'test-only-binding',
  approvedFallbackIds: [],
  capabilities: {
    structuredOutput: false,
    nativeTools: false,
    imageInput: false,
  },
};

const ANSWER = JSON.stringify({ note: '点击详情', done: true, toolCalls: [] });

/** Drive one decision and return the user-visible prompt the model received. */
async function promptFor(outputSchema) {
  const sent = [];
  const gateway = createGateway({
    profiles: [profile],
    decryptKey: () => 'fixture-credential',
    adapter: createOpenAIAdapter(async (_url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      return new Response(
        JSON.stringify({
          model: 'fixture-model',
          choices: [{ message: { role: 'assistant', content: ANSWER } }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
        { status: 200 },
      );
    }),
  });
  const record = await gateway.generateDecision({
    taskId,
    profileId,
    contextVersion: 1,
    role: 'executor',
    promptVersion: 'note',
    purpose: 'decide',
    approvedImageIds: [],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '下一步做什么？' }] },
    ],
    toolSchemas: [],
    maxInputTokens: 4000,
    maxOutputTokens: 400,
    timeoutMs: 300,
    outputSchema,
  });
  const body = sent.at(-1);
  const prompt = body.messages
    .flatMap((message) => message.content)
    .map((part) => part.text ?? '')
    .join('\n');
  const compact = JSON.parse(/outputSchema=(.+)/.exec(prompt)[1]);
  return { record, prompt, compact, body };
}

const schemaWithoutNote = {
  type: 'object',
  additionalProperties: false,
  required: ['toolCalls', 'done'],
  properties: {
    done: { type: 'boolean' },
    toolCalls: { type: 'array', items: { type: 'object' } },
  },
};

test('the compact decision description names the required note', async () => {
  const { record, prompt, compact } = await promptFor(DECISION_SCHEMA);
  assert.equal(record.requestResult, 'ok');
  // The example starts with the reason, so the model writes it first.
  assert.match(
    prompt,
    /必须返回 \{"note":"一句话说明这一步做什么","done":boolean,"toolCalls":/,
  );
  assert.match(prompt, /note 是必填字段/);
  assert.doesNotMatch(prompt, /禁止增加其他字段/);
  assert.match(prompt, /不要增加上面没有列出的字段/);
  // The compact schema keeps the annotation, first in `required`.
  assert.deepEqual(compact.required, ['note', 'done', 'toolCalls']);
  assert.deepEqual(compact.properties.note.type, ['string', 'null']);
  assert.equal(compact.additionalProperties, false);
  assert.deepEqual(Object.keys(compact.properties), [
    'note',
    'done',
    'toolCalls',
  ]);
  // …and it is still a compact description, not the 21 KB ToolCall tree.
  assert.ok(prompt.includes('outputSchema='));
  assert.equal(prompt.includes('snapshotId'), false);
});

test('a decision schema without a note keeps the previous description', async () => {
  const { prompt, compact } = await promptFor(schemaWithoutNote);
  assert.match(
    prompt,
    /必须返回 \{"done":boolean,"toolCalls":\[\{"name":工具名,"args":参数对象\}\]\}；无工具调用时 toolCalls=\[\]。仅使用列出的工具名称及其参数，禁止增加其他字段。/,
  );
  assert.equal(prompt.includes('note'), false);
  assert.deepEqual(compact.required, ['done', 'toolCalls']);
  assert.deepEqual(Object.keys(compact.properties), ['done', 'toolCalls']);
});

test('a non-decision schema is still described verbatim', async () => {
  const report = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'criteria'],
    properties: {
      summary: { type: 'string' },
      criteria: { type: 'array' },
    },
  };
  const { prompt, compact } = await promptFor(report);
  assert.match(prompt, /该对象必须满足 outputSchema。/);
  assert.deepEqual(compact, report);
});

test('native tool calls keep the assistant text as the step note', async () => {
  const sent = [];
  const gateway = createGateway({
    profiles: [
      {
        ...profile,
        responseFormat: 'native_tools',
        capabilities: { ...profile.capabilities, nativeTools: true },
      },
    ],
    decryptKey: () => 'fixture-credential',
    adapter: createOpenAIAdapter(async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          model: 'fixture-model',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '  先看列表有没有分页  ',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'observe',
                      arguments: JSON.stringify({ pageId: taskId }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
        { status: 200 },
      );
    }),
  });
  const record = await gateway.generateDecision({
    taskId,
    profileId,
    contextVersion: 1,
    role: 'executor',
    promptVersion: 'note',
    purpose: 'decide',
    approvedImageIds: [],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '下一步做什么？' }] },
    ],
    toolSchemas: [],
    maxInputTokens: 4000,
    maxOutputTokens: 400,
    timeoutMs: 300,
    outputSchema: DECISION_SCHEMA,
  });
  assert.equal(record.requestResult, 'ok');
  assert.equal(record.data.note, '先看列表有没有分页');
  assert.equal(record.data.toolCalls.length, 1);
  assert.equal(sent.length, 1);
});
