import { randomUUID } from 'node:crypto';
import { ERROR_CODES } from '@localqa/contracts';
import type {
  AuthProfile,
  BrowserSnapshot,
  CredentialMaterial,
  Criterion,
  CriterionResult,
  JsonValue,
  Locator,
  NodeTarget,
} from '@localqa/contracts';
import { STABLE_REASON_CODES } from '@localqa/browser';
import type {
  ApprovedAuthState,
  AuthEffect,
  AuthExportGrant,
  AuthPermit,
  AuthSessionBinding,
  PrivateAuthPort,
} from '@localqa/browser';

/** The four private auth actions. The model has no entry to any of them. */
export type AuthActionName =
  'navigate_auth' | 'fill_credential' | 'submit_auth' | 'import_storage_state';
export type AuthActionSlot =
  'login_url' | 'username' | 'password' | 'otp' | 'submit' | 'storage_state';

/** Same shape as the AUTH-5 private request: no URL, secret, state, or code. */
export interface AuthActionRequest {
  requestId: string;
  sessionId: string;
  action: AuthActionName;
  slot: AuthActionSlot;
  target?: NodeTarget;
}

export interface AuthRecordOutcome {
  status: 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  reasonCode: string;
}

/** One-shot private OTP handle. Real ciphertext tickets stay server-side. */
export interface AuthOtpMaterial {
  code: string;
}

/** Private capture handle issued by the trusted Runtime, opaque here. */
export interface AuthCaptureReceipt {
  stateRef: string;
}

/**
 * Trusted Worker-facing Runtime. Every method is a private service boundary:
 * the adapter never defaults to allowed and the model never sees these calls.
 * Production wiring supplies server-owned permits, OTP tickets and capture
 * gates; pure flow tests inject an explicitly labeled Fake Runtime.
 */
export interface AuthFlowRuntime {
  /** Local-memory credential material for this proof/profile. */
  material(): Promise<CredentialMaterial>;
  /**
   * Server-derived permit; the port gate calls beginAuthExecution. The permit
   * carries the full AUTH-5 binding tuple (context/profile/version/epoch/
   * purpose) and this adapter never fabricates or downgrades those fields.
   */
  grantAuth(request: AuthActionRequest): Promise<AuthPermit>;
  /**
   * Private ledger write for one action. The real adapter attaches the begin
   * receipt from the gate and forwards to the auth service method; it must not
   * fall back to the ordinary recordAction/HTTP result channel, which rejects
   * auth intents.
   */
  recordAuth(permit: AuthPermit, outcome: AuthRecordOutcome): Promise<void>;
  /** Registers the redacted observation that gives the next permit provenance. */
  recordAuthObservation(snapshot: BrowserSnapshot): Promise<void>;
  /** Exactly one private OTP wait that keeps the current lease/context. */
  pauseForOtp(): Promise<AuthOtpMaterial>;
  recordAuthCriterion(
    snapshot: BrowserSnapshot,
    result: CriterionResult,
  ): Promise<void>;
  issueCaptureGrant(): Promise<AuthExportGrant>;
  captureAuthState(
    grant: AuthExportGrant,
    state: ApprovedAuthState,
  ): Promise<AuthCaptureReceipt>;
  finishAuth(stateRef: string): Promise<void>;
}

/**
 * Fresh-observation handshake: a trusted adapter resolves the locator against
 * the snapshot it actually observed and returns both, so the flow can redact and
 * register that real snapshot before granting a permit for it.
 */
export interface AuthFreshObservation {
  snapshot: BrowserSnapshot;
  target: NodeTarget;
}

/**
 * Trusted adapters return targets bound to observations. AI identification
 * calls the server's frozen model; action permits remain in the private flow.
 */
export interface AuthFlowAdapters {
  identify?(
    snapshot: BrowserSnapshot,
    slot: 'username' | 'password' | 'submit' | 'otp',
    signal: AbortSignal,
  ): Promise<AuthFreshObservation | null>;
  evaluateAiSuccess?(
    snapshot: BrowserSnapshot,
    signal: AbortSignal,
  ): Promise<{ snapshot: BrowserSnapshot; result: CriterionResult }>;
  locate(
    snapshot: BrowserSnapshot,
    locator: Locator,
    signal: AbortSignal,
  ): Promise<NodeTarget | null>;
  /**
   * Preferred when present: resolves against a fresh observation and hands that
   * observation back instead of rewriting its identity onto an older snapshot.
   */
  locateFresh?(
    snapshot: BrowserSnapshot,
    locator: Locator,
    signal: AbortSignal,
  ): Promise<AuthFreshObservation | null>;
  evaluate(
    snapshot: BrowserSnapshot,
    criterion: Criterion,
    signal: AbortSignal,
  ): Promise<CriterionResult>;
}

