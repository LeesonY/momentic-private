import type { AuthProfile } from '@localqa/contracts';
import { BrowserManager, BrowserSessionImpl } from '@localqa/browser';
import type { AuthSessionBinding } from '@localqa/browser';
import type { RuntimeClient } from '@localqa/orchestrator';
import type { LeaseProof } from '@localqa/storage';
import { runBrowserAuthImport } from './auth-import.js';
import type { AuthImportResult } from './auth-import.js';

type ImportTaskClient = Pick<
  RuntimeClient,
  | 'allocateAuthImporterSession'
  | 'issueAuthActivationTicket'
  | 'activateAuthSession'
  | 'endAuthSession'
  | 'grantAuthImport'
  | 'prepareAuthImport'
  | 'beginAuthImport'
  | 'recordAuthImport'
> &
  Partial<Pick<RuntimeClient, 'authSession'>>;

export interface AuthenticatedImportTask {
  client: ImportTaskClient;
  browser: BrowserManager;
  proof: LeaseProof;
  profile: AuthProfile;
  /** Server-provided, frozen current-state handle. Never read from the user. */
  authStateId: string;
  /** The run's approved network scope. No widening to the profile's scope. */
  allowedOrigins: readonly string[];
  tlsPolicy?: 'strict' | 'allow_self_signed';
  artifactsDir?: string;
  navigationTimeoutMs?: number;
  /** The subsequent task must run in this SAME isolated Chromium context. */
  onAuthenticated: (
    session: BrowserSessionImpl,
    signal: AbortSignal,
  ) => Promise<void>;
}

const denial: AuthImportResult = Object.freeze({
  status: 'blocked',
  reasonCode: 'VALIDATION_ERROR',
});
const cancelled: AuthImportResult = Object.freeze({
  status: 'cancelled',
  reasonCode: 'CANCELLED',
});

/** Do not accept substituted server bindings between allocate and activate. */
function identityMatches(
  allocated: AuthSessionBinding,
  active: AuthSessionBinding,
  options: AuthenticatedImportTask,
): boolean {
  const proof = options.proof;
  const profile = options.profile;
  const fields = [
    'sessionId',
    'projectId',
    'runId',
    'taskId',
    'workerId',
    'fencingToken',
    'contextVersion',
    'contextId',
    'profileId',
    'profileVersion',
    'authEpoch',
    'purpose',
    'expiresAt',
  ] as const;
  return (
    allocated.status === 'allocated' &&
    active.status === 'active' &&
    allocated.purpose === 'importer' &&
    fields.every((key) => allocated[key] === active[key]) &&
    active.projectId === profile.projectId &&
    active.profileId === profile.id &&
    active.profileVersion === profile.version &&
    active.taskId === proof.taskId &&
    active.fencingToken === proof.fencingToken &&
    active.contextVersion === proof.contextVersion &&
    Number.isFinite(Date.parse(active.expiresAt)) &&
    Date.parse(active.expiresAt) > Date.now()
  );
}

/**
 * Trusted Worker task admission for an already approved, captured auth state.
 *
 * Allocation, one-use ticket activation and import all use the real Runtime
 * facade. The caller provides the state handle from a server-frozen Work item,
 * not a user-selected profile. The callback keeps the authenticated browser
 * context task-local; it cannot migrate to another task or Worker.
 *
 * Worker.once supplies the server-frozen state ID and runs its browser work
 * through the authenticated callback. This helper alone is not P0 admission.
 */
export async function withApprovedBrowserAuth(
  options: AuthenticatedImportTask,
  signal: AbortSignal,
): Promise<AuthImportResult> {
  if (signal.aborted) return cancelled;
  if (options.profile?.status !== 'active' || options.profile.mode === 'none')
    return denial;
  if (
    typeof options.authStateId !== 'string' ||
    !options.authStateId ||
    !options.proof.leaseToken ||
    typeof options.onAuthenticated !== 'function'
  )
    return denial;
  // The login profile may include an IdP origin not approved for the task.
  // The importer validates the full captured state, then projects only the
  // task-approved hosts/origins into Chromium without widening navigation.
  let profileOrigins: Set<string>;
  let taskOrigins: Set<string>;
  try {
    profileOrigins = new Set(
      options.profile.allowedOrigins.map((url) => new URL(url).origin),
    );
    taskOrigins = new Set(
      options.allowedOrigins.map((url) => new URL(url).origin),
    );
  } catch {
    return denial;
  }
  if (
    !taskOrigins.size ||
    [...taskOrigins].some((origin) => !profileOrigins.has(origin))
  )
    return denial;

  let allocated: AuthSessionBinding | undefined;
  let session: BrowserSessionImpl | undefined;
  let outcome: AuthImportResult;
  let cleanupFailed = false;
  let finalized = false;
  try {
    allocated = await options.client.allocateAuthImporterSession(
      options.proof,
      options.authStateId,
    );
    // Reject an altered allocate tuple before requesting a ticket.
    if (
      !identityMatches(allocated, { ...allocated, status: 'active' }, options)
    )
      return denial;
    if (signal.aborted) return cancelled;
    const issued = await options.client.issueAuthActivationTicket(
      options.proof,
      allocated.sessionId,
    );
    if (
      !issued ||
      typeof issued.activationTicket !== 'string' ||
      !issued.activationTicket
    )
      return denial;
    // A cancelled task must never activate a ticket issued just as the
    // heartbeat revoked its lease.
    if (signal.aborted) return cancelled;
    const active = await options.client.activateAuthSession(
      options.proof,
      allocated.sessionId,
      issued.activationTicket,
    );
    if (!identityMatches(allocated, active, options)) return denial;
    if (signal.aborted) return cancelled;
    const created = await options.browser.createSession({
      sessionId: active.contextId,
      projectId: active.projectId,
      runId: active.runId,
      taskId: active.taskId,
      allowedOrigins: [...taskOrigins],
      tlsPolicy: options.tlsPolicy ?? 'strict',
      mode: 'non_submitting',
      artifactsDir: options.artifactsDir,
      navigationTimeoutMs: options.navigationTimeoutMs,
      enableTrace: false,
    });
    if (!(created instanceof BrowserSessionImpl)) {
      await created.close();
      return denial;
    }
    session = created;
    outcome = await runBrowserAuthImport(
      {
        client: options.client,
        proof: options.proof,
        binding: active,
        profile: options.profile,
        authStateId: options.authStateId,
        executionOrigins: [...taskOrigins],
        session,
      },
      signal,
    );
    if (outcome.status !== 'imported') return outcome;
    if (signal.aborted) return cancelled;
    // The coordinator's ordinary finish() verifies the import receipt and
    // atomically ends this session via AuthImportService.endTask. Ending here
    // first would bypass that server-side verification. The trusted callback
    // must finish the task while this session is still active.
    await options.onAuthenticated(session, signal);
    finalized = true;
    if (signal.aborted) return cancelled;
  } catch {
    outcome = signal.aborted ? cancelled : denial;
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (allocated && !finalized) {
      try {
        await options.client.endAuthSession(
          options.proof,
          allocated.sessionId,
          signal.aborted ? 'cancelled' : 'failed',
        );
      } catch {
        cleanupFailed = true;
      }
    }
  }
  return cleanupFailed ? denial : outcome;
}
