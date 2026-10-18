// Pure Node: the real Coordinator.finish transaction over an SQL-aware fake
// client. The verdict/finding triggers from storage migration 002 are
// simulated with the same rules, so a report shape they reject surfaces as the
// same StorageError('VALIDATION_ERROR') the real database produces.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
import { criteriaHash } from '@localqa/domain';
import { StorageError } from '@localqa/storage';
import { Coordinator } from '../dist/core.js';

function focusCase({ extraCriteria = 0, sourceKind = 'inferred' } = {}) {
  const projectId = randomUUID();
  const runId = randomUUID();
  const caseId = randomUUID();
  return {
    projectId,
    runId,
    caseId,
    definition: parseContract('CaseDefinition', {
      id: caseId,
      runId,
      projectId,
      version: 1,
      title: '登录表单键盘焦点顺序',
      summary: '验证 Tab 键焦点依次落在账号框、密码框和登录按钮上。',
      preconditions: ['未登录状态打开登录页'],
      outline: ['Navigate http://192.168.114.114/login', '按 Tab 观察焦点'],
      criteria: [
        {
          id: 'focus_order',
          kind: 'semantic',
          description: '按 Tab 后焦点依次落在账号、密码和登录按钮。',
          sourceKind,
          sourceRef: 'session:planner',
        },
        {
          id: 'focus_visible',
          kind: 'semantic',
          description: '获得焦点的控件有可见的焦点样式。',
          sourceKind,
          sourceRef: 'session:planner',
        },
        ...Array.from({ length: extraCriteria }, (_, index) => ({
          id: `extra_${index}`,
          kind: 'semantic',
          description: `第 ${index + 1} 条附加验收标准。`,
          sourceKind,
          sourceRef: 'session:planner',
        })),
      ],
      requiresLogin: false,
    }),
  };
}

