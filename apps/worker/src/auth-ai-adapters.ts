import type {
  BrowserSnapshot,
  CriterionResult,
  Locator,
} from '@localqa/contracts';
import type { BrowserSessionImpl, PrivateAuthPort } from '@localqa/browser';
import { resolveTarget } from '@localqa/browser';
import type { AuthRecognitionSlot, RuntimeClient } from '@localqa/orchestrator';
import { StorageError, type LeaseProof } from '@localqa/storage';
import type { AuthFlowAdapters } from './auth-flow.js';

/** Observe and register privately before asking the server's frozen model. */
export function createAiAuthAdapters(options: {
  session: BrowserSessionImpl;
  port: PrivateAuthPort;
  runtime: RuntimeClient;
  proof: LeaseProof;
  sessionId: string;
}): AuthFlowAdapters {
  async function identify(slot: AuthRecognitionSlot, signal: AbortSignal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw new StorageError('USER_CANCELLED');
      const snapshot = options.port.redactObservation(
        await options.session.getSnapshot({ forceFresh: true }),
      );
      await options.runtime.recordAuthObservation(
        options.proof,
        options.sessionId,
        snapshot,
      );
      const answer = await options.runtime.recognizeAuth(
        options.proof,
        options.sessionId,
        snapshot.snapshotId,
        slot,
        signal,
      );
      if (signal.aborted) throw new StorageError('USER_CANCELLED');
      if (
        answer.target &&
        (answer.target.snapshotId !== snapshot.snapshotId ||
          answer.target.pageId !== snapshot.pageId)
      )
        throw new StorageError('VALIDATION_ERROR');
      if (answer.target) {
        // Model latency can outlast a SPA loading animation. Validate before
        // issuing any private action permit; stale proposals are never rebound.
        const resolved = await resolveTarget(
          options.session.getPage(),
          answer.target,
          snapshot,
        );
        if (resolved.status === 'resolved') {
          await resolved.elementHandle.dispose();
        } else if (resolved.reasonCode === 'VERSION_CONFLICT') {
          if (attempt === 0) continue;
          throw new StorageError('VERSION_CONFLICT');
        } else {
          throw new StorageError('VALIDATION_ERROR');
        }
      }
      return { snapshot, answer };
    }
    throw new StorageError('VERSION_CONFLICT');
  }
  return {
    async identify(_snapshot, slot, signal) {
      const observed = await identify(slot, signal);
      return observed.answer.target
        ? { snapshot: observed.snapshot, target: observed.answer.target }
        : null;
    },
    async evaluateAiSuccess(_snapshot, signal) {
      // A pending SPA render may advance while a model response is in flight.
      // Re-observe once on a valid negative result; never resubmit credentials
      // or retry a failed/unknown provider request.
      let observed = await identify('success', signal);
      if (observed.answer.success?.result !== 'passed')
        observed = await identify('success', signal);
      const result: CriterionResult = observed.answer.success ?? {
        criterionId: 'login_success',
        result: 'unknown',
        reason: 'AI 尚未确认登录成功',
        evidenceRefs: [],
      };
      return { snapshot: observed.snapshot, result };
    },
    async locate(_snapshot: BrowserSnapshot, _locator: Locator) {
      throw new StorageError('POLICY_DENIED');
    },
    async evaluate() {
      throw new StorageError('POLICY_DENIED');
    },
  };
}
