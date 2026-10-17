// Pure Node: the report must describe the page as it is at report time, not the
// page as it was right after the last action. The 66 run reported "密码已填写却仍
// 提示请输入密码" from a snapshot taken 0.43 s after the click, while that message
// was still leaving its transition. The real Worker runs here; the runtime, the
// browser and the model are fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseContract } from '@localqa/contracts';
import { Worker } from '../dist/index.js';

const pageId = '22222222-2222-4222-8222-222222222222';
const taskId = randomUUID();
let seed = 0;
const node = (nodeId, extra) =>
  parseContract('SnapshotNode', {
    nodeId,
    frameId: 'main',
    role: 'text',
    name: '',
    text: '',
    visible: true,
    enabled: true,
    bounds: { left: 0, top: 0, width: 200, height: 40 },
    ...extra,
  });

function snapshot(nodes) {
  seed += 1;
  return parseContract('BrowserSnapshot', {
    snapshotId: randomUUID(),
    pageId,
    frameIds: ['main'],
    displayUrl: 'http://fixture.local/login',
    title: '登录',
    responseStatus: 200,
    capturedAt: new Date(Date.UTC(2026, 9, 17, 0, 0, seed)).toISOString(),
    stateVersion: seed,
    viewport: { width: 1280, height: 720 },
    nodes: [
      node('main_node', { role: 'main', name: '登录', text: '登录' }),
      ...nodes,
    ],
    screenshotRef: null,
    networkSummary: [],
    consoleSummary: [],
    truncated: false,
    redacted: true,
  });
}

const account = node('main_node_0', {
  role: 'text',
  inputType: 'text',
  name: '请输入账号',
  placeholder: '请输入账号',
});
const password = node('main_node_1', {
  role: 'password',
  inputType: 'password',
  name: '请输入密码',
  placeholder: '请输入密码',
  text: '[redacted]',
  sensitive: true,
});
const accountHint = node('main_text_1', {
  role: 'statictext',
  name: '请输入账号',
  text: '请输入账号',
  relatedNodeId: 'main_node_0',
});
const passwordHint = node('main_text_2', {
  role: 'statictext',
  name: '请输入密码',
  text: '请输入密码',
  relatedNodeId: 'main_node_1',
});

const definition = parseContract('CaseDefinition', {
  id: randomUUID(),
  runId: randomUUID(),
  projectId: randomUUID(),
  title: '单字段缺失登录校验',
  summary: '账号为空、密码已填时点击登录，只应提示请输入账号。',
  preconditions: [],
  outline: ['打开登录页', '在密码框输入虚构口令', '点击登录'],
  criteria: [
    {
      id: 'only_missing_field_hint',
      kind: 'semantic',
      description: '账号为空时只出现账号的必填提示，密码的提示已经消失',
      sourceRef: 'session:planner',
      sourceKind: 'inferred',
    },
  ],
  requiresLogin: false,
  version: 1,
});