/** Real finish transaction; only the SQL client and the lease are fakes. */
function finishFixture({
  role = 'executor',
  extraCriteria = 0,
  sourceKind = 'inferred',
} = {}) {
  const { projectId, runId, caseId, definition } = focusCase({
    extraCriteria,
    sourceKind,
  });
  const taskId = randomUUID();
  const attemptId = randomUUID();
  const artifactId = randomUUID();
  const originalAttemptId = randomUUID();
  const originalContextId = randomUUID();
  const currentContextId = randomUUID();
  const originalArtifactId = randomUUID();
  const findingId = randomUUID();
  const run = {
    id: runId,
    projectId,
    targetUrl: 'http://192.168.114.114/login',
    executionMode: 'smoke',
    status: 'running',
    effectiveConfig: { allowedOrigins: ['http://192.168.114.114'] },
  };
  const jobDocument = parseContract('Task', {
    id: taskId,
    runId,
    caseId,
    role,
    status: 'running',
    attempt: 1,
    summary: role === 'reproducer' ? 'reproduce' : 'execute',
    elapsedSeconds: 0,
  });
  const job = {
    id: taskId,
    case_id: caseId,
    role,
    status: 'running',
    document: jobDocument,
    result:
      role === 'reproducer'
        ? { stage: 'reproduce', entryUrl: run.targetUrl, findingId }
        : { stage: 'execute', entryUrl: run.targetUrl },
  };
  const proof = {
    taskId,
    fencingToken: 1,
    leaseToken: 'x',
    contextVersion: 1,
  };
  const scope = { projectId, workerId: 'w' };
  const verdicts = [];
  const findings = [];
  const findingEvidence = [];
  const findingUpdates = [];
  const reproductions = [];
  const reproductionEvidence = [];
  const events = [];
  let leaseExpired = false;

  const findingDocument = parseContract('Finding', {
    id: findingId,
    runId,
    caseIds: [caseId],
    kind: 'functional',
    status: 'suspected',
    title: definition.title,
    severity: 'medium',
    expected: definition.criteria[0].description,
    actual: '原始尝试看到的实际表现',
    expectedSource: definition.criteria[0].sourceKind,
    reproSteps: definition.outline,
    evidenceRefs: [originalArtifactId],
    reproductionRef: null,
    triageDisposition: 'open',
    version: 1,
  });

  const modelBinding = { profileId: randomUUID(), version: 1 };
  const runDto = parseContract('Run', {
    id: runId,
    projectId,
    creatorId: randomUUID(),
    targetUrl: run.targetUrl,
    status: 'completed',
    phase: 'execute',
    completion: 'complete',
    terminationReason: null,
    contextVersion: 1,
    effectiveConfig: {
      allowedOrigins: [run.targetUrl],
      actionPolicy: 'non_submitting',
      budget: {
        maxCases: 8,
        maxPages: 6,
        maxDepth: 2,
        maxActiveSeconds: 1800,
        maxActionsPerCase: 24,
        maxActions: 120,
        maxModelCalls: 300,
        maxReproductions: 3,
        concurrency: 2,
        maxTotalTokens: 1500000,
      },
      environmentVersion: null,
      authProfileVersion: null,
      knowledgeVersionIds: [],
      models: {
        coordinator: modelBinding,
        explorer: modelBinding,
        executor: modelBinding,
        assertion: modelBinding,
        reproducer: modelBinding,
      },
    },
    budgetUsed: {
      activeSeconds: 0,
      actions: 0,
      modelCalls: 0,
      reproductions: 0,
      totalTokens: 0,
    },
    createdAt: '2026-10-18T06:53:00.000Z',
    updatedAt: '2026-10-18T06:54:00.000Z',
    version: 1,
  });
  const rows = (items = []) => ({ rows: items, rowCount: items.length });
  const client = {
    async query(sql, params = []) {
      if (sql.includes('SELECT j.* FROM jobs j JOIN task_leases'))
        return rows([
          {
            id: taskId,
            status: 'running',
            document: job.document,
            result: job.result,
          },
        ]);
      if (sql.includes('SELECT document FROM run_sessions')) return rows([]);
      if (sql.includes('SELECT document FROM run_cases'))
        return rows([{ document: definition }]);
      if (sql.includes('LEFT JOIN verdicts'))
        return rows([
          { context_id: originalContextId, verdict_status: 'issue_found' },
        ]);
      if (sql.includes('FROM case_attempts'))
        return rows([
          { id: attemptId, status: 'running', context_id: currentContextId },
        ]);
      if (sql.includes('SELECT id FROM artifacts'))
        return rows([{ id: artifactId }]);
      if (sql.includes('INSERT INTO verdicts')) {
        const verdict = params[4];
        // storage/migrations/002_invariants.sql: guard_verdict().
        if (
          leaseExpired ||
          (verdict.status === 'passed' &&
            !definition.criteria.every((criterion) =>
              verdict.criterionResults.some(
                (result) =>
                  result.criterionId === criterion.id &&
                  result.result === 'passed' &&
                  result.evidenceRefs.includes(artifactId),
              ),
            )) ||
          (verdict.status === 'issue_found' &&
            !verdict.criterionResults.some(
              (result) => result.result === 'failed',
            ))
        ) {
          // 23514 -> mapDatabaseError -> VALIDATION_ERROR.
          throw new StorageError(
            leaseExpired ? 'LEASE_EXPIRED' : 'VALIDATION_ERROR',
          );
        }
        verdicts.push(verdict);
        return rows();
      }
      if (sql.includes('UPDATE case_attempts')) return rows();
      if (sql.includes('SELECT event_seq FROM runs'))
        return rows([{ event_seq: '0' }]);
      if (sql.includes('INSERT INTO run_events')) {
        events.push({ type: params[3], payload: params[4] });
        return rows();
      }
      if (sql.includes('SELECT id,document FROM findings')) return rows([]);
      if (sql.includes('SELECT * FROM findings WHERE id=$1'))
        return rows([
          {
            id: findingId,
            run_id: runId,
            case_id: caseId,
            original_attempt_id: originalAttemptId,
            criteria_hash: criteriaHash(definition),
            status: findingDocument.status,
            document: findingDocument,
          },
        ]);
      if (sql.includes('SELECT artifact_id FROM finding_evidence'))
        return rows([{ artifact_id: originalArtifactId }]);
      if (sql.includes('INSERT INTO findings')) {
        findings.push(params[8]);
        return rows();
      }
      if (sql.includes('INSERT INTO finding_evidence')) {
        findingEvidence.push({ findingId: params[1], artifactId: params[2] });
        return rows();
      }
      if (sql.includes('INSERT INTO reproductions')) {
        const reproduction = params[8];
        // storage/migrations/002_invariants.sql: guard_reproduction().
        if (
          reproduction.outcome === 'reproduced' &&
          !verdicts.some(
            (verdict) =>
              verdict.attemptId === attemptId &&
              verdict.status === 'issue_found',
          )
        )
          throw new StorageError('VALIDATION_ERROR');
        reproductions.push(reproduction);
        return rows();
      }
      if (sql.includes('INSERT INTO reproduction_evidence')) {
        reproductionEvidence.push({
          reproductionId: params[1],
          artifactId: params[2],
        });
        return rows();
      }
      if (sql.includes('UPDATE findings SET status=$2')) {
        findingUpdates.push({
          status: params[1],
          reproductionId: params[2],
          document: params[3],
        });
        return rows();
      }
      if (sql.includes('SELECT is_admin() AS allowed'))
        return rows([{ allowed: true }]);
      if (sql.includes("outcome='pending'")) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT redacted_summary FROM audit_log'))
        return rows([]);
      if (sql.includes('SELECT extract(epoch FROM clock_timestamp())'))
        return rows([{ milliseconds: String(Date.now()) }]);
      if (sql.includes('SELECT 1 FROM jobs WHERE'))
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('UPDATE run_budgets SET used')) return rows();
      if (sql.includes('INSERT INTO audit_log')) return rows();
      if (sql.includes('UPDATE budget_reservations')) return rows();
      if (sql.includes('SELECT id FROM auth_execution_sessions'))
        return rows([]);
      if (sql.includes('SELECT id FROM auth_import_grants')) return rows([]);
      if (sql.includes('UPDATE auth_execution_sessions')) return rows();
      if (sql.includes('UPDATE auth_profile_run_locks')) return rows();
      if (sql.includes("UPDATE jobs SET status='succeeded'"))
        return rows([{ started_at: new Date(), finished_at: new Date() }]);
      if (sql.includes('UPDATE task_leases SET released_at')) return rows();
      if (
        sql.includes(
          "SELECT CASE WHEN is_admin() THEN 'admin' ELSE project_role(id) END AS role FROM projects",
        )
      )
        return rows([{ role: 'admin' }]);
      if (sql.includes('SELECT jsonb_build_object'))
        return rows([{ dto: runDto }]);
      if (sql.includes('SELECT * FROM jobs WHERE project_id'))
        return rows([job]);
      throw new Error(`Unhandled fixture query: ${sql.slice(0, 160)}`);
    },
  };
  const coordinator = new Coordinator({
    db: {
      actor: async (_actor, work) => {
        try {
          return await work(client);
        } catch (error) {
          // Database.#transaction: StorageError passes, anything else becomes
          // an infrastructure error.
          if (error instanceof StorageError) throw error;
          throw new StorageError('SERVICE_UNAVAILABLE', error.message);
        }
      },
    },
    vault: {},
    serviceActor: { userId: randomUUID() },
  });
  coordinator.validateLease = async () => ({ run, job });
  coordinator.sessions.advance = async () => true;

  const report = ({ status, focusVisible, bug, long = false }) => ({
    status,
    summary: long ? '长摘要'.repeat(400) : '执行代理的摘要',
    verified: long ? ['已确认'.repeat(300)] : ['首页可见'],
    gaps: long ? ['缺口'.repeat(500)] : ['焦点样式未确认'],
    criteria: [
      {
        criterionId: 'focus_order',
        result: 'passed',
        reason: long ? '顺序正确'.repeat(200) : '焦点顺序正确',
      },
      {
        criterionId: 'focus_visible',
        result: focusVisible,
        reason: long ? '看不清'.repeat(300) : '焦点样式需要看图确认',
      },
    ],
    bug,
  });
  const resultsFor = (modelReport) =>
    definition.criteria.map((criterion) => {
      const judged = modelReport.criteria.find(
        (entry) => entry.criterionId === criterion.id,
      );
      return {
        criterionId: criterion.id,
        result: judged?.result ?? 'unknown',
        reason: judged?.reason || '执行代理没有单独说明这一条',
        evidenceRefs: [artifactId],
      };
    });

  return {
    scope,
    proof,
    definition,
    artifactId,
    report,
    resultsFor,
    verdicts,
    findings,
    findingEvidence,
    findingUpdates,
    reproductions,
    reproductionEvidence,
    events,
    findingId,
    expireLease: () => {
      leaseExpired = true;
    },
    finish: (modelReport) =>
      coordinator.finish(
        scope,
        proof,
        {
          stage: role === 'reproducer' ? 'reproduce' : 'execute',
          oracle: 'agent_report',
          agentReport: modelReport,
        },
        resultsFor(modelReport),
      ),
    coordinator,
  };
}

