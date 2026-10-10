#!/usr/bin/env node
import pg from '../../packages/storage/node_modules/pg/lib/index.js';
import { loadDatabaseUrl } from '../images/database-url.mjs';

const connectionString = await loadDatabaseUrl();

const workerId = process.env.WORKER_ID || process.argv[2] || null;
const timeoutSeconds = Number(process.env.SHUTDOWN_TIMEOUT_SECONDS || 30);

console.log('[Graceful Shutdown] Initiating steady-state shutdown sequence...');
if (workerId) {
  console.log(`[Graceful Shutdown] Target Worker ID: ${workerId}`);
}
console.log(`[Graceful Shutdown] Grace period: ${timeoutSeconds}s`);

const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000 });
const client = await pool.connect();

try {
  // Task-claim cessation belongs to the worker runtime; this script only observes leases.
  console.log(
    '[Graceful Shutdown] Observation only: stop new task claims in the worker before invoking.',
  );

  // Step 2: Check for in-flight tasks
  const start = Date.now();
  let remainingInFlight = 0;

  do {
    const query = workerId
      ? "SELECT count(*)::integer n FROM task_leases l JOIN jobs j ON j.id=l.task_id WHERE l.worker_id=$1 AND j.status='running' AND l.lease_until > clock_timestamp()"
      : "SELECT count(*)::integer n FROM jobs WHERE status='running'";
    const params = workerId ? [workerId] : [];
    const res = await client.query(query, params);
    remainingInFlight = res.rows[0]?.n ?? 0;

    if (remainingInFlight === 0) {
      console.log(
        '[Graceful Shutdown] Step 2: All in-flight tasks finished cleanly.',
      );
      break;
    }

    console.log(
      `[Graceful Shutdown] Waiting for ${remainingInFlight} active task(s) to finish (elapsed: ${Math.floor((Date.now() - start) / 1000)}s)...`,
    );
    await new Promise((r) => setTimeout(r, 2000));
  } while (remainingInFlight > 0 && Date.now() - start < timeoutSeconds * 1000);

  if (remainingInFlight > 0) {
    console.error(
      `[Graceful Shutdown] ${remainingInFlight} task(s) still running; refusing to declare a safe drain or invalidate a live lease.`,
    );
    process.exitCode = 2;
  }

  console.log('[Graceful Shutdown] Closing database connections...');
} catch (err) {
  console.error('[Graceful Shutdown] Error during graceful drain:', err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
  console.log('[Graceful Shutdown] Shutdown complete. Process exiting.');
}
