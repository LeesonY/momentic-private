import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseContract } from '@localqa/contracts';
import type { NodeTarget, BrowserSnapshot, Step } from '@localqa/contracts';
import {
  StorageError,
  hashPayload,
  type WorkerScope,
  type LeaseProof,
} from '@localqa/storage';
import { validateTarget, displayUrl } from '@localqa/domain';
import type { Coordinator } from './core.js';
import { signInKind, type AuthSessionPurpose } from './auth-execution.js';

/** Per private self-sign-in session, including failed/unknown/pending intents.
 * Separate from both the shared run action budget and the case allowance. */
export const MAX_SELF_SIGN_IN_ACTIONS = 20;

export type AuthActionName =
  'navigate_auth' | 'fill_credential' | 'submit_auth' | 'import_storage_state';

export type AuthActionSlot =
  | 'login_url'
  | 'username'
  | 'password'
  | 'otp'
  | 'variable'
  | 'submit'
  | 'storage_state';

export interface AuthActionRequest {
  requestId: string;
  sessionId: string;
  action: AuthActionName;
  slot: AuthActionSlot;
  target?: NodeTarget | undefined;
}

export interface AuthPermit {
  grantId: string;
  sessionId: string;
  taskId: string;
  runId: string;
  projectId: string;
  workerId: string;
  fencingToken: number;
  contextVersion: number;
  contextId: string;
  profileId: string;
  profileVersion: number;
  authEpoch: number;
  purpose: AuthSessionPurpose;
  deadline: string;
  action: AuthActionName;
  slot: AuthActionSlot;
  target?: NodeTarget | undefined;
  url?: string | undefined;
}

export interface AuthExecutionReceipt {
  grantId: string;
  executionId: string;
  startedAt: string;
}

export interface AuthActionOutcome {
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  snapshot?: BrowserSnapshot | null | undefined;
  evidence?: string[] | undefined;
}

const ACTION_SLOT_MAP: Record<AuthActionName, AuthActionSlot[]> = {
  navigate_auth: ['login_url'],
  fill_credential: ['username', 'password', 'otp', 'variable'],
  submit_auth: ['submit'],
  import_storage_state: ['storage_state'],
};

function validateActionSlot(
  action: AuthActionName,
  slot: AuthActionSlot,
): void {
  const allowed = ACTION_SLOT_MAP[action];
  if (!allowed || !allowed.includes(slot)) {
    throw new StorageError('VALIDATION_ERROR');
  }
}

async function verifyLeaseNotExpired(
  client: PoolClient,
  proof: LeaseProof,
): Promise<Date> {
  const leaseRow = (
    await client.query<{ lease_until: Date }>(
      `SELECT l.lease_until
       FROM task_leases l
       JOIN jobs j ON j.id = l.task_id AND j.fencing_token = l.fencing_token
       WHERE l.task_id = $1
         AND l.fencing_token = $2
         AND l.released_at IS NULL
         AND l.lease_until > clock_timestamp()
         AND j.lease_until > clock_timestamp()
         AND j.status = 'running'`,
      [proof.taskId, proof.fencingToken],
    )
  ).rows[0];

  if (!leaseRow) {
    throw new StorageError('LEASE_EXPIRED');
  }

  return leaseRow.lease_until;
}

async function verifySessionNotExpired(
  client: PoolClient,
  sessionId: string,
): Promise<void> {
  const sessionRow = (
    await client.query<{ id: string }>(
      `SELECT id FROM auth_execution_sessions
       WHERE id = $1 AND expires_at > clock_timestamp()`,
      [sessionId],
    )
  ).rows[0];

  if (!sessionRow) {
    throw new StorageError('LEASE_EXPIRED');
  }
}

export class AuthActionsManager {
  constructor(private readonly coordinator: Coordinator) {}

  async recordAuthObservation(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    snapshotInput: BrowserSnapshot,
  ): Promise<BrowserSnapshot> {
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );

    const kind = await signInKind(this.coordinator, client, job, run);
    if (!kind) {
      throw new StorageError('POLICY_DENIED');
    }

