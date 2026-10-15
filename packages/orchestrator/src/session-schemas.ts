import { loginReportText } from './session-agent.js';
import { getValidator, type ContractName } from '@localqa/contracts';
import type { SessionContext } from './session-agent.js';

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

/** Keep all case IDs/outcomes, but bound narrative context and mark omitted detail. */
export function sessionModelContext(
  context: SessionContext,
): Record<string, unknown> {
  const brief = context.session.objective;
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
    login:
      context.login.status === 'blocked'
        ? { ...context.login, detail: loginReportText(context.login) }
        : context.login,
    remainingCases: context.remainingCases,
    remainingPages: context.remainingPages,
    concurrency: context.concurrency,
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
    cases: context.cases.map((c) => ({
      caseId: c.definition.id,
      title: c.definition.title.slice(0, 120),
      outcome: c.outcome,
      outline: c.definition.outline
        .slice(0, 6)
        .map((step) => step.slice(0, 180)),
      criteria: c.definition.criteria.map((k) => ({
        id: k.id,
        description: k.description.slice(0, 180),
        sourceKind: k.sourceKind,
        sourceRef: k.sourceRef,
      })),
      results: c.verdict?.criterionResults,
      report: c.verdict
        ? {
            status: c.verdict.status,
            summary: c.verdict.summary.slice(0, 400),
            verified: (c.verdict.verified ?? [])
              .slice(0, 6)
              .map((item) => item.slice(0, 160)),
            gaps: c.verdict.gaps.slice(0, 6).map((gap) => gap.slice(0, 200)),
          }
        : null,
    })),
    findings: context.findings.map((f) => ({
      id: f.id,
      title: f.title.slice(0, 120),
      status: f.status,
      caseIds: f.caseIds,
      expected: f.expected.slice(0, 200),
      actual: f.actual.slice(0, 200),
    })),
    contextNote:
      '上下文包含全部用例标识和权威结果，长文本、旧观察和旧规划轮次经过裁剪。activeTasks 是尚未完成的任务，不要把它们判为失败、重复派工或提前报告完成；只根据新结果追加独立工作。',
  };
  const size = () => Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (size() > 24000) result['observations'] = [];
  if (size() > 24000)
    result['sources'] = context.sources
      .slice(0, 4)
      .map((source) => ({ ...source, text: source.text.slice(0, 500) }));
  if (size() > 24000)
    result['cases'] = context.cases.map((c) => ({
      caseId: c.definition.id,
      title: c.definition.title.slice(0, 80),
      outcome: c.outcome,
    }));
  if (size() > 24000)
    result['findings'] = context.findings.map((f) => ({
      id: f.id,
      title: f.title.slice(0, 80),
      status: f.status,
      caseIds: f.caseIds,
    }));
  if (size() > 24000) {
    result['session'] = {
      round: context.session.round,
      status: context.session.status,
      objective: brief.slice(0, 500),
      history: context.session.history.slice(-12).map((round) => ({
        round: round.round,
        reason: round.reason.slice(0, 80),
      })),
    };
    result['sources'] = context.sources
      .slice(0, 3)
      .map((source) => ({ ...source, text: source.text.slice(0, 200) }));
    result['findings'] = context.findings.map((f) => ({
      id: f.id,
      status: f.status,
    }));
  }
  return result;
}
