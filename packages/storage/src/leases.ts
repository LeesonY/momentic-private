import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseContract } from '@localqa/contracts';
import type {
  Lease,
  Task,
  HeartbeatResult,
  TaskComplete,
  Verdict,
  CredentialMaterial,
} from '@localqa/contracts';
import {
  Database,
  StorageError,
  type Actor,
  requireAdmin,
} from './database.js';
import type { WorkerScope } from './database.js';
import { newToken, hashToken, hashPayload, SecretVault } from './crypto.js';
import { appendEvent } from './repositories.js';

export type LeaseProof = {
  taskId: string;
  fencingToken: number;
  leaseToken: string;
  contextVersion: number;
};
/** Close public OTP prompts when trusted recovery invalidates private state. */
export async function reconcileExpiredOtpInputs(
  client: PoolClient,
  projectId: string,
  runId: string,
  taskId: string,
): Promise<void> {
  const expired = await client.query<{ document: unknown }>(
    `UPDATE input_requests i
       SET document=jsonb_set(
         jsonb_set(i.document,'{status}',to_jsonb('expired'::text)),
         '{version}',to_jsonb(i.version+1)),
         version=i.version+1
       FROM auth_otp_challenges c
       WHERE c.input_id=i.id AND c.project_id=$1 AND c.run_id=$2
         AND c.task_id=$3 AND c.status='expired'
         AND i.document->>'kind'='one_time_code'
         AND i.document->>'status'='pending'
       RETURNING i.document`,
    [projectId, runId, taskId],
  );
  for (const row of expired.rows)
    await appendEvent(
      client,
      projectId,
      runId,
      'input.resolved',
      parseContract('InputRequest', row.document),
    );
}
type JobRow = {
  id: string;
  project_id: string;
  run_id: string;
  worker_id: string | null;
  lease_until: Date | null;
  fencing_token: string;
  status: Task['status'];
  document: Task;
  context_version: number;
  run_status: string;
  run_termination_reason?: string | null;
  started_at?: Date | null;
  finished_at?: Date | null;
  lease_active?: boolean;
};
const dto = (row: JobRow): Task => {
  const started = row.started_at ? new Date(row.started_at).getTime() : null;
  const ended = row.finished_at
    ? new Date(row.finished_at).getTime()
    : Date.now();
  return parseContract('Task', {
    ...row.document,
    status: row.status,
    elapsedSeconds:
      started !== null && Number.isFinite(started) && ended >= started
        ? Math.max(1, Math.ceil((ended - started) / 1000))
        : 0,
  });
};
function duration(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 45)
    throw new StorageError('VALIDATION_ERROR');
}
export async function claimTask(
  client: PoolClient,
  scope: WorkerScope,
  leaseSeconds = 45,
  admission?: { children: boolean; control: boolean },
): Promise<Lease | null> {
  duration(leaseSeconds);
  // Run lock serializes a claim with cancellation/archive transitions, while two
  // claimants retain compatible share locks and SKIP LOCKED the same task row.
  const row = (
    await client.query<JobRow>(
      `SELECT j.*,r.context_version,r.status run_status FROM jobs j JOIN runs r ON r.id=j.run_id
       JOIN projects p ON p.id=j.project_id AND p.deleted_at IS NULL
       WHERE j.project_id=$1 AND j.status='queued' AND j.available_at<=clock_timestamp() AND r.status IN ('queued','running')
       AND COALESCE(r.termination_reason,'') <> 'budget_limit'
       AND NOT EXISTS (SELECT 1 FROM run_budgets cutoff WHERE cutoff.run_id=r.id
         AND (cutoff.used->>'activeSeconds')::integer >= (cutoff.limits->>'maxActiveSeconds')::integer)
       -- Do not promote this run across other runs' FIFO positions. Merely
       -- withhold its queued executors/explorers until its reproducer claims.
       -- This is also the exclusive-account waiting queue: blocked account
       -- users stay queued below, so the same local priority applies there.
       AND (j.role NOT IN ('executor','explorer') OR NOT EXISTS (
         SELECT 1 FROM jobs priority
         WHERE priority.project_id=j.project_id AND priority.run_id=j.run_id
           AND priority.role='reproducer' AND priority.document->>'summary'='reproduce'
           AND priority.status='queued'
           AND priority.available_at<=clock_timestamp()
       ))
       ${
         admission
           ? `AND (($2::boolean AND j.role IN ('coordinator','finalizer')) OR ($3::boolean AND j.role NOT IN ('coordinator','finalizer')))
        AND (j.role IN ('coordinator','finalizer') OR
          (SELECT count(*) FROM budget_reservations b JOIN jobs occupied ON occupied.id=b.task_id
           WHERE b.run_id=r.id AND b.kind='concurrency' AND b.status='reserved' AND occupied.status='running' AND occupied.role NOT IN ('coordinator','finalizer'))
          < (r.effective_config->'budget'->>'concurrency')::integer)
        AND (j.role NOT IN ('coordinator','finalizer') OR NOT EXISTS(
          SELECT 1 FROM budget_reservations b JOIN jobs occupied ON occupied.id=b.task_id
          WHERE b.run_id=r.id AND b.kind='concurrency' AND b.status='reserved' AND occupied.status='running' AND occupied.role IN ('coordinator','finalizer')))`
           : ''
       }
       AND NOT (
         -- Serial claim for session tasks using an exclusive sign-in credential:
         -- leave queued if another self-signing task on this account is running.
         -- A session explorer signs in as well, so it takes part in the same
         -- queue; an explorer enqueued as a signed-out target does not.
         r.execution_mode = 'smoke'
         AND (
           (j.role IN ('executor', 'reproducer')
             AND j.document->>'summary' IN ('execute', 'reproduce')
             AND COALESCE((SELECT c.document->>'requiresLogin' FROM run_cases c WHERE c.project_id = j.project_id AND c.run_id = j.run_id AND c.id = j.case_id), 'true') <> 'false')
           OR (j.role = 'explorer' AND j.document->>'summary' = 'explore'
             AND COALESCE(j.result->>'signedOut', 'false') <> 'true')
         )
         AND EXISTS(SELECT 1 FROM run_sessions s WHERE s.project_id = r.project_id AND s.run_id = r.id)
         AND r.auth_profile_id IS NOT NULL
         AND (
           SELECT v.document->>'sharingPolicy'
           FROM auth_profiles p
           JOIN auth_profile_versions v ON v.project_id = p.project_id AND v.auth_profile_id = p.id AND v.version = p.version
           WHERE p.project_id = r.project_id AND p.id = r.auth_profile_id AND p.deleted_at IS NULL AND NOT p.revoked
         ) = 'exclusive_run'
         AND EXISTS(
           SELECT 1
           FROM jobs other_j
           JOIN runs other_r ON other_r.project_id = other_j.project_id AND other_r.id = other_j.run_id
           WHERE other_j.status = 'running'
             AND (
               (other_j.role IN ('executor', 'reproducer')
                 AND other_j.document->>'summary' IN ('execute', 'reproduce')
                 AND COALESCE((SELECT other_c.document->>'requiresLogin' FROM run_cases other_c WHERE other_c.project_id = other_j.project_id AND other_c.run_id = other_j.run_id AND other_c.id = other_j.case_id), 'true') <> 'false')
               OR (other_j.role = 'explorer' AND other_j.document->>'summary' = 'explore'
                 AND COALESCE(other_j.result->>'signedOut', 'false') <> 'true')
             )
             AND other_r.execution_mode = 'smoke'
             AND other_r.auth_profile_id = r.auth_profile_id
             AND EXISTS(SELECT 1 FROM run_sessions other_s WHERE other_s.project_id = other_r.project_id AND other_s.run_id = other_r.id)
         )
       )
       ORDER BY CASE WHEN j.role IN ('coordinator','finalizer') THEN 0 ELSE 1 END,j.available_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
      admission
        ? [scope.projectId, admission.control, admission.children]
        : [scope.projectId],
    )
  ).rows[0];
  if (!row) return null;
  const run = (
    await client.query<{ context_version: number; status: string }>(
      'SELECT context_version,status FROM runs WHERE project_id=$1 AND id=$2 FOR SHARE',
      [scope.projectId, row.run_id],
    )
  ).rows[0];
  if (!run || !['queued', 'running'].includes(run.status)) return null;
  const updated = (
    await client.query<JobRow>(
      `UPDATE jobs SET status='running',started_at=COALESCE(started_at,clock_timestamp()),finished_at=NULL,worker_id=$2,lease_until=clock_timestamp()+$3::integer*interval '1 second',fencing_token=fencing_token+1 WHERE id=$1 AND status='queued' RETURNING *`,
      [row.id, scope.workerId, leaseSeconds],
    )
  ).rows[0]!;
  const token = newToken();
  await client.query(
    'INSERT INTO task_leases(id,project_id,task_id,worker_id,fencing_token,token_hash,lease_until) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      randomUUID(),
      scope.projectId,
      row.id,
      scope.workerId,
      updated.fencing_token,
      hashToken(token),
      updated.lease_until,
    ],
  );
  return parseContract('Lease', {
    task: dto(updated),
    fencingToken: Number(updated.fencing_token),
    leaseToken: token,
    leaseUntil: updated.lease_until!.toISOString(),
    contextVersion: run.context_version,
  });
}
async function currentLease(
  client: PoolClient,
  scope: WorkerScope,
  proof: LeaseProof,
  heartbeat = false,
): Promise<JobRow> {
  const row = (
    await client.query<JobRow>(
      `SELECT j.*,r.context_version,r.status run_status,(j.lease_until IS NOT NULL AND l.lease_until IS NOT NULL AND j.lease_until>clock_timestamp() AND l.lease_until>clock_timestamp()) AS lease_active FROM jobs j JOIN runs r ON r.id=j.run_id JOIN task_leases l ON l.task_id=j.id AND l.fencing_token=j.fencing_token WHERE j.project_id=$1 AND j.id=$2 AND j.worker_id=$3 AND j.fencing_token=$4 AND j.status='running' AND l.released_at IS NULL AND l.token_hash=$5 FOR UPDATE OF j,l`,
      [
        scope.projectId,
        proof.taskId,
        scope.workerId,
        proof.fencingToken,
        hashToken(proof.leaseToken),
      ],
    )
  ).rows[0];
  if (!row) throw new StorageError('LEASE_EXPIRED');
  const run = (
    await client.query<{ context_version: number; status: string }>(
      'SELECT context_version,status FROM runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
      [scope.projectId, row.run_id],
    )
  ).rows[0];
  if (!run) throw new StorageError('LEASE_EXPIRED');
  row.context_version = run.context_version;
  row.run_status = run.status;
  // lease_until is compared with the database clock. A still-valid lease whose
  // run context or status no longer matches is scope change, not expiry.
  if (row.lease_until == null || row.lease_active !== true)
    throw new StorageError('LEASE_EXPIRED');
  if (
    !heartbeat &&
    (row.context_version !== proof.contextVersion ||
      row.run_status !== 'running')
  )
    throw new StorageError('SCOPE_CHANGED');
  return row;
}
export class LeaseRepository {
  constructor(
    private readonly db: Database,
    private readonly serviceActor?: Actor,
  ) {}
  claim(scope: WorkerScope, seconds = 45): Promise<Lease | null> {
    return this.db.worker(scope, (client) => claimTask(client, scope, seconds));
  }
  heartbeat(
    scope: WorkerScope,
    proof: LeaseProof,
    seconds = 45,
  ): Promise<HeartbeatResult> {
    duration(seconds);
    return this.db.worker(scope, async (client) => {
      const job = await currentLease(client, scope, proof, true);
      const result = await client.query<{ lease_until: Date }>(
        `UPDATE jobs SET lease_until=clock_timestamp()+$2::integer*interval '1 second' WHERE id=$1 RETURNING lease_until`,
        [job.id, seconds],
      );
      await client.query(
        'UPDATE task_leases SET lease_until=$3 WHERE task_id=$1 AND fencing_token=$2 AND released_at IS NULL',
        [job.id, proof.fencingToken, result.rows[0]!.lease_until],
      );
      return parseContract('HeartbeatResult', {
        leaseUntil: result.rows[0]!.lease_until.toISOString(),
        cancelRequested: !['queued', 'running'].includes(job.run_status),
        contextVersion: job.context_version,
      });
    });
  }
  complete(
    scope: WorkerScope,
    proof: LeaseProof,
    input: TaskComplete,
  ): Promise<Task> {
    const data = parseContract('TaskComplete', input);
    if (data.fencingToken !== proof.fencingToken)
      throw new StorageError('LEASE_EXPIRED');
    return this.db.worker(scope, async (client) => {
      const candidate = (
        await client.query<JobRow & { result_hash: string }>(
          'SELECT j.*,r.context_version,r.status run_status FROM jobs j JOIN runs r ON r.id=j.run_id JOIN task_leases l ON l.task_id=j.id AND l.fencing_token=j.fencing_token WHERE j.id=$1 AND j.project_id=$2 AND j.worker_id=$3 AND j.fencing_token=$4 AND l.token_hash=$5 FOR UPDATE OF j',
          [
            proof.taskId,
            scope.projectId,
            scope.workerId,
            proof.fencingToken,
            hashToken(proof.leaseToken),
          ],
        )
      ).rows[0];
      if (!candidate) throw new StorageError('LEASE_EXPIRED');
      if (
        ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(
          candidate.status,
        )
      ) {
        if (
          candidate.status !== data.status ||
          candidate.result_hash !== data.resultHash ||
          hashPayload(data.result) !== data.resultHash
        )
          throw new StorageError('IDEMPOTENCY_CONFLICT');
        return dto(candidate);
      }
      const job = await currentLease(client, scope, proof);
      if (hashPayload(data.result) !== data.resultHash)
        throw new StorageError('VALIDATION_ERROR');
      // Structured role-specific result validation/atomic verdict submission is T05.
      const updated = (
        await client.query<JobRow>(
          'UPDATE jobs SET status=$2,result_hash=$3,result=$4,finished_at=clock_timestamp() WHERE id=$1 RETURNING *',
          [job.id, data.status, data.resultHash, data.result],
        )
      ).rows[0]!;
      await client.query(
        'UPDATE task_leases SET released_at=clock_timestamp() WHERE task_id=$1 AND fencing_token=$2',
        [job.id, proof.fencingToken],
      );
      await appendEvent(
        client,
        scope.projectId,
        job.run_id,
        'task.updated',
        dto(updated),
      );
      return dto(updated);
    });
  }
  submitVerdict(
    scope: WorkerScope,
    proof: LeaseProof,
    input: Verdict,
    payloadHash = hashPayload(input),
  ): Promise<Verdict> {
    const verdict = parseContract('Verdict', input);
    return this.db.worker(scope, async (client) => {
      const job = await currentLease(client, scope, proof);
      const attempt = (
        await client.query<{ task_id: string; case_id: string }>(
          'SELECT task_id,case_id FROM case_attempts WHERE project_id=$1 AND id=$2',
          [scope.projectId, verdict.attemptId],
        )
      ).rows[0];
      if (
        !attempt ||
        attempt.task_id !== job.id ||
        attempt.case_id !== verdict.caseId
      )
        throw new StorageError('NOT_FOUND');
      const previous = (
        await client.query<{ document: Verdict; payload_hash: string }>(
          'SELECT document,payload_hash FROM verdicts WHERE project_id=$1 AND attempt_id=$2',
          [scope.projectId, verdict.attemptId],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.payload_hash !== payloadHash ||
          hashPayload(verdict) !== payloadHash
        )
          throw new StorageError('IDEMPOTENCY_CONFLICT');
        return parseContract('Verdict', previous.document);
      }
      if (hashPayload(verdict) !== payloadHash)
        throw new StorageError('VALIDATION_ERROR');
      await client.query(
        'INSERT INTO verdicts(id,project_id,case_id,attempt_id,document,payload_hash,fencing_token) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          verdict.id,
          scope.projectId,
          verdict.caseId,
          verdict.attemptId,
          verdict,
          payloadHash,
          proof.fencingToken,
        ],
      );
      return verdict;
    });
  }
  recoverExpired(
    scope: WorkerScope,
  ): Promise<{ requeued: number; interrupted: number }> {
    const runWork = (client: PoolClient, isAdmin: boolean) =>
      this.#recoverExpiredIn(client, scope, isAdmin);
    if (this.serviceActor) {
      return this.db.actor(this.serviceActor, async (client) => {
        await requireAdmin(client);
        return runWork(client, true);
      });
    }
    return this.db.worker(scope, (client) => runWork(client, false));
  }

  async #recoverExpiredIn(
    client: PoolClient,
    scope: WorkerScope,
    isAdmin: boolean,
  ): Promise<{ requeued: number; interrupted: number }> {
    const rows = await client.query<JobRow>(
      "SELECT j.*,r.context_version,r.status run_status,r.termination_reason AS run_termination_reason FROM jobs j JOIN runs r ON r.id=j.run_id WHERE j.project_id=$1 AND j.status='running' AND j.lease_until<=clock_timestamp() FOR UPDATE OF j SKIP LOCKED",
      [scope.projectId],
    );
    let requeued = 0,
      interrupted = 0;
    for (const job of rows.rows) {
      const isAuthTask = job.document?.summary === 'auth';
      const acted = Boolean(
        (
          await client.query(
            'SELECT 1 FROM action_intents WHERE project_id=$1 AND task_id=$2 LIMIT 1',
            [scope.projectId, job.id],
          )
        ).rowCount,
      );
      const canRetry =
        !isAuthTask && !acted && job.run_termination_reason !== 'budget_limit' &&
        ['queued', 'running'].includes(job.run_status);
      await client.query(
        "UPDATE jobs SET status=$2,worker_id=NULL,lease_until=NULL,started_at=CASE WHEN $2='queued' THEN NULL ELSE started_at END,finished_at=CASE WHEN $2='queued' THEN NULL ELSE clock_timestamp() END WHERE id=$1",
        [job.id, canRetry ? 'queued' : 'interrupted'],
      );
      await client.query(
        "UPDATE action_intents SET outcome='unknown', execution_state='completed' WHERE task_id=$1 AND project_id=$2 AND outcome='pending'",
        [job.id, scope.projectId],
      );
      if (isAdmin) {
        await client.query(
          `UPDATE auth_otp_challenges SET status='expired',
           ciphertext=NULL,nonce=NULL,auth_tag=NULL,key_version=NULL
           WHERE task_id=$1 AND project_id=$2 AND status IN ('pending','submitted')`,
          [job.id, scope.projectId],
        );
        await reconcileExpiredOtpInputs(
          client,
          scope.projectId,
          job.run_id,
          job.id,
        );
        await client.query(
          "UPDATE auth_execution_sessions SET status='ended', ended_at=clock_timestamp(), end_reason='interrupted' WHERE task_id=$1 AND project_id=$2 AND status IN ('allocated','active')",
          [job.id, scope.projectId],
        );
        await client.query(
          "UPDATE auth_profile_run_locks SET status='released', released_at=clock_timestamp(), release_reason='interrupted' WHERE run_id=$1 AND phase='initializing' AND status='held'",
          [job.run_id],
        );
      }
      await client.query(
        "UPDATE case_attempts SET status='interrupted',finished_at=clock_timestamp() WHERE project_id=$1 AND task_id=$2 AND status IN ('queued','running')",
        [scope.projectId, job.id],
      );
      // Unknown model/action reservations are charged conservatively, not released as zero.
      const reservations = await client.query<{
        id: string;
        run_id: string;
        reserved: Record<string, number>;
      }>(
        "SELECT id,run_id,reserved FROM budget_reservations WHERE project_id=$1 AND task_id=$2 AND status='reserved' FOR UPDATE",
        [scope.projectId, job.id],
      );
      for (const reservation of reservations.rows) {
        const budget = (
          await client.query<{
            used: Record<string, number>;
            reserved: Record<string, number>;
          }>(
            'SELECT used,reserved FROM run_budgets WHERE run_id=$1 FOR UPDATE',
            [reservation.run_id],
          )
        ).rows[0]!;
        for (const [key, value] of Object.entries(reservation.reserved)) {
          budget.used[key] = (budget.used[key] ?? 0) + value;
          budget.reserved[key] = Math.max(
            0,
            (budget.reserved[key] ?? 0) - value,
          );
        }
        await client.query(
          'UPDATE run_budgets SET used=$2,reserved=$3 WHERE run_id=$1',
          [reservation.run_id, budget.used, budget.reserved],
        );
        await client.query(
          "UPDATE budget_reservations SET status='unknown',charged=reserved WHERE id=$1",
          [reservation.id],
        );
      }
      await client.query(
        'UPDATE task_leases SET released_at=clock_timestamp() WHERE task_id=$1 AND fencing_token=$2',
        [job.id, job.fencing_token],
      );
      await client.query(
        "INSERT INTO audit_log(project_id,actor_id,action,object_id,result) VALUES($1,actor_id(),'lease.expired',$2,$3)",
        [scope.projectId, job.id, canRetry ? 'requeued' : 'interrupted'],
      );
      if (canRetry) requeued++;
      else interrupted++;
    }
    return { requeued, interrupted };
  }
  async resolveAuth(
    scope: WorkerScope,
    proof: LeaseProof,
    authProfileId: string,
    authProfileVersion: number,
    vault: SecretVault,
  ): Promise<CredentialMaterial> {
    return this.db.worker(scope, async (client) => {
      const job = await currentLease(client, scope, proof);
      const row = (
        await client.query<{
          document: { mode: CredentialMaterial['mode'] };
          secret_id: string | null;
          secret_version: number | null;
        }>(
          'SELECT v.document,v.secret_id,v.secret_version FROM auth_profiles p JOIN auth_profile_versions v ON v.auth_profile_id=p.id AND v.project_id=p.project_id JOIN runs r ON r.auth_profile_id=p.id AND r.auth_profile_version=v.version WHERE p.project_id=$1 AND p.id=$2 AND v.version=$3 AND r.id=$4 AND NOT p.revoked',
          [scope.projectId, authProfileId, authProfileVersion, job.run_id],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      let material = {};
      // An approved anonymous policy needs no credentials, including unused
      // secrets attached to a historical none profile.
      if (row.document.mode !== 'none' && row.secret_id) {
        const secret = (
          await client.query<{
            ciphertext: Buffer;
            nonce: Buffer;
            auth_tag: Buffer;
            key_version: number;
            purpose: string;
          }>(
            'SELECT v.ciphertext,v.nonce,v.auth_tag,v.key_version,s.purpose FROM secret_versions v JOIN secrets s ON s.id=v.secret_id AND s.project_id=v.project_id WHERE v.project_id=$1 AND v.secret_id=$2 AND v.version=$3 AND NOT s.revoked',
            [scope.projectId, row.secret_id, row.secret_version],
          )
        ).rows[0];
        if (!secret) throw new StorageError('AUTH_FAILED');
        material = JSON.parse(
          vault.decrypt(
            {
              ciphertext: secret.ciphertext,
              nonce: secret.nonce,
              authTag: secret.auth_tag,
              keyVersion: secret.key_version,
            },
            {
              projectId: scope.projectId,
              secretId: row.secret_id,
              purpose: secret.purpose,
            },
          ),
        );
      }
      return parseContract('CredentialMaterial', {
        mode: row.document.mode,
        material,
        expiresAt: job.lease_until!.toISOString(),
      });
    });
  }
}
