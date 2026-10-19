import { sanitizeText } from '@localqa/browser';
import { createHash, randomUUID } from 'node:crypto';
import { SessionAgent, type SessionContext } from './session-agent.js';
import { parseSessionDecision } from './session-planning.js';
import { linkMergedFindingEvidence } from './session-findings.js';
import { parseAgentReport, verdictFromReport } from './agent-report.js';
import { graceDeadline, graceEligibleRun, REPRODUCTION_BUDGET_GRACE_SECONDS } from './reproduction-grace.js';
import { cleanDecisionNote } from './decision-note.js';
import { reproductionRecordingIn } from './reproduction-recording-store.js';
import { settledStep } from './step-settlement.js';
import { actionDenied, evaluateTargetGrant } from './action-grant.js';
import { createRegressionPlan } from './regression-plan.js';
import { AuthStateService, type AuthStateRef } from './auth-state-service.js';
import { AuthOtpService } from './auth-otp.js';
import { readRunAuthProfile, readSavedAuthValues } from './auth-profile.js';
import { inputValueOf, matchesSavedCredential } from './signed-out-input.js';
import {
  AuthImportService,
  type AuthImportGrant,
  type AuthImportReceipt,
  type AuthImportOutcome,
} from './auth-import-service.js';
import {
  AuthExecutionManager,
  signInKind,
  type AuthSessionBinding,
} from './auth-execution.js';
import {
  AuthActionsManager,
  type AuthActionRequest,
  type AuthPermit,
  type AuthExecutionReceipt,
  type AuthActionOutcome,
} from './auth-actions.js';
import type { PoolClient } from 'pg';
import {
  isActionDenialCode,
  parseContract,
  type Run,
  type RunConfig,
  type RunCreate,
  type Task,
  type Lease,
  type BudgetUsed,
  type BudgetLimits,
  type CaseDefinition,
  type Finding,
  type Artifact,
  type BrowserSnapshot,
  type Step,
  type ToolCall,
  type CriterionResult,
  type InputRequest,
  type AuthProfile,
  type ActionResult,
  type CredentialMaterial,
  type TaskRecording,
} from '@localqa/contracts';
import {
  Database,
  StorageError,
  authorize,
  requireAdmin,
  audit,
  runDTO,
  appendEvent,
  hashToken,
  hashPayload,
  reconcileExpiredOtpInputs,
  SecretVault,
  claimTask,
  LeaseRepository,
  type Actor,
  type WorkerScope,
  type LeaseProof,
} from '@localqa/storage';
import {
  DomainError,
  EMPTY_USED,
  TERMINAL,
  transition,
  completion,
  reserve,
  displayUrl,
  validateTarget,
  validateBrowserTool,
  taskKey,
  criteriaHash,
  smokeCase,
  verdictStatus,
  type Counters,
} from '@localqa/domain';

export type Stage =
  | 'preflight'
  | 'auth'
  | 'explore'
  | 'plan'
  | 'execute'
  | 'reproduce'
  | 'finalize'
  | 'recover';
