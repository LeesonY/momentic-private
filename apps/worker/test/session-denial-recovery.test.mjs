import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseContract } from '@localqa/contracts';
import { Worker } from '../dist/index.js';

const snapshot = (stateVersion, nodeId) =>
  parseContract('BrowserSnapshot', {
    snapshotId: randomUUID(),
    pageId: '22222222-2222-4222-8222-222222222222',
    frameIds: ['main'],
    displayUrl: 'http://fixture.local/login',
    title: 'Login',
    responseStatus: 200,
    capturedAt: '2026-10-16T13:33:49.000Z',
    stateVersion,
    viewport: { width: 1280, height: 720 },
    nodes: [
      {
        nodeId,
        frameId: 'main',
        role: 'text',
        name: '请输入账号',
        text: '',
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

/**
 * One explorer job with a fake runtime and browser. `decisions` is consumed
 * per model round; `executeTool` decides the browser receipt per call.
 */
async function runExplorer({ decisions, executeTool, grant }) {
  const ids = {
    project: randomUUID(),
    run: randomUUID(),
    task: randomUUID(),
    context: randomUUID(),
  };
  const first = snapshot(1, 'main_node_0');
  const refreshed = snapshot(2, 'main_node_0');
  const scratch = mkdtempSync(join(tmpdir(), 'localqa-denial-recovery-'));
  const records = [];
  const finishes = [];
  const modelPayloads = [];
  const grants = [];
  let latestSnapshotId = null;
  let round = 0;
  const runtime = {
    async claim() {
      return {
        task: { id: ids.task, role: 'explorer' },
        fencingToken: 1,
        leaseToken: 'fake',
        contextVersion: 1,
      };
    },
    async work() {
      return {
        stage: 'explore',
        task: { id: ids.task, role: 'explorer' },
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
            budget: { maxActionsPerCase: 4, maxPages: 2, maxDepth: 1 },
          },
        },
      };
    },
    async requireAnonymousOrInput() {
      return true;
    },
    async model(_proof, _role, payload) {
      modelPayloads.push(payload);
      const planned = decisions({ first, refreshed });
      const decision = planned[round] ?? { done: true, toolCalls: [] };
      round += 1;
      return { requestResult: 'ok', data: decision };
    },
    async grant(_proof, call, _source, note) {
      grants.push({ call, note });
      if (grant) return grant(call, { latestSnapshotId });
      return { step: { id: randomUUID(), seq: grants.length } };
    },
    async record(_proof, _grant, status, recorded, evidence, reasonCode) {
      if (status === 'succeeded' && recorded)
        latestSnapshotId = recorded.snapshotId;
      records.push({
        status,
        reasonCode: reasonCode ?? null,
        snapshot: recorded,
        evidence: evidence ?? [],
      });
    },
    async finish(_proof, result) {
      finishes.push(result);
    },
    async stop() {
      throw new Error('unexpected run termination');
    },
    async heartbeat() {
      return { contextVersion: 1, cancelRequested: false };
    },
  };
  const browser = {
    async createSession() {
      return {
        id: ids.context,
        activePageId: first.pageId,
        getPageById() {
          return undefined;
        },
        executeTool: (call) => executeTool(call, { first, refreshed }),
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
    return { records, finishes, modelPayloads, grants, first, refreshed };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const text = (payload) =>
  payload.messages
    .flatMap((message) => message.content.map((part) => part.text ?? ''))
    .join('\n');

test('second refusal of the same target/reason tells the agent the count and to stop retrying', async () => {
  const { modelPayloads, records } = await runExplorer({
    decisions: ({ first }) => {
      const action = { done: false, toolCalls: [{ name: 'type_text', args: {
        target: { snapshotId: first.snapshotId, pageId: first.pageId, nodeId: 'main_node_0' },
        text: 'WrongPwd_123',
      } }] };
      return [action, action, action, { done: true, toolCalls: [] }];
    },
    grant: (call) => {
      if (call.name === 'type_text') throw Object.assign(new Error('SENSITIVE_INPUT_FORBIDDEN'),
        { code: 'SENSITIVE_INPUT_FORBIDDEN' });
      return { step: { id: randomUUID() } };
    },
    executeTool: (_call, { first }) => ({ status: 'succeeded', reasonCode: null, data: first }),
  });
  assert.doesNotMatch(text(modelPayloads[1]), /第 2 次被拒/);
  assert.match(text(modelPayloads[2]), /第 2 次被拒/);
  assert.match(text(modelPayloads[3]), /第 3 次被拒/);
  assert.match(text(modelPayloads[2]), /必须换目标或结束/);
  // Only initial navigation was granted/recorded; refusals never spend an intent.
  assert.equal(records.length, 1);
});

test('only the first step from a multi-tool decision receives its optional annotation', async () => {
  const result = await runExplorer({
    decisions: () => [
      { done: false, note: '检查页面状态和提示。', toolCalls: [
        { name: 'observe', args: {} }, { name: 'observe', args: {} },
      ] },
      { done: false, toolCalls: [{ name: 'observe', args: {} }] },
      { done: true, toolCalls: [] },
    ],
    executeTool: (_call, { first }) => ({ status: 'succeeded', reasonCode: null, data: first, evidenceRefs: [] }),
  });
  assert.deepEqual(result.grants.map(({ note }) => note), [undefined, '检查页面状态和提示。', undefined, undefined]);
});

test('a version conflict refreshes the observation and tells the model why', async () => {
  const { records, finishes, modelPayloads, refreshed } = await runExplorer({
    decisions: ({ first }) => [
      {
        done: false,
        toolCalls: [
          {
            name: 'type_text',
            args: {
              target: {
                snapshotId: first.snapshotId,
                pageId: first.pageId,
                nodeId: 'main_node_0',
              },
              text: 'smoke_user_114',
            },
          },
        ],
      },
      { done: true, toolCalls: [] },
    ],
    executeTool: (call, { first: initial, refreshed: fresh }) => {
      if (call.name === 'navigate')
        return { status: 'succeeded', reasonCode: null, data: initial };
      if (call.name === 'observe')
        return { status: 'succeeded', reasonCode: null, data: fresh };
      if (call.name === 'type_text')
        return { status: 'failed', reasonCode: 'VERSION_CONFLICT', data: null };
      return { status: 'failed', reasonCode: 'TARGET_NOT_FOUND', data: null };
    },
  });
  // The failed action is settled with its reason code, then the platform
  // re-observes so the next decision starts from an accepted snapshot.
  assert.deepEqual(
    records.map((record) => [record.status, record.reasonCode]),
    [
      ['succeeded', null],
      ['failed', 'VERSION_CONFLICT'],
      ['succeeded', null],
    ],
  );
  assert.equal(JSON.stringify(records).includes('smoke_user_114'), false);
  const settled = finishes.at(-1);
  assert.equal(settled.stage, 'explore');
  assert.equal(settled.modelActionDenials, 1);
  assert.deepEqual(settled.modelActionDenialReasons, {
    VERSION_CONFLICT: 1,
  });
  const second = text(modelPayloads[1]);
  assert.match(second, /VERSION_CONFLICT/);
  assert.match(second, /不要重复提交同一个目标/);
  assert.match(second, new RegExp(refreshed.snapshotId));
});

test('an action denied before its grant is counted by reason code', async () => {
  const { records, finishes, modelPayloads } = await runExplorer({
    decisions: () => [
      {
        done: false,
        toolCalls: [
          { name: 'finish_case', args: { summary: '越权', gaps: [] } },
        ],
      },
      { done: true, toolCalls: [] },
    ],
    executeTool: (call, { first }) => {
      if (call.name === 'navigate')
        return { status: 'succeeded', reasonCode: null, data: first };
      return { status: 'failed', reasonCode: 'TARGET_NOT_FOUND', data: null };
    },
  });
  // The dispatcher denied the tool before any grant/action intent existed.
  assert.deepEqual(
    records.map((record) => record.status),
    ['succeeded'],
  );
  const settled = finishes.at(-1);
  assert.equal(settled.modelActionDenials, 1);
  assert.deepEqual(settled.modelActionDenialReasons, { POLICY_DENIED: 1 });
  assert.match(text(modelPayloads[1]), /POLICY_DENIED/);
});

test('a grant-stage stale snapshot is a version conflict and recovers after the automatic observe', async () => {
  const afterAccount = snapshot(3, 'main_node_0');
  const afterPassword = snapshot(4, 'main_node_1');
  const typed = [];
  const { records, finishes, modelPayloads, refreshed } = await runExplorer({
    decisions: ({ first, refreshed: observed }) => [
      {
        done: false,
        toolCalls: [
          {
            name: 'type_text',
            args: {
              target: {
                snapshotId: first.snapshotId,
                pageId: first.pageId,
                nodeId: 'main_node_0',
              },
              text: 'WrongUser_123',
            },
          },
        ],
      },
      {
        done: false,
        // Still cites the navigate observation; the account action advanced it.
        toolCalls: [
          {
            name: 'type_text',
            args: {
              target: {
                snapshotId: first.snapshotId,
                pageId: first.pageId,
                nodeId: 'main_node_1',
              },
              text: 'WrongPwd_123',
            },
          },
        ],
      },
      {
        done: false,
        toolCalls: [
          {
            name: 'type_text',
            args: {
              target: {
                snapshotId: observed.snapshotId,
                pageId: observed.pageId,
                nodeId: 'main_node_1',
              },
              text: 'WrongPwd_123',
            },
          },
        ],
      },
      { done: true, toolCalls: [] },
    ],
    grant: (call, { latestSnapshotId }) => {
      const target = call.args?.target;
      if (target && target.snapshotId !== latestSnapshotId) {
        throw Object.assign(new Error('stale'), {
          code: 'VERSION_CONFLICT',
          denial: { role: 'password', name: '请输入密码' },
        });
      }
      return { step: { id: randomUUID() } };
    },
    executeTool: (call, { first: initial, refreshed: fresh }) => {
      if (call.name === 'navigate')
        return { status: 'succeeded', reasonCode: null, data: initial };
      if (call.name === 'observe')
        return { status: 'succeeded', reasonCode: null, data: fresh };
      if (call.name === 'type_text') {
        typed.push({ nodeId: call.args.target.nodeId, text: call.args.text });
        return {
          status: 'succeeded',
          reasonCode: null,
          data:
            call.args.target.nodeId === 'main_node_0'
              ? afterAccount
              : afterPassword,
        };
      }
      return { status: 'failed', reasonCode: 'TARGET_NOT_FOUND', data: null };
    },
  });
  // The stale attempt was refused before the browser; the retry after the
  // platform's automatic observe reached the password field.
  assert.deepEqual(typed, [
    { nodeId: 'main_node_0', text: 'WrongUser_123' },
    { nodeId: 'main_node_1', text: 'WrongPwd_123' },
  ]);
  assert.deepEqual(
    records.map((record) => record.status),
    ['succeeded', 'succeeded', 'succeeded', 'succeeded'],
  );
  const settled = finishes.at(-1);
  assert.equal(settled.modelActionDenials, 1);
  assert.deepEqual(settled.modelActionDenialReasons, {
    VERSION_CONFLICT: 1,
  });
  assert.deepEqual(settled.grantDenials, [
    {
      tool: 'type_text',
      reasonCode: 'VERSION_CONFLICT',
      role: 'password',
      name: '请输入密码',
    },
  ]);
  const persisted = JSON.stringify(settled);
  assert.equal(persisted.includes('WrongPwd_123'), false);
  assert.equal(persisted.includes('WrongUser_123'), false);
  const third = text(modelPayloads[2]);
  assert.match(third, /VERSION_CONFLICT/);
  assert.match(third, new RegExp(refreshed.snapshotId));
});

test('an out-of-scope refusal is explained and the case continues', async () => {
  const afterAccount = snapshot(3, 'main_node_0');
  const typed = [];
  const { records, finishes, modelPayloads } = await runExplorer({
    decisions: ({ first }) => [
      {
        done: false,
        toolCalls: [
          {
            name: 'press',
            args: {
              target: {
                snapshotId: first.snapshotId,
                pageId: first.pageId,
                nodeId: 'main_node_0',
              },
              key: 'Enter',
            },
          },
        ],
      },
      {
        done: false,
        toolCalls: [
          {
            name: 'type_text',
            args: {
              target: {
                snapshotId: first.snapshotId,
                pageId: first.pageId,
                nodeId: 'main_node_0',
              },
              text: 'WrongUser_123',
            },
          },
        ],
      },
      { done: true, toolCalls: [] },
    ],
    grant: (call, { latestSnapshotId }) => {
      if (call.name === 'press' && call.args.key === 'Enter')
        throw Object.assign(new Error('denied'), {
          code: 'OUT_OF_SCOPE_MUTATION',
          denial: {
            role: 'text',
            name: '请输入账号',
            enterButton: { role: 'button', name: '保存' },
          },
        });
      const target = call.args?.target;
      if (target && target.snapshotId !== latestSnapshotId)
        throw Object.assign(new Error('stale'), { code: 'VERSION_CONFLICT' });
      return { step: { id: randomUUID() } };
    },
    executeTool: (call, { first: initial }) => {
      if (call.name === 'navigate')
        return { status: 'succeeded', reasonCode: null, data: initial };
      if (call.name === 'type_text') {
        typed.push(call.args.text);
        return { status: 'succeeded', reasonCode: null, data: afterAccount };
      }
      return { status: 'succeeded', reasonCode: null, data: initial };
    },
  });
  // The refusal is reported, not fatal: the next round still typed.
  assert.deepEqual(typed, ['WrongUser_123']);
  assert.deepEqual(
    records.map((record) => record.status),
    ['succeeded', 'succeeded'],
  );
  const settled = finishes.at(-1);
  assert.equal(settled.stage, 'explore');
  assert.equal(settled.modelActionDenials, 1);
  assert.deepEqual(settled.modelActionDenialReasons, {
    OUT_OF_SCOPE_MUTATION: 1,
  });
  assert.deepEqual(settled.grantDenials, [
    {
      tool: 'press',
      reasonCode: 'OUT_OF_SCOPE_MUTATION',
      role: 'text',
      name: '请输入账号',
      enterButton: { role: 'button', name: '保存' },
    },
  ]);
  assert.equal(JSON.stringify(settled).includes('WrongUser_123'), false);
  assert.match(text(modelPayloads[1]), /回车只在它等效的按钮可点时放行/);
});
