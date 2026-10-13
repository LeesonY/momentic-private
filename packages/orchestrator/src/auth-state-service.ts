import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseContract } from '@localqa/contracts';
import type {
  AuthProfile,
  BrowserSnapshot,
  CriterionResult,
  CredentialMaterial,
  Criterion,
} from '@localqa/contracts';
import {
  AGENT_LOGIN_CRITERION,
  evaluateAuthCriterion,
  evaluateTechnical,
} from '@localqa/domain';
import {
  StorageError,
  hashPayload,
  hashToken,
  appendEvent,
  type WorkerScope,
  type LeaseProof,
} from '@localqa/storage';
import {
  validateApprovedAuthState,
  type ApprovedAuthState,
  type AuthExportGrant,
} from '@localqa/browser';
import type { Coordinator } from './core.js';
import {
  validateAuthRecognition,
  type AuthRecognitionResult,
  type AuthRecognitionSlot,
} from './auth-ai.js';

export interface AuthStateRef {
  authStateId: string;
  runId: string;
  authEpoch: number;
  capturedAt: string;
}
interface ScopeRow {
  status: 'initializing' | 'granted' | 'revoked';
  auth_epoch: number;
  context_version: number;
  auth_profile_id: string;
  auth_profile_version: number;
  current_state_id: string | null;
}
interface SessionRow {
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
  purpose: 'initializer' | 'importer';
  status: string;
  expires_at: Date;
  ai_success_criterion: unknown;
  ai_success_snapshot_id: string | null;
}
interface Authority extends Awaited<ReturnType<Coordinator['validateLease']>> {
  session: SessionRow;
  authScope: ScopeRow;
  profile: AuthProfile;
  secretId: string | null;
  secretVersion: number | null;
}
interface CaptureGrant {
  id: string;
  project_id: string;
  run_id: string;
  task_id: string;
  auth_session_id: string;
  auth_epoch: number;
  ticket_hash: string;
  success_gate_id: string;
  status: string;
  deadline: Date;
}
interface StateRow {
  id: string;
  project_id: string;
  run_id: string;
  auth_profile_id: string;
  auth_profile_version: number;
  context_version: number;
  capturing_context_id: string;
  capturing_session_id: string;
  capturing_task_id: string;
  capturing_worker_id: string;
  capturing_fencing_token: string;
  capturing_grant_id: string;
  auth_epoch: number;
  status: string;
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  key_version: number;
  state_hmac: string;
  hmac_key_version: number;
  origin_fingerprint: string;
  captured_at: Date;
}
interface GateRow {
  id: string;
  auth_epoch: number;
  criterion_id: string;
  criterion_hash: string;
  snapshot_id: string;
  snapshot_hash: string;
  intent_fingerprint: string;
}

function approvedState(
  input: unknown,
  origins: readonly string[],
): ApprovedAuthState {
  try {
    return validateApprovedAuthState(input, origins);
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'TARGET_NOT_ALLOWED'
        ? 'TARGET_NOT_ALLOWED'
        : 'VALIDATION_ERROR';
    throw new StorageError(code);
  }
}
function originFingerprint(profile: AuthProfile): string {
  return hashPayload(
    profile.allowedOrigins.map((o) => new URL(o).origin).sort(),
  );
}
function stateRef(row: StateRow): AuthStateRef {
  return {
    authStateId: row.id,
    runId: row.run_id,
    authEpoch: row.auth_epoch,
    capturedAt: row.captured_at.toISOString(),
  };
}

/** Private state authority. All entry points lock the same authoritative tuple;
 * no method repairs a caller's old proof from current database values. */
export class AuthStateService {
  constructor(private readonly coordinator: Coordinator) {}

  private successCriterion(auth: Authority): Criterion | null {
    if (auth.profile.mode === 'storage_state')
      return auth.profile.storageCriterion ?? null;
    if (auth.profile.mode === 'agent') return AGENT_LOGIN_CRITERION;
    if (auth.profile.mode !== 'form') return null;
    if (auth.profile.formConfig?.detectionMode !== 'ai')
      return auth.profile.formConfig?.successCriterion ?? null;
    if (
      !auth.session.ai_success_snapshot_id ||
      !auth.session.ai_success_criterion
    )
      return null;
    return parseContract('Criterion', auth.session.ai_success_criterion);
  }