export interface JobRow {
  id: string;
  project_id: string;
  run_id: string;
  case_id: string | null;
  role: Task['role'];
  status: Task['status'];
  document: Task;
  fencing_token: string;
  context_version: number;
  worker_id: string | null;
  lease_until: Date | null;
  result: Record<string, unknown> | null;
  result_hash: string | null;
}
type StoppedRecordingJobRow = JobRow & {
  finished_at: Date | null;
  run_status: Run['status'];
  run_termination_reason: Run['terminationReason'];
};
/** Bytes are written by ArtifactStore before this metadata transaction. */
export interface StoppedRecordingArtifact {
  artifact: Artifact;
  bytes: Uint8Array;
}
export interface Work {
  run: Run;
  task: Task;
  stage: Stage;
  targetUrl: string;
  /** TLS trust comes only from the run's frozen environment version. */
  tlsPolicy: 'strict' | 'allow_self_signed';
  contextId: string;
  /** Server-verified current auth state, never supplied by a model or caller. */
  authStateId: string | null;
  attemptId: string | null;
  definition: CaseDefinition | null;
  regressionPlan?: ReturnType<typeof createRegressionPlan>;
  findingId: string | null;
  /** For a reproducer: the suspected bug it independently re-checks. */
  finding?: import('@localqa/contracts').Finding | null;
  /**
   * Mo-style session agent of a login-bound run: it signs in inside its own
   * browser before its work. No run-level state is captured or imported.
   */
  signIn?: boolean;
  /** A session explorer of a login-bound run: it explores signed out. */
  withoutSignIn?: boolean;
  session?: SessionContext;
}
export interface Reservation {
  regressionSource?: import('@localqa/contracts').RegressionStepSource;
  id: string;
  requestId: string;
  amount: Counters;
}
export interface ActionGrant {
  id: string;
  step: Step;
  reservation: Reservation;
  call: ToolCall;
}
export interface CoordinatorOptions {
  db: Database;
  serviceActor: Actor;
  vault: SecretVault;
  platformSlots?: number;
  projectSlots?: number;
  protectedOrigins?: readonly string[];
}
export class Coordinator {
  readonly sessions: SessionAgent;
  readonly db: Database;
  readonly serviceActor: Actor;
  readonly vault: SecretVault;
  readonly leases: LeaseRepository;
  readonly authExecution: AuthExecutionManager;
  readonly authActions: AuthActionsManager;
  readonly authStateService: AuthStateService;
  readonly authOtp: AuthOtpService;
  readonly authImportService: AuthImportService;
  readonly platformSlots: number;
  readonly projectSlots: number;
  readonly protectedOrigins: readonly string[];
  constructor(options: CoordinatorOptions) {
    this.sessions = new SessionAgent(this);
    this.db = options.db;
    this.serviceActor = options.serviceActor;
    this.vault = options.vault;
    this.leases = new LeaseRepository(this.db, this.serviceActor);
    this.authExecution = new AuthExecutionManager(this);
    this.authActions = new AuthActionsManager(this);
    this.authStateService = new AuthStateService(this);
    this.authOtp = new AuthOtpService(this);
    this.authImportService = new AuthImportService(this);
    this.platformSlots = options.platformSlots ?? 4;
    this.projectSlots = options.projectSlots ?? 4;
    this.protectedOrigins = options.protectedOrigins ?? [];
    if (
      !Number.isSafeInteger(this.platformSlots) ||
      this.platformSlots < 1 ||
      !Number.isSafeInteger(this.projectSlots) ||
      this.projectSlots < 1
    )
      throw new DomainError('VALIDATION_ERROR');
  }
  async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.db.actor(this.serviceActor, async (client) => {
      await requireAdmin(client);
      try {
        return await work(client);
      } catch (error) {
        if (error instanceof DomainError) {
          // Preserve the codes the rest of the system acts on. Action-ledger
          // refusals (stale snapshot, hidden input, saved credential, ...)
          // must reach the dispatcher unchanged: rewriting them to
          // VALIDATION_ERROR turned a recoverable refusal into a case-ending
          // infrastructure error.
          const preserved =
            isActionDenialCode(error.code) ||
            error.code === 'BUDGET_EXCEEDED' ||
            error.code === 'VALIDATION_ERROR';
          if (!preserved)
            // Constant codes only: never the message, which may carry content.
            console.warn(
              JSON.stringify({
                event: 'coordinator.tx.rewritten',
                from: error.code,
                to: 'VALIDATION_ERROR',
              }),
            );
          throw new StorageError(
            preserved ? (error.code as 'VALIDATION_ERROR') : 'VALIDATION_ERROR',
          );
        }
        throw error;
      }
    });
  }
  async start(
    actor: Actor,
    input: RunCreate,
    config: RunConfig,
    idempotencyKey: string,
    trustedCases: CaseDefinition[] = [],
  ): Promise<Run> {
    const data = parseContract('RunCreate', input);
    const effective = parseContract('RunConfig', {
      ...config,
      budget: { ...config.budget, ...data.budget },
    });
    validateTarget(
      data.targetUrl,
      effective.allowedOrigins,
      this.protectedOrigins,
    );
    if (!idempotencyKey || idempotencyKey.length > 200)
      throw new StorageError('VALIDATION_ERROR');
    // Server-generated case/run identities change on a retry. Bind idempotency
    // to the ordered frozen definitions, including their source version data.
    const stableCases = trustedCases.map(
      ({ id: _caseId, runId: _runId, ...definition }) => definition,
    );
    const executionMode = trustedCases.some((c) => c.regression)
      ? 'regression'
      : 'smoke';
    if (
      executionMode === 'regression' &&
      trustedCases.some((c) => !c.regression)
    )
      throw new StorageError('VALIDATION_ERROR');
    const bodyHash = hashPayload({
      data,
      effective,
      trustedCases: stableCases,
    });
    return this.db.actor(actor, async (client) => {
      await authorize(client, data.projectId, 'run');
      if (
        (
          await client.query('SELECT status FROM projects WHERE id=$1', [
            data.projectId,
          ])
        ).rows[0].status === 'archived'
      )
        throw new StorageError('PROJECT_ARCHIVED');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${data.projectId}:${actor.userId}:${idempotencyKey}`],
      );
      const old = (
        await client.query(
          'SELECT body_hash,result_id FROM request_idempotency WHERE project_id=$1 AND actor_id=$2 AND route=$3 AND key=$4',
          [data.projectId, actor.userId, 'T05/run', idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (old.body_hash !== bodyHash)
          throw new StorageError('IDEMPOTENCY_CONFLICT');
        return runDTO(client, data.projectId, old.result_id);
      }
      // Admission under the same global lock as lease claim. Already queued work
      // remains queued; a new request when all browser slots are leased receives
      // the contract's 429 instead of an apparently accepted, unbounded queue.
      // This is the API/run-creation side of the mutex: it holds one connection
      // for the duration of one short claim transaction (the worker's claim loop
      // uses try-lock and never queues here), so it cannot starve the pool.
      await client.query('SELECT pg_advisory_xact_lock(741005)');
      const slots = (
        await client.query<{ total: number; project: number }>(
          "SELECT count(*)::integer AS total,count(*) FILTER(WHERE b.project_id=$1)::integer AS project FROM budget_reservations b JOIN jobs j ON j.id=b.task_id WHERE b.kind='concurrency' AND b.status='reserved' AND j.status='running' AND j.role NOT IN ('coordinator','finalizer')",
          [data.projectId],
        )
      ).rows[0]!;
      if (
        slots.total >= this.platformSlots ||
        slots.project >= this.projectSlots
      )
        throw new StorageError('RATE_LIMITED');
      const id = trustedCases[0]?.runId ?? randomUUID();
      const now = new Date().toISOString();
      let run = parseContract('Run', {
        id,
        projectId: data.projectId,
        creatorId: actor.userId,
        targetUrl: displayUrl(data.targetUrl),
        status: 'queued',
        phase: 'preflight',
        completion: 'none',
        terminationReason: null,
        contextVersion: 1,
        version: 1,
        effectiveConfig: effective,
        executionMode,
        budgetUsed: EMPTY_USED,
        createdAt: now,
        updatedAt: now,
      });
      let secretId: string | null = null;
      if (new URL(data.targetUrl).search) {
        secretId = randomUUID();
        const e = this.vault.encrypt(data.targetUrl, {
          projectId: data.projectId,
          secretId,
          purpose: 'run_url',
        });
        await client.query(
          "INSERT INTO secrets(id,project_id,name,purpose) VALUES($1,$2,'Run URL','run_url')",
          [secretId, data.projectId],
        );
        await client.query(
          'INSERT INTO secret_versions(id,project_id,secret_id,version,ciphertext,nonce,auth_tag,key_version) VALUES($1,$2,$3,1,$4,$5,$6,$7)',
          [
            randomUUID(),
            data.projectId,
            secretId,
            e.ciphertext,
            e.nonce,
            e.authTag,
            e.keyVersion,
          ],
        );
      }
      await client.query(
        "INSERT INTO runs(id,project_id,creator_id,display_url,raw_url_secret_id,raw_url_secret_version,status,phase,completion,termination_reason,effective_config,budget_used,environment_id,environment_version,auth_profile_id,auth_profile_version,created_at,updated_at,execution_mode) VALUES($1,$2,$3,$4,$5,$6,'queued','preflight','none',NULL,$7,$8,$9,$10,$11,$12,$13,$13,$14)",
        [
          id,
          data.projectId,
          actor.userId,
          run.targetUrl,
          secretId,
          secretId ? 1 : null,
          effective,
          EMPTY_USED,
          data.environmentId ?? null,
          effective.environmentVersion,
          data.authProfileId ?? null,
          effective.authProfileVersion,
          now,
          executionMode,
        ],
      );
      for (const [role, binding] of Object.entries(effective.models))
        await client.query(
          'INSERT INTO run_model_bindings(project_id,run_id,role,profile_id,version) VALUES($1,$2,$3,$4,$5)',
          [data.projectId, id, role, binding.profileId, binding.version],
        );
      for (const knowledge of effective.knowledgeVersionIds)
        await client.query(
          'INSERT INTO run_knowledge_bindings(project_id,run_id,knowledge_version_id) VALUES($1,$2,$3)',
          [data.projectId, id, knowledge],
        );
      await client.query(
        'INSERT INTO run_budgets(project_id,run_id,limits,used) VALUES($1,$2,$3,$4)',
        [data.projectId, id, effective.budget, EMPTY_USED],
      );
      await appendEvent(client, data.projectId, id, 'run.updated', run);
      if (trustedCases.length > effective.budget.maxCases)
        throw new StorageError('BUDGET_EXCEEDED');
      for (const item of trustedCases) {
        const c = parseContract('CaseDefinition', item);
        if (
          c.runId !== id ||
          c.projectId !== data.projectId ||
          (!c.regression &&
            c.criteria.some(
              (k) =>
                k.sourceKind !== 'generic_smoke' &&
                (k.sourceKind !== 'user_spec' ||
                  k.sourceRef !== `brief:${hashPayload(data.brief ?? '')}`),
            ))
        )
          throw new StorageError('VALIDATION_ERROR');
        if (c.regression) {
          const source = (
            await client.query(
              'SELECT document,sha256,review_status FROM saved_case_versions WHERE project_id=$1 AND id=$2 FOR SHARE',
              [c.projectId, c.regression.sourceVersionId],
            )
          ).rows[0];
          if (
            !source ||
            source.review_status !== 'approved' ||
            source.sha256 !== c.regression.sourceDocumentSha256 ||
            hashPayload(source.document) !==
              (c.regression.snapshotDocumentSha256 ??
                c.regression.sourceDocumentSha256) ||
            hashPayload(source.document) !== hashPayload(c.regression.document)
          )
            throw new StorageError('VALIDATION_ERROR');
          const env = await this.regressionEnvironment(client, run);
          const plan = createRegressionPlan(c.regression, {
            projectId: c.projectId,
            allowedOrigins: effective.allowedOrigins,
            env,
            maxExpandedSteps: effective.budget.maxActionsPerCase,
          });
          for (const entry of plan.steps)
            if (entry.step.kind === 'navigate')
              validateTarget(
                entry.step.url,
                effective.allowedOrigins,
                this.protectedOrigins,
              );
          if (hashPayload(plan.criteria) !== hashPayload(c.criteria))
            throw new StorageError('VALIDATION_ERROR');
        }
        await this.insertCase(client, c);
      }
      if (executionMode === 'smoke' && !trustedCases.length)
        await this.sessions.initialize(client, run, data.brief ?? '');
      if (effective.taskIntent === 'plan') {
        run = await this.change(client, run, 'running', 'plan');
        await this.sessions.advance(client, run, []);
      } else {
        await this.enqueue(
          client,
          run,
          'coordinator',
          'preflight',
          'prepare',
          null,
          1,
        );
      }
      await audit(client, 'run.created', id, data.projectId);
      await client.query(
        "INSERT INTO request_idempotency(project_id,actor_id,route,key,body_hash,result_id,expires_at) VALUES($1,$2,'T05/run',$3,$4,$5,clock_timestamp()+interval '24 hours')",
        [data.projectId, actor.userId, idempotencyKey, bodyHash, id],
      );
      return run;
    });
  }
  async insertCase(client: PoolClient, c: CaseDefinition): Promise<void> {
    await client.query(
      'INSERT INTO run_cases(id,project_id,run_id,document,criteria_hash) VALUES($1,$2,$3,$4,$5)',
      [c.id, c.projectId, c.runId, c, criteriaHash(c)],
    );
    if (c.regression)
      await client.query(
        'INSERT INTO run_case_regression_bindings(project_id,run_id,case_id,source_version_id,source_sha256,binding) VALUES($1,$2,$3,$4,$5,$6)',
        [
          c.projectId,
          c.runId,
          c.id,
          c.regression.sourceVersionId,
          c.regression.sourceDocumentSha256,
          c.regression,
        ],
      );
    await appendEvent(client, c.projectId, c.runId, 'case.created', c);
  }
  async regressionEnvironment(
    client: PoolClient,
    run: Run,
  ): Promise<Record<string, string>> {
    const row = (
      await client.query(
        'SELECT environment_id FROM runs WHERE id=$1 AND project_id=$2',
        [run.id, run.projectId],
      )
    ).rows[0];
    if (!row?.environment_id) return { BASE_URL: run.targetUrl };
    const version = (
      await client.query(
        'SELECT document FROM environment_versions WHERE project_id=$1 AND environment_id=$2 AND version=$3',
        [
          run.projectId,
          row.environment_id,
          run.effectiveConfig.environmentVersion,
        ],
      )
    ).rows[0];
    if (!version) throw new StorageError('VERSION_CONFLICT');
    return { BASE_URL: parseContract('Environment', version.document).baseUrl };
  }
  async enqueue(
    client: PoolClient,
    run: Run,
    role: Task['role'],
    stage: Stage,
    target: string,
    caseId: string | null,
    attempt = 1,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const key = taskKey(
      run.id,
      role,
      `${stage}:${target}`,
      attempt,
      run.contextVersion,
    );
    const task = parseContract('Task', {
      id: randomUUID(),
      runId: run.id,
      role,
      status: 'queued',
      caseId,
      attempt,
      summary: stage,
      elapsedSeconds: 0,
    });
    const row = await client.query(
      'INSERT INTO jobs(id,project_id,run_id,case_id,unique_key,role,attempt,document,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(unique_key) DO NOTHING RETURNING id',
      [
        task.id,
        run.projectId,
        run.id,
        caseId,
        key,
        role,
        attempt,
        task,
        { stage, ...extra },
      ],
    );
    if (row.rowCount)
      await appendEvent(client, run.projectId, run.id, 'task.updated', task);
    return (
      row.rows[0]?.id ??
      (
        await client.query(
          'SELECT id FROM jobs WHERE unique_key=$1 AND project_id=$2',
          [key, run.projectId],
        )
      ).rows[0].id
    );
  }
  private async startApprovedRegression(
    client: PoolClient,
    run: Run,
  ): Promise<Run> {
    const cases = (
      await client.query<{ document: CaseDefinition }>(
        'SELECT document FROM run_cases WHERE project_id=$1 AND run_id=$2 ORDER BY id',
        [run.projectId, run.id],
      )
    ).rows;
    if (!cases.length || cases.some((row) => !row.document.regression))
      throw new StorageError('VALIDATION_ERROR');
    run = await this.change(client, run, 'running', 'execute');
    for (const { document: c } of cases)
      await this.enqueue(
        client,
        run,
        'executor',
        'execute',
        `${c.id}:v${c.version}`,
        c.id,
        1,
      );
    return run;
  }

  /**
   * Trusted frozen smoke cases already contain the authoritative assertions.
   * Avoid redundant AI exploration and planning before executing them.
   */
  private async startSmokeAfterAuth(
    client: PoolClient,
    run: Run,
  ): Promise<Run> {
    const cases = (
      await client.query<{ document: CaseDefinition }>(
        'SELECT document FROM run_cases WHERE project_id=$1 AND run_id=$2 ORDER BY id',
        [run.projectId, run.id],
      )
    ).rows.map(({ document }) => document);
    if (cases.length) {
      if (cases.some((c) => c.regression))
        throw new StorageError('VALIDATION_ERROR');
      run = await this.change(client, run, 'running', 'execute');
      for (const c of cases) {
        const entryUrl = c.outline[0]?.startsWith('Navigate ')
          ? c.outline[0].slice(9)
          : run.targetUrl;
        validateTarget(
          entryUrl,
          run.effectiveConfig.allowedOrigins,
          this.protectedOrigins,
        );
        await this.enqueue(
          client,
          run,
          'executor',
          'execute',
          `${c.id}:v${c.version}`,
          c.id,
          1,
          { entryUrl },
        );
      }
      return run;
    }
    run = await this.change(client, run, 'running', 'explore');
    if (await this.sessions.read(client, run))
      await this.sessions.advance(client, run, []);
    else await this.enqueue(client, run, 'explorer', 'explore', 'entry', null);
    return run;
  }

  /** Approved regression keeps its run-level sign-in and imported state. */
  async startRegressionAfterPreflight(
    client: PoolClient,
    run: Run,
  ): Promise<Run> {
    const bound = (
      await client.query<{ document: unknown; revoked: boolean }>(
        `SELECT v.document,p.revoked FROM runs r
         JOIN auth_profiles p ON p.project_id=r.project_id
           AND p.id=r.auth_profile_id
         JOIN auth_profile_versions v ON v.project_id=r.project_id
           AND v.auth_profile_id=p.id AND v.version=r.auth_profile_version
         WHERE r.project_id=$1 AND r.id=$2`,
        [run.projectId, run.id],
      )
    ).rows[0];
    if (
      run.effectiveConfig.authProfileVersion !== null &&
      (!bound || bound.revoked || !bound.document)
    ) {
      await this.finalize(client, run, 'setup_failure', 'completed');
      return run;
    }
    const profile = bound ? parseContract('AuthProfile', bound.document) : null;
    if (profile && profile.status !== 'active') {
      await this.finalize(client, run, 'setup_failure', 'completed');
      return run;
    }
    if (profile && profile.mode !== 'none') {
      run = await this.change(client, run, 'running', 'auth');
      await this.enqueue(client, run, 'executor', 'auth', 'initialize', null);
      return run;
    }
    return this.startApprovedRegression(client, run);
  }

  /**
   * A configured, non-anonymous smoke profile must first acquire a real
   * authenticated state; never skip auth and explore anonymously. A
   * Mo-style session has no run-level sign-in: each executor and reproducer
   * signs in inside its own browser (Work.signIn), so it goes straight on.
   */
  async startSmokeAfterPreflight(client: PoolClient, run: Run): Promise<Run> {
    // Session credentials are checked by each task's private sign-in; an edit
    // or revocation between preflight and dispatch must not fail the run.
    if (
      run.executionMode === 'smoke' &&
      (await this.sessions.read(client, run)) !== null
    ) {
      run = await this.change(client, run, 'running', 'auth');
      return this.startSmokeAfterAuth(client, run);
    }
    const bound = (
      await client.query<{ document: unknown; revoked: boolean }>(
        `SELECT v.document,p.revoked FROM runs r
         JOIN auth_profiles p ON p.project_id=r.project_id
           AND p.id=r.auth_profile_id
         JOIN auth_profile_versions v ON v.project_id=r.project_id
           AND v.auth_profile_id=p.id AND v.version=r.auth_profile_version
         WHERE r.project_id=$1 AND r.id=$2`,
        [run.projectId, run.id],
      )
    ).rows[0];
    if (
      run.effectiveConfig.authProfileVersion !== null &&
      (!bound || bound.revoked || !bound.document)
    ) {
      await this.finalize(client, run, 'setup_failure', 'completed');
      return run;
    }
    const profile = bound ? parseContract('AuthProfile', bound.document) : null;
    if (profile && profile.status !== 'active') {
      await this.finalize(client, run, 'setup_failure', 'completed');
      return run;
    }
    if (
      profile &&
      profile.mode !== 'none' &&
      !(await this.sessions.read(client, run))
    ) {
      if (run.executionMode !== 'smoke')
        throw new StorageError('POLICY_DENIED');
      run = await this.change(client, run, 'running', 'auth');
      await this.enqueue(client, run, 'executor', 'auth', 'initialize', null);
      return run;
    }
    run = await this.change(client, run, 'running', 'auth');
    return this.startSmokeAfterAuth(client, run);
  }

  async change(
    client: PoolClient,
    run: Run,
    status: Run['status'],
    phase = run.phase,
    reason = run.terminationReason,
    done = run.completion,
  ): Promise<Run> {
    transition(run, status, phase);
    await client.query(
      'UPDATE runs SET status=$3,phase=$4,termination_reason=$5,completion=$6,version=version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
      [run.projectId, run.id, status, phase, reason, done],
    );
    const updated = await runDTO(client, run.projectId, run.id);
    if (phase !== run.phase)
      await appendEvent(client, run.projectId, run.id, 'phase.changed', {
        phase,
        contextVersion: run.contextVersion,
      });
    await appendEvent(client, run.projectId, run.id, 'run.updated', updated);
    return updated;
  }
  async validateLease(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    allowStopping = false,
  ): Promise<{ job: JobRow; run: Run }> {
    const job = (
      await client.query<JobRow>(
        "SELECT j.* FROM jobs j JOIN task_leases l ON l.task_id=j.id AND l.fencing_token=j.fencing_token WHERE j.project_id=$1 AND j.id=$2 AND j.worker_id=$3 AND j.fencing_token=$4 AND j.status='running' AND j.lease_until>clock_timestamp() AND l.lease_until>clock_timestamp() AND l.released_at IS NULL AND l.token_hash=$5 FOR UPDATE OF j,l",
        [
          scope.projectId,
          proof.taskId,
          scope.workerId,
          proof.fencingToken,
          hashToken(proof.leaseToken),
        ],
      )
    ).rows[0];
    if (!job) throw new StorageError('LEASE_EXPIRED');
    await client.query(
      'SELECT id FROM runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
      [scope.projectId, job.run_id],
    );
    let run = await runDTO(client, scope.projectId, job.run_id);
    if (!allowStopping && job.role === 'reproducer' && graceEligibleRun(run))
      run = await this.checkTimeBudget(client, run);
    const grace = !allowStopping && await this.inReproductionGrace(client, run, job);
    if (
      !allowStopping && !grace &&
      run.budgetUsed.activeSeconds >=
        run.effectiveConfig.budget.maxActiveSeconds &&
      !['recover', 'finalize'].includes(
        String(job.result?.['stage'] ?? job.document.summary),
      )
    )
      throw new StorageError('BUDGET_EXCEEDED');
    if (
      run.contextVersion !== proof.contextVersion ||
      (!allowStopping &&
        (run.status !== 'running' ||
          (!grace && ['budget_limit', 'model_failure', 'setup_failure'].includes(
            run.terminationReason ?? '',
          ) &&
            !['recover', 'finalize'].includes(
              String(job.result?.['stage'] ?? job.document.summary),
            ))))
    )
      throw new StorageError('LEASE_EXPIRED');
    return { job, run };
  }
  async claim(scope: WorkerScope, seconds = 45): Promise<Lease | null> {
    try {
      // Claim and slot bookkeeping must share one mutual-exclusion domain: the
      // advisory lock is held for the whole claim+bookkeep, so a second worker
      // cannot observe reserved=limit-1 and oversell slots.
      //
      // It must be a *try* lock: with BROWSER_SLOTS=25 a worker launches up to
      // 26 concurrent claim flights, and a blocking advisory lock would hold
      // those pooled connections while they queue. The pool then has no
      // connection left for heartbeats and model reservations of tasks that are
      // already running, which fail as SERVICE_UNAVAILABLE. Losing the race only
      // means this flight claims nothing; the caller's poll loop retries.
      let lease = null;
      await this.tx(async (client) => {
        const locked = (
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(741005) AS locked',
          )
        ).rows[0]?.locked;
        if (!locked) return;
        const slots = (
          await client.query<{
            children: number;
            project: number;
            control: number;
          }>(
            "SELECT count(*) FILTER(WHERE j.role NOT IN ('coordinator','finalizer'))::int children,count(*) FILTER(WHERE j.role NOT IN ('coordinator','finalizer') AND b.project_id=$1)::int project,count(*) FILTER(WHERE j.role IN ('coordinator','finalizer'))::int control FROM budget_reservations b JOIN jobs j ON j.id=b.task_id WHERE b.kind='concurrency' AND b.status='reserved' AND j.status='running'",
            [scope.projectId],
          )
        ).rows[0]!;
        lease = await claimTask(client, scope, seconds, {
          children:
            slots.children < this.platformSlots &&
            slots.project < this.projectSlots,
          control: slots.control < 1,
        });
        if (!lease) return;
        const run = await runDTO(client, scope.projectId, lease.task.runId);
        if (run.status === 'queued') await this.change(client, run, 'running');
        await client.query(
          "INSERT INTO budget_reservations(id,project_id,run_id,task_id,request_id,fencing_token,kind,reserved,status) VALUES($1,$2,$3,$4,$5,$6,'concurrency','{}','reserved')",
          [
            randomUUID(),
            scope.projectId,
            run.id,
            lease.task.id,
            randomUUID(),
            lease.fencingToken,
          ],
        );
        await this.pulse(client, run.projectId, run.id);
      });
      return lease;
    } catch (error) {
      if (error instanceof StorageError && error.code === 'RATE_LIMITED')
        return null;
      throw error;
    }
  }
  /** Same bound profile, latest for self sign-in; never returns secrets. */
  async authProfile(
    scope: WorkerScope,
    proof: LeaseProof,
    versionPolicy: 'task' | 'frozen' = 'task',
  ): Promise<AuthProfile | null> {
    return this.tx(async (client) => {
      const { job, run } = await this.validateLease(client, scope, proof);
      return readRunAuthProfile(
        client,
        run,
        versionPolicy === 'task' &&
          (await signInKind(this, client, job, run)) === 'self',
        proof,
      );
    });
  }
  allocateAuthSession(
    scope: WorkerScope,
    proof: LeaseProof,
  ): Promise<AuthSessionBinding> {
    return this.tx((client) =>
      this.authExecution.allocateAuthSession(client, scope, proof),
    );
  }
  issueAuthActivationTicket(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<{ activationTicket: string }> {
    return this.tx((client) =>
      this.authExecution.issueAuthActivationTicket(
        client,
        scope,
        proof,
        sessionId,
      ),
    );
  }
  activateAuthSession(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    ticket: string,
  ): Promise<AuthSessionBinding> {
    return this.tx((client) =>
      this.authExecution.activateAuthSession(
        client,
        scope,
        proof,
        sessionId,
        ticket,
      ),
    );
  }
  allocateAuthImporterSession(
    scope: WorkerScope,
    proof: LeaseProof,
    authStateId: string,
  ): Promise<AuthSessionBinding> {
    return this.tx((client) =>
      this.authExecution.allocateAuthImporterSession(
        client,
        scope,
        proof,
        authStateId,
      ),
    );
  }
  grantAuthImport(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<AuthImportGrant> {
    return this.tx((client) =>
      this.authImportService.grantImport(client, scope, proof, sessionId),
    );
  }
  prepareAuthImport(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
  ) {
    return this.tx((client) =>
      this.authImportService.prepare(client, scope, proof, sessionId, grantId),
    );
  }
  beginAuthImport(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
  ): Promise<AuthImportReceipt> {
    return this.tx((client) =>
      this.authImportService.begin(client, scope, proof, sessionId, grantId),
    );
  }
  recordAuthImport(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    receipt: AuthImportReceipt,
    outcome: AuthImportOutcome,
  ): Promise<void> {
    return this.tx((client) =>
      this.authImportService.record(
        client,
        scope,
        proof,
        sessionId,
        grantId,
        receipt,
        outcome,
      ),
    );
  }

  authSession(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<AuthSessionBinding> {
    return this.tx((client) =>
      this.authExecution.authSession(client, scope, proof, sessionId),
    );
  }
  endAuthSession(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    reason?: string,
  ): Promise<AuthSessionBinding> {
    return this.tx((client) =>
      this.authExecution.endAuthSession(
        client,
        scope,
        proof,
        sessionId,
        reason,
      ),
    );
  }
  recordAuthObservation(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    snapshot: BrowserSnapshot,
  ): Promise<BrowserSnapshot> {
    return this.tx((client) =>
      this.authActions.recordAuthObservation(
        client,
        scope,
        proof,
        sessionId,
        snapshot,
      ),
    );
  }
  grantAuth(
    scope: WorkerScope,
    proof: LeaseProof,
    request: AuthActionRequest,
  ): Promise<AuthPermit> {
    return this.tx((client) =>
      this.authActions.grantAuth(client, scope, proof, request),
    );
  }
  beginAuthExecution(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
  ): Promise<AuthExecutionReceipt> {
    return this.tx((client) =>
      this.authActions.beginAuthExecution(
        client,
        scope,
        proof,
        sessionId,
        grantId,
      ),
    );
  }
  recordAuth(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    receipt: AuthExecutionReceipt,
    outcome: AuthActionOutcome,
  ): Promise<void> {
    return this.tx((client) =>
      this.authActions.recordAuth(
        client,
        scope,
        proof,
        sessionId,
        grantId,
        receipt,
        outcome,
      ),
    );
  }
  finishAuth(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    authStateId: string,
  ): Promise<void> {
    return this.tx((client) =>
      this.authStateService.finishAuth(
        client,
        scope,
        proof,
        sessionId,
        authStateId,
      ),
    );
  }
  authMaterial(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
  ): Promise<CredentialMaterial> {
    return this.tx((client) =>
      this.authStateService.authMaterial(client, scope, proof, sessionId),
    );
  }
  recordAuthCriterion(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    criterionResult: CriterionResult,
    snapshotId: string,
  ): Promise<{ gateId: string }> {
    return this.tx((client) =>
      this.authStateService.recordAuthCriterion(
        client,
        scope,
        proof,
        sessionId,
        criterionResult,
        snapshotId,
      ),
    );
  }
  issueCaptureGrant(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    gateId: string,
  ): Promise<{
    grant: import('@localqa/browser').AuthExportGrant;
    captureTicket: string;
  }> {
    return this.tx((client) =>
      this.authStateService.issueCaptureGrant(
        client,
        scope,
        proof,
        sessionId,
        gateId,
      ),
    );
  }
  beginAuthCapture(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    ticket: string,
  ): Promise<void> {
    return this.tx((client) =>
      this.authStateService.beginAuthCapture(
        client,
        scope,
        proof,
        sessionId,
        grantId,
        ticket,
      ),
    );
  }
  captureAuthState(
    scope: WorkerScope,
    proof: LeaseProof,
    sessionId: string,
    grantId: string,
    ticket: string,
    state: import('@localqa/browser').ApprovedAuthState,
  ): Promise<AuthStateRef> {
    return this.tx((client) =>
      this.authStateService.captureAuthState(
        client,
        scope,
        proof,
        sessionId,
        grantId,
        ticket,
        state,
      ),
    );
  }
  private async regressionLocatorKey(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    source: import('@localqa/contracts').RegressionStepSource,
    locator: import('@localqa/contracts').Locator,
    pageUrl: string,
  ): Promise<{
    key: string;
    fingerprint: string;
    runId: string;
    sourceVersionId: string;
  }> {
    const { run, job } = await this.validateLease(client, scope, proof);
    if (
      run.executionMode !== 'regression' ||
      !job.case_id ||
      !['execute', 'reproduce'].includes(String(job.document.summary)) ||
      locator.by !== 'role' ||
      !locator.name ||
      locator.value.length > 80 ||
      locator.name.length > 120
    )
      throw new StorageError('VALIDATION_ERROR');
    const origin = parseContract('Locator', locator);
    let page: URL;
    try {
      page = new URL(pageUrl);
    } catch {
      throw new StorageError('VALIDATION_ERROR');
    }
    if (!run.effectiveConfig.allowedOrigins.includes(page.origin))
      throw new StorageError('TARGET_NOT_ALLOWED');
    const stepSource = parseContract('RegressionStepSource', source);
    const binding = (
      await client.query<{ source_version_id: string; source_sha256: string }>(
        `SELECT source_version_id,source_sha256
         FROM run_case_regression_bindings
         WHERE project_id=$1 AND run_id=$2 AND case_id=$3`,
        [scope.projectId, run.id, job.case_id],
      )
    ).rows[0];
    if (!binding) throw new StorageError('VALIDATION_ERROR');
    const isolation = (
      await client.query<{
        environment_id: string | null;
        auth_profile_id: string | null;
      }>(
        'SELECT environment_id,auth_profile_id FROM runs WHERE project_id=$1 AND id=$2',
        [scope.projectId, run.id],
      )
    ).rows[0]!;
    const fingerprint = hashPayload({ role: origin.value, name: origin.name });
    const key = hashPayload({
      projectId: scope.projectId,
      sourceVersionId: binding.source_version_id,
      sourceSha256: binding.source_sha256,
      source: stepSource,
      locator: origin,
      environmentId: isolation.environment_id,
      environmentVersion: run.effectiveConfig.environmentVersion,
      authProfileId: isolation.auth_profile_id,
      authProfileVersion: run.effectiveConfig.authProfileVersion,
      allowedOrigins: run.effectiveConfig.allowedOrigins,
      actionPolicy: run.effectiveConfig.actionPolicy,
      targetOrigin: new URL(run.targetUrl).origin,
      pageLocation: page.href,
      cacheProtocolVersion: 2,
    });
    return {
      key,
      fingerprint,
      runId: run.id,
      sourceVersionId: binding.source_version_id,
    };
  }
  /** Hints never confer authority. A fresh browser snapshot must match the
   * expected unique role/name before using a newly minted NodeTarget. */
  async lookupRegressionLocator(
    scope: WorkerScope,
    proof: LeaseProof,
    source: import('@localqa/contracts').RegressionStepSource,
    locator: import('@localqa/contracts').Locator,
    pageUrl: string,
  ): Promise<string | null> {
    return this.tx(async (client) => {
      const { key, fingerprint } = await this.regressionLocatorKey(
        client,
        scope,
        proof,
        source,
        locator,
        pageUrl,
      );
      const row = (
        await client.query<{ fingerprint: string }>(
          `SELECT hint->>'fingerprint' AS fingerprint
           FROM regression_locator_hints
           WHERE project_id=$1 AND cache_key=$2
             AND expires_at>clock_timestamp()`,
          [scope.projectId, key],
        )
      ).rows[0];
      return row?.fingerprint === fingerprint ? fingerprint : null;
    });
  }
  /** A verified cache hit counts only after browser-side uniqueness/ownership
   * validation. Invalidated hints are deleted and never reported as hits. */
  async recordRegressionLocator(
    scope: WorkerScope,
    proof: LeaseProof,
    source: import('@localqa/contracts').RegressionStepSource,
    locator: import('@localqa/contracts').Locator,
    pageUrl: string,
    outcome: 'hit' | 'miss' | 'invalidated',
    resolved: boolean,
  ): Promise<void> {
    await this.tx(async (client) => {
      const item = await this.regressionLocatorKey(
        client,
        scope,
        proof,
        source,
        locator,
        pageUrl,
      );
      await client.query(
        `INSERT INTO run_locator_cache_stats(
           project_id,run_id,hits,misses,invalidated
         ) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(project_id,run_id) DO UPDATE SET
           hits=run_locator_cache_stats.hits+EXCLUDED.hits,
           misses=run_locator_cache_stats.misses+EXCLUDED.misses,
           invalidated=run_locator_cache_stats.invalidated+EXCLUDED.invalidated,
           updated_at=clock_timestamp()`,
        [
          scope.projectId,
          item.runId,
          outcome === 'hit' ? 1 : 0,
          outcome === 'miss' ? 1 : 0,
          outcome === 'invalidated' ? 1 : 0,
        ],
      );
      if (outcome === 'invalidated')
        await client.query(
          'DELETE FROM regression_locator_hints WHERE project_id=$1 AND cache_key=$2',
          [scope.projectId, item.key],
        );
      // Store only a hash of a statically approved role/name pair, never a
      // snapshot, credential, DOM text, old NodeTarget or prior pass result.
      if (resolved && outcome !== 'hit')
        await client.query(
          `INSERT INTO regression_locator_hints(
             project_id,cache_key,source_version_id,hint
           ) VALUES($1,$2,$3,$4)
           ON CONFLICT(project_id,cache_key) DO UPDATE SET
             hint=EXCLUDED.hint,updated_at=clock_timestamp(),
             expires_at=clock_timestamp()+interval '7 days'`,
          [
            scope.projectId,
            item.key,
            item.sourceVersionId,
            { fingerprint: item.fingerprint },
          ],
        );
    });
  }
  async work(scope: WorkerScope, proof: LeaseProof): Promise<Work> {
    return this.tx(async (client) => {
      const { job, run } = await this.validateLease(client, scope, proof);
      const stage = (job.result?.['stage'] ?? job.document.summary) as Stage;
      const definition = job.case_id
        ? parseContract(
            'CaseDefinition',
            (
              await client.query(
                'SELECT document FROM run_cases WHERE id=$1 AND project_id=$2',
                [job.case_id, scope.projectId],
              )
            ).rows[0].document,
          )
        : null;
      let authStateId: string | null = null;
      /** Mo-style session agent that signs in inside its own browser. */
      let signIn = false;
      /** Session explorer or signed-out case of a login-bound run. */
      let withoutSignIn = false;
      if (
        (run.executionMode === 'smoke' || run.executionMode === 'regression') &&
        ['explore', 'execute', 'reproduce'].includes(stage) &&
        run.effectiveConfig.authProfileVersion !== null
      ) {
        const sessionManaged =
          run.executionMode === 'smoke' &&
          (await this.sessions.read(client, run)) !== null;
        if (sessionManaged && definition?.requiresLogin === false) {
          withoutSignIn = true;
        } else if (sessionManaged) {
          // Unavailable credentials are blocked by the task's sign-in, not
          // work() or the whole run. Read the current mode, never import state.
          const self = (await signInKind(this, client, job, run)) === 'self';
          let needsSignIn = true;
          try {
            needsSignIn =
              (await readRunAuthProfile(client, run, true, proof))?.mode !==
              'none';
          } catch (error) {
            if (
              !(error instanceof StorageError) ||
              !['AUTH_FAILED', 'TARGET_NOT_ALLOWED'].includes(error.code)
            )
              throw error;
          }
          if (needsSignIn) {
            if (self) signIn = true;
            else withoutSignIn = true;
          }
        } else {
          const profile = await readRunAuthProfile(client, run);
          if (!profile) throw new StorageError('AUTH_FAILED');
          if (profile.mode !== 'none') {
            const authority = (
              await client.query<{
                status: string;
                current_state_id: string | null;
                context_version: number;
                auth_profile_id: string;
                auth_profile_version: number;
              }>(
                `SELECT status,current_state_id,context_version,
                        auth_profile_id,auth_profile_version
                 FROM run_auth_scopes WHERE project_id=$1 AND run_id=$2`,
                [scope.projectId, run.id],
              )
            ).rows[0];
            if (
              !authority ||
              authority.status !== 'granted' ||
              !authority.current_state_id ||
              authority.context_version !== proof.contextVersion ||
              authority.auth_profile_id !== profile.id ||
              authority.auth_profile_version !== profile.version
            )
              throw new StorageError('AUTH_FAILED');
            authStateId = authority.current_state_id;
          }
        }
      }
      let targetUrl = run.targetUrl;
      const raw = (
        await client.query(
          'SELECT v.*,s.purpose FROM runs r JOIN secret_versions v ON v.secret_id=r.raw_url_secret_id AND v.version=r.raw_url_secret_version AND v.project_id=r.project_id JOIN secrets s ON s.id=v.secret_id WHERE r.id=$1 AND r.project_id=$2 AND NOT s.revoked',
          [run.id, scope.projectId],
        )
      ).rows[0];
      if (raw)
        targetUrl = this.vault.decrypt(
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
      if (
        typeof job.result?.['entryUrl'] === 'string' &&
        displayUrl(job.result['entryUrl']) !== run.targetUrl
      )
        targetUrl = job.result['entryUrl'];

      if (run.executionMode === 'regression') {
        if (definition) {
          const snapshot = (
            await client.query(
              'SELECT binding FROM run_case_regression_bindings WHERE project_id=$1 AND run_id=$2 AND case_id=$3',
              [scope.projectId, run.id, definition.id],
            )
          ).rows[0];
          if (
            !snapshot ||
            !definition.regression ||
            hashPayload(snapshot.binding) !== hashPayload(definition.regression)
          )
            throw new StorageError('VALIDATION_ERROR');
        } else if (
          ['execute', 'reproduce'].includes(
            String(job.result?.['stage'] ?? job.document.summary),
          )
        )
          throw new StorageError('VALIDATION_ERROR');
      }
      let contextId: string = randomUUID(),
        attemptId: string | null = null;
      // A signed-in browser context is frozen on the task: importer and
      // self sign-in sessions bind to it and never invent another one.
      const boundContext = authStateId !== null || signIn;
      if (boundContext && typeof job.result?.['authContextId'] === 'string') {
        const frozenContext = job.result['authContextId'];
        if (
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(frozenContext)
        )
          throw new StorageError('VALIDATION_ERROR');
        contextId = frozenContext;
      }
      if (definition) {
        await client.query('SELECT id FROM run_cases WHERE id=$1 FOR UPDATE', [
          definition.id,
        ]);
        const existing = (
          await client.query(
            "SELECT id,context_id FROM case_attempts WHERE project_id=$1 AND task_id=$2 AND status='running' ORDER BY attempt_number DESC LIMIT 1",
            [scope.projectId, job.id],
          )
        ).rows[0];
        if (existing) {
          attemptId = existing.id;
          if (
            boundContext &&
            job.result?.['authContextId'] &&
            job.result['authContextId'] !== existing.context_id
          )
            throw new StorageError('VERSION_CONFLICT');
          contextId = existing.context_id;
        } else {
          if (job.role === 'reproducer') {
            const scheduled = (
              await client.query(
                "SELECT * FROM budget_reservations WHERE project_id=$1 AND task_id=$2 AND kind='reproduction' AND status='reserved' AND fencing_token IS NULL FOR UPDATE",
                [scope.projectId, job.id],
              )
            ).rows[0];
            let reservationId: string;
            if (scheduled) {
              await client.query(
                'UPDATE budget_reservations SET fencing_token=$2 WHERE id=$1',
                [scheduled.id, proof.fencingToken],
              );
              reservationId = scheduled.id;
            } else
              reservationId = (
                await this.reserve(client, scope, proof, 'reproduction', {
                  reproductions: 1,
                })
              ).id;
            await this.settleIn(
              client,
              scope,
              proof,
              reservationId,
              { reproductions: 1 },
              'reported',
            );
          }
          attemptId = randomUUID();
          await client.query(
            "INSERT INTO case_attempts(id,project_id,run_id,case_id,task_id,attempt_number,status,context_id,started_at) VALUES($1,$2,$3,$4,$5,(SELECT COALESCE(max(attempt_number),0)+1 FROM case_attempts WHERE case_id=$4),'running',$6,clock_timestamp())",
            [
              attemptId,
              scope.projectId,
              run.id,
              definition.id,
              job.id,
              contextId,
            ],
          );
        }
      }
      if (boundContext) {
        // Persist the actual case-attempt/Work context before private
        // importer allocation; it must never invent another browser context.
        await client.query(
          `UPDATE jobs SET result=jsonb_set(
             COALESCE(result, '{}'::jsonb), '{authContextId}',
             to_jsonb($3::text), true)
           WHERE id=$1 AND project_id=$2`,
          [job.id, scope.projectId, contextId],
        );
      }
      let tlsPolicy: 'strict' | 'allow_self_signed' = 'strict';
      if (run.effectiveConfig.environmentVersion !== null) {
        const frozenEnvironment = (
          await client.query<{ document: unknown }>(
            `SELECT v.document FROM runs r
             JOIN environment_versions v
               ON v.project_id=r.project_id
                 AND v.environment_id=r.environment_id
                 AND v.version=r.environment_version
             WHERE r.project_id=$1 AND r.id=$2`,
            [scope.projectId, run.id],
          )
        ).rows[0];
        if (!frozenEnvironment) throw new StorageError('NOT_FOUND');
        const environment = parseContract(
          'Environment',
          frozenEnvironment.document,
        );
        if (environment.tlsPolicy === 'allow_self_signed') {
          const origin = new URL(targetUrl).origin;
          // IgnoreHTTPSErrors is context-wide. Never weaken trust for another
          // origin, including an IdP or a redirect, or for mutable env settings.
          if (
            environment.allowedOrigins.length !== 1 ||
            environment.allowedOrigins[0] !== origin ||
            run.effectiveConfig.allowedOrigins.length !== 1 ||
            run.effectiveConfig.allowedOrigins[0] !== origin
          )
            throw new StorageError('TARGET_NOT_ALLOWED');
          tlsPolicy = 'allow_self_signed';
        }
      }
      const session = ['coordinator', 'finalizer'].includes(job.role)
        ? await this.sessions.context(client, run)
        : null;
      return {
        run,
        ...(session ? { session } : {}),
        task: { ...job.document, status: job.status },
        stage,
        targetUrl,
        tlsPolicy,
        contextId,
        authStateId,
        attemptId,
        definition,
        ...(definition?.regression
          ? {
              regressionPlan: createRegressionPlan(definition.regression, {
                projectId: scope.projectId,
                allowedOrigins: run.effectiveConfig.allowedOrigins,
                env: await this.regressionEnvironment(client, run),
                maxExpandedSteps: run.effectiveConfig.budget.maxActionsPerCase,
              }),
            }
          : {}),
        findingId:
          typeof job.result?.['findingId'] === 'string'
            ? job.result['findingId']
            : null,
        finding:
          typeof job.result?.['findingId'] === 'string'
            ? ((
                await client.query<{ document: unknown }>(
                  'SELECT document FROM findings WHERE project_id=$1 AND run_id=$2 AND id=$3',
                  [scope.projectId, run.id, job.result['findingId']],
                )
              ).rows.map((row) => parseContract('Finding', row.document))[0] ??
              null)
            : null,
        ...(signIn ? { signIn } : {}),
        ...(withoutSignIn ? { withoutSignIn } : {}),
      };
    });
  }
  async reserve(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    kind: 'model' | 'action' | 'reproduction',
    amount: Counters,
    requestId = randomUUID(),
  ): Promise<Reservation> {
    const { job, run } = await this.validateLease(client, scope, proof);
    const previous = (
      await client.query(
        'SELECT * FROM budget_reservations WHERE project_id=$1 AND request_id=$2',
        [scope.projectId, requestId],
      )
    ).rows[0];
    if (previous) {
      if (
        previous.task_id !== job.id ||
        previous.fencing_token !== String(proof.fencingToken) ||
        hashPayload(previous.reserved) !== hashPayload(amount)
      )
        throw new StorageError('IDEMPOTENCY_CONFLICT');
      return { id: previous.id, requestId, amount };
    }
    const budget = (
      await client.query<{
        limits: BudgetLimits;
        used: BudgetUsed;
        reserved: Counters;
      }>(
        'SELECT * FROM run_budgets WHERE run_id=$1 AND project_id=$2 FOR UPDATE',
        [run.id, scope.projectId],
      )
    ).rows[0]!;
    const next = reserve(budget.limits, budget.used, budget.reserved, amount);
    await client.query('UPDATE run_budgets SET reserved=$2 WHERE run_id=$1', [
      run.id,
      next,
    ]);
    const id = randomUUID();
    await client.query(
      "INSERT INTO budget_reservations(id,project_id,run_id,task_id,request_id,fencing_token,kind,reserved,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved')",
      [
        id,
        scope.projectId,
        run.id,
        job.id,
        requestId,
        proof.fencingToken,
        kind,
        amount,
      ],
    );
    return { id, requestId, amount };
  }
  async settle(
    scope: WorkerScope,
    proof: LeaseProof,
    reservationId: string,
    charged: Counters,
    source: 'reported' | 'estimated' | 'unknown' | 'released',
  ): Promise<void> {
    await this.tx((client) =>
      this.settleIn(client, scope, proof, reservationId, charged, source),
    );
  }
  async settleIn(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    id: string,
    amount: Counters,
    source: string,
  ): Promise<void> {
    const boundJob = (
      await client.query(
        'SELECT id,run_id FROM jobs WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [proof.taskId, scope.projectId],
      )
    ).rows[0];
    if (!boundJob) throw new StorageError('LEASE_EXPIRED');
    await client.query(
      'SELECT id FROM runs WHERE id=$1 AND project_id=$2 FOR UPDATE',
      [boundJob.run_id, scope.projectId],
    );
    const r = (
      await client.query(
        'SELECT br.* FROM budget_reservations br JOIN task_leases l ON l.task_id=br.task_id AND l.fencing_token=br.fencing_token WHERE br.project_id=$1 AND br.id=$2 AND br.task_id=$3 AND br.fencing_token=$4 AND l.worker_id=$5 AND l.token_hash=$6 FOR UPDATE OF br',
        [
          scope.projectId,
          id,
          proof.taskId,
          proof.fencingToken,
          scope.workerId,
          hashToken(proof.leaseToken),
        ],
      )
    ).rows[0];
    if (!r) throw new StorageError('LEASE_EXPIRED');
    if (r.status !== 'reserved') {
      if (r.status === 'unknown') return;
      if (hashPayload(r.charged ?? {}) !== hashPayload(amount))
        throw new StorageError('IDEMPOTENCY_CONFLICT');
      return;
    }
    const budget = (
      await client.query<{
        used: BudgetUsed;
        reserved: Counters;
        limits: BudgetLimits;
      }>(
        'SELECT * FROM run_budgets WHERE project_id=$1 AND run_id=$2 FOR UPDATE',
        [scope.projectId, r.run_id],
      )
    ).rows[0]!;
    const charged = source === 'unknown' ? r.reserved : amount;
    for (const [k, v] of Object.entries(charged)) {
      if (
        ![
          'activeSeconds',
          'actions',
          'modelCalls',
          'reproductions',
          'totalTokens',
        ].includes(k) ||
        !Number.isSafeInteger(v) ||
        Number(v) < 0
      )
        throw new StorageError('VALIDATION_ERROR');
      budget.used[k as keyof BudgetUsed] += Number(v);
    }
    for (const [key, value] of Object.entries(r.reserved as Counters)) {
      const k = key as keyof BudgetUsed;
      budget.reserved[k] = Math.max(
        0,
        (budget.reserved[k] ?? 0) - (value ?? 0),
      );
    }
    await client.query(
      'UPDATE run_budgets SET used=$2,reserved=$3 WHERE run_id=$1',
      [r.run_id, budget.used, budget.reserved],
    );
    await client.query(
      'UPDATE budget_reservations SET status=$2,charged=$3 WHERE id=$1',
      [
        id,
        source === 'unknown'
          ? 'unknown'
          : source === 'released'
            ? 'released'
            : 'settled',
        charged,
      ],
    );
    if (source === 'unknown')
      await client.query(
        'UPDATE model_requests SET status=\'unknown\',redacted_diagnostic=redacted_diagnostic||\'{"usageSource":"unknown"}\'::jsonb WHERE reservation_id=$1 AND project_id=$2',
        [id, scope.projectId],
      );
    await appendEvent(client, scope.projectId, r.run_id, 'budget.updated', {
      used: budget.used,
      limits: budget.limits,
    });
  }
  async grantAction(
    scope: WorkerScope,
    proof: LeaseProof,
    input: unknown,
    regressionSource?: import('@localqa/contracts').RegressionStepSource,
    decisionNote?: unknown,
  ): Promise<ActionGrant> {
    return this.tx(async (client) => {
      const { job, run } = await this.validateLease(client, scope, proof);
      const sessionManaged =
        run.executionMode === 'smoke' &&
        (await this.sessions.read(client, run)) !== null;
      const signedOutCase =
        sessionManaged &&
        ((job.role === 'explorer' &&
          !job.case_id &&
          job.result?.['signedOut'] === true) ||
          (job.case_id
            ? (
                await client.query<{ document: { requiresLogin?: boolean } }>(
                  'SELECT document FROM run_cases WHERE id=$1 AND project_id=$2 AND run_id=$3',
                  [job.case_id, scope.projectId, run.id],
                )
              ).rows[0]?.document.requiresLogin === false
            : false));
      if (
        run.effectiveConfig.authProfileVersion !== null &&
        !signedOutCase &&
        ['explore', 'execute', 'reproduce'].includes(
          String(job.result?.['stage'] ?? job.document.summary),
        )
      ) {
        // Check the task-pinned version for self sign-in, and the frozen run
        // version for imported auth. Revocation is serialized against grants.
        const selfSignIn =
          (await signInKind(this, client, job, run)) === 'self';
        const bound = (
          await client.query<{
            revoked: boolean;
            document: unknown;
            current_status: string | null;
            scope_status: string | null;
            current_state_id: string | null;
            scope_context_version: number | null;
            scope_auth_epoch: number | null;
            scope_profile_version: number | null;
          }>(
            `SELECT p.revoked,v.document,h.document->>'status' AS current_status,
               s.status AS scope_status,
               s.current_state_id,s.context_version AS scope_context_version,
               s.auth_epoch AS scope_auth_epoch,
               s.auth_profile_version AS scope_profile_version
             FROM runs r
             JOIN auth_profiles p ON p.project_id=r.project_id AND p.id=r.auth_profile_id
               AND p.deleted_at IS NULL
             JOIN auth_profile_versions h ON h.project_id=p.project_id
               AND h.auth_profile_id=p.id AND h.version=p.version
             JOIN auth_profile_versions v ON v.project_id=p.project_id
               AND v.auth_profile_id=p.id
               AND v.version=CASE WHEN $3::boolean THEN COALESCE((
                 SELECT a.auth_profile_version FROM auth_execution_sessions a
                 WHERE a.project_id=r.project_id AND a.run_id=r.id AND a.task_id=$4::uuid
                   AND a.fencing_token=$5 AND a.context_version=$6 AND a.purpose='initializer'
               ),p.version) ELSE r.auth_profile_version END
             LEFT JOIN run_auth_scopes s ON s.project_id=r.project_id AND s.run_id=r.id
             WHERE r.project_id=$1 AND r.id=$2 FOR SHARE OF p`,
            [
              scope.projectId,
              run.id,
              selfSignIn,
              job.id,
              proof.fencingToken,
              proof.contextVersion,
            ],
          )
        ).rows[0];
        if (
          !bound ||
          bound.revoked ||
          (selfSignIn && bound.current_status !== 'active')
        )
          throw new StorageError('AUTH_FAILED');
        const profile = parseContract('AuthProfile', bound.document);

        if (sessionManaged && profile.mode !== 'none') {
          if (profile.status !== 'active')
            throw new StorageError('AUTH_FAILED');
          // A session agent acts only after its own server-verified sign-in
          // in this lease; an explorer of the run looks around signed out.
          if (selfSignIn) {
            if (
              !bound.scope_status ||
              bound.scope_status === 'revoked' ||
              bound.scope_context_version !== proof.contextVersion
            )
              throw new StorageError('AUTH_FAILED');
            const signedIn = await client.query(
              `SELECT 1 FROM auth_success_gates g
               JOIN auth_execution_sessions s ON s.id=g.auth_session_id
               WHERE s.project_id=$1 AND s.task_id=$2 AND s.fencing_token=$3
                 AND s.context_version=$4 AND s.purpose='initializer'
                 AND s.context_id=$5::uuid AND s.auth_profile_id=$6::uuid
                 AND s.auth_profile_version=$7 AND s.auth_epoch=$8
                 AND s.end_reason='signed_in' AND s.status='ended'
                 AND g.result='passed' LIMIT 1`,
              [
                scope.projectId,
                job.id,
                proof.fencingToken,
                proof.contextVersion,
                job.result?.['authContextId'],
                profile.id,
                profile.version,
                bound.scope_auth_epoch,
              ],
            );
            if (!signedIn.rowCount) throw new StorageError('AUTH_FAILED');
          }
        } else if (
          profile.status !== 'active' ||
          profile.version !== run.effectiveConfig.authProfileVersion ||
          (profile.mode !== 'none' &&
            (bound.scope_status !== 'granted' ||
              !bound.current_state_id ||
              bound.scope_context_version !== proof.contextVersion ||
              bound.scope_profile_version !== profile.version))
        )
          throw new StorageError('AUTH_FAILED');
      }
      const requested = parseContract('ToolCall', input);
      const sessionInteractions =
        (await this.sessions.read(client, run)) !== null;
      const call =
        run.executionMode === 'regression' &&
        ['executor', 'reproducer'].includes(job.role) &&
        ['click', 'type_text'].includes(requested.name)
          ? requested
          : validateBrowserTool(
              job.role,
              input,
              run.effectiveConfig.allowedOrigins,
              this.protectedOrigins,
              sessionInteractions,
            );
      if (sessionInteractions && 'target' in call.args && call.args.target) {
        const target = call.args.target;
        const owned = (
          await client.query<{ document: BrowserSnapshot }>(
            'SELECT document FROM page_snapshots WHERE project_id=$1 AND run_id=$2 AND task_id=$3 AND id=$4',
            [scope.projectId, run.id, job.id, target.snapshotId],
          )
        ).rows[0]?.document;
        const latest = (
          await client.query<{ result_hash: string }>(
            "SELECT i.result_hash FROM action_intents i JOIN steps s ON s.action_id=i.id WHERE i.project_id=$1 AND i.run_id=$2 AND i.task_id=$3 AND i.outcome='succeeded' AND i.tool_call->>'name'<>'capture' ORDER BY s.seq DESC LIMIT 1",
            [scope.projectId, run.id, job.id],
          )
        ).rows[0];
        const decision = evaluateTargetGrant({
          target,
          owned,
          latestResultHash: latest?.result_hash ?? null,
          call,
          signedOutCase,
          actionPolicy: run.effectiveConfig.actionPolicy,
          writeScope: run.effectiveConfig.writeScope ?? [],
        });
        if (decision.denial)
          throw actionDenied(
            decision.denial,
            decision.node,
            decision.enterButton,
          );
        if (decision.releasedSensitive) {
          const value = inputValueOf(call);
          if (value !== null && value.length > 0) {
            // Decrypt, compare, drop: neither value enters a log, event,
            // result or error, and a failed read fails closed.
            const saved = await readSavedAuthValues(
              client,
              this.vault,
              run,
              proof,
            );
            let matched: boolean;
            try {
              matched = matchesSavedCredential(value, saved);
            } finally {
              saved.length = 0;
            }
            if (matched) {
              console.warn(
                JSON.stringify({
                  event: 'action.denied',
                  reasonCode: 'SAVED_CREDENTIAL_INPUT',
                  runId: run.id,
                  taskId: job.id,
                  tool: call.name,
                }),
              );
              throw actionDenied('SAVED_CREDENTIAL_INPUT', decision.node);
            }
          }
        }
      }
      let verifiedSource:
        import('@localqa/contracts').RegressionStepSource | undefined;
      if (run.executionMode === 'regression') {
        if (!job.case_id || !regressionSource)
          throw new StorageError('VALIDATION_ERROR');
        verifiedSource = parseContract(
          'RegressionStepSource',
          regressionSource,
        );
        const binding = (
          await client.query(
            'SELECT binding FROM run_case_regression_bindings WHERE project_id=$1 AND run_id=$2 AND case_id=$3',
            [scope.projectId, run.id, job.case_id],
          )
        ).rows[0]?.binding;
        if (!binding) throw new StorageError('VALIDATION_ERROR');
        const plan = createRegressionPlan(binding, {
          projectId: scope.projectId,
          allowedOrigins: run.effectiveConfig.allowedOrigins,
          env: await this.regressionEnvironment(client, run),
          maxExpandedSteps: run.effectiveConfig.budget.maxActionsPerCase,
        });
        const entry = plan.steps.find(
          (entry) => hashPayload(entry.source) === hashPayload(verifiedSource),
        );
        if (!entry) throw new StorageError('VALIDATION_ERROR');
        const utility = ['observe', 'capture'].includes(call.name);
        if (!utility && entry.step.kind !== 'ai_action') {
          if (
            call.name !== entry.step.kind ||
            (entry.step.kind === 'navigate' &&
              call.name === 'navigate' &&
              entry.step.url !== call.args.url) ||
            (entry.step.kind === 'type_text' &&
              call.name === 'type_text' &&
              entry.step.text !== call.args.text)
          )
            throw new StorageError('VALIDATION_ERROR');
        }
        if ('target' in call.args) {
          const target = call.args.target;
          const owned = (
            await client.query(
              'SELECT document FROM page_snapshots WHERE project_id=$1 AND run_id=$2 AND task_id=$3 AND id=$4',
              [scope.projectId, run.id, job.id, target.snapshotId],
            )
          ).rows[0]?.document;
          if (
            !owned ||
            owned.pageId !== target.pageId ||
            !owned.nodes.some(
              (node: { nodeId: string; frameId: string }) =>
                node.nodeId === target.nodeId &&
                node.frameId === (target.frameId ?? 'main'),
            )
          )
            throw new StorageError('NOT_FOUND');
          const latest = (
            await client.query(
              "SELECT i.result_hash FROM action_intents i JOIN steps s ON s.action_id=i.id WHERE i.project_id=$1 AND i.run_id=$2 AND i.task_id=$3 AND i.outcome='succeeded' AND i.tool_call->>'name'<>'capture' ORDER BY s.seq DESC LIMIT 1",
              [scope.projectId, run.id, job.id],
            )
          ).rows[0];
          if (
            latest?.result_hash !==
            hashPayload({ status: 'succeeded', snapshot: owned, evidence: [] })
          )
            throw new StorageError('VERSION_CONFLICT');
        }
      } else if (regressionSource) throw new StorageError('VALIDATION_ERROR');
      if (job.case_id) {
        const caseActions = (
          await client.query(
            // A task's own sign-in steps are private and bounded on their own;
            // they do not use up the case's action allowance. Evidence
            // captures do not either: they are read-only screenshots, and the
            // report phase needs one after the last test step.
            "SELECT count(*)::integer n FROM action_intents WHERE project_id=$1 AND task_id=$2 AND tool_call->>'name' <> 'capture' AND ($3::boolean OR auth_session_id IS NULL)",
            [
              scope.projectId,
              job.id,
              (await signInKind(this, client, job, run)) !== 'self',
            ],
          )
        ).rows[0].n;
        // A spent case allowance is the agent's to handle (report from the
        // evidence it has); it must not look like a run-wide budget stop.
        if (caseActions >= run.effectiveConfig.budget.maxActionsPerCase)
          throw actionDenied('CASE_ACTION_LIMIT');
      }
      const reservation = await this.reserve(client, scope, proof, 'action', {
        actions: 1,
      });
      const id = randomUUID();
      const redacted =
        call.name === 'navigate'
          ? { ...call, args: { url: displayUrl(call.args.url) } }
          : call;
      await client.query(
        'INSERT INTO action_intents(id,project_id,run_id,task_id,fencing_token,context_version,reservation_id,tool_call) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          scope.projectId,
          run.id,
          job.id,
          proof.fencingToken,
          proof.contextVersion,
          reservation.id,
          redacted,
        ],
      );
      const seq = (
        await client.query(
          'SELECT COALESCE(max(seq),0)+1 n FROM steps WHERE project_id=$1 AND task_id=$2',
          [scope.projectId, job.id],
        )
      ).rows[0].n;
      let thought: string | null = null;
      if (typeof decisionNote === 'string' && decisionNote.trim()) {
        let saved: string[] = [];
        try {
          saved = await readSavedAuthValues(client, this.vault, run, proof);
          thought = cleanDecisionNote(decisionNote, saved);
        } catch {
          // An optional annotation must never weaken secret protection or
          // turn a valid browser decision into a malformed model response.
          thought = null;
        } finally {
          saved.length = 0;
        }
      }
      const step = parseContract('Step', {
        id: randomUUID(),
        runId: run.id,
        taskId: job.id,
        caseId: job.case_id,
        seq,
        toolName: call.name,
        status: 'running',
        ...(verifiedSource ? { regressionSource: verifiedSource } : {}),
        summary: 'Action intent persisted before execution',
        thought,
        targetDescription: call.name,
        evidenceRefs: [],
        createdAt: new Date().toISOString(),
        finishedAt: null,
      });
      await client.query(
        'INSERT INTO steps(id,project_id,run_id,task_id,case_id,action_id,seq,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [step.id, scope.projectId, run.id, job.id, job.case_id, id, seq, step],
      );
      await appendEvent(client, scope.projectId, run.id, 'step.recorded', step);
      return {
        id,
        step,
        reservation: verifiedSource
          ? { ...reservation, regressionSource: verifiedSource }
          : reservation,
        call,
      };
    });
  }
  async recordAction(
    scope: WorkerScope,
    proof: LeaseProof,
    grant: ActionGrant,
    status: 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    snapshot: BrowserSnapshot | null,
    evidence: string[] = [],
    reasonCode?: string | null,
  ): Promise<void> {
    await this.tx((client) =>
      this.recordActionIn(
        client,
        scope,
        proof,
        grant,
        status,
        snapshot,
        evidence,
        undefined,
        reasonCode,
      ),
    );
  }
  /** HTTP has no trusted snapshot or ActionGrant. Resolve its alias and all
   * metadata from the ledger, under the same lease/settlement transaction. */
  async recordHttpAction(
    scope: WorkerScope,
    proof: LeaseProof,
    actionOrStepId: string,
    input: ActionResult,
  ): Promise<string> {
    const payload = parseContract('ActionResult', input);
    return this.tx(async (client) => {
      const { job, run } = await this.validateLease(client, scope, proof);
      const row = (
        await client.query<{
          action_id: string;
          step_id: string;
          run_id: string;
          task_id: string;
          case_id: string | null;
          seq: number;
          document: unknown;
          tool_call: ToolCall;
          context_version: number;
        }>(
          `SELECT a.id AS action_id,s.id AS step_id,a.run_id,a.task_id,
                s.case_id,s.seq,s.document,a.tool_call,a.context_version
         FROM action_intents a JOIN steps s ON s.action_id=a.id
           AND s.project_id=a.project_id AND s.run_id=a.run_id AND s.task_id=a.task_id
         WHERE a.project_id=$1 AND a.run_id=$2 AND a.task_id=$3
           AND (a.id=$4 OR s.id=$4)`,
          [scope.projectId, run.id, job.id, actionOrStepId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      const step = parseContract('Step', row.document);
      if (row.context_version !== proof.contextVersion)
        throw new StorageError('LEASE_EXPIRED');
      if (
        step.id !== row.step_id ||
        step.runId !== run.id ||
        step.taskId !== job.id ||
        step.caseId !== row.case_id ||
        row.case_id !== job.case_id ||
        step.seq !== row.seq ||
        step.toolName !== row.tool_call.name
      )
        throw new StorageError('VALIDATION_ERROR');
      // Full transport payload, including opaque client resultHash and raw
      // summary, participates only in a server-computed digest, never events.
      await this.recordActionIn(
        client,
        scope,
        proof,
        { id: row.action_id, step },
        payload.outcome,
        null,
        payload.evidenceRefs,
        hashPayload(payload),
      );
      return row.action_id;
    });
  }
  private async recordActionIn(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
    grant: Pick<ActionGrant, 'id' | 'step'>,
    status: 'succeeded' | 'failed' | 'cancelled' | 'unknown',
    snapshot: BrowserSnapshot | null,
    evidence: string[],
    transportFingerprint?: string,
    reasonCode?: string | null,
  ): Promise<void> {
    const { job, run } = await this.validateLease(client, scope, proof);
    const hash = hashPayload({
      status,
      snapshot,
      evidence,
      ...(transportFingerprint === undefined ? {} : { transportFingerprint }),
    });
    const intent = (
      await client.query(
        'SELECT * FROM action_intents WHERE id=$1 AND project_id=$2 AND task_id=$3 FOR UPDATE',
        [grant.id, scope.projectId, job.id],
      )
    ).rows[0];
    if (!intent || intent.fencing_token !== String(proof.fencingToken))
      throw new StorageError('LEASE_EXPIRED');
    if (intent.auth_session_id !== null && intent.auth_session_id !== undefined)
      throw new StorageError('POLICY_DENIED');
    const recorded = (
      await client.query(
        'SELECT document FROM steps WHERE id=$1 AND action_id=$2',
        [grant.step.id, grant.id],
      )
    ).rows[0];
    if (!recorded) throw new StorageError('NOT_FOUND');
    const current = parseContract('Step', recorded.document);
    if (
      hashPayload(current.regressionSource ?? null) !==
      hashPayload(grant.step.regressionSource ?? null)
    )
      throw new StorageError('VALIDATION_ERROR');
    if (intent.outcome !== 'pending') {
      if (intent.result_hash !== hash)
        throw new StorageError('IDEMPOTENCY_CONFLICT');
      return;
    }
    if (snapshot) {
      parseContract('BrowserSnapshot', snapshot);
      if (snapshot.displayUrl.startsWith('http'))
        validateTarget(
          snapshot.displayUrl,
          run.effectiveConfig.allowedOrigins,
          this.protectedOrigins,
        );
      await client.query(
        'INSERT INTO page_snapshots(id,project_id,run_id,task_id,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
        [snapshot.snapshotId, scope.projectId, run.id, job.id, snapshot],
      );
    }
    const owned = (
      await client.query(
        'SELECT id FROM artifacts WHERE project_id=$1 AND run_id=$2 AND task_id=$3 AND id=ANY($4::uuid[])',
        [scope.projectId, run.id, job.id, evidence],
      )
    ).rows.map((row) => row.id);
    if (owned.length !== new Set(evidence).size)
      throw new StorageError('NOT_FOUND');
    await client.query(
      'UPDATE action_intents SET outcome=$2,result_hash=$3 WHERE id=$1',
      [grant.id, status, hash],
    );
    const step = settledStep(current, status, evidence, reasonCode);
    await client.query('UPDATE steps SET document=$2 WHERE id=$1', [
      step.id,
      step,
    ]);
    await this.settleIn(
      client,
      scope,
      proof,
      intent.reservation_id,
      { actions: 1 },
      status === 'unknown' ? 'unknown' : 'reported',
    );
    await appendEvent(client, scope.projectId, run.id, 'step.recorded', step);
  }
  async saveArtifact(
    scope: WorkerScope,
    proof: LeaseProof,
    input: Artifact,
  ): Promise<Artifact> {
    return this.tx(async (client) => {
      const { job, run } = await this.validateLease(client, scope, proof);
      const artifact = parseContract('Artifact', {
        ...input,
        projectId: scope.projectId,
        runId: run.id,
        taskId: job.id,
        caseId: job.case_id,
        contentUrl: `/api/v1/projects/${scope.projectId}/runs/${run.id}/artifacts/${input.id}/content`,
      });
      await client.query(
        "INSERT INTO artifacts(id,project_id,run_id,task_id,step_id,case_id,snapshot_id,document,retain_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '30 days')",
        [
          artifact.id,
          scope.projectId,
          run.id,
          job.id,
          artifact.stepId,
          artifact.caseId,
          artifact.snapshotId,
          artifact,
        ],
      );
      await appendEvent(
        client,
        scope.projectId,
        run.id,
        'artifact.updated',
        artifact,
      );
      return artifact;
    });
  }
  /**
   * Lock the last lease's job for a post-abort recording write. The fencing
   * token is the authority: a later lease increments it, so an older worker
   * cannot pass this check. A job that is still healthy and running is not
   * writable; cancellation, a termination reason, a context change or a
   * just-expired lease are the only abort states accepted here.
   */
  private async lockStoppedRecordingJob(
    client: PoolClient,
    scope: WorkerScope,
    proof: LeaseProof,
  ): Promise<StoppedRecordingJobRow> {
    const job = (
      await client.query<StoppedRecordingJobRow>(
        `SELECT j.*,r.context_version AS context_version,r.status AS run_status,r.termination_reason AS run_termination_reason
         FROM jobs j JOIN runs r ON r.project_id=j.project_id AND r.id=j.run_id
         WHERE j.project_id=$1 AND j.id=$2 AND j.fencing_token=$3
           AND r.execution_mode='smoke'
           AND j.role IN ('explorer','executor','reproducer')
         FOR UPDATE OF j`,
        [scope.projectId, proof.taskId, proof.fencingToken],
      )
    ).rows[0];
    if (!job) throw new StorageError('LEASE_EXPIRED');
    if (
      job.result &&
      Object.prototype.hasOwnProperty.call(job.result, 'taskRecording')
    )
      throw new StorageError('IDEMPOTENCY_CONFLICT');
    const now = Date.now();
    const windowMs = 5 * 60_000;
    const finishedAt = job.finished_at?.getTime() ?? null;
    const leaseUntil = job.lease_until?.getTime() ?? null;
    if (['cancelled', 'interrupted', 'failed'].includes(job.status)) {
      if (finishedAt === null || finishedAt < now - windowMs)
        throw new StorageError('POLICY_DENIED');
      return job;
    }
    const aborting =
      job.status === 'running' &&
      (['cancelling', 'cancelled', 'failed'].includes(job.run_status) ||
        [
          'budget_limit',
          'model_failure',
          'setup_failure',
          'user_cancel',
        ].includes(job.run_termination_reason ?? '') ||
        proof.contextVersion !== job.context_version ||
        (leaseUntil !== null &&
          leaseUntil <= now &&
          leaseUntil >= now - windowMs));
    if (!aborting) throw new StorageError('POLICY_DENIED');
    return job;
  }

  /** Resolve the run directory for a stopped recording before writing bytes. */
  async stoppedRecordingTarget(
    scope: WorkerScope,
    proof: LeaseProof,
  ): Promise<{ runId: string }> {
    return this.tx(async (client) => {
      const job = await this.lockStoppedRecordingJob(client, scope, proof);
      return { runId: job.run_id };
    });
  }

  /**
   * Attach the already-written stopped-recording artifacts and their
   * TaskRecording snapshot in one transaction. This is not a finish: job/case
   * statuses, verdicts and findings are untouched.
   */
  async saveStoppedRecording(
    scope: WorkerScope,
    proof: LeaseProof,
    entries: readonly StoppedRecordingArtifact[],
    recording: TaskRecording,
  ): Promise<void> {
    const parsedRecording = parseContract('TaskRecording', recording);
    if (
      parsedRecording.taskId !== proof.taskId ||
      !['degraded', 'missing'].includes(parsedRecording.status) ||
      entries.length === 0
    )
      throw new StorageError('VALIDATION_ERROR');
    await this.tx(async (client) => {
      const job = await this.lockStoppedRecordingJob(client, scope, proof);
      const inserted = new Map<string, Artifact['kind']>();
      for (const entry of entries) {
        const input = parseContract('Artifact', entry.artifact);
        if (
          input.projectId !== scope.projectId ||
          input.runId !== job.run_id ||
          input.taskId !== job.id ||
          !['rrweb', 'console', 'network'].includes(input.kind) ||
          !['available', 'degraded'].includes(input.status) ||
          input.redaction !== 'applied' ||
          entry.bytes.byteLength > 25 * 1024 * 1024 ||
          input.bytes !== entry.bytes.byteLength ||
          createHash('sha256').update(entry.bytes).digest('hex') !==
            input.sha256 ||
          inserted.has(input.id)
        )
          throw new StorageError('VALIDATION_ERROR');
        const artifact = parseContract('Artifact', {
          ...input,
          projectId: scope.projectId,
          runId: job.run_id,
          taskId: job.id,
          caseId: job.case_id,
          contentUrl: `/api/v1/projects/${scope.projectId}/runs/${job.run_id}/artifacts/${input.id}/content`,
        });
        await client.query(
          "INSERT INTO artifacts(id,project_id,run_id,task_id,step_id,case_id,snapshot_id,document,retain_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '30 days')",
          [
            artifact.id,
            scope.projectId,
            job.run_id,
            job.id,
            artifact.stepId,
            artifact.caseId,
            artifact.snapshotId,
            artifact,
          ],
        );
        await client.query(
          "INSERT INTO artifact_references(project_id,artifact_id,ref_kind,ref_id) VALUES($1,$2,'task',$3) ON CONFLICT DO NOTHING",
          [scope.projectId, artifact.id, job.id],
        );
        inserted.set(artifact.id, artifact.kind);
      }
      for (const [id, kind] of [
        [parsedRecording.rrwebArtifactId, 'rrweb'],
        [parsedRecording.consoleArtifactId, 'console'],
        [parsedRecording.networkArtifactId, 'network'],
      ] as const) {
        if (id !== null && inserted.get(id) !== kind)
          throw new StorageError('VALIDATION_ERROR');
      }
      await client.query(
        "UPDATE jobs SET result=COALESCE(result,'{}'::jsonb)||$2::jsonb WHERE id=$1",
        [job.id, JSON.stringify({ taskRecording: parsedRecording })],
      );
    });
  }
  async finish(
    scope: WorkerScope,
    proof: LeaseProof,
    result: Record<string, unknown>,
    results?: CriterionResult[],
    reason?: string,
  ): Promise<void> {
    await this.tx(async (client) => {
      const existing = (
        await client.query<JobRow>(
          'SELECT j.* FROM jobs j JOIN task_leases l ON l.task_id=j.id AND l.fencing_token=j.fencing_token WHERE j.id=$1 AND j.project_id=$2 AND l.token_hash=$3 AND l.worker_id=$4 AND j.fencing_token=$5 FOR UPDATE OF j',
          [
            proof.taskId,
            scope.projectId,
            hashToken(proof.leaseToken),
            scope.workerId,
            proof.fencingToken,
          ],
        )
      ).rows[0];
      if (existing?.document.summary === 'auth')
        throw new StorageError('POLICY_DENIED');
      if (existing && ['succeeded', 'failed'].includes(existing.status)) {
        if (
          existing.result_hash !==
          hashPayload({
            result,
            results: results ?? null,
            reason: reason ?? null,
          })
        )
          throw new StorageError('IDEMPOTENCY_CONFLICT');
        return;
      }
      const { job, run } = await this.validateLease(client, scope, proof);
      if (job.document.summary === 'auth')
        throw new StorageError('POLICY_DENIED');
      if (result['stage'] !== job.result?.['stage'])
        throw new StorageError('VALIDATION_ERROR');
      if (await this.sessions.read(client, run)) {
        if (result['stage'] === 'plan') {
          const failureCode = result['plannerFailureCode'];
          const failureHint = result['plannerFailureHint'];
          await this.sessions.applyPlan(
            client,
            run,
            job,
            result['decision'],
            typeof failureCode === 'string' ? failureCode : undefined,
            Array.isArray(failureHint) ? failureHint : undefined,
          );
        }
        if (result['stage'] === 'finalize')
          await this.sessions.conclude(client, run, result['conclusion']);
      }
      if (job.case_id) {
        if (!results) throw new StorageError('VALIDATION_ERROR');
        const definition = parseContract(
          'CaseDefinition',
          (
            await client.query(
              'SELECT document FROM run_cases WHERE id=$1 AND project_id=$2',
              [job.case_id, scope.projectId],
            )
          ).rows[0].document,
        );
        const attempt = (
          await client.query(
            "SELECT * FROM case_attempts WHERE task_id=$1 AND project_id=$2 AND status='running' ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE",
            [job.id, scope.projectId],
          )
        ).rows[0];
        if (!attempt) throw new StorageError('VALIDATION_ERROR');
        const evidence = (
          await client.query(
            "SELECT id FROM artifacts WHERE project_id=$1 AND run_id=$2 AND task_id=$3 AND document->>'status' IN ('available','degraded') AND document->>'redaction' IN ('applied','not_needed')",
            [scope.projectId, run.id, job.id],
          )
        ).rows.map((row) => row.id as string);
        // Mo-style sessions: the executing agent's own report is the
        // verdict. Frozen regression replays keep their fixed oracle.
        const byAgent =
          run.executionMode === 'smoke' && result['oracle'] === 'agent_report';
        const report = byAgent ? parseAgentReport(result['agentReport']) : null;
        const reported = byAgent ? verdictFromReport(report, reason) : null;
        const ownedEvidence = new Set(evidence);
        // The verdict guard (storage migration 002) rejects two report/status
        // combinations with a 23514 that surfaces as VALIDATION_ERROR:
        //   - issue_found without any failed criterion result;
        //   - passed without every case criterion passed on owned evidence.
        // A model report can hold either shape (e.g. "issue_found" with the
        // unverifiable criterion left unknown). Neither shape means the case
        // did not run: keep the report, record what it really says, and say
        // why in gaps instead of failing the whole finish.
        const unmetCriteria = definition.criteria.filter(
          (criterion) =>
            !results.some(
              (entry) =>
                entry.criterionId === criterion.id &&
                entry.result === 'passed' &&
                entry.evidenceRefs.some((id) => ownedEvidence.has(id)),
            ),
        );
        const failedCriteria = unmetCriteria.filter((criterion) =>
          results.some(
            (entry) =>
              entry.criterionId === criterion.id && entry.result === 'failed',
          ),
        );
        const undecidedCriteria = unmetCriteria.filter(
          (criterion) => !failedCriteria.includes(criterion),
        );
        const hasFailedCriterion = results.some(
          (entry) => entry.result === 'failed',
        );
        const reportedStatus = reported?.status ?? null;
        // An issue the agent named in bug but could not tie to a failed
        // criterion is still a real observation. Keep issue_found and add a
        // synthetic failed criterion (agent_reported_issue) instead of
        // rewriting one of the agent's own results: readers match results by
        // definition criterion id and ignore the extra entry, while the guard
        // and the finding fallback accept it. Without a bug there is nothing
        // concrete to report, so the case is inconclusive.
        const agentIssue =
          reportedStatus === 'issue_found' && !hasFailedCriterion
            ? (report?.bug ?? null)
            : null;
        const status =
          reportedStatus === 'issue_found' && !hasFailedCriterion && !agentIssue
            ? 'inconclusive'
            : reportedStatus === 'passed' && unmetCriteria.length > 0
              ? 'inconclusive'
              : (reportedStatus ??
                verdictStatus(
                  definition,
                  results,
                  ownedEvidence,
                  reason === 'WORKER_INTERRUPTED' ? undefined : reason,
                ));
        const criterionState = (criterion: { id: string }) => {
          const judged = results.find(
            (entry) => entry.criterionId === criterion.id,
          );
          if (!judged) return '未给出判定';
          if (
            judged.result === 'passed' &&
            !judged.evidenceRefs.some((id) => ownedEvidence.has(id))
          )
            return '判为 passed 但缺少本任务可用证据';
          return judged.result;
        };
        const statusCorrection =
          reportedStatus && status !== reportedStatus
            ? reportedStatus === 'issue_found'
              ? '报告把用例标记为 issue_found，但没有任何验收标准判为 failed，也没有报告具体缺陷；按 inconclusive 记录，具体观察见 summary/gaps。'
              : `报告把用例标记为 passed，但${[
                  ...failedCriteria.map(
                    (criterion) =>
                      `${criterion.id} 判为 failed（报告与验收标准自相矛盾）`,
                  ),
                  ...undecidedCriteria.map(
                    (criterion) =>
                      `${criterion.id} 未能判定（${criterionState(criterion)}），未计为通过`,
                  ),
                ].join('，')}；按 inconclusive 记录，具体观察见 summary/gaps。`
            : null;
        // CriterionResults is capped at 20, so a full list cannot take the
        // synthetic entry; fail the first criterion the agent did not pass
        // instead (falling back to the first one), which is also the fallback
        // the finding below uses when no listed criterion failed.
        const agentIssueRefs = [
          ...new Set(results.flatMap((entry) => entry.evidenceRefs)),
        ]
          .filter((ref) => ownedEvidence.has(ref))
          .slice(0, 30);
        const failedFallbackIndex = Math.max(
          0,
          results.findIndex((entry) => entry.result !== 'passed'),
        );
        const criterionResults = agentIssue
          ? results.length < 20
            ? [
                ...results,
                {
                  criterionId: 'agent_reported_issue',
                  result: 'failed' as const,
                  reason: `执行代理报告了缺陷：${agentIssue.title}`,
                  evidenceRefs: agentIssueRefs,
                },
              ]
            : results.map((entry, index) =>
                index === failedFallbackIndex
                  ? {
                      ...entry,
                      result: 'failed' as const,
                      reason: `执行代理报告了缺陷：${agentIssue.title}`,
                    }
                  : entry,
              )
          : results;
        const verdict = parseContract('Verdict', {
          id: randomUUID(),
          caseId: job.case_id,
          attemptId: attempt.id,
          status,
          reasonCode: reported
            ? status === reported.status
              ? reported.reasonCode
              : status === 'inconclusive'
                ? 'AGENT_INCONCLUSIVE'
                : 'AGENT_BLOCKED'
            : (reason ??
              (status === 'passed'
                ? 'OBSERVED'
                : status === 'issue_found'
                  ? 'CRITERION_FAILED'
                  : 'INSUFFICIENT_EVIDENCE')),
          summary:
            reported?.summary ??
            reason ??
            'Fixed criteria evaluated against owned observations',
          criterionResults,
          gaps: [
            // The platform correction goes first so a report with 30 gaps of
            // its own cannot push the explanation out of the list.
            ...(statusCorrection ? [statusCorrection] : []),
            ...(reported?.gaps ??
              (status === 'passed' || status === 'issue_found'
                ? []
                : [reason ?? 'Criteria not fully evaluated'])),
          ].slice(0, 30),
          ...(reported ? { verified: reported.verified } : {}),
          createdAt: new Date().toISOString(),
        });
        await client.query(
          'INSERT INTO verdicts(id,project_id,case_id,attempt_id,document,payload_hash,fencing_token) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            verdict.id,
            scope.projectId,
            job.case_id,
            attempt.id,
            verdict,
            hashPayload(verdict),
            proof.fencingToken,
          ],
        );
        await client.query(
          "UPDATE case_attempts SET status='completed',finished_at=clock_timestamp() WHERE id=$1",
          [attempt.id],
        );
        await appendEvent(client, scope.projectId, run.id, 'case.result', {
          definition,
          outcome: status,
          verdict,
        });
        if (job.role === 'executor' && status === 'issue_found') {
          // An agent may report an issue outside any one listed criterion.
          const failed =
            definition.criteria.find((k) =>
              results.some(
                (r) => r.criterionId === k.id && r.result === 'failed',
              ),
            ) ?? definition.criteria[0]!;
          // Only this attempt's usable material may back the finding; a stray
          // reference is dropped rather than failing the agent's report.
          const refs = [
            ...new Set(results.flatMap((r) => r.evidenceRefs)),
          ].filter((ref) => evidence.includes(ref));
          const sessionManaged =
            (await this.sessions.read(client, run)) !== null;
          const fingerprint = sessionManaged
            ? hashPayload({
                entryUrl: job.result?.['entryUrl'] ?? run.targetUrl,
                requiresLogin: definition.requiresLogin !== false,
                preconditions: definition.preconditions,
                outline: definition.outline,
                criterion: {
                  kind: failed.kind,
                  sourceKind: failed.sourceKind,
                  sourceRef: failed.sourceRef,
                  description: failed.description
                    .trim()
                    .replace(/\s+/g, ' ')
                    .toLowerCase(),
                  locator: failed.locator,
                  expectedValue: failed.expectedValue,
                },
              })
            : hashPayload([definition.id, failed.id]);
          const duplicate = sessionManaged
            ? (
                await client.query<{ id: string; document: unknown }>(
                  "SELECT id,document FROM findings WHERE project_id=$1 AND run_id=$2 AND fingerprint=$3 AND status IN ('suspected','confirmed') AND COALESCE(document->>'triageDisposition','open')<>'duplicate' AND document->>'duplicateOf' IS NULL ORDER BY id LIMIT 1 FOR UPDATE",
                  [scope.projectId, run.id, fingerprint],
                )
              ).rows[0]
            : undefined;
          if (duplicate) {
            const old = parseContract('Finding', duplicate.document);
            const grouped = parseContract('Finding', {
              ...old,
              version: old.version + 1,
              caseIds: [...new Set([...old.caseIds, definition.id])],
              evidenceRefs: [...new Set([...old.evidenceRefs, ...refs])],
            });
            await client.query(
              'UPDATE findings SET version=version+1,document=$2 WHERE id=$1 AND project_id=$3',
              [old.id, grouped, scope.projectId],
            );
            await linkMergedFindingEvidence(client, run, old.id, refs);
            await appendEvent(
              client,
              scope.projectId,
              run.id,
              'finding.updated',
              grouped,
            );
          } else {
            const finding = parseContract('Finding', {
              id: randomUUID(),
              runId: run.id,
              caseIds: [definition.id],
              kind: 'functional',
              status: 'suspected',
              title: report?.bug?.title || definition.title,
              severity: 'medium',
              expected: report?.bug?.expected || failed.description,
              actual:
                report?.bug?.actual ||
                report?.summary ||
                'Fixed sourced criterion failed',
              expectedSource: failed.sourceKind,
              reproSteps: definition.outline,
              evidenceRefs: refs,
              reproductionRef: null,
              triageDisposition: 'open',
              version: 1,
            });
            await client.query(
              "INSERT INTO findings(id,project_id,run_id,case_id,original_attempt_id,criteria_hash,fingerprint,kind,status,expected_source,document) VALUES($1,$2,$3,$4,$5,$6,$7,'functional','suspected',$8,$9)",
              [
                finding.id,
                scope.projectId,
                run.id,
                definition.id,
                attempt.id,
                criteriaHash(definition),
                fingerprint,
                failed.sourceKind,
                finding,
              ],
            );
            for (const ref of refs)
              await client.query(
                'INSERT INTO finding_evidence(project_id,finding_id,artifact_id) VALUES($1,$2,$3)',
                [scope.projectId, finding.id, ref],
              );
            await appendEvent(
              client,
              scope.projectId,
              run.id,
              'finding.updated',
              finding,
            );
          }
        }
        if (job.role === 'reproducer') {
          const findingId = job.result?.['findingId'];
          const row = (
            await client.query(
              'SELECT * FROM findings WHERE id=$1 AND project_id=$2 FOR UPDATE',
              [findingId, scope.projectId],
            )
          ).rows[0];
          if (!row || row.criteria_hash !== criteriaHash(definition))
            throw new StorageError('VALIDATION_ERROR');
          const refs = [...new Set(results.flatMap((r) => r.evidenceRefs))];
          // Do not trust the caller's freshContext declaration. The server
          // owns attempt/context identities and both sets of artifact links.
          const original = (
            await client.query<{
              context_id: string;
              verdict_status: string | null;
            }>(
              `SELECT a.context_id,v.document->>'status' AS verdict_status
               FROM case_attempts a
               LEFT JOIN verdicts v ON v.project_id=a.project_id
                 AND v.attempt_id=a.id AND v.valid=true
               WHERE a.project_id=$1 AND a.id=$2 AND a.case_id=$3`,
              [scope.projectId, row.original_attempt_id, job.case_id],
            )
          ).rows[0];
          if (
            !original ||
            original.context_id === attempt.context_id ||
            row.original_attempt_id === attempt.id
          )
            throw new StorageError('VALIDATION_ERROR');
          const originalRefs = new Set<string>(
            (
              await client.query<{ artifact_id: string }>(
                'SELECT artifact_id FROM finding_evidence WHERE project_id=$1 AND finding_id=$2',
                [scope.projectId, findingId],
              )
            ).rows.map((r) => r.artifact_id),
          );
          const independentEvidence =
            original.verdict_status === 'issue_found' &&
            originalRefs.size > 0 &&
            refs.length > 0 &&
            refs.every((ref) => !originalRefs.has(ref));
          const outcome =
            status === 'issue_found' && independentEvidence
              ? 'reproduced'
              : status === 'passed' && independentEvidence
                ? 'not_reproduced'
                : 'blocked';
          const reproduction = parseContract('Reproduction', {
            id: randomUUID(),
            findingId,
            taskId: job.id,
            outcome,
            freshContext: true,
            summary: report?.summary || `Independent reproduction: ${outcome}`,
            evidenceRefs: refs,
            createdAt: new Date().toISOString(),
          });
          await client.query(
            'INSERT INTO reproductions(id,project_id,run_id,finding_id,task_id,attempt_id,criteria_hash,fresh_context,outcome,document) VALUES($1,$2,$3,$4,$5,$6,$7,true,$8,$9)',
            [
              reproduction.id,
              scope.projectId,
              run.id,
              findingId,
              job.id,
              attempt.id,
              row.criteria_hash,
              outcome,
              reproduction,
            ],
          );
          for (const ref of refs)
            await client.query(
              'INSERT INTO reproduction_evidence(project_id,reproduction_id,artifact_id) VALUES($1,$2,$3)',
              [scope.projectId, reproduction.id, ref],
            );
          const f = parseContract('Finding', row.document);
          const recording = await reproductionRecordingIn(client, {
            projectId: scope.projectId,
            runId: run.id,
            taskId: job.id,
            reproductionId: reproduction.id,
            finding: f,
            outcome,
            taskRecording: result['taskRecording'],
            anchors: report?.reproStepActions,
          });
          const updated = {
            ...f,
            recording,
            // Reproduced by an independent agent from a clean start: confirmed.
            status:
              outcome === 'reproduced' && independentEvidence
                ? 'confirmed'
                : outcome === 'not_reproduced'
                  ? 'unconfirmed'
                  : 'blocked',
            reproductionRef: reproduction.id,
            version: f.version + 1,
          };
          await client.query(
            'UPDATE findings SET status=$2,reproduction_id=$3,version=version+1,document=$4 WHERE id=$1',
            [findingId, updated.status, reproduction.id, updated],
          );
          await appendEvent(
            client,
            scope.projectId,
            run.id,
            'finding.updated',
            updated,
          );
        }
      }
      if (
        (
          await client.query(
            "SELECT 1 FROM action_intents WHERE project_id=$1 AND task_id=$2 AND outcome='pending' LIMIT 1",
            [scope.projectId, job.id],
          )
        ).rowCount
      )
        throw new StorageError('VALIDATION_ERROR');
      await this.pulse(client, scope.projectId, run.id);
      await this.releaseSlots(client, scope.projectId, job.id);
      const importDeadline = await this.authImportService.endTask(
        client,
        scope,
        proof,
      );
      // A task that signed in itself releases its account with its result.
      await this.authExecution.endTaskSignIn(
        client,
        scope.projectId,
        job.id,
        'task_finished',
      );
      const finishTime = (
        await client.query<{
          started_at: Date | null;
          finished_at: Date | null;
        }>(
          "UPDATE jobs SET status='succeeded',result=$2,result_hash=$3,finished_at=clock_timestamp() WHERE id=$1 RETURNING started_at,finished_at",
          [
            job.id,
            { ...job.result, ...result },
            hashPayload({
              result,
              results: results ?? null,
              reason: reason ?? null,
            }),
          ],
        )
      ).rows[0];
      await client.query(
        'UPDATE task_leases SET released_at=clock_timestamp() WHERE task_id=$1 AND fencing_token=$2',
        [job.id, proof.fencingToken],
      );
      await this.pulse(client, scope.projectId, run.id);
      await appendEvent(client, scope.projectId, run.id, 'task.updated', {
        ...job.document,
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
      if (importDeadline) {
        const now = (
          await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        ).rows[0]!.now;
        if (now >= importDeadline) throw new StorageError('LEASE_EXPIRED');
      }
      if (
        ['explore', 'execute', 'reproduce', 'recover'].includes(
          String(result['stage']),
        )
      ) {
        const current = await runDTO(client, scope.projectId, run.id);
        if (
          current.status === 'running' &&
          ![
            'budget_limit',
            'input_timeout',
            'model_failure',
            'setup_failure',
          ].includes(current.terminationReason ?? '') &&
          current.budgetUsed.activeSeconds <
            current.effectiveConfig.budget.maxActiveSeconds
        ) {
          const jobs = (
            await client.query<JobRow>(
              'SELECT * FROM jobs WHERE project_id=$1 AND run_id=$2',
              [scope.projectId, run.id],
            )
          ).rows;
          // Dispatch is committed with the result. The manager's model call
          // remains a separately leased job, outside this transaction.
          await this.sessions.advance(client, current, jobs);
        }
      }
    });
  }
  /** Caller holds the run lock. Persist the one cutoff window in immutable
   * audit_log, not a new migration or a worker-supplied result field. */
  async checkTimeBudget(client: PoolClient, run: Run): Promise<Run> {
    if (run.status !== 'running' || (run.terminationReason && run.terminationReason !== 'worker_failure') ||
      run.budgetUsed.activeSeconds < run.effectiveConfig.budget.maxActiveSeconds) return run;
    if (graceEligibleRun(run) && await this.sessions.read(client, run)) {
      const clock = (await client.query<{ now: Date; sample: { sampleAt: number; carry: number } | null }>(
        `SELECT clock_timestamp() AS now,(SELECT redacted_summary FROM audit_log
         WHERE project_id=$1 AND object_id=$2 AND action='active.sample'
         ORDER BY created_at DESC,id DESC LIMIT 1) AS sample`, [run.projectId, run.id],
      )).rows[0]!;
      const deadline = graceDeadline(run.budgetUsed.activeSeconds + (clock.sample?.carry ?? 0),
        run.effectiveConfig.budget.maxActiveSeconds, new Date(clock.sample?.sampleAt ?? clock.now));
      const cutoff = new Date(Date.parse(deadline) - REPRODUCTION_BUDGET_GRACE_SECONDS * 1000).toISOString();
      const eligible = (await client.query<{ id: string; fencing_token: string }>(
        `SELECT id,fencing_token FROM jobs WHERE project_id=$1 AND run_id=$2
         AND role='reproducer' AND document->>'summary'='reproduce'
         AND status='running' AND started_at<=$3::timestamptz AND lease_until>clock_timestamp()`,
        [run.projectId, run.id, cutoff],
      )).rows;
      await client.query(
        `INSERT INTO audit_log(project_id,actor_id,action,object_id,result,redacted_summary,created_at)
         VALUES($1,actor_id(),'reproduction.grace',$2,'ok',$3,clock_timestamp())`,
        [run.projectId, run.id, { deadline, tasks: eligible }],
      );
    }
    return this.change(client, run, 'running', run.phase, 'budget_limit');
  }
  async inReproductionGrace(client: PoolClient, run: Run, job: JobRow): Promise<boolean> {
    if (run.status !== 'running' || run.terminationReason !== 'budget_limit' ||
      job.status !== 'running' || job.role !== 'reproducer' ||
      job.document.summary !== 'reproduce') return false;
    const row = (await client.query<{
      redacted_summary: { deadline: string; tasks: { id: string; fencing_token: string }[] };
      now: Date;
    }>(`SELECT redacted_summary,clock_timestamp() AS now FROM audit_log
         WHERE project_id=$1 AND object_id=$2 AND action='reproduction.grace'
         ORDER BY created_at DESC,id DESC LIMIT 1`, [run.projectId, run.id])).rows[0];
    return Boolean(row && Date.parse(row.redacted_summary.deadline) > row.now.getTime() &&
      row.redacted_summary.tasks.some((task) => task.id === job.id &&
        String(task.fencing_token) === String(job.fencing_token)));
  }
  async pulse(
    client: PoolClient,
    projectId: string,
    runId: string,
  ): Promise<void> {
    const previous = (
      await client.query(
        "SELECT redacted_summary FROM audit_log WHERE project_id=$1 AND object_id=$2 AND action='active.sample' ORDER BY created_at DESC,id DESC LIMIT 1",
        [projectId, runId],
      )
    ).rows[0]?.redacted_summary;
    const now = Number(
      (
        await client.query(
          'SELECT extract(epoch FROM clock_timestamp())*1000 milliseconds',
        )
      ).rows[0].milliseconds,
    );
    const active = Boolean(
      (
        await client.query(
          "SELECT 1 FROM jobs WHERE project_id=$1 AND run_id=$2 AND status='running' LIMIT 1",
          [projectId, runId],
        )
      ).rowCount,
    );
    const elapsed = previous?.active
      ? Math.max(0, (now - previous.sampleAt) / 1000)
      : 0;
    const seconds = elapsed + (previous?.carry ?? 0);
    const whole = Math.floor(seconds);
    if (whole)
      await client.query(
        "UPDATE run_budgets SET used=jsonb_set(used,'{activeSeconds}',to_jsonb((used->>'activeSeconds')::integer+$3::integer)) WHERE project_id=$1 AND run_id=$2",
        [projectId, runId, whole],
      );
    await client.query(
      "INSERT INTO audit_log(project_id,actor_id,action,object_id,result,redacted_summary,created_at) VALUES($1,actor_id(),'active.sample',$2,'ok',$3,clock_timestamp())",
      [projectId, runId, { sampleAt: now, active, carry: seconds - whole }],
    );
  }
  async releaseSlots(
    client: PoolClient,
    projectId: string,
    taskId: string,
  ): Promise<void> {
    await client.query(
      "UPDATE budget_reservations SET status='released',charged='{}' WHERE project_id=$1 AND task_id=$2 AND kind='concurrency' AND status='reserved'",
      [projectId, taskId],
    );
  }
  async cancel(actor: Actor, projectId: string, runId: string): Promise<Run> {
    return this.db.actor(actor, async (client) => {
      await authorize(client, projectId, 'run');
      await client.query(
        'SELECT id FROM runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
        [projectId, runId],
      );
      const run = await runDTO(client, projectId, runId);
      if (TERMINAL.has(run.status) || run.status === 'cancelling') return run;
      return this.change(client, run, 'cancelling', run.phase, 'user_cancel');
    });
  }
  async waitForInput(
    scope: WorkerScope,
    proof: LeaseProof,
    kind: InputRequest['kind'],
    prompt: string,
    expiresMs = 60000,
    options?: string[],
    sessionDecision?: unknown,
  ): Promise<InputRequest> {
    return this.tx(async (client) => {
      const { job, run } = await this.validateLease(client, scope, proof);
      if (
        !Number.isSafeInteger(expiresMs) ||
        expiresMs < 1 ||
        // A Mo-style question waits for the user; waiting time is not active.
        expiresMs > 86400000
      )
        throw new StorageError('VALIDATION_ERROR');
      const input = parseContract('InputRequest', {
        id: randomUUID(),
        runId: run.id,
        kind,
        status: 'pending',
        prompt,
        expiresAt: new Date(Date.now() + expiresMs).toISOString(),
        version: 1,
        ...(options?.length ? { options } : {}),
      });
      if (sessionDecision !== undefined) {
        if (
          kind !== 'clarification' ||
          job.role !== 'coordinator' ||
          job.result?.['stage'] !== 'plan'
        )
          throw new StorageError('FORBIDDEN');
        const { decision } = parseSessionDecision(sessionDecision);
        if (
          decision.action !== 'ask' ||
          decision.question?.trim() !== prompt.trim() ||
          decision.cases.length ||
          decision.exploreTargets.length
        )
          throw new StorageError('VALIDATION_ERROR');
        // A question must not discard this round's finding review. Apply it
        // in the same transaction before releasing the manager's lease.
        await this.sessions.applyPlan(client, run, job, sessionDecision);
      }
      await client.query(
        'INSERT INTO input_requests(id,project_id,run_id,version,document) VALUES($1,$2,$3,1,$4)',
        [input.id, scope.projectId, run.id, input],
      );
      await this.pulse(client, scope.projectId, run.id);
      await client.query(
        "UPDATE jobs SET status='waiting',result=result||$2::jsonb WHERE id=$1",
        [
          job.id,
          JSON.stringify({ inputId: input.id, previousPhase: run.phase }),
        ],
      );
      await client.query(
        'UPDATE task_leases SET released_at=clock_timestamp() WHERE task_id=$1',
        [job.id],
      );
      await this.releaseSlots(client, scope.projectId, job.id);
      await this.pulse(client, scope.projectId, run.id);
      await appendEvent(
        client,
        scope.projectId,
        run.id,
        'input.requested',
        input,
      );
      if (
        !(
          await client.query(
            "SELECT 1 FROM jobs WHERE project_id=$1 AND run_id=$2 AND status IN ('queued','running') LIMIT 1",
            [scope.projectId, run.id],
          )
        ).rowCount
      )
        await this.change(client, run, 'awaiting_input');
      return input;
    });
  }
  async resolveClarification(
    actor: Actor,
    projectId: string,
    inputId: string,
    expectedVersion: number,
    text?: string,
    decision: 'provide' | 'approve' | 'reject' = 'provide',
  ): Promise<InputRequest> {
    return this.db.actor(actor, async (client) => {
      await authorize(client, projectId, 'run');
      const candidate = (
        await client.query(
          'SELECT run_id FROM input_requests WHERE project_id=$1 AND id=$2',
          [projectId, inputId],
        )
      ).rows[0];
      if (!candidate) throw new StorageError('NOT_FOUND');
      const jobs = (
        await client.query<JobRow>(
          "SELECT * FROM jobs WHERE project_id=$1 AND run_id=$2 AND result->>'inputId'=$3 FOR UPDATE",
          [projectId, candidate.run_id, inputId],
        )
      ).rows;
      await client.query(
        'SELECT id FROM runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
        [projectId, candidate.run_id],
      );
      const run = await runDTO(client, projectId, candidate.run_id);
      const row = (
        await client.query(
          'SELECT document FROM input_requests WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, inputId],
        )
      ).rows[0];
      const input = parseContract('InputRequest', row.document);
      if (
        input.version !== expectedVersion ||
        input.status !== 'pending' ||
        Date.parse(input.expiresAt) <= Date.now()
      )
        throw new StorageError('VERSION_CONFLICT');
      if (
        input.kind !== 'clarification' ||
        TERMINAL.has(run.status) ||
        run.status === 'cancelling'
      )
        throw new StorageError('VALIDATION_ERROR');
      const updated = {
        ...input,
        status: decision === 'reject' ? 'rejected' : 'resolved',
        version: input.version + 1,
      };
      if (decision !== 'reject' && text?.trim())
        await client.query(
          'INSERT INTO run_messages(id,project_id,run_id,actor_id,context_version,redacted_text) VALUES($1,$2,$3,$4,$5,$6)',
          [
            randomUUID(),
            projectId,
            run.id,
            actor.userId,
            run.contextVersion,
            text.trim(),
          ],
        );
      await client.query(
        'UPDATE input_requests SET document=$2,version=version+1,actor_id=actor_id() WHERE id=$1',
        [inputId, updated],
      );
      for (const job of jobs) {
        if (job.status !== 'waiting') continue;
        if (decision === 'reject') {
          await this.interrupt(client, run, job, 'cancelled');
          continue;
        }
        const acted = (
          await client.query(
            'SELECT 1 FROM action_intents WHERE project_id=$1 AND task_id=$2 LIMIT 1',
            [projectId, job.id],
          )
        ).rowCount;
        if (acted) {
          await client.query(
            'UPDATE jobs SET result=result||\'{"interruptionReason":"user_input"}\'::jsonb WHERE id=$1',
            [job.id],
          );
          await this.interrupt(client, run, job, 'interrupted');
        } else {
          await client.query(
            "UPDATE case_attempts SET status='interrupted',finished_at=clock_timestamp() WHERE project_id=$1 AND task_id=$2 AND status='running'",
            [projectId, job.id],
          );
          await client.query(
            "UPDATE jobs SET status='queued',result=result||'{\"inputId\":null}'::jsonb WHERE id=$1",
            [job.id],
          );
          await appendEvent(client, projectId, run.id, 'task.updated', {
            ...job.document,
            status: 'queued',
          });
        }
      }
      if (run.status === 'awaiting_input')
        await this.change(client, run, 'running', run.phase);
      if (decision === 'reject') {
        const session = await this.sessions.read(client, run);
        if (session)
          await this.sessions.write(client, run, {
            ...session,
            status: 'finalizing',
            planningStopped: true,
            coverageGaps: [
              ...session.coverageGaps,
              '用户拒绝补充信息，未完成的范围保留在报告中。',
            ].slice(0, 100),
          });
      }
      await appendEvent(client, projectId, run.id, 'input.resolved', updated);
      await audit(
        client,
        'input.acknowledged',
        inputId,
        projectId,
        updated.version,
      );
      return parseContract('InputRequest', updated);
    });
  }
  async tick(projectId: string): Promise<void> {
    await this.leases.recoverExpired({
      projectId,
      workerId: 'coordinator-recovery',
    });
    await this.tx(async (client) => {
      await client.query(
        "UPDATE model_requests m SET status='unknown',redacted_diagnostic=redacted_diagnostic||'{\"usageSource\":\"unknown\"}'::jsonb FROM budget_reservations b WHERE m.reservation_id=b.id AND m.project_id=$1 AND b.status='unknown' AND m.status='reserved'",
        [projectId],
      );
      const staleSteps = (
        await client.query(
          "SELECT s.* FROM steps s JOIN action_intents a ON a.id=s.action_id WHERE s.project_id=$1 AND a.outcome='unknown' AND s.document->>'status'='running'",
          [projectId],
        )
      ).rows;
      for (const row of staleSteps) {
        const step = {
          ...row.document,
          status: 'unknown',
          summary: 'Worker interrupted; action will not be replayed',
          finishedAt: new Date().toISOString(),
        };
        await client.query('UPDATE steps SET document=$2 WHERE id=$1', [
          row.id,
          step,
        ]);
        await appendEvent(client, projectId, row.run_id, 'step.recorded', step);
      }
      // Finished runs keep no exclusive credential. finalize() releases its own
      // lock; this also frees locks left by runs that ended before that fix.
      await client.query(
        "UPDATE auth_profile_run_locks l SET status='released', released_at=clock_timestamp(), release_reason='run_finished' FROM runs r WHERE l.project_id=$1 AND r.project_id=l.project_id AND r.id=l.run_id AND l.status='held' AND r.status IN ('completed','cancelled','failed')",
        [projectId],
      );
      // Reconcile capacity left by a completed or requeued task. Stale
      // reservations must not permanently starve all control jobs.
      await client.query(
        "UPDATE budget_reservations b SET status='released',charged='{}' FROM jobs j WHERE b.project_id=$1 AND b.task_id=j.id AND b.kind='concurrency' AND b.status='reserved' AND j.status<>'running'",
        [projectId],
      );
      const ids = (
        await client.query(
          "SELECT id FROM runs WHERE project_id=$1 AND status NOT IN ('completed','cancelled','failed') ORDER BY id",
          [projectId],
        )
      ).rows;
      for (const { id } of ids) {
        const jobs = (
          await client.query<JobRow>(
            'SELECT * FROM jobs WHERE project_id=$1 AND run_id=$2 ORDER BY id FOR UPDATE',
            [projectId, id],
          )
        ).rows;
        await client.query(
          'SELECT id FROM runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, id],
        );
        let run = await runDTO(client, projectId, id);
        if (TERMINAL.has(run.status)) continue;
        await this.pulse(client, projectId, id);
        run = await runDTO(client, projectId, id);
        run = await this.checkTimeBudget(client, run);
        if (
          ['budget_limit', 'model_failure', 'setup_failure'].includes(
            run.terminationReason ?? '',
          )
        ) {
          for (const j of jobs.filter(
            (j) =>
              ['queued', 'running', 'waiting'].includes(j.status) &&
              (run.terminationReason === 'budget_limit' || !['recover', 'finalize'].includes(
                String(j.result?.['stage'] ?? j.document.summary),
              )),
          )) {
            if (await this.inReproductionGrace(client, run, j)) continue;
            await this.interrupt(client, run, j, 'cancelled');
            j.status = 'cancelled';
          }
        }
        const pending = (
          await client.query<{ document: InputRequest }>(
            "SELECT document FROM input_requests WHERE project_id=$1 AND run_id=$2 AND document->>'status'='pending' FOR UPDATE",
            [projectId, id],
          )
        ).rows;
        for (const row of pending) {
          if (Date.parse(row.document.expiresAt) <= Date.now()) {
            const input = {
              ...row.document,
              status: 'expired',
              version: row.document.version + 1,
            };
            await client.query(
              'UPDATE input_requests SET document=$2,version=version+1 WHERE id=$1',
              [input.id, input],
            );
            await appendEvent(client, projectId, id, 'input.resolved', input);
            for (const j of jobs.filter(
              (j) =>
                j.status === 'waiting' && j.result?.['inputId'] === input.id,
            )) {
              await this.interrupt(client, run, j, 'interrupted');
              j.status = 'interrupted';
            }
            if (
              ['awaiting_input', 'running'].includes(run.status) &&
              !['budget_limit', 'model_failure', 'setup_failure'].includes(
                run.terminationReason ?? '',
              )
            )
              run = await this.change(
                client,
                run,
                'running',
                run.phase,
                'input_timeout',
              );
          }
        }
        if (run.status === 'cancelling') {
          for (const j of jobs.filter((j) =>
            ['queued', 'running', 'waiting'].includes(j.status),
          )) {
            await this.interrupt(client, run, j, 'cancelled');
          }
          await this.finalize(client, run, 'user_cancel', 'cancelled');
          continue;
        }
        for (const j of jobs.filter(
          (j) => j.status === 'interrupted' && j.case_id && run.terminationReason !== 'budget_limit',
        )) {
          const hasVerdict = (
            await client.query(
              'SELECT 1 FROM case_attempts a JOIN verdicts v ON v.attempt_id=a.id WHERE a.project_id=$1 AND a.task_id=$2',
              [projectId, j.id],
            )
          ).rowCount;
          if (!hasVerdict) {
            await this.enqueue(
              client,
              run,
              'executor',
              'recover',
              j.id,
              j.case_id,
              j.document.attempt + 1,
              { previousTaskId: j.id },
            );
            if (
              !run.terminationReason &&
              j.result?.['interruptionReason'] !== 'user_input'
            )
              run = await this.change(
                client,
                run,
                'running',
                run.phase,
                'worker_failure',
              );
          }
        }
        const refreshed = (
          await client.query<JobRow>(
            'SELECT * FROM jobs WHERE project_id=$1 AND run_id=$2',
            [projectId, id],
          )
        ).rows;
        const active = refreshed.some((j) =>
          ['queued', 'running'].includes(j.status),
        );
        if (
          !active &&
          refreshed.some((j) => j.status === 'waiting') &&
          pending.some((row) => Date.parse(row.document.expiresAt) > Date.now())
        ) {
          if (run.status === 'running')
            await this.change(client, run, 'awaiting_input');
          continue;
        }
        if (
          ![
            'budget_limit',
            'input_timeout',
            'model_failure',
            'setup_failure',
          ].includes(run.terminationReason ?? '') &&
          ['explore', 'plan', 'execute', 'reproduce', 'finalize'].includes(
            run.phase,
          ) &&
          (await this.sessions.advance(client, run, refreshed))
        )
          continue;
        if (active) continue;
        if (
          run.terminationReason &&
          [
            'budget_limit',
            'input_timeout',
            'model_failure',
            'setup_failure',
          ].includes(run.terminationReason)
        ) {
          await this.finalize(client, run, run.terminationReason, 'completed');
          continue;
        }
        const succeeded = (stage: Stage) =>
          refreshed.some(
            (j) =>
              j.status === 'succeeded' &&
              (j.result?.['stage'] ?? j.document.summary) === stage,
          );
        if (
          run.phase === 'auth' &&
          !succeeded('auth') &&
          refreshed.some(
            (j) =>
              (j.result?.['stage'] ?? j.document.summary) === 'auth' &&
              ['interrupted', 'failed', 'cancelled'].includes(j.status),
          )
        ) {
          // Ambiguous authentication must not hang or be replayed with old
          // tokens after a Worker crash. A new run gets a new lease and scope.
          // (Sessions have no run-level auth job; their agents sign in.)
          await this.finalize(client, run, 'setup_failure', 'completed');
          continue;
        }
        if (
          run.phase === 'preflight' &&
          succeeded('preflight') &&
          run.executionMode === 'regression'
        ) {
          run = await this.startRegressionAfterPreflight(client, run);
        } else if (run.phase === 'preflight' && succeeded('preflight')) {
          run = await this.startSmokeAfterPreflight(client, run);
        } else if (run.phase === 'auth' && succeeded('auth')) {
          // finishAuth alone can mark the auth job successful after a real,
          // server-verified criterion and state capture. Normal job finish
          // explicitly refuses to forge this result.
          if (run.executionMode === 'regression') {
            run = await this.startApprovedRegression(client, run);
          } else {
            run = await this.startSmokeAfterAuth(client, run);
          }
        } else if (run.phase === 'explore' && succeeded('explore')) {
          run = await this.change(client, run, 'running', 'plan');
          await this.enqueue(client, run, 'coordinator', 'plan', 'plan', null);
        } else if (run.phase === 'plan' && succeeded('plan')) {
          const cases = (
            await client.query<{ document: CaseDefinition }>(
              'SELECT document FROM run_cases WHERE project_id=$1 AND run_id=$2 ORDER BY id',
              [projectId, id],
            )
          ).rows.map((row) => row.document);
          if (!cases.length) {
            const explorer = refreshed.find(
              (j) => j.role === 'explorer' && j.status === 'succeeded',
            );
            const pages = Array.isArray(explorer?.result?.['pages'])
              ? (explorer.result['pages'] as { url: string; depth: number }[])
              : [{ url: run.targetUrl, depth: 0 }];
            const urls = [
              ...new Set(
                pages
                  .filter(
                    (page) => page.depth <= run.effectiveConfig.budget.maxDepth,
                  )
                  .map((page) =>
                    displayUrl(
                      validateTarget(
                        page.url,
                        run.effectiveConfig.allowedOrigins,
                        this.protectedOrigins,
                      ).toString(),
                    ),
                  ),
              ),
            ].slice(
              0,
              Math.min(
                run.effectiveConfig.budget.maxPages,
                run.effectiveConfig.budget.maxCases,
              ),
            );
            for (const [index, url] of urls.entries()) {
              const c = smokeCase(run, url, index);
              await this.insertCase(client, c);
              cases.push(c);
            }
          }
          run = await this.change(client, run, 'running', 'execute');
          for (const c of cases.slice(0, run.effectiveConfig.budget.maxCases))
            await this.enqueue(
              client,
              run,
              'executor',
              'execute',
              `${c.id}:v${c.version}`,
              c.id,
              1,
              {
                entryUrl: c.outline[0]?.startsWith('Navigate ')
                  ? c.outline[0].slice(9)
                  : run.targetUrl,
              },
            );
        } else if (run.phase === 'execute' || run.phase === 'reproduce') {
          const created = await this.enqueueReproductions(
            client,
            run,
            refreshed,
          );
          if (created && run.phase !== 'reproduce')
            await this.change(client, run, 'running', 'reproduce');
          else if (!created) {
            run = await this.change(client, run, 'running', 'finalize');
            await this.enqueue(
              client,
              run,
              'finalizer',
              'finalize',
              'report',
              null,
            );
          }
        } else if (run.phase === 'finalize' && succeeded('finalize'))
          await this.finalize(
            client,
            run,
            run.terminationReason ?? 'normal',
            'completed',
          );
      }
    });
  }
  async enqueueReproductions(
    client: PoolClient,
    run: Run,
    jobs: JobRow[],
    reviewedTaskIds?: readonly string[],
  ): Promise<number> {
    const findings = (
      await client.query<{
        id: string;
        case_id: string;
        original_attempt_id: string;
        original_task_id: string;
        document: Finding;
      }>(
        "SELECT f.*,a.task_id AS original_task_id FROM findings f JOIN case_attempts a ON a.id=f.original_attempt_id AND a.project_id=f.project_id WHERE f.project_id=$1 AND f.run_id=$2 AND f.status='suspected' AND COALESCE(f.document->>'triageDisposition','open')<>'duplicate' AND f.document->>'duplicateOf' IS NULL AND a.finished_at IS NOT NULL ORDER BY f.id",
        [run.projectId, run.id],
      )
    ).rows;
    // Session managers review new reports before paying for reproduction.
    // Legacy/fallback runs omit this watermark and keep immediate dispatch.
    const reviewed = reviewedTaskIds ? new Set(reviewedTaskIds) : null;
    const candidates = findings.filter(
      (f) =>
        f.document.triageDisposition !== 'duplicate' &&
        !f.document.duplicateOf &&
        (!reviewed || reviewed.has(f.original_task_id)) &&
        !jobs.some(
          (j) => j.role === 'reproducer' && j.result?.['findingId'] === f.id,
        ),
    );
    let created = 0;
    for (const f of candidates) {
      const budget = (
        await client.query(
          'SELECT * FROM run_budgets WHERE run_id=$1 FOR UPDATE',
          [run.id],
        )
      ).rows[0];
      try {
        budget.reserved = reserve(budget.limits, budget.used, budget.reserved, {
          reproductions: 1,
        });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'BUDGET_EXCEEDED')
          break;
        throw error;
      }
      await client.query('UPDATE run_budgets SET reserved=$2 WHERE run_id=$1', [
        run.id,
        budget.reserved,
      ]);
      const jobId = await this.enqueue(
        client,
        run,
        'reproducer',
        'reproduce',
        f.id,
        f.case_id,
        1,
        {
          findingId: f.id,
          entryUrl:
            (
              await client.query(
                "SELECT j.result->>'entryUrl' url FROM case_attempts a JOIN jobs j ON j.id=a.task_id WHERE a.id=$1 AND a.project_id=$2",
                [f.original_attempt_id, run.projectId],
              )
            ).rows[0]?.url ?? run.targetUrl,
        },
      );
      await client.query(
        "INSERT INTO budget_reservations(id,project_id,run_id,task_id,request_id,kind,reserved,status) VALUES($1,$2,$3,$4,$5,'reproduction','{\"reproductions\":1}','reserved')",
        [randomUUID(), run.projectId, run.id, jobId, randomUUID()],
      );
      created++;
    }
    return created;
  }
  async interrupt(
    client: PoolClient,
    run: Run,
    job: JobRow,
    status: 'cancelled' | 'interrupted',
  ): Promise<void> {
    await client.query(
      `UPDATE auth_otp_challenges SET status='expired',
       ciphertext=NULL,nonce=NULL,auth_tag=NULL,key_version=NULL
       WHERE project_id=$1 AND task_id=$2 AND status IN ('pending','submitted')`,
      [run.projectId, job.id],
    );
    await reconcileExpiredOtpInputs(client, run.projectId, run.id, job.id);
    await client.query(
      "UPDATE action_intents SET outcome='unknown', execution_state='completed' WHERE project_id=$1 AND task_id=$2 AND outcome='pending'",
      [run.projectId, job.id],
    );
    await client.query(
      "UPDATE auth_execution_sessions SET status='ended', ended_at=clock_timestamp(), end_reason='interrupted' WHERE project_id=$1 AND task_id=$2 AND status IN ('allocated','active')",
      [run.projectId, job.id],
    );
    await client.query(
      "UPDATE auth_profile_run_locks SET status='released', released_at=clock_timestamp(), release_reason='interrupted' WHERE project_id=$1 AND run_id=$2 AND phase='initializing' AND status='held'",
      [run.projectId, run.id],
    );
    await this.authExecution.endTaskSignIn(
      client,
      run.projectId,
      job.id,
      'interrupted',
    );
    const uncertainSteps = (
      await client.query(
        "UPDATE steps s SET document=s.document||$3::jsonb FROM action_intents i WHERE s.action_id=i.id AND s.project_id=$1 AND i.task_id=$2 AND i.outcome='unknown' AND s.document->>'status'='running' RETURNING s.document",
        [
          run.projectId,
          job.id,
          JSON.stringify({
            status: 'unknown',
            finishedAt: new Date().toISOString(),
            summary: 'Action outcome unknown after interruption',
          }),
        ],
      )
    ).rows;
    for (const row of uncertainSteps)
      await appendEvent(
        client,
        run.projectId,
        run.id,
        'step.recorded',
        parseContract('Step', row.document),
      );
    await client.query(
      "UPDATE case_attempts SET status=$3,finished_at=clock_timestamp() WHERE project_id=$1 AND task_id=$2 AND status='running'",
      [run.projectId, job.id, status],
    );
    const pending = (
      await client.query(
        "SELECT * FROM budget_reservations WHERE project_id=$1 AND task_id=$2 AND status='reserved' FOR UPDATE",
        [run.projectId, job.id],
      )
    ).rows;
    for (const reservation of pending) {
      if (reservation.kind === 'concurrency') {
        await this.releaseSlots(client, run.projectId, job.id);
        continue;
      }
      const budget = (
        await client.query(
          'SELECT * FROM run_budgets WHERE run_id=$1 FOR UPDATE',
          [run.id],
        )
      ).rows[0];
      for (const [key, value] of Object.entries(reservation.reserved)) {
        budget.used[key] = (budget.used[key] ?? 0) + Number(value);
        budget.reserved[key] = Math.max(
          0,
          (budget.reserved[key] ?? 0) - Number(value),
        );
      }
      await client.query(
        'UPDATE run_budgets SET used=$2,reserved=$3 WHERE run_id=$1',
        [run.id, budget.used, budget.reserved],
      );
      await client.query(
        "UPDATE budget_reservations SET status='unknown',charged=reserved WHERE id=$1",
        [reservation.id],
      );
    }
    await client.query(
      'UPDATE jobs SET status=$2, lease_until=NULL, finished_at=clock_timestamp() WHERE id=$1',
      [job.id, status],
    );
    await client.query(
      'UPDATE task_leases SET released_at=clock_timestamp() WHERE task_id=$1',
      [job.id],
    );
    // A reproducer that crashes or is cancelled before producing a verdict
    // must not leave its original finding looking like a live confirmed
    // candidate. There is no valid independent Reproduction to attach:
    // record an explicit blocked Finding without inventing evidence.
    if (
      job.role === 'reproducer' &&
      typeof job.result?.['findingId'] === 'string'
    ) {
      const row = (
        await client.query<{
          id: string;
          document: import('@localqa/contracts').Finding;
        }>(
          `SELECT id,document FROM findings
           WHERE project_id=$1 AND run_id=$2 AND id=$3
             AND status='suspected' FOR UPDATE`,
          [run.projectId, run.id, job.result['findingId']],
        )
      ).rows[0];
      if (row) {
        const finding = parseContract('Finding', {
          ...row.document,
          status: 'blocked',
          reproductionRef: null,
          version: row.document.version + 1,
        });
        await client.query(
          `UPDATE findings SET status='blocked',version=version+1,document=$2
           WHERE id=$1`,
          [row.id, finding],
        );
        await appendEvent(
          client,
          run.projectId,
          run.id,
          'finding.updated',
          finding,
        );
      }
    }
    await client.query(
      "UPDATE model_requests SET status='unknown',redacted_diagnostic=redacted_diagnostic||'{\"usageSource\":\"unknown\"}'::jsonb WHERE project_id=$1 AND task_id=$2 AND status='reserved'",
      [run.projectId, job.id],
    );
    await this.pulse(client, run.projectId, run.id);
    await appendEvent(client, run.projectId, run.id, 'task.updated', {
      ...job.document,
      status,
    });
  }
  async stopTask(
    scope: WorkerScope,
    proof: LeaseProof,
    reason: NonNullable<Run['terminationReason']>,
  ): Promise<void> {
    await this.tx(async (client) => {
      const { job, run } = await this.validateLease(client, scope, proof, true);
      if (run.status === 'cancelling' || TERMINAL.has(run.status)) return;
      const current = reason === 'budget_limit' && job.role !== 'reproducer'
        ? await this.checkTimeBudget(client, run) : run;
      await this.interrupt(client, current, job, 'interrupted');
      // Heartbeat cancellation of other agents must not turn a budget stop
      // into worker_failure while its already-running reproduction drains.
      await this.change(client, current, 'running', current.phase,
        current.terminationReason === 'budget_limit' ? 'budget_limit' : reason);
    });
  }
  /**
   * A sign-in that did not succeed is the sign-in agent's report, not a run
   * failure (as in Mo). The auth job ends with that report; tick then
   * starts the session agent, which reads it and decides what to ask.
   */
  async failAuth(
    scope: WorkerScope,
    proof: LeaseProof,
    input: { reasonCode: string; detail: string | null },
  ): Promise<void> {
    await this.tx(async (client) => {
      const { job, run } = await this.validateLease(client, scope, proof, true);
      if (job.document.summary !== 'auth')
        throw new StorageError('POLICY_DENIED');
      if (run.status === 'cancelling' || TERMINAL.has(run.status)) return;
      const reasonCode = /^[A-Z][A-Z0-9_]{1,47}$/.test(input.reasonCode)
        ? input.reasonCode
        : 'AUTH_FAILED';
      const detail =
        typeof input.detail === 'string' && input.detail.trim()
          ? sanitizeText(input.detail).replace(/\s+/g, ' ').trim().slice(0, 300)
          : null;
      // Record the report while the job is still running: a terminal job
      // is immutable. The interruption then releases its session and slots.
      await client.query(
        "UPDATE jobs SET result=COALESCE(result,'{}'::jsonb)||$2::jsonb WHERE id=$1",
        [
          job.id,
          JSON.stringify({
            stage: 'auth',
            loginBlocked: { reasonCode, detail },
          }),
        ],
      );
      await this.interrupt(client, run, job, 'interrupted');
    });
  }
  async finalize(
    client: PoolClient,
    run: Run,
    reason: NonNullable<Run['terminationReason']>,
    status: 'completed' | 'cancelled',
  ): Promise<void> {
    const rows = (
      await client.query(
        "SELECT c.id,v.document->>'status' status,EXISTS(SELECT 1 FROM case_attempts a WHERE a.case_id=c.id) started FROM run_cases c LEFT JOIN final_valid_verdicts v ON v.case_id=c.id WHERE c.project_id=$1 AND c.run_id=$2",
        [run.projectId, run.id],
      )
    ).rows;
    const summary = (await import('@localqa/domain')).summarize(
      rows.map((r) => r.status ?? (r.started ? 'inconclusive' : 'not_run')),
    );
    await this.sessions.finishRun(client, run, reason);
    const final = await this.change(
      client,
      run,
      status === 'completed' &&
        summary.attempted === 0 &&
        ['setup_failure', 'model_failure'].includes(reason)
        ? 'failed'
        : status,
      'finalize',
      reason,
      completion(reason, summary),
    );
    await appendEvent(client, run.projectId, run.id, 'report.ready', {
      schemaVersion: 1,
      reportVersion: final.version,
      generatedAt: new Date().toISOString(),
    });
    // A granted exclusive auth lock otherwise outlives the run, and every
    // later run on the same profile fails auth with RATE_LIMITED.
    await client.query(
      "UPDATE auth_profile_run_locks SET status='released', released_at=clock_timestamp(), release_reason='run_finished' WHERE project_id=$1 AND run_id=$2 AND status='held'",
      [run.projectId, run.id],
    );
    await appendEvent(client, run.projectId, run.id, 'run.finished', final);
  }
}
