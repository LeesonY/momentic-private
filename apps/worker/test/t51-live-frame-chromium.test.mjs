import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrowserManager } from '@localqa/browser';
import { startLiveFrameCapture } from '../dist/live-frame.js';

const dataRoot = process.env.DATA_DIR ?? '/var/localqa/data';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test('T51 live capture: changing actual Chromium frames, bound hash, expiry and cleanup', async () => {
  const manager = new BrowserManager();
  const runId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  const file = join(dataRoot, 'live-frames', `${taskId}.19.jpg`);
  let session, handle;
  try {
    session = await manager.createSession({
      projectId,
      runId,
      taskId,
      mode: 'non_submitting',
    });
    const page = session.getPage();
    await page.setContent(`<!doctype html><h1 id="clock">0</h1><input type="password" value="PRIVATE_SECRET"/>
       <script>let ticks=0;setInterval(()=>document.querySelector('#clock').textContent=String(++ticks),300)</script>`);
    handle = startLiveFrameCapture(session, {
      projectId,
      runId,
      taskId,
      fencingToken: 19,
    });
    const frames = new Map();
    for (let i = 0; i < 11; i++) {
      await pause(450);
      let bytes;
      try {
        bytes = await readFile(file);
      } catch {
        continue;
      }
      const end = bytes.indexOf(10);
      assert.ok(end > 10 && end < 1024);
      const meta = JSON.parse(bytes.subarray(0, end).toString());
      const jpeg = bytes.subarray(end + 1);
      assert.equal(meta.projectId, projectId);
      assert.equal(meta.runId, runId);
      assert.equal(meta.taskId, taskId);
      assert.equal(meta.fencingToken, 19);
      assert.ok(
        meta.capturedAt <= Date.now() && Date.now() - meta.capturedAt < 2600,
      );
      assert.equal(
        meta.sha256,
        createHash('sha256').update(jpeg).digest('hex'),
      );
      assert.equal(jpeg[0], 0xff);
      assert.equal(jpeg[1], 0xd8);
      frames.set(meta.sequence, meta.sha256);
    }
    assert.ok(
      frames.size >= 3,
      'should capture multiple sequential browser frames',
    );
    assert.ok(
      new Set(frames.values()).size >= 2,
      'browser actually changed, not replayed still',
    );
    console.log(
      'T51_LIVE_CAPTURE',
      JSON.stringify({
        frames: frames.size,
        distinctFrames: new Set(frames.values()).size,
      }),
    );
  } finally {
    await handle?.stop();
    await session?.close();
    await manager.close();
  }
  await assert.rejects(
    access(file),
    'live frame must be deleted after browser closes',
  );
});
test('T54 stale Worker teardown cannot remove replacement lease frames', async () => {
  const manager = new BrowserManager();
  const runId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const oldFile = join(dataRoot, 'live-frames', `${taskId}.41.jpg`);
  const freshFile = join(dataRoot, 'live-frames', `${taskId}.42.jpg`);
  const waitForFrame = async (file, fence) => {
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const bytes = await readFile(file);
        const end = bytes.indexOf(10);
        const head = JSON.parse(bytes.subarray(0, end).toString());
        assert.equal(head.fencingToken, fence);
        assert.equal(head.taskId, taskId);
        return bytes;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await pause(250);
      }
    }
    assert.fail(`No live frame for lease ${fence}`);
  };
  let session, previous, replacement;
  try {
    session = await manager.createSession({
      projectId, runId, taskId, mode: 'non_submitting',
    });
    await session.getPage().setContent('<main>Fenced lease capture</main>');
    previous = startLiveFrameCapture(session, {
      projectId, runId, taskId, fencingToken: 41,
    });
    await waitForFrame(oldFile, 41);
    replacement = startLiveFrameCapture(session, {
      projectId, runId, taskId, fencingToken: 42,
    });
    await waitForFrame(freshFile, 42);
    await previous.stop();
    await assert.rejects(access(oldFile));
    await waitForFrame(freshFile, 42);
    await replacement.stop();
    await assert.rejects(access(freshFile));
  } finally {
    await Promise.allSettled([previous?.stop(), replacement?.stop()]);
    await session?.close();
    await manager.close();
  }
});
