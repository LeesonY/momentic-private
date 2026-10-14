import type { AuthProfile } from '@localqa/contracts';
import {
  BrowserManager,
  BrowserSessionImpl,
  createPrivateAuthPort,
  createTrustedBrowserAuthPrimitives,
  resolveTarget,
} from '@localqa/browser';
import type { AuthSessionBinding } from '@localqa/browser';
import { authCriterionFor } from '@localqa/domain';
import type { RuntimeClient } from '@localqa/orchestrator';
import type { LeaseProof } from '@localqa/storage';
import { setTimeout as delay } from 'node:timers/promises';
import { createAuthAdapters } from './auth-adapters.js';
import { createAiAuthAdapters } from './auth-ai-adapters.js';
import { createAgentLoginDriver } from './auth-agent.js';
import { runAuthFlow } from './auth-flow.js';
import type { AuthFlowOutcome } from './auth-flow.js';
import { createAuthRuntimeBridge } from './auth-runtime.js';
import { createAuthServices } from './auth-services.js';

const blocked: AuthFlowOutcome = Object.freeze({
  status: 'blocked',
  reasonCode: 'AUTH_FAILED',
  steps: [],
  stateRef: null,
});

const same = (allocated: AuthSessionBinding, active: AuthSessionBinding) =>
  allocated.status === 'allocated' &&
  active.status === 'active' &&
  allocated.purpose === 'initializer' &&
  active.purpose === 'initializer' &&
  (
    [
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
      'expiresAt',
    ] as const
  ).every((key) => allocated[key] === active[key]) &&
  Date.parse(active.expiresAt) > Date.now();

/**
 * Run the production, server-authorized authentication in an owned Chromium
 * context. Form and storage-state profiles are fixed adapters; agent profiles
 * let the auth-job model propose steps over redacted observations. Neither is a
 * model tool, and credential material, private tickets or imported state never
 * reach ordinary task output or the model.
 * finishAuth performs the *only* successful auth-job settlement in PostgreSQL.
 */
