import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  parseContract,
  type Run,
  type SessionReport,
  type BrowserSnapshot,
  type CaseRecord,
  type Finding,
} from '@localqa/contracts';
import { sanitizeText } from '@localqa/browser';
import { DomainError, smokeCase } from '@localqa/domain';
import { appendEvent, hashPayload, StorageError } from '@localqa/storage';
import type { Coordinator, JobRow } from './core.js';
import {
  reviewSessionProposal,
  type SessionSource,
} from './session-planning.js';

export const SESSION_ROUND_LIMIT = 64;
const clean = (value: string) =>
  sanitizeText(value).replace(
    /((?:密码|口令|password|secret|api[_ -]?key)\s*[:：=]\s*)\S+/gi,
    '$1[redacted]',
  );
export interface SessionContext {
  session: SessionReport;
  sources: SessionSource[];
  observations: Array<
    Pick<
      BrowserSnapshot,
      'snapshotId' | 'displayUrl' | 'title' | 'responseStatus' | 'truncated'
    > & {
      nodes: Array<
        Pick<BrowserSnapshot['nodes'][number], 'role' | 'name' | 'text'>
      >;
    }
  >;
  cases: CaseRecord[];
  findings: Finding[];
  activeTasks: Array<{
    id: string;
    role: JobRow['role'];
    status: JobRow['status'];
    caseId: string | null;
    summary: string;
  }>;
  concurrency: number;
  remainingCases: number;
  remainingPages: number;
  actionPolicy: Run['effectiveConfig']['actionPolicy'];
  taskIntent: Run['effectiveConfig']['taskIntent'];
  writeScope: readonly string[];
  assertionCapabilities: {
    structuredOutput: boolean;
    nativeTools: boolean;
    imageInput: boolean;
  };
}

