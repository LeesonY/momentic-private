import { isErrorCode, type AuthProfile } from '@localqa/contracts';
import {
  BrowserManager,
  BrowserSessionImpl,
  createPrivateAuthPort,
  createTrustedBrowserAuthPrimitives,
  resolveTarget,
} from '@localqa/browser';
import type {
  AuthSessionBinding,
  TrustedAuthPrimitives,
} from '@localqa/browser';
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

function codeOf(error: unknown): string | null {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return isErrorCode(code) ? code : null;
  } catch {
    return null;
  }
}

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
 * Run production, server-authorized authentication in an isolated Chromium
 * context, either created here or supplied by the task. Form and storage-state
 * profiles are fixed adapters; agent profiles propose steps over redacted
 * observations. Credentials, private tickets and browser state never reach
 * ordinary task output or the model. finishAuth settles legacy auth jobs;
 * signed_in ends only the private authority of a task-local login.
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
    /**
     * Mo-style self sign-in: the task's own, already opened browser. The
     * sign-in happens in it and it stays open for the task's work; only the
     * private port and the server session end here. No state is captured.
     */
    session?: BrowserSessionImpl;
    /** The leased role whose model binding and budget the sign-in uses. */
    role?: 'explorer' | 'executor' | 'reproducer';
    /** Trusted Worker-only notice of the first server-authorized login URL.
     * The raw URL stays private; it is never part of the auth outcome. */
    onLoginStart?: (url: string) => void;
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
  let primitives: TrustedAuthPrimitives | undefined;
  let finished = false;
  let outcome = blocked;
  let cleanupFailed = false;
  const own = options.session;
  /** Self sign-in only: ended with the server's success verification. */
  let signedIn = false;
  try {
    let allocated: AuthSessionBinding;
    try {
      allocated = await runtime.allocateAuthSession(proof);
    } catch (error) {
      if (own && codeOf(error) === 'RATE_LIMITED')
        return {
          ...blocked,
          reasonCode: 'RATE_LIMITED',
          detail: '账号被同一运行或其他运行的任务占用，本条用例未执行。',
        };
      throw error;
    }
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
    if (signal.aborted)
      return { ...blocked, status: 'cancelled', reasonCode: 'CANCELLED' };
    if (!activationTicket) return blocked;
    const active = await runtime.activateAuthSession(
      proof,
      allocated.sessionId,
      activationTicket,
    );
    if (signal.aborted)
      return { ...blocked, status: 'cancelled', reasonCode: 'CANCELLED' };
    if (!same(allocated, active)) return blocked;
    if (own) {
      // The server session is bound to this exact task browser context.
      if (
        own.isClosed ||
        own.id !== active.contextId ||
        own.taskId !== active.taskId
      )
        return blocked;
      session = own;
    }
    const created =
      own ??
      (await options.browser.createSession({
        sessionId: active.contextId,
        projectId: active.projectId,
        runId: active.runId,
        taskId: active.taskId,
        allowedOrigins: profile.allowedOrigins,
        tlsPolicy: options.tlsPolicy ?? 'strict',
        mode: 'non_submitting',
        enableTrace: false,
      }));
    if (!(created instanceof BrowserSessionImpl)) {
      await created.close();
      return blocked;
    }
    session = created;
    session.beginPrivateAuthentication();
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
    if (own) {
      services.finishSignIn = async () => {
        await runtime.endAuthSession(proof, active.sessionId, 'signed_in');
        signedIn = true;
      };
    }
    const { runtime: flowRuntime, gate } = createAuthRuntimeBridge({
      client: runtime,
      proof,
      binding: active,
      services,
    });
    primitives = createTrustedBrowserAuthPrimitives(
      session,
      profile.allowedOrigins,
    );
    const navigate = primitives.navigate.bind(primitives);
    let loginStarted = false;
    primitives.navigate = async (url) => {
      // This URL comes from navigate_auth's permit, not Work.targetUrl or the
      // browser's about:blank/current page. Agent profiles may omit loginUrl.
      if (!loginStarted) {
        loginStarted = true;
        options.onLoginStart?.(url);
      }
      return navigate(url);
    };
    port = createPrivateAuthPort({
      binding: active,
      allowedOrigins: profile.allowedOrigins,
      gate,
      trustedRenewal: () => runtime.authSession(proof, active.sessionId),
      onSensitiveValue: (value) => session!.rememberAuthenticationValue(value),
      primitives,
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
        )
          return false;
        const resolved = await resolveTarget(
          session!.getPage(),
          target,
          observed,
        );
        if (resolved.status !== 'resolved') return false;
        await resolved.elementHandle.dispose().catch(() => undefined);
        return !preflightSignal.aborted;
      };
    }
    // Login uses this task's frozen model binding and shared run budget.
    // A reproducer signs in with the reproducer binding, not the executor's.
    const agent =
      profile.mode === 'agent'
        ? createAgentLoginDriver({
            call: (messages, outputSchema, callSignal) =>
              runtime.model(
                proof,
                options.role ?? 'executor',
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
    outcome = await runAuthFlow(
      {
        ...(own ? { completion: 'task_sign_in' } : {}),
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
    finished = outcome.status === 'succeeded' && (!own || signedIn);
    if (outcome.status === 'succeeded' && !finished) outcome = blocked;
  } catch (error) {
    // No raw exceptions or secrets enter ordinary task results. Preserve only
    // trusted codes so cancellation/budget/lease failures are not downgraded.
    const code = codeOf(error) ?? 'AUTH_FAILED';
    outcome =
      signal.aborted || code === 'CANCELLED' || code === 'USER_CANCELLED'
        ? { ...blocked, status: 'cancelled', reasonCode: 'CANCELLED' }
        : { ...blocked, reasonCode: code };
  } finally {
    try {
      if (port) await port.close();
      else await primitives?.close?.();
    } catch {
      cleanupFailed = true;
    }
    session?.endPrivateAuthentication();
    if (!own) await session?.close().catch(() => {});
    if (binding && !finished) {
      await runtime
        .endAuthSession(
          proof,
          binding.sessionId,
          signal.aborted || outcome.status === 'cancelled'
            ? 'cancelled'
            : 'failed',
        )
        .catch(() => {});
    }
  }
  // Never let a task act while a private browser guard could still be held.
  return cleanupFailed && outcome.status === 'succeeded' ? blocked : outcome;
}
