// T24 fixture ONLY. A dedicated OS process with an actual Worker.once and
// browser; it is terminated by the parent after the private OTP is pending.
// The disposable DB connection and KEK arrive via private IPC, not argv,
// environment or logs. Never use this harness in production.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database, SecretVault } from '../packages/storage/dist/index.js';
import { BrowserManager } from '../packages/browser/dist/index.js';
import {
  Coordinator,
  RuntimeClient,
  ArtifactStore,
} from '../packages/orchestrator/dist/index.js';
import { Worker } from '../apps/worker/dist/index.js';

process.once('message', async (payload) => {
  if (payload?.kind !== 't24-auth-child-start') process.exit(2);
  const db = new Database(payload.connection);
  const vault = new SecretVault(
    1,
    new Map([[1, Buffer.from(payload.kek, 'base64')]]),
  );
  const coordinator = new Coordinator({
    db,
    vault,
    serviceActor: { userId: payload.userId },
    platformSlots: 2,
    projectSlots: 2,
  });
  const workerId = `t24-crash-${randomUUID()}`;
  const runtime = new RuntimeClient(
    coordinator,
    { projectId: payload.projectId, workerId },
    new ArtifactStore(join(tmpdir(), `localqa-t24-child-${randomUUID()}`)),
    {},
  );
  if (payload.holdConsume) {
    // Parent terminates the real Worker with a submitted encrypted OTP
    // still pending; no decrypted code reaches the browser in this branch.
    runtime.consumeAuthOtp = async () => new Promise(() => {});
  }
  const originalClaim = runtime.claim.bind(runtime);
  runtime.claim = async (seconds) => {
    const lease = await originalClaim(seconds);
    if (lease) process.send?.({ kind: 't24-lease', workerId, lease });
    return lease;
  };
  const browser = new BrowserManager();
  const worker = new Worker({
    runtime,
    browser,
    scratch: join(tmpdir(), `localqa-t24-worker-${randomUUID()}`),
    heartbeatMs: 200,
    leaseSeconds: 3,
  });
  process.send?.({ kind: 't24-ready', workerId });
  try {
    await worker.once();
    // This must never complete without external human input.
    process.send?.({ kind: 't24-unexpected-exit' });
    process.exitCode = 3;
  } catch {
    process.send?.({ kind: 't24-unexpected-failure' });
    process.exitCode = 4;
  } finally {
    await browser.close();
    await db.close();
  }
});