/** Model proposes work; transactions own IDs, quotas, source checks and dispatch. */
export class SessionAgent {
  constructor(private coordinator: Coordinator) {}
  async initialize(client: PoolClient, run: Run, brief: string): Promise<void> {
    const document = parseContract('SessionReport', {
      objective: clean(brief),
      round: 0,
      status: 'planning',
      plan: '',
      caseIds: [],
      exploredUrls: [],
      coverageGaps: [],
      summary: '',
      history: [],
    });
    await client.query(
      'INSERT INTO run_sessions(project_id,run_id,document) VALUES($1,$2,$3)',
      [run.projectId, run.id, document],
    );
    await appendEvent(
      client,
      run.projectId,
      run.id,
      'session.updated',
      document,
    );
  }
  async read(client: PoolClient, run: Run): Promise<SessionReport | null> {
    const row = (
      await client.query<{ document: unknown }>(
        'SELECT document FROM run_sessions WHERE project_id=$1 AND run_id=$2',
        [run.projectId, run.id],
      )
    ).rows[0];
    return row ? parseContract('SessionReport', row.document) : null;
  }
  async write(
    client: PoolClient,
    run: Run,
    document: SessionReport,
  ): Promise<void> {
    const checked = parseContract('SessionReport', document);
    await client.query(
      'UPDATE run_sessions SET document=$3 WHERE project_id=$1 AND run_id=$2',
      [run.projectId, run.id, checked],
    );
    await appendEvent(
      client,
      run.projectId,
      run.id,
      'session.updated',
      checked,
    );
  }
  async context(client: PoolClient, run: Run): Promise<SessionContext | null> {
    const session = await this.read(client, run);
    if (!session) return null;
    const sources: SessionSource[] = session.objective.trim()
      ? [
          {
            kind: 'user_spec',
            ref: `brief:${hashPayload(session.objective)}`,
            text: session.objective,
          },
        ]
      : [];
    const messages = (
      await client.query<{ id: string; redacted_text: string }>(
        'SELECT id,redacted_text FROM run_messages WHERE project_id=$1 AND run_id=$2 AND actor_id IS NOT NULL AND context_version<=$3 ORDER BY created_at DESC LIMIT 5',
        [run.projectId, run.id, run.contextVersion],
      )
    ).rows;
    for (const message of messages)
      sources.push({
        kind: 'user_spec',
        ref: `message:${message.id}`,
        text: clean(message.redacted_text),
      });
    const knowledge = (
      await client.query<{
        id: string;
        document: { text?: string; sourceRef?: string };
      }>(
        'SELECT v.id,v.document FROM run_knowledge_bindings b JOIN knowledge_versions v ON v.id=b.knowledge_version_id AND v.project_id=b.project_id WHERE b.project_id=$1 AND b.run_id=$2',
        [run.projectId, run.id],
      )
    ).rows;
    for (const row of knowledge)
      if (row.document.text)
        sources.push({
          kind: 'project_knowledge',
          ref: `knowledge:${row.id}`,
          text: clean(row.document.text).slice(0, 4000),
        });
    const snapshots = (
      await client.query<{ document: BrowserSnapshot }>(
        `SELECT document FROM page_snapshots WHERE project_id=$1 AND run_id=$2 ORDER BY document->>'capturedAt' DESC,id LIMIT 12`,
        [run.projectId, run.id],
      )
    ).rows;
    const observations: SessionContext['observations'] = [];
    const urls = new Set<string>();
    for (const { document: snapshot } of snapshots) {
      if (urls.has(snapshot.displayUrl)) continue;
      urls.add(snapshot.displayUrl);
      const observed = {
        snapshotId: snapshot.snapshotId,
        displayUrl: snapshot.displayUrl,
        title: snapshot.title,
        responseStatus: snapshot.responseStatus,
        truncated: snapshot.truncated,
        nodes: snapshot.nodes
          .filter((n) => n.visible)
          .slice(0, 40)
          .map((n) => ({
            role: n.role,
            name: clean(n.name).slice(0, 160),
            text: clean(n.text).slice(0, 240),
          })),
      };
      observations.push(observed);
      sources.push({
        kind: 'inferred',
        ref: `observation:${snapshot.snapshotId}`,
        text: JSON.stringify(observed),
      });
    }
    const rows = (
      await client.query<{
        definition: unknown;
        verdict: unknown;
        outcome: string;
      }>(
        `SELECT c.document AS definition,v.document AS verdict,COALESCE(v.document->>'status',
         CASE WHEN EXISTS(SELECT 1 FROM case_attempts a WHERE a.project_id=c.project_id AND a.case_id=c.id AND a.finished_at IS NOT NULL) THEN 'inconclusive' ELSE 'not_run' END) AS outcome
       FROM run_cases c LEFT JOIN final_valid_verdicts v ON v.project_id=c.project_id AND v.case_id=c.id
       WHERE c.project_id=$1 AND c.run_id=$2 ORDER BY c.id`,
        [run.projectId, run.id],
      )
    ).rows;
    const cases = rows.map((row) =>
      parseContract('CaseRecord', { ...row, verdict: row.verdict ?? null }),
    );
    const findings = (
      await client.query<{ document: unknown }>(
        'SELECT document FROM findings WHERE project_id=$1 AND run_id=$2 ORDER BY id',
        [run.projectId, run.id],
      )
    ).rows.map((row) => parseContract('Finding', row.document));
    const activeTasks = (
      await client.query<JobRow>(
        "SELECT * FROM jobs WHERE project_id=$1 AND run_id=$2 AND role IN ('explorer','executor','reproducer') AND status IN ('queued','running','waiting') ORDER BY available_at,id",
        [run.projectId, run.id],
      )
    ).rows.map((job) => ({
      id: job.id,
      role: job.role,
      status: job.status,
      caseId: job.case_id,
      summary: clean(job.document.summary).slice(0, 200),
    }));
    const binding = run.effectiveConfig.models.assertion;
    const profile = (
      await client.query<{ document: unknown }>(
        'SELECT document FROM model_profile_versions WHERE profile_id=$1 AND version=$2',
        [binding.profileId, binding.version],
      )
    ).rows[0];
    const assertionCapabilities = profile
      ? parseContract('ModelProfile', profile.document).capabilities
      : { structuredOutput: false, nativeTools: false, imageInput: false };
    return {
      session,
      sources,
      observations,
      cases,
      findings,
      activeTasks,
      concurrency: run.effectiveConfig.budget.concurrency,
      remainingCases: Math.max(
        0,
        run.effectiveConfig.budget.maxCases - cases.length,
      ),
      remainingPages: Math.max(
        0,
        run.effectiveConfig.budget.maxPages - session.exploredUrls.length,
      ),
      actionPolicy: run.effectiveConfig.actionPolicy,
      taskIntent: run.effectiveConfig.taskIntent ?? 'flow',
      writeScope: run.effectiveConfig.writeScope ?? [],
      assertionCapabilities,
    };
  }
  async applyPlan(
    client: PoolClient,
    run: Run,
    job: JobRow,
    input: unknown,
    plannerFailureCode?: string,
  ): Promise<void> {
    if (job.role !== 'coordinator' || job.result?.['stage'] !== 'plan')
      throw new StorageError('FORBIDDEN');
    await client.query(
      'SELECT run_id FROM run_sessions WHERE project_id=$1 AND run_id=$2 FOR UPDATE',
      [run.projectId, run.id],
    );
    const context = await this.context(client, run);
    if (!context || context.session.round !== job.result['sessionRound'])
      throw new StorageError('VERSION_CONFLICT');
    let accepted: ReturnType<typeof reviewSessionProposal>;
    let fallbackToTechnicalSmoke = false;
    if (plannerFailureCode !== undefined) {
      // Failure codes are emitted by the trusted model gateway, not inferred
      // from model text. Provider/network/billing failures must NOT fall back.
      if (
        input !== undefined ||
        !['MODEL_OUTPUT_TRUNCATED', 'VALIDATION_ERROR'].includes(
          plannerFailureCode,
        )
      )
        throw new StorageError('VALIDATION_ERROR');
      // Recover once by exploring the server-authorized entry URL.
      // A repeated planner failure still uses immutable technical smoke.
      const exploreBeforeFallback =
        context.session.round === 1 &&
        context.session.exploredUrls.length === 0 &&
        context.remainingPages > 0 &&
        run.effectiveConfig.taskIntent !== 'plan';
      fallbackToTechnicalSmoke =
        !exploreBeforeFallback &&
        context.cases.length === 0 &&
        context.remainingCases > 0 &&
        run.effectiveConfig.taskIntent !== 'plan';
      accepted = {
        action: 'dispatch',
        rationale: exploreBeforeFallback
          ? 'AI 规划输出无效；使用已授权入口的只读探索结果重新规划。'
          : 'AI 规划输出被截断或格式不合法；服务端未采用该输出。',
        cases: [],
        exploreTargets: exploreBeforeFallback ? [run.targetUrl] : [],
        coverageGaps: [
          exploreBeforeFallback
            ? '首次 AI 规划无效；仅探索已授权入口，等待基于观察的下一轮规划。'
            : 'AI 规划的结构化输出无效；业务用例未得到确认。',
          ...(fallbackToTechnicalSmoke
            ? ['仅执行服务端固定的入口 HTTP/可见性技术冒烟。']
            : []),
        ],
      };
    } else {
      try {
        accepted = reviewSessionProposal(input, {
          ...context,
          targetUrl: run.targetUrl,
          allowedOrigins: run.effectiveConfig.allowedOrigins,
          protectedOrigins: this.coordinator.protectedOrigins,
          existingCases: context.cases.map((c) => c.definition),
          exploredUrls: context.session.exploredUrls,
          imageInput: context.assertionCapabilities.imageInput,
        });
      } catch (error) {
        // A model's invalid source attribution or unauthorized proposed case
        // must never become an executable business assertion. Preserve an
        // explicit coverage gap and use only the server-owned technical smoke
        // oracle (with immutable FR-013/016 criteria) on the approved entry.
        const invalidProposal =
          (error instanceof DomainError || error instanceof StorageError) &&
          ['VALIDATION_ERROR', 'TARGET_NOT_ALLOWED'].includes(error.code);
        if (!invalidProposal) throw error;
        fallbackToTechnicalSmoke =
          context.cases.length === 0 &&
          context.remainingCases > 0 &&
          run.effectiveConfig.taskIntent !== 'plan';
        accepted = {
          action: 'dispatch',
          rationale: 'AI 规划不符合源引用或授权约束，已拒绝原方案。',
          cases: [],
          exploreTargets: [],
          coverageGaps: [
            'AI 规划未通过服务端校验；未执行其业务断言。',
            ...(fallbackToTechnicalSmoke
              ? ['仅执行服务端固定的入口 HTTP/可见性技术冒烟。']
              : []),
          ],
        };
      }
    }
    const caseIds: string[] = [];
    const planningOnly = run.effectiveConfig.taskIntent === 'plan';
    if (fallbackToTechnicalSmoke && !planningOnly) {
      const c = smokeCase(run, run.targetUrl);
      await this.coordinator.insertCase(client, c);
      await this.coordinator.enqueue(
        client,
        run,
        'executor',
        'execute',
        `${c.id}:v${c.version}`,
        c.id,
        1,
        { entryUrl: run.targetUrl },
      );
      caseIds.push(c.id);
    }
    for (const candidate of accepted.cases) {
      const { entryUrl, ...data } = candidate;
      const definition = parseContract('CaseDefinition', {
        ...data,
        id: randomUUID(),
        projectId: run.projectId,
        runId: run.id,
        version: 1,
        outline: [`Navigate ${entryUrl}`, ...data.outline],
      });
      await this.coordinator.insertCase(client, definition);
      if (!planningOnly)
        await this.coordinator.enqueue(
          client,
          run,
          'executor',
          'execute',
          `${definition.id}:v1`,
          definition.id,
          1,
          { entryUrl },
        );
      caseIds.push(definition.id);
    }
    for (const url of planningOnly ? [] : accepted.exploreTargets)
      await this.coordinator.enqueue(
        client,
        run,
        'explorer',
        'explore',
        `session:${context.session.round}:${hashPayload(url)}`,
        null,
        1,
        { entryUrl: url },
      );
    if (
      !planningOnly &&
      caseIds.length &&
      ['explore', 'plan'].includes(run.phase)
    )
      await this.coordinator.change(client, run, 'running', 'execute');
    const hasWork = caseIds.length > 0 || accepted.exploreTargets.length > 0;
    const gaps = [...context.session.coverageGaps, ...accepted.coverageGaps];
    if (!hasWork && accepted.action === 'dispatch')
      gaps.push('主 AI 未提出可执行的新任务，已停止重复派工。');
    if (!hasWork && !context.cases.length)
      gaps.push('本次没有可执行用例，不能据此认为目标系统通过测试。');
    const document: SessionReport = {
      ...context.session,
      // An invalid model plan cannot be repaired by repeatedly prompting the
      // same planner after dispatching the fixed technical fallback. Finish
      // after its owned executor/reproducer work, retaining the coverage gap.
      status:
        planningOnly || fallbackToTechnicalSmoke
          ? 'finalizing'
          : hasWork
            ? 'working'
            : 'finalizing',
      planningStopped: planningOnly || fallbackToTechnicalSmoke,
      plan: clean(accepted.rationale),
      ...(!context.session.title && accepted.title?.trim()
        ? { title: clean(accepted.title).slice(0, 60) }
        : {}),
      caseIds: [...context.session.caseIds, ...caseIds],
      exploredUrls: [
        ...new Set([
          ...context.session.exploredUrls,
          ...accepted.exploreTargets,
        ]),
      ],
      coverageGaps: [...new Set(gaps.map(clean))].slice(0, 100),
      history: [
        ...context.session.history,
        {
          round: context.session.round,
          reason: clean(accepted.rationale),
          caseIds,
          exploreTargets: accepted.exploreTargets,
        },
      ],
    };
    await this.write(client, run, document);
  }
  async conclude(client: PoolClient, run: Run, input: unknown): Promise<void> {
    const conclusion = parseContract('SessionConclusion', input);
    const context = await this.context(client, run);
    if (!context) throw new StorageError('NOT_FOUND');
    const ids = new Set(context.cases.map((c) => c.definition.id));
    if (conclusion.caseComments.some((comment) => !ids.has(comment.caseId)))
      throw new StorageError('VALIDATION_ERROR');
    await this.write(client, run, {
      ...context.session,
      status: 'complete',
      summary: clean(conclusion.overview),
      coverageGaps: [
        ...new Set([
          ...context.session.coverageGaps,
          ...conclusion.coverageGaps.map(clean),
          ...context.cases
            .filter((c) => !['passed', 'issue_found'].includes(c.outcome))
            .map((c) => `尚未验证：${c.definition.title}（${c.outcome}）`),
          ...context.findings
            .filter((f) => f.status !== 'confirmed')
            .map((f) => `缺陷尚未复现确认：${f.title}（${f.status}）`),
        ]),
      ].slice(0, 100),
    });
  }
  async advance(
    client: PoolClient,
    run: Run,
    jobs: JobRow[],
  ): Promise<boolean> {
    let session = await this.read(client, run);
    if (!session) return false;
    const latestMessage =
      (
        await client.query<{ id: string }>(
          'SELECT id FROM run_messages WHERE project_id=$1 AND run_id=$2 AND actor_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1',
          [run.projectId, run.id],
        )
      ).rows[0]?.id ?? null;
    const pending = (job: JobRow) =>
      ['queued', 'running', 'waiting'].includes(job.status);
    // Completion watermarks are consumed only when a manager is enqueued.
    // Results arriving during its model call remain available for the next
    // review. Tick/retried finish calls cannot create competing managers.
    if (
      jobs.some(
        (job) =>
          ['coordinator', 'finalizer'].includes(job.role) && pending(job),
      )
    )
      return true;
    const children = jobs.filter(
      (job) =>
        ['explorer', 'executor', 'reproducer'].includes(job.role) &&
        ['explore', 'execute', 'reproduce', 'recover'].includes(
          String(job.result?.['stage'] ?? job.document.summary),
        ),
    );
    const completed = children
      .filter((job) => !pending(job))
      .map((job) => job.id);
    const reviewed = new Set(session.reviewedTaskIds ?? []);
    const hasNewResult = completed.some((id) => !reviewed.has(id));
    const hasNewMessage = latestMessage !== (session.messageCursor ?? null);
    const reproduced =
      run.phase !== 'finalize'
        ? await this.coordinator.enqueueReproductions(client, run, jobs)
        : 0;
    if (reproduced && run.phase !== 'reproduce')
      run = await this.coordinator.change(client, run, 'running', 'reproduce');
    const childrenPending = reproduced > 0 || children.some(pending);
    if (session.status === 'planning' || session.status === 'reviewing') {
      const round = session.round;
      const manager = jobs.find(
        (j) => j.result?.['sessionRound'] === round && j.role === 'coordinator',
      );
      if (
        manager &&
        ['interrupted', 'failed', 'cancelled'].includes(manager.status)
      ) {
        if (!childrenPending)
          await this.coordinator.finalize(
            client,
            run,
            run.terminationReason ?? 'worker_failure',
            'completed',
          );
        return true;
      }
    }
    if (
      run.phase !== 'finalize' &&
      session.status !== 'complete' &&
      !session.planningStopped &&
      session.round < SESSION_ROUND_LIMIT &&
      (session.round === 0 || hasNewResult || hasNewMessage)
    ) {
      const next: SessionReport = {
        ...session,
        round: session.round + 1,
        messageCursor: latestMessage,
        reviewedTaskIds: [...new Set([...reviewed, ...completed])],
        status: session.round ? 'reviewing' : 'planning',
      };
      await this.write(client, run, next);
      await this.coordinator.enqueue(
        client,
        run,
        'coordinator',
        'plan',
        `session:${next.round}`,
        null,
        1,
        { sessionRound: next.round },
      );
      return true;
    }
    if (session.round >= SESSION_ROUND_LIMIT && !session.planningStopped) {
      session = {
        ...session,
        status: 'finalizing',
        planningStopped: true,
        coverageGaps: [
          ...session.coverageGaps,
          '规划轮次达到上限，停止继续补测。',
        ].slice(0, 100),
      };
      await this.write(client, run, session);
    }
    // A finish proposal stops adding work until fresh results arrive. Reporting
    // is allowed only after every browser job (including waiting jobs) settles.
    if (childrenPending) return true;
    if (!['finalizing', 'complete'].includes(session.status))
      await this.write(client, run, {
        ...session,
        status: 'finalizing',
      });
    if (run.phase !== 'finalize')
      run = await this.coordinator.change(client, run, 'running', 'finalize');
    const finalizer = jobs.find((job) => job.role === 'finalizer');
    if (finalizer && !pending(finalizer))
      await this.coordinator.finalize(
        client,
        run,
        run.terminationReason ??
          (finalizer.status === 'succeeded' ? 'normal' : 'worker_failure'),
        'completed',
      );
    else
      await this.coordinator.enqueue(
        client,
        run,
        'finalizer',
        'finalize',
        'session-report',
        null,
      );
    return true;
  }
  async finishRun(client: PoolClient, run: Run, reason: string): Promise<void> {
    const session = await this.read(client, run);
    if (!session) return;
    await this.write(client, run, {
      ...session,
      status: 'complete',
      coverageGaps:
        reason === 'normal'
          ? session.coverageGaps
          : [
              ...new Set([
                ...session.coverageGaps,
                `运行提前结束：${reason}，覆盖范围以实际执行记录为准。`,
              ]),
            ].slice(0, 100),
    });
  }
}
