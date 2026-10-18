import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseContract } from '@localqa/contracts';
import { DomainError } from '@localqa/domain';
import { Worker } from '../dist/index.js';

const snapshot = (stateVersion, nodeId = 'main_node_0') =>
  parseContract('BrowserSnapshot', {
    snapshotId: randomUUID(),
    pageId: '22222222-2222-4222-8222-222222222222',
    frameIds: ['main'],
    displayUrl: 'http://fixture.local/home',
    title: 'Home',
    responseStatus: 200,
    capturedAt: '2026-10-17T05:57:00.000Z',
    stateVersion,
    viewport: { width: 1280, height: 720 },
    nodes: [
      {
        nodeId,
        frameId: 'main',
        role: 'text',
        name: '搜索',
        text: '首页',
        visible: true,
        enabled: true,
        bounds: { left: 0, top: 0, width: 200, height: 40 },
      },
    ],
    screenshotRef: null,
    networkSummary: [],
    consoleSummary: [],
    truncated: false,
    redacted: true,
  });

const target = (snap) => ({
  snapshotId: snap.snapshotId,
  pageId: snap.pageId,
  nodeId: snap.nodes[0].nodeId,
});

const isReportSchema = (schema) =>
  Boolean(schema?.properties && 'status' in schema.properties);

/**
 * One executor job for a frozen case. The fake grant spends the case's action
 * allowance after `allowedActions` non-capture actions; captures are evidence
 * and stay allowed. The fake browser returns a fresh snapshot per action and
 * writes a real screenshot file for the report's evidence capture.
 */