test('issue_found without a failed criterion or a bug is recorded inconclusive', async () => {
  const fixture = finishFixture();
  const modelReport = fixture.report({
    status: 'issue_found',
    focusVisible: 'unknown',
    bug: null,
  });
  // The verdict guard would reject this shape with VALIDATION_ERROR; the
  // finish must keep the report and record what it actually says.
  await fixture.finish(modelReport);
  assert.equal(fixture.verdicts.length, 1);
  const verdict = fixture.verdicts[0];
  assert.equal(verdict.status, 'inconclusive');
  assert.equal(verdict.reasonCode, 'AGENT_INCONCLUSIVE');
  assert.ok(
    verdict.gaps.some((gap) => gap.includes('issue_found')),
    'the correction is explained in gaps',
  );
  assert.deepEqual(
    verdict.criterionResults.map((entry) => [entry.criterionId, entry.result]),
    [
      ['focus_order', 'passed'],
      ['focus_visible', 'unknown'],
    ],
  );
  assert.equal(fixture.findings.length, 0, 'no finding without a named bug');
  const caseResult = fixture.events.find(
    (event) => event.type === 'case.result',
  );
  assert.equal(caseResult.payload.outcome, 'inconclusive');
});

test('an issue reported outside the criteria keeps issue_found and creates a finding', async () => {
  const fixture = finishFixture();
  await fixture.finish(
    fixture.report({
      status: 'issue_found',
      focusVisible: 'unknown',
      bug: { title: '焦点样式不可见', expected: '', actual: '' },
    }),
  );
  const verdict = fixture.verdicts[0];
  assert.equal(verdict.status, 'issue_found');
  assert.equal(verdict.reasonCode, 'AGENT_ISSUE_FOUND');
  // The agent's own results stay untouched; a synthetic failed criterion
  // satisfies the guard without inventing a failure for focus_visible.
  assert.deepEqual(
    verdict.criterionResults
      .slice(0, 2)
      .map((entry) => [entry.criterionId, entry.result]),
    [
      ['focus_order', 'passed'],
      ['focus_visible', 'unknown'],
    ],
  );
  const synthetic = verdict.criterionResults.find(
    (entry) => entry.criterionId === 'agent_reported_issue',
  );
  assert.equal(synthetic.result, 'failed');
  assert.ok(synthetic.reason.includes('焦点样式不可见'));
  assert.equal(fixture.findings.length, 1);
  const finding = fixture.findings[0];
  assert.equal(finding.title, '焦点样式不可见');
  // No listed criterion failed: the finding falls back to the first criterion.
  assert.equal(finding.expected, fixture.definition.criteria[0].description);
  assert.ok(finding.actual.includes('执行代理的摘要'));
  assert.deepEqual(fixture.findingEvidence, [
    { findingId: finding.id, artifactId: fixture.artifactId },
  ]);
});

