import { isErrorCode } from '@localqa/contracts';
import type {
  BrowserSnapshot,
  CredentialMaterial,
  CriterionResult,
} from '@localqa/contracts';
import type { ApprovedAuthState, AuthExportGrant } from '@localqa/browser';
import type { LeaseProof } from '@localqa/storage';
import type { AuthStateRef, RuntimeClient } from '@localqa/orchestrator';
import type { AuthSessionBinding } from '@localqa/browser';
import type { AuthFlowServices } from './auth-runtime.js';

/**
 * The slice of the real `RuntimeClient` used by the trusted auth services. The
 * five signatures mirror the current facade exactly; the compile-time check
 * below fails the build if the facade ever drifts from them.
 */
export interface AuthServiceClient {
  authMaterial(
    proof: LeaseProof,
    sessionId: string,
  ): Promise<CredentialMaterial>;
  recordAuthCriterion(
    proof: LeaseProof,
    sessionId: string,
    criterionResult: CriterionResult,
    snapshotId: string,
  ): Promise<{ gateId: string }>;
  issueCaptureGrant(
    proof: LeaseProof,
    sessionId: string,
    gateId: string,
  ): Promise<{ grant: AuthExportGrant; captureTicket: string }>;
  beginAuthCapture(
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    ticket: string,
  ): Promise<void>;
  captureAuthState(
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    ticket: string,
    state: ApprovedAuthState,
  ): Promise<AuthStateRef>;
  finishAuth(
    proof: LeaseProof,
    sessionId: string,
    authStateId: string,
  ): Promise<void>;
}

// Compile-time compatibility proof against the real facade; erased at runtime.
type _ServicesFacadeIsCompatible = RuntimeClient extends AuthServiceClient
  ? true
  : never;
const _facadeCheck: _ServicesFacadeIsCompatible = true;
void _facadeCheck;

export interface AuthServiceOptions {
  client: AuthServiceClient;
  /** Lease proof. Copied and frozen here; the leaseToken stays in the closure. */
  proof: LeaseProof;
  /** Active AUTH-5 binding: its session/run/epoch scope every service call. */
  binding: AuthSessionBinding;
  /** Real, private OTP authority. The caller holds the same live Worker lease. */
  pauseForOtp?: () => Promise<{ code: string }>;
  /**
   * The production initializer supplies the private OTP wait callback.
   * Legacy isolated unit tests may inject an explicit stub instead; with
   * neither present the flow fails closed, never using a generic input channel.
   */
  unimplementedServices?: Pick<AuthFlowServices, 'pauseForOtp'>;
}

class AuthServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AuthServiceError';
  }
}

/** Reads `error.code` only; messages, causes, and raw text never cross over. */
function serviceCode(error: unknown): string | null {
  let code: unknown;
  try {
    code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
  } catch {
    return null;
  }
  if (code === 'CANCELLED') return 'CANCELLED';
  return typeof code === 'string' && isErrorCode(code) ? code : null;
}

async function call<T>(action: () => Promise<T>, fallback: string): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new AuthServiceError(serviceCode(error) ?? fallback);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Real `RuntimeClient` → `AuthFlowServices` adapter for the AUTH-7A services.
 *
 * Private state that never leaves this closure:
 * - the capture `gateId` returned by `recordAuthCriterion` for a passed, frozen
 *   criterion; `issueCaptureGrant` is refused without it, and every new
 *   evaluation clears it first so a stale gate can never authorize a capture,
 * - the `captureTicket` per issued grant, used for the `beginAuthCapture` CAS
 *   and for the capture itself.
 *
 * Material is returned exactly as the service produced it (canonical
 * `username`/`password`, or the canonical `storageState` string); nothing is
 * renamed, parsed, or wrapped. OTP and finish/handoff are not implemented in
 * this batch, so the flow stays blocked at those steps.
 */