    // 1. Lock scope FOR SHARE
    const scopeRow = (
      await client.query<{ status: string; auth_epoch: number }>(
        `SELECT status, auth_epoch FROM run_auth_scopes
         WHERE project_id = $1 AND run_id = $2
         FOR SHARE`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    // 2. Lock session FOR UPDATE
    const session = (
      await client.query<{
        id: string;
        auth_epoch: number;
        status: string;
        expires_at: Date;
      }>(
        `SELECT id, auth_epoch, status, expires_at
         FROM auth_execution_sessions
         WHERE id = $1 AND project_id = $2 AND task_id = $3
           AND worker_id = $4 AND fencing_token = $5 AND context_version = $6
         FOR UPDATE`,
        [
          sessionId,
          scope.projectId,
          proof.taskId,
          scope.workerId,
          proof.fencingToken,
          proof.contextVersion,
        ],
      )
    ).rows[0];

    if (!session || session.status !== 'active') {
      throw new StorageError('LEASE_EXPIRED');
    }

    if (
      !scopeRow ||
      scopeRow.status === 'revoked' ||
      scopeRow.auth_epoch !== session.auth_epoch
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    // 3. Lock profile FOR SHARE
    const profileRow = (
      await client.query<{ id: string; revoked: boolean }>(
        `SELECT p.id, p.revoked
         FROM auth_profiles p
         JOIN runs r ON r.auth_profile_id = p.id
         WHERE p.project_id = $1 AND r.id = $2
         FOR SHARE OF p`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false) {
      throw new StorageError('AUTH_FAILED');
    }

    // 4. Post-lock clock re-checks
    await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, sessionId);

    // Validate snapshot
    try {
      parseContract('BrowserSnapshot', snapshotInput);
    } catch {
      throw new StorageError('VALIDATION_ERROR');
    }
    if (
      !snapshotInput.redacted ||
      snapshotInput.screenshotRef !== null ||
      snapshotInput.networkSummary.length ||
      snapshotInput.consoleSummary.length
    ) {
      throw new StorageError('VALIDATION_ERROR');
    }
    if (snapshotInput.displayUrl.startsWith('http')) {
      validateTarget(
        snapshotInput.displayUrl,
        run.effectiveConfig.allowedOrigins,
        this.coordinator.protectedOrigins,
      );
    }

    // 5. Strict snapshot ownership & identity check (no cross-session or modified rebinding)
    const existingSnap = (
      await client.query<{
        project_id: string;
        run_id: string;
        task_id: string;
        document: unknown;
        auth_session_id: string | null;
        auth_epoch: number | null;
      }>(
        `SELECT project_id, run_id, task_id, document, auth_session_id, auth_epoch
         FROM page_snapshots
         WHERE id = $1`,
        [snapshotInput.snapshotId],
      )
    ).rows[0];

    if (existingSnap) {
      if (
        existingSnap.project_id !== scope.projectId ||
        existingSnap.run_id !== run.id ||
        existingSnap.task_id !== job.id ||
        existingSnap.auth_session_id !== sessionId ||
        existingSnap.auth_epoch !== session.auth_epoch ||
        hashPayload(existingSnap.document) !== hashPayload(snapshotInput)
      ) {
        throw new StorageError('IDEMPOTENCY_CONFLICT');
      }
      return snapshotInput;
    }

    await client.query(
      `INSERT INTO page_snapshots(
         id, project_id, run_id, task_id, document, auth_session_id, auth_epoch
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        snapshotInput.snapshotId,
        scope.projectId,
        run.id,
        job.id,
        snapshotInput,
        sessionId,
        session.auth_epoch,
      ],
    );

    return snapshotInput;
  }

  async grantAuth(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    request: AuthActionRequest,
  ): Promise<AuthPermit> {
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );

    const kind = await signInKind(this.coordinator, client, job, run);
    if (!kind) {
      throw new StorageError('POLICY_DENIED');
    }

    if (!request.requestId || typeof request.requestId !== 'string') {
      throw new StorageError('VALIDATION_ERROR');
    }

    validateActionSlot(request.action, request.slot);

    // Read profile metadata. A self sign-in uses the version its own session
    // pinned at allocation (the latest one then), not the run's frozen one.
    const runProfile = (
      await client.query<{
        auth_profile_id: string;
        auth_profile_version: number;
        document: unknown;
      }>(
        `SELECT r.auth_profile_id, v.version AS auth_profile_version, v.document
         FROM runs r
         JOIN auth_profile_versions v
           ON v.project_id = r.project_id
          AND v.auth_profile_id = r.auth_profile_id
          AND v.version = CASE WHEN $3::boolean THEN (
            SELECT s.auth_profile_version FROM auth_execution_sessions s
            WHERE s.id = $4::uuid AND s.project_id = r.project_id
              AND s.run_id = r.id AND s.task_id = $5::uuid
          ) ELSE r.auth_profile_version END
         WHERE r.project_id = $1 AND r.id = $2`,
        [
          scope.projectId,
          run.id,
          kind === 'self',
          request.sessionId,
          proof.taskId,
        ],
      )
    ).rows[0];

    if (!runProfile || !runProfile.document) {
      throw new StorageError('AUTH_FAILED');
    }

    const profile = parseContract('AuthProfile', runProfile.document);
    if (
      profile.status !== 'active' ||
      profile.id !== runProfile.auth_profile_id ||
      profile.projectId !== scope.projectId ||
      profile.version !== runProfile.auth_profile_version
    )
      throw new StorageError('AUTH_FAILED');
    if (profile.mode === 'none') {
      throw new StorageError('POLICY_DENIED');
    }

    if (
      (profile.mode === 'form' || profile.mode === 'agent') &&
      request.action === 'import_storage_state'
    ) {
      throw new StorageError('VALIDATION_ERROR');
    }
    // Fixed form slots and named agent variables never cross modes.
    if (
      request.action === 'fill_credential' &&
      request.slot !== 'otp' &&
      (request.slot === 'variable') !== (profile.mode === 'agent')
    ) {
      throw new StorageError('VALIDATION_ERROR');
    }
    if (
      profile.mode === 'storage_state' &&
      (request.action === 'fill_credential' || request.action === 'submit_auth')
    ) {
      throw new StorageError('VALIDATION_ERROR');
    }
    // AI-recognized forms and agent sign-in may ask the user for one code
    // when the page shows a verification step, like Mo asking in the chat.
    if (
      request.slot === 'otp' &&
      profile.mode !== 'agent' &&
      !profile.formConfig?.otpTarget &&
      profile.formConfig?.detectionMode !== 'ai'
    ) {
      throw new StorageError('VALIDATION_ERROR');
    }

    // 1. Lock scope FOR UPDATE
    const scopeRow = (
      await client.query<{ status: string; auth_epoch: number }>(
        `SELECT status, auth_epoch FROM run_auth_scopes
         WHERE project_id = $1 AND run_id = $2
         FOR UPDATE`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    // 2. Lock session FOR UPDATE (fetch full authority tuple)
    const session = (
      await client.query<{
        id: string;
        context_id: string;
        auth_profile_id: string;
        auth_profile_version: number;
        auth_epoch: number;
        purpose: AuthSessionPurpose;
        status: string;
        expires_at: Date;
      }>(
        `SELECT id, context_id, auth_profile_id, auth_profile_version, auth_epoch, purpose, status, expires_at
         FROM auth_execution_sessions
         WHERE id = $1 AND project_id = $2 AND task_id = $3
           AND worker_id = $4 AND fencing_token = $5 AND context_version = $6
         FOR UPDATE`,
        [
          request.sessionId,
          scope.projectId,
          proof.taskId,
          scope.workerId,
          proof.fencingToken,
          proof.contextVersion,
        ],
      )
    ).rows[0];

    if (!session || session.status !== 'active') {
      throw new StorageError('LEASE_EXPIRED');
    }

    if (
      session.auth_profile_id !== profile.id ||
      session.auth_profile_version !== profile.version
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    if (
      !scopeRow ||
      scopeRow.status === 'revoked' ||
      scopeRow.auth_epoch !== session.auth_epoch
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    // 3. Lock profile FOR SHARE
    const profileRow = (
      await client.query<{
        id: string;
        revoked: boolean;
        current_status: string;
      }>(
        `SELECT p.id,p.revoked,h.document->>'status' AS current_status
         FROM auth_profiles p
         JOIN auth_profile_versions h ON h.project_id=p.project_id
           AND h.auth_profile_id=p.id AND h.version=p.version
         WHERE p.project_id=$1 AND p.id=$2 AND p.deleted_at IS NULL
         FOR SHARE OF p`,
        [scope.projectId, profile.id],
      )
    ).rows[0];

    if (
      !profileRow ||
      profileRow.revoked !== false ||
      (kind === 'self' && profileRow.current_status !== 'active')
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    // 4. Post-lock clock re-checks
    const currentLeaseUntil = await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, request.sessionId);

    // Deadline <= min(session.expires_at, job.lease_until)
    const deadlineDate =
      new Date(session.expires_at) < new Date(currentLeaseUntil)
        ? session.expires_at
        : currentLeaseUntil;
    const deadline = deadlineDate.toISOString();

    // Target provenance check
    if (
      request.action === 'fill_credential' ||
      request.action === 'submit_auth'
    ) {
      if (!request.target) {
        throw new StorageError('VALIDATION_ERROR');
      }
      const snapshotRow = (
        await client.query<{ document: unknown }>(
          `SELECT document FROM page_snapshots
           WHERE project_id = $1 AND run_id = $2 AND task_id = $3
             AND id = $4 AND auth_session_id = $5`,
          [
            scope.projectId,
            run.id,
            job.id,
            request.target.snapshotId,
            request.sessionId,
          ],
        )
      ).rows[0];

      if (!snapshotRow) {
        throw new StorageError('NOT_FOUND');
      }

      const snapDoc = snapshotRow.document as BrowserSnapshot;
      if (snapDoc.pageId !== request.target.pageId) {
        throw new StorageError('NOT_FOUND');
      }

      const hasNode = snapDoc.nodes.some(
        (n) =>
          n.nodeId === request.target!.nodeId &&
          n.frameId === (request.target!.frameId ?? 'main'),
      );
      if (!hasNode) {
        throw new StorageError('NOT_FOUND');
      }
    } else if (request.target) {
      throw new StorageError('VALIDATION_ERROR');
    }

    // Idempotency check on (auth_session_id, request_id)
    const requestHash = hashPayload({
      action: request.action,
      slot: request.slot,
      target: request.target ?? null,
    });

    const existingReq = (
      await client.query<{
        grant_id: string;
        request_hash: string;
      }>(
        `SELECT grant_id, request_hash FROM auth_action_requests
         WHERE auth_session_id = $1 AND request_id = $2
         FOR UPDATE`,
        [request.sessionId, request.requestId],
      )
    ).rows[0];

    let serverUrl: string | undefined;
    if (request.action === 'navigate_auth') {
      if (profile.mode === 'form') {
        serverUrl = profile.formConfig?.loginUrl;
      } else if (profile.mode === 'agent' && profile.agentConfig?.loginUrl) {
        serverUrl = profile.agentConfig.loginUrl;
      } else if (profile.mode === 'storage_state' || profile.mode === 'agent') {
        let targetUrl = run.targetUrl;
        const raw = (
          await client.query<{
            ciphertext: Buffer;
            nonce: Buffer;
            auth_tag: Buffer;
            key_version: number;
            secret_id: string;
            purpose: string;
          }>(
            `SELECT v.ciphertext, v.nonce, v.auth_tag, v.key_version, v.secret_id, s.purpose
             FROM runs r
             JOIN secret_versions v
               ON v.secret_id = r.raw_url_secret_id
              AND v.version = r.raw_url_secret_version
              AND v.project_id = r.project_id
             JOIN secrets s ON s.id = v.secret_id
             WHERE r.id = $1 AND r.project_id = $2 AND NOT s.revoked`,
            [run.id, scope.projectId],
          )
        ).rows[0];
        if (raw) {
          targetUrl = this.coordinator.vault.decrypt(
            {
              ciphertext: raw.ciphertext,
              nonce: raw.nonce,
              authTag: raw.auth_tag,
              keyVersion: raw.key_version,
            },
            {
              projectId: scope.projectId,
              secretId: raw.secret_id,
              purpose: raw.purpose,
            },
          );
        }
        serverUrl = targetUrl;
      }
    }

    if (existingReq) {
      if (existingReq.request_hash !== requestHash) {
        throw new StorageError('IDEMPOTENCY_CONFLICT');
      }

      const existingIntent = (
        await client.query<{ id: string }>(
          'SELECT id FROM action_intents WHERE id = $1',
          [existingReq.grant_id],
        )
      ).rows[0];

      if (!existingIntent) {
        throw new StorageError('NOT_FOUND');
      }

      return {
        grantId: existingReq.grant_id,
        sessionId: request.sessionId,
        taskId: job.id,
        runId: run.id,
        projectId: scope.projectId,
        workerId: scope.workerId,
        fencingToken: proof.fencingToken,
        contextVersion: proof.contextVersion,
        contextId: session.context_id,
        profileId: session.auth_profile_id,
        profileVersion: session.auth_profile_version,
        authEpoch: session.auth_epoch,
        purpose: session.purpose,
        deadline,
        action: request.action,
        slot: request.slot,
        target: request.target,
        url: serverUrl,
      };
    }

    if (kind === 'self') {
      // The session row is already locked FOR UPDATE, so parallel requests
      // cannot race past this cap. Retries of the same request returned above.
      const used = (await client.query<{ n: number }>(
        'SELECT count(*)::integer n FROM action_intents WHERE project_id=$1 AND auth_session_id=$2',
        [scope.projectId, session.id],
      )).rows[0]!.n;
      if (used >= MAX_SELF_SIGN_IN_ACTIONS)
        throw new StorageError('AUTH_FAILED');
    }
    // Keep the intent/reservation/step ledger intact, but task-local sign-in
    // spends its own cap, not maxActions. Legacy run-level auth is unchanged.
    const reservation = await this.coordinator.reserve(
      client,
      scope,
      proof,
      'action',
      kind === 'self' ? {} : { actions: 1 },
    );

    const grantId = randomUUID();
    const toolCall = {
      name: request.action,
      args: {
        slot: request.slot,
        ...(request.target ? { target: request.target } : {}),
        ...(serverUrl ? { url: displayUrl(serverUrl) } : {}),
      },
    };

    // Insert action_intents as private auth intent
    await client.query(
      `INSERT INTO action_intents(
         id, project_id, run_id, task_id, fencing_token, context_version, reservation_id,
         tool_call, outcome, auth_session_id, auth_epoch, execution_state
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, 'pending', $9, $10, 'issued'
       )`,
      [
        grantId,
        scope.projectId,
        run.id,
        job.id,
        proof.fencingToken,
        proof.contextVersion,
        reservation.id,
        toolCall,
        request.sessionId,
        session.auth_epoch,
      ],
    );

    // Insert Step
    const seq = (
      await client.query<{ n: number }>(
        'SELECT COALESCE(max(seq), 0) + 1 AS n FROM steps WHERE project_id = $1 AND task_id = $2',
        [scope.projectId, job.id],
      )
    ).rows[0]!.n;

    const step = parseContract('Step', {
      id: randomUUID(),
      runId: run.id,
      taskId: job.id,
      caseId: null,
      seq,
      toolName: request.action,
      status: 'running',
      summary: 'Auth action intent persisted before execution',
      targetDescription: request.action,
      evidenceRefs: [],
      createdAt: new Date().toISOString(),
      finishedAt: null,
    });

    await client.query(
      'INSERT INTO steps(id, project_id, run_id, task_id, case_id, action_id, seq, document) VALUES($1, $2, $3, $4, NULL, $5, $6, $7)',
      [step.id, scope.projectId, run.id, job.id, grantId, seq, step],
    );

    // Insert auth_action_requests for idempotency
    await client.query(
      `INSERT INTO auth_action_requests(
         id, project_id, run_id, task_id, auth_session_id, request_id, request_hash, action, slot, grant_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        scope.projectId,
        run.id,
        job.id,
        request.sessionId,
        request.requestId,
        requestHash,
        request.action,
        request.slot,
        grantId,
      ],
    );

    return {
      grantId,
      sessionId: request.sessionId,
      taskId: job.id,
      runId: run.id,
      projectId: scope.projectId,
      workerId: scope.workerId,
      fencingToken: proof.fencingToken,
      contextVersion: proof.contextVersion,
      contextId: session.context_id,
      profileId: session.auth_profile_id,
      profileVersion: session.auth_profile_version,
      authEpoch: session.auth_epoch,
      purpose: session.purpose,
      deadline,
      action: request.action,
      slot: request.slot,
      target: request.target,
      url: serverUrl,
    };
  }

  async beginAuthExecution(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
  ): Promise<AuthExecutionReceipt> {
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );

    const kind = await signInKind(this.coordinator, client, job, run);
    if (!kind) {
      throw new StorageError('POLICY_DENIED');
    }

    // 1. Lock intent FOR UPDATE
    const intent = (
      await client.query<{
        id: string;
        auth_session_id: string | null;
        auth_epoch: number | null;
        fencing_token: string;
        context_version: number;
        execution_state: string;
      }>(
        `SELECT id, auth_session_id, auth_epoch, fencing_token, context_version, execution_state
         FROM action_intents
         WHERE id = $1 AND project_id = $2 AND task_id = $3
         FOR UPDATE`,
        [grantId, scope.projectId, job.id],
      )
    ).rows[0];

    if (!intent || intent.auth_session_id !== sessionId) {
      throw new StorageError('NOT_FOUND');
    }

    if (
      intent.fencing_token !== String(proof.fencingToken) ||
      intent.context_version !== proof.contextVersion
    ) {
      throw new StorageError('LEASE_EXPIRED');
    }

    if (intent.execution_state !== 'issued') {
      throw new StorageError('VERSION_CONFLICT');
    }

    // 2. Lock scope FOR UPDATE
    const scopeRow = (
      await client.query<{ status: string; auth_epoch: number }>(
        `SELECT status, auth_epoch FROM run_auth_scopes
         WHERE project_id = $1 AND run_id = $2
         FOR UPDATE`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    // 3. Lock session FOR UPDATE
    const session = (
      await client.query<{
        id: string;
        auth_profile_id: string;
        auth_profile_version: number;
        auth_epoch: number;
        status: string;
        expires_at: Date;
      }>(
        `SELECT id, auth_profile_id, auth_profile_version, auth_epoch, status, expires_at
         FROM auth_execution_sessions
         WHERE id = $1 AND project_id = $2 AND task_id = $3
           AND worker_id = $4 AND fencing_token = $5 AND context_version = $6
         FOR UPDATE`,
        [
          sessionId,
          scope.projectId,
          proof.taskId,
          scope.workerId,
          proof.fencingToken,
          proof.contextVersion,
        ],
      )
    ).rows[0];

    if (!session || session.status !== 'active') {
      throw new StorageError('LEASE_EXPIRED');
    }

    if (
      !scopeRow ||
      scopeRow.status === 'revoked' ||
      scopeRow.auth_epoch !== intent.auth_epoch
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    // 4. Lock profile FOR SHARE
    const profileRow = (
      await client.query<{
        id: string;
        revoked: boolean;
        sharing_policy: string;
        current_status: string;
        selected_status: string;
      }>(
        `SELECT p.id,p.revoked,v.document->>'sharingPolicy' AS sharing_policy,
           h.document->>'status' AS current_status,v.document->>'status' AS selected_status
         FROM auth_profiles p
         JOIN auth_profile_versions h ON h.project_id=p.project_id
           AND h.auth_profile_id=p.id AND h.version=p.version
         JOIN auth_profile_versions v
           ON v.project_id=p.project_id AND v.auth_profile_id=p.id
         JOIN runs r ON r.project_id=p.project_id AND r.auth_profile_id=p.id
         WHERE p.project_id=$1 AND r.id=$2 AND p.deleted_at IS NULL
           AND p.id=$5::uuid AND v.version=CASE WHEN $3::boolean
             THEN $4::integer ELSE r.auth_profile_version END
         FOR SHARE OF p`,
        [
          scope.projectId,
          run.id,
          kind === 'self',
          session.auth_profile_version,
          session.auth_profile_id,
        ],
      )
    ).rows[0];

    if (
      !profileRow ||
      profileRow.revoked !== false ||
      (kind === 'self' &&
        (profileRow.current_status !== 'active' ||
          profileRow.selected_status !== 'active'))
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    // 5. A self sign-in took the exclusive lock for its own session at
    // allocation; it may act only while that exact lock is still held.
    if (kind === 'self' && profileRow.sharing_policy === 'exclusive_run') {
      const own = await client.query(
        "SELECT 1 FROM auth_profile_run_locks WHERE project_id=$1 AND auth_profile_id=$2 AND run_id=$3 AND auth_session_id=$4 AND status='held' FOR UPDATE",
        [scope.projectId, profileRow.id, run.id, sessionId],
      );
      if (!own.rowCount) throw new StorageError('RATE_LIMITED');
    } else if (profileRow.sharing_policy === 'exclusive_run') {
      const lockRow = (
        await client.query<{
          id: string;
          run_id: string;
          status: string;
        }>(
          `SELECT id, run_id, status FROM auth_profile_run_locks
           WHERE project_id = $1 AND auth_profile_id = $2 AND status = 'held'
           FOR UPDATE`,
          [scope.projectId, profileRow.id],
        )
      ).rows[0];

      if (lockRow) {
        if (lockRow.run_id !== run.id) {
          throw new StorageError('RATE_LIMITED');
        }
      } else {
        await client.query(
          `INSERT INTO auth_profile_run_locks(
             id, project_id, auth_profile_id, run_id, auth_session_id,
             auth_epoch, status, phase, held_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'held', 'initializing', clock_timestamp()
           ) ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            scope.projectId,
            profileRow.id,
            run.id,
            sessionId,
            intent.auth_epoch,
          ],
        );

        const acquired = (
          await client.query<{ run_id: string }>(
            `SELECT run_id FROM auth_profile_run_locks
             WHERE project_id = $1 AND auth_profile_id = $2 AND status = 'held'`,
            [scope.projectId, profileRow.id],
          )
        ).rows[0];

        if (!acquired || acquired.run_id !== run.id) {
          throw new StorageError('RATE_LIMITED');
        }
      }
    }

    // 6. Post-lock clock re-checks
    await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, sessionId);

    // CAS execution state: issued -> started
    const executionId = randomUUID();
    const updated = (
      await client.query<{ started_at: Date }>(
        `UPDATE action_intents
         SET execution_state = 'started', execution_id = $1, started_at = clock_timestamp()
         WHERE id = $2 AND execution_state = 'issued'
         RETURNING started_at`,
        [executionId, grantId],
      )
    ).rows[0];

    if (!updated) {
      throw new StorageError('VERSION_CONFLICT');
    }

    return {
      grantId,
      executionId,
      startedAt: updated.started_at.toISOString(),
    };
  }

  async recordAuth(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    receipt: AuthExecutionReceipt,
    outcome: AuthActionOutcome,
  ): Promise<void> {
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );

    const kind = await signInKind(this.coordinator, client, job, run);
    if (!kind) {
      throw new StorageError('POLICY_DENIED');
    }

    // 1. Lock intent FOR UPDATE
    const intent = (
      await client.query<{
        id: string;
        reservation_id: string;
        outcome: string;
        result_hash: string | null;
        execution_state: string;
        execution_id: string | null;
        auth_session_id: string | null;
        auth_epoch: number | null;
      }>(
        `SELECT id, reservation_id, outcome, result_hash, execution_state,
                execution_id, auth_session_id, auth_epoch
         FROM action_intents
         WHERE id = $1 AND project_id = $2 AND task_id = $3
         FOR UPDATE`,
        [grantId, scope.projectId, job.id],
      )
    ).rows[0];

    if (!intent || intent.auth_session_id !== sessionId) {
      throw new StorageError('NOT_FOUND');
    }

    // Compute complete outcome hash (includes snapshot and evidence)
    const resultHash = hashPayload({
      status: outcome.status,
      snapshot: outcome.snapshot ?? null,
      evidence: outcome.evidence ?? [],
    });

    // Idempotent retry check on completed intent
    if (intent.execution_state === 'completed') {
      if (intent.result_hash !== resultHash) {
        throw new StorageError('IDEMPOTENCY_CONFLICT');
      }
      return;
    }

    if (intent.execution_state !== 'started') {
      throw new StorageError('VALIDATION_ERROR');
    }

    if (intent.execution_id !== receipt.executionId) {
      throw new StorageError('VERSION_CONFLICT');
    }

    // 2. Lock scope FOR SHARE
    const scopeRow = (
      await client.query<{ status: string; auth_epoch: number }>(
        `SELECT status, auth_epoch FROM run_auth_scopes
         WHERE project_id = $1 AND run_id = $2
         FOR SHARE`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    // 3. Lock session FOR UPDATE
    const session = (
      await client.query<{
        id: string;
        auth_profile_id: string;
        auth_epoch: number;
        status: string;
        expires_at: Date;
      }>(
        `SELECT id, auth_profile_id, auth_epoch, status, expires_at
         FROM auth_execution_sessions
         WHERE id = $1 AND project_id = $2 AND task_id = $3
         FOR UPDATE`,
        [sessionId, scope.projectId, job.id],
      )
    ).rows[0];

    if (!session || session.status !== 'active') {
      throw new StorageError('LEASE_EXPIRED');
    }

    if (
      !scopeRow ||
      scopeRow.status === 'revoked' ||
      scopeRow.auth_epoch !== intent.auth_epoch
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    // 4. Lock profile FOR SHARE
    const profileRow = (
      await client.query<{ id: string; revoked: boolean }>(
        `SELECT p.id, p.revoked
         FROM auth_profiles p
         JOIN runs r ON r.auth_profile_id = p.id
         WHERE p.project_id = $1 AND r.id = $2
         FOR SHARE OF p`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false) {
      throw new StorageError('AUTH_FAILED');
    }

    // 5. Post-lock clock re-checks
    await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, sessionId);

    // Verify all evidence artifacts exist and belong to this project, run, and task
    if (outcome.evidence && outcome.evidence.length > 0) {
      const owned = (
        await client.query<{ id: string }>(
          `SELECT id FROM artifacts
           WHERE project_id = $1 AND run_id = $2 AND task_id = $3
             AND id = ANY($4::uuid[])`,
          [scope.projectId, run.id, job.id, outcome.evidence],
        )
      ).rows.map((r) => r.id);

      if (owned.length !== new Set(outcome.evidence).size) {
        throw new StorageError('NOT_FOUND');
      }
    }

    // Save snapshot if provided
    if (outcome.snapshot) {
      try {
        parseContract('BrowserSnapshot', outcome.snapshot);
      } catch {
        throw new StorageError('VALIDATION_ERROR');
      }
      await client.query(
        `INSERT INTO page_snapshots(
           id, project_id, run_id, task_id, document, auth_session_id, auth_epoch
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          outcome.snapshot.snapshotId,
          scope.projectId,
          run.id,
          job.id,
          outcome.snapshot,
          sessionId,
          intent.auth_epoch,
        ],
      );
    }

    // Self-sign-in receipts keep their ledger/evidence without charging the
    // shared run action budget. Unknown outcomes charge the reserved amount
    // (also empty for self sign-in), just like crash recovery.
    await this.coordinator.settleIn(
      client,
      scope,
      proof,
      intent.reservation_id,
      kind === 'self' ? {} : { actions: 1 },
      outcome.status === 'unknown' ? 'unknown' : 'reported',
    );

    // Update action_intents to completed
    await client.query(
      `UPDATE action_intents
       SET outcome = $2, result_hash = $3, execution_state = 'completed'
       WHERE id = $1`,
      [grantId, outcome.status, resultHash],
    );

    // Update Step document
    const stepRow = (
      await client.query<{ id: string; document: unknown }>(
        'SELECT id, document FROM steps WHERE action_id = $1',
        [grantId],
      )
    ).rows[0];

    if (stepRow) {
      const step = {
        ...(stepRow.document as Step),
        status: outcome.status,
        summary: `Auth ${outcome.status}`,
        finishedAt: new Date().toISOString(),
      };

      await client.query('UPDATE steps SET document = $2 WHERE id = $1', [
        stepRow.id,
        step,
      ]);
    }

    // If outcome is failed/cancelled, release initializing lock if held by this run
    if (outcome.status === 'failed' || outcome.status === 'cancelled') {
      // A self sign-in releases only its own lock, never a sibling task's.
      await client.query(
        `UPDATE auth_profile_run_locks
         SET status = 'released', released_at = clock_timestamp(), release_reason = $3
         WHERE project_id = $1 AND run_id = $2 AND phase = 'initializing' AND status = 'held'
           AND ($4::uuid IS NULL OR auth_session_id = $4::uuid)`,
        [
          scope.projectId,
          run.id,
          `auth_${outcome.status}`,
          kind === 'self' ? sessionId : null,
        ],
      );
    }
  }
}
