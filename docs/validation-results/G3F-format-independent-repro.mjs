// Local injected transport only; this is an output-contract check, not G3 release.
import { randomUUID } from 'node:crypto';
import { createGateway, createOpenAIAdapter } from '../../packages/model-gateway/dist/index.js';
import { DECISION_SCHEMA } from '../../packages/agents/dist/index.js';

const profile = {
  id: randomUUID(), version: 1, name: 'Root format fixture',
  endpoint: 'https://format-fixture.invalid/v1', configuredModelId: 'format-fixture',
  kind: 'openai_compatible', dataBoundary: 'internal',
  capabilities: { structuredOutput: true, nativeTools: false, imageInput: false },
  responseFormat: 'json_schema', status: 'ready', encryptedApiKey: 'local-slot', approvedFallbackIds: [],
};
const scenarios = [
  { name: 'Invalid UUID ToolCall', schema: DECISION_SCHEMA, data: { done: false, toolCalls: [{ name: 'click', args: { target: { snapshotId: 'not-a-uuid', pageId: 'not-a-uuid', nodeId: 'testid_fixture', frameId: 'main' } } }] } },
  ...['uuid', 'uri'].map(format => ({ name: `Invalid custom ${format}`, schema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string', format } } }, data: { value: 'not-valid' } })),
];
const warnings = [], results = [], warn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(' '));
try {
  for (const scenario of scenarios) {
    let sends = 0;
    const gateway = createGateway({
      profiles: [profile], decryptKey: () => 'synthetic-fixture-key',
      adapter: createOpenAIAdapter(async () => {
        sends++;
        return new Response(JSON.stringify({ model: profile.configuredModelId, choices: [{ message: { content: JSON.stringify(scenario.data) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
      }),
    });
    const record = await gateway.generateDecision({
      taskId: randomUUID(), profileId: profile.id, contextVersion: 1, role: 'executor', promptVersion: 'root-local-format', purpose: 'decide',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Controlled format negative' }] }],
      approvedImageIds: [], outputSchema: scenario.schema, maxOutputTokens: 100, timeoutMs: 1000, knownEvidenceIds: [], toolSchemas: [],
    });
    results.push({ case: scenario.name, requestResult: record.requestResult, errorCode: record.errorCode, sends, passed: record.requestResult !== 'ok' && record.requestResult !== 'repaired' && record.errorCode !== null && record.data === null });
  }
} finally { console.warn = warn; }
console.log(JSON.stringify({ results, warningCount: warnings.length, scope: 'Local gateway output validation, no PG/browser/provider network' }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
