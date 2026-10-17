import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseContract } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import { Coordinator } from '../../dist/core.js';

const example = JSON.parse(
  readFileSync(
    new URL('../../../../docs/examples/report.sample.json', import.meta.url),
    'utf8',
  ),
);
export const brief = '页面应显示订单明细';
export function proposal(extra = {}) {
  return {
    action: 'dispatch',
    rationale: '复查报告并继续测试',
    cases: [],
    exploreTargets: [],
    coverageGaps: [],
    ...extra,
  };
}
export function candidate(
  title = '订单明细',
  entryUrl = 'https://fixture.test/orders',
  step = '点击查看明细',
) {
  return {
    entryUrl,
    title,
    summary: '检查页面',
    preconditions: ['已有可用账号'],
    outline: [step],
    criteria: [
      {
        id: 'detail_visible',
        kind: 'semantic',
        description: brief,
        sourceKind: 'inferred',
        sourceRef: 'observation:owned',
        sourceQuote: '',
        locator: null,
        expectedValue: null,
      },
    ],
  };
}

/** SQL-aware test double: exercises service projections and writes, not the
 * PostgreSQL engine, migrations, RLS or confirmation/evidence triggers. */
export function sessionFixture(extra = {}, options = {}) {
  const run = parseContract('Run', {
    ...structuredClone(example.run),
    id: randomUUID(),
    projectId: randomUUID(),
    creatorId: randomUUID(),
    targetUrl: 'https://fixture.test/',
    executionMode: 'smoke',
    status: 'running',
    phase: 'execute',
    terminationReason: null,
    version: 1,
    budgetUsed: {
      activeSeconds: 0,
      actions: 0,
      modelCalls: 0,
      reproductions: 0,
      totalTokens: 0,
    },
    effectiveConfig: {
      ...structuredClone(example.run.effectiveConfig),
      allowedOrigins: ['https://fixture.test'],
      taskIntent: 'flow',
      writeScope: [],
      budget: {
        ...example.run.effectiveConfig.budget,
        maxCases: 30,
        maxPages: 30,
      },
    },
    ...extra,
  });
  const state = {
    session: parseContract('SessionReport', {
      objective: brief,
      round: 1,
      status: 'reviewing',
      plan: '',
      caseIds: [],
      exploredUrls: [],
      coverageGaps: [],
      summary: '',
      history: [],
    }),
    cases: new Map(),
    jobs: new Map(),
    attempts: [],
    findings: new Map(),
    artifacts: new Map(),
    reproductionEvidence: new Map(),
    references: [],
    updates: [],
    queries: [],
    events: [],
    enqueued: [],
    changes: [],
    inputs: [],
    seq: 0,
    budget: {
      limits: run.effectiveConfig.budget,
      used: run.budgetUsed,
      reserved: {},
    },
  };
  const addJob = (
    caseId,
    {
      role = 'executor',
      stage = 'execute',
      status = 'succeeded',
      attempt = 1,
      result = {},
    } = {},
  ) => {
    const document = parseContract('Task', {
      id: randomUUID(),
      runId: run.id,
      caseId,
      role,
      status,
      attempt,
      summary: stage,
      elapsedSeconds: 0,
    });
    const row = {
      id: document.id,
      project_id: run.projectId,
      run_id: run.id,
      case_id: caseId,
      role,
      status,
      attempt,
      document,
      result: { stage, ...result },
      fencing_token: '1',
      worker_id: 'fixture-worker',
    };
    state.jobs.set(row.id, row);
    return row;
  };
  const addAttempt = (
    definition,
    {
      job,
      outcome = 'blocked',
      summary = '上一次执行受阻',
      number,
      valid = true,
    } = {},
  ) => {
    job ??= addJob(definition.id);
    const attempt = {
      id: randomUUID(),
      caseId: definition.id,
      jobId: job.id,
      number:
        number ??
        Math.max(
          0,
          ...state.attempts
            .filter((a) => a.caseId === definition.id)
            .map((a) => a.number),
        ) + 1,
      valid,
      verdict: null,
    };
    if (outcome !== null)
      attempt.verdict = parseContract('Verdict', {
        id: randomUUID(),
        caseId: definition.id,
        attemptId: attempt.id,
        status: outcome,
        summary,
        reasonCode: outcome === 'passed' ? 'OBSERVED' : 'INSUFFICIENT_EVIDENCE',
        criterionResults: [],
        verified: outcome === 'passed' ? ['订单明细已显示'] : [],
        gaps: outcome === 'blocked' ? ['需要有效账号'] : [],
        createdAt: new Date().toISOString(),
      });
    state.attempts.push(attempt);
    return attempt;
  };
  const currentCase = (definition) => {
    const latest = state.attempts
      .filter(
        (a) =>
          a.caseId === definition.id &&
          state.jobs.get(a.jobId).role !== 'reproducer',
      )
      .sort((a, b) => b.number - a.number)[0];
    const verdict = latest?.valid ? latest.verdict : null;
    return parseContract('CaseRecord', {
      definition,
      verdict: verdict ?? null,
      outcome: verdict?.status ?? (latest ? 'inconclusive' : 'not_run'),
    });
  };
  const addCase = (outcome = 'blocked', patch = {}) => {
    const c = candidate();
    const definition = parseContract('CaseDefinition', {
      id: randomUUID(),
      projectId: run.projectId,
      runId: run.id,
      version: 1,
      title: c.title,
      summary: c.summary,
      preconditions: c.preconditions,
      outline: [`Navigate ${c.entryUrl}`, ...c.outline],
      criteria: [
        {
          id: 'detail_visible',
          kind: 'semantic',
          description: brief,
          sourceKind: 'user_spec',
          sourceRef: 'brief:owned',
        },
      ],
      ...patch,
    });
    state.cases.set(definition.id, definition);
    state.session.caseIds.push(definition.id);
    if (outcome !== 'not_run') addAttempt(definition, { outcome });
    return currentCase(definition);
  };
  const addFinding = (record, patch = {}) => {
    const document = parseContract('Finding', {
      id: randomUUID(),
      runId: run.id,
      caseIds: [record.definition.id],
      kind: 'functional',
      status: 'suspected',
      title: '订单明细缺失',
      severity: 'medium',
      expected: brief,
      actual: '页面显示 404',
      expectedSource: 'user_spec',
      reproSteps: record.definition.outline,
      evidenceRefs: [randomUUID()],
      reproductionRef: null,
      triageDisposition: 'open',
      version: 1,
      ...patch,
    });
    for (const id of document.evidenceRefs)
      state.artifacts.set(id, { projectId: run.projectId, runId: run.id });
    const attempt = state.attempts.filter(
      (a) => a.caseId === record.definition.id,
    )[0];
    state.findings.set(document.id, {
      id: document.id,
      case_id: record.definition.id,
      original_attempt_id: attempt?.id ?? randomUUID(),
      original_task_id: attempt?.jobId ?? randomUUID(),
      document,
    });
    return document;
  };
  const scopedCases = () =>
    [...state.cases.values()].filter(
      (c) => c.projectId === run.projectId && c.runId === run.id,
    );
  const scopedFindings = () =>
    [...state.findings.values()].filter((f) => f.document.runId === run.id);
  const ownedArtifacts = (ids) =>
    ids.filter((id) => {
      const artifact = state.artifacts.get(id);
      return artifact?.projectId === run.projectId && artifact.runId === run.id;
    });
  const rows = (value = []) => ({ rows: value, rowCount: value.length });
  const client = {
    async query(sql, params = []) {
      state.queries.push({ sql, params });
      if (sql.includes('SELECT event_seq FROM runs'))
        return rows([{ event_seq: String(state.seq) }]);
      if (sql.includes('SELECT id FROM runs')) return rows([{ id: run.id }]);
      if (sql.includes('INSERT INTO run_events')) {
        assert.equal(params[2], state.seq + 1);
        state.seq = params[2];
        state.events.push({
          type: params[3],
          payload: structuredClone(params[4]),
        });
        return rows();
      }
      if (sql.includes('SELECT CASE WHEN is_admin()'))
        return rows([{ role: 'admin' }]);
      if (sql.includes('SELECT jsonb_build_object')) {
        const records = scopedCases().map(currentCase);
        const excludeDuplicates = sql.includes(
          "COALESCE(f.document->>'triageDisposition','open')<>'duplicate'",
        );
        return rows([
          {
            dto: {
              ...run,
              stats: {
                cases: records.length,
                passed: records.filter((c) => c.outcome === 'passed').length,
                issues: records.filter((c) => c.outcome === 'issue_found')
                  .length,
                blocked: records.filter((c) => c.outcome === 'blocked').length,
                findings: scopedFindings().filter(
                  (f) =>
                    !excludeDuplicates ||
                    f.document.triageDisposition !== 'duplicate',
                ).length,
              },
            },
          },
        ]);
      }
      if (sql.includes('SELECT run_id FROM run_sessions'))
        return rows([{ run_id: run.id }]);
      if (sql.includes('SELECT document FROM run_sessions'))
        return rows([{ document: state.session }]);
      if (sql.includes('UPDATE run_sessions SET document')) {
        state.session = parseContract('SessionReport', params[2]);
        return rows();
      }
      if (
        sql.includes('FROM run_messages') ||
        sql.includes('FROM run_knowledge_bindings') ||
        sql.includes('FROM page_snapshots')
      )
        return rows();
      if (sql.includes('FROM model_profile_versions'))
        return rows([
          {
            document: {
              id: run.effectiveConfig.models.assertion.profileId,
              name: 'fixture',
              endpoint: 'https://model.test/v1',
              configuredModelId: 'fixture',
              adapter: 'openai_compatible',
              dataBoundary: 'internal',
              capabilities: {
                structuredOutput: true,
                nativeTools: true,
                imageInput: false,
              },
              status: 'ready',
              version: 1,
            },
          },
        ]);
      if (sql.includes("document->>'summary'='auth'")) return rows();
      if (sql.includes('c.document AS definition')) {
        assert.ok(
          sql.includes('final_valid_verdicts'),
          'context must use the authoritative latest-execution projection',
        );
        return rows(scopedCases().map(currentCase));
      }
      if (sql.includes('SELECT id FROM run_cases')) {
        assert.deepEqual(params.slice(0, 2), [run.projectId, run.id]);
        return rows(
          scopedCases()
            .filter((c) => params[2].includes(c.id))
            .map((c) => ({ id: c.id })),
        );
      }
      if (sql.includes('INSERT INTO run_cases')) {
        const definition = parseContract('CaseDefinition', params[3]);
        state.cases.set(definition.id, definition);
        return rows();
      }
      if (sql.includes('SELECT case_id, max(attempt)')) {
        const ids = new Set(
          [...state.jobs.values()]
            .filter((j) => j.role === 'executor' && j.case_id)
            .map((j) => j.case_id),
        );
        return rows(
          [...ids].map((id) => {
            const jobs = [...state.jobs.values()].filter(
              (j) => j.role === 'executor' && j.case_id === id,
            );
            return {
              case_id: id,
              last_attempt: Math.max(...jobs.map((j) => j.attempt)),
              retries: Math.max(
                0,
                jobs.filter((j) => j.document.summary === 'execute').length - 1,
              ),
            };
          }),
        );
      }
      if (sql.includes('SELECT * FROM jobs')) {
        let jobs = [...state.jobs.values()];
        if (sql.includes('ANY($3::uuid[])'))
          jobs = jobs.filter((j) => params[2].includes(j.case_id));
        if (sql.includes("role IN ('explorer'"))
          jobs = jobs.filter(
            (j) =>
              ['executor', 'explorer', 'reproducer'].includes(j.role) &&
              ['queued', 'running', 'waiting'].includes(j.status),
          );
        return rows(jobs);
      }
      if (sql.includes('INSERT INTO jobs')) {
        const old = [...state.jobs.values()].find(
          (j) => j.unique_key === params[4],
        );
        if (old) return rows();
        const document = parseContract('Task', params[7]);
        const job = {
          id: params[0],
          project_id: params[1],
          run_id: params[2],
          case_id: params[3],
          unique_key: params[4],
          role: params[5],
          status: 'queued',
          attempt: params[6],
          document,
          result: params[8],
          fencing_token: '1',
        };
        state.jobs.set(job.id, job);
        state.enqueued.push(job);
        return rows([{ id: job.id }]);
      }
      if (sql.includes('SELECT id FROM jobs WHERE unique_key'))
        return rows(
          [...state.jobs.values()].filter((j) => j.unique_key === params[0]),
        );
      if (sql.includes("UPDATE jobs SET status='waiting'")) {
        const job = state.jobs.get(params[0]);
        job.status = 'waiting';
        Object.assign(job.result, JSON.parse(params[1]));
        return rows();
      }
      if (sql.includes('UPDATE task_leases')) return rows();
      if (sql.includes('SELECT 1 FROM jobs'))
        return rows(
          [...state.jobs.values()]
            .filter((j) => ['queued', 'running'].includes(j.status))
            .map(() => ({})),
        );
      if (sql.includes('INSERT INTO input_requests')) {
        state.inputs.push(params[3]);
        return rows();
      }
      if (sql.includes('SELECT f.*,a.task_id AS original_task_id'))
        return rows(
          scopedFindings().filter((f) => f.document.status === 'suspected'),
        );
      if (sql.includes('SELECT id,document FROM findings'))
        return rows(scopedFindings());
      if (sql.includes('SELECT document FROM findings'))
        return rows(scopedFindings().map((f) => ({ document: f.document })));
      if (sql.includes('UPDATE findings SET version=version+1,document=$3')) {
        const old = state.findings.get(params[3]);
        const document = parseContract('Finding', params[2]);
        assert.equal(document.version, old.document.version + 1);
        assert.equal(
          document.status,
          old.document.status,
          'merge must not change confirmation status',
        );
        assert.equal(
          document.reproductionRef,
          old.document.reproductionRef,
          'merge must not substitute confirmation provenance',
        );
        assert.ok(!sql.includes('SET status='));
        old.document = document;
        state.updates.push(document);
        return rows();
      }
      if (sql.includes('SELECT e.artifact_id FROM reproduction_evidence'))
        return rows(
          (state.reproductionEvidence.get(params[2]) ?? []).map((id) => ({
            artifact_id: id,
          })),
        );
      if (sql.includes('SELECT id FROM artifacts'))
        return rows(ownedArtifacts(params[2]).map((id) => ({ id })));
      if (sql.includes('INSERT INTO artifact_references')) {
        state.references.push({
          findingId: params[2],
          evidenceRefs: ownedArtifacts(params[3]),
        });
        return rows();
      }
      if (sql.includes('finding_evidence'))
        throw new Error(
          'Merged occurrences must not mutate original confirmation evidence',
        );
      if (sql.includes('SELECT * FROM run_budgets'))
        return rows([structuredClone(state.budget)]);
      if (sql.includes('UPDATE run_budgets SET reserved')) {
        state.budget.reserved = params[1];
        return rows();
      }
      if (sql.includes("SELECT j.result->>'entryUrl'"))
        return rows([{ url: run.targetUrl }]);
      if (sql.includes('SELECT is_admin() AS allowed'))
        return rows([{ allowed: true }]);
      if (sql.includes('INSERT INTO budget_reservations')) return rows();
      throw new Error(`Unhandled fixture query: ${sql}`);
    },
  };
  const coordinator = new Coordinator({
    db: {},
    vault: {},
    serviceActor: { userId: run.creatorId },
  });
  if (options.realTx) {
    // Exercise the real Coordinator.tx error mapping (and a Database-like
    // actor) over the fake client. Database.#transaction rethrows
    // StorageError as-is and maps anything else to an infrastructure error.
    coordinator.db = {
      actor: async (_actor, work) => {
        try {
          return await work(client);
        } catch (error) {
          if (error instanceof StorageError) throw error;
          throw new StorageError('SERVICE_UNAVAILABLE');
        }
      },
    };
  } else {
    coordinator.tx = async (fn) => fn(client);
  }
  coordinator.change = async (
    _client,
    current,
    status,
    phase = current.phase,
  ) => {
    state.changes.push({ status, phase });
    Object.assign(run, { status, phase });
    return run;
  };
  coordinator.pulse = async () => {};
  coordinator.releaseSlots = async () => {};
  const manager = addJob(null, {
    role: 'coordinator',
    stage: 'plan',
    status: 'running',
    result: { sessionRound: 1 },
  });
  coordinator.validateLease = async () => ({ run, job: manager });
  return {
    run,
    state,
    client,
    coordinator,
    agent: coordinator.sessions,
    manager,
    addCase,
    addFinding,
    addJob,
    addAttempt,
    currentCase,
  };
}
