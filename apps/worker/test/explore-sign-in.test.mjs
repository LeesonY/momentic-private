// Pure Node: an exploration that cannot sign in must not fail the session. The
// explorer signs in inside its own browser (so the main AI sees the signed-in
// pages at all); when that fails — here because the exclusive account is busy —
// the task ends with a warning that names the reason, and the session goes on so
// the main AI can ask the user or explore elsewhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageError } from '@localqa/storage';
import { BrowserManager, BrowserSessionImpl } from '@localqa/browser';
import { Worker } from '../dist/index.js';

/** A BrowserSessionImpl over EventEmitter fakes: no Chromium is launched. */
function fakeSession(ids) {
  const page = new EventEmitter();
  const context = new EventEmitter();
  context.close = async () => {};
  return new BrowserSessionImpl(
    randomUUID(),
    { projectId: ids.project, runId: ids.run, taskId: ids.task },
    context,
    page,
    randomUUID(),
  );
}

async function runExplorer(allocate) {
  const ids = {
    project: randomUUID(),
    run: randomUUID(),
    task: randomUUID(),
    context: randomUUID(),
  };
  const scratch = mkdtempSync(join(tmpdir(), 'localqa-explore-signin-'));
  const finishes = [];
  const stops = [];
  const session = fakeSession(ids);
  const browser = new BrowserManager();
  let created = 0;
  browser.createSession = async () => {
    created += 1;
    return session;
  };
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
        signIn: true,
        targetUrl: 'http://fixture.local/',
        contextId: ids.context,
        run: {
          projectId: ids.project,
          id: ids.run,
          executionMode: 'smoke',
          effectiveConfig: {
            authProfileVersion: 1,
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
    async authProfile() {
      return {
        id: randomUUID(),
        projectId: ids.project,
        environmentId: null,
        name: 'fixture',
        mode: 'agent',
        agentConfig: {
          loginUrl: 'http://fixture.local/login',
          instructions: '登录',
          variables: [{ name: 'USERNAME', sensitive: false }],
        },
        allowedOrigins: ['http://fixture.local'],
        sharingPolicy: 'exclusive_run',
        hasSecret: true,
        version: 1,
        status: 'active',
        formConfig: null,
      };
    },
    async allocateAuthSession() {
      return allocate();
    },
    async model() {
      return { requestResult: 'ok', data: { done: true, toolCalls: [] } };
    },
    async grant() {
      return { step: { id: randomUUID() } };
    },
    async record() {},
    async finish(proof, result) {
      finishes.push(result);
    },
    async stop(reason) {
      stops.push(reason);
    },
    async heartbeat() {
      return { contextVersion: 1, cancellationRequested: false };
    },
  };
  try {
    const worker = new Worker({
      runtime,
      browser,
      scratch,
      heartbeatMs: 10000,
    });
    const handled = await worker.once();
    return { handled, finishes, stops, created, session };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('a failed exploration sign-in ends with a warning instead of failing the session', async () => {
  const result = await runExplorer(() => {
    // The exclusive account is held by another running task.
    throw new StorageError('RATE_LIMITED');
  });
  assert.equal(result.handled, true, 'the task settled');
  assert.deepEqual(result.stops, [], 'the run was not terminated');
  assert.equal(result.finishes.length, 1);
  const finished = result.finishes[0];
  assert.equal(finished.stage, 'explore');
  assert.deepEqual(finished.pages, []);
  assert.equal(finished.coverage, 'Not explored');
  assert.equal(finished.warnings.length, 1);
  assert.match(finished.warnings[0], /登录未成功/);
  assert.match(finished.warnings[0], /账号被同一运行或其他运行的任务占用/);
});

test('the explorer really signs in inside its own browser context', async () => {
  let allocated = 0;
  const result = await runExplorer(() => {
    allocated += 1;
    // Stop right after the allocation: this test only proves the explorer walks
    // the private sign-in path at all (the flow itself is covered elsewhere).
    throw new StorageError('AUTH_FAILED');
  });
  assert.equal(result.created, 1, 'a browser context was created for it');
  assert.equal(allocated, 1, 'it asked for a private auth session');
  assert.equal(result.handled, true);
  assert.match(result.finishes[0].warnings[0], /登录未成功/);
});