export function createAuthServices(
  options: AuthServiceOptions,
): AuthFlowServices {
  const client = options.client;
  if (
    !client ||
    typeof client !== 'object' ||
    typeof client.authMaterial !== 'function' ||
    typeof client.recordAuthCriterion !== 'function' ||
    typeof client.issueCaptureGrant !== 'function' ||
    typeof client.beginAuthCapture !== 'function' ||
    typeof client.captureAuthState !== 'function'
  ) {
    throw new AuthServiceError('VALIDATION_ERROR');
  }
  const proofInput = options.proof;
  if (
    !proofInput ||
    !nonEmpty(proofInput.taskId) ||
    !nonEmpty(proofInput.leaseToken) ||
    !Number.isSafeInteger(proofInput.fencingToken) ||
    !Number.isSafeInteger(proofInput.contextVersion)
  ) {
    throw new AuthServiceError('VALIDATION_ERROR');
  }
  const bindingInput = options.binding;
  if (
    !bindingInput ||
    !nonEmpty(bindingInput.sessionId) ||
    !nonEmpty(bindingInput.runId) ||
    bindingInput.status !== 'active'
  ) {
    throw new AuthServiceError('VALIDATION_ERROR');
  }
  const lease: LeaseProof = Object.freeze({ ...proofInput });
  const binding: AuthSessionBinding = Object.freeze({ ...bindingInput });
  const sessionId = binding.sessionId;

  // Private closure state: never returned, logged, or placed in an outcome.
  let successGateId: string | null = null;
  const tickets = new Map<string, string>();
  const captured = new Map<string, string>();

  const services: AuthFlowServices = {
    async material() {
      const value = await call(
        () => client.authMaterial(lease, sessionId),
        'AUTH_FAILED',
      );
      if (!value || typeof value !== 'object') {
        throw new AuthServiceError('AUTH_FAILED');
      }
      return value;
    },
    async recordAuthCriterion(snapshot: BrowserSnapshot, result) {
      // A new evaluation starts by invalidating any earlier success gate: a
      // stale gate must never authorize a capture, whether this call ends in a
      // non-passed result, a service failure, or a malformed gate response.
      successGateId = null;
      // The service only issues a capture gate for a passed criterion, so a
      // non-passed result is left to the flow's own blocked reason.
      if (!result || result.result !== 'passed') return;
      if (!nonEmpty(snapshot?.snapshotId)) {
        throw new AuthServiceError('VALIDATION_ERROR');
      }
      const issued = await call(
        () =>
          client.recordAuthCriterion(
            lease,
            sessionId,
            result,
            snapshot.snapshotId,
          ),
        'AUTH_FAILED',
      );
      if (!issued || !nonEmpty(issued.gateId)) {
        throw new AuthServiceError('AUTH_FAILED');
      }
      successGateId = issued.gateId;
    },
    async issueCaptureGrant() {
      const gateId = successGateId;
      if (!gateId) {
        // No passed, same-session success gate: no capture grant either.
        throw new AuthServiceError('AUTH_FAILED');
      }
      const issued = await call(
        () => client.issueCaptureGrant(lease, sessionId, gateId),
        'AUTH_FAILED',
      );
      const grant = issued?.grant;
      const ticket = issued?.captureTicket;
      if (
        !grant ||
        !nonEmpty(grant.grantId) ||
        !nonEmpty(ticket) ||
        !nonEmpty(grant.captureTicket)
      ) {
        throw new AuthServiceError('AUTH_FAILED');
      }
      if (grant.sessionId !== sessionId || grant.captureTicket !== ticket) {
        throw new AuthServiceError('LEASE_EXPIRED');
      }
      tickets.set(grant.grantId, ticket);
      return grant;
    },
    async authorizeExport(grant: AuthExportGrant) {
      const ticket = nonEmpty(grant?.grantId)
        ? tickets.get(grant.grantId)
        : undefined;
      if (!ticket || grant.sessionId !== sessionId) {
        // A grant this adapter never issued cannot open the export CAS.
        throw new AuthServiceError('LEASE_EXPIRED');
      }
      await call(
        () => client.beginAuthCapture(lease, sessionId, grant.grantId, ticket),
        'AUTH_FAILED',
      );
    },
    async captureAuthState(grant: AuthExportGrant, state: ApprovedAuthState) {
      const ticket = nonEmpty(grant?.grantId)
        ? tickets.get(grant.grantId)
        : undefined;
      if (!ticket || grant.sessionId !== sessionId) {
        throw new AuthServiceError('LEASE_EXPIRED');
      }
      const ref = await call(
        () =>
          client.captureAuthState(
            lease,
            sessionId,
            grant.grantId,
            ticket,
            state,
          ),
        'AUTH_FAILED',
      );
      if (!ref || !nonEmpty(ref.authStateId)) {
        throw new AuthServiceError('AUTH_FAILED');
      }
      // A handle from another run or epoch is refused, not handed on.
      if (ref.runId !== binding.runId || ref.authEpoch !== binding.authEpoch) {
        throw new AuthServiceError('LEASE_EXPIRED');
      }
      captured.set(grant.grantId, ref.authStateId);
      return { stateRef: ref.authStateId };
    },
    async finishAuth(stateRef: string) {
      if (!nonEmpty(stateRef)) {
        throw new AuthServiceError('VALIDATION_ERROR');
      }
      // Only the state this adapter captured for the frozen proof/session may be
      // finished; there is no ordinary-finish fallback.
      let known = false;
      for (const value of captured.values()) {
        if (value === stateRef) {
          known = true;
          break;
        }
      }
      if (!known) throw new AuthServiceError('LEASE_EXPIRED');
      const finish = client.finishAuth;
      if (typeof finish !== 'function') {
        throw new AuthServiceError('SERVICE_UNAVAILABLE');
      }
      await call(
        () => finish.call(client, lease, sessionId, stateRef),
        'AUTH_FAILED',
      );
    },
  };

  // Only explicit stubs may fill the unimplemented slots; absent stays absent so
  // the bridge blocks those steps instead of inventing a completion.
  const unimplemented = options.unimplementedServices;
  if (options.pauseForOtp) services.pauseForOtp = options.pauseForOtp;
  else if (unimplemented?.pauseForOtp)
    services.pauseForOtp = unimplemented.pauseForOtp;
  return services;
}
