import type {
  Artifact,
  CriterionResult,
  HeartbeatResult,
  InputRequest,
  Lease,
  ToolCall,
  BrowserSnapshot,
  AuthProfile,
  CredentialMaterial,
  TaskRecording,
} from '@localqa/contracts';
import {
  StorageError,
  type LeaseProof,
  type WorkerScope,
} from '@localqa/storage';
import type { CallRecord } from '@localqa/model-gateway';
import type {
  Coordinator,
  Work,
  ActionGrant,
  StoppedRecordingArtifact,
} from './core.js';
import {
  BoundModel,
  type DecisionPayload,
  type ModelOptions,
  type AgentRoleName,
} from './model.js';
import { ArtifactStore } from './artifacts.js';
import {
  authRecognitionPayload,
  type AuthRecognitionResult,
  type AuthRecognitionSlot,
} from './auth-ai.js';
import { isErrorCode } from '@localqa/contracts';

/** In-process internal service client. T06 must replace/bind it at verified service
 * identity boundary, never from an HTTP body/user cookie/model. Worker sees no DB/KEK. */
export class RuntimeClient {
  readonly #model: BoundModel;
  readonly #coordinator: Coordinator;
  readonly #scope: WorkerScope;
  readonly #artifacts: ArtifactStore;
  constructor(
    coordinator: Coordinator,
    scope: WorkerScope,
    artifacts: ArtifactStore,
    options: ModelOptions,
  ) {
    if (!scope.projectId || !scope.workerId || scope.workerId.length > 200)
      throw new StorageError('VALIDATION_ERROR');
    this.#coordinator = coordinator;
    this.#scope = Object.freeze({ ...scope });
    this.#artifacts = artifacts;
    this.#model = new BoundModel(coordinator, this.#scope, {
      ...options,
      readApprovedImage: (input) => this.#artifacts.readApprovedImage(input),
    });
  }
  claim(seconds = 45): Promise<Lease | null> {
    return this.#coordinator.claim(this.#scope, seconds);
  }
  work(proof: LeaseProof): Promise<Work> {
    return this.#coordinator.work(this.#scope, proof);
  }
  lookupRegressionLocator(
    proof: LeaseProof,
    source: import('@localqa/contracts').RegressionStepSource,
    locator: import('@localqa/contracts').Locator,
    pageUrl: string,
  ): Promise<string | null> {
    return this.#coordinator.lookupRegressionLocator(
      this.#scope,
      proof,
      source,
      locator,
      pageUrl,
    );
  }
  recordRegressionLocator(
    proof: LeaseProof,
    source: import('@localqa/contracts').RegressionStepSource,
    locator: import('@localqa/contracts').Locator,
    pageUrl: string,
    outcome: 'hit' | 'miss' | 'invalidated',
    resolved: boolean,
  ): Promise<void> {
    return this.#coordinator.recordRegressionLocator(
      this.#scope,
      proof,
      source,
      locator,
      pageUrl,
      outcome,
      resolved,
    );
  }
  async heartbeat(proof: LeaseProof, seconds = 45): Promise<HeartbeatResult> {
    const heartbeat = await this.#coordinator.leases.heartbeat(
      this.#scope,
      proof,
      seconds,
    );
    return this.#coordinator.tx(async (client) => {
      const { run } = await this.#coordinator.validateLease(
        client,
        this.#scope,
        proof,
        true,
      );
      await this.#coordinator.pulse(client, this.#scope.projectId, run.id);
      // A session outlives the initial 45s lease only while this exact Worker
      // keeps a valid fenced heartbeat. Never renew on stop/cancel/scope
      // changes; the browser's authority must be re-fetched privately.
      if (
        !heartbeat.cancelRequested &&
        run.status === 'running' &&
        !['budget_limit', 'model_failure', 'setup_failure'].includes(
          run.terminationReason ?? '',
        )
      )
        await this.#coordinator.authExecution.renewForHeartbeat(
          client,
          this.#scope,
          proof,
        );
      return {
        ...heartbeat,
        cancelRequested:
          heartbeat.cancelRequested ||
          ['budget_limit', 'model_failure', 'setup_failure'].includes(
            run.terminationReason ?? '',
          ),
      };
    });
  }
  authProfile(proof: LeaseProof): Promise<AuthProfile | null> {
    return this.#coordinator.authProfile(this.#scope, proof);
  }
  async requireAnonymousOrInput(proof: LeaseProof): Promise<boolean> {
    const profile = await this.authProfile(proof);
    if (profile && profile.mode !== 'none') {
      await this.#coordinator.waitForInput(
        this.#scope,
        proof,
        'auth_profile',
        'Configured authentication requires an approved adapter integration; refusing anonymous fallback',
      );
      return false;
    }
    return true;
  }
  model(
    proof: LeaseProof,
    role: AgentRoleName,
    payload: DecisionPayload,
    criterionId?: string,
    signal?: AbortSignal,
  ): Promise<CallRecord> {
    return this.#model.call(proof, role, payload, criterionId, signal);
  }
  grant(
    proof: LeaseProof,
    call: ToolCall,
    source?: import('@localqa/contracts').RegressionStepSource,
    decisionNote?: unknown,
  ): Promise<ActionGrant> {
    return this.#coordinator.grantAction(
      this.#scope,
      proof,
      call,
      source,
      decisionNote,
    );
  }
  record(
    proof: LeaseProof,
    grant: ActionGrant,
    status: 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    snapshot: BrowserSnapshot | null,
    evidence: string[] = [],
    reasonCode?: string | null,
  ): Promise<void> {
    return this.#coordinator.recordAction(
      this.#scope,
      proof,
      grant,
      status,
      snapshot,
      evidence,
      reasonCode,
    );
  }
  upload(
    proof: LeaseProof,
    artifact: Artifact,
    bytes: Uint8Array,
  ): Promise<Artifact> {
    return this.#artifacts.upload(
      this.#coordinator,
      this.#scope,
      proof,
      artifact,
      bytes,
    );
  }
  /** Attach evidence captured before a cancelled/expired browser task. */
  saveStoppedRecording(
    proof: LeaseProof,
    artifacts: readonly StoppedRecordingArtifact[],
    recording: TaskRecording,
  ): Promise<void> {
    return this.#artifacts.uploadStopped(
      this.#coordinator,
      this.#scope,
      proof,
      artifacts,
      recording,
    );
  }
  finish(
    proof: LeaseProof,
    result: Record<string, unknown>,
    results?: CriterionResult[],
    reason?: string,
  ): Promise<void> {
    return this.#coordinator.finish(
      this.#scope,
      proof,
      result,
      results,
      reason,
    );
  }
  /** The sign-in agent could not sign in: report it without failing the run. */
  failAuth(
    proof: LeaseProof,
    input: { reasonCode: string; detail: string | null },
  ): Promise<void> {
    return this.#coordinator.failAuth(this.#scope, proof, input);
  }
  stop(
    proof: LeaseProof,
    reason:
      'budget_limit' | 'worker_failure' | 'model_failure' | 'setup_failure',
  ): Promise<void> {
    return this.#coordinator.stopTask(this.#scope, proof, reason);
  }
  input(
    proof: LeaseProof,
    kind: InputRequest['kind'],
    prompt: string,
    expiresMs = 60000,
    options?: string[],
    sessionDecision?: unknown,
  ): Promise<InputRequest> {
    return this.#coordinator.waitForInput(
      this.#scope,
      proof,
      kind,
      prompt,
      expiresMs,
      options,
      sessionDecision,
    );
  }
  poll(): Promise<void> {
    return this.#coordinator.tick(this.#scope.projectId);
  }
  issueAuthOtp(proof: LeaseProof, sessionId: string) {
    return this.#coordinator.authOtp.issue(this.#scope, proof, sessionId);
  }
  consumeAuthOtp(proof: LeaseProof, sessionId: string, inputId: string) {
    return this.#coordinator.authOtp.consume(
      this.#scope,
      proof,
      sessionId,
      inputId,
    );
  }
  allocateAuthSession(
    proof: LeaseProof,
  ): Promise<import('./auth-execution.js').AuthSessionBinding> {
    return this.#coordinator.allocateAuthSession(this.#scope, proof);
  }
  allocateAuthImporterSession(proof: LeaseProof, authStateId: string) {
    return this.#coordinator.allocateAuthImporterSession(
      this.#scope,
      proof,
      authStateId,
    );
  }
  grantAuthImport(proof: LeaseProof, sessionId: string) {
    return this.#coordinator.grantAuthImport(this.#scope, proof, sessionId);
  }
  prepareAuthImport(proof: LeaseProof, sessionId: string, grantId: string) {
    return this.#coordinator.prepareAuthImport(
      this.#scope,
      proof,
      sessionId,
      grantId,
    );
  }
  beginAuthImport(proof: LeaseProof, sessionId: string, grantId: string) {
    return this.#coordinator.beginAuthImport(
      this.#scope,
      proof,
      sessionId,
      grantId,
    );
  }
  recordAuthImport(
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    receipt: import('./auth-import-service.js').AuthImportReceipt,
    outcome: import('./auth-import-service.js').AuthImportOutcome,
  ) {
    return this.#coordinator.recordAuthImport(
      this.#scope,
      proof,
      sessionId,
      grantId,
      receipt,
      outcome,
    );
  }
  issueAuthActivationTicket(
    proof: LeaseProof,
    sessionId: string,
  ): Promise<{ activationTicket: string }> {
    return this.#coordinator.issueAuthActivationTicket(
      this.#scope,
      proof,
      sessionId,
    );
  }
  activateAuthSession(
    proof: LeaseProof,
    sessionId: string,
    ticket: string,
  ): Promise<import('./auth-execution.js').AuthSessionBinding> {
    return this.#coordinator.activateAuthSession(
      this.#scope,
      proof,
      sessionId,
      ticket,
    );
  }
  authSession(
    proof: LeaseProof,
    sessionId: string,
  ): Promise<import('./auth-execution.js').AuthSessionBinding> {
    return this.#coordinator.authSession(this.#scope, proof, sessionId);
  }
  endAuthSession(
    proof: LeaseProof,
    sessionId: string,
    reason?: string,
  ): Promise<import('./auth-execution.js').AuthSessionBinding> {
    return this.#coordinator.endAuthSession(
      this.#scope,
      proof,
      sessionId,
      reason,
    );
  }
  recordAuthObservation(
    proof: LeaseProof,
    sessionId: string,
    snapshot: BrowserSnapshot,
  ): Promise<BrowserSnapshot> {
    return this.#coordinator.recordAuthObservation(
      this.#scope,
      proof,
      sessionId,
      snapshot,
    );
  }
  async recognizeAuth(
    proof: LeaseProof,
    sessionId: string,
    snapshotId: string,
    slot: AuthRecognitionSlot,
    signal?: AbortSignal,
  ): Promise<AuthRecognitionResult> {
    if (!['username', 'password', 'submit', 'otp', 'success'].includes(slot))
      throw new StorageError('VALIDATION_ERROR');
    const context = await this.#coordinator.tx((client) =>
      this.#coordinator.authStateService.authRecognitionContext(
        client,
        this.#scope,
        proof,
        sessionId,
        snapshotId,
      ),
    );
    const record = await this.#model.callAuthRecognition(
      proof,
      authRecognitionPayload(context.snapshot, slot, context.sensitiveValues),
      signal,
      context.sensitiveValues,
    );
    if (
      !['ok', 'repaired'].includes(record.requestResult) ||
      record.errorCode ||
      !record.data
    )
      throw new StorageError(
        record.errorCode && isErrorCode(record.errorCode)
          ? record.errorCode
          : 'SERVICE_UNAVAILABLE',
      );
    return this.#coordinator.tx((client) =>
      this.#coordinator.authStateService.recordAuthRecognition(
        client,
        this.#scope,
        proof,
        sessionId,
        snapshotId,
        slot,
        record.data,
      ),
    );
  }
  grantAuth(
    proof: LeaseProof,
    request: import('./auth-actions.js').AuthActionRequest,
  ): Promise<import('./auth-actions.js').AuthPermit> {
    return this.#coordinator.grantAuth(this.#scope, proof, request);
  }
  beginAuthExecution(
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
  ): Promise<import('./auth-actions.js').AuthExecutionReceipt> {
    return this.#coordinator.beginAuthExecution(
      this.#scope,
      proof,
      sessionId,
      grantId,
    );
  }
  recordAuth(
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    receipt: import('./auth-actions.js').AuthExecutionReceipt,
    outcome: import('./auth-actions.js').AuthActionOutcome,
  ): Promise<void> {
    return this.#coordinator.recordAuth(
      this.#scope,
      proof,
      sessionId,
      grantId,
      receipt,
      outcome,
    );
  }
  finishAuth(
    proof: LeaseProof,
    sessionId: string,
    authStateId: string,
  ): Promise<void> {
    return this.#coordinator.finishAuth(
      this.#scope,
      proof,
      sessionId,
      authStateId,
    );
  }
  authMaterial(
    proof: LeaseProof,
    sessionId: string,
  ): Promise<CredentialMaterial> {
    return this.#coordinator.authMaterial(this.#scope, proof, sessionId);
  }
  recordAuthCriterion(
    proof: LeaseProof,
    sessionId: string,
    criterionResult: CriterionResult,
    snapshotId: string,
  ): Promise<{ gateId: string }> {
    return this.#coordinator.recordAuthCriterion(
      this.#scope,
      proof,
      sessionId,
      criterionResult,
      snapshotId,
    );
  }
  issueCaptureGrant(
    proof: LeaseProof,
    sessionId: string,
    gateId: string,
  ): Promise<{
    grant: import('@localqa/browser').AuthExportGrant;
    captureTicket: string;
  }> {
    return this.#coordinator.issueCaptureGrant(
      this.#scope,
      proof,
      sessionId,
      gateId,
    );
  }
  beginAuthCapture(
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    ticket: string,
  ): Promise<void> {
    return this.#coordinator.beginAuthCapture(
      this.#scope,
      proof,
      sessionId,
      grantId,
      ticket,
    );
  }
  captureAuthState(
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    ticket: string,
    state: import('@localqa/browser').ApprovedAuthState,
  ): Promise<import('./auth-state-service.js').AuthStateRef> {
    return this.#coordinator.captureAuthState(
      this.#scope,
      proof,
      sessionId,
      grantId,
      ticket,
      state,
    );
  }
}