test('passed with an unverified criterion is recorded inconclusive', async () => {
  const fixture = finishFixture();
  await fixture.finish(
    fixture.report({ status: 'passed', focusVisible: 'unknown', bug: null }),
  );
  const verdict = fixture.verdicts[0];
  assert.equal(verdict.status, 'inconclusive');
  assert.equal(verdict.reasonCode, 'AGENT_INCONCLUSIVE');
  const gap = verdict.gaps.find((entry) => entry.includes('passed'));
  assert.ok(gap.includes('focus_visible'));
  assert.ok(gap.includes('未能判定'));
  assert.equal(fixture.findings.length, 0);
});

test('passed with a failed criterion is recorded inconclusive as contradictory', async () => {
  const fixture = finishFixture();
  await fixture.finish(
    fixture.report({ status: 'passed', focusVisible: 'failed', bug: null }),
  );
  const verdict = fixture.verdicts[0];
  assert.equal(verdict.status, 'inconclusive');
  assert.equal(verdict.reasonCode, 'AGENT_INCONCLUSIVE');
  const gap = verdict.gaps.find((entry) => entry.includes('passed'));
  assert.ok(gap.includes('focus_visible 判为 failed'));
  assert.ok(gap.includes('自相矛盾'));
  assert.equal(fixture.findings.length, 0);
});

