import type { BrowserSnapshot, NodeTarget } from '@localqa/contracts';
import { AuthStateError, validateApprovedAuthState } from './auth-state.js';
import type { ApprovedAuthState } from './types.js';

export type AuthSessionStatus = 'allocated' | 'active' | 'ended' | 'revoked';

export interface AuthSessionBinding {
  sessionId: string;
  projectId: string;
  runId: string;
  taskId: string;
  workerId: string;
  fencingToken: number;
  contextVersion: number;
  contextId: string;
  profileId: string;
  profileVersion: number;
  authEpoch: number;
  purpose: 'initializer' | 'importer';
  /**
   * Only an activated session may reach the private port. This rejects
   * allocated/ended/revoked bindings by mistake; it never replaces the
   * per-call server gate check.
   */
  status: AuthSessionStatus;
  expiresAt: string;
}

export type AuthExportKind = 'capture_auth_state';

/**
 * Private authorization for one state capture. `captureTicket` is issued by the
 * trusted Runtime and must only cross the private gate boundary: it never goes
 * into a snapshot, Step, ToolCall, event, report, or log.
 */
export interface AuthExportGrant extends AuthSessionBinding {
  grantId: string;
  deadline: string;
  kind: AuthExportKind;
  captureTicket: string;
}

export interface AuthPermit {
  grantId: string;
  sessionId: string;
  projectId: string;
  runId: string;
  taskId: string;
  workerId: string;
  fencingToken: number;
  contextVersion: number;
  contextId: string;
  profileId: string;
  profileVersion: number;
  authEpoch: number;
  purpose: 'initializer' | 'importer';
  deadline: string;
  action:
    | 'navigate_auth'
    | 'fill_credential'
    | 'submit_auth'
    | 'import_storage_state';
  slot:
    | 'login_url'
    | 'username'
    | 'password'
    | 'otp'
    | 'variable'
    | 'submit'
    | 'storage_state';
  // Explicit `| undefined` keeps this assignable from the orchestrator's permit
  // under `exactOptionalPropertyTypes`.
  target?: NodeTarget | undefined;
  url?: string | undefined;
}

export type AuthEffect =
  | { kind: 'navigate' }
  | { kind: 'fill'; secret: string }
  | { kind: 'submit' }
  | { kind: 'prepare_state'; state: unknown };

export interface AuthExecutionGate {
  authorize(input: {
    binding: AuthSessionBinding;
    permit: AuthPermit;
  }): Promise<void>;
  /** Required. There is no default-allow export path. */
  authorizeExport(input: {
    binding: AuthSessionBinding;
    grant: AuthExportGrant;
  }): Promise<void>;
}

/** Trusted browser primitives. Callers must not pass ToolCall objects here. */
export interface TrustedAuthPrimitives {
  navigate(url: string): Promise<BrowserSnapshot>;
  fill(target: NodeTarget, secret: string): Promise<BrowserSnapshot>;
  submit(target: NodeTarget): Promise<BrowserSnapshot>;
  prepareState(state: ApprovedAuthState): Promise<void>;
  exportState(): Promise<ApprovedAuthState>;
  /** Release browser-local auth guards without closing the task's context. */
  close?(): Promise<void>;
}

export interface PrivateAuthPort {
  readonly sessionId: string;
  /**
   * Optional, trusted server-side lease refresh. It has no caller-supplied
   * expiry or identity parameters: only the sealed Worker authority may
   * produce the new binding, with all identity fields held constant.
   */
  renewAuthority?(): Promise<void>;
  /**
   * Registers known sensitive values before any browser effect, so the first
   * snapshot after a navigation cannot expose material that the page already
   * contains (pre-filled or auto-filled fields, echoed URLs, titles).
   *
   * Private by construction: this is not a ToolCall, has no model entry point,
   * and the values stay in this instance's closure. Rejects after close and
   * never echoes a rejected value.
   */
  primeSensitiveValues(values: readonly string[]): void;
  /**
   * Pure redaction of a snapshot observed outside `executeAuth` (for example a
   * fresh locator observation). It uses only the already-registered secrets and
   * filled targets, performs no navigation and calls no primitive, and returns a
   * detached scrubbed copy — never a flag flipped on the raw observation.
   */
  redactObservation(snapshot: BrowserSnapshot): BrowserSnapshot;
  executeAuth(
    permit: AuthPermit,
    effect: AuthEffect,
    signal: AbortSignal,
  ): Promise<{ snapshot: BrowserSnapshot | null }>;
  exportAuthState(
    grant: AuthExportGrant,
    signal?: AbortSignal,
  ): Promise<ApprovedAuthState>;
  close(): Promise<void>;
}

