import { isErrorCode } from '@localqa/contracts';
import type {
  BrowserSnapshot,
  CredentialMaterial,
  CriterionResult,
} from '@localqa/contracts';
import type {
  AuthActionOutcome,
  AuthActionRequest,
  AuthExecutionReceipt,
  AuthPermit,
  RuntimeClient,
} from '@localqa/orchestrator';
import type { LeaseProof } from '@localqa/storage';
import { PrivateAuthError } from '@localqa/browser';
import type {
  ApprovedAuthState,
  AuthExecutionGate,
  AuthExportGrant,
  AuthSessionBinding,
} from '@localqa/browser';
import type {
  AuthCaptureReceipt,
  AuthFlowRuntime,
  AuthOtpMaterial,
  AuthRecordOutcome,
} from './auth-flow.js';

/**
 * The narrow slice of the real `RuntimeClient` this bridge is allowed to use.
 * The four signatures mirror the current facade exactly; the compile-time check
 * below fails the build if the facade ever drifts from them.
 */
export interface AuthRuntimeClient {
  grantAuth(proof: LeaseProof, request: AuthActionRequest): Promise<AuthPermit>;
  recordAuthObservation(
    proof: LeaseProof,
    sessionId: string,
    snapshot: BrowserSnapshot,
  ): Promise<BrowserSnapshot>;
  beginAuthExecution(
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
  ): Promise<AuthExecutionReceipt>;
  recordAuth(
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    receipt: AuthExecutionReceipt,
    outcome: AuthActionOutcome,
  ): Promise<void>;
}

// Compile-time compatibility proof against the real facade; erased at runtime.
type _FacadeIsCompatible = RuntimeClient extends AuthRuntimeClient
  ? true
  : never;
const _facadeCheck: _FacadeIsCompatible = true;
void _facadeCheck;

/**
 * Private services that are NOT implemented yet. Every one is optional on
 * purpose: a missing service blocks the flow with SERVICE_UNAVAILABLE instead of
 * succeeding, fabricating a stateRef, or falling back to an ordinary channel.
 */
export interface AuthFlowServices {
  material?(): Promise<CredentialMaterial>;
  pauseForOtp?(): Promise<AuthOtpMaterial>;
  recordAuthCriterion?(
    snapshot: BrowserSnapshot,
    result: CriterionResult,
  ): Promise<void>;
  issueCaptureGrant?(): Promise<AuthExportGrant>;
  /** Capture-ticket CAS gate; the real Coordinator wiring is still outstanding. */
  authorizeExport?(grant: AuthExportGrant): Promise<void>;
  captureAuthState?(
    grant: AuthExportGrant,
    state: ApprovedAuthState,
  ): Promise<AuthCaptureReceipt>;
  finishAuth?(stateRef: string): Promise<void>;
  /** End the verified sign-in of one task, without state capture or job finish. */
  finishSignIn?(): Promise<void>;
}

export interface AuthRuntimeOptions {
  client: AuthRuntimeClient;
  /** Lease proof. Copied and frozen here; the raw leaseToken stays private. */
  proof: LeaseProof;
  /** Active AUTH-5 authority binding. Copied and frozen here. */
  binding: AuthSessionBinding;
  services?: AuthFlowServices | undefined;
}

export interface AuthRuntimeBridge {
  runtime: AuthFlowRuntime;
  gate: AuthExecutionGate;
}

class BridgeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AuthBridgeError';
  }
}

const CLIENT_METHODS = [
  'grantAuth',
  'recordAuthObservation',
  'beginAuthExecution',
  'recordAuth',
] as const;

