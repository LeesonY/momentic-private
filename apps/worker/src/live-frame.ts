import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserSession } from '@localqa/browser';

// Ephemeral, non-evidence frames. Never published for credentialed or
// write-authorized tasks. Untrusted page pixels are NOT fully redacted,
// so only the no-auth/non-submitting browser lane may opt in.
const ROOT = join(process.env.DATA_DIR ?? '/var/localqa/data', 'live-frames');
const MAX_BYTES = 250_000;
const FRAME_PERIOD_MS = 750;

export interface LiveFrameCapture {
  stop(): Promise<void>;
}

export function startLiveFrameCapture(
  session: BrowserSession,
  input: {
    taskId: string;
    runId: string;
    projectId: string;
    fencingToken: number;
  },
): LiveFrameCapture {
  const { taskId, runId, projectId, fencingToken } = input;
  if (
    ![taskId, runId, projectId].every((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
    )
  )
    throw new Error('LIVE_FRAME_INVALID_ID');
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1)
    throw new Error('LIVE_FRAME_INVALID_FENCE');
  let stopped = false,
    busy = false;
  let sequence = 0;
  let current: Promise<void> | null = null;
  // Fence the filename too: an expired Worker must never unlink or overwrite
  // its replacement Worker's frames for the same task.
  const filename = join(ROOT, `${taskId}.${fencingToken}.jpg`);
  const attempt = async () => {
    if (stopped || busy || session.isClosed) return;
    busy = true;
    const frameSeq = ++sequence;
    const temp = join(ROOT, `${taskId}.${fencingToken}.${frameSeq}.tmp`);
    try {
      await mkdir(ROOT, { recursive: true, mode: 0o700 });
      // Browser may navigate or close during capture. Never block the tested
      // action or propagate live telemetry failure into a regression verdict.
      const page = session.getPageById?.(session.activePageId);
      if (!page) return;
      const image = await page.screenshot({
        type: 'jpeg',
        quality: 55,
        fullPage: false,
        animations: 'disabled',
        caret: 'hide',
        timeout: 1800,
        mask: [
          page.locator('input'),
          page.locator('textarea'),
          page.locator('[contenteditable]'),
          page.locator('[data-sensitive]'),
          page.locator('[data-private]'),
          page.locator('[autocomplete]'),
        ],
        maskColor: '#555555',
      });
      if (
        stopped ||
        session.isClosed ||
        image.length > MAX_BYTES ||
        image.length < 100
      )
        return;
      const digest = createHash('sha256').update(image).digest('hex');
      // Header binds each frame to the exact leased task and project.
      // Atomic rename means readers never see partial files.
      const header = Buffer.from(
        JSON.stringify({
          schema: 1,
          taskId,
          runId,
          projectId,
          fencingToken,
          capturedAt: Date.now(),
          sequence: frameSeq,
          sha256: digest,
        }) + '\n',
      );
      if (header.length > 1024) return;
      await writeFile(temp, Buffer.concat([header, image]), {
        mode: 0o600,
        flag: 'wx',
      });
      if (!stopped) await rename(temp, filename);
    } catch {
      // Browser teardown, missing volume, or screenshot privacy mask failure
      // makes the frame unavailable; it never authorizes an action.
    } finally {
      await unlink(temp).catch(() => {});
      busy = false;
    }
  };
  const timer = setInterval(() => {
    if (!stopped && !busy) current = attempt();
  }, FRAME_PERIOD_MS);
  timer.unref();
  current = attempt();
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await current?.catch(() => {});
      await unlink(filename).catch(() => {});
    },
  };
}