export interface AuthFlowOptions {
  /** Frozen profile. `mode: 'none'` never touches material or the port. */
  profile: AuthProfile;
  /** Active private authority binding (AUTH-5). */
  binding: AuthSessionBinding;
  runtime: AuthFlowRuntime;
  /** Required for form/storage_state; unused and untouched for `none`. */
  port?: PrivateAuthPort | undefined;
  adapters: AuthFlowAdapters;
  /** Frozen criterion; only `storage_state` profiles take it from here. */
  criterion?: Criterion | undefined;
  newRequestId?: (() => string) | undefined;
  now?: (() => number) | undefined;
}

export type AuthFlowStatus =
  'succeeded' | 'blocked' | 'cancelled' | 'not_required';

export interface AuthFlowStep {
  action: AuthActionName;
  slot: AuthActionSlot;
  status: 'succeeded' | 'failed';
  reasonCode: string;
}

export interface AuthFlowOutcome {
  status: AuthFlowStatus;
  /** Constant machine code only; never a message, page body, or secret. */
  reasonCode: string;
  steps: readonly AuthFlowStep[];
  /** Private capture handle, present only after finish. Not a model value. */
  stateRef: string | null;
}

class Stop extends Error {
  constructor(
    readonly status: AuthFlowStatus,
    readonly code: string,
  ) {
    super(code);
  }
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Explicit allowlist: service ErrorCodes, browser executor codes, port abort. */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ...ERROR_CODES,
  ...Object.values(STABLE_REASON_CODES),
  'CANCELLED',
]);

/**
 * Reads `error.code` without touching `error.message`. A throwing getter or an
 * unknown/raw code (which could be material) becomes null and falls back to a
 * constant code, so no free-form text ever reaches an outcome.
 */
function knownCode(error: unknown): string | null {
  let code: unknown;
  try {
    code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
  } catch {
    return null;
  }
  return typeof code === 'string' && KNOWN_ERROR_CODES.has(code) ? code : null;
}

function failure(error: unknown, fallback: string): Stop {
  if (error instanceof Stop) return error;
  const code = knownCode(error);
  if (code === 'CANCELLED' || code === 'USER_CANCELLED') {
    return new Stop('cancelled', 'CANCELLED');
  }
  return new Stop('blocked', code ?? fallback);
}

function isRecord(value: JsonValue | undefined): value is {
  [key: string]: JsonValue | undefined;
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical storage_state material: the JSON string that resolveAuth returns,
 * or a plain approved object. Alternate key names are never accepted, and the
 * value is passed on untouched so the private port's validator (not this
 * adapter) rejects accessors, cycles, and foreign origins.
 */
function isCanonicalStorageState(value: JsonValue | undefined): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (!isRecord(value)) return false;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/**
 * Authentication over the private port: navigate, identify and fill fields,
 * submit, optionally complete one OTP, verify success, capture and finish.
 * AI forms can advance once from an account page to a separate password page.
 *
 * Failures stop the flow: no loop, no second OTP request, no fabricated pass.
 * The outcome and every error carry constant codes only. Manual forms use a
 * configured success criterion; AI forms need server-validated success evidence.
 * The real OTP and capture-ticket services are supplied by the trusted
 * adapters, not by the model or this pure flow.
 *
 * Supported scope of this batch:
 * - `form` and `storage_state` profiles over the AUTH-5 private port only.
 * - storage_state material is the canonical `material.storageState` that
 *   LeaseRepository.resolveAuth returns (a JSON string, or a plain approved
 *   object). No other key is accepted, nothing is parsed or normalized here,
 *   and the private port's approved-state validator decides validity.
 * - Targets and criteria come from the frozen profile or trusted AI recognition
 *   (storage_state takes the frozen `criterion` option), using a current snapshot;
 *   a target outside that snapshot, a missing resolver, or a criterion that is
 *   absent or not evaluated is blocked. Criteria that need a model or an image
 *   (semantic/visual) are only as supported as the injected evaluator: they
 *   must answer `not_evaluated`/`unknown` rather than guess.
 * - `none` profiles return not_required without material or a private port.
 * No model ToolCall, no `type_text` password, no distributed exactly-once.
 */
