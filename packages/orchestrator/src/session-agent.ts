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

export const SESSION_ROUND_LIMIT = 6;
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
  remainingCases: number;
  remainingPages: number;
  actionPolicy: Run['effectiveConfig']['actionPolicy'];
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
         CASE WHEN EXISTS(SELECT 1 FROM case_attempts a WHERE a.project_id=c.project_id AND a.case_id=c.id) THEN 'inconclusive' ELSE 'not_run' END) AS outcome
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
      remainingCases: Math.max(
        0,
        run.effectiveConfig.budget.maxCases - cases.length,
      ),
      remainingPages: Math.max(
        0,
        run.effectiveConfig.budget.maxPages - session.exploredUrls.length,
      ),
      actionPolicy: run.effectiveConfig.actionPolicy,
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
      fallbackToTechnicalSmoke =
        context.cases.length === 0 && context.remainingCases > 0;
      accepted = {
        action: 'dispatch',
        rationale: 'AI 规划输出被截断或格式不合法；服务端未采用该输出。',
        cases: [],
        exploreTargets: [],
        coverageGaps: [
          'AI 规划的结构化输出无效；业务用例未得到确认。',
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
          context.cases.length === 0 && context.remainingCases > 0;
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
    if (fallbackToTechnicalSmoke) {
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
    for (const url of accepted.exploreTargets)
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
    if (caseIds.length && ['explore', 'plan'].includes(run.phase))
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
      status: fallbackToTechnicalSmoke
        ? 'finalizing'
        : hasWork
          ? 'working'
          : 'finalizing',
      plan: clean(accepted.rationale),
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
    const session = await this.read(client, run);
    if (!session) return false;
    // A finalizing session can still have a suspected finding from the
    // completed technical executor. Offer independent reproduction before
    // entering finalize, so skipping extra AI planning cannot confirm a bug.
    if (
      session.status === 'finalizing' &&
      run.phase !== 'finalize' &&
      (await this.coordinator.enqueueReproductions(client, run, jobs))
    ) {
      if (run.phase !== 'reproduce')
        await this.coordinator.change(client, run, 'running', 'reproduce');
      return true;
    }
    if (session.status === 'finalizing' || session.status === 'complete') {
      if (run.phase !== 'finalize')
        run = await this.coordinator.change(client, run, 'running', 'finalize');
      if (jobs.some((j) => j.role === 'finalizer' && j.status === 'succeeded'))
        await this.coordinator.finalize(
          client,
          run,
          run.terminationReason ?? 'normal',
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
    if (
      session.status === 'working' &&
      (await this.coordinator.enqueueReproductions(client, run, jobs))
    ) {
      if (run.phase !== 'reproduce')
        await this.coordinator.change(client, run, 'running', 'reproduce');
      return true;
    }
    if (session.status === 'planning' || session.status === 'reviewing') {
      const manager = jobs.find(
        (j) =>
          j.result?.['sessionRound'] === session.round &&
          j.role === 'coordinator',
      );
      if (
        manager &&
        ['interrupted', 'failed', 'cancelled'].includes(manager.status)
      ) {
        await this.coordinator.finalize(
          client,
          run,
          run.terminationReason ?? 'worker_failure',
          'completed',
        );
        return true;
      }
      if (manager) return true;
    }
    if (session.round >= SESSION_ROUND_LIMIT) {
      await this.write(client, run, {
        ...session,
        status: 'finalizing',
        coverageGaps: [
          ...session.coverageGaps,
          '规划轮次达到上限，停止继续补测。',
        ].slice(0, 100),
      });
      await this.coordinator.enqueue(
        client,
        run,
        'finalizer',
        'finalize',
        'session-report',
        null,
      );
    } else {
      const next = {
        ...session,
        round: session.round + 1,
        status: session.round ? ('reviewing' as const) : ('planning' as const),
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
    }
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
