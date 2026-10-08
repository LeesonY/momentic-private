import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseContract } from '@localqa/contracts';
import type { CriterionResult, CredentialMaterial } from '@localqa/contracts';
import {
  StorageError,
  hashPayload,
  type WorkerScope,
  type LeaseProof,
} from '@localqa/storage';
import {
  validateApprovedAuthState,
  type ApprovedAuthState,
  type AuthExportGrant,
} from '@localqa/browser';
import type { Coordinator } from './core.js';
import type { AuthSessionPurpose } from './auth-execution.js';

export interface AuthStateRef {
  authStateId: string;
  runId: string;
  authEpoch: number;
  capturedAt: string;
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

export class AuthStateService {
  constructor(private readonly coordinator: Coordinator) {}

  async authMaterial(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<CredentialMaterial> {
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );

    if (job.document.summary !== 'auth') {
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
      scopeRow.auth_epoch !== session.auth_epoch
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    // 3. Lock profile FOR SHARE
    const profileRow = (
      await client.query<{
        id: string;
        revoked: boolean;
        secret_id: string | null;
        secret_version: number | null;
        document: unknown;
      }>(
        `SELECT p.id, p.revoked, v.secret_id, v.secret_version, v.document
         FROM auth_profiles p
         JOIN auth_profile_versions v
           ON v.project_id = p.project_id AND v.auth_profile_id = p.id
          AND v.version = $3
         WHERE p.project_id = $1 AND p.id = $2
         FOR SHARE OF p`,
        [
          scope.projectId,
          session.auth_profile_id,
          session.auth_profile_version,
        ],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false || !profileRow.document) {
      throw new StorageError('AUTH_FAILED');
    }

    const profile = parseContract('AuthProfile', profileRow.document);
    if (profile.mode === 'none') {
      throw new StorageError('POLICY_DENIED');
    }

    // 4. Post-lock clock re-checks
    const currentLeaseUntil = await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, sessionId);

    let material: Record<string, unknown> = {};
    if (profileRow.secret_id && profileRow.secret_version) {
      const secret = (
        await client.query<{
          ciphertext: Buffer;
          nonce: Buffer;
          auth_tag: Buffer;
          key_version: number;
          purpose: string;
        }>(
          `SELECT v.ciphertext, v.nonce, v.auth_tag, v.key_version, s.purpose
           FROM secret_versions v
           JOIN secrets s ON s.id = v.secret_id AND s.project_id = v.project_id
           WHERE v.project_id = $1 AND v.secret_id = $2 AND v.version = $3 AND NOT s.revoked`,
          [scope.projectId, profileRow.secret_id, profileRow.secret_version],
        )
      ).rows[0];

      if (!secret) {
        throw new StorageError('AUTH_FAILED');
      }

      material = JSON.parse(
        this.coordinator.vault.decrypt(
          {
            ciphertext: secret.ciphertext,
            nonce: secret.nonce,
            authTag: secret.auth_tag,
            keyVersion: secret.key_version,
          },
          {
            projectId: scope.projectId,
            secretId: profileRow.secret_id,
            purpose: secret.purpose,
          },
        ),
      );
    }

    const expiresAt =
      new Date(session.expires_at) < new Date(currentLeaseUntil)
        ? session.expires_at.toISOString()
        : currentLeaseUntil.toISOString();

    return parseContract('CredentialMaterial', {
      mode: profile.mode,
      material,
      expiresAt,
    });
  }

  async recordAuthCriterion(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    criterionResult: CriterionResult,
    snapshotId: string,
  ): Promise<{ gateId: string }> {
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );

    if (job.document.summary !== 'auth') {
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
        auth_profile_id: string;
        auth_profile_version: number;
        auth_epoch: number;
        status: string;
      }>(
        `SELECT id, auth_profile_id, auth_profile_version, auth_epoch, status
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
      await client.query<{
        id: string;
        revoked: boolean;
        document: unknown;
      }>(
        `SELECT p.id, p.revoked, v.document
         FROM auth_profiles p
         JOIN auth_profile_versions v
           ON v.project_id = p.project_id AND v.auth_profile_id = p.id
          AND v.version = $3
         WHERE p.project_id = $1 AND p.id = $2
         FOR SHARE OF p`,
        [
          scope.projectId,
          session.auth_profile_id,
          session.auth_profile_version,
        ],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false || !profileRow.document) {
      throw new StorageError('AUTH_FAILED');
    }

    const profile = parseContract('AuthProfile', profileRow.document);
    if (profile.mode === 'none') {
      throw new StorageError('POLICY_DENIED');
    }

    // Form profile must match frozen successCriterion
    if (profile.mode === 'form') {
      if (
        !profile.formConfig?.successCriterion ||
        criterionResult.criterionId !== profile.formConfig.successCriterion.id
      ) {
        throw new StorageError('VALIDATION_ERROR');
      }
    } else {
      // Storage mode without server frozen criterion explicitly refuses capture gate
      throw new StorageError('POLICY_DENIED');
    }

    // Result must be 'passed'
    if (criterionResult.result !== 'passed') {
      throw new StorageError('POLICY_DENIED');
    }

    // 4. Post-lock clock re-checks
    await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, sessionId);

    // Verify snapshot was registered for this session and task
    const snapRow = (
      await client.query<{ id: string; document: unknown }>(
        `SELECT id, document FROM page_snapshots
         WHERE id = $1 AND project_id = $2 AND run_id = $3
           AND task_id = $4 AND auth_session_id = $5`,
        [snapshotId, scope.projectId, run.id, job.id, sessionId],
      )
    ).rows[0];

    if (!snapRow) {
      throw new StorageError('NOT_FOUND');
    }

    // Verify all auth action intents for this task are completed (no pending intents)
    const pendingIntents = (
      await client.query<{ id: string }>(
        `SELECT id FROM action_intents
         WHERE task_id = $1 AND project_id = $2
           AND (outcome = 'pending' OR execution_state != 'completed')
         LIMIT 1`,
        [job.id, scope.projectId],
      )
    ).rows;

    if (pendingIntents.length > 0) {
      throw new StorageError('VALIDATION_ERROR');
    }

    const gateId = randomUUID();
    const snapshotHash = hashPayload(snapRow.document);

    await client.query(
      `INSERT INTO auth_success_gates(
         id, project_id, run_id, task_id, auth_session_id, auth_epoch,
         criterion_id, snapshot_id, snapshot_hash, result
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'passed')`,
      [
        gateId,
        scope.projectId,
        run.id,
        job.id,
        sessionId,
        session.auth_epoch,
        criterionResult.criterionId,
        snapshotId,
        snapshotHash,
      ],
    );

    return { gateId };
  }

  async issueCaptureGrant(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    gateId: string,
  ): Promise<{ grant: AuthExportGrant; captureTicket: string }> {
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );

    if (job.document.summary !== 'auth') {
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
         WHERE p.project_id = $1 AND p.id = $2
         FOR SHARE OF p`,
        [scope.projectId, session.auth_profile_id],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false) {
      throw new StorageError('AUTH_FAILED');
    }

    // 4. Verify gate belongs to this session and epoch
    const gate = (
      await client.query<{ id: string }>(
        `SELECT id FROM auth_success_gates
         WHERE id = $1 AND project_id = $2 AND run_id = $3
           AND task_id = $4 AND auth_session_id = $5 AND auth_epoch = $6`,
        [
          gateId,
          scope.projectId,
          run.id,
          job.id,
          sessionId,
          session.auth_epoch,
        ],
      )
    ).rows[0];

    if (!gate) {
      throw new StorageError('NOT_FOUND');
    }

    // 5. Post-lock clock re-checks
    const currentLeaseUntil = await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, sessionId);