async function runCase({
  allowedActions,
  decisions,
  report,
  maxActionsPerCase = 4,
}) {
  const ids = {
    project: randomUUID(),
    run: randomUUID(),
    task: randomUUID(),
    context: randomUUID(),
    case: randomUUID(),
  };
  const scratch = mkdtempSync(join(tmpdir(), 'localqa-case-limit-'));
  const directory = join(scratch, ids.task);
  const snapshots = [];
  const records = [];
  const finishes = [];
  const modelPayloads = [];
  const uploads = [];
  let grants = 0;
  let stopped = false;
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
        targetUrl: 'http://fixture.local/home',
        contextId: ids.context,
        definition: parseContract('CaseDefinition', {
          id: ids.case,
          runId: ids.run,
          projectId: ids.project,
          version: 1,
          title: '登录后首页与主菜单冒烟',
          summary: '检查首页和主要菜单',
          preconditions: [],
          outline: ['打开首页', '检查菜单'],
          criteria: [
            {
              id: 'home_visible',
              kind: 'semantic',
              description: '首页可见',
              sourceKind: 'inferred',
              sourceRef: 'observation:1',
            },
            {
              id: 'menus_checked',
              kind: 'semantic',
              description: '主要菜单都能打开',
              sourceKind: 'inferred',
              sourceRef: 'observation:2',
            },
          ],
        }),
        run: {
          projectId: ids.project,
          id: ids.run,
          executionMode: 'smoke',
          effectiveConfig: {
            authProfileVersion: null,
            actionPolicy: 'non_submitting',
            allowedOrigins: ['http://fixture.local'],
            budget: {
              maxActionsPerCase,
              maxPages: 2,
              maxDepth: 1,
            },
          },
        },
      };
    },
    async requireAnonymousOrInput() {
      return true;
    },
    async model(_proof, _role, payload) {
      modelPayloads.push(payload);
      if (isReportSchema(payload.outputSchema))
        return { requestResult: 'ok', data: report };
      const decision = decisions[round] ?? { done: true, toolCalls: [] };
      round += 1;
      return { requestResult: 'ok', data: decision };
    },
    async grant(_proof, call) {
      if (call.name === 'capture') return { step: { id: randomUUID() } };
      grants += 1;
      if (grants > allowedActions)
        throw Object.assign(new Error('case limit'), {
          code: 'CASE_ACTION_LIMIT',
        });
      return { step: { id: randomUUID() } };
    },
    async record(_proof, _grant, status, recorded, evidence) {
      records.push({
        status,
        snapshot: recorded,
        evidence: evidence ?? [],
      });
    },
    async upload(_proof, artifact) {
      uploads.push(artifact.id);
      return artifact;
    },
    async finish(_proof, result, results) {
      finishes.push({ result, results });
    },
    async stop() {
      stopped = true;
    },
    async heartbeat() {
      return { contextVersion: 1, cancelRequested: false };
    },
  };
  const browser = {
    async createSession() {
      return {
        id: ids.context,
        activePageId: '22222222-2222-4222-8222-222222222222',
        getPageById() {
          return undefined;
        },
        async executeTool(call) {
          if (call.name === 'capture') {
            mkdirSync(directory, { recursive: true });
            const file = join(directory, `shot-${randomUUID()}.png`);
            writeFileSync(file, 'png');
            return {
              status: 'succeeded',
              reasonCode: null,
              data: parseContract('Artifact', {
                id: randomUUID(),
                projectId: ids.project,
                runId: ids.run,
                kind: 'screenshot',
                status: 'available',
                bytes: 3,
                sha256: null,
                contentUrl: pathToFileURL(file).href,
                redaction: 'not_needed',
                error: null,
                createdAt: '2026-10-17T05:57:00.000Z',
                taskId: ids.task,
                stepId: null,
                caseId: null,
                snapshotId: null,
              }),
            };
          }
          const next = snapshot(snapshots.length + 1);
          snapshots.push(next);
          return { status: 'succeeded', reasonCode: null, data: next };
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
    return {
      modelPayloads,
      finishes,
      records,
      uploads,
      stopped,
      maxActionsPerCase,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const typeText = () => ({
  done: false,
  toolCalls: [
    { name: 'type_text', args: { target: target(snapshot(1)), text: 'x' } },
  ],
});

test('a spent case allowance still produces a report and never stops the session', async () => {
  const { modelPayloads, finishes, records, stopped } = await runCase({
    allowedActions: 2,
    decisions: [
      typeText(),
      typeText(),
      typeText(),
      { done: true, toolCalls: [] },
    ],
    report: {
      status: 'blocked',
      summary: '首页已打开，菜单只检查了一部分就到达动作上限。',
      verified: ['首页正常显示'],
      gaps: ['菜单未全部检查'],
      criteria: [
        {
          criterionId: 'home_visible',
          result: 'passed',
          reason: '首页标题和主体在观察里可见',
        },
        {
          criterionId: 'menus_checked',
          result: 'unknown',
          reason: '动作上限已用完，只检查了部分菜单',
        },
      ],
      bug: null,
    },
  });
  // Two decisions acted, the third was refused with CASE_ACTION_LIMIT; the
  // report call is the last model request.
  const reportPayload = modelPayloads.at(-1);
  assert.equal(isReportSchema(reportPayload.outputSchema), true);
  const reportInput = JSON.parse(reportPayload.messages[1].content[0].text);
  assert.deepEqual(reportInput.caseBudget, {
    maxActions: 4,
    actionsUsed: 2,
    limitReached: true,
  });
  assert.ok(reportInput.actions.length >= 2);
  assert.equal(
    reportInput.actions.at(-1).reasonCode,
    'CASE_ACTION_LIMIT',
    'the refused action is in the trail',
  );
  // The verdict keeps the evidence-backed criterion and the limit gap.
  const settled = finishes.at(-1);
  assert.equal(settled.result.stage, 'execute');
  assert.deepEqual(settled.result.caseActionLimit, {
    maxActions: 4,
    actionsUsed: 2,
  });
  assert.deepEqual(
    settled.results.map((entry) => [entry.criterionId, entry.result]),
    [
      ['home_visible', 'passed'],
      ['menus_checked', 'unknown'],
    ],
  );
  assert.ok(
    settled.result.agentReport.gaps.some((gap) =>
      gap.includes('本用例动作上限已用完'),
    ),
  );
  // Captures are evidence: the report's screenshot was still taken.
  assert.equal(settled.result.agentReport.status, 'blocked');
  assert.equal(stopped, false, 'the session must not be stopped');
  assert.ok(records.some((record) => record.status === 'succeeded'));
});

test('the observation carries a decreasing remaining action count', async () => {
  const { modelPayloads } = await runCase({
    allowedActions: 2,
    decisions: [typeText(), typeText(), { done: true, toolCalls: [] }],
    report: {
      status: 'passed',
      summary: '完成',
      verified: [],
      gaps: [],
      criteria: [
        { criterionId: 'home_visible', result: 'passed', reason: 'ok' },
        { criterionId: 'menus_checked', result: 'passed', reason: 'ok' },
      ],
      bug: null,
    },
  });
  const observationJson = (payload) => {
    const parts = payload.messages.flatMap((message) => message.content);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const text = parts[index].text ?? '';
      if (!text.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(text);
        if (parsed.caseBudget) return parsed;
      } catch {
        /* not the observation JSON */
      }
    }
    return null;
  };
  const budgets = modelPayloads
    .filter((payload) => !isReportSchema(payload.outputSchema))
    .map((payload) => observationJson(payload).caseBudget.remainingActions);
  assert.deepEqual(budgets, [2, 1]);
});

test('a run-level budget stop keeps its old behaviour', async () => {
  const ids = {
    project: randomUUID(),
    run: randomUUID(),
    task: randomUUID(),
    context: randomUUID(),
  };
  const scratch = mkdtempSync(join(tmpdir(), 'localqa-case-budget-'));
  let stopped = false;
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
        targetUrl: 'http://fixture.local/home',
        contextId: ids.context,
        definition: parseContract('CaseDefinition', {
          id: randomUUID(),
          runId: ids.run,
          projectId: ids.project,
          version: 1,
          title: '预算',
          summary: '预算',
          preconditions: [],
          outline: ['打开'],
          criteria: [
            {
              id: 'c1',
              kind: 'semantic',
              description: 'c1',
              sourceKind: 'inferred',
              sourceRef: 'observation:1',
            },
          ],
        }),
        run: {
          projectId: ids.project,
          id: ids.run,
          executionMode: 'smoke',
          effectiveConfig: {
            authProfileVersion: null,
            actionPolicy: 'non_submitting',
            allowedOrigins: ['http://fixture.local'],
            budget: { maxActionsPerCase: 4, maxPages: 2, maxDepth: 1 },
          },
        },
      };
    },
    async requireAnonymousOrInput() {
      return true;
    },
    async model() {
      return { requestResult: 'ok', data: { done: true, toolCalls: [] } };
    },
    async grant() {
      throw new DomainError('BUDGET_EXCEEDED');
    },
    async record() {},
    async upload() {
      throw new Error('unexpected upload');
    },
    async finish() {},
    async stop() {
      stopped = true;
    },
    async heartbeat() {
      return { contextVersion: 1, cancelRequested: false };
    },
  };
  const browser = {
    async createSession() {
      return {
        id: ids.context,
        activePageId: '22222222-2222-4222-8222-222222222222',
        getPageById() {
          return undefined;
        },
        async executeTool() {
          return { status: 'succeeded', reasonCode: null, data: snapshot(1) };
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
    await worker.once();
    assert.equal(stopped, true, 'a run budget stop is unchanged');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