/** Reads `error.code` without touching `error.message`; only contract codes pass. */
function serviceCode(error: unknown): string | null {
  if (error instanceof BridgeError) return error.code;
  if (error instanceof PrivateAuthError) return error.code;
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

function fail(code: string): never {
  throw new BridgeError(code);
}

/** Service failures become constant codes; unknown text never crosses over. */
function mapped(error: unknown, fallback: string): BridgeError {
  if (error instanceof BridgeError || error instanceof PrivateAuthError) {
    return error;
  }
  return new BridgeError(serviceCode(error) ?? fallback);
}

/** The port only understands three codes; everything else is a denial. */
function portError(error: unknown): PrivateAuthError {
  if (error instanceof PrivateAuthError) return error;
  const code = serviceCode(error);
  if (code === 'CANCELLED' || code === 'USER_CANCELLED') {
    return new PrivateAuthError('CANCELLED');
  }
  if (code === 'LEASE_EXPIRED' || code === 'AUTH_REQUIRED') {
    return new PrivateAuthError('LEASE_EXPIRED');
  }
  return new PrivateAuthError('VALIDATION_ERROR');
}

const TUPLE_KEYS = [
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
] as const;

/** Every permit is re-checked against the frozen binding; nothing is patched in. */
function permitMatchesBinding(
  permit: AuthPermit | null | undefined,
  binding: AuthSessionBinding,
): boolean {
  if (
    !permit ||
    typeof permit.grantId !== 'string' ||
    permit.grantId.length === 0
  ) {
    return false;
  }
  for (const key of TUPLE_KEYS) {
    if (permit[key] !== binding[key]) return false;
  }
  if (typeof permit.deadline !== 'string' || permit.deadline.length === 0) {
    return false;
  }
  return Number.isFinite(Date.parse(permit.deadline));
}

/**
 * Trusted Worker-side bridge: the real RuntimeClient plus one frozen proof and
 * active binding, exposed as the AUTH-6 flow runtime and the AUTH-5 gate.
 *
 * Receipts from `beginAuthExecution` are held in a private closure keyed by
 * session+grant and never appear in an outcome, a Step, or a returned object.
 * Every method re-verifies through the service; no cached "active" value lets an
 * expired, revoked, or rebound session pass. The raw leaseToken lives only in
 * this closure.
 */
export function createAuthRuntimeBridge(
  options: AuthRuntimeOptions,
): AuthRuntimeBridge {
  const client = options.client;
  if (!client || typeof client !== 'object') fail('VALIDATION_ERROR');
  for (const method of CLIENT_METHODS) {
    if (typeof client[method] !== 'function') fail('VALIDATION_ERROR');
  }
  const proof = options.proof;
  if (
    !proof ||
    typeof proof.taskId !== 'string' ||
    proof.taskId.length === 0 ||
    typeof proof.leaseToken !== 'string' ||
    proof.leaseToken.length === 0 ||
    !Number.isSafeInteger(proof.fencingToken) ||
    !Number.isSafeInteger(proof.contextVersion)
  ) {
    fail('VALIDATION_ERROR');
  }
  const lease: LeaseProof = Object.freeze({ ...proof });
  const bindingInput = options.binding;
  if (
    !bindingInput ||
    typeof bindingInput.sessionId !== 'string' ||
    bindingInput.sessionId.length === 0 ||
    bindingInput.status !== 'active'
  ) {
    fail('VALIDATION_ERROR');
  }
  const binding: AuthSessionBinding = Object.freeze({ ...bindingInput });
  // The caller's object is kept as-is (never copied or frozen) so every service
  // method still runs with its original receiver.
  const services: AuthFlowServices = options.services ?? {};

  interface HeldReceipt {
    receipt: AuthExecutionReceipt;
    proof: LeaseProof;
    sessionId: string;
    grantId: string;
  }
  const receipts = new Map<string, HeldReceipt>();
  const pending = new Set<string>();
  const key = (sessionId: string, grantId: string): string =>
    `${sessionId}\u0000${grantId}`;

  function requireService<K extends keyof AuthFlowServices>(
    name: K,
  ): NonNullable<AuthFlowServices[K]> {
    let service: AuthFlowServices[K];
    try {
      service = services[name];
    } catch (error) {
      // A throwing accessor is a broken service, not a permission to continue.
      throw mapped(error, 'VALIDATION_ERROR');
    }
    if (typeof service !== 'function') {
      // Not implemented yet: stay blocked, never pretend to succeed.
      throw new BridgeError('SERVICE_UNAVAILABLE');
    }
    return service.bind(services) as NonNullable<AuthFlowServices[K]>;
  }

  /** Same lookup for the gate, which reports through PrivateAuthError codes. */
  function optionalService<K extends keyof AuthFlowServices>(
    name: K,
  ): NonNullable<AuthFlowServices[K]> | null {
    let service: AuthFlowServices[K];
    try {
      service = services[name];
    } catch {
      return null;
    }
    return typeof service === 'function'
      ? (service.bind(services) as NonNullable<AuthFlowServices[K]>)
      : null;
  }

  const runtime: AuthFlowRuntime = {
    async material() {
      const service = requireService('material');
      try {
        return await service();
      } catch (error) {
        throw mapped(error, 'AUTH_FAILED');
      }
    },
    async grantAuth(request: AuthActionRequest) {
      if (
        !request ||
        request.sessionId !== binding.sessionId ||
        typeof request.action !== 'string' ||
        typeof request.slot !== 'string'
      ) {
        throw new BridgeError('VALIDATION_ERROR');
      }
      let permit: AuthPermit;
      try {
        permit = await client.grantAuth(lease, {
          requestId: request.requestId,
          sessionId: binding.sessionId,
          action: request.action,
          slot: request.slot,
          ...(request.target ? { target: { ...request.target } } : {}),
        });
      } catch (error) {
        throw mapped(error, 'AUTH_FAILED');
      }
      if (
        !permitMatchesBinding(permit, binding) ||
        permit.action !== request.action ||
        permit.slot !== request.slot ||
        (request.target !== undefined &&
          !sameTarget(permit.target, request.target))
      ) {
        throw new BridgeError('LEASE_EXPIRED');
      }
      return permit;
    },
    async recordAuth(permit: AuthPermit, outcome: AuthRecordOutcome) {
      const held =
        permit && typeof permit.grantId === 'string'
          ? receipts.get(key(permit.sessionId, permit.grantId))
          : undefined;
      // Only the receipt begun for this exact session+grant+proof may settle it.
      if (
        !held ||
        held.proof !== lease ||
        held.sessionId !== binding.sessionId ||
        permit.sessionId !== binding.sessionId
      ) {
        throw new BridgeError('VALIDATION_ERROR');
      }
      try {
        await client.recordAuth(
          lease,
          binding.sessionId,
          permit.grantId,
          held.receipt,
          {
            status: outcome.status,
          },
        );
      } catch (error) {
        throw mapped(error, 'AUTH_FAILED');
      }
    },
    async recordAuthObservation(snapshot: BrowserSnapshot) {
      try {
        await client.recordAuthObservation(lease, binding.sessionId, snapshot);
      } catch (error) {
        throw mapped(error, 'AUTH_FAILED');
      }
    },
    async pauseForOtp() {
      const service = requireService('pauseForOtp');
      try {
        return await service();
      } catch (error) {
        throw mapped(error, 'AUTH_FAILED');
      }
    },
    async recordAuthCriterion(
      snapshot: BrowserSnapshot,
      result: CriterionResult,
    ) {
      const service = requireService('recordAuthCriterion');
      try {
        await service(snapshot, result);
      } catch (error) {
        throw mapped(error, 'AUTH_FAILED');
      }
    },
    async issueCaptureGrant() {
      const service = requireService('issueCaptureGrant');
      let granted: AuthExportGrant;
      try {
        granted = await service();
      } catch (error) {
        throw mapped(error, 'AUTH_FAILED');
      }
      if (!granted || granted.sessionId !== binding.sessionId) {
        throw new BridgeError('LEASE_EXPIRED');
      }
      return granted;
    },
    async captureAuthState(grant: AuthExportGrant, state: ApprovedAuthState) {
      const service = requireService('captureAuthState');
      try {
        return await service(grant, state);
      } catch (error) {
        throw mapped(error, 'AUTH_FAILED');
      }
    },
    async finishSignIn() {
      const service = requireService('finishSignIn');
      try {
        await service();
      } catch (error) {
        throw mapped(error, 'AUTH_FAILED');
      }
    },
    async finishAuth(stateRef: string) {
      const service = requireService('finishAuth');
      if (typeof stateRef !== 'string' || stateRef.length === 0) {
        throw new BridgeError('VALIDATION_ERROR');
      }
      try {
        await service(stateRef);
      } catch (error) {
        throw mapped(error, 'AUTH_FAILED');
      }
    },
  };

  const gate: AuthExecutionGate = {
    async authorize(input) {
      if (input?.binding?.sessionId !== binding.sessionId) {
        throw new PrivateAuthError('LEASE_EXPIRED');
      }
      const permit = input.permit;
      if (!permitMatchesBinding(permit, binding)) {
        throw new PrivateAuthError('LEASE_EXPIRED');
      }
      const receiptKey = key(binding.sessionId, permit.grantId);
      // One begin per grant: a second attempt is refused locally as well.
      if (receipts.has(receiptKey) || pending.has(receiptKey)) {
        throw new PrivateAuthError('VALIDATION_ERROR');
      }
      pending.add(receiptKey);
      try {
        const receipt = await client.beginAuthExecution(
          lease,
          binding.sessionId,
          permit.grantId,
        );
        if (
          !receipt ||
          receipt.grantId !== permit.grantId ||
          typeof receipt.executionId !== 'string' ||
          receipt.executionId.length === 0
        ) {
          throw new BridgeError('VALIDATION_ERROR');
        }
        receipts.set(receiptKey, {
          receipt,
          proof: lease,
          sessionId: binding.sessionId,
          grantId: permit.grantId,
        });
      } catch (error) {
        throw portError(error);
      } finally {
        pending.delete(receiptKey);
      }
    },
    async authorizeExport(input) {
      if (input?.binding?.sessionId !== binding.sessionId) {
        throw new PrivateAuthError('LEASE_EXPIRED');
      }
      const granted = input.grant;
      if (
        !granted ||
        typeof granted.grantId !== 'string' ||
        granted.grantId.length === 0 ||
        granted.sessionId !== binding.sessionId
      ) {
        throw new PrivateAuthError('LEASE_EXPIRED');
      }
      const service = optionalService('authorizeExport');
      if (!service) {
        // No capture-ticket CAS service yet: the export stays blocked.
        throw new PrivateAuthError('VALIDATION_ERROR');
      }
      try {
        await service(granted);
      } catch (error) {
        throw portError(error);
      }
    },
  };

  return { runtime, gate };
}

function sameTarget(
  left: AuthPermit['target'],
  right: NonNullable<AuthPermit['target']>,
): boolean {
  return Boolean(
    left &&
    left.snapshotId === right.snapshotId &&
    left.pageId === right.pageId &&
    left.nodeId === right.nodeId &&
    (left.frameId ?? 'main') === (right.frameId ?? 'main'),
  );
}
