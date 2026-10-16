import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseContract } from '@localqa/contracts';
import {
  StorageError,
  reconcileExpiredOtpInputs,
  type WorkerScope,
  type LeaseProof,
} from '@localqa/storage';
import type { Coordinator, JobRow } from './core.js';
import type { Run } from '@localqa/contracts';

/**
 * Which tasks may run the private sign-in flow: the run-level auth job, or
 * (Mo-style) an executor/reproducer of a session-managed smoke run signing in
 * inside its own browser. `self` sign-ins never capture or import state.
 */
export async function signInKind(
  coordinator: Pick<Coordinator, 'sessions'>,
  client: PoolClient,
  job: Pick<JobRow, 'role' | 'document'>,
  run: Run,
): Promise<'auth' | 'self' | null> {
  const stage = job.document.summary;
  if (stage === 'auth') return 'auth';
  if (
    run.executionMode === 'smoke' &&
    ((job.role === 'executor' && stage === 'execute') ||
      (job.role === 'reproducer' && stage === 'reproduce')) &&
    (await coordinator.sessions.read(client, run)) !== null
  )
    return 'self';
  return null;
}

export type AuthSessionPurpose = 'initializer' | 'importer';
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
  purpose: AuthSessionPurpose;
  status: AuthSessionStatus;
  expiresAt: string;
}

interface RawSessionRow {
  id: string;
  project_id: string;
  run_id: string;
  task_id: string;
  worker_id: string;
  fencing_token: string;
  context_version: number;
  context_id: string;
  auth_profile_id: string;
  auth_profile_version: number;
  auth_epoch: number;
  purpose: AuthSessionPurpose;
  status: AuthSessionStatus;
  activation_ticket_hash: string | null;
  activation_ticket_issued_at: Date | null;
  activated_at: Date | null;
  ended_at: Date | null;
  end_reason: string | null;
  expires_at: Date;
  created_at: Date;
}

function toBinding(row: RawSessionRow): AuthSessionBinding {
  return {
    sessionId: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    taskId: row.task_id,
    workerId: row.worker_id,
    fencingToken: Number(row.fencing_token),
    contextVersion: row.context_version,
    contextId: row.context_id,
    profileId: row.auth_profile_id,
    profileVersion: row.auth_profile_version,
    authEpoch: row.auth_epoch,
    purpose: row.purpose,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
  };
}

