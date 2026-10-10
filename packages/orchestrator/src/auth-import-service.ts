import { randomUUID, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseContract, type AuthProfile, type Step } from '@localqa/contracts';
import {
  StorageError,
  hashPayload,
  appendEvent,
  type WorkerScope,
  type LeaseProof,
} from '@localqa/storage';
import type { ApprovedAuthState } from '@localqa/browser';
import type { Coordinator } from './core.js';
import type { AuthSessionBinding } from './auth-execution.js';

export interface AuthImportGrant extends AuthSessionBinding {
  grantId: string;
  authStateId: string;
  kind: 'import_auth_state';
  deadline: string;
}
export interface AuthImportReceipt {
  grantId: string;
  executionId: string;
  startedAt: string;
}
export interface AuthImportOutcome {
  status: 'succeeded' | 'failed' | 'unknown' | 'cancelled';
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
  status: AuthSessionBinding['status'];
  expires_at: Date;
  import_auth_state_id: string | null;
}
interface ScopeRow {
  status: string;
  auth_epoch: number;
  context_version: number;
  auth_profile_id: string;
  auth_profile_version: number;
  current_state_id: string | null;
}
interface Authority extends Awaited<ReturnType<Coordinator['validateLease']>> {
  session: SessionRow | undefined;
  profile: AuthProfile;
  authScope: ScopeRow;
  stateId: string;
  stateFingerprint: string;
}
interface GrantRow {
  id: string;
  project_id: string;
  run_id: string;
  task_id: string;
  auth_session_id: string;
  auth_state_id: string;
  state_fingerprint: string;
  worker_id: string;
  fencing_token: string;
  context_version: number;
  context_id: string;
  auth_profile_id: string;
  auth_profile_version: number;
  auth_epoch: number;
  status: string;
  deadline: Date;
  receipt_hash: string | null;
  result_hash: string | null;
}
function binding(s: SessionRow): AuthSessionBinding {
  return {
    sessionId: s.id,
    projectId: s.project_id,
    runId: s.run_id,
    taskId: s.task_id,
    workerId: s.worker_id,
    fencingToken: Number(s.fencing_token),
    contextVersion: s.context_version,
    contextId: s.context_id,
    profileId: s.auth_profile_id,
    profileVersion: s.auth_profile_version,
    authEpoch: s.auth_epoch,
    purpose: s.purpose,
    status: s.status,
    expiresAt: s.expires_at.toISOString(),
  };
}
function uuid(value: string): void {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
  )
    throw new StorageError('VALIDATION_ERROR');
}

/** Server-internal only. No raw state/receipts may enter DTOs, steps or events. */
export class AuthImportService {
  constructor(private readonly coordinator: Coordinator) {}

