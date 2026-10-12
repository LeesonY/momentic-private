import {
  AGENT_LOGIN_CRITERION,
  evaluateAgentLogin,
  evaluateTechnical,
} from '@localqa/domain';
import { isErrorCode } from '@localqa/contracts';
import type {
  BrowserSnapshot,
  CaseDefinition,
  Criterion,
  CriterionResult,
  Locator,
  NodeTarget,
} from '@localqa/contracts';
import { STABLE_REASON_CODES } from '@localqa/browser';
import type { AuthSessionBinding, BrowserSession } from '@localqa/browser';
import type { AuthFlowAdapters, AuthFreshObservation } from './auth-flow.js';

/** The exact slice of the real BrowserSession this adapter resolves through. */
export interface AuthLocatorSession {
  resolveRegressionLocator(
    locator: Locator,
    signal?: AbortSignal,
  ): Promise<NodeTarget>;
  /** Cached read of the observation the locator just produced. */
  getSnapshot(options?: { forceFresh?: boolean }): Promise<BrowserSnapshot>;
}

// Compile-time compatibility proof against the real session interface.
type _SessionMethodIsCompatible =
  NonNullable<
    BrowserSession['resolveRegressionLocator']
  > extends AuthLocatorSession['resolveRegressionLocator']
    ? true
    : never;
const _sessionCheck: _SessionMethodIsCompatible = true;
void _sessionCheck;

type _SessionSnapshotIsCompatible =
  AuthLocatorSession['getSnapshot'] extends NonNullable<
    BrowserSession['getSnapshot']
  >
    ? true
    : never;
const _sessionSnapshotCheck: _SessionSnapshotIsCompatible = true;
void _sessionSnapshotCheck;

export interface AuthAdapterOptions {
  session: AuthLocatorSession;
  binding: AuthSessionBinding;
  /**
   * The one frozen criterion this adapter may evaluate. The flow must pass this
   * same criterion; swapping it is refused instead of being evaluated.
   */
  criterion: Criterion;
  /**
   * Evidence refs this run actually owns for the snapshot. With none, the real
   * evaluator reports unknown for any would-be pass or fail — never a pass.
   */
  ownedEvidence?:
    ((snapshot: BrowserSnapshot) => readonly string[]) | undefined;
}

class AuthAdapterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AuthAdapterError';
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

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Code of a locator failure, read without touching its message. */
function errorCode(error: unknown): string | null {
  let code: unknown;
  try {
    code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
  } catch {
    return null;
  }
  return typeof code === 'string' ? code : null;
}

const MAX_EVIDENCE_REFS = 32;

/**
 * Real locator/criterion adapters for the fixed auth flow.
 *
 * - Locators resolve through the real `BrowserSession.resolveRegressionLocator`
 *   signature, then the returned target is re-based onto the snapshot the flow
 *   is holding: the session resolves against its own fresh snapshot while the
 *   server verifies provenance against the snapshot the flow registered, and the
 *   page/node/frame must match that current snapshot.
 * - Only `LOCATOR_NOT_FOUND` (an explicit "not present" signal) becomes null, so
 *   the flow can skip an optional OTP field; every other failure keeps a stable
 *   code instead of being flattened into "absent".
 * - Criteria are evaluated by the real `evaluateTechnical` over the frozen
 *   criterion, with only the owned evidence refs the caller supplies. There is
 *   no model call and no BrowserTool fallback, and an unsupported oracle or a
 *   missing owned ref yields unknown/unsupported — never a fabricated pass.
 */