export class PrivateAuthError extends Error {
  readonly code: 'VALIDATION_ERROR' | 'LEASE_EXPIRED' | 'CANCELLED';
  constructor(code: 'VALIDATION_ERROR' | 'LEASE_EXPIRED' | 'CANCELLED') {
    super(code);
    this.name = 'PrivateAuthError';
    this.code = code;
  }
}

const FILL_SLOTS = new Set(['username', 'password', 'otp', 'variable']);

function fail(code: PrivateAuthError['code']): never {
  throw new PrivateAuthError(code);
}

function positiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function parseTime(value: string): number {
  if (typeof value !== 'string' || value.length === 0) fail('VALIDATION_ERROR');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('VALIDATION_ERROR');
  return parsed;
}

function assertBindingShape(binding: AuthSessionBinding): void {
  if (
    !binding ||
    typeof binding.sessionId !== 'string' ||
    binding.sessionId.length === 0 ||
    typeof binding.projectId !== 'string' ||
    typeof binding.runId !== 'string' ||
    typeof binding.taskId !== 'string' ||
    typeof binding.workerId !== 'string' ||
    typeof binding.contextId !== 'string' ||
    typeof binding.profileId !== 'string' ||
    !positiveInt(binding.fencingToken) ||
    !positiveInt(binding.contextVersion) ||
    !positiveInt(binding.profileVersion) ||
    !positiveInt(binding.authEpoch) ||
    (binding.purpose !== 'initializer' && binding.purpose !== 'importer') ||
    binding.status !== 'active'
  ) {
    fail('VALIDATION_ERROR');
  }
  parseTime(binding.expiresAt);
}

const GRANT_KEYS = new Set<string>([
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
  'grantId',
  'deadline',
  'kind',
  'captureTicket',
]);

function assertGrantShape(grant: AuthExportGrant): void {
  assertBindingShape(grant);
  if (
    typeof grant.grantId !== 'string' ||
    grant.grantId.length === 0 ||
    grant.kind !== 'capture_auth_state' ||
    typeof grant.captureTicket !== 'string' ||
    grant.captureTicket.length === 0
  ) {
    fail('VALIDATION_ERROR');
  }
  for (const key of Reflect.ownKeys(grant)) {
    if (typeof key !== 'string' || !GRANT_KEYS.has(key))
      fail('VALIDATION_ERROR');
  }
  parseTime(grant.deadline);
}

/** The frozen identity tuple every permit and grant must match exactly. */
type AuthBindingTuple = Pick<
  AuthSessionBinding,
  | 'sessionId'
  | 'projectId'
  | 'runId'
  | 'taskId'
  | 'workerId'
  | 'fencingToken'
  | 'contextVersion'
  | 'contextId'
  | 'profileId'
  | 'profileVersion'
  | 'authEpoch'
  | 'purpose'
>;

function sameBinding(
  candidate: AuthBindingTuple,
  binding: AuthBindingTuple,
): boolean {
  return (
    candidate.sessionId === binding.sessionId &&
    candidate.projectId === binding.projectId &&
    candidate.runId === binding.runId &&
    candidate.taskId === binding.taskId &&
    candidate.workerId === binding.workerId &&
    candidate.fencingToken === binding.fencingToken &&
    candidate.contextVersion === binding.contextVersion &&
    candidate.contextId === binding.contextId &&
    candidate.profileId === binding.profileId &&
    candidate.profileVersion === binding.profileVersion &&
    candidate.authEpoch === binding.authEpoch &&
    candidate.purpose === binding.purpose
  );
}

