import { isErrorCode } from '@localqa/contracts';
import type { AuthProfile } from '@localqa/contracts';
import {
  createPrivateAuthPort,
  createTrustedBrowserAuthPrimitives,
  validateApprovedAuthState,
  PrivateAuthError,
} from '@localqa/browser';
import type { BrowserSessionImpl } from '@localqa/browser';
import type {
  AuthSessionBinding,
  AuthPermit,
  TrustedAuthPrimitives,
} from '@localqa/browser';
import type {
  RuntimeClient,
  AuthImportGrant,
  AuthImportReceipt,
} from '@localqa/orchestrator';
import type { LeaseProof } from '@localqa/storage';

type ImportClient = Pick<
  RuntimeClient,
  | 'grantAuthImport'
  | 'prepareAuthImport'
  | 'beginAuthImport'
  | 'recordAuthImport'
> &
  Partial<Pick<RuntimeClient, 'authSession'>>;

export interface AuthImportOptions {
  client: ImportClient;
  proof: LeaseProof;
  /** Obtained from the real importer allocation and activation services. */
  binding: AuthSessionBinding;
  profile: AuthProfile;
  authStateId: string;
  primitives: TrustedAuthPrimitives;
  /** Task-approved origins; must be a subset of the frozen profile scope. */
  executionOrigins?: readonly string[];
}

export interface AuthImportResult {
  status: 'imported' | 'not_required' | 'blocked' | 'cancelled';
  reasonCode: string;
}

/**
 * Concrete Worker-side importer binding: the trusted private import service
 * runs against this task's owned Chromium context, never a fake primitive or
 * the model-facing ToolCall port. Task allocation and activation remain the
 * coordinator's responsibility, not this function's.
 */
export async function runBrowserAuthImport(
  options: Omit<AuthImportOptions, 'primitives'> & {
    session: BrowserSessionImpl;
  },
  signal: AbortSignal,
): Promise<AuthImportResult> {
  // Anonymous and revoked profiles must never start browser activity.
  if (options.profile.status !== 'active')
    return Object.freeze({ status: 'blocked', reasonCode: 'VALIDATION_ERROR' });
  if (options.profile.mode === 'none')
    return Object.freeze({
      status: 'not_required',
      reasonCode: 'AUTH_NOT_REQUIRED',
    });
  if (signal.aborted)
    return Object.freeze({ status: 'cancelled', reasonCode: 'CANCELLED' });
  // The lease/binding tuple must identify the very Chromium context receiving
  // secrets. A valid server grant alone cannot make a different task's tab an
  // approved recipient; check before any grant, decrypt, or browser operation.
  if (
    options.session.isClosed ||
    options.session.id !== options.binding.contextId ||
    options.session.taskId !== options.proof.taskId ||
    options.binding.taskId !== options.proof.taskId ||
    options.binding.fencingToken !== options.proof.fencingToken ||
    options.binding.contextVersion !== options.proof.contextVersion
  )
    return Object.freeze({ status: 'blocked', reasonCode: 'VALIDATION_ERROR' });
  try {
    return await runAuthImport(
      {
        client: options.client,
        proof: options.proof,
        binding: options.binding,
        profile: options.profile,
        authStateId: options.authStateId,
        ...(options.executionOrigins
          ? { executionOrigins: options.executionOrigins }
          : {}),
        primitives: createTrustedBrowserAuthPrimitives(
          options.session,
          options.executionOrigins ?? options.profile.allowedOrigins,
        ),
      },
      signal,
    );
  } catch {
    // Even constructor/route registration errors may contain browser details;
    // do not forward anything but a fixed code to the task ledger.
    return Object.freeze({ status: 'blocked', reasonCode: 'VALIDATION_ERROR' });
  }
}

const TUPLE = [
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
  'status',
  'expiresAt',
] as const;

function codeOf(error: unknown, fallback: string): string {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'CANCELLED') return 'CANCELLED';
    return isErrorCode(code) ? code : fallback;
  } catch {
    return fallback;
  }
}

function deny(): never {
  throw new PrivateAuthError('VALIDATION_ERROR');
}

/** One private import into an already allocated task context. No navigation,
 * ordinary tool channel, state capture, task finish, or automatic replay. The
 * surrounding Worker owns the underlying context and task/session lifecycle. */