    const grantId = randomUUID();
    const ticket = randomBytes(32).toString('hex');
    const ticketHash = createHash('sha256').update(ticket).digest('hex');

    const deadlineDate =
      new Date(session.expires_at) < new Date(currentLeaseUntil)
        ? session.expires_at
        : currentLeaseUntil;
    const deadline = deadlineDate.toISOString();

    await client.query(
      `INSERT INTO auth_capture_grants(
         id, project_id, run_id, task_id, auth_session_id, auth_epoch,
         ticket_hash, success_gate_id, status, deadline
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'issued', $9)`,
      [
        grantId,
        scope.projectId,
        run.id,
        job.id,
        sessionId,
        session.auth_epoch,
        ticketHash,
        gateId,
        deadline,
      ],
    );

    const grant: AuthExportGrant = {
      grantId,
      kind: 'capture_auth_state',
      sessionId,
      taskId: proof.taskId,
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
      status: session.status,
      deadline,
      captureTicket: ticket,
      expiresAt: session.expires_at.toISOString(),
    };

    return { grant, captureTicket: ticket };
  }

  async beginAuthCapture(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    ticket: string,
  ): Promise<void> {
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );

    if (job.document.summary !== 'auth') {
      throw new StorageError('POLICY_DENIED');
    }

    // 1. Lock grant FOR UPDATE
    const grant = (
      await client.query<{
        id: string;
        ticket_hash: string;
        status: string;
        deadline: Date;
        auth_epoch: number;
        success_gate_id: string;
      }>(
        `SELECT id, ticket_hash, status, deadline, auth_epoch, success_gate_id
         FROM auth_capture_grants
         WHERE id = $1 AND project_id = $2 AND task_id = $3
           AND auth_session_id = $4
         FOR UPDATE`,
        [grantId, scope.projectId, job.id, sessionId],
      )
    ).rows[0];

