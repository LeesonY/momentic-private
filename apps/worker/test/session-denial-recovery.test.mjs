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

test('a version conflict refreshes the observation and tells the model why', async () => {
  const ids = {
    project: randomUUID(),
    run: randomUUID(),
    task: randomUUID(),
    context: randomUUID(),
  };
  const scratch = mkdtempSync(join(tmpdir(), 'localqa-denial-recovery-'));
  const first = snapshot(1, 'main_node_0');
  const refreshed = snapshot(2, 'main_node_0');
  const modelPayloads = [];
  const records = [];
  let decisions = 0;
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
      decisions += 1;
      if (decisions === 1)
        return {
          requestResult: 'ok',
          data: {
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
        };
      return { requestResult: 'ok', data: { done: true, toolCalls: [] } };
    },
    async grant() {
      return { step: { id: randomUUID() } };
    },
    async record(_proof, _grant, status) {
      records.push(status);
    },
    async finish(_proof, result) {
      records.push(result);
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
        async executeTool(call) {
          if (call.name === 'navigate')
            return { status: 'succeeded', reasonCode: null, data: first };
          if (call.name === 'observe')
            return { status: 'succeeded', reasonCode: null, data: refreshed };
          if (call.name === 'type_text')
            return {
              status: 'failed',
              reasonCode: 'VERSION_CONFLICT',
              data: first,
            };
          return { status: 'failed', reasonCode: 'TARGET_NOT_FOUND', data: null };
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
    // The failed action is settled, then the platform re-observes so the next
    // decision starts from a snapshot the action ledger will accept.
    assert.deepEqual(records.slice(0, 3), ['succeeded', 'failed', 'succeeded']);
    const settled = records.at(-1);
    assert.equal(settled.stage, 'explore');
    assert.equal(settled.modelActionDenials, 1);
    assert.equal(decisions, 2);
    const second = modelPayloads[1];
    const text = second.messages
      .flatMap((message) => message.content.map((part) => part.text ?? ''))
      .join('\n');
    assert.match(text, /VERSION_CONFLICT/);
    assert.match(text, /不要重复提交同一个目标/);
    assert.match(text, new RegExp(refreshed.snapshotId));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