function verifySessionCaller(
  row: RawSessionRow,
  scope: WorkerScope,
  proof: LeaseProof,
): void {
  if (
    row.project_id !== scope.projectId ||
    row.task_id !== proof.taskId ||
    row.worker_id !== scope.workerId ||
    row.fencing_token !== String(proof.fencingToken) ||
    row.context_version !== proof.contextVersion
  ) {
    throw new StorageError('LEASE_EXPIRED');
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

export class AuthExecutionManager {
  constructor(private readonly coordinator: Coordinator) {}

  /**
   * A renewed Worker lease is necessary but not sufficient for a private
   * browser session. Extend only a *still-live* active session owned by that
   * exact Worker/fence/context, and never past five minutes from activation.
   * This runs in the Coordinator heartbeat's already-locked job/run
   * transaction, after the actual task lease has been renewed.
   */
  async renewForHeartbeat(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
  ): Promise<void> {
    const scopeRow = (
      await client.query<{ status: string; auth_epoch: number }>(
        'SELECT status,auth_epoch FROM run_auth_scopes WHERE project_id=$1 AND run_id=(SELECT run_id FROM jobs WHERE id=$2) FOR SHARE',
        [scope.projectId, proof.taskId],
      )
    ).rows[0];
    const session = (
      await client.query<RawSessionRow>(
        `SELECT * FROM auth_execution_sessions
         WHERE project_id=$1 AND task_id=$2 AND worker_id=$3
           AND fencing_token=$4 AND context_version=$5 AND status='active'
         FOR UPDATE`,
        [
          scope.projectId,
          proof.taskId,
          scope.workerId,
          proof.fencingToken,
          proof.contextVersion,
        ],
      )
    ).rows[0];
    if (!session) return;
    if (
      !scopeRow ||
      scopeRow.status === 'revoked' ||
      scopeRow.auth_epoch !== session.auth_epoch ||
      !session.activated_at
    )
      throw new StorageError('AUTH_FAILED');
    const profile = (
      await client.query<{ revoked: boolean }>(
        'SELECT revoked FROM auth_profiles WHERE project_id=$1 AND id=$2 FOR SHARE',
        [scope.projectId, session.auth_profile_id],
      )
    ).rows[0];
    if (!profile || profile.revoked) throw new StorageError('AUTH_FAILED');
    const currentLeaseUntil = await verifyLeaseNotExpired(client, proof);
    const now = Date.now();
    const hardDeadline = session.activated_at.getTime() + 5 * 60 * 1000;
    if (session.expires_at.getTime() <= now || hardDeadline <= now)
      throw new StorageError('LEASE_EXPIRED');
    const newExpiry = new Date(
      Math.min(currentLeaseUntil.getTime(), hardDeadline),
    );
    if (newExpiry.getTime() > session.expires_at.getTime())
      await client.query(
        `UPDATE auth_execution_sessions SET expires_at=$2
         WHERE id=$1 AND status='active' AND expires_at>clock_timestamp()`,
        [session.id, newExpiry],
      );
  }

  private async validateImporterCaller(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<void> {
    const row = (
      await client.query<{ purpose: string }>(
        'SELECT purpose FROM auth_execution_sessions WHERE id=$1 AND project_id=$2',
        [sessionId, scope.projectId],
      )
    ).rows[0];
    if (row?.purpose === 'importer')
      await this.coordinator.authImportService.validateSession(
        client,
        scope,
        proof,
        sessionId,
      );
  }

  allocateAuthImporterSession(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    authStateId: string,
  ): Promise<AuthSessionBinding> {
    return this.coordinator.authImportService.allocate(
      client,
      scope,
      proof,
      authStateId,
    );
  }

  async allocateAuthSession(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
  ): Promise<AuthSessionBinding> {
    // 1. Lock job/lease, then run
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );

    // Initializer permits the run's auth job, and (Mo-style) a session
    // executor/reproducer signing in inside its own browser.
    const kind = await signInKind(this.coordinator, client, job, run);
    if (!kind) {
      throw new StorageError('POLICY_DENIED');
    }

    // 2. Read frozen profile metadata from run without taking lock yet
    const runProfileRow = (
      await client.query<{
        auth_profile_id: string | null;
        auth_profile_version: number | null;
        environment_id: string | null;
        document: unknown;
      }>(
        `SELECT r.auth_profile_id, r.auth_profile_version, r.environment_id, v.document
         FROM runs r
         JOIN auth_profile_versions v
           ON v.project_id = r.project_id
          AND v.auth_profile_id = r.auth_profile_id
          AND v.version = r.auth_profile_version
         WHERE r.project_id = $1 AND r.id = $2`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    if (
      !runProfileRow ||
      !runProfileRow.auth_profile_id ||
      !runProfileRow.auth_profile_version ||
      !runProfileRow.document
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    const profileDoc = parseContract('AuthProfile', runProfileRow.document);
    // Anonymous mode=none policy produces zero rows and zero decryption
    if (profileDoc.mode === 'none') {
      throw new StorageError('POLICY_DENIED');
    }

    const approvedOrigins = new Set(
      profileDoc.allowedOrigins.map((origin) => new URL(origin).origin),
    );
    if (
      run.effectiveConfig.allowedOrigins.some(
        (origin) => !approvedOrigins.has(new URL(origin).origin),
      )
    ) {
      throw new StorageError('TARGET_NOT_ALLOWED');
    }

    // 3. Lock scope FOR UPDATE
    let scopeRow = (
      await client.query<{
        auth_epoch: number;
        status: string;
        context_version: number;
        auth_profile_id: string;
        auth_profile_version: number;
      }>(
        `SELECT auth_epoch, status, context_version, auth_profile_id, auth_profile_version
         FROM run_auth_scopes
         WHERE project_id = $1 AND run_id = $2
         FOR UPDATE`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    // 4. Lock session FOR UPDATE
    const existing = (
      await client.query<RawSessionRow>(
        `SELECT * FROM auth_execution_sessions
         WHERE task_id = $1 AND fencing_token = $2
         FOR UPDATE`,
        [proof.taskId, proof.fencingToken],
      )
    ).rows[0];

    // 5. Lock profile FOR SHARE (the final lock in the order: job/lease -> run -> scope -> session -> profile)
    const profileRow = (
      await client.query<{ id: string; revoked: boolean }>(
        `SELECT p.id, p.revoked
         FROM auth_profiles p
         WHERE p.project_id = $1 AND p.id = $2
         FOR SHARE OF p`,
        [scope.projectId, profileDoc.id],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false) {
      throw new StorageError('AUTH_FAILED');
    }

    // 6. Post-lock re-check: verify lease has NOT expired while waiting on FOR SHARE lock
    const currentLeaseUntil = await verifyLeaseNotExpired(client, proof);

    // Validate scope row if already existed
    if (!scopeRow) {
      scopeRow = (
        await client.query<{
          auth_epoch: number;
          status: string;
          context_version: number;
          auth_profile_id: string;
          auth_profile_version: number;
        }>(
          `INSERT INTO run_auth_scopes(
             project_id, run_id, auth_profile_id, auth_profile_version,
             context_version, auth_epoch, status
           ) VALUES ($1, $2, $3, $4, $5, 1, 'initializing')
           RETURNING auth_epoch, status, context_version, auth_profile_id, auth_profile_version`,
          [
            scope.projectId,
            run.id,
            profileDoc.id,
            profileDoc.version,
            proof.contextVersion,
          ],
        )
      ).rows[0]!;
    } else {
      if (scopeRow.status === 'revoked') {
        throw new StorageError('AUTH_FAILED');
      }
      if (scopeRow.context_version !== proof.contextVersion) {
        throw new StorageError('SCOPE_CHANGED');
      }
      if (
        scopeRow.auth_profile_id !== profileDoc.id ||
        scopeRow.auth_profile_version !== profileDoc.version
      ) {
        throw new StorageError('AUTH_FAILED');
      }
    }

    if (existing) {
      if (existing.auth_epoch !== scopeRow.auth_epoch) {
        throw new StorageError('AUTH_FAILED');
      }
      if (new Date(existing.expires_at) <= new Date()) {
        throw new StorageError('LEASE_EXPIRED');
      }
      if (existing.status === 'allocated') {
        return toBinding(existing);
      }
      throw new StorageError('VERSION_CONFLICT');
    }

    const sessionId = randomUUID();
    // A self sign-in happens in the task's own, already opened browser: bind
    // the server session to that exact context, never invent another one.
    const taskContext = job.result?.['authContextId'];
    if (
      kind === 'self' &&
      (typeof taskContext !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(taskContext))
    )
      throw new StorageError('VALIDATION_ERROR');
    const contextId = kind === 'self' ? (taskContext as string) : randomUUID();

    const inserted = (
      await client.query<RawSessionRow>(
        `INSERT INTO auth_execution_sessions(
           id, project_id, run_id, task_id, worker_id, fencing_token, context_version,
           context_id, auth_profile_id, auth_profile_version, auth_epoch, purpose, status,
           activation_ticket_hash, activation_ticket_issued_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, 'initializer', 'allocated',
           NULL, NULL, $12
         ) RETURNING *`,
        [
          sessionId,
          scope.projectId,
          run.id,
          proof.taskId,
          scope.workerId,
          proof.fencingToken,
          proof.contextVersion,
          contextId,
          profileDoc.id,
          profileDoc.version,
          scopeRow.auth_epoch,
          currentLeaseUntil,
        ],
      )
    ).rows[0]!;

    if (kind === 'self' && profileDoc.sharingPolicy === 'exclusive_run')
      await this.holdCredential(client, scope, run.id, inserted);

    return toBinding(inserted);
  }

  /**
   * An exclusive account is signed in by one task at a time. A self sign-in
   * takes the existing run lock for its own session and keeps it until its
   * task ends; it never queues. A lock left by a task that no longer runs is
   * stale and reclaimed. Busy means RATE_LIMITED: that case is blocked.
   */
  private async holdCredential(
    client: PoolClient,
    scope: WorkerScope,
    runId: string,
    session: RawSessionRow,
  ): Promise<void> {
    const held = (
      await client.query<{
        id: string;
        run_id: string;
        holder_running: boolean;
      }>(
        `SELECT l.id,l.run_id,
           (j.status='running' AND j.fencing_token=s.fencing_token
             AND j.document->>'summary'<>'auth') AS holder_running
         FROM auth_profile_run_locks l
         JOIN auth_execution_sessions s ON s.id=l.auth_session_id
         JOIN jobs j ON j.id=s.task_id
         WHERE l.project_id=$1 AND l.auth_profile_id=$2 AND l.status='held'
         FOR UPDATE OF l`,
        [scope.projectId, session.auth_profile_id],
      )
    ).rows[0];
    if (held) {
      // Another run's lock (or its run-level auth state) stays untouched.
      if (held.run_id !== runId || held.holder_running)
        throw new StorageError('RATE_LIMITED');
      await client.query(
        "UPDATE auth_profile_run_locks SET status='released',released_at=clock_timestamp(),release_reason='holder_ended' WHERE id=$1",
        [held.id],
      );
    }
    await client.query(
      `INSERT INTO auth_profile_run_locks(
         id,project_id,auth_profile_id,run_id,auth_session_id,auth_epoch,status,phase,held_at
       ) VALUES($1,$2,$3,$4,$5,$6,'held','initializing',clock_timestamp())
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        scope.projectId,
        session.auth_profile_id,
        runId,
        session.id,
        session.auth_epoch,
      ],
    );
    const acquired = (
      await client.query<{ auth_session_id: string }>(
        "SELECT auth_session_id FROM auth_profile_run_locks WHERE project_id=$1 AND auth_profile_id=$2 AND status='held'",
        [scope.projectId, session.auth_profile_id],
      )
    ).rows[0];
    if (acquired?.auth_session_id !== session.id)
      throw new StorageError('RATE_LIMITED');
  }

  async issueAuthActivationTicket(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<{ activationTicket: string }> {
    // 1. Lock job/lease, then run
    const { run } = await this.coordinator.validateLease(client, scope, proof);
    await this.validateImporterCaller(client, scope, proof, sessionId);

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
    const row = (
      await client.query<RawSessionRow>(
        `SELECT * FROM auth_execution_sessions
         WHERE project_id = $1 AND id = $2
         FOR UPDATE`,
        [scope.projectId, sessionId],
      )
    ).rows[0];

    if (!row) throw new StorageError('NOT_FOUND');
    verifySessionCaller(row, scope, proof);

    if (
      !scopeRow ||
      scopeRow.status === 'revoked' ||
      scopeRow.auth_epoch !== row.auth_epoch
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    if (row.status !== 'allocated') {
      throw new StorageError('VERSION_CONFLICT');
    }

    // 4. Lock profile FOR SHARE
    const profileRow = (
      await client.query<{ id: string; revoked: boolean }>(
        `SELECT p.id, p.revoked
         FROM auth_profiles p
         WHERE p.project_id = $1 AND p.id = $2
         FOR SHARE OF p`,
        [scope.projectId, row.auth_profile_id],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false) {
      throw new StorageError('AUTH_FAILED');
    }

    // 5. Post-lock clock re-checks
    await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, sessionId);

    const ticket = randomBytes(32).toString('hex');
    const ticketHash = createHash('sha256').update(ticket).digest('hex');

    await client.query(
      `UPDATE auth_execution_sessions
       SET activation_ticket_hash = $1, activation_ticket_issued_at = clock_timestamp()
       WHERE id = $2`,
      [ticketHash, sessionId],
    );

    await this.validateImporterCaller(client, scope, proof, sessionId);
    return { activationTicket: ticket };
  }

  async activateAuthSession(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    ticket: string,
  ): Promise<AuthSessionBinding> {
    // 1. Lock job/lease, then run
    const { run } = await this.coordinator.validateLease(client, scope, proof);
    await this.validateImporterCaller(client, scope, proof, sessionId);

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
    const row = (
      await client.query<RawSessionRow>(
        `SELECT * FROM auth_execution_sessions
         WHERE project_id = $1 AND id = $2
         FOR UPDATE`,
        [scope.projectId, sessionId],
      )
    ).rows[0];

    if (!row) throw new StorageError('NOT_FOUND');
    verifySessionCaller(row, scope, proof);

    if (
      !scopeRow ||
      scopeRow.status === 'revoked' ||
      scopeRow.auth_epoch !== row.auth_epoch
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    if (row.status !== 'allocated') {
      throw new StorageError('VERSION_CONFLICT');
    }

    // 4. Lock profile FOR SHARE
    const profileRow = (
      await client.query<{ id: string; revoked: boolean }>(
        `SELECT p.id, p.revoked
         FROM auth_profiles p
         WHERE p.project_id = $1 AND p.id = $2
         FOR SHARE OF p`,
        [scope.projectId, row.auth_profile_id],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false) {
      throw new StorageError('AUTH_FAILED');
    }

    // 5. Post-lock clock re-checks
    await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, sessionId);

    const ticketHash = createHash('sha256').update(ticket).digest('hex');
    if (
      !row.activation_ticket_hash ||
      row.activation_ticket_hash !== ticketHash
    ) {
      throw new StorageError('FORBIDDEN');
    }

    const updated = (
      await client.query<RawSessionRow>(
        `UPDATE auth_execution_sessions
         SET status = 'active', activated_at = clock_timestamp(), activation_ticket_hash = NULL
         WHERE id = $1 AND status = 'allocated'
         RETURNING *`,
        [sessionId],
      )
    ).rows[0]!;

    await this.validateImporterCaller(client, scope, proof, sessionId);
    return toBinding(updated);
  }

  async authSession(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<AuthSessionBinding> {
    // 1. Lock job/lease, then run
    const { run } = await this.coordinator.validateLease(client, scope, proof);
    await this.validateImporterCaller(client, scope, proof, sessionId);

    // 2. Lock scope FOR SHARE
    const scopeRow = (
      await client.query<{ status: string; auth_epoch: number }>(
        `SELECT status, auth_epoch FROM run_auth_scopes
         WHERE project_id = $1 AND run_id = $2
         FOR SHARE`,
        [scope.projectId, run.id],
      )
    ).rows[0];

    // 3. Query session
    const row = (
      await client.query<RawSessionRow>(
        `SELECT * FROM auth_execution_sessions
         WHERE project_id = $1 AND id = $2`,
        [scope.projectId, sessionId],
      )
    ).rows[0];

    if (!row) throw new StorageError('NOT_FOUND');
    verifySessionCaller(row, scope, proof);

    if (
      !scopeRow ||
      scopeRow.status === 'revoked' ||
      scopeRow.auth_epoch !== row.auth_epoch
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    // 4. Lock profile FOR SHARE
    const profileRow = (
      await client.query<{ id: string; revoked: boolean }>(
        `SELECT p.id, p.revoked
         FROM auth_profiles p
         WHERE p.project_id = $1 AND p.id = $2
         FOR SHARE OF p`,
        [scope.projectId, row.auth_profile_id],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false) {
      throw new StorageError('AUTH_FAILED');
    }

    // 5. Post-lock clock re-checks: verify both lease AND session have not expired
    await verifyLeaseNotExpired(client, proof);
    await verifySessionNotExpired(client, sessionId);

    return toBinding(row);
  }

  async endAuthSession(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    reason = 'completed',
  ): Promise<AuthSessionBinding> {
    // 1. Lock job/lease, then run
    const { job, run } = await this.coordinator.validateLease(
      client,
      scope,
      proof,
    );
    await this.validateImporterCaller(client, scope, proof, sessionId);

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
    const row = (
      await client.query<RawSessionRow>(
        `SELECT * FROM auth_execution_sessions
         WHERE project_id = $1 AND id = $2
         FOR UPDATE`,
        [scope.projectId, sessionId],
      )
    ).rows[0];

    if (!row) throw new StorageError('NOT_FOUND');
    verifySessionCaller(row, scope, proof);

    if (
      !scopeRow ||
      scopeRow.status === 'revoked' ||
      scopeRow.auth_epoch !== row.auth_epoch
    ) {
      throw new StorageError('AUTH_FAILED');
    }

    // 4. Lock profile FOR SHARE
    const profileRow = (
      await client.query<{ id: string; revoked: boolean }>(
        `SELECT p.id, p.revoked
         FROM auth_profiles p
         WHERE p.project_id = $1 AND p.id = $2
         FOR SHARE OF p`,
        [scope.projectId, row.auth_profile_id],
      )
    ).rows[0];

    if (!profileRow || profileRow.revoked !== false) {
      throw new StorageError('AUTH_FAILED');
    }

    if (row.status === 'ended' || row.status === 'revoked') {
      return toBinding(row);
    }

    // 5. Post-lock clock re-check
    await verifyLeaseNotExpired(client, proof);

    if (row.purpose === 'importer') {
      await this.coordinator.authImportService.endAttempt(
        client,
        scope,
        proof,
        sessionId,
      );
    }
    if (row.purpose === 'initializer') {
      await client.query(
        `UPDATE auth_otp_challenges SET status='expired',
          ciphertext=NULL,nonce=NULL,auth_tag=NULL,key_version=NULL
         WHERE auth_session_id=$1 AND status IN ('pending','submitted')`,
        [sessionId],
      );
      await reconcileExpiredOtpInputs(
        client,
        scope.projectId,
        run.id,
        row.task_id,
      );
    }
    if (
      row.purpose === 'initializer' &&
      (await signInKind(this.coordinator, client, job, run)) === 'self'
    )
      reason = await this.endSelfSignIn(client, scope, proof, row, reason);
    else if (reason === 'signed_in') throw new StorageError('POLICY_DENIED');
    const updated = (
      await client.query<RawSessionRow>(
        `UPDATE auth_execution_sessions
         SET status = 'ended', ended_at = clock_timestamp(), end_reason = $2
         WHERE id = $1
         RETURNING *`,
        [sessionId, reason],
      )
    ).rows[0]!;

    if (row.purpose === 'importer') {
      await verifyLeaseNotExpired(client, proof);
      await verifySessionNotExpired(client, sessionId);
    }
    return toBinding(updated);
  }

  /**
   * A self sign-in leaves no private authority behind. `signed_in` is the
   * only success ending and needs this session's server-verified success
   * gate; the exclusive lock then stays with the task until it ends. Any
   * other ending releases the lock. Unsettled private intents are charged as
   * unknown, never replayed, so the task can still report its result.
   */
  private async endSelfSignIn(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    row: RawSessionRow,
    reason: string,
  ): Promise<string> {
    const open = (
      await client.query<{ id: string; reservation_id: string }>(
        "SELECT id,reservation_id FROM action_intents WHERE project_id=$1 AND auth_session_id=$2 AND outcome='pending' FOR UPDATE",
        [scope.projectId, row.id],
      )
    ).rows;
    for (const intent of open) {
      await this.coordinator.settleIn(
        client,
        scope,
        proof,
        intent.reservation_id,
        { actions: 1 },
        'unknown',
      );
      await client.query(
        "UPDATE action_intents SET outcome='unknown',execution_state='completed' WHERE id=$1",
        [intent.id],
      );
      await client.query(
        `UPDATE steps SET document=document||'{"status":"unknown","summary":"Auth unknown"}'::jsonb
         WHERE action_id=$1`,
        [intent.id],
      );
    }
    const signedIn =
      reason === 'signed_in' &&
      open.length === 0 &&
      Boolean(
        (
          await client.query(
            "SELECT 1 FROM auth_success_gates WHERE project_id=$1 AND auth_session_id=$2 AND result='passed' LIMIT 1",
            [scope.projectId, row.id],
          )
        ).rowCount,
      );
    if (reason === 'signed_in' && !signedIn)
      throw new StorageError('POLICY_DENIED');
    await client.query(
      signedIn
        ? "UPDATE auth_profile_run_locks SET phase='granted' WHERE project_id=$1 AND auth_session_id=$2 AND status='held'"
        : "UPDATE auth_profile_run_locks SET status='released',released_at=clock_timestamp(),release_reason='sign_in_ended' WHERE project_id=$1 AND auth_session_id=$2 AND status='held'",
      [scope.projectId, row.id],
    );
    return reason;
  }

  /** A task's self sign-in authority ends with the task: session and lock. */
  async endTaskSignIn(
    client: PoolClient,
    projectId: string,
    taskId: string,
    reason: string,
  ): Promise<void> {
    await client.query(
      "UPDATE auth_execution_sessions SET status='ended',ended_at=clock_timestamp(),end_reason=$3 WHERE project_id=$1 AND task_id=$2 AND purpose='initializer' AND status IN ('allocated','active')",
      [projectId, taskId, reason],
    );
    await client.query(
      `UPDATE auth_profile_run_locks l SET status='released',released_at=clock_timestamp(),release_reason=$3
       FROM auth_execution_sessions s
       WHERE s.id=l.auth_session_id AND l.project_id=$1 AND s.task_id=$2 AND l.status='held'`,
      [projectId, taskId, reason],
    );
  }
}
