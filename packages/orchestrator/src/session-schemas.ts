import { getValidator, type ContractName } from '@localqa/contracts';
import {
  INVALID_PLAN_STREAK_LIMIT,
  type SessionContext,
} from './session-agent.js';
import { CASE_RETRY_LIMIT } from './session-retries.js';
import { sessionEntryUrl } from './session-planning.js';

/** Only reachable contract definitions, so planning does not send the entire API schema. */
export function sessionOutputSchema(
  name: 'SessionDecision' | 'SessionConclusion',
): Record<string, unknown> {
  const definition = (key: string) => getValidator(key as ContractName).schema;
  const selected: Record<string, unknown> = {};
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (
        key === '$ref' &&
        typeof child === 'string' &&
        child.startsWith('#/$defs/')
      ) {
        const dependency = child.slice('#/$defs/'.length);
        if (!(dependency in selected)) {
          selected[dependency] = definition(dependency);
          visit(selected[dependency]);
        }
      } else visit(child);
    }
  };
  visit(definition(name));
  return { ...(definition(name) as Record<string, unknown>), $defs: selected };
}

/** Safe, schema-path-only account of why the previous round was rejected. */
function rejectedPlanNotice(
  context: SessionContext,
): Record<string, unknown> | null {
  const streak = context.session.invalidPlanStreak ?? 0;
  const failure = context.session.lastPlanFailure ?? null;
  if (streak <= 0 || !failure) return null;
  const reason =
    failure.reasonCode === 'MODEL_OUTPUT_TRUNCATED'
      ? '上一轮结构化输出被截断，没有通过格式校验。'
      : failure.reasonCode === 'TARGET_NOT_ALLOWED'
        ? '上一轮方案引用了未授权地址，没有通过服务端校验。'
        : '上一轮输出未通过格式校验（缺少必填字段、字段类型不符，或包含 schema 未定义的字段）。';
  const where = failure.schemaErrors.length
    ? `问题位置（schema 路径:关键词:属性名）：${failure.schemaErrors.join('；')}。`
    : '';
  return {
    attempt: streak,
    limit: INVALID_PLAN_STREAK_LIMIT,
    reasonCode: failure.reasonCode,
    schemaErrors: failure.schemaErrors,
    instruction: `${reason}${where}请严格按 outputSchema 输出 SessionDecision：只输出 JSON，不要包含 schema 未定义的字段（例如 cases[] 里不要出现 id、report、retryCount），必填字段必须齐全。这是连续第 ${streak} 次不合格，达到 ${INVALID_PLAN_STREAK_LIMIT} 次将停止规划并收尾。`,
  };
}

/** Keep identities, latest results, retry fences and finding review fields even
 * when long narrative context is trimmed. Summaries retain only unique findings. */
