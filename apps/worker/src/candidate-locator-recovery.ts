import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserSession } from '@localqa/browser';
import { parseContract } from '@localqa/contracts';
import type { Locator, NodeTarget } from '@localqa/contracts';

export class CandidateLocatorFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Re-observe before each locator resolution. The worker may refresh a stale
 * *witness*, but must never replay a browser click or type after dispatch.
 *
 * Only unique, fresh, owned DOM witnesses are admissible. A second/missing
 * candidate, policy rejection, cancellation, or invalid snapshot fails closed.
 */
export async function resolveCandidateLocator(
  session: Pick<
    BrowserSession,
    'activePageId' | 'executeTool' | 'resolveRegressionLocator'
  >,
  locator: Locator,
  signal: AbortSignal,
): Promise<NodeTarget> {
  if (!session.resolveRegressionLocator)
    throw new CandidateLocatorFailure('LOCATOR_UNSUPPORTED');
  const retryable = new Set(['LOCATOR_NOT_FOUND', 'LOCATOR_SNAPSHOT_STALE']);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal.aborted)
      throw new CandidateLocatorFailure('VERIFICATION_CANCELLED');
    const observed = await session.executeTool(
      { name: 'observe', args: { pageId: session.activePageId } },
      { signal },
    );
    if (observed.status !== 'succeeded')
      throw new CandidateLocatorFailure('OBSERVATION_INCOMPLETE');
    const snapshot = parseContract('BrowserSnapshot', observed.data);
    if (!snapshot.redacted || snapshot.truncated)
      throw new CandidateLocatorFailure('OBSERVATION_INCOMPLETE');
    try {
      const target = await session.resolveRegressionLocator(locator, signal);
      if (signal.aborted)
        throw new CandidateLocatorFailure('VERIFICATION_CANCELLED');
      return parseContract('NodeTarget', target);
    } catch (error) {
      if (signal.aborted)
        throw new CandidateLocatorFailure('VERIFICATION_CANCELLED');
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (typeof code !== 'string' || !retryable.has(code))
        throw new CandidateLocatorFailure(
          code === 'LOCATOR_NOT_OWNED_OR_AMBIGUOUS'
            ? 'LOCATOR_NOT_OWNED_OR_AMBIGUOUS'
            : 'VERIFICATION_LOCATOR_FAILED',
        );
      if (attempt === 3) throw new CandidateLocatorFailure(code);
      await delay(attempt * 250, undefined, { signal }).catch(() => {
        throw new CandidateLocatorFailure('VERIFICATION_CANCELLED');
      });
    }
  }
  throw new CandidateLocatorFailure('VERIFICATION_LOCATOR_FAILED');
}
