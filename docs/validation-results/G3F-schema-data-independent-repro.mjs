// Injected local responses only. Schema annotations and constants are data.
import { randomUUID } from 'node:crypto';
import { createGateway, createOpenAIAdapter } from '../../packages/model-gateway/dist/index.js';

const value = { format: 'business-label', kind: 'invoice' };
const scenarios = [
  { name: 'const object field format is data', schema: { type: 'object', const: value }, data: value, expected: 'ok', sends: 1 },
  { name: 'default object field format is data', schema: { type: 'object', default: value }, data: value, expected: 'ok', sends: 1 },
  { name: 'examples object field format is data', schema: { type: 'object', examples: [value] }, data: value, expected: 'ok', sends: 1 },
  { name: 'enum object field format is data', schema: { type: 'object', enum: [value] }, data: value, expected: 'ok', sends: 1 },
  { name: 'unknown nested schema format rejects before send', schema: { type: 'object', properties: { value: { type: 'string', format: 'business-label' } } }, data: { value: 'x' }, expected: 'malformed', sends: 0 },
  { name: 'invalid UUID still rejects after one repair', schema: { type: 'object', required: ['value'], properties: { value: { type: 'string', format: 'uuid' } } }, data: { value: 'not-valid' }, expected: 'malformed', sends: 2 },
];

const results = [];
for (const scenario of scenarios) {
  let sends = 0;
  const profile = {
    id: randomUUID(), version: 1, name: 'Root local schema-data fixture',
    endpoint: 'https://local.invalid/v1', configuredModelId: 'local-fixture',
    kind: 'openai_compatible', dataBoundary: 'internal',
    capabilities: { structuredOutput: true, nativeTools: false, imageInput: false },
    responseFormat: 'json_schema', status: 'ready', encryptedApiKey: 'synthetic-slot', approvedFallbackIds: [],
  };
  const gateway = createGateway({
    profiles: [profile], decryptKey: () => 'synthetic-fixture-key',
    adapter: createOpenAIAdapter(async () => {
      sends++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(scenario.data) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    }),
  });
  const record = await gateway.generateDecision({
    taskId: randomUUID(), profileId: profile.id, contextVersion: 1, role: 'executor', promptVersion: 'root-format-data', purpose: 'decide',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Local schema-data validation' }] }],
    approvedImageIds: [], outputSchema: scenario.schema, maxOutputTokens: 100, timeoutMs: 1000, knownEvidenceIds: [], toolSchemas: [],
  });
  results.push({
    case: scenario.name, requestResult: record.requestResult, errorCode: record.errorCode, sends,
    passed: record.requestResult === scenario.expected && sends === scenario.sends &&
      (scenario.expected === 'ok' ? record.errorCode === null && JSON.stringify(record.data) === JSON.stringify(scenario.data) : record.errorCode === 'VALIDATION_ERROR' && record.data === null),
  });
}
console.log(JSON.stringify({ results, scope: 'Local injected transport; no PG/browser/external model', P0Passed: false }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