function assertLive(now: number, deadline: string, expiresAt: string): void {
  const deadlineAt = parseTime(deadline);
  const expires = parseTime(expiresAt);
  if (deadlineAt > expires) fail('VALIDATION_ERROR');
  if (now >= deadlineAt || now >= expires) fail('LEASE_EXPIRED');
}

function assertEffect(permit: AuthPermit, effect: AuthEffect): void {
  if (permit.action === 'navigate_auth') {
    if (
      effect.kind !== 'navigate' ||
      permit.slot !== 'login_url' ||
      typeof permit.url !== 'string' ||
      permit.url.length === 0
    ) {
      fail('VALIDATION_ERROR');
    }
    return;
  }
  if (permit.action === 'fill_credential') {
    if (
      effect.kind !== 'fill' ||
      !FILL_SLOTS.has(permit.slot) ||
      !permit.target ||
      typeof effect.secret !== 'string' ||
      effect.secret.length === 0
    ) {
      fail('VALIDATION_ERROR');
    }
    return;
  }
  if (permit.action === 'submit_auth') {
    if (
      effect.kind !== 'submit' ||
      permit.slot !== 'submit' ||
      !permit.target
    ) {
      fail('VALIDATION_ERROR');
    }
    return;
  }
  if (permit.action === 'import_storage_state') {
    if (effect.kind !== 'prepare_state' || permit.slot !== 'storage_state') {
      fail('VALIDATION_ERROR');
    }
    return;
  }
  fail('VALIDATION_ERROR');
}

/** Auth permits never expand approved network scope. Compare exact protocol,
 * host, and port, before invoking the gate or any browser effect. */
function assertAllowedAuthUrl(
  url: string,
  allowedOrigins: readonly string[],
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AuthStateError('TARGET_NOT_ALLOWED');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !allowedOrigins.some((approved) => {
      try {
        const candidate = new URL(approved);
        return (
          ['http:', 'https:'].includes(candidate.protocol) &&
          candidate.username === '' &&
          candidate.password === '' &&
          candidate.origin === parsed.origin
        );
      } catch {
        return false;
      }
    })
  ) {
    throw new AuthStateError('TARGET_NOT_ALLOWED');
  }
}

function cloneValue<T>(
  value: T,
  ancestors = new WeakSet<object>(),
  depth = 0,
): T {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 32 || ancestors.has(value)) fail('VALIDATION_ERROR');
  const isArray = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    fail('VALIDATION_ERROR');
  }
  const copy: object = isArray ? [] : Object.create(null);
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string') fail('VALIDATION_ERROR');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        fail('VALIDATION_ERROR');
      }
      Object.defineProperty(copy, key, {
        value: cloneValue(descriptor.value as unknown, ancestors, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (isArray) (copy as unknown[]).length = value.length;
    return copy as T;
  } finally {
    ancestors.delete(value);
  }
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeValue(child);
  }
  return value;
}

function snapshotCopy<T>(value: T): T {
  try {
    return freezeValue(cloneValue(value));
  } catch (error) {
    constantFailure(error);
  }
}

function scrub(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    if (redacted.includes(secret)) redacted = redacted.split(secret).join('•');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret && redacted.includes(encoded)) {
      redacted = redacted.split(encoded).join('%E2%80%A2');
    }
  }
  return redacted;
}

function redactSnapshot(
  snapshot: BrowserSnapshot,
  secrets: readonly string[],
  targets: readonly NodeTarget[],
): BrowserSnapshot {
  return {
    ...snapshot,
    displayUrl: scrub(snapshot.displayUrl, secrets),
    title: scrub(snapshot.title, secrets),
    screenshotRef: null,
    networkSummary: [],
    consoleSummary: [],
    redacted: true,
    nodes: snapshot.nodes.map((node) => {
      const frameId = node.frameId ?? 'main';
      const targeted = targets.some(
        (target) =>
          target.nodeId === node.nodeId &&
          (target.frameId ?? 'main') === frameId,
      );
      return {
        ...node,
        role: scrub(node.role, secrets),
        name: targeted ? '•' : scrub(node.name, secrets),
        text: targeted ? '•' : scrub(node.text, secrets),
        // A filled control's current content is that very secret.
        ...(node.value !== undefined
          ? { value: targeted ? '•' : scrub(node.value, secrets) }
          : {}),
      };
    }),
  };
}

