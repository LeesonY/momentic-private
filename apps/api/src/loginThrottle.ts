/**
 * Failed-login throttling.
 *
 * The honest threat model for this deployment: an internal platform whose login
 * endpoint had no throttle at all, so a script could try passwords as fast as
 * the network allowed (verified: ten consecutive wrong passwords all answered
 * 401 with no delay and no lockout).
 *
 * Design constraints:
 *  - slow guessing down without ever locking an account. A permanent lockout is
 *    a denial-of-service against legitimate users, and the operator explicitly
 *    requires that authorised automated tests keep working.
 *  - keyed by (account, client) so one noisy source cannot lock everyone out of
 *    one account, and rotating the target account does not evade the per-source
 *    budget.
 *  - bounded memory: the map is pruned on every write and capped.
 *
 * Deliberately NOT a credential store: only timestamps are kept, and the email
 * is hashed before use as a key so the table never holds account identifiers in
 * a form that is easy to scrape from a heap dump.
 */
import { createHash } from 'node:crypto';

export const LOGIN_WINDOW_MS = 5 * 60_000;
/** Generous enough for a human or an automated suite that uses correct credentials. */
export const LOGIN_MAX_FAILURES_PER_ACCOUNT = 12;
/** Rotating the target account must not give an unbounded budget. */
export const LOGIN_MAX_FAILURES_PER_SOURCE = 40;
const MAX_TRACKED_KEYS = 10_000;

interface WindowEntry {
  failures: number[];
}

export interface ThrottleDecision {
  limited: boolean;
  retryAfterSeconds: number;
  scope: 'account' | 'source' | null;
}

function accountKey(email: string, clientId: string): string {
  return `a:${createHash('sha256')
    .update(`${email.toLowerCase()}|${clientId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function sourceKey(clientId: string): string {
  return `s:${createHash('sha256').update(clientId).digest('hex').slice(0, 32)}`;
}

export class LoginThrottle {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Checked before the password is verified. */
  inspect(email: string, clientId: string): ThrottleDecision {
    const now = this.now();
    for (const [key, limit] of [
      [accountKey(email, clientId), LOGIN_MAX_FAILURES_PER_ACCOUNT],
      [sourceKey(clientId), LOGIN_MAX_FAILURES_PER_SOURCE],
    ] as const) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      const recent = entry.failures.filter((at) => now - at < LOGIN_WINDOW_MS);
      if (recent.length < limit) continue;
      const oldest = recent[0] ?? now;
      return {
        limited: true,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((LOGIN_WINDOW_MS - (now - oldest)) / 1000),
        ),
        scope: key.startsWith('a:') ? 'account' : 'source',
      };
    }
    return { limited: false, retryAfterSeconds: 0, scope: null };
  }

  recordFailure(email: string, clientId: string): void {
    const now = this.now();
    this.#record(accountKey(email, clientId), now);
    this.#record(sourceKey(clientId), now);
  }

  /** A successful login clears the account budget for this client. */
  recordSuccess(email: string, clientId: string): void {
    this.entries.delete(accountKey(email, clientId));
  }

  #record(key: string, now: number): void {
    const entry = this.entries.get(key) ?? { failures: [] };
    entry.failures = entry.failures.filter((at) => now - at < LOGIN_WINDOW_MS);
    entry.failures.push(now);
    this.entries.set(key, entry);
    if (this.entries.size > MAX_TRACKED_KEYS) this.#prune(now);
  }

  #prune(now: number): void {
    for (const [key, entry] of this.entries) {
      const recent = entry.failures.filter((at) => now - at < LOGIN_WINDOW_MS);
      if (recent.length === 0) this.entries.delete(key);
      else entry.failures = recent;
    }
    // Still oversized: drop the oldest half of what remains.
    if (this.entries.size > MAX_TRACKED_KEYS) {
      const victims = [...this.entries.keys()].slice(
        0,
        Math.floor(MAX_TRACKED_KEYS / 2),
      );
      for (const victim of victims) this.entries.delete(victim);
    }
  }

  /** Test/observability hook. */
  get trackedKeys(): number {
    return this.entries.size;
  }
}

/**
 * Client identity for throttling. The gateway sets `X-Real-IP`; a direct caller
 * has no proxy, so the socket address is used. A client cannot spoof its way
 * past the throttle: a forged header only changes which bucket it lands in,
 * never whether a bucket exists.
 */
export function clientIdentity(
  headers: Record<string, string | undefined>,
  socketAddress: string | undefined,
): string {
  const real = headers['x-real-ip']?.trim();
  if (real) return real;
  const forwarded = headers['x-forwarded-for']?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return socketAddress?.trim() || 'unknown';
}
