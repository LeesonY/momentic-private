import { randomUUID } from 'node:crypto';
import { parseContract, type InputRequest } from '@localqa/contracts';
import {
  StorageError,
  authorize,
  appendEvent,
  audit,
  type Actor,
  type LeaseProof,
  type WorkerScope,
} from '@localqa/storage';
import type { Coordinator } from './core.js';

type Status = 'pending' | 'submitted' | 'consumed' | 'rejected' | 'expired';
type Challenge = {
  input_id: string;
  project_id: string;
  run_id: string;
  task_id: string;
  auth_session_id: string;
  fencing_token: string;
  context_version: number;
  auth_epoch: number;
  status: Status;
  expires_at: Date;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  auth_tag: Buffer | null;
  key_version: number | null;
};

/** The OTP is never serialized into InputRequest, any event or an HTTP result. */
export class AuthOtpService {
  constructor(private readonly coordinator: Coordinator) {}

  async issue(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    ttlMs = 180000,
  ): Promise<InputRequest> {
    return this.coordinator.tx(async (client) => {
      const { job, run } = await this.coordinator.validateLease(
        client,
        scope,
        proof,
      );
      if (job.document.summary !== 'auth' || ttlMs < 1000 || ttlMs > 180000)
        throw new StorageError('POLICY_DENIED');
      const authority = (
        await client.query<{
          status: string;
          expires_at: Date;
          activated_at: Date | null;
          fencing_token: string;
          context_version: number;
          auth_epoch: number;
          purpose: string;
          worker_id: string;
          task_id: string;
          revoked: boolean;
          scope_status: string;
          scope_epoch: number;
          frozen_profile: unknown;
        }>(
          `SELECT s.status,s.expires_at,s.activated_at,s.fencing_token,s.context_version,
          s.auth_epoch,s.purpose,s.worker_id,s.task_id,p.revoked,
          a.status AS scope_status,a.auth_epoch AS scope_epoch,v.document AS frozen_profile
          FROM auth_execution_sessions s
          JOIN run_auth_scopes a ON a.project_id=s.project_id AND a.run_id=s.run_id
          JOIN auth_profiles p ON p.project_id=s.project_id AND p.id=s.auth_profile_id
          JOIN auth_profile_versions v ON v.project_id=s.project_id
            AND v.auth_profile_id=s.auth_profile_id AND v.version=s.auth_profile_version
          WHERE s.project_id=$1 AND s.id=$2 AND s.run_id=$3
          FOR UPDATE OF s FOR SHARE OF p`,
          [scope.projectId, sessionId, run.id],
        )
      ).rows[0];
      const frozen = authority
        ? parseContract('AuthProfile', authority.frozen_profile)
        : null;
      if (
        !authority ||
        authority.status !== 'active' ||
        authority.purpose !== 'initializer' ||
        authority.revoked ||
        authority.scope_status !== 'initializing' ||
        authority.scope_epoch !== authority.auth_epoch ||
        authority.worker_id !== scope.workerId ||
        authority.task_id !== proof.taskId ||
        authority.fencing_token !== String(proof.fencingToken) ||
        authority.context_version !== proof.contextVersion ||
        authority.expires_at.getTime() <= Date.now() + 2000 ||
        !authority.activated_at ||
        authority.activated_at.getTime() + 5 * 60 * 1000 <=
          Date.now() + ttlMs + 20000 ||
        frozen?.mode !== 'form' ||
        (!frozen.formConfig?.otpTarget &&
          frozen.formConfig?.detectionMode !== 'ai')
      )
        throw new StorageError('AUTH_FAILED');
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      const input = parseContract('InputRequest', {
        id: randomUUID(),
        runId: run.id,
        kind: 'one_time_code',
        status: 'pending',
        prompt:
          'Enter the one-time code for this approved authentication session.',
        expiresAt,
        version: 1,
      });
      await client.query(
        'INSERT INTO input_requests(id,project_id,run_id,version,document) VALUES($1,$2,$3,1,$4)',
        [input.id, scope.projectId, run.id, input],
      );
      await client.query(
        `INSERT INTO auth_otp_challenges
          (input_id,project_id,run_id,task_id,auth_session_id,
           fencing_token,context_version,auth_epoch,status,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
        [
          input.id,
          scope.projectId,
          run.id,
          proof.taskId,
          sessionId,
          proof.fencingToken,
          proof.contextVersion,
          authority.auth_epoch,
          expiresAt,
        ],
      );
      await appendEvent(
        client,
        scope.projectId,
        run.id,
        'input.requested',
        input,
      );
      return input;
    });
  }

  async submit(
    actor: Actor,
    projectId: string,
    runId: string,
    inputId: string,
    expectedVersion: number,
    decision: 'provide' | 'reject',
    oneTimeCode?: string,
  ): Promise<InputRequest> {
    if (
      (decision === 'provide' &&
        (typeof oneTimeCode !== 'string' ||
          !/^[A-Za-z0-9]{4,32}$/.test(oneTimeCode))) ||
      (decision === 'reject' && oneTimeCode !== undefined)
    )
      throw new StorageError('VALIDATION_ERROR');
    // Normal project RBAC is checked with the real submitting user, but the
    // ciphertext ledger remains admin-RLS-only; never grant project roles
    // SELECT on the private OTP table.
    await this.coordinator.db.actor(actor, async (client) => {
      await authorize(client, projectId, 'run');
    });
    return this.coordinator.tx(async (client) => {
      // The initial project RBAC check ran as the real HTTP actor. Recheck
      // while holding row locks in the private write transaction so a role
      // revocation cannot race between public authorization and OTP delivery.
      const principal = (
        await client.query<{ global_role: string; disabled: boolean }>(
          'SELECT global_role,disabled FROM users WHERE id=$1 FOR SHARE',
          [actor.userId],
        )
      ).rows[0];
      const membership = (
        await client.query<{ role: string }>(
          'SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE',
          [projectId, actor.userId],
        )
      ).rows[0];
      if (
        !principal ||
        principal.disabled ||
        (principal.global_role !== 'admin' &&
          !['owner', 'operator'].includes(membership?.role ?? ''))
      )
        throw new StorageError('FORBIDDEN');
      const candidate = (
        await client.query<Challenge>(
          'SELECT * FROM auth_otp_challenges WHERE project_id=$1 AND run_id=$2 AND input_id=$3',
          [projectId, runId, inputId],
        )
      ).rows[0];
      if (!candidate) throw new StorageError('NOT_FOUND');
      // Match the Worker action lock order (job -> run -> private row).
      const job = (
        await client.query<{ status: string; lease_until: Date }>(
          'SELECT status,lease_until FROM jobs WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, candidate.task_id],
        )
      ).rows[0];
      const run = (
        await client.query<{ status: string; context_version: number }>(
          'SELECT status,context_version FROM runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, runId],
        )
      ).rows[0];
      const inputRow = (
        await client.query<{ document: unknown }>(
          'SELECT document FROM input_requests WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, inputId],
        )
      ).rows[0];
      const challenge = (
        await client.query<Challenge>(
          'SELECT * FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2 FOR UPDATE',
          [projectId, inputId],
        )
      ).rows[0];
      const session = (
        await client.query<{
          status: string;
          auth_epoch: number;
          expires_at: Date;
        }>(
          'SELECT status,auth_epoch,expires_at FROM auth_execution_sessions WHERE project_id=$1 AND id=$2',
          [projectId, candidate.auth_session_id],
        )
      ).rows[0];
      const liveLease = (
        await client.query(
          `SELECT 1 FROM task_leases WHERE project_id=$1 AND task_id=$2
           AND fencing_token=$3 AND released_at IS NULL
           AND lease_until>clock_timestamp()`,
          [projectId, candidate.task_id, candidate.fencing_token],
        )
      ).rowCount;
      const authority = (
        await client.query<{
          status: string;
          auth_epoch: number;
          revoked: boolean;
        }>(
          `SELECT a.status,a.auth_epoch,p.revoked FROM run_auth_scopes a
         JOIN auth_profiles p ON p.project_id=a.project_id AND p.id=a.auth_profile_id
         WHERE a.project_id=$1 AND a.run_id=$2 FOR SHARE OF p`,
          [projectId, runId],
        )
      ).rows[0];
      const current = parseContract('InputRequest', inputRow?.document);
      if (
        current.kind !== 'one_time_code' ||
        current.version !== expectedVersion ||
        current.status !== 'pending' ||
        !challenge ||
        challenge.status !== 'pending' ||
        current.runId !== runId ||
        Date.parse(current.expiresAt) <= Date.now() ||
        challenge.expires_at.getTime() <= Date.now() ||
        job?.status !== 'running' ||
        job.lease_until <= new Date() ||
        !liveLease ||
        run?.status !== 'running' ||
        run.context_version !== challenge.context_version ||
        session?.status !== 'active' ||
        session.auth_epoch !== challenge.auth_epoch ||
        session.expires_at <= new Date() ||
        authority?.status !== 'initializing' ||
        authority.auth_epoch !== challenge.auth_epoch ||
        authority.revoked
      )
        throw new StorageError('VERSION_CONFLICT');
      const updated = parseContract('InputRequest', {
        ...current,
        status: decision === 'provide' ? 'resolved' : 'rejected',
        version: current.version + 1,
      });
      if (decision === 'provide') {
        const envelope = this.coordinator.vault.encrypt(oneTimeCode!, {
          projectId,
          secretId: inputId,
          purpose: 'auth_otp',
        });
        await client.query(
          `UPDATE auth_otp_challenges SET status='submitted',
             ciphertext=$2,nonce=$3,auth_tag=$4,key_version=$5
             WHERE input_id=$1`,
          [
            inputId,
            envelope.ciphertext,
            envelope.nonce,
            envelope.authTag,
            envelope.keyVersion,
          ],
        );
      } else {
        await client.query(
          "UPDATE auth_otp_challenges SET status='rejected' WHERE input_id=$1",
          [inputId],
        );
      }
      await client.query(
        'UPDATE input_requests SET document=$2,version=version+1,actor_id=$3 WHERE id=$1',
        [inputId, updated, actor.userId],
      );
      await appendEvent(client, projectId, runId, 'input.resolved', updated);
      await audit(
        client,
        'input.acknowledged',
        inputId,
        projectId,
        updated.version,
      );
      return updated;
    });
  }

  async consume(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    inputId: string,
  ): Promise<{
    status: 'pending' | 'ready' | 'rejected' | 'expired';
    code?: string;
  }> {
    return this.coordinator.tx(async (client) => {
      const { job, run } = await this.coordinator.validateLease(
        client,
        scope,
        proof,
      );
      if (job.document.summary !== 'auth')
        throw new StorageError('POLICY_DENIED');
      const session = (
        await client.query<{
          status: string;
          auth_epoch: number;
          fencing_token: string;
          expires_at: Date;
        }>(
          'SELECT status,auth_epoch,fencing_token,expires_at FROM auth_execution_sessions WHERE project_id=$1 AND id=$2',
          [scope.projectId, sessionId],
        )
      ).rows[0];
      // The input row is locked before the challenge in both the submit and
      // expiry paths, avoiding a wait-cycle with simultaneous human input.
      const inputRow = (
        await client.query<{ document: unknown }>(
          'SELECT document FROM input_requests WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [scope.projectId, inputId],
        )
      ).rows[0];
      const challenge = (
        await client.query<Challenge>(
          'SELECT * FROM auth_otp_challenges WHERE project_id=$1 AND input_id=$2 AND auth_session_id=$3 FOR UPDATE',
          [scope.projectId, inputId, sessionId],
        )
      ).rows[0];
      if (
        !challenge ||
        session?.status !== 'active' ||
        session.expires_at.getTime() <= Date.now() ||
        session.auth_epoch !== challenge.auth_epoch ||
        session.fencing_token !== String(proof.fencingToken) ||
        challenge.run_id !== run.id ||
        challenge.task_id !== proof.taskId ||
        challenge.fencing_token !== String(proof.fencingToken) ||
        challenge.context_version !== proof.contextVersion
      )
        throw new StorageError('AUTH_FAILED');
      const scopeRow = (
        await client.query<{
          status: string;
          auth_epoch: number;
          revoked: boolean;
        }>(
          `SELECT a.status,a.auth_epoch,p.revoked FROM run_auth_scopes a
         JOIN auth_profiles p ON p.project_id=a.project_id AND p.id=a.auth_profile_id
         WHERE a.project_id=$1 AND a.run_id=$2 FOR SHARE OF p`,
          [scope.projectId, run.id],
        )
      ).rows[0];
      if (
        scopeRow?.status !== 'initializing' ||
        scopeRow.auth_epoch !== challenge.auth_epoch ||
        scopeRow.revoked
      )
        throw new StorageError('AUTH_FAILED');
      if (challenge.status === 'rejected' || challenge.status === 'expired')
        return { status: challenge.status };
      if (challenge.expires_at.getTime() <= Date.now()) {
        await client.query(
          `UPDATE auth_otp_challenges SET status='expired',
             ciphertext=NULL,nonce=NULL,auth_tag=NULL,key_version=NULL WHERE input_id=$1`,
          [inputId],
        );
        const input = parseContract('InputRequest', inputRow?.document);
        if (input.status === 'pending') {
          const expired = {
            ...input,
            status: 'expired',
            version: input.version + 1,
          };
          await client.query(
            'UPDATE input_requests SET document=$2,version=version+1 WHERE id=$1',
            [inputId, expired],
          );
          await appendEvent(
            client,
            scope.projectId,
            run.id,
            'input.resolved',
            expired,
          );
        }
        return { status: 'expired' };
      }
      if (challenge.status === 'pending') return { status: 'pending' };
      if (
        challenge.status !== 'submitted' ||
        !challenge.ciphertext ||
        !challenge.nonce ||
        !challenge.auth_tag ||
        !challenge.key_version
      )
        throw new StorageError('AUTH_FAILED');
      // Consume and zero the ciphertext before returning the private code.
      await client.query(
        `UPDATE auth_otp_challenges SET status='consumed',
         ciphertext=NULL,nonce=NULL,auth_tag=NULL,key_version=NULL,
         consumed_at=clock_timestamp() WHERE input_id=$1`,
        [inputId],
      );
      const code = this.coordinator.vault.decrypt(
        {
          ciphertext: challenge.ciphertext,
          nonce: challenge.nonce,
          authTag: challenge.auth_tag,
          keyVersion: challenge.key_version,
        },
        { projectId: scope.projectId, secretId: inputId, purpose: 'auth_otp' },
      );
      return { status: 'ready', code };
    });
  }
}