/**
 * Codes a trusted auth primitive may raise through the private port. Anything
 * outside this set becomes a constant VALIDATION_ERROR, so a raw page/browser
 * message can never travel as a refusal reason.
 */
const AUTH_STATE_CODES = new Set<string>([
  'VALIDATION_ERROR',
  'TARGET_NOT_ALLOWED',
  'LEASE_EXPIRED',
  'CANCELLED',
  'POLICY_DENIED',
  'BROWSER_UNAVAILABLE',
]);

function constantFailure(error: unknown): never {
  if (error instanceof PrivateAuthError) throw error;
  if (
    error instanceof Error &&
    (error.name === 'AuthStateError' ||
      error.name === 'PrivateAuthError' ||
      error.name === 'AuthRequestBlockedError') &&
    AUTH_STATE_CODES.has(error.message)
  )
    throw error;
  fail('VALIDATION_ERROR');
}

function bindGate(gate: AuthExecutionGate): AuthExecutionGate {
  try {
    if (!gate || typeof gate !== 'object') fail('VALIDATION_ERROR');
    const { authorize, authorizeExport } = gate;
    if (
      typeof authorize !== 'function' ||
      typeof authorizeExport !== 'function'
    ) {
      fail('VALIDATION_ERROR');
    }
    return {
      authorize: authorize.bind(gate),
      authorizeExport: authorizeExport.bind(gate),
    };
  } catch (error) {
    constantFailure(error);
  }
}

function bindPrimitives(
  primitives: TrustedAuthPrimitives,
): TrustedAuthPrimitives {
  try {
    if (!primitives || typeof primitives !== 'object') fail('VALIDATION_ERROR');
    const { navigate, fill, submit, prepareState, exportState, close } =
      primitives;
    if (
      typeof navigate !== 'function' ||
      typeof fill !== 'function' ||
      typeof submit !== 'function' ||
      typeof prepareState !== 'function' ||
      typeof exportState !== 'function'
    ) {
      fail('VALIDATION_ERROR');
    }
    return {
      navigate: navigate.bind(primitives),
      fill: fill.bind(primitives),
      submit: submit.bind(primitives),
      prepareState: prepareState.bind(primitives),
      exportState: exportState.bind(primitives),
      ...(typeof close === 'function' ? { close: close.bind(primitives) } : {}),
    };
  } catch (error) {
    constantFailure(error);
  }
}

