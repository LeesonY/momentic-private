// Pool sizing for the worker process. Claim flights (BROWSER_SLOTS + 1) and the
// tasks they run share one pool, so the pool must be larger than the number of
// in-flight claims; PostgreSQL max_connections is 100, so this stays bounded.
export function workerPoolMax(slots, envValue) {
  const explicit = envValue === undefined ? undefined : Number(envValue);
  if (explicit !== undefined) {
    if (Number.isSafeInteger(explicit) && explicit >= 1 && explicit <= 100)
      return explicit;
    console.warn(
      `Ignoring invalid DB_POOL_MAX (${String(envValue)}); using the slot-based size`,
    );
  }
  if (!Number.isSafeInteger(slots) || slots < 1) return 8;
  return Math.max(8, Math.min(slots + 8, 40));
}