export function createAuthAdapters(
  options: AuthAdapterOptions,
): AuthFlowAdapters {
  const session = options.session;
  if (
    !session ||
    typeof session.resolveRegressionLocator !== 'function' ||
    typeof session.getSnapshot !== 'function'
  ) {
    // Without the cached snapshot read there is no handshake: rather than
    // rewriting ids, the adapter is refused outright, so no grant or effect can
    // happen with a target it cannot account for.
    throw new AuthAdapterError('VALIDATION_ERROR');
  }
  const bindingInput = options.binding;
  if (
    !bindingInput ||
    !nonEmpty(bindingInput.runId) ||
    !nonEmpty(bindingInput.projectId) ||
    !nonEmpty(bindingInput.taskId)
  ) {
    throw new AuthAdapterError('VALIDATION_ERROR');
  }
  const binding: AuthSessionBinding = Object.freeze({ ...bindingInput });
  const criterionInput = options.criterion;
  if (!criterionInput || !nonEmpty(criterionInput.id)) {
    throw new AuthAdapterError('VALIDATION_ERROR');
  }
  const criterion: Criterion = freeze(copy(criterionInput));
  const ownedEvidence = options.ownedEvidence;

  function sameCriterion(candidate: Criterion | undefined): boolean {
    try {
      return JSON.stringify(candidate) === JSON.stringify(criterion);
    } catch {
      return false;
    }
  }

  function evidenceRefs(snapshot: BrowserSnapshot): string[] {
    if (typeof ownedEvidence !== 'function') return [];
    let values: readonly string[];
    try {
      values = ownedEvidence(snapshot) ?? [];
    } catch (error) {
      throw new AuthAdapterError(errorCode(error) ?? 'CRITERION_UNSUPPORTED');
    }
    if (!Array.isArray(values) || values.length > MAX_EVIDENCE_REFS) {
      throw new AuthAdapterError('VALIDATION_ERROR');
    }
    for (const value of values) {
      if (!nonEmpty(value)) throw new AuthAdapterError('VALIDATION_ERROR');
    }
    return [...values];
  }

  /**
   * The target must belong to the snapshot it is checked against. It is passed
   * through unchanged: rewriting another snapshot's ids onto an older snapshot
   * would forge provenance, even when page, node and frame names happen to match.
   */
  function sameSnapshotTarget(
    target: NodeTarget | null | undefined,
    snapshot: BrowserSnapshot,
  ): NodeTarget {
    if (!target || !nonEmpty(target.nodeId)) {
      throw new AuthAdapterError(STABLE_REASON_CODES.TARGET_NOT_FOUND);
    }
    if (
      target.snapshotId !== snapshot.snapshotId ||
      target.pageId !== snapshot.pageId
    ) {
      throw new AuthAdapterError(STABLE_REASON_CODES.TARGET_NOT_FOUND);
    }
    const frameId = target.frameId ?? 'main';
    const node = snapshot.nodes.find(
      (candidate) =>
        candidate.nodeId === target.nodeId &&
        (candidate.frameId ?? 'main') === frameId,
    );
    if (!node) {
      throw new AuthAdapterError(STABLE_REASON_CODES.TARGET_NOT_FOUND);
    }
    if (!node.visible) {
      throw new AuthAdapterError(STABLE_REASON_CODES.TARGET_HIDDEN);
    }
    return target;
  }

  async function resolve(
    locator: Locator | undefined,
    signal: AbortSignal | undefined,
  ): Promise<NodeTarget | null> {
    if (signal?.aborted) throw new AuthAdapterError('CANCELLED');
    if (!locator || typeof locator.by !== 'string') {
      throw new AuthAdapterError('VALIDATION_ERROR');
    }
    let target: NodeTarget | null;
    try {
      target = await session.resolveRegressionLocator(locator, signal);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'CANCELLED' || signal?.aborted) {
        throw new AuthAdapterError('CANCELLED');
      }
      // Only an explicit "not present" may become null; ambiguity and
      // unknown failures keep a stable rejected code.
      if (code === 'LOCATOR_NOT_FOUND') return null;
      if (code === 'LOCATOR_NOT_UNIQUE') {
        throw new AuthAdapterError(STABLE_REASON_CODES.TARGET_AMBIGUOUS);
      }
      if (code === STABLE_REASON_CODES.VALIDATION_ERROR) {
        throw new AuthAdapterError(STABLE_REASON_CODES.VALIDATION_ERROR);
      }
      throw new AuthAdapterError('RESOLVER_ERROR');
    }
    if (signal?.aborted) throw new AuthAdapterError('CANCELLED');
    return target;
  }

  const adapters: AuthFlowAdapters = {
    async locate(
      snapshot: BrowserSnapshot,
      locator: Locator,
      signal?: AbortSignal,
    ): Promise<NodeTarget | null> {
      const target = await resolve(locator, signal);
      if (!target) return null;
      return sameSnapshotTarget(target, snapshot);
    },
    async locateFresh(
      snapshot: BrowserSnapshot,
      locator: Locator,
      signal?: AbortSignal,
    ): Promise<AuthFreshObservation | null> {
      const target = await resolve(locator, signal);
      if (!target) return null;
      // Read the observation the locator just produced; never force a new one.
      let observed: BrowserSnapshot;
      try {
        observed = await session.getSnapshot();
      } catch (error) {
        throw new AuthAdapterError(errorCode(error) ?? 'RESOLVER_ERROR');
      }
      if (
        !observed ||
        typeof observed !== 'object' ||
        !Array.isArray(observed.nodes)
      ) {
        throw new AuthAdapterError('RESOLVER_ERROR');
      }
      if (observed.pageId !== snapshot.pageId) {
        throw new AuthAdapterError(STABLE_REASON_CODES.TARGET_NOT_FOUND);
      }
      return {
        snapshot: observed,
        target: sameSnapshotTarget(target, observed),
      };
    },
    async observe(signal?: AbortSignal): Promise<BrowserSnapshot> {
      if (signal?.aborted) throw new AuthAdapterError('CANCELLED');
      let observed: BrowserSnapshot;
      try {
        observed = await session.getSnapshot({ forceFresh: true });
      } catch (error) {
        throw new AuthAdapterError(errorCode(error) ?? 'OBSERVATION_FAILED');
      }
      if (
        !observed ||
        typeof observed !== 'object' ||
        !Array.isArray(observed.nodes)
      ) {
        throw new AuthAdapterError('OBSERVATION_FAILED');
      }
      return observed;
    },
    async evaluate(
      snapshot: BrowserSnapshot,
      candidate: Criterion,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) throw new AuthAdapterError('CANCELLED');
      if (!sameCriterion(candidate)) {
        throw new AuthAdapterError('VALIDATION_ERROR');
      }
      const evidence = evidenceRefs(snapshot);
      // Only `criteria` is consumed by evaluateTechnical; the rest of the
      // envelope is inert and derived from the frozen binding.
      const definition: CaseDefinition = {
        id: binding.taskId,
        runId: binding.runId,
        projectId: binding.projectId,
        version: 1,
        title: 'auth criterion evaluation',
        summary: 'auth criterion evaluation',
        preconditions: [],
        outline: ['auth'],
        criteria: [criterion],
      };
      // Agent sign-in has its own fixed oracle; the server re-evaluates it
      // over the registered observation in the same way.
      const agentOracle =
        JSON.stringify(criterion) === JSON.stringify(AGENT_LOGIN_CRITERION);
      let results: CriterionResult[];
      try {
        results = agentOracle
          ? [evaluateAgentLogin(snapshot, evidence)]
          : evaluateTechnical(
              definition,
              snapshot,
              snapshot.responseStatus ?? null,
              evidence,
            );
      } catch (error) {
        throw new AuthAdapterError(
          isErrorCode(errorCode(error) ?? '')
            ? (errorCode(error) as string)
            : 'CRITERION_UNSUPPORTED',
        );
      }
      if (signal?.aborted) throw new AuthAdapterError('CANCELLED');
      const result = results.find((item) => item.criterionId === criterion.id);
      if (!result) throw new AuthAdapterError('CRITERION_UNSUPPORTED');
      // Defence in depth: a pass without owned evidence is never reported.
      if (result.result === 'passed' && result.evidenceRefs.length === 0) {
        return freeze({
          ...result,
          result: 'unknown' as const,
          reason: 'Required owned evidence missing',
        });
      }
      return freeze(copy(result));
    },
  };
  return adapters;
}
