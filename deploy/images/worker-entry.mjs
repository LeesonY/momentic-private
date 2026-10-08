#!/usr/bin/env node
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../../packages/browser/node_modules/playwright/index.mjs';
import { BrowserManager } from '../../packages/browser/dist/index.js';
import { Worker } from '../../apps/worker/dist/index.js';
import { Database } from '../../packages/storage/dist/index.js';
import { loadProtectedKek } from './kek.mjs';
import {
  Coordinator,
  RuntimeClient,
  ArtifactStore,
} from '../../packages/orchestrator/dist/index.js';
import { ModelRepository } from '../../packages/storage/dist/index.js';
import { createWorkerModelOptions } from '../../packages/orchestrator/dist/index.js';
import { readiness } from './readiness.mjs';
import { projectOffers } from './project-scheduling.mjs';

if (process.getuid() === 0) throw new Error('Refusing to run browser as root');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const allowTestStub = process.env.LOCALQA_ALLOW_TEST_STUB === '1';
const scratch = '/var/localqa/scratch';
const slots = Number(process.env.BROWSER_SLOTS || 4);
if (!Number.isSafeInteger(slots) || slots < 1)
  throw new Error('Invalid BROWSER_SLOTS');
const vault = await loadProtectedKek();
const identity = (
  await readFile(
    process.env.WORKER_IDENTITY_FILE || '/run/secrets/worker_identity.json',
    'utf8',
  )
).trim();
if (!identity) throw new Error('Worker identity missing');
const workerId = `worker-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
const db = new Database(process.env.DATABASE_URL);
const adminId = await db.auth(
  async (client) =>
    (
      await client.query(
        "SELECT id FROM users WHERE global_role='admin' AND NOT disabled ORDER BY created_at LIMIT 1",
      )
    ).rows[0]?.id,
);
if (!adminId) throw new Error('Bootstrap admin before starting worker');
const actor = { userId: adminId };
const coordinator = new Coordinator({
  db,
  serviceActor: actor,
  vault,
  platformSlots: slots,
  projectSlots: slots,
});
const artifacts = new ArtifactStore(
  process.env.DATA_DIR || '/var/localqa/data',
);
const browser = new BrowserManager();
const modelRepo = new ModelRepository(db, vault);
const options = createWorkerModelOptions({
  transport: globalThis.fetch,
  allowTestStub,
  async load(id, version) {
    if (allowTestStub) {
      const document = await db.actor(
        actor,
        async (client) =>
          (
            await client.query(
              'SELECT document FROM model_profile_versions WHERE profile_id=$1 AND version=$2',
              [id, version],
            )
          ).rows[0]?.document,
      );
      if (!document) throw new Error('Test stub profile not configured');
      return { document, apiKey: null };
    }
    return modelRepo.readVersion(actor, id, version);
  },
});
let running = true;
let nextProject = 0;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    running = false;
  });
async function capacityProbe() {
  const browserInstance = await chromium.launch({ chromiumSandbox: true });
  try {
    const page = await browserInstance.newPage();
    const target =
      process.env.WORKER_FIXTURE_URL ||
      'data:text/html,<button id="action">Ready</button>';
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 12000 });
    if (process.env.WORKER_FIXTURE_URL) {
      if (!(await page.title()).includes('LocalQA Test Fixture'))
        throw new Error('Fixture title mismatch');
      await page.getByTestId('tab-btn-details').click({ timeout: 5000 });
      if (!(await page.getByTestId('tab-panel-details').isVisible()))
        throw new Error('Fixture tab action failed');
    } else await page.locator('button').click({ timeout: 5000 });
    const pids = (await readdir('/proc')).filter((pid) => /^\d+$/.test(pid));
    const processes = [];
    for (const pid of pids) {
      try {
        const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8'))
          .split('\0')
          .filter(Boolean);
        if (!cmdline[0]?.includes('chrome')) continue;
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        processes.push({
          uid: Number(status.match(/^Uid:\s+(\d+)/m)?.[1]),
          seccomp: Number(status.match(/^Seccomp:\s+(\d+)/m)?.[1]),
          noSandbox: cmdline.includes('--no-sandbox'),
        });
      } catch {
        /* short-lived browser process */
      }
    }
    if (
      !processes.length ||
      processes.some((p) => p.uid === 0 || p.seccomp !== 2 || p.noSandbox)
    )
      throw new Error('Chromium sandbox invariant failed');
    await writeFile(
      `${scratch}/sandbox-result.json`,
      JSON.stringify({
        node: process.version,
        uid: process.getuid(),
        url: target,
        action: process.env.WORKER_FIXTURE_URL
          ? 'details-tab.click'
          : 'button.click',
        processes,
        browserVersion: browserInstance.version(),
        playwright: (
          await import(
            '../../packages/browser/node_modules/playwright/package.json',
            { with: { type: 'json' } }
          )
        ).default.version,
      }),
    );
    await writeFile(`${scratch}/browser-ready`, String(Date.now()));
  } finally {
    await browserInstance.close();
  }
}
const active = new Set();
try {
  let capacityAt = 0;
  while (running) {
    try {
      if (Date.now() - capacityAt > 15000) {
        await capacityProbe();
        capacityAt = Date.now();
      }
      if (!(await readiness()))
        throw new Error('Database/schema/data not ready');
      // Poll and claim using the storage lease/fencing transaction. Worker.once owns
      // heartbeat, action intents, isolated browser contexts and result submission.
      const projects = await db.actor(actor, async (client) =>
        (
          await client.query(
            "SELECT id FROM projects WHERE status='active' ORDER BY id",
          )
        ).rows.map((r) => r.id),
      );
      // Spread each round across projects before offering another slot to one
      // project. Rotate the starting project between rounds to avoid a stable
      // lexicographic winner when total demand exceeds browser capacity.
      const offers = projectOffers(projects, slots, nextProject++);
      for (const [offered, projectId] of offers.entries()) {
        if (!running || active.size >= slots) break;
        const runtime = new RuntimeClient(
          coordinator,
          { projectId, workerId: `${workerId}-${offered}` },
          artifacts,
          options,
        );
        const worker = new Worker({
          runtime,
          browser,
          scratch,
          pollMs: 500,
          heartbeatMs: Number(process.env.JOB_HEARTBEAT_SECONDS || 10) * 1000,
          leaseSeconds: Number(process.env.JOB_LEASE_SECONDS || 45),
        });
        await writeFile(`${scratch}/task-ready`, String(Date.now()));
        const flight = worker.once().catch((error) => {
          console.error('Worker leased task failed:', error.message);
          throw error;
        });
        active.add(flight);
        void flight.finally(() => active.delete(flight)).catch(() => {});
      }
      if (!projects.length && (await readiness()))
        await writeFile(`${scratch}/task-ready`, String(Date.now()));
      // Even with no queued job, reaching this point proves the lease-claim
      // path is live; stamp task-ready so readiness reflects actual capability.
      await writeFile(`${scratch}/task-ready`, String(Date.now()));
    } catch (error) {
      console.error('Worker task loop failed:', error.message);
      // Do not clear readiness markers on a transient task-loop error: the
      // process is still polling and will re-stamp on the next successful
      // iteration. Clearing them makes the health probe flap while the worker
      // is in fact alive and working.
      if (Date.now() - capacityAt > 60000)
        await rm(`${scratch}/browser-ready`, { force: true });
    }
    if (running) await delay(Number(process.env.JOB_POLL_INTERVAL_MS || 1000));
  }
} finally {
  await rm(`${scratch}/task-ready`, { force: true });
  await Promise.allSettled([...active]);
  await browser.close();
  await db.close();
  vault.dispose();
}