export function createPrivateAuthPort(options: {
  binding: AuthSessionBinding;
  gate: AuthExecutionGate;
  primitives: TrustedAuthPrimitives;
  allowedOrigins: readonly string[];
  now?: () => number;
  trustedRenewal?: () => Promise<AuthSessionBinding>;
  /** Trusted browser-local redaction survives a task's in-place sign-in. */
  onSensitiveValue?: (value: string) => void;
}): PrivateAuthPort {
  let binding = snapshotCopy(options.binding);
  assertBindingShape(binding);
  const gate = bindGate(options.gate);
  const { authorize, authorizeExport } = gate;
  const primitives = bindPrimitives(options.primitives);
  const allowedOrigins = Object.freeze([...options.allowedOrigins]);
  const grants = new Map<string, 'pending' | 'done'>();
  const secrets: string[] = [];
  const targets: NodeTarget[] = [];
  let closed = false;
  let closeFlight: Promise<void> | undefined;
  const now = options.now ?? Date.now;
  const absoluteRenewalLimit = parseTime(binding.expiresAt) + 5 * 60 * 1000;

  async function renewAuthority(): Promise<void> {
    if (!options.trustedRenewal || closed) fail('VALIDATION_ERROR');
    let next: AuthSessionBinding;
    try {
      next = snapshotCopy(await options.trustedRenewal());
      assertBindingShape(next);
    } catch {
      fail('LEASE_EXPIRED');
    }
    const oldExpiry = parseTime(binding.expiresAt);
    const newExpiry = parseTime(next.expiresAt);
    if (
      !sameBinding(next, binding) ||
      newExpiry < oldExpiry ||
      newExpiry <= now() ||
      newExpiry > absoluteRenewalLimit
    )
      fail('LEASE_EXPIRED');
    binding = next;
  }

  function assertActive(signal?: AbortSignal): void {
    if (closed) fail('VALIDATION_ERROR');
    if (signal?.aborted) fail('CANCELLED');
    assertLive(now(), binding.expiresAt, binding.expiresAt);
  }

  function rememberMaterial(value: string): void {
    if (value.length > 0 && !secrets.includes(value)) {
      secrets.push(value);
      options.onSensitiveValue?.(value);
    }
  }

  function redactObservation(snapshot: BrowserSnapshot): BrowserSnapshot {
    try {
      if (closed) fail('VALIDATION_ERROR');
      // Descriptor-safe deep copy first: no accessor runs, no cycle or exotic
      // prototype is accepted, and nothing of the caller's is read directly,
      // aliased, or frozen afterwards.
      const detached = cloneValue(snapshot);
      if (
        !detached ||
        typeof detached !== 'object' ||
        !Array.isArray(detached.nodes)
      ) {
        fail('VALIDATION_ERROR');
      }
      // Redact our own copy (never a flag on the raw observation) and freeze
      // only that copy, so the caller's nested objects stay untouched.
      return freezeValue(redactSnapshot(detached, secrets, targets));
    } catch (error) {
      constantFailure(error);
    }
  }

  const PRIMED_VALUE_LIMIT = 4096;
  const PRIMED_COUNT_LIMIT = 32;

  function primeSensitiveValues(values: readonly string[]): void {
    try {
      if (closed) fail('VALIDATION_ERROR');
      if (!Array.isArray(values)) fail('VALIDATION_ERROR');
      const prototype: unknown = Object.getPrototypeOf(values);
      if (prototype !== Array.prototype && prototype !== null) {
        fail('VALIDATION_ERROR');
      }
      const primed: string[] = [];
      for (const key of Reflect.ownKeys(values)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
          fail('VALIDATION_ERROR');
        }
        // Read descriptors, never accessors: a getter must not run here.
        const descriptor = Object.getOwnPropertyDescriptor(values, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          fail('VALIDATION_ERROR');
        }
        const value: unknown = descriptor.value;
        if (
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > PRIMED_VALUE_LIMIT
        ) {
          fail('VALIDATION_ERROR');
        }
        primed.push(value);
      }
      if (primed.length > PRIMED_COUNT_LIMIT) fail('VALIDATION_ERROR');
      // A hole in the array is not a value: refuse rather than silently ignore it.
      if (primed.length !== values.length) fail('VALIDATION_ERROR');
      for (const value of primed) rememberMaterial(value);
    } catch (error) {
      constantFailure(error);
    }
  }

  return {
    sessionId: binding.sessionId,
    ...(options.trustedRenewal ? { renewAuthority } : {}),
    primeSensitiveValues,
    redactObservation,
    async executeAuth(permit, effect, signal) {
      const approvedPermit = snapshotCopy(permit);
      const approvedEffect = snapshotCopy(effect);
      if (
        typeof approvedPermit?.grantId !== 'string' ||
        approvedPermit.grantId.length === 0
      ) {
        fail('VALIDATION_ERROR');
      }
      // The Worker heartbeat can extend the server session between issuing
      // the permit and reaching this private browser port. Fetch the proven
      // authority *after* the permit, avoiding a stale-deadline race.
      if (options.trustedRenewal) await renewAuthority();
      assertActive(signal);
      if (!sameBinding(approvedPermit, binding)) fail('LEASE_EXPIRED');
      assertLive(now(), approvedPermit.deadline, binding.expiresAt);
      assertEffect(approvedPermit, approvedEffect);
      if (grants.has(approvedPermit.grantId)) fail('VALIDATION_ERROR');
      if (approvedEffect.kind === 'navigate') {
        assertAllowedAuthUrl(approvedPermit.url ?? '', allowedOrigins);
      }
      grants.set(approvedPermit.grantId, 'pending');
      try {
        await authorize({ binding, permit: approvedPermit });
        assertActive(signal);
        assertLive(now(), approvedPermit.deadline, binding.expiresAt);
        if (approvedEffect.kind === 'navigate') {
          const url = approvedPermit.url ?? '';
          const snapshot = await primitives.navigate(url);
          assertActive(signal);
          return { snapshot: redactSnapshot(snapshot, secrets, targets) };
        }
        if (approvedEffect.kind === 'fill') {
          const fillTarget = approvedPermit.target;
          if (!fillTarget) fail('VALIDATION_ERROR');
          rememberMaterial(approvedEffect.secret);
          targets.push(snapshotCopy(fillTarget));
          const snapshot = await primitives.fill(
            fillTarget,
            approvedEffect.secret,
          );
          assertActive(signal);
          return { snapshot: redactSnapshot(snapshot, secrets, targets) };
        }
        if (approvedEffect.kind === 'submit') {
          const submitTarget = approvedPermit.target;
          if (!submitTarget) fail('VALIDATION_ERROR');
          const snapshot = await primitives.submit(submitTarget);
          assertActive(signal);
          return { snapshot: redactSnapshot(snapshot, secrets, targets) };
        }
        const state = validateApprovedAuthState(
          approvedEffect.kind === 'prepare_state' ? approvedEffect.state : null,
          allowedOrigins,
        );
        for (const cookie of state.cookies ?? [])
          rememberMaterial(cookie.value);
        for (const originState of state.origins ?? []) {
          for (const item of originState.localStorage)
            rememberMaterial(item.value);
        }
        await primitives.prepareState(state);
        assertActive(signal);
        return { snapshot: null };
      } catch (error) {
        constantFailure(error);
      } finally {
        grants.set(approvedPermit.grantId, 'done');
      }
    },
    async exportAuthState(grant, signal) {
      const approvedGrant = snapshotCopy(grant);
      assertGrantShape(approvedGrant);
      if (options.trustedRenewal) await renewAuthority();
      assertActive(signal);
      if (!sameBinding(approvedGrant, binding)) fail('LEASE_EXPIRED');
      // A heartbeat may advance the *same* session after this grant was
      // issued. Accept an earlier grant deadline only if the renewed, frozen
      // authority tuple remains identical and the server gate approves it.
      if (
        options.trustedRenewal
          ? parseTime(approvedGrant.expiresAt) > parseTime(binding.expiresAt)
          : approvedGrant.expiresAt !== binding.expiresAt
      )
        fail('LEASE_EXPIRED');
      assertLive(now(), approvedGrant.deadline, binding.expiresAt);
      if (grants.has(approvedGrant.grantId)) fail('VALIDATION_ERROR');
      grants.set(approvedGrant.grantId, 'pending');
      // The ticket is Runtime material: keep it out of any later snapshot too.
      rememberMaterial(approvedGrant.captureTicket);
      try {
        await authorizeExport({
          binding,
          grant: approvedGrant,
        });
        assertActive(signal);
        assertLive(now(), approvedGrant.deadline, binding.expiresAt);
        let state: ApprovedAuthState;
        try {
          state = await primitives.exportState();
        } catch (error) {
          constantFailure(error);
        }
        assertActive(signal);
        assertLive(now(), approvedGrant.deadline, binding.expiresAt);
        try {
          return validateApprovedAuthState(state, allowedOrigins);
        } catch (error) {
          constantFailure(error);
        }
      } catch (error) {
        constantFailure(error);
      } finally {
        grants.set(approvedGrant.grantId, 'done');
      }
    },
    async close() {
      closed = true;
      secrets.length = 0;
      targets.length = 0;
      await (closeFlight ??= primitives.close?.() ?? Promise.resolve());
    },
  };
}