export async function runAuthImport(
  options: AuthImportOptions,
  signal: AbortSignal,
): Promise<AuthImportResult> {
  let port: ReturnType<typeof createPrivateAuthPort> | undefined;
  let grant: AuthImportGrant | undefined;
  let receipt: AuthImportReceipt | undefined;
  let effectAttempted = false;
  let recordAttempted = false;
  let stable:
    | {
        client: ImportClient;
        proof: Readonly<LeaseProof>;
        binding: Readonly<AuthSessionBinding>;
      }
    | undefined;
  const result = (
    status: AuthImportResult['status'],
    reasonCode: string,
  ): AuthImportResult => Object.freeze({ status, reasonCode });
  try {
    if (signal.aborted) return result('cancelled', 'CANCELLED');
    if (options.profile.status !== 'active') deny();
    // A frozen anonymous policy needs neither a service call nor a private port.
    if (options.profile.mode === 'none')
      return result('not_required', 'AUTH_NOT_REQUIRED');
    const binding = Object.freeze({ ...options.binding });
    const proof = Object.freeze({ ...options.proof });
    const client = options.client;
    const renewal =
      typeof client.authSession === 'function'
        ? client.authSession.bind(client)
        : undefined;
    const stateId = options.authStateId;
    const profileOrigins = Object.freeze([...options.profile.allowedOrigins]);
    const origins = Object.freeze([
      ...(options.executionOrigins ?? profileOrigins),
    ]);
    let approved: Set<string>;
    let permitted: Set<string>;
    try {
      approved = new Set(profileOrigins.map((url) => new URL(url).origin));
      permitted = new Set(origins.map((url) => new URL(url).origin));
    } catch {
      deny();
    }
    if (!permitted.size || [...permitted].some((url) => !approved.has(url)))
      deny();
    const primitives = options.primitives;
    stable = { client, proof, binding };
    if (
      binding.purpose !== 'importer' ||
      binding.status !== 'active' ||
      binding.taskId !== proof.taskId ||
      binding.fencingToken !== proof.fencingToken ||
      binding.contextVersion !== proof.contextVersion ||
      binding.profileId !== options.profile.id ||
      binding.profileVersion !== options.profile.version ||
      binding.projectId !== options.profile.projectId ||
      !stateId ||
      !proof.leaseToken ||
      !Number.isSafeInteger(proof.fencingToken) ||
      proof.fencingToken < 1 ||
      !Number.isSafeInteger(proof.contextVersion) ||
      proof.contextVersion < 1 ||
      !Number.isFinite(Date.parse(binding.expiresAt)) ||
      Date.parse(binding.expiresAt) <= Date.now()
    )
      deny();
    for (const method of [
      'grantAuthImport',
      'prepareAuthImport',
      'beginAuthImport',
      'recordAuthImport',
    ] as const) {
      if (typeof client[method] !== 'function') deny();
    }
    const checkGrant = async (candidate: AuthImportGrant): Promise<void> => {
      // Heartbeat renewal may advance expiry while Chromium is starting.
      // Confirm that advance through the trusted Runtime; identity stays fixed.
      const candidateExpiry = Date.parse(candidate.expiresAt);
      const activatedExpiry = Date.parse(binding.expiresAt);
      if (
        !candidate ||
        candidate.kind !== 'import_auth_state' ||
        !candidate.grantId ||
        candidate.authStateId !== stateId ||
        TUPLE.some(
          (key) => key !== 'expiresAt' && candidate[key] !== binding[key],
        ) ||
        !Number.isFinite(candidateExpiry) ||
        candidateExpiry < activatedExpiry ||
        candidateExpiry > activatedExpiry + 5 * 60 * 1000 ||
        !Number.isFinite(Date.parse(candidate.deadline)) ||
        Date.parse(candidate.deadline) <= Date.now() ||
        Date.parse(candidate.deadline) > candidateExpiry
      )
        deny();
      if (candidate.expiresAt !== binding.expiresAt) {
        if (!renewal) deny();
        const live = await renewal(proof, binding.sessionId);
        const liveExpiry = Date.parse(live.expiresAt);
        if (
          TUPLE.some(
            (key) => key !== 'expiresAt' && live[key] !== binding[key],
          ) ||
          !Number.isFinite(liveExpiry) ||
          liveExpiry <= Date.now() ||
          liveExpiry < candidateExpiry ||
          liveExpiry > activatedExpiry + 5 * 60 * 1000
        )
          deny();
      }
    };
    grant = Object.freeze({
      ...(await client.grantAuthImport(proof, binding.sessionId)),
    });
    await checkGrant(grant);
    if (signal.aborted) return result('cancelled', 'CANCELLED');
    const prepared = await client.prepareAuthImport(
      proof,
      binding.sessionId,
      grant.grantId,
    );
    await checkGrant(prepared.grant);
    if (
      prepared.grant.grantId !== grant.grantId ||
      prepared.grant.deadline !== grant.deadline
    )
      deny();
    if (signal.aborted) return result('cancelled', 'CANCELLED');
    // Only the action/slot are fixed internal mappings. Every authority field
    // comes from the server grant and must match the activated binding.
    const permit: AuthPermit = Object.freeze({
      ...grant,
      action: 'import_storage_state',
      slot: 'storage_state',
    });
    port = createPrivateAuthPort({
      binding,
      ...(renewal
        ? { trustedRenewal: () => renewal(proof, binding.sessionId) }
        : {}),
      allowedOrigins: origins,
      primitives: {
        navigate: primitives.navigate.bind(primitives),
        fill: primitives.fill.bind(primitives),
        submit: primitives.submit.bind(primitives),
        exportState: primitives.exportState.bind(primitives),
        async prepareState(state) {
          effectAttempted = true;
          await primitives.prepareState.call(primitives, state);
        },
      },
      gate: {
        async authorize(input) {
          if (
            receipt ||
            input.permit.grantId !== grant!.grantId ||
            input.permit.action !== 'import_storage_state' ||
            input.permit.slot !== 'storage_state'
          )
            deny();
          try {
            receipt = await client.beginAuthImport(
              proof,
              binding.sessionId,
              grant!.grantId,
            );
          } catch (error) {
            const code = codeOf(error, 'VALIDATION_ERROR');
            throw new PrivateAuthError(
              code === 'LEASE_EXPIRED'
                ? 'LEASE_EXPIRED'
                : code === 'CANCELLED'
                  ? 'CANCELLED'
                  : 'VALIDATION_ERROR',
            );
          }
          if (
            !receipt ||
            receipt.grantId !== grant!.grantId ||
            typeof receipt.executionId !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(receipt.executionId) ||
            !Number.isFinite(Date.parse(receipt.startedAt))
          )
            deny();
        },
        async authorizeExport() {
          deny();
        },
      },
    });
    // Verify the complete captured state against the profile BEFORE dropping
    // out-of-scope data. Only task-approved host cookies and localStorage may
    // enter this isolated Chromium context. No arbitrary domain suffix match.
    const complete = validateApprovedAuthState(prepared.state, profileOrigins);
    const hosts = new Set(
      [...permitted].map((url) => new URL(url).hostname.toLowerCase()),
    );
    const state = validateApprovedAuthState(
      {
        cookies:
          complete.cookies?.filter((cookie) =>
            hosts.has(cookie.domain.replace(/^\./, '').toLowerCase()),
          ) ?? [],
        origins:
          complete.origins?.filter((entry) => permitted.has(entry.origin)) ??
          [],
      },
      origins,
    );
    const effect = await port.executeAuth(
      permit,
      { kind: 'prepare_state', state },
      signal,
    );
    if (effect.snapshot !== null || !receipt) deny();
    recordAttempted = true;
    await client.recordAuthImport(
      proof,
      binding.sessionId,
      grant.grantId,
      receipt,
      { status: 'succeeded' },
    );
    if (signal.aborted) return result('cancelled', 'CANCELLED');
    return result('imported', 'AUTH_IMPORTED');
  } catch (error) {
    // Failed/ambiguous effects must not leave a successful outcome. A failed
    // record is never retried or replaced with an ordinary result write.
    if (grant && receipt && stable && !recordAttempted) {
      try {
        await stable.client.recordAuthImport(
          stable.proof,
          stable.binding.sessionId,
          grant.grantId,
          receipt,
          {
            status: signal.aborted
              ? 'cancelled'
              : effectAttempted
                ? 'unknown'
                : 'failed',
          },
        );
      } catch {
        /* The task owner/recovery settles any remaining private intent. */
      }
    }
    return result(
      signal.aborted ? 'cancelled' : 'blocked',
      signal.aborted ? 'CANCELLED' : codeOf(error, 'AUTH_IMPORT_FAILED'),
    );
  } finally {
    await port?.close();
  }
}