  private async authority(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    stateId?: string,
    sessionId?: string,
    allocated = false,
  ): Promise<Authority> {
    if (stateId) uuid(stateId);
    if (sessionId) uuid(sessionId);
    const leased = await this.coordinator.validateLease(client, scope, proof);
    const { job, run } = leased;
    const roles: Record<string, string> = {
      explore: 'explorer',
      execute: 'executor',
      reproduce: 'reproducer',
    };
    if (
      (run.executionMode !== 'smoke' && run.executionMode !== 'regression') ||
      roles[job.document.summary] !== job.role
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
        sessionId
          ? 'SELECT * FROM auth_execution_sessions WHERE id=$1 AND project_id=$2 FOR UPDATE'
          : 'SELECT * FROM auth_execution_sessions WHERE task_id=$1 AND project_id=$2 AND fencing_token=$3 FOR UPDATE',
        sessionId
          ? [sessionId, scope.projectId]
          : [proof.taskId, scope.projectId, proof.fencingToken],
      )
    ).rows[0];
    if (sessionId && !session) throw new StorageError('LEASE_EXPIRED');
    if (
      session &&
      (session.run_id !== run.id ||
        session.task_id !== proof.taskId ||
        session.worker_id !== scope.workerId ||
        session.fencing_token !== String(proof.fencingToken) ||
        session.context_version !== proof.contextVersion)
    )
      throw new StorageError('LEASE_EXPIRED');
    if (session && session.purpose !== 'importer')
      throw new StorageError('POLICY_DENIED');
    if (
      session &&
      !(allocated ? ['allocated', 'active'] : ['active']).includes(
        session.status,
      )
    )
      throw new StorageError('LEASE_EXPIRED');
    const frozen = (
      await client.query<{
        document: unknown;
        revoked: boolean;
        auth_profile_id: string;
        auth_profile_version: number;
      }>(
        `SELECT v.document,p.revoked,r.auth_profile_id,r.auth_profile_version FROM runs r
       JOIN auth_profiles p ON p.id=r.auth_profile_id AND p.project_id=r.project_id
       JOIN auth_profile_versions v ON v.project_id=p.project_id AND v.auth_profile_id=p.id AND v.version=r.auth_profile_version
       WHERE r.project_id=$1 AND r.id=$2 FOR SHARE OF p,v`,
        [scope.projectId, run.id],
      )
    ).rows[0];
    if (!frozen || frozen.revoked) throw new StorageError('AUTH_FAILED');
    const profile = parseContract('AuthProfile', frozen.document);
    if (profile.mode === 'none') throw new StorageError('POLICY_DENIED');
    if (
      profile.status !== 'active' ||
      profile.projectId !== scope.projectId ||
      profile.id !== frozen.auth_profile_id ||
      profile.version !== frozen.auth_profile_version ||
      run.effectiveConfig.authProfileVersion !== profile.version
    )
      throw new StorageError('AUTH_FAILED');
    const resolvedState = stateId ?? session?.import_auth_state_id;
    if (
      !resolvedState ||
      !authScope ||
      authScope.status !== 'granted' ||
      authScope.current_state_id !== resolvedState ||
      authScope.context_version !== proof.contextVersion ||
      authScope.auth_profile_id !== profile.id ||
      authScope.auth_profile_version !== profile.version ||
      (session &&
        (session.import_auth_state_id !== resolvedState ||
          session.auth_epoch !== authScope.auth_epoch ||
          session.auth_profile_id !== profile.id ||
          session.auth_profile_version !== profile.version))
    )
      throw new StorageError('AUTH_FAILED');
    const origins = new Set(
      profile.allowedOrigins.map((o) => new URL(o).origin),
    );
    if (
      run.effectiveConfig.allowedOrigins.some(
        (o) => !origins.has(new URL(o).origin),
      )
    )
      throw new StorageError('TARGET_NOT_ALLOWED');
    if (profile.sharingPolicy === 'exclusive_run') {
      const lock = (
        await client.query<{
          run_id: string;
          auth_epoch: number;
          phase: string;
        }>(
          `SELECT run_id,auth_epoch,phase FROM auth_profile_run_locks WHERE project_id=$1 AND auth_profile_id=$2 AND status='held' FOR SHARE`,
          [scope.projectId, profile.id],
        )
      ).rows[0];
      if (
        !lock ||
        lock.run_id !== run.id ||
        lock.auth_epoch !== authScope.auth_epoch ||
        lock.phase !== 'granted'
      )
        throw new StorageError('AUTH_FAILED');
    }
    const auth = {
      ...leased,
      session,
      profile,
      authScope,
      stateId: resolvedState,
      stateFingerprint: '',
    };
    const fingerprint = await this.coordinator.authStateService.importState(
      client,
      this.stateAuthority(auth),
      false,
    );
    if (typeof fingerprint !== 'string') throw new StorageError('AUTH_FAILED');
    auth.stateFingerprint = fingerprint;
    await this.live(client, proof, auth);
    return auth;
  }
  private stateAuthority(a: Authority) {
    return {
      run: a.run,
      profile: a.profile,
      epoch: a.authScope.auth_epoch,
      contextVersion: a.authScope.context_version,
      stateId: a.stateId,
    };
  }
  private async live(
    client: PoolClient,
    proof: LeaseProof,
    a: Authority,
    g?: GrantRow,
  ): Promise<Date> {
    const row = (
      await client.query<{ deadline: Date; now: Date }>(
        `SELECT LEAST(j.lease_until,l.lease_until,COALESCE(s.expires_at,j.lease_until)) AS deadline,clock_timestamp() AS now
       FROM jobs j JOIN task_leases l ON l.task_id=j.id AND l.fencing_token=j.fencing_token
       LEFT JOIN auth_execution_sessions s ON s.id=$3
       WHERE j.id=$1 AND j.fencing_token=$2 AND j.status='running' AND l.released_at IS NULL
         AND j.lease_until>clock_timestamp() AND l.lease_until>clock_timestamp()
         AND ($3::uuid IS NULL OR (s.status IN ('allocated','active') AND s.expires_at>clock_timestamp()))`,
        [proof.taskId, proof.fencingToken, a.session?.id ?? null],
      )
    ).rows[0];
    if (!row || (g && g.deadline <= row.now))
      throw new StorageError('LEASE_EXPIRED');
    return g && g.deadline < row.deadline ? g.deadline : row.deadline;
  }
  async allocate(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    stateId: string,
  ): Promise<AuthSessionBinding> {
    const a = await this.authority(
      client,
      scope,
      proof,
      stateId,
      undefined,
      true,
    );
    if (a.session) {
      if (a.session.status !== 'allocated')
        throw new StorageError('VERSION_CONFLICT');
      return binding(a.session);
    }
    const expires = await this.live(client, proof, a);
    const taskContext = (
      await client.query<{ context_id: string | null }>(
        `SELECT result->>'authContextId' AS context_id
         FROM jobs WHERE id=$1 AND project_id=$2 AND run_id=$3`,
        [proof.taskId, scope.projectId, a.run.id],
      )
    ).rows[0]?.context_id;
    if (
      !taskContext ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(taskContext)
    )
      throw new StorageError('VALIDATION_ERROR');
    const row = (
      await client.query<SessionRow>(
        `INSERT INTO auth_execution_sessions(id,project_id,run_id,task_id,worker_id,fencing_token,context_version,context_id,
        auth_profile_id,auth_profile_version,auth_epoch,purpose,status,expires_at,import_auth_state_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'importer','allocated',$12,$13) RETURNING *`,
        [
          randomUUID(),
          scope.projectId,
          a.run.id,
          proof.taskId,
          scope.workerId,
          proof.fencingToken,
          proof.contextVersion,
          taskContext,
          a.profile.id,
          a.profile.version,
          a.authScope.auth_epoch,
          expires,
          stateId,
        ],
      )
    ).rows[0]!;
    await this.live(client, proof, { ...a, session: row });
    return binding(row);
  }
  /** Activation methods reuse tickets/CAS, with importer-specific current authority. */
  async validateSession(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<void> {
    await this.authority(client, scope, proof, undefined, sessionId, true);
  }
  private grantDto(a: Authority, g: GrantRow): AuthImportGrant {
    return {
      ...binding(a.session!),
      grantId: g.id,
      authStateId: g.auth_state_id,
      kind: 'import_auth_state',
      deadline: g.deadline.toISOString(),
    };
  }
  private async grant(
    client: PoolClient,
    a: Authority,
    grantId: string,
  ): Promise<GrantRow> {
    uuid(grantId);
    const g = (
      await client.query<GrantRow>(
        'SELECT * FROM auth_import_grants WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [grantId, a.run.projectId],
      )
    ).rows[0];
    const s = a.session!;
    if (
      !g ||
      g.auth_session_id !== s.id ||
      g.run_id !== s.run_id ||
      g.task_id !== s.task_id
    )
      throw new StorageError('NOT_FOUND');
    if (
      g.auth_state_id !== a.stateId ||
      g.state_fingerprint !== a.stateFingerprint ||
      g.worker_id !== s.worker_id ||
      g.fencing_token !== s.fencing_token ||
      g.context_version !== s.context_version ||
      g.context_id !== s.context_id ||
      g.auth_profile_id !== s.auth_profile_id ||
      g.auth_profile_version !== s.auth_profile_version ||
      g.auth_epoch !== s.auth_epoch
    )
      throw new StorageError('AUTH_FAILED');
    const intent = (
      await client.query<{
        project_id: string;
        run_id: string;
        task_id: string;
        auth_session_id: string;
        auth_epoch: number;
        fencing_token: string;
        context_version: number;
        execution_state: string;
        outcome: string;
        result_hash: string | null;
        tool_call: unknown;
      }>('SELECT * FROM action_intents WHERE id=$1 FOR UPDATE', [g.id])
    ).rows[0];
    const expectedExecution =
      g.status === 'completed'
        ? 'completed'
        : g.status === 'started'
          ? 'started'
          : 'issued';
    if (
      !intent ||
      intent.project_id !== g.project_id ||
      intent.run_id !== g.run_id ||
      intent.task_id !== g.task_id ||
      intent.auth_session_id !== s.id ||
      intent.auth_epoch !== s.auth_epoch ||
      intent.fencing_token !== s.fencing_token ||
      intent.context_version !== s.context_version ||
      intent.execution_state !== expectedExecution ||
      hashPayload(intent.tool_call) !==
        hashPayload({ name: 'prepare_auth_state', args: {} }) ||
      (g.status === 'completed'
        ? intent.result_hash !== g.result_hash ||
          g.result_hash !== hashPayload({ status: intent.outcome })
        : intent.outcome !== 'pending')
    )
      throw new StorageError('AUTH_FAILED');
    return g;
  }
  async grantImport(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<AuthImportGrant> {
    const a = await this.authority(client, scope, proof, undefined, sessionId);
    const existing = (
      await client.query<{ id: string }>(
        'SELECT id FROM auth_import_grants WHERE auth_session_id=$1',
        [sessionId],
      )
    ).rows[0];
    if (existing) {
      const g = await this.grant(client, a, existing.id);
      if (g.status !== 'issued') throw new StorageError('VERSION_CONFLICT');
      await this.live(client, proof, a, g);
      return this.grantDto(a, g);
    }
    const count = (
      await client.query<{ n: number }>(
        'SELECT count(*)::integer n FROM action_intents WHERE project_id=$1 AND task_id=$2',
        [scope.projectId, proof.taskId],
      )
    ).rows[0]!.n;
    if (
      a.job.case_id &&
      count >= a.run.effectiveConfig.budget.maxActionsPerCase
    )
      throw new StorageError('BUDGET_EXCEEDED');
    const reservation = await this.coordinator.reserve(
      client,
      scope,
      proof,
      'action',
      { actions: 1 },
    );
    const deadline = await this.live(client, proof, a);
    const id = randomUUID();
    await client.query(
      `INSERT INTO action_intents(id,project_id,run_id,task_id,fencing_token,context_version,reservation_id,
      tool_call,outcome,auth_session_id,auth_epoch,execution_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,'issued')`,
      [
        id,
        scope.projectId,
        a.run.id,
        proof.taskId,
        proof.fencingToken,
        proof.contextVersion,
        reservation.id,
        { name: 'prepare_auth_state', args: {} },
        sessionId,
        a.session!.auth_epoch,
      ],
    );
    const seq = (
      await client.query<{ n: number }>(
        'SELECT COALESCE(max(seq),0)+1 n FROM steps WHERE project_id=$1 AND task_id=$2',
        [scope.projectId, proof.taskId],
      )
    ).rows[0]!.n;
    const step = parseContract('Step', {
      id: randomUUID(),
      runId: a.run.id,
      taskId: proof.taskId,
      caseId: a.job.case_id,
      seq,
      toolName: 'prepare_auth_state',
      status: 'running',
      summary: 'Private auth import reserved',
      targetDescription: 'Protected state import',
      evidenceRefs: [],
      createdAt: new Date().toISOString(),
      finishedAt: null,
    });
    await client.query(
      'INSERT INTO steps(id,project_id,run_id,task_id,case_id,action_id,seq,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        step.id,
        scope.projectId,
        a.run.id,
        proof.taskId,
        a.job.case_id,
        id,
        seq,
        step,
      ],
    );
    const g = (
      await client.query<GrantRow>(
        `INSERT INTO auth_import_grants(id,project_id,run_id,task_id,auth_session_id,auth_state_id,
      worker_id,fencing_token,context_version,context_id,auth_profile_id,auth_profile_version,auth_epoch,status,deadline,state_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'issued',$14,$15) RETURNING *`,
        [
          id,
          scope.projectId,
          a.run.id,
          proof.taskId,
          sessionId,
          a.stateId,
          scope.workerId,
          proof.fencingToken,
          proof.contextVersion,
          a.session!.context_id,
          a.profile.id,
          a.profile.version,
          a.session!.auth_epoch,
          deadline,
          a.stateFingerprint,
        ],
      )
    ).rows[0]!;
    await this.live(client, proof, a, g);
    return this.grantDto(a, g);
  }
  async prepare(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
  ): Promise<{ grant: AuthImportGrant; state: ApprovedAuthState }> {
    const a = await this.authority(client, scope, proof, undefined, sessionId);
    const g = await this.grant(client, a, grantId);
    if (g.status !== 'issued') throw new StorageError('VERSION_CONFLICT');
    await this.live(client, proof, a, g);
    const changed = await client.query(
      "UPDATE auth_import_grants SET status='prepared',prepared_at=clock_timestamp() WHERE id=$1 AND status='issued' RETURNING id",
      [grantId],
    );
    if (changed.rowCount !== 1) throw new StorageError('VERSION_CONFLICT');
    const state = await this.coordinator.authStateService.importState(
      client,
      this.stateAuthority(a),
      true,
    );
    await this.live(client, proof, a, g);
    if (!state || typeof state === 'string')
      throw new StorageError('AUTH_FAILED');
    return { grant: this.grantDto(a, g), state };
  }
  async begin(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
  ): Promise<AuthImportReceipt> {
    const a = await this.authority(client, scope, proof, undefined, sessionId);
    const g = await this.grant(client, a, grantId);
    if (g.status !== 'prepared') throw new StorageError('VERSION_CONFLICT');
    await this.live(client, proof, a, g);
    const now = (
      await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now;
    const receipt = {
      grantId,
      executionId: randomBytes(32).toString('hex'),
      startedAt: now.toISOString(),
    };
    const changed = await client.query(
      "UPDATE auth_import_grants SET status='started',receipt_hash=$2,started_at=$3 WHERE id=$1 AND status='prepared' RETURNING id",
      [grantId, hashPayload(receipt), now],
    );
    if (changed.rowCount !== 1) throw new StorageError('VERSION_CONFLICT');
    await client.query(
      "UPDATE action_intents SET execution_state='started',started_at=$2 WHERE id=$1",
      [grantId, now],
    );
    await this.live(client, proof, a, g);
    return receipt;
  }
  async record(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    receipt: AuthImportReceipt,
    outcome: AuthImportOutcome,
  ): Promise<void> {
    if (
      !outcome ||
      Object.keys(outcome).some((k) => k !== 'status') ||
      !['succeeded', 'failed', 'unknown', 'cancelled'].includes(outcome.status)
    )
      throw new StorageError('VALIDATION_ERROR');
    const a = await this.authority(client, scope, proof, undefined, sessionId);
    const g = await this.grant(client, a, grantId);
    if (
      !receipt ||
      receipt.grantId !== grantId ||
      !g.receipt_hash ||
      hashPayload(receipt) !== g.receipt_hash
    )
      throw new StorageError('FORBIDDEN');
    await this.live(client, proof, a, g);
    const resultHash = hashPayload(outcome);
    if (g.status === 'completed') {
      if (g.result_hash !== resultHash)
        throw new StorageError('IDEMPOTENCY_CONFLICT');
      return;
    }
    if (g.status !== 'started') throw new StorageError('VALIDATION_ERROR');
    await this.complete(client, scope, proof, g, outcome.status, resultHash);
    await this.live(client, proof, a, g);
  }
  private async complete(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    g: GrantRow,
    status: AuthImportOutcome['status'],
    resultHash: string,
  ): Promise<void> {
    const intent = (
      await client.query<{ reservation_id: string }>(
        'SELECT reservation_id FROM action_intents WHERE id=$1 AND auth_session_id=$2 FOR UPDATE',
        [g.id, g.auth_session_id],
      )
    ).rows[0];
    if (!intent) throw new StorageError('AUTH_FAILED');
    await this.coordinator.settleIn(
      client,
      scope,
      proof,
      intent.reservation_id,
      { actions: 1 },
      status === 'unknown' ? 'unknown' : 'reported',
    );
    await client.query(
      "UPDATE action_intents SET execution_state='completed',outcome=$2,result_hash=$3 WHERE id=$1",
      [g.id, status, resultHash],
    );
    await client.query(
      "UPDATE auth_import_grants SET status='completed',result_hash=$2,completed_at=clock_timestamp() WHERE id=$1",
      [g.id, resultHash],
    );
    const row = (
      await client.query<{ id: string; document: Step }>(
        'SELECT id,document FROM steps WHERE action_id=$1 FOR UPDATE',
        [g.id],
      )
    ).rows[0];
    if (!row) throw new StorageError('AUTH_FAILED');
    const step = parseContract('Step', {
      ...row.document,
      status,
      summary: `Private auth import ${status}`,
      finishedAt: new Date().toISOString(),
    });
    await client.query('UPDATE steps SET document=$2 WHERE id=$1', [
      row.id,
      step,
    ]);
    await appendEvent(client, scope.projectId, g.run_id, 'step.recorded', step);
  }
  /** End only this importer attempt. Lost receipts charge unknown, never replay. */
  async endAttempt(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<void> {
    const a = await this.authority(
      client,
      scope,
      proof,
      undefined,
      sessionId,
      true,
    );
    const row = (
      await client.query<{ id: string }>(
        'SELECT id FROM auth_import_grants WHERE auth_session_id=$1',
        [sessionId],
      )
    ).rows[0];
    if (row) {
      const g = await this.grant(client, a, row.id);
      if (!['completed', 'ended'].includes(g.status)) {
        await this.complete(
          client,
          scope,
          proof,
          g,
          'unknown',
          hashPayload({ status: 'unknown' }),
        );
      }
    }
    await this.live(client, proof, a);
  }
  async endTask(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
  ): Promise<Date | undefined> {
    const sessions = (
      await client.query<{ id: string }>(
        "SELECT id FROM auth_execution_sessions WHERE project_id=$1 AND task_id=$2 AND purpose='importer' AND status IN ('allocated','active')",
        [scope.projectId, proof.taskId],
      )
    ).rows;
    let deadline: Date | undefined;
    for (const s of sessions) {
      const a = await this.authority(
        client,
        scope,
        proof,
        undefined,
        s.id,
        true,
      );
      const row = (
        await client.query<{ id: string }>(
          'SELECT id FROM auth_import_grants WHERE auth_session_id=$1',
          [s.id],
        )
      ).rows[0];
      if (!row) throw new StorageError('POLICY_DENIED');
      const g = await this.grant(client, a, row.id);
      if (
        g.status !== 'completed' ||
        g.result_hash !== hashPayload({ status: 'succeeded' })
      )
        throw new StorageError('POLICY_DENIED');
      const limit = await this.live(client, proof, a, g);
      deadline = !deadline || limit < deadline ? limit : deadline;
      await client.query(
        "UPDATE auth_execution_sessions SET status='ended',ended_at=clock_timestamp(),end_reason='task_finished' WHERE id=$1",
        [s.id],
      );
    }
    return deadline;
  }
}