  async authRecognitionContext(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    snapshotId: string,
  ) {
    const auth = await this.authority(client, scope, proof, sessionId);
    this.initializing(auth);
    if (
      auth.profile.mode !== 'form' ||
      auth.profile.formConfig?.detectionMode !== 'ai'
    )
      throw new StorageError('POLICY_DENIED');
    const current = await this.current(client, auth);
    if (current.snapshot.snapshotId !== snapshotId)
      throw new StorageError('VERSION_CONFLICT');
    const before = (
      await client.query<{ document: unknown }>(
        'SELECT document FROM page_snapshots WHERE project_id=$1 AND task_id=$2 AND auth_session_id=$3 ORDER BY created_at,id LIMIT 1',
        [scope.projectId, proof.taskId, sessionId],
      )
    ).rows[0];
    const material = await this.authMaterial(client, scope, proof, sessionId);
    const sensitiveValues = ['username', 'password']
      .map((key) => material.material[key])
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      );
    await this.live(client, proof, auth);
    return {
      snapshot: current.snapshot,
      before: before
        ? parseContract('BrowserSnapshot', before.document)
        : undefined,
      sensitiveValues,
    };
  }

  async recordAuthRecognition(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    snapshotId: string,
    slot: AuthRecognitionSlot,
    answer: unknown,
  ): Promise<AuthRecognitionResult> {
    const context = await this.authRecognitionContext(
      client,
      scope,
      proof,
      sessionId,
      snapshotId,
    );
    const selected = validateAuthRecognition(
      context.snapshot,
      slot,
      answer,
      context.before,
    );
    if (slot !== 'success') return { target: selected.target };
    if (!selected.criterion)
      return {
        target: null,
        success: {
          criterionId: 'login_success',
          result: 'unknown',
          reason: '登录后的页面标识尚未确认',
          evidenceRefs: [],
        },
      };
    const actions = (
      await client.query<{
        tool_call: { name: string; args: { slot?: string } };
      }>(
        "SELECT tool_call FROM action_intents WHERE project_id=$1 AND task_id=$2 AND auth_session_id=$3 AND outcome='succeeded' AND execution_state='completed'",
        [scope.projectId, proof.taskId, sessionId],
      )
    ).rows.map((row) => `${row.tool_call.name}:${row.tool_call.args.slot}`);
    if (
      ![
        'fill_credential:username',
        'fill_credential:password',
        'submit_auth:submit',
      ].every((action) => actions.includes(action))
    )
      throw new StorageError('POLICY_DENIED');
    const result = evaluateTechnical(
      { criteria: [selected.criterion] },
      context.snapshot,
      context.snapshot.responseStatus,
      [snapshotId],
    )[0];
    if (result?.result !== 'passed') throw new StorageError('AUTH_FAILED');
    await client.query(
      "UPDATE auth_execution_sessions SET ai_success_criterion=$2,ai_success_snapshot_id=$3 WHERE id=$1 AND status='active'",
      [sessionId, selected.criterion, snapshotId],
    );
    return { target: selected.target, success: result };
  }

  private async authority(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<Authority> {
    const leased = await this.coordinator.validateLease(client, scope, proof);
    const { job, run } = leased;
    if (
      job.document.summary !== 'auth' ||
      (run.executionMode !== 'smoke' && run.executionMode !== 'regression')
    )
      throw new StorageError('POLICY_DENIED');
    const authScope = (
      await client.query<ScopeRow>(
        'SELECT * FROM run_auth_scopes WHERE project_id=$1 AND run_id=$2 FOR UPDATE',
        [scope.projectId, run.id],
      )
    ).rows[0];
    const session = (
      await client.query<SessionRow>(
        'SELECT * FROM auth_execution_sessions WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [sessionId, scope.projectId],
      )
    ).rows[0];
    if (
      !session ||
      session.status !== 'active' ||
      session.run_id !== run.id ||
      session.task_id !== proof.taskId ||
      session.worker_id !== scope.workerId ||
      session.fencing_token !== String(proof.fencingToken) ||
      session.context_version !== proof.contextVersion
    ) {
      throw new StorageError('LEASE_EXPIRED');
    }
    if (session.purpose !== 'initializer')
      throw new StorageError('POLICY_DENIED');
    const frozen = (
      await client.query<{
        auth_profile_id: string;
        auth_profile_version: number;
      }>(
        'SELECT auth_profile_id,auth_profile_version FROM runs WHERE project_id=$1 AND id=$2',
        [scope.projectId, run.id],
      )
    ).rows[0];
    if (
      !authScope ||
      !frozen ||
      authScope.status === 'revoked' ||
      authScope.context_version !== proof.contextVersion ||
      authScope.auth_epoch !== session.auth_epoch ||
      authScope.auth_profile_id !== frozen.auth_profile_id ||
      authScope.auth_profile_version !== frozen.auth_profile_version ||
      session.auth_profile_id !== frozen.auth_profile_id ||
      session.auth_profile_version !== frozen.auth_profile_version ||
      session.context_id === session.id
    )
      throw new StorageError('AUTH_FAILED');
    const profileRow = (
      await client.query<{
        document: unknown;
        secret_id: string | null;
        secret_version: number | null;
        revoked: boolean;
      }>(
        `SELECT v.document,v.secret_id,v.secret_version,p.revoked FROM auth_profiles p
       JOIN auth_profile_versions v ON v.project_id=p.project_id AND v.auth_profile_id=p.id AND v.version=$3
       WHERE p.project_id=$1 AND p.id=$2 FOR SHARE OF p,v`,
        [scope.projectId, frozen.auth_profile_id, frozen.auth_profile_version],
      )
    ).rows[0];
    if (!profileRow || profileRow.revoked)
      throw new StorageError('AUTH_FAILED');
    const profile = parseContract('AuthProfile', profileRow.document);
    if (
      profile.id !== frozen.auth_profile_id ||
      profile.projectId !== scope.projectId ||
      profile.version !== frozen.auth_profile_version ||
      profile.status !== 'active'
    )
      throw new StorageError('AUTH_FAILED');
    if (profile.mode === 'none') throw new StorageError('POLICY_DENIED');
    const allowed = new Set(
      profile.allowedOrigins.map((o) => new URL(o).origin),
    );
    if (
      run.effectiveConfig.allowedOrigins.some(
        (o) => !allowed.has(new URL(o).origin),
      )
    )
      throw new StorageError('TARGET_NOT_ALLOWED');
    const result = {
      ...leased,
      authScope,
      session,
      profile,
      secretId: profileRow.secret_id,
      secretVersion: profileRow.secret_version,
    };
    await this.live(client, proof, result);
    return result;
  }

  private async live(
    client: PoolClient,
    proof: LeaseProof,
    auth: Authority,
    grant?: CaptureGrant,
  ): Promise<Date> {
    const row = (
      await client.query<{ lease_until: Date; expires_at: Date; now: Date }>(
        `SELECT l.lease_until,s.expires_at,clock_timestamp() AS now
       FROM task_leases l JOIN jobs j ON j.id=l.task_id AND j.fencing_token=l.fencing_token
       JOIN auth_execution_sessions s ON s.id=$3
       WHERE l.task_id=$1 AND l.fencing_token=$2 AND l.released_at IS NULL AND j.status='running'
         AND l.lease_until>clock_timestamp() AND j.lease_until>clock_timestamp()
         AND s.status='active' AND s.expires_at>clock_timestamp()`,
        [proof.taskId, proof.fencingToken, auth.session.id],
      )
    ).rows[0];
    if (!row || (grant && grant.deadline <= row.now))
      throw new StorageError('LEASE_EXPIRED');
    const deadline =
      row.lease_until < row.expires_at ? row.lease_until : row.expires_at;
    return grant && grant.deadline < deadline ? grant.deadline : deadline;
  }

  private initializing(auth: Authority): void {
    if (
      auth.authScope.status !== 'initializing' ||
      auth.authScope.current_state_id !== null
    )
      throw new StorageError('POLICY_DENIED');
  }

  private async current(
    client: PoolClient,
    auth: Authority,
  ): Promise<{ snapshot: BrowserSnapshot; intentFingerprint: string }> {
    const latest = (
      await client.query<{ id: string; document: unknown }>(
        `SELECT id,document FROM page_snapshots WHERE project_id=$1 AND run_id=$2 AND task_id=$3 AND auth_session_id=$4
       ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`,
        [auth.run.projectId, auth.run.id, auth.job.id, auth.session.id],
      )
    ).rows[0];
    if (!latest) throw new StorageError('NOT_FOUND');
    const snapshot = parseContract('BrowserSnapshot', latest.document);
    if (snapshot.snapshotId !== latest.id || !snapshot.redacted)
      throw new StorageError('VALIDATION_ERROR');
    const intents = (
      await client.query<{
        id: string;
        outcome: string;
        execution_state: string | null;
      }>(
        'SELECT id,outcome,execution_state FROM action_intents WHERE project_id=$1 AND task_id=$2 ORDER BY id',
        [auth.run.projectId, auth.job.id],
      )
    ).rows;
    if (
      intents.some(
        (i) =>
          i.outcome === 'pending' ||
          (i.execution_state !== null && i.execution_state !== 'completed'),
      )
    ) {
      throw new StorageError('VALIDATION_ERROR');
    }
    return { snapshot, intentFingerprint: hashPayload(intents) };
  }

  private async verifyGate(
    client: PoolClient,
    auth: Authority,
    gateId: string,
  ): Promise<void> {
    const gate = (
      await client.query<GateRow>(
        `SELECT * FROM auth_success_gates WHERE id=$1 AND project_id=$2 AND run_id=$3 AND task_id=$4 AND auth_session_id=$5
       FOR SHARE`,
        [gateId, auth.run.projectId, auth.run.id, auth.job.id, auth.session.id],
      )
    ).rows[0];
    if (!gate) throw new StorageError('NOT_FOUND');
    const criterion = this.successCriterion(auth);
    if (
      !criterion ||
      gate.auth_epoch !== auth.session.auth_epoch ||
      gate.criterion_id !== criterion.id ||
      gate.criterion_hash !== hashPayload(criterion)
    )
      throw new StorageError('AUTH_FAILED');
    const current = await this.current(client, auth);
    if (
      current.snapshot.snapshotId !== gate.snapshot_id ||
      hashPayload(current.snapshot) !== gate.snapshot_hash ||
      current.intentFingerprint !== gate.intent_fingerprint
    )
      throw new StorageError('VERSION_CONFLICT');
  }

  private async grant(
    client: PoolClient,
    auth: Authority,
    grantId: string,
    ticket: string,
  ): Promise<CaptureGrant> {
    const grant = (
      await client.query<CaptureGrant>(
        `SELECT * FROM auth_capture_grants WHERE id=$1 AND project_id=$2 AND run_id=$3 AND task_id=$4 AND auth_session_id=$5 FOR UPDATE`,
        [
          grantId,
          auth.run.projectId,
          auth.run.id,
          auth.job.id,
          auth.session.id,
        ],
      )
    ).rows[0];
    if (!grant) throw new StorageError('NOT_FOUND');
    if (
      typeof ticket !== 'string' ||
      grant.ticket_hash !== createHash('sha256').update(ticket).digest('hex')
    )
      throw new StorageError('FORBIDDEN');
    if (grant.auth_epoch !== auth.session.auth_epoch)
      throw new StorageError('AUTH_FAILED');
    return grant;
  }

  private async lock(
    client: PoolClient,
    auth: Authority,
    granted: boolean,
  ): Promise<void> {
    if (auth.profile.sharingPolicy !== 'exclusive_run') return;
    const lock = (
      await client.query<{
        run_id: string;
        auth_session_id: string;
        auth_epoch: number;
        phase: string;
      }>(
        `SELECT run_id,auth_session_id,auth_epoch,phase FROM auth_profile_run_locks
       WHERE project_id=$1 AND auth_profile_id=$2 AND status='held' FOR UPDATE`,
        [auth.run.projectId, auth.profile.id],
      )
    ).rows[0];
    if (
      !lock ||
      lock.run_id !== auth.run.id ||
      lock.auth_epoch !== auth.session.auth_epoch ||
      lock.auth_session_id !== auth.session.id ||
      lock.phase !== (granted ? 'granted' : 'initializing')
    )
      throw new StorageError('AUTH_FAILED');
  }

  async finishAuth(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    authStateId: string,
  ): Promise<void> {
    if (
      typeof authStateId !== 'string' ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(authStateId)
    )
      throw new StorageError('VALIDATION_ERROR');
    const result = { stage: 'auth', granted: true, authStateId };
    const completed = (
      await client.query<{
        document: { summary: string };
        result: Record<string, unknown>;
        result_hash: string;
        context_version: number;
        auth_session_id: string;
        session_status: string;
        end_reason: string;
      }>(
        `SELECT j.document,j.result,j.result_hash,r.context_version,s.id AS auth_session_id,s.status AS session_status,s.end_reason
       FROM jobs j JOIN task_leases l ON l.task_id=j.id AND l.fencing_token=j.fencing_token
       JOIN runs r ON r.id=j.run_id AND r.project_id=j.project_id
       JOIN auth_execution_sessions s ON s.task_id=j.id AND s.fencing_token=j.fencing_token
       WHERE j.id=$1 AND j.project_id=$2 AND j.status='succeeded' AND j.fencing_token=$3
         AND l.worker_id=$4 AND l.token_hash=$5 FOR UPDATE OF j`,
        [
          proof.taskId,
          scope.projectId,
          proof.fencingToken,
          scope.workerId,
          hashToken(proof.leaseToken),
        ],
      )
    ).rows[0];
    if (completed) {
      if (
        completed.context_version !== proof.contextVersion ||
        completed.auth_session_id !== sessionId ||
        completed.document.summary !== 'auth' ||
        completed.session_status !== 'ended' ||
        completed.end_reason !== 'auth_finished'
      ) {
        throw new StorageError('LEASE_EXPIRED');
      }
      if (completed.result_hash !== hashPayload(result))
        throw new StorageError('IDEMPOTENCY_CONFLICT');
      return; // Historical completion only: never reissue material or state authority.
    }
    const auth = await this.authority(client, scope, proof, sessionId);
    if (
      auth.job.role !== 'executor' ||
      auth.job.case_id !== null ||
      auth.authScope.status !== 'granted' ||
      auth.authScope.current_state_id !== authStateId
    )
      throw new StorageError('POLICY_DENIED');
    const state = (
      await client.query<StateRow>(
        'SELECT * FROM run_auth_states WHERE id=$1 AND project_id=$2 AND run_id=$3 FOR UPDATE',
        [authStateId, scope.projectId, auth.run.id],
      )
    ).rows[0];
    if (!state) throw new StorageError('AUTH_FAILED');
    const grant = (
      await client.query<CaptureGrant>(
        `SELECT * FROM auth_capture_grants WHERE id=$1 AND project_id=$2 AND run_id=$3 AND task_id=$4 AND auth_session_id=$5 FOR UPDATE`,
        [
          state.capturing_grant_id,
          scope.projectId,
          auth.run.id,
          proof.taskId,
          sessionId,
        ],
      )
    ).rows[0];
    if (
      !grant ||
      grant.status !== 'consumed' ||
      grant.auth_epoch !== auth.session.auth_epoch
    )
      throw new StorageError('AUTH_FAILED');
    this.decode(auth, state, grant);
    await this.verifyGate(client, auth, grant.success_gate_id);
    await this.lock(client, auth, true);
    await this.coordinator.pulse(client, scope.projectId, auth.run.id);
    await this.coordinator.releaseSlots(client, scope.projectId, proof.taskId);
    const deadline = await this.live(client, proof, auth, grant);
    const finishTime = (
      await client.query<{ started_at: Date | null; finished_at: Date | null }>(
        "UPDATE jobs SET status='succeeded',result=$2,result_hash=$3,finished_at=clock_timestamp() WHERE id=$1 RETURNING started_at,finished_at",
        [proof.taskId, result, hashPayload(result)],
      )
    ).rows[0];
    await client.query(
      'UPDATE task_leases SET released_at=clock_timestamp() WHERE task_id=$1 AND fencing_token=$2',
      [proof.taskId, proof.fencingToken],
    );
    await client.query(
      "UPDATE auth_execution_sessions SET status='ended',ended_at=clock_timestamp(),end_reason='auth_finished' WHERE id=$1",
      [sessionId],
    );
    await this.coordinator.pulse(client, scope.projectId, auth.run.id);
    await appendEvent(client, scope.projectId, auth.run.id, 'task.updated', {
      ...auth.job.document,
      status: 'succeeded',
      elapsedSeconds:
        finishTime?.started_at && finishTime?.finished_at
          ? Math.max(
              1,
              Math.ceil(
                (new Date(finishTime.finished_at).getTime() -
                  new Date(finishTime.started_at).getTime()) /
                  1000,
              ),
            )
          : 0,
    });
    const time = (
      await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now;
    if (time >= deadline) throw new StorageError('LEASE_EXPIRED');
  }

  async authMaterial(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<CredentialMaterial> {
    const auth = await this.authority(client, scope, proof, sessionId);
    this.initializing(auth);
    if (!auth.secretId || !auth.secretVersion)
      throw new StorageError('AUTH_FAILED');
    const secret = (
      await client.query<{
        ciphertext: Buffer;
        nonce: Buffer;
        auth_tag: Buffer;
        key_version: number;
        purpose: string;
      }>(
        `SELECT v.ciphertext,v.nonce,v.auth_tag,v.key_version,s.purpose FROM secret_versions v
       JOIN secrets s ON s.id=v.secret_id AND s.project_id=v.project_id
       WHERE v.project_id=$1 AND v.secret_id=$2 AND v.version=$3 AND NOT s.revoked FOR SHARE OF s,v`,
        [scope.projectId, auth.secretId, auth.secretVersion],
      )
    ).rows[0];
    if (!secret) throw new StorageError('AUTH_FAILED');
    const expiresAt = await this.live(client, proof, auth);
    let material: unknown;
    try {
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
            secretId: auth.secretId,
            purpose: secret.purpose,
          },
        ),
      );
    } catch {
      throw new StorageError('AUTH_FAILED');
    }
    return parseContract('CredentialMaterial', {
      mode: auth.profile.mode,
      material,
      expiresAt: expiresAt.toISOString(),
    });
  }

  async recordAuthCriterion(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    input: CriterionResult,
    snapshotId: string,
  ): Promise<{ gateId: string }> {
    const auth = await this.authority(client, scope, proof, sessionId);
    this.initializing(auth);
    const criterion = this.successCriterion(auth);
    if (!criterion) throw new StorageError('POLICY_DENIED');
    let result: CriterionResult;
    try {
      result = parseContract('CriterionResult', input);
    } catch {
      throw new StorageError('VALIDATION_ERROR');
    }
    if (result.criterionId !== criterion.id)
      throw new StorageError('VALIDATION_ERROR');
    if (result.result !== 'passed') throw new StorageError('POLICY_DENIED');
    const current = await this.current(client, auth);
    if (current.snapshot.snapshotId !== snapshotId)
      throw new StorageError('NOT_FOUND');
    // An auth success gate must be derived from the actual server-owned
    // observation, not from a worker's self-reported "passed" flag.
    // Only fixed, locally evaluable criteria may authorize credential reuse;
    // speculative semantic/visual assertions stay blocked. Agent sign-in uses
    // its own fixed, deterministic oracle over this same observation.
    const observed = evaluateAuthCriterion(
      auth.profile,
      criterion,
      current.snapshot,
      [snapshotId],
    );
    if (
      observed?.result !== 'passed' ||
      result.evidenceRefs.length === 0 ||
      !result.evidenceRefs.every((ref) => ref === snapshotId)
    )
      throw new StorageError('POLICY_DENIED');
    await this.live(client, proof, auth);
    const gateId = randomUUID();
    await client.query(
      `INSERT INTO auth_success_gates(id,project_id,run_id,task_id,auth_session_id,auth_epoch,criterion_id,criterion_hash,snapshot_id,snapshot_hash,intent_fingerprint,result)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'passed')`,
      [
        gateId,
        scope.projectId,
        auth.run.id,
        proof.taskId,
        sessionId,
        auth.session.auth_epoch,
        criterion.id,
        hashPayload(criterion),
        snapshotId,
        hashPayload(current.snapshot),
        current.intentFingerprint,
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
    const auth = await this.authority(client, scope, proof, sessionId);
    this.initializing(auth);
    await this.verifyGate(client, auth, gateId);
    const prior = await client.query(
      'SELECT id FROM auth_capture_grants WHERE auth_session_id=$1 LIMIT 1',
      [sessionId],
    );
    if (prior.rowCount) throw new StorageError('VERSION_CONFLICT');
    const deadline = await this.live(client, proof, auth);
    const grantId = randomUUID(),
      ticket = randomBytes(32).toString('hex');
    await client.query(
      `INSERT INTO auth_capture_grants(id,project_id,run_id,task_id,auth_session_id,auth_epoch,ticket_hash,success_gate_id,status,deadline)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'issued',$9)`,
      [
        grantId,
        scope.projectId,
        auth.run.id,
        proof.taskId,
        sessionId,
        auth.session.auth_epoch,
        createHash('sha256').update(ticket).digest('hex'),
        gateId,
        deadline,
      ],
    );
    return {
      captureTicket: ticket,
      grant: {
        grantId,
        kind: 'capture_auth_state',
        sessionId,
        projectId: scope.projectId,
        runId: auth.run.id,
        taskId: proof.taskId,
        workerId: scope.workerId,
        fencingToken: proof.fencingToken,
        contextVersion: proof.contextVersion,
        contextId: auth.session.context_id,
        profileId: auth.profile.id,
        profileVersion: auth.profile.version,
        authEpoch: auth.session.auth_epoch,
        purpose: 'initializer',
        status: 'active',
        expiresAt: auth.session.expires_at.toISOString(),
        deadline: deadline.toISOString(),
        captureTicket: ticket,
      },
    };
  }

  async beginAuthCapture(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    ticket: string,
  ): Promise<void> {
    const auth = await this.authority(client, scope, proof, sessionId);
    this.initializing(auth);
    const grant = await this.grant(client, auth, grantId, ticket);
    if (grant.status !== 'issued') throw new StorageError('VERSION_CONFLICT');
    await this.verifyGate(client, auth, grant.success_gate_id);
    await this.live(client, proof, auth, grant);
    const updated = await client.query(
      "UPDATE auth_capture_grants SET status='started',started_at=clock_timestamp() WHERE id=$1 AND status='issued' RETURNING id",
      [grantId],
    );
    if (updated.rowCount !== 1) throw new StorageError('VERSION_CONFLICT');
  }

  /** Internal importer reader: current authority is checked by AuthImportService;
   * this verifies the complete historical capture against the same decoder used
   * by capture/finish. Historical leases need not still be active. */
  async importState(
    client: PoolClient,
    current: {
      run: Authority['run'];
      profile: AuthProfile;
      epoch: number;
      contextVersion: number;
      stateId: string;
    },
    decrypt: boolean,
  ): Promise<ApprovedAuthState | string> {
    const row = (
      await client.query<StateRow>(
        'SELECT * FROM run_auth_states WHERE id=$1 AND project_id=$2 AND run_id=$3 FOR SHARE',
        [current.stateId, current.run.projectId, current.run.id],
      )
    ).rows[0];
    if (
      !row ||
      row.status !== 'granted' ||
      row.auth_epoch !== current.epoch ||
      row.context_version !== current.contextVersion ||
      row.auth_profile_id !== current.profile.id ||
      row.auth_profile_version !== current.profile.version ||
      row.origin_fingerprint !== originFingerprint(current.profile)
    )
      throw new StorageError('AUTH_FAILED');
    const session = (
      await client.query<SessionRow & { end_reason: string | null }>(
        'SELECT * FROM auth_execution_sessions WHERE id=$1 AND project_id=$2',
        [row.capturing_session_id, current.run.projectId],
      )
    ).rows[0];
    const job = (
      await client.query<Authority['job']>(
        'SELECT * FROM jobs WHERE id=$1 AND project_id=$2 AND run_id=$3',
        [row.capturing_task_id, current.run.projectId, current.run.id],
      )
    ).rows[0];
    const grant = (
      await client.query<CaptureGrant>(
        'SELECT * FROM auth_capture_grants WHERE id=$1 FOR SHARE',
        [row.capturing_grant_id],
      )
    ).rows[0];
    if (
      !session ||
      !job ||
      !grant ||
      session.purpose !== 'initializer' ||
      !['active', 'ended'].includes(session.status) ||
      (session.status === 'ended' &&
        !['auth_finished', 'interrupted'].includes(session.end_reason ?? '')) ||
      session.project_id !== row.project_id ||
      session.run_id !== row.run_id ||
      session.task_id !== row.capturing_task_id ||
      session.worker_id !== row.capturing_worker_id ||
      session.fencing_token !== row.capturing_fencing_token ||
      session.context_id !== row.capturing_context_id ||
      session.context_version !== row.context_version ||
      session.auth_epoch !== row.auth_epoch ||
      session.auth_profile_id !== row.auth_profile_id ||
      session.auth_profile_version !== row.auth_profile_version ||
      job.document.summary !== 'auth' ||
      job.fencing_token !== row.capturing_fencing_token ||
      grant.status !== 'consumed' ||
      grant.project_id !== row.project_id ||
      grant.run_id !== row.run_id ||
      grant.task_id !== row.capturing_task_id ||
      grant.auth_session_id !== session.id ||
      grant.auth_epoch !== row.auth_epoch
    )
      throw new StorageError('AUTH_FAILED');
    const historical: Authority = {
      job,
      run: current.run,
      session,
      profile: current.profile,
      authScope: {
        status: 'granted',
        current_state_id: row.id,
        auth_epoch: current.epoch,
        context_version: current.contextVersion,
        auth_profile_id: current.profile.id,
        auth_profile_version: current.profile.version,
      },
      secretId: null,
      secretVersion: null,
    };
    // A grant pins the protected row as well as its ID. Rotation/tampering of
    // ciphertext or historical HMAC after prepare cannot authorize an effect.
    return decrypt ? this.decode(historical, row, grant) : hashPayload(row);
  }

  private decode(
    auth: Authority,
    row: StateRow,
    grant: CaptureGrant,
  ): ApprovedAuthState {
    if (
      row.status !== 'granted' ||
      row.project_id !== auth.run.projectId ||
      row.run_id !== auth.run.id ||
      row.auth_profile_id !== auth.profile.id ||
      row.auth_profile_version !== auth.profile.version ||
      row.context_version !== auth.session.context_version ||
      row.capturing_context_id !== auth.session.context_id ||
      row.auth_epoch !== auth.session.auth_epoch ||
      row.capturing_session_id !== auth.session.id ||
      row.capturing_task_id !== auth.job.id ||
      row.capturing_worker_id !== auth.session.worker_id ||
      row.capturing_fencing_token !== auth.session.fencing_token ||
      row.capturing_grant_id !== grant.id ||
      row.origin_fingerprint !== originFingerprint(auth.profile)
    )
      throw new StorageError('AUTH_FAILED');
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(
        this.coordinator.vault.decrypt(
          {
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            authTag: row.auth_tag,
            keyVersion: row.key_version,
          },
          {
            projectId: row.project_id,
            secretId: row.id,
            purpose: 'run_auth_state',
          },
        ),
      );
    } catch {
      throw new StorageError('AUTH_FAILED');
    }
    const expected = this.envelopeBinding(auth, grant.id);
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Object.entries(expected).some(([key, value]) => envelope[key] !== value)
    ) {
      throw new StorageError('AUTH_FAILED');
    }
    const state = approvedState(envelope.state, auth.profile.allowedOrigins);
    if (
      !this.coordinator.vault.verifyKeyedHmac(
        hashPayload(state),
        'auth_state_capture',
        row.state_hmac,
        row.hmac_key_version,
      )
    )
      throw new StorageError('AUTH_FAILED');
    return state;
  }

  private envelopeBinding(
    auth: Authority,
    grantId: string,
  ): Record<string, string | number> {
    return {
      projectId: auth.run.projectId,
      runId: auth.run.id,
      contextVersion: auth.session.context_version,
      contextId: auth.session.context_id,
      profileId: auth.profile.id,
      profileVersion: auth.profile.version,
      authEpoch: auth.session.auth_epoch,
      capturingSessionId: auth.session.id,
      capturingTaskId: auth.job.id,
      capturingWorkerId: auth.session.worker_id,
      capturingFencingToken: Number(auth.session.fencing_token),
      capturingGrantId: grantId,
    };
  }

  async captureAuthState(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    ticket: string,
    input: ApprovedAuthState,
  ): Promise<AuthStateRef> {
    const auth = await this.authority(client, scope, proof, sessionId);
    const grant = await this.grant(client, auth, grantId, ticket);
    if (!['started', 'consumed'].includes(grant.status))
      throw new StorageError('VALIDATION_ERROR');
    await this.verifyGate(client, auth, grant.success_gate_id);
    const existing = (
      await client.query<StateRow>(
        'SELECT * FROM run_auth_states WHERE project_id=$1 AND run_id=$2 FOR UPDATE',
        [scope.projectId, auth.run.id],
      )
    ).rows[0];
    const state = approvedState(input, auth.profile.allowedOrigins);
    const payloadHash = hashPayload(state);
    await this.lock(client, auth, Boolean(existing));
    await this.live(client, proof, auth, grant);
    if (existing) {
      if (
        grant.status !== 'consumed' ||
        auth.authScope.status !== 'granted' ||
        auth.authScope.current_state_id !== existing.id
      )
        throw new StorageError('AUTH_FAILED');
      this.decode(auth, existing, grant);
      if (
        !this.coordinator.vault.verifyKeyedHmac(
          payloadHash,
          'auth_state_capture',
          existing.state_hmac,
          existing.hmac_key_version,
        )
      ) {
        throw new StorageError('IDEMPOTENCY_CONFLICT');
      }
      return stateRef(existing);
    }
    this.initializing(auth);
    if (grant.status !== 'started') throw new StorageError('VALIDATION_ERROR');
    const stateId = randomUUID();
    const cipher = this.coordinator.vault.encrypt(
      JSON.stringify({ ...this.envelopeBinding(auth, grant.id), state }),
      {
        projectId: scope.projectId,
        secretId: stateId,
        purpose: 'run_auth_state',
      },
    );
    const fingerprint = this.coordinator.vault.keyedHmac(
      payloadHash,
      'auth_state_capture',
    );
    const row = (
      await client.query<StateRow>(
        `INSERT INTO run_auth_states(id,project_id,run_id,auth_profile_id,auth_profile_version,context_version,capturing_context_id,
       capturing_session_id,capturing_task_id,capturing_worker_id,capturing_fencing_token,capturing_grant_id,
       auth_epoch,status,ciphertext,nonce,auth_tag,key_version,state_hmac,hmac_key_version,origin_fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'granted',$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [
          stateId,
          scope.projectId,
          auth.run.id,
          auth.profile.id,
          auth.profile.version,
          proof.contextVersion,
          auth.session.context_id,
          sessionId,
          proof.taskId,
          scope.workerId,
          proof.fencingToken,
          grantId,
          auth.session.auth_epoch,
          cipher.ciphertext,
          cipher.nonce,
          cipher.authTag,
          cipher.keyVersion,
          fingerprint.hmac,
          fingerprint.keyVersion,
          originFingerprint(auth.profile),
        ],
      )
    ).rows[0]!;
    await client.query(
      "UPDATE auth_capture_grants SET status='consumed',consumed_at=clock_timestamp() WHERE id=$1",
      [grantId],
    );
    await client.query(
      "UPDATE run_auth_scopes SET status='granted',current_state_id=$1,updated_at=clock_timestamp() WHERE project_id=$2 AND run_id=$3",
      [stateId, scope.projectId, auth.run.id],
    );
    if (auth.profile.sharingPolicy === 'exclusive_run') {
      const promoted = await client.query(
        "UPDATE auth_profile_run_locks SET phase='granted' WHERE project_id=$1 AND run_id=$2 AND auth_session_id=$3 AND auth_epoch=$4 AND status='held' AND phase='initializing' RETURNING id",
        [scope.projectId, auth.run.id, sessionId, auth.session.auth_epoch],
      );
      if (promoted.rowCount !== 1) throw new StorageError('AUTH_FAILED');
    }
    // Insertion/unique-index waits can outlive a previously checked deadline.
    await this.live(client, proof, auth, grant);
    return stateRef(row);
  }
}
