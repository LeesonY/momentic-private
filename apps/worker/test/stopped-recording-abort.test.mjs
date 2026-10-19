import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseContract } from '@localqa/contracts';
import { DomainError } from '@localqa/domain';
import { Worker } from '../dist/index.js';

const recording = {
  events: [
    {
      type: 4,
      data: { href: 'http://fixture.local/home' },
      timestamp: 1_700_000_000_000,
    },
  ],
  consoleEntries: [
    {
      at: '2026-10-18T06:53:00.000Z',
      level: 'log',
      source: 'console',
      text: 'console marker',
    },
  ],
  networkEntries: [
    {
      at: '2026-10-18T06:53:00.000Z',
      method: 'GET',
      url: 'http://fixture.local/home',
      resourceType: 'document',
      status: 200,
      failed: false,
      durationMs: 5,
    },
  ],
  status: 'recording',
  error: null,
  notes: [],
  startedAt: '2026-10-18T06:53:00.000Z',
  endedAt: '2026-10-18T06:53:01.000Z',
  viewport: { width: 1280, height: 720 },
};

async function runAbort({ flushNever = false } = {}) {
  const ids = {
    project: randomUUID(),
    run: randomUUID(),
    task: randomUUID(),
    context: randomUUID(),
    case: randomUUID(),
  };
  const scratch = mkdtempSync(join(tmpdir(), 'localqa-stopped-abort-'));
  const order = [];
  const uploads = [];
  const stopped = [];
  let abortController;
  const definition = parseContract('CaseDefinition', {
    id: ids.case,
    runId: ids.run,
    projectId: ids.project,
    version: 1,
    title: 'Stopped recording case',
    summary: 'Stop while the browser is working',
    preconditions: [],
    outline: ['open'],
    criteria: [
      {
        id: 'home_visible',
        kind: 'semantic',
        description: '首页可见',
        sourceKind: 'inferred',
        sourceRef: 'observation:1',
      },
    ],
  });
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
      order.push('work');
      return {
        stage: 'execute',
        task: { id: ids.task, role: 'executor' },
        targetUrl: 'http://fixture.local/home',
        contextId: ids.context,
        definition,
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
      throw new Error('model must not be called after abort');
    },
    async grant() {
      return { step: { id: randomUUID(), seq: 1 } };
    },
    async record() {},
    async upload(_proof, artifact) {
      uploads.push(artifact);
      return artifact;
    },
    async finish() {
      throw new Error('finish must not be called after abort');
    },
    async stop() {
      order.push('stop');
    },
    async saveStoppedRecording(_proof, artifacts, taskRecording) {
      order.push('saveStopped');
      stopped.push({ artifacts, taskRecording });
    },
    async heartbeat() {
      return { contextVersion: 1, cancelRequested: false };
    },
  };
  const browser = {
    async createSession() {
      order.push('createSession');
      return {
        id: ids.context,
        activePageId: '22222222-2222-4222-8222-222222222222',
        isClosed: false,
        getPageById() {
          return undefined;
        },
        async executeTool(_call, options) {
          order.push('execute');
          return new Promise((resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => {
                order.push('abort');
                reject(new DomainError('CANCELLED'));
              },
              { once: true },
            );
            setTimeout(() => abortController.abort(), 10);
          });
        },
        async cancel() {
          order.push('cancel');
        },
        async flushRecording() {
          order.push('flush');
          if (flushNever) return new Promise(() => {});
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        getRecording() {
          order.push('getRecording');
          return recording;
        },
        async close() {
          order.push('close');
          this.isClosed = true;
        },
      };
    },
  };
  abortController = new AbortController();
  const worker = new Worker({
    runtime,
    browser,
    scratch,
    heartbeatMs: 10_000,
  });
  try {
    await worker.once(abortController.signal);
    return { order, uploads, stopped };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('abort flushes the browser recording before closing and saves it', async () => {
  const { order, uploads, stopped } = await runAbort();
  assert.equal(uploads.length, 0, 'the live-lease upload path is not used');
  assert.equal(stopped.length, 1);
  assert.equal(order.includes('stop'), true);
  assert.equal(order.includes('cancel'), true);
  assert.ok(order.indexOf('cancel') < order.indexOf('flush'));
  assert.ok(order.indexOf('stop') < order.indexOf('flush'));
  assert.ok(order.indexOf('flush') < order.indexOf('saveStopped'));
  assert.ok(order.indexOf('saveStopped') < order.indexOf('close'));
  assert.deepEqual(
    stopped[0].artifacts.map(({ artifact }) => artifact.kind).sort(),
    ['console', 'network', 'rrweb'],
  );
  assert.equal(stopped[0].taskRecording.status, 'degraded');
  assert.match(
    stopped[0].taskRecording.error,
    /任务被中止（CANCELLED），录像只到中止时刻/,
  );
});

test('a stuck flush still saves the events already returned to Node', async () => {
  const started = Date.now();
  const { order, stopped } = await runAbort({ flushNever: true });
  assert.ok(Date.now() - started >= 1900);
  assert.equal(stopped.length, 1);
  assert.equal(order.includes('getRecording'), true);
  assert.ok(order.indexOf('getRecording') < order.indexOf('saveStopped'));
  assert.ok(order.indexOf('saveStopped') < order.indexOf('close'));
  assert.equal(stopped[0].taskRecording.status, 'degraded');
  assert.equal(stopped[0].artifacts.length, 3);
});