test('a 20-criterion report cannot take the synthetic result and fails the first unverified criterion', async () => {
  const fixture = finishFixture({ extraCriteria: 18 });
  assert.equal(fixture.definition.criteria.length, 20);
  await fixture.finish(
    fixture.report({
      status: 'issue_found',
      focusVisible: 'unknown',
      bug: { title: '焦点样式不可见', expected: '', actual: '' },
    }),
  );
  const verdict = fixture.verdicts[0];
  assert.equal(verdict.status, 'issue_found');
  assert.equal(verdict.criterionResults.length, 20);
  assert.equal(
    verdict.criterionResults.some(
      (entry) => entry.criterionId === 'agent_reported_issue',
    ),
    false,
  );
  const failed = verdict.criterionResults.find(
    (entry) => entry.result === 'failed',
  );
  assert.equal(failed.criterionId, 'focus_visible');
  assert.ok(failed.reason.includes('焦点样式不可见'));
  assert.equal(fixture.findings.length, 1);
});

test('a reproducer that reports an issue outside the criteria keeps issue_found and writes a reproduction', async () => {
  const fixture = finishFixture({
    role: 'reproducer',
    sourceKind: 'user_spec',
  });
  await fixture.finish(
    fixture.report({
      status: 'issue_found',
      focusVisible: 'unknown',
      bug: {
        title: '焦点样式不可见',
        expected: '有焦点轮廓',
        actual: '看不到',
      },
    }),
  );
  const verdict = fixture.verdicts[0];
  assert.equal(verdict.status, 'issue_found');
  assert.ok(
    verdict.criterionResults.some(
      (entry) =>
        entry.criterionId === 'agent_reported_issue' &&
        entry.result === 'failed',
    ),
  );
  assert.equal(fixture.reproductions.length, 1);
  const reproduction = fixture.reproductions[0];
  assert.equal(reproduction.outcome, 'reproduced');
  assert.equal(reproduction.findingId, fixture.findingId);
  assert.deepEqual(fixture.reproductionEvidence, [
    { reproductionId: reproduction.id, artifactId: fixture.artifactId },
  ]);
  assert.equal(fixture.findingUpdates.length, 1);
  assert.equal(fixture.findingUpdates[0].status, 'confirmed');
  assert.equal(fixture.findingUpdates[0].reproductionId, reproduction.id);
});

test('a passed report with every criterion verified stays passed', async () => {
  const fixture = finishFixture();
  await fixture.finish(
    fixture.report({ status: 'passed', focusVisible: 'passed', bug: null }),
  );
  assert.equal(fixture.verdicts[0].status, 'passed');
  assert.equal(fixture.verdicts[0].reasonCode, 'AGENT_VERIFIED');
  assert.equal(fixture.findings.length, 0);
});