export async function initializeBrowserAuthentication(
  options: {
    runtime: RuntimeClient;
    browser: BrowserManager;
    proof: LeaseProof;
    profile: AuthProfile;
    projectId: string;
    runId: string;
    tlsPolicy?: 'strict' | 'allow_self_signed';
  },
  signal: AbortSignal,
): Promise<AuthFlowOutcome> {
  if (signal.aborted)
    return { ...blocked, status: 'cancelled', reasonCode: 'CANCELLED' };
  const { profile, runtime, proof } = options;
  // Manual forms, imported state and agent sign-in have a frozen success
  // criterion. AI-recognized forms establish it from server-validated
  // login-page observations.
  const criterion = authCriterionFor(profile);
  if (
    !['form', 'storage_state', 'agent'].includes(profile.mode) ||
    profile.status !== 'active' ||
    (!criterion && profile.formConfig?.detectionMode !== 'ai') ||
    profile.projectId !== options.projectId
  )
    return blocked;

  let binding: AuthSessionBinding | undefined;
  let session: BrowserSessionImpl | undefined;
  let port: ReturnType<typeof createPrivateAuthPort> | undefined;
  let finished = false;
  try {
    const allocated = await runtime.allocateAuthSession(proof);
    binding = allocated;
    if (
      allocated.taskId !== proof.taskId ||
      allocated.fencingToken !== proof.fencingToken ||
      allocated.contextVersion !== proof.contextVersion ||
      allocated.profileId !== profile.id ||
      allocated.profileVersion !== profile.version ||
      allocated.projectId !== options.projectId ||
      allocated.runId !== options.runId ||
      allocated.purpose !== 'initializer' ||
      allocated.status !== 'allocated'
    )
      return blocked;
    if (signal.aborted)
      return { ...blocked, status: 'cancelled', reasonCode: 'CANCELLED' };
    const { activationTicket } = await runtime.issueAuthActivationTicket(
      proof,
      allocated.sessionId,
    );
    if (!activationTicket || signal.aborted) return blocked;
    const active = await runtime.activateAuthSession(
      proof,
      allocated.sessionId,
      activationTicket,
    );
    if (!same(allocated, active) || signal.aborted) return blocked;
    const created = await options.browser.createSession({
      sessionId: active.contextId,
      projectId: active.projectId,
      runId: active.runId,
      taskId: active.taskId,
      allowedOrigins: profile.allowedOrigins,
      tlsPolicy: options.tlsPolicy ?? 'strict',
      mode: 'non_submitting',
      enableTrace: false,
    });
    if (!(created instanceof BrowserSessionImpl)) {
      await created.close();
      return blocked;
    }
    session = created;
    const services = createAuthServices({
      client: runtime,
      proof,
      binding: active,
      pauseForOtp: async () => {
        if (signal.aborted) throw new Error('CANCELLED');
        const input = await runtime.issueAuthOtp(proof, active.sessionId);
        // The existing Worker heartbeat stays active and its private Chromium
        // session remains held. No generic waitForInput()/job requeue occurs.
        // A crash or lease revocation ends this task, never replays the OTP.
        while (!signal.aborted) {
          const result = await runtime.consumeAuthOtp(
            proof,
            active.sessionId,
            input.id,
          );
          if (result.status === 'ready' && result.code)
            return { code: result.code };
          if (result.status !== 'pending') throw new Error('AUTH_FAILED');
          await delay(250, undefined, { signal });
        }
        throw new Error('CANCELLED');
      },
    });
    const { runtime: flowRuntime, gate } = createAuthRuntimeBridge({
      client: runtime,
      proof,
      binding: active,
      services,
    });
    port = createPrivateAuthPort({
      binding: active,
      allowedOrigins: profile.allowedOrigins,
      gate,
      trustedRenewal: () => runtime.authSession(proof, active.sessionId),
      primitives: createTrustedBrowserAuthPrimitives(
        session,
        profile.allowedOrigins,
      ),
    });
    const adapters =
      profile.mode === 'form' && profile.formConfig?.detectionMode === 'ai'
        ? createAiAuthAdapters({
            session,
            port,
            runtime,
            proof,
            sessionId: active.sessionId,
          })
        : createAuthAdapters({
            session,
            binding: active,
            criterion: criterion!,
            // The exact observed snapshot is registered in the server-side auth
            // ledger; its immutable ID is the supporting evidence for this oracle.
            ownedEvidence: (snapshot) => [snapshot.snapshotId],
          });
    if (profile.mode === 'agent') {
      // The browser validates the same immutable target the model selected.
      // No grant/credential is issued if a reactive page invalidated it.
      adapters.preflightTarget = async (target, preflightSignal) => {
        if (preflightSignal.aborted) throw new Error('CANCELLED');
        const observed = await session!.getSnapshot();
        if (
          observed.snapshotId !== target.snapshotId ||
          observed.pageId !== target.pageId
        ) return false;
        const resolved = await resolveTarget(session!.getPage(), target, observed);
        if (resolved.status !== 'resolved') return false;
        await resolved.elementHandle.dispose().catch(() => undefined);
        return !preflightSignal.aborted;
      };
    }
    // The auth job runs under the executor lease, so agent sign-in uses the
    // run's frozen executor model binding and its budget.
    const agent =
      profile.mode === 'agent'
        ? createAgentLoginDriver({
            call: (messages, outputSchema, callSignal) =>
              runtime.model(
                proof,
                'executor',
                {
                  purpose: 'decide',
                  messages,
                  outputSchema,
                },
                undefined,
                callSignal,
              ),
          })
        : undefined;
    const outcome = await runAuthFlow(
      {
        profile,
        binding: active,
        runtime: flowRuntime,
        port,
        adapters,
        criterion: criterion ?? undefined,
        agent,
      },
      signal,
    );
    finished = outcome.status === 'succeeded';
    return outcome;
  } catch {
    // No raw exceptions or secrets enter ordinary task results.
    return signal.aborted
      ? { ...blocked, status: 'cancelled', reasonCode: 'CANCELLED' }
      : blocked;
  } finally {
    await port?.close().catch(() => {});
    await session?.close().catch(() => {});
    if (binding && !finished) {
      await runtime
        .endAuthSession(proof, binding.sessionId, 'failed')
        .catch(() => {});
    }
  }
}
