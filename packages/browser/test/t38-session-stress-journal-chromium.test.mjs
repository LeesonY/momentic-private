/* global window */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BrowserManager,
  inspectActionAudit,
  resolveTarget,
  SessionRecorder,
} from '../dist/index.js';

const identity = () => ({
  projectId: randomUUID(),
  runId: randomUUID(),
  taskId: randomUUID(),
  mode: 'full',
});
const click = (snapshot) => ({
  name: 'click',
  args: {
    target: {
      snapshotId: snapshot.snapshotId,
      pageId: snapshot.pageId,
      nodeId: 'testid_confirm',
    },
  },
});

test('T38 120 session snapshots retain bounded grants and 700 page errors cannot grow console buffers unbounded', async () => {
  const manager = new BrowserManager();
  const session = await manager.createSession(identity());
  try {
    const page = session.getPage();
    await page.setContent('<button data-testid="confirm">Confirm</button>');
    const previous = [];
    for (let i = 0; i < 120; i++)
      previous.push(await session.getSnapshot({ forceFresh: true }));
    const old = previous[0];
    const denial = await resolveTarget(
      page,
      {
        snapshotId: old.snapshotId,
        pageId: old.pageId,
        nodeId: 'testid_confirm',
      },
      old,
    );
    assert.equal(denial.status, 'rejected');
    assert.equal(denial.reasonCode, 'VERSION_CONFLICT');
    const latest = previous.at(-1);
    assert.equal(
      (
        await resolveTarget(
          page,
          {
            snapshotId: latest.snapshotId,
            pageId: latest.pageId,
            nodeId: 'testid_confirm',
          },
          latest,
        )
      ).status,
      'resolved',
    );
    for (let i = 0; i < 700; i++)
      page.emit('pageerror', new Error(`sensitive-unstored-payload-${i}`));
    const recorder = session.recorder;
    assert.ok(recorder.getRawConsole().length <= 500);
    assert.ok(recorder.getSnapshotSummaries().degraded);
  } finally {
    await session.close();
    await manager.close();
  }
});