/** One executor job with fake runtime, fake browser and fake model. */
async function runExecutor({ executeTool }) {
  const ids = {
    project: randomUUID(),
    run: randomUUID(),
    task: taskId,
    context: randomUUID(),
  };
  const scratch = mkdtempSync(join(tmpdir(), 'localqa-final-observation-'));
  const records = [];
  const finishes = [];
  const modelPayloads = [];
  const toolCalls = [];
  let round = 0;
  const runtime = {
    async claim() {
      return {
        task: { id: ids.task, role: 'executor' },
        fencingToken: 1,
        leaseToken: 'fake',
        contextVersion: 1,
      };
    },
    async work() {
      return {
        stage: 'execute',
        task: { id: ids.task, role: 'executor' },
        definition,
        targetUrl: 'http://fixture.local/login',
        contextId: ids.context,
        run: {
          projectId: ids.project,
          id: ids.run,
          executionMode: 'smoke',
          effectiveConfig: {
            authProfileVersion: null,
            actionPolicy: 'non_submitting',
            allowedOrigins: ['http://fixture.local'],
            budget: { maxActionsPerCase: 8, maxPages: 2, maxDepth: 1 },
          },
        },
      };
    },
    async requireAnonymousOrInput() {
      return true;
    },
    async model(_proof, _role, payload) {
      modelPayloads.push(payload);
      const schema = payload.outputSchema ?? {};
      if (Array.isArray(schema.required) && schema.required.includes('bug'))
        return {
          requestResult: 'ok',
          data: {
            status: 'passed',
            summary: '密码的提示已经消失，只剩账号的提示。',
            verified: ['点击后只剩账号必填提示'],
            gaps: [],
            criteria: [
              {
                criterionId: 'only_missing_field_hint',
                result: 'passed',
                reason: '只剩账号提示',
              },
            ],
            bug: null,
          },
        };
      round += 1;
      if (round === 1)
        return {
          requestResult: 'ok',
          data: {
            done: false,
            toolCalls: [{ name: 'click', args: { target: clickTarget } }],
          },
        };
      return { requestResult: 'ok', data: { done: true, toolCalls: [] } };
    },
    async grant() {
      return { step: { id: randomUUID() } };
    },
    async record(_proof, _grant, status, recorded, evidence, reasonCode) {
      records.push({
        status,
        reasonCode: reasonCode ?? null,
        snapshot: recorded ?? null,
        evidence: evidence ?? [],
      });
    },
    async upload(_proof, input) {
      return { ...input, id: randomUUID() };
    },
    async finish(_proof, result) {
      finishes.push(result);
    },
    async stop() {
      throw new Error('unexpected run termination');
    },
    async heartbeat() {
      return { contextVersion: 1, cancellationRequested: false };
    },
  };
  const browser = {
    async createSession() {
      return {
        id: ids.context,
        activePageId: pageId,
        getPageById() {
          return undefined;
        },
        executeTool: (call) => {
          toolCalls.push(call.name);
          return executeTool(call, { ids, scratch });
        },
        async close() {},
      };
    },
  };
  try {
    const worker = new Worker({
      runtime,
      browser,
      scratch,
      heartbeatMs: 10000,
    });
    assert.equal(await worker.once(), true);
    return { records, finishes, modelPayloads, toolCalls };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

let clickTarget;
test('the report reads a fresh observation and says what changed after the last action', async () => {
  // Before the click both hints are on screen; the click's own observation still
  // shows both because the password hint is leaving its transition. By report
  // time only the account hint is left.
  const beforeClick = snapshot([account, password, accountHint, passwordHint]);
  const afterClick = snapshot([account, password, accountHint, passwordHint]);
  const atReport = snapshot([account, password, accountHint]);
  clickTarget = {
    snapshotId: beforeClick.snapshotId,
    pageId: beforeClick.pageId,
    nodeId: 'main_node_2',
    frameId: 'main',
  };
  const result = await runExecutor({
    executeTool: (call, { ids, scratch }) => {
      if (call.name === 'navigate')
        return { status: 'succeeded', reasonCode: null, data: beforeClick };
      if (call.name === 'click')
        return { status: 'succeeded', reasonCode: null, data: afterClick };
      if (call.name === 'observe')
        return { status: 'succeeded', reasonCode: null, data: atReport };
      if (call.name === 'capture') {
        const path = join(scratch, ids.task, 'case.png');
        writeFileSync(path, Buffer.from([137, 80, 78, 71]));
        return {
          status: 'succeeded',
          reasonCode: null,
          data: {
            id: randomUUID(),
            projectId: ids.project,
            runId: ids.run,
            kind: 'screenshot',
            status: 'available',
            bytes: 4,
            sha256: null,
            contentUrl: pathToFileURL(path).href,
            redaction: 'not_needed',
            error: null,
            createdAt: new Date().toISOString(),
            taskId: ids.task,
            stepId: null,
            caseId: definition.id,
            snapshotId: null,
          },
        };
      }
      return { status: 'failed', reasonCode: 'TARGET_NOT_FOUND', data: null };
    },
  });

  // The page was observed again right before the report.
  assert.deepEqual(result.toolCalls, [
    'navigate',
    'click',
    'capture',
    'observe',
  ]);
  const payload = JSON.parse(
    result.modelPayloads.at(-1).messages.at(-1).content[0].text,
  );
  const hints = payload.finalObservation.nodes.filter(
    (entry) => entry.role === 'statictext',
  );
  assert.deepEqual(
    hints.map((entry) => entry.name),
    ['请输入账号'],
    'the departed hint is not in the final observation',
  );
  // The password field itself is still there, with its own placeholder.
  assert.equal(
    payload.finalObservation.nodes.find((entry) => entry.role === 'password')
      .placeholder,
    '请输入密码',
  );
  assert.deepEqual(payload.sinceLastAction, {
    appeared: [],
    disappeared: ['请输入密码（请输入密码）'],
  });
  assert.equal(payload.finalObservation.settled, undefined);
  assert.equal(result.finishes.length, 1);
  assert.equal(result.finishes[0].agentReport.status, 'passed');
});