export function sessionModelContext(
  context: SessionContext,
  purpose: 'plan' | 'summarize' = 'plan',
): Record<string, unknown> {
  const brief = context.session.objective;
  const findings = context.findings.filter(
    (finding) =>
      purpose !== 'summarize' || finding.triageDisposition !== 'duplicate',
  );
  const caseContext = (c: SessionContext['cases'][number], compact = 0) => {
    const navigation = c.definition.outline[0]?.startsWith('Navigate ');
    const outline = navigation
      ? c.definition.outline.slice(1)
      : c.definition.outline;
    const criteria = c.definition.criteria.slice(0, compact ? 3 : 20);
    const retry = context.caseRetries?.[c.definition.id];
    return {
      caseId: c.definition.id,
      entryUrl: sessionEntryUrl(c.definition, context.targetUrl),
      requiresLogin: c.definition.requiresLogin !== false,
      title: c.definition.title.slice(
        0,
        compact === 2 ? 60 : compact ? 80 : 120,
      ),
      outcome: c.outcome,
      retryCount: retry?.retries ?? 0,
      lastAttempt: retry?.lastAttempt ?? (c.verdict ? 1 : 0),
      preconditions: c.definition.preconditions
        .slice(0, compact === 2 ? 1 : compact ? 2 : 4)
        .map((item) => item.slice(0, compact === 2 ? 60 : compact ? 80 : 160)),
      outline: outline
        .slice(0, compact === 2 ? 1 : compact ? 2 : 6)
        .map((step) => step.slice(0, compact === 2 ? 60 : compact ? 100 : 180)),
      criteria: criteria.map((k) => ({
        id: k.id,
        description: k.description.slice(
          0,
          compact === 2 ? 40 : compact ? 80 : 180,
        ),
        ...(!compact
          ? { sourceKind: k.sourceKind, sourceRef: k.sourceRef }
          : {}),
      })),
      ...(criteria.length < c.definition.criteria.length
        ? { criteriaOmitted: c.definition.criteria.length - criteria.length }
        : {}),
      ...(!compact ? { results: c.verdict?.criterionResults } : {}),
      report: c.verdict
        ? {
            status: c.verdict.status,
            summary: c.verdict.summary.slice(
              0,
              compact === 2 ? 120 : compact ? 200 : 400,
            ),
            verified: (c.verdict.verified ?? [])
              .slice(0, compact === 2 ? 0 : compact ? 2 : 6)
              .map((item) => item.slice(0, compact ? 100 : 160)),
            gaps: c.verdict.gaps
              .slice(0, compact === 2 ? 2 : compact ? 3 : 6)
              .map((gap) =>
                gap.slice(0, compact === 2 ? 80 : compact ? 100 : 200),
              ),
          }
        : null,
    };
  };
  const findingContext = (
    f: SessionContext['findings'][number],
    compact = 0,
  ) => ({
    id: f.id,
    title: f.title.slice(0, compact === 2 ? 60 : compact ? 80 : 120),
    status: f.status,
    triageDisposition: f.triageDisposition,
    duplicateOf: f.duplicateOf ?? null,
    caseIds: f.caseIds,
    expected: f.expected.slice(0, compact === 2 ? 64 : compact ? 80 : 200),
    actual: f.actual.slice(0, compact === 2 ? 64 : compact ? 80 : 200),
  });
  const rejectedPlan = purpose === 'plan' ? rejectedPlanNotice(context) : null;
  const result: Record<string, unknown> = {
    session: {
      ...context.session,
      reviewedTaskIds: undefined,
      objective: brief.slice(0, 1800),
      plan: context.session.plan.slice(0, 500),
      history: context.session.history.slice(-12).map((round) => ({
        ...round,
        reason: round.reason.slice(0, 200),
      })),
      coverageGaps: context.session.coverageGaps
        .slice(-10)
        .map((gap) => gap.slice(0, 200)),
      summary: context.session.summary.slice(0, 1000),
    },
    actionPolicy: context.actionPolicy,
    taskIntent: context.taskIntent,
    writeScope: context.writeScope,
    assertionCapabilities: context.assertionCapabilities,
    signIn: context.signIn,
    remainingCases: context.remainingCases,
    remainingPages: context.remainingPages,
    concurrency: context.concurrency,
    caseRetryLimit: CASE_RETRY_LIMIT,
    findingCount: findings.filter((f) => f.triageDisposition !== 'duplicate')
      .length,
    ...(rejectedPlan ? { previousPlanRejected: rejectedPlan } : {}),
    activeTasks: context.activeTasks,
    sources: context.sources.slice(0, 8).map((source) => ({
      ...source,
      text: source.text.slice(0, source.kind === 'user_spec' ? 2400 : 1000),
    })),
    observations: context.observations.slice(0, 4).map((observation) => ({
      ...observation,
      nodes: observation.nodes
        .slice(0, 12)
        .map((node) => ({ ...node, text: node.text.slice(0, 100) })),
    })),
    cases: context.cases.map((c) => caseContext(c)),
    findings: findings.map((f) => findingContext(f)),
    contextNote:
      '上下文包含全部用例/缺陷标识、最近执行结果、重跑次数及合并关系；长文本、部分验收描述、旧观察和旧规划轮次经过裁剪。cases[].report 仅是最近一次非复现的执行尝试；新尝试无有效报告时为 null，不得套用旧报告。activeTasks 是尚未完成的任务，不要把它们判为失败、重复派工或提前报告完成。duplicate 缺陷仅供追溯，不作为独立缺陷计数或 sameAs 目标。',
  };
  const size = () => Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (size() > 24000) result['observations'] = [];
  if (size() > 24000)
    result['sources'] = context.sources
      .slice(0, 4)
      .map((source) => ({ ...source, text: source.text.slice(0, 500) }));
  if (size() > 24000)
    result['cases'] = context.cases.map((c) => caseContext(c, 1));
  if (size() > 24000)
    result['findings'] = findings.map((f) => findingContext(f, 1));
  if (size() > 24000) {
    result['session'] = {
      round: context.session.round,
      status: context.session.status,
      objective: brief.slice(0, 500),
      summary: context.session.summary.slice(0, 500),
      history: context.session.history.slice(-6).map((round) => ({
        round: round.round,
        reason: round.reason.slice(0, 80),
      })),
    };
    result['sources'] = context.sources
      .slice(0, 3)
      .map((source) => ({ ...source, text: source.text.slice(0, 200) }));
    result['activeTasks'] = context.activeTasks.map((task) => ({
      ...task,
      summary: task.summary.slice(0, 40),
    }));
  }
  if (size() > 24000)
    result['cases'] = context.cases.map((c) => caseContext(c, 2));
  if (size() > 24000)
    result['findings'] = findings.map((f) => findingContext(f, 2));
  return result;
}