test('T38 three parallel sessions have independent action grants, DOM state and durable scrubbed audit files', async () => {
  const manager = new BrowserManager();
  const root = mkdtempSync(join(tmpdir(), 'localqa-t38-'));
  const sessions = [];
  try {
    for (let i = 0; i < 3; i++) {
      const session = await manager.createSession({
        ...identity(),
        artifactsDir: join(root, `s${i}`),
      });
      sessions.push(session);
      await session.getPage()
        .setContent(`<button data-testid="confirm">Confirm</button>
        <script>window.hitCount=0;document.querySelector('button').onclick=()=>{window.hitCount++;}</script>`);
    }
    const snapshots = await Promise.all(
      sessions.map((session) => session.getSnapshot({ forceFresh: true })),
    );
    const foreign = await sessions[1].executeTool(click(snapshots[0]));
    assert.equal(foreign.status, 'failed');
    assert.equal(
      await sessions[1].getPage().evaluate(() => window.hitCount),
      0,
    );
    const results = await Promise.all(
      sessions.map((s, i) => s.executeTool(click(snapshots[i]))),
    );
    assert.ok(
      results.every((r) => r.status === 'succeeded'),
      JSON.stringify(
        results.map((r) => ({ status: r.status, reasonCode: r.reasonCode })),
      ),
    );
    assert.deepEqual(
      await Promise.all(
        sessions.map((s) => s.getPage().evaluate(() => window.hitCount)),
      ),
      [1, 1, 1],
    );
    const auditFiles = sessions.map((_s, i) =>
      join(
        root,
        `s${i}`,
        readdirSync(join(root, `s${i}`)).find((name) =>
          name.startsWith('action-audit-'),
        ),
      ),
    );
    assert.equal(new Set(auditFiles).size, 3);
    for (let i = 0; i < 3; i++) {
      const records = inspectActionAudit(auditFiles[i]);
      assert.equal(
        records.filter((row) => row.outcome === 'succeeded').length,
        1,
      );
      assert.equal(
        records.filter((row) => row.status === 'outcome_unknown').length,
        0,
      );
      const raw = readFileSync(auditFiles[i], 'utf8');
      for (const forbidden of [
        'data-testid',
        'Confirm</button>',
        'token=',
        'sensitive-unstored-payload',
      ])
        assert.equal(raw.includes(forbidden), false);
    }
  } finally {
    await Promise.allSettled(sessions.map((s) => s.close()));
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('T38 post-dispatch cancellation survives session close as ambiguous write, orphan intent requires review not replay', async () => {
  const manager = new BrowserManager();
  const root = mkdtempSync(join(tmpdir(), 'localqa-t38-audit-'));
  const ctrl = new AbortController();
  let session;
  try {
    session = await manager.createSession({
      ...identity(),
      artifactsDir: root,
    });
    const page = session.getPage();
    await page.exposeFunction('t38Stop', () => ctrl.abort());
    await page.setContent(`<button data-testid="confirm">Confirm</button>
      <script>window.hitCount=0;document.querySelector('button').onclick=()=>{
        window.hitCount++; window.t38Stop();
      };</script>`);
    const snapshot = await session.getSnapshot({ forceFresh: true });
    const result = await session.executeTool(click(snapshot), {
      signal: ctrl.signal,
    });
    assert.equal(result.status, 'cancelled', result.reasonCode);
    assert.ok(result.actionId);
    assert.equal(await page.evaluate(() => window.hitCount), 1);
    await session.close();
    const file = join(
      root,
      readdirSync(root).find((name) => name.startsWith('action-audit-')),
    );
    const recovered = inspectActionAudit(file);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'settled');
    assert.equal(recovered[0].outcome, 'cancelled');
    assert.equal(recovered[0].actionId, result.actionId);
    assert.equal(recovered[0].requiresReview, true);
    // Simulate a process terminated after fsync(intent) but before result.
    const intent = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]);
    appendFileSync(
      file,
      JSON.stringify({
        ...intent,
        attemptId: randomUUID(),
        phase: 'intent',
        actionId: null,
        outcome: null,
      }) + '\n',
    );
    const afterCrash = inspectActionAudit(file);
    assert.equal(afterCrash.length, 2);
    assert.equal(afterCrash.at(-1).requiresReview, true);
    assert.equal(
      afterCrash.filter((item) => item.status === 'outcome_unknown').length,
      1,
    );
  } finally {
    await session?.close();
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('T38 failed durable intent writes block browser mutation; lost settlement leaves UNKNOWN despite a click side effect', async () => {
  const manager = new BrowserManager();
  const root = mkdtempSync(join(tmpdir(), 'localqa-t38-writefail-'));
  let session;
  try {
    session = await manager.createSession({
      ...identity(),
      artifactsDir: root,
    });
    const page = session.getPage();
    await page.setContent(`<button data-testid="confirm">Confirm</button>
      <script>window.hitCount=0;document.querySelector('button').onclick=()=>{window.hitCount++;}</script>`);
    const intentRecorder = session.recorder.recordActionAudit.bind(
      session.recorder,
    );
    session.recorder.recordActionAudit = () => {
      throw new Error('TEST_DISK_UNAVAILABLE');
    };
    const initial = await session.getSnapshot({ forceFresh: true });
    await assert.rejects(
      () => session.executeTool(click(initial)),
      /TEST_DISK_UNAVAILABLE/,
    );
    assert.equal(await page.evaluate(() => window.hitCount), 0);
    session.recorder.recordActionAudit = (entry) => {
      if (entry.phase === 'settlement')
        throw new Error('TEST_SETTLEMENT_DISK_FAILURE');
      return intentRecorder(entry);
    };
    await assert.rejects(
      () => session.executeTool(click(initial)),
      /TEST_SETTLEMENT_DISK_FAILURE/,
    );
    assert.equal(await page.evaluate(() => window.hitCount), 1);
    const file = join(
      root,
      readdirSync(root).find((name) => name.startsWith('action-audit-')),
    );
    const result = inspectActionAudit(file);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'outcome_unknown');
    assert.equal(result[0].outcome, null);
    assert.equal(result[0].requiresReview, true);
    // Explicit review is needed: a new attempt would need a new approval.
    assert.equal(await page.evaluate(() => window.hitCount), 1);
  } finally {
    await session?.close();
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('T38 audit writer denies invented tool metadata and redacts unsafe reason messages before writing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'localqa-t38-scrub-'));
  try {
    const recorder = new SessionRecorder({
      ...identity(),
      artifactsDir: directory,
    });
    assert.throws(
      () =>
        recorder.recordActionAudit({
          attemptId: randomUUID(),
          tool: 'secret_password_value',
          phase: 'intent',
        }),
      /ACTION_AUDIT_INVALID_METADATA/,
    );
    const sentinel = 'SECRET_SENTINEL_DO_NOT_PERSIST';
    recorder.recordActionAudit({
      attemptId: randomUUID(),
      tool: 'click',
      phase: 'intent',
      reasonCode: sentinel + '=sensitive',
    });
    const raw = readFileSync(recorder.getActionAuditPath(), 'utf8');
    assert.equal(raw.includes(sentinel), false);
    assert.equal(raw.includes('UNRECOGNIZED_REASON'), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
