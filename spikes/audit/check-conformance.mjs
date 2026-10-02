/**
 * Read-only contract conformance probe.
 * Does not start Postgres, Playwright, or a live model.
 * Writes spikes/audit/raw-results.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const root = '/Users/dcp/Documents/公司/momentic';
const require = createRequire(import.meta.url);

const contracts = await import(root + '/packages/contracts/dist/index.js');
const storageAccounts = await import(root + '/packages/storage/dist/accounts.js');
const agents = await import(root + '/packages/agents/dist/index.js');
const gateway = await import(root + '/packages/model-gateway/dist/index.js');

const {
  validateContract,
  getRootValidator,
  getToolResultValidator,
  toolMetadata,
  ERROR_CODES,
  parseContract,
} = contracts;
const { userDTO } = storageAccounts;
const { createPolicyDispatcher, reviewPlan, toolsForRole, AGENT_ROLES } = agents;
const {
  createGateway,
  createStubAdapter,
  assessCriterionOutput,
  messageFromText,
  FIXTURE,
} = gateway;

const domain = JSON.parse(readFileSync(root + '/docs/contracts/domain.schema.json', 'utf8'));
const tools = JSON.parse(readFileSync(root + '/docs/contracts/tools.schema.json', 'utf8'));
const events = JSON.parse(readFileSync(root + '/docs/contracts/events.schema.json', 'utf8'));
const report = JSON.parse(readFileSync(root + '/docs/contracts/report.schema.json', 'utf8'));
const section7 = readFileSync(root + '/docs/03-data-and-api.md', 'utf8');

const uuid = {
  request: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  action: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  project: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  run: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  task: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  user: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  page: '33333333-3333-4333-8333-333333333333',
  snap: '44444444-4444-4444-8444-444444444444',
  evidence: '55555555-5555-4555-8555-555555555555',
};

function issues(result) {
  if (result.success) return [];
  return result.errors.map((error) => `${error.instancePath || '/'} ${error.keyword} ${error.message}`);
}

function check(name, data) {
  const result = validateContract(name, data);
  return { name, ok: result.success, issues: issues(result) };
}

const section7Codes = [...section7.matchAll(/^\| ([A-Z][A-Z0-9_ /]+) \|/gm)]
  .flatMap((match) => match[1].split('/').map((code) => code.trim()))
  .filter((code) => /^[A-Z0-9_]+$/.test(code));

const toolNames = tools.$defs.ToolCall.oneOf.map((tool) => tool.properties.name.const);
const browserCases = [
  'observe', 'navigate', 'click', 'type_text', 'select_option', 'press',
  'scroll', 'wait_for', 'capture', 'inspect_network', 'assert_criterion',
];
const browserSource = readFileSync(root + '/packages/browser/src/types.ts', 'utf8');
const browserCodes = [...browserSource.matchAll(/: '([A-Z_]+)'/g)].map((match) => match[1]);
const storageSource = ['database.ts', 'accounts.ts', 'repositories.ts', 'leases.ts', 'crypto.ts']
  .map((file) => readFileSync(root + '/packages/storage/src/' + file, 'utf8'))
  .join('\n');
const storageCodes = [...new Set([...storageSource.matchAll(/new StorageError\('([A-Z_]+)'\)/g)].map((m) => m[1]))];
const gatewaySource = readFileSync(root + '/packages/model-gateway/src/gateway.ts', 'utf8');
const gatewayErrorCodes = [...new Set([...gatewaySource.matchAll(/errorCode: '([A-Z_]+)'/g)].map((m) => m[1]))];
const assessmentCodes = [
  'MODEL_CAPABILITY_MISSING', 'NO_OBSERVATION_REF', 'CRITERION_MISMATCH',
  'FAKE_EVIDENCE', 'MALFORMED_JUDGMENT', 'NO_DECISION', 'OBSERVED',
];

const probes = [];

probes.push({
  id: 'section7-vs-error-codes',
  section7Codes,
  errorCodes: [...ERROR_CODES],
  onlyInSection7: section7Codes.filter((code) => !ERROR_CODES.includes(code)),
  onlyInPackage: ERROR_CODES.filter((code) => !section7Codes.includes(code)),
});

probes.push({
  id: 'storage-error-literals',
  codes: storageCodes,
  outsideSection7: storageCodes.filter((code) => !section7Codes.includes(code)),
});

probes.push({
  id: 'browser-reason-literals',
  codes: browserCodes,
  outsideSection7: browserCodes.filter((code) => !section7Codes.includes(code)),
  inSection7: browserCodes.filter((code) => section7Codes.includes(code)),
});

probes.push({
  id: 'gateway-errorCode-literals',
  codes: gatewayErrorCodes,
  outsideSection7: gatewayErrorCodes.filter((code) => !section7Codes.includes(code)),
});

const user = userDTO({
  id: uuid.user,
  email: 'audit@example.com',
  display_name: 'Audit',
  global_role: 'member',
  disabled: false,
  version: 1,
});
probes.push({ id: 'storage.userDTO', contract: check('User', user), keys: Object.keys(user) });

const project = {
  id: uuid.project,
  name: 'audit',
  status: 'active',
  version: 1,
  createdAt: new Date('2026-10-02T00:00:00.000Z').toISOString(),
  defaultModelProfileId: null,
};
probes.push({ id: 'storage.project-shape', contract: check('Project', project) });

const runStamp = '2026-10-02T09:26:57.913Z';
probes.push({
  id: 'time.run-to-char-pattern',
  sample: runStamp,
  dateTime: check('Project', { ...project, createdAt: runStamp }).ok,
});

const event = {
  schemaVersion: 1,
  id: '1',
  runId: uuid.run,
  seq: 1,
  type: 'phase.changed',
  at: new Date().toISOString(),
  payload: { phase: 'explore', contextVersion: 1 },
};
probes.push({
  id: 'events.phase.changed',
  contract: check('RunEvent', event),
  idEqualsSeq: event.id === String(event.seq),
});

probes.push({
  id: 'events.payload-mismatch',
  contract: check('RunEvent', { ...event, payload: { phase: 'explore' } }),
});

probes.push({
  id: 'events.id-seq-not-enforced-by-schema',
  contract: check('RunEvent', { ...event, id: '9', seq: 1 }),
});

const attemptBase = {
  id: uuid.action,
  caseId: uuid.request,
  taskId: uuid.task,
  attemptNumber: 1,
  status: 'running',
  verdict: null,
  finishedAt: null,
};
probes.push({
  id: 'time.attempt-candidates',
  z: check('CaseAttempt', { ...attemptBase, startedAt: '2026-10-02T09:26:57.913Z' }),
  offset: check('CaseAttempt', { ...attemptBase, startedAt: '2026-10-02T17:26:57.913+08:00' }),
  utcOffset: check('CaseAttempt', { ...attemptBase, startedAt: '2026-10-02T09:26:57.913+00:00' }),
  space: check('CaseAttempt', { ...attemptBase, startedAt: '2026-10-02 09:26:57.913+00' }),
  nullStarted: check('CaseAttempt', { ...attemptBase, startedAt: null }),
});

const snapshot = {
  snapshotId: uuid.snap,
  pageId: uuid.page,
  frameIds: ['main'],
  displayUrl: 'https://example.test/',
  title: 'audit',
  responseStatus: null,
  capturedAt: new Date().toISOString(),
  stateVersion: 1,
  viewport: { width: 1280, height: 720 },
  nodes: [],
  screenshotRef: null,
  networkSummary: [],
  consoleSummary: [],
  truncated: false,
  redacted: true,
};
probes.push({
  id: 'browser.snapshot-null-status',
  nullStatus: check('BrowserSnapshot', snapshot),
  forced200: check('BrowserSnapshot', { ...snapshot, responseStatus: null ?? 200 }),
  expression: null ?? 200,
});

const networkEntry = {
  url: 'https://example.test/a',
  method: 'GET',
  status: null,
  resourceType: 'document',
  summary: '[REQ] GET https://example.test/a',
};
probes.push({ id: 'browser.network-entry', contract: check('NetworkEntries', [networkEntry]) });

const artifactDefault = {
  id: uuid.evidence,
  projectId: 'project-default',
  runId: 'run-default',
  kind: 'screenshot',
  status: 'available',
  bytes: 3,
  sha256: 'a'.repeat(64),
  contentUrl: 'memory://' + uuid.evidence + '.png',
  redaction: 'not_needed',
  error: null,
  createdAt: new Date().toISOString(),
  taskId: null,
  stepId: null,
  caseId: null,
  snapshotId: null,
};
const artifactUuid = {
  ...artifactDefault,
  projectId: uuid.project,
  runId: uuid.run,
  taskId: uuid.task,
  contentUrl: 'file:///tmp/audit.png',
};
probes.push({
  id: 'browser.artifact',
  defaultIds: check('Artifact', artifactDefault),
  uuidIds: check('Artifact', artifactUuid),
  captureResultDefault: (() => {
    const validator = getToolResultValidator('capture');
    const ok = validator(artifactDefault);
    return { ok: Boolean(ok), issues: ok ? [] : (validator.errors ?? []).map((e) => `${e.instancePath} ${e.message}`) };
  })(),
  captureResultUuid: (() => {
    const validator = getToolResultValidator('capture');
    return { ok: Boolean(validator(artifactUuid)) };
  })(),
});

const criterionResult = {
  criterionId: 'smoke.visible',
  result: 'passed',
  reason: "Criterion 'smoke.visible' evaluated on active page state.",
  evidenceRefs: [],
};
probes.push({
  id: 'browser.assert-criterion-data',
  contract: check('CriterionResult', criterionResult),
  resultSchema: Boolean(getToolResultValidator('assert_criterion')(criterionResult)),
});

const toolResult = {
  requestId: uuid.request,
  actionId: uuid.action,
  status: 'failed',
  data: snapshot,
  reasonCode: 'INVALID_TOOL_ARGUMENTS',
  evidenceRefs: [],
};
probes.push({
  id: 'browser.tool-result-envelope',
  envelope: check('ToolResult', toolResult),
  submitCaseDataIsSnapshot: Boolean(getToolResultValidator('submit_case')(snapshot)),
});

const toolsValidator = getRootValidator('tools');
function toolOk(call) {
  const ok = toolsValidator(call);
  return { ok: Boolean(ok), issues: ok ? [] : (toolsValidator.errors ?? []).map((e) => `${e.instancePath} ${e.message}`) };
}
const pageId = uuid.page;
probes.push({
  id: 'tools.sample-calls',
  observe: toolOk({ name: 'observe', args: {} }),
  observeExtra: toolOk({ name: 'observe', args: { pageId, extra: true } }),
  scroll: toolOk({ name: 'scroll', args: { pageId, direction: 'down', pixels: 100 } }),
  scrollMissingPage: toolOk({ name: 'scroll', args: { direction: 'down', pixels: 100 } }),
  click: toolOk({
    name: 'click',
    args: { target: { snapshotId: uuid.snap, pageId, nodeId: 'n1' } },
  }),
  clickMissingPage: toolOk({
    name: 'click',
    args: { target: { snapshotId: uuid.snap, nodeId: 'n1' } },
  }),
  finishCase: toolOk({ name: 'finish_case', args: { summary: 'done', gaps: [] } }),
  requestInput: toolOk({ name: 'request_input', args: { kind: 'clarification', prompt: 'which account?' } }),
  namesInSchemaNotInBrowserSwitch: toolNames.filter((name) => !browserCases.includes(name)),
  browserSwitchNotInSchema: browserCases.filter((name) => !toolNames.includes(name)),
});

const dispatcher = createPolicyDispatcher(async () => ({ observed: true }));
const known = [uuid.evidence];
const dispatched = await dispatcher.dispatch({
  role: 'explorer',
  knownEvidenceIds: known,
  call: { name: 'observe', args: { pageId } },
});
const deniedTool = await dispatcher.dispatch({
  role: 'explorer',
  knownEvidenceIds: known,
  call: { name: 'finish_case', args: { summary: 'x', gaps: [] } },
});
const badCall = await dispatcher.dispatch({
  role: 'explorer',
  knownEvidenceIds: known,
  call: { name: 'observe', args: { extra: 1 } },
});
probes.push({
  id: 'agents.dispatch-result',
  success: dispatched,
  denied: deniedTool,
  invalid: badCall,
  successIsToolResult: check('ToolResult', dispatched),
  executedDataIsBrowserSnapshot: Boolean(getToolResultValidator('observe')(dispatched.data)),
});

probes.push({
  id: 'agents.review-plan',
  missingKind: reviewPlan({
    criteria: [{ id: 'smoke.visible', sourceKind: 'generic_smoke', sourceRef: 'smoke' }],
  }),
  fullCriterion: check('Criterion', {
    id: 'smoke.visible',
    kind: 'element_visible',
    description: 'visible',
    sourceKind: 'generic_smoke',
    sourceRef: 'smoke',
  }),
  elementVisibleWithoutLocator: check('Criterion', {
    id: 'smoke.visible',
    kind: 'element_visible',
    description: 'visible',
    sourceKind: 'generic_smoke',
    sourceRef: 'smoke',
  }),
});

const decisionOk = { type: 'object', additionalProperties: false, required: ['toolCalls', 'done'], properties: { done: { type: 'boolean' }, toolCalls: { type: 'array', maxItems: 4, items: { type: 'object' } } } };
const { Ajv } = createRequire(root + '/packages/contracts/package.json')('ajv');
probes.push({
  id: 'agents.decision-schema',
  looseAccepted: new Ajv({ allErrors: true }).compile(decisionOk)({ done: false, toolCalls: [{ foo: 1 }] }),
  toolsRejected: toolOk({ foo: 1 }),
});

probes.push({
  id: 'agents.roles',
  agentRoles: [...AGENT_ROLES],
  taskRoles: domain.$defs.Task.properties.role.enum,
  roleModels: Object.keys(domain.$defs.RoleModels.properties),
  toolsByRole: Object.fromEntries(AGENT_ROLES.map((role) => [role, toolsForRole(role)])),
  metadataRoles: Object.fromEntries(Object.entries(toolMetadata).map(([name, meta]) => [name, [...meta.roles]])),
});

probes.push({
  id: 'gateway.assessment',
  fake: assessCriterionOutput({
    data: { criterionId: 'smoke.visible', result: 'passed', evidenceRefs: ['99999999-9999-4999-8999-999999999999'] },
    expectedCriterionId: 'smoke.visible',
    knownEvidenceIds: [uuid.evidence],
    criterionKind: 'semantic',
    imageInput: true,
  }),
  empty: assessCriterionOutput({
    data: { criterionId: 'smoke.visible', result: 'passed', evidenceRefs: [] },
    expectedCriterionId: 'smoke.visible',
    knownEvidenceIds: [uuid.evidence],
    criterionKind: 'semantic',
    imageInput: true,
  }),
  visual: assessCriterionOutput({
    data: { criterionId: 'smoke.visible', result: 'passed', evidenceRefs: [uuid.evidence] },
    expectedCriterionId: 'smoke.visible',
    knownEvidenceIds: [uuid.evidence],
    criterionKind: 'visual',
    imageInput: false,
  }),
  assessmentCodes,
  outsideSection7: assessmentCodes.filter((code) => !section7Codes.includes(code)),
});

const callInput = {
  taskId: FIXTURE.taskId,
  profileId: FIXTURE.profileId,
  contextVersion: 1,
  role: 'executor',
  promptVersion: 't04.1',
  purpose: 'decide',
  messages: [messageFromText('user', 'look')],
  approvedImageIds: [],
  toolSchemas: [],
  outputSchema: { type: 'object', additionalProperties: true },
  timeoutMs: 1000,
  maxOutputTokens: 200,
};

let decrypts = 0;
const httpsGateway = createGateway({
  profiles: [{
    id: FIXTURE.profileId,
    version: 1,
    name: 'audit',
    endpoint: 'http://example.test/v1',
    configuredModelId: 'audit-model',
    kind: 'openai_compatible',
    dataBoundary: 'external',
    capabilities: { structuredOutput: true, nativeTools: true, imageInput: false },
    encryptedApiKey: 'ciphertext',
    approvedFallbackIds: [],
  }],
  decryptKey() {
    decrypts += 1;
    return 'secret';
  },
  adapter: {
    kind: 'openai_compatible',
    version: 'audit',
    build(input) { return { endpoint: input.endpoint, body: { model: input.model } }; },
    async send() { throw new Error('send should not run'); },
  },
});
const httpsRecord = await httpsGateway.generateDecision(callInput);

let sends = 0;
const providerGateway = createGateway({
  profiles: [{
    id: FIXTURE.profileId,
    version: 1,
    name: 'audit',
    endpoint: 'https://example.test/v1',
    configuredModelId: 'audit-model',
    kind: 'openai_compatible',
    dataBoundary: 'external',
    capabilities: { structuredOutput: true, nativeTools: true, imageInput: false },
    encryptedApiKey: 'ciphertext',
    approvedFallbackIds: [],
  }],
  decryptKey: () => 'secret',
  adapter: {
    kind: 'openai_compatible',
    version: 'audit',
    build(input) { return { endpoint: input.endpoint, body: { model: input.model } }; },
    async send() {
      sends += 1;
      throw Object.assign(new Error('PROVIDER_ERROR'), { code: 'PROVIDER_ERROR' });
    },
  },
});
const providerRecord = await providerGateway.generateDecision(callInput);

const stub = createStubAdapter();
const stubGateway = createGateway({
  profiles: [{
    id: FIXTURE.profileId,
    version: 1,
    name: 'stub',
    endpoint: 'https://stub.invalid/v1',
    configuredModelId: 'stub-ok',
    kind: 'stub',
    dataBoundary: 'internal',
    capabilities: { structuredOutput: true, nativeTools: true, imageInput: true },
    encryptedApiKey: null,
    approvedFallbackIds: [],
  }],
  decryptKey() { throw new Error('decrypt'); },
  adapter: stub,
});
const completeRecord = await stubGateway.complete({
  taskId: FIXTURE.taskId,
  profileId: FIXTURE.profileId,
  contextVersion: 1,
  purpose: 'decide',
  messages: [messageFromText('user', 'look')],
  maxOutputTokens: 200,
  outputSchema: { type: 'object', additionalProperties: true },
}, {
  role: 'executor',
  promptVersion: 't04.1',
  approvedImageIds: [],
  toolSchemas: [],
  timeoutMs: 1000,
});
const probeRecord = await stubGateway.capabilityProbe(FIXTURE.profileId, 1000);

const gatewayProfile = {
  id: FIXTURE.profileId,
  version: 1,
  name: 'stub',
  endpoint: 'https://stub.invalid/v1',
  configuredModelId: 'stub-ok',
  kind: 'stub',
  dataBoundary: 'internal',
  capabilities: { structuredOutput: true, nativeTools: true, imageInput: true },
  encryptedApiKey: null,
  approvedFallbackIds: [],
};

probes.push({
  id: 'gateway.runtime',
  httpDoesNotDecrypt: { decrypts, errorCode: httpsRecord.errorCode, requestResult: httpsRecord.requestResult, providerCalls: httpsRecord.providerCalls },
  providerErrorMapped: { sends, errorCode: providerRecord.errorCode, requestResult: providerRecord.requestResult },
  completeDataIsModelResult: check('ModelResult', completeRecord.data),
  completeMeta: {
    errorCode: completeRecord.errorCode,
    requestResult: completeRecord.requestResult,
    usageSource: completeRecord.data && completeRecord.data.usage ? completeRecord.data.usage.usageSource : null,
  },
  probeDataIsModelProbeResult: check('ModelProbeResult', probeRecord.data),
  gatewayProfileIsNotModelProfile: check('ModelProfile', gatewayProfile),
});

const reportNames = Object.keys(report.$defs);
const domainNames = new Set(Object.keys(domain.$defs));
probes.push({
  id: 'schema-surface',
  domainDefs: domainNames.size,
  toolCount: toolNames.length,
  eventTypes: events.$defs.RunEvent.properties.type.enum,
  reportDefsAlsoInDomain: reportNames.filter((name) => domainNames.has(name)),
  reportOnly: reportNames.filter((name) => !domainNames.has(name)),
});

const output = {
  at: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  probes,
};
writeFileSync(root + '/spikes/audit/raw-results.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  node: output.node,
  probeIds: probes.map((probe) => probe.id),
  highlights: {
    user: probes.find((p) => p.id === 'storage.userDTO'),
    artifact: probes.find((p) => p.id === 'browser.artifact'),
    assert: probes.find((p) => p.id === 'browser.assert-criterion-data'),
    tools: probes.find((p) => p.id === 'tools.sample-calls'),
    dispatch: probes.find((p) => p.id === 'agents.dispatch-result'),
    plan: probes.find((p) => p.id === 'agents.review-plan'),
    decision: probes.find((p) => p.id === 'agents.decision-schema'),
    gateway: probes.find((p) => p.id === 'gateway.runtime'),
    attempt: probes.find((p) => p.id === 'time.attempt-candidates'),
    snapshot: probes.find((p) => p.id === 'browser.snapshot-null-status'),
    outside: {
      browser: probes.find((p) => p.id === 'browser-reason-literals').outsideSection7,
      storage: probes.find((p) => p.id === 'storage-error-literals').outsideSection7,
      gateway: probes.find((p) => p.id === 'gateway-errorCode-literals').outsideSection7,
      assessment: probes.find((p) => p.id === 'gateway.assessment').outsideSection7,
      section7diff: probes.find((p) => p.id === 'section7-vs-error-codes'),
    },
  },
}, null, 2));
