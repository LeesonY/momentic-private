import type { SessionDecision, RunConfig } from '@localqa/contracts';

/**
 * A model-generated request for clarification cannot expand a frozen run's
 * authority, request secrets or stall authorized exploration. Real OTP and
 * authentication input use independent trusted mechanisms.
 */
export function continueWithoutPlannerQuestion(
  decision: SessionDecision,
  context: {
    taskIntent: RunConfig['taskIntent'];
    targetUrl: string;
    remainingPages: number;
    exploredUrls: readonly string[];
    activeTasks: readonly { status: string }[];
  },
): SessionDecision {
  if (decision.action !== 'ask') return decision;

  const targetAlreadyExplored = context.exploredUrls.some((url) => {
    try {
      const a = new URL(url);
      const b = new URL(context.targetUrl);
      return a.origin === b.origin && a.pathname === b.pathname;
    } catch {
      return false;
    }
  });
  const canExplore =
    context.taskIntent !== 'plan' &&
    context.remainingPages > 0 &&
    !targetAlreadyExplored &&
    !context.activeTasks.some((task) =>
      ['queued', 'running', 'waiting'].includes(task.status),
    );
  // Do not persist untrusted question text: it may echo private page content.
  const gap = canExplore
    ? '主 AI 请求额外澄清；已改为在现有授权范围内自主观察目标页面。'
    : '主 AI 请求额外澄清，但缺少足够可核实依据；相关业务预期保留为未验证，不推断通过。';

  return {
    action: canExplore ? 'dispatch' : 'finish',
    rationale: canExplore
      ? '依据已授权目标继续探索；不因普通歧义中断任务。'
      : '已用现有资料完成可执行部分；将未核实事项留在覆盖缺口。',
    cases: [],
    exploreTargets: canExplore ? [context.targetUrl] : [],
    coverageGaps: [...new Set([...decision.coverageGaps, gap])].slice(0, 20),
    ...(decision.title ? { title: decision.title } : {}),
  };
}