test('issue_found with a failed criterion creates a finding from the summary fallbacks', async () => {
  const fixture = finishFixture();
  await fixture.finish(
    fixture.report({
      status: 'issue_found',
      focusVisible: 'failed',
      bug: null,
      long: true,
    }),
  );
  const verdict = fixture.verdicts[0];
  assert.equal(verdict.status, 'issue_found');
  assert.equal(verdict.reasonCode, 'AGENT_ISSUE_FOUND');
  assert.equal(fixture.findings.length, 1);
  const finding = fixture.findings[0];
  assert.equal(finding.title, fixture.definition.title);
  assert.equal(finding.expected, fixture.definition.criteria[1].description);
  assert.ok(finding.actual.includes('长摘要'));
  assert.equal(finding.expectedSource, 'inferred');
  assert.equal(finding.status, 'suspected');
  assert.deepEqual(finding.caseIds, [fixture.definition.id]);
  assert.ok(finding.reproSteps.length > 0);
  assert.deepEqual(fixture.findingEvidence, [
    { findingId: finding.id, artifactId: fixture.artifactId },
  ]);
});

test('a bug with only a title is completed from the failed criterion', async () => {
  const fixture = finishFixture();
  await fixture.finish(
    fixture.report({
      status: 'issue_found',
      focusVisible: 'failed',
      bug: { title: '焦点样式不可见', expected: '', actual: '' },
    }),
  );
  const finding = fixture.findings[0];
  assert.equal(finding.title, '焦点样式不可见');
  assert.equal(finding.expected, fixture.definition.criteria[1].description);
  assert.ok(finding.actual.length > 0);
});

test('a complete bug is kept as written', async () => {
  const fixture = finishFixture();
  await fixture.finish(
    fixture.report({
      status: 'issue_found',
      focusVisible: 'failed',
      bug: {
        title: '焦点样式不可见',
        expected: '有焦点轮廓',
        actual: '看不到',
      },
    }),
  );
  const finding = fixture.findings[0];
  assert.equal(finding.title, '焦点样式不可见');
  assert.equal(finding.expected, '有焦点轮廓');
  assert.equal(finding.actual, '看不到');
});

test('a blocked report keeps its status and gaps', async () => {
  const fixture = finishFixture();
  await fixture.finish(
    fixture.report({ status: 'blocked', focusVisible: 'unknown', bug: null }),
  );
  const verdict = fixture.verdicts[0];
  assert.equal(verdict.status, 'blocked');
  assert.equal(verdict.reasonCode, 'AGENT_BLOCKED');
  assert.deepEqual(verdict.gaps, ['焦点样式未确认']);
  assert.equal(fixture.findings.length, 0);
});

test('a lease-level failure from the verdict guard is never swallowed', async () => {
  const fixture = finishFixture();
  fixture.expireLease();
  await assert.rejects(
    fixture.finish(
      fixture.report({ status: 'blocked', focusVisible: 'unknown', bug: null }),
    ),
    (error) => error.code === 'LEASE_EXPIRED',
  );
  assert.equal(fixture.verdicts.length, 0);
});

test('the tx rewrite diagnostic records the original DomainError code', async () => {
  const fixture = finishFixture();
  const warnings = [];
  const original = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    await assert.rejects(
      fixture.coordinator.tx(async () => {
        const { DomainError } = await import('@localqa/domain');
        throw new DomainError('SOMETHING_UNEXPECTED');
      }),
      (error) => error.code === 'VALIDATION_ERROR',
    );
  } finally {
    console.warn = original;
  }
  const rewritten = warnings
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === 'coordinator.tx.rewritten');
  assert.ok(rewritten, 'the rewrite is logged');
  assert.equal(rewritten.from, 'SOMETHING_UNEXPECTED');
  assert.equal(rewritten.to, 'VALIDATION_ERROR');
});