export async function runAuthFlow(
  options: AuthFlowOptions,
  signal: AbortSignal,
): Promise<AuthFlowOutcome> {
  const steps: AuthFlowStep[] = [];
  const mode = options.profile?.mode;
  // Never let evidence assembly throw: a bad copy/freeze lands as an empty
  // step list, and the outcome code still comes from the flow itself.
  const finish = (
    status: AuthFlowStatus,
    reasonCode: string,
    stateRef: string | null = null,
  ): AuthFlowOutcome => {
    let frozen: readonly AuthFlowStep[];
    try {
      frozen = freeze(copy(steps));
    } catch {
      frozen = Object.freeze([]);
    }
    return Object.freeze({ status, reasonCode, steps: frozen, stateRef });
  };

  // `none` is not an authentication: no material, no port, no adapter call.
  if (mode === 'none') return finish('not_required', 'AUTH_MODE_NONE');
  const port = options.port;
  const { runtime, adapters, binding } = options;
  const newRequestId = options.newRequestId ?? ((): string => randomUUID());
  const now = options.now ?? Date.now;

  function requirePort(): PrivateAuthPort {
    if (!port) throw new Stop('blocked', 'PRIVATE_PORT_MISSING');
    return port;
  }

  function check(): void {
    if (signal.aborted) throw new Stop('cancelled', 'CANCELLED');
  }

  /**
   * Registers the actual fresh observation a locator resolved against: the
   * snapshot is redacted through the private port (already-known secrets only)
   * and then recorded, so the next permit carries that snapshot's real id
   * instead of a rewritten one.
   */
  async function registerFresh(
    observed: AuthFreshObservation,
  ): Promise<NodeTarget> {
    const fresh = observed?.snapshot;
    const target = observed?.target;
    if (
      !fresh ||
      !target ||
      target.snapshotId !== fresh.snapshotId ||
      target.pageId !== fresh.pageId
    ) {
      throw new Stop('blocked', 'TARGET_NOT_IN_SNAPSHOT');
    }
    const frameId = target.frameId ?? 'main';
    const node = fresh.nodes?.find(
      (candidate) =>
        candidate.nodeId === target.nodeId &&
        (candidate.frameId ?? 'main') === frameId,
    );
    if (!node) throw new Stop('blocked', 'TARGET_NOT_FOUND');
    check();
    const redacted = requirePort().redactObservation(fresh);
    if (
      redacted.snapshotId !== fresh.snapshotId ||
      redacted.pageId !== fresh.pageId
    ) {
      throw new Stop('blocked', 'OBSERVATION_MISMATCH');
    }
    try {
      await runtime.recordAuthObservation(redacted);
    } catch (error) {
      throw failure(error, 'OBSERVATION_FAILED');
    }
    return target;
  }

  /**
   * Resolves a target. A trusted adapter may hand back the fresh observation the
   * locator actually used; otherwise the target must belong to the snapshot the
   * flow already holds. A target from another snapshot is refused, never
   * rewritten onto this one.
   */
  async function locateOrNull(
    snapshot: BrowserSnapshot,
    locator: Locator | undefined,
  ): Promise<NodeTarget | null> {
    check();
    if (!locator) throw new Stop('blocked', 'RESOLVER_UNAVAILABLE');
    if (typeof adapters.locateFresh === 'function') {
      let observed: AuthFreshObservation | null;
      try {
        observed = await adapters.locateFresh(snapshot, locator, signal);
      } catch (error) {
        throw failure(error, 'RESOLVER_ERROR');
      }
      if (!observed) return null;
      return registerFresh(observed);
    }
    if (typeof adapters.locate !== 'function') {
      throw new Stop('blocked', 'RESOLVER_UNAVAILABLE');
    }
    let target: NodeTarget | null;
    try {
      target = await adapters.locate(snapshot, locator, signal);
    } catch (error) {
      throw failure(error, 'RESOLVER_ERROR');
    }
    if (!target) return null;
    if (
      target.snapshotId !== snapshot.snapshotId ||
      target.pageId !== snapshot.pageId
    ) {
      throw new Stop('blocked', 'TARGET_NOT_IN_SNAPSHOT');
    }
    return target;
  }

  async function locate(
    snapshot: BrowserSnapshot,
    locator: Locator | undefined,
  ): Promise<NodeTarget> {
    const target = await locateOrNull(snapshot, locator);
    if (!target) throw new Stop('blocked', 'TARGET_NOT_RESOLVED');
    return target;
  }

  function sameTarget(left: NodeTarget, right: NodeTarget): boolean {
    return (
      left.snapshotId === right.snapshotId &&
      left.pageId === right.pageId &&
      left.nodeId === right.nodeId &&
      (left.frameId ?? 'main') === (right.frameId ?? 'main')
    );
  }

  async function grant(
    action: AuthActionName,
    slot: AuthActionSlot,
    target?: NodeTarget,
  ): Promise<AuthPermit> {
    check();
    let permit: AuthPermit;
    try {
      permit = await runtime.grantAuth({
        requestId: newRequestId(),
        sessionId: binding.sessionId,
        action,
        slot,
        ...(target ? { target } : {}),
      });
    } catch (error) {
      throw failure(error, 'GRANT_FAILED');
    }
    if (
      !permit ||
      permit.sessionId !== binding.sessionId ||
      permit.action !== action ||
      permit.slot !== slot ||
      (target !== undefined &&
        (!permit.target || !sameTarget(permit.target, target)))
    ) {
      throw new Stop('blocked', 'GRANT_MISMATCH');
    }
    return permit;
  }

  async function record(
    permit: AuthPermit,
    status: AuthRecordOutcome['status'],
    reasonCode: string,
    fallback: string,
  ): Promise<void> {
    try {
      await runtime.recordAuth(permit, { status, reasonCode });
    } catch (error) {
      throw failure(error, fallback);
    }
  }

  /** One action: grant -> port execution -> record -> observation. */
  async function perform(
    action: AuthActionName,
    slot: AuthActionSlot,
    effect: AuthEffect,
    target?: NodeTarget,
  ): Promise<BrowserSnapshot | null> {
    // In production the Worker heartbeat advances the DB-backed private
    // session TTL. Refresh its browser-side snapshot using only the trusted
    // Runtime (never a model/page-supplied timestamp) before any new grant.
    if (requirePort().renewAuthority) {
      try {
        await requirePort().renewAuthority!();
      } catch (error) {
        throw failure(error, 'LEASE_EXPIRED');
      }
    }
    const permit = await grant(action, slot, target);
    let snapshot: BrowserSnapshot | null;
    try {
      check();
      const result = await requirePort().executeAuth(permit, effect, signal);
      snapshot = result.snapshot;
    } catch (error) {
      const stop = failure(error, 'ACTION_FAILED');
      steps.push({ action, slot, status: 'failed', reasonCode: stop.code });
      await record(
        permit,
        stop.status === 'cancelled' ? 'cancelled' : 'failed',
        stop.code,
        'RECORD_FAILED',
      ).catch(() => undefined);
      throw stop;
    }
    await record(permit, 'succeeded', 'AUTH_ACTION_SUCCEEDED', 'RECORD_FAILED');
    steps.push({
      action,
      slot,
      status: 'succeeded',
      reasonCode: 'AUTH_ACTION_SUCCEEDED',
    });
    if (snapshot) {
      try {
        check();
        await runtime.recordAuthObservation(snapshot);
      } catch (error) {
        throw failure(error, 'OBSERVATION_FAILED');
      }
    }
    return snapshot;
  }

  function requireSnapshot(
    snapshot: BrowserSnapshot | null,
    code = 'SNAPSHOT_MISSING',
  ): BrowserSnapshot {
    if (!snapshot) throw new Stop('blocked', code);
    return snapshot;
  }

  async function criterion(
    snapshot: BrowserSnapshot,
    configured: Criterion | undefined,
  ): Promise<void> {
    const target = configured;
    if (!target || typeof target.id !== 'string' || target.id.length === 0) {
      throw new Stop('blocked', 'CRITERION_NOT_CONFIGURED');
    }
    if (typeof adapters.evaluate !== 'function') {
      throw new Stop('blocked', 'CRITERION_UNSUPPORTED');
    }
    check();
    let result: CriterionResult;
    try {
      result = await adapters.evaluate(snapshot, target, signal);
    } catch (error) {
      throw failure(error, 'CRITERION_UNSUPPORTED');
    }
    if (!result || result.criterionId !== target.id) {
      throw new Stop('blocked', 'CRITERION_RESULT_MISMATCH');
    }
    try {
      await runtime.recordAuthCriterion(snapshot, result);
    } catch (error) {
      throw failure(error, 'CRITERION_RECORD_FAILED');
    }
    if (result.result === 'not_evaluated') {
      throw new Stop('blocked', 'CRITERION_NOT_EVALUATED');
    }
    if (result.result === 'unknown') {
      throw new Stop('blocked', 'CRITERION_UNKNOWN');
    }
    if (result.result !== 'passed') {
      throw new Stop('blocked', 'CRITERION_FAILED');
    }
  }

  /** Capture and finish. Every step must succeed for the flow to succeed. */
  async function captureAndFinish(): Promise<string> {
    check();
    if (requirePort().renewAuthority) {
      try {
        await requirePort().renewAuthority!();
      } catch (error) {
        throw failure(error, 'LEASE_EXPIRED');
      }
    }
    let granted: AuthExportGrant;
    try {
      granted = await runtime.issueCaptureGrant();
    } catch (error) {
      throw failure(error, 'CAPTURE_GRANT_FAILED');
    }
    if (
      !granted ||
      typeof granted.grantId !== 'string' ||
      granted.grantId.length === 0 ||
      granted.sessionId !== binding.sessionId
    ) {
      throw new Stop('blocked', 'CAPTURE_GRANT_MISMATCH');
    }
    let state: ApprovedAuthState;
    try {
      state = await requirePort().exportAuthState(granted, signal);
    } catch (error) {
      throw failure(error, 'EXPORT_FAILED');
    }
    let receipt: AuthCaptureReceipt;
    try {
      receipt = await runtime.captureAuthState(granted, state);
    } catch (error) {
      throw failure(error, 'CAPTURE_FAILED');
    }
    const stateRef = receipt?.stateRef;
    if (typeof stateRef !== 'string' || stateRef.length === 0) {
      throw new Stop('blocked', 'CAPTURE_RECEIPT_INVALID');
    }
    check();
    try {
      await runtime.finishAuth(stateRef);
    } catch (error) {
      throw failure(error, 'FINISH_FAILED');
    }
    return stateRef;
  }

  async function material(): Promise<CredentialMaterial> {
    check();
    let value: CredentialMaterial;
    try {
      value = await runtime.material();
    } catch (error) {
      throw failure(error, 'MATERIAL_UNAVAILABLE');
    }
    if (!value || value.mode !== mode) {
      throw new Stop('blocked', 'MATERIAL_MODE_MISMATCH');
    }
    if (
      typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= now()
    ) {
      throw new Stop('blocked', 'MATERIAL_EXPIRED');
    }
    return value;
  }

  async function formFlow(): Promise<string> {
    const form = options.profile.formConfig;
    if (!form) throw new Stop('blocked', 'FORM_CONFIG_MISSING');
    const ai = form.detectionMode === 'ai';
    const field = async (
      snapshot: BrowserSnapshot,
      slot: 'username' | 'password' | 'submit' | 'otp',
      locator: Locator | undefined,
      optional = false,
    ): Promise<NodeTarget | null> => {
      if (!ai)
        return optional
          ? locateOrNull(snapshot, locator)
          : locate(snapshot, locator);
      if (!adapters.identify) throw new Stop('blocked', 'RESOLVER_UNAVAILABLE');
      const observed = await adapters.identify(snapshot, slot, signal);
      if (observed) return registerFresh(observed);
      if (optional) return null;
      throw new Stop('blocked', 'TARGET_NOT_RESOLVED');
    };
    const value = await material();
    const username = value.material?.username;
    const password = value.material?.password;
    if (
      typeof username !== 'string' ||
      username.length === 0 ||
      typeof password !== 'string' ||
      password.length === 0
    ) {
      throw new Stop('blocked', 'MATERIAL_INVALID');
    }
    // Register the known credentials before any browser effect: the first
    // snapshot after the login navigation may already show an auto-filled
    // username/password, and the port can only redact what it knows.
    requirePort().primeSensitiveValues([username, password]);
    const landed = requireSnapshot(
      await perform('navigate_auth', 'login_url', { kind: 'navigate' }),
    );
    const filledUser = requireSnapshot(
      await perform(
        'fill_credential',
        'username',
        { kind: 'fill', secret: username },
        (await field(landed, 'username', form.usernameTarget))!,
      ),
    );
    let passwordPage = filledUser;
    let passwordTarget = await field(
      passwordPage,
      'password',
      form.passwordTarget,
      ai,
    );
    if (!passwordTarget && ai) {
      // Ordinary two-step login: account -> Next -> password. This stays
      // inside the private auth permit path and never executes model tools.
      passwordPage = requireSnapshot(
        await perform(
          'submit_auth',
          'submit',
          { kind: 'submit' },
          (await field(passwordPage, 'submit', form.submitTarget))!,
        ),
      );
      passwordTarget = await field(
        passwordPage,
        'password',
        form.passwordTarget,
      );
    }
    if (!passwordTarget) throw new Stop('blocked', 'TARGET_NOT_RESOLVED');
    const filledPassword = requireSnapshot(
      await perform(
        'fill_credential',
        'password',
        { kind: 'fill', secret: password },
        passwordTarget,
      ),
    );
    let current = requireSnapshot(
      await perform(
        'submit_auth',
        'submit',
        { kind: 'submit' },
        (await field(filledPassword, 'submit', form.submitTarget))!,
      ),
    );
    // At most one OTP wait, and only when the profile configures an otpTarget
    // that resolves in the current snapshot. A later criterion failure never
    // returns here.
    if (form.otpTarget || ai) {
      const otpTarget = await field(current, 'otp', form.otpTarget, true);
      if (otpTarget) {
        check();
        let otp: AuthOtpMaterial;
        try {
          otp = await runtime.pauseForOtp();
        } catch (error) {
          throw failure(error, 'OTP_UNAVAILABLE');
        }
        const code = otp?.code;
        if (typeof code !== 'string' || code.length === 0) {
          throw new Stop('blocked', 'OTP_UNAVAILABLE');
        }
        const filledOtp = requireSnapshot(
          await perform(
            'fill_credential',
            'otp',
            { kind: 'fill', secret: code },
            otpTarget,
          ),
        );
        current = requireSnapshot(
          await perform(
            'submit_auth',
            'submit',
            { kind: 'submit' },
            (await field(filledOtp, 'submit', form.submitTarget))!,
          ),
        );
      }
    }
    if (ai) {
      if (!adapters.evaluateAiSuccess)
        throw new Stop('blocked', 'CRITERION_UNSUPPORTED');
      const observed = await adapters.evaluateAiSuccess(current, signal);
      check();
      const clean = requirePort().redactObservation(observed.snapshot);
      if (
        clean.pageId !== current.pageId ||
        observed.result.criterionId !== 'login_success' ||
        observed.result.result !== 'passed' ||
        observed.result.evidenceRefs.length === 0 ||
        !observed.result.evidenceRefs.every((ref) => ref === clean.snapshotId)
      )
        throw new Stop('blocked', 'CRITERION_FAILED');
      await runtime.recordAuthObservation(clean);
      await runtime.recordAuthCriterion(clean, observed.result);
    } else {
      await criterion(current, form.successCriterion);
    }
    return captureAndFinish();
  }

  async function storageFlow(): Promise<string> {
    const value = await material();
    // resolveAuth ships `{storageState: "<json>"}`; that exact key is the only
    // accepted source, and the private port validates the raw shape.
    const state = value.material?.storageState;
    if (!isCanonicalStorageState(state)) {
      throw new Stop('blocked', 'MATERIAL_INVALID');
    }
    // Injection goes through the private port only; it never navigates.
    await perform('import_storage_state', 'storage_state', {
      kind: 'prepare_state',
      state,
    });
    const landed = requireSnapshot(
      await perform('navigate_auth', 'login_url', { kind: 'navigate' }),
    );
    // A storage_state profile carries no formConfig, so the caller supplies the
    // frozen criterion; without one the flow is blocked, never passed.
    await criterion(landed, options.criterion);
    return captureAndFinish();
  }

  try {
    if (mode !== 'form' && mode !== 'storage_state') {
      throw new Stop('blocked', 'AUTH_MODE_UNSUPPORTED');
    }
    if (!options.profile) throw new Stop('blocked', 'AUTH_PROFILE_MISSING');
    if (options.profile.status !== 'active') {
      throw new Stop('blocked', 'AUTH_PROFILE_NOT_ACTIVE');
    }
    if (binding?.status !== 'active' || !binding.sessionId) {
      throw new Stop('blocked', 'SESSION_NOT_ACTIVE');
    }
    // The port instance must belong to the same session as the binding.
    if (requirePort().sessionId !== binding.sessionId) {
      throw new Stop('blocked', 'SESSION_MISMATCH');
    }
    const stateRef = mode === 'form' ? await formFlow() : await storageFlow();
    return finish('succeeded', 'AUTH_SUCCEEDED', stateRef);
  } catch (error) {
    const stop = failure(error, 'AUTH_FLOW_ERROR');
    return finish(stop.status, stop.code);
  } finally {
    // The session is discarded on every path; material is never reused after.
    try {
      await port?.close();
    } catch {
      // Closing cannot change an outcome that is already decided.
    }
  }
}