    if (!grant) {
      throw new StorageError('NOT_FOUND');
    }

    const ticketHash = createHash('sha256').update(ticket).digest('hex');
    if (grant.ticket_hash !== ticketHash) {
      throw new StorageError('FORBIDDEN');
    }

    if (grant.status !== 'issued') {
      throw new StorageError('VERSION_CONFLICT');
    }

    if (new Date(grant.deadline) <= new Date()) {
      throw new StorageError('LEASE_EXPIRED');
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
      await client.query<{ id: string; status: string; auth_epoch: number }>(
        `SELECT id, status, auth_epoch FROM auth_execution_sessions
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
      scopeRow.auth_epoch !== grant.auth_epoch ||
      session.auth_epoch !== grant.auth_epoch
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

    // CAS: issued -> started
    const updated = (
      await client.query<{ id: string }>(
        `UPDATE auth_capture_grants
         SET status = 'started', started_at = clock_timestamp()
         WHERE id = $1 AND status = 'issued'
         RETURNING id`,
        [grantId],
      )
    ).rows[0];

    if (!updated) {
      throw new StorageError('VERSION_CONFLICT');
    }
  }

  async captureAuthState(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    ticket: string,
    stateInput: ApprovedAuthState,
  ): Promise<AuthStateRef> {
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );

    if (job.document.summary !== 'auth') {
      throw new StorageError('POLICY_DENIED');
    }

    // 1. Lock grant FOR UPDATE
    const grant = (
      await client.query<{
        id: string;
        ticket_hash: string;
        status: string;
        deadline: Date;
        auth_epoch: number;
      }>(
        `SELECT id, ticket_hash, status, deadline, auth_epoch
         FROM auth_capture_grants
         WHERE id = $1 AND project_id = $2 AND task_id = $3
           AND auth_session_id = $4
         FOR UPDATE`,
        [grantId, scope.projectId, job.id, sessionId],
      )
    ).rows[0];

    if (!grant) {
      throw new StorageError('NOT_FOUND');
    }

    const ticketHash = createHash('sha256').update(ticket).digest('hex');
    if (grant.ticket_hash !== ticketHash) {
      throw new StorageError('FORBIDDEN');
    }

    if (grant.status !== 'started' && grant.status !== 'consumed') {
      throw new StorageError('VALIDATION_ERROR');
    }

    if (new Date(grant.deadline) <= new Date()) {
      throw new StorageError('LEASE_EXPIRED');
    }

    // 2. Lock scope FOR UPDATE
    const scopeRow = (
      await client.query<{
        status: string;
        auth_epoch: number;
        auth_profile_id: string;
        auth_profile_version: number;
      }>(
        `SELECT status, auth_epoch, auth_profile_id, auth_profile_version
         FROM run_auth_scopes
         WHERE project_id = $1 AND run_id = $2
         FOR UPDATE`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    // 3. Lock session FOR UPDATE
    const session = (
      await client.query<{
        id: string;
        context_id: string;
        auth_profile_id: string;
        auth_profile_version: number;
        auth_epoch: number;
        status: string;
      }>(
        `SELECT id, context_id, auth_profile_id, auth_profile_version, auth_epoch, status
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
      scopeRow.auth_epoch !== grant.auth_epoch ||
      session.auth_epoch !== grant.auth_epoch
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    // 4. Lock profile FOR SHARE
    const profileRow = (
      await client.query<{
        id: string;
        revoked: boolean;
        document: unknown;
      }>(
        `SELECT p.id, p.revoked, v.document
         FROM auth_profiles p
         JOIN auth_profile_versions v
           ON v.project_id = p.project_id AND v.auth_profile_id = p.id
          AND v.version = $3
         WHERE p.project_id = $1 AND p.id = $2
         FOR SHARE OF p`,
        [
          scope.projectId,
          session.auth_profile_id,
          session.auth_profile_version,
        ],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false || !profileRow.document) {
      throw new StorageError('AUTH_FAILED');
    }

    const profile = parseContract('AuthProfile', profileRow.document);
    if (profile.mode === 'none') {
      throw new StorageError('POLICY_DENIED');
    }

    // 5. Post-lock clock re-checks
    await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, sessionId);

    // Validate approved auth state via AUTH-4A validator
    const validatedState = validateApprovedAuthState(
      stateInput,
      profile.allowedOrigins,
    );

    // Compute canonical keyed HMAC over validated state
    const canonicalPayloadHash = hashPayload(validatedState);
    const { hmac: stateHmac, keyVersion: hmacKeyVersion } =
      this.coordinator.vault.keyedHmac(
        canonicalPayloadHash,
        'auth_state_capture',
      );

    const originFingerprint = hashPayload(
      [...profile.allowedOrigins].map((u) => new URL(u).origin).sort(),
    );

    // 6. Check existing state for idempotency or conflict
    const existingState = (
      await client.query<{
        id: string;
        state_hmac: string;
        auth_epoch: number;
        captured_at: Date;
      }>(
        `SELECT id, state_hmac, auth_epoch, captured_at
         FROM run_auth_states
         WHERE project_id = $1 AND run_id = $2
         FOR UPDATE`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    if (existingState) {
      if (existingState.state_hmac === stateHmac) {
        return {
          authStateId: existingState.id,
          runId: run.id,
          authEpoch: existingState.auth_epoch,
          capturedAt: existingState.captured_at.toISOString(),
        };
      }
      // Different state HMAC (e.g. changed cookie value or localStorage) -> conflict
      throw new StorageError('IDEMPOTENCY_CONFLICT');
    }

    if (grant.status !== 'started') {
      throw new StorageError('VALIDATION_ERROR');
    }

    // 7. Atomic state encryption & commit
    const stateId = randomUUID();
    const envelope = {
      projectId: scope.projectId,
      runId: run.id,
      contextVersion: proof.contextVersion,
      profileId: profile.id,
      profileVersion: profile.version,
      authEpoch: session.auth_epoch,
      capturingSessionId: sessionId,
      capturingTaskId: proof.taskId,
      capturingWorkerId: scope.workerId,
      capturingFencingToken: proof.fencingToken,
      state: validatedState,
    };

    const cipher = this.coordinator.vault.encrypt(JSON.stringify(envelope), {
      projectId: scope.projectId,
      secretId: stateId,
      purpose: 'run_auth_state',
    });

    const insertedState = (
      await client.query<{ captured_at: Date }>(
        `INSERT INTO run_auth_states(
           id, project_id, run_id, auth_profile_id, auth_profile_version, context_version,
           capturing_session_id, capturing_task_id, capturing_worker_id, capturing_fencing_token,
           auth_epoch, status, ciphertext, nonce, auth_tag, key_version,
           state_hmac, hmac_key_version, origin_fingerprint
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10,
           $11, 'granted', $12, $13, $14, $15,
           $16, $17, $18
         ) RETURNING captured_at`,
        [
          stateId,
          scope.projectId,
          run.id,
          profile.id,
          profile.version,
          proof.contextVersion,
          sessionId,
          proof.taskId,
          scope.workerId,
          proof.fencingToken,
          session.auth_epoch,
          cipher.ciphertext,
          cipher.nonce,
          cipher.authTag,
          cipher.keyVersion,
          stateHmac,
          hmacKeyVersion,
          originFingerprint,
        ],
      )
    ).rows[0]!;

    // Consume capture grant
    await client.query(
      `UPDATE auth_capture_grants
       SET status = 'consumed', consumed_at = clock_timestamp()
       WHERE id = $1`,
      [grantId],
    );

    // Update run_auth_scopes to granted with current_state_id
    await client.query(
      `UPDATE run_auth_scopes
       SET status = 'granted', current_state_id = $1, updated_at = clock_timestamp()
       WHERE project_id = $2 AND run_id = $3`,
      [stateId, scope.projectId, run.id],
    );

    // Promote exclusive profile run lock if held in initializing phase
    await client.query(
      `UPDATE auth_profile_run_locks
       SET phase = 'granted'
       WHERE project_id = $1 AND run_id = $2 AND phase = 'initializing' AND status = 'held'`,
      [scope.projectId, run.id],
    );

    return {
      authStateId: stateId,
      runId: run.id,
      authEpoch: session.auth_epoch,
      capturedAt: insertedState.captured_at.toISOString(),
    };
  }
}
