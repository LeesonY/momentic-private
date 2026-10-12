// Compatibility for authentication-only wire fixtures: cover the new session
// stages without inventing business rules or relaxing the private auth checks.
export function scriptedSessionResponse(body) {
  const text = (message) =>
    typeof message.content === 'string'
      ? message.content
      : message.content.map((p) => p.text ?? '').join('\n');
  const system = body.messages
    .filter((m) => m.role === 'system')
    .map(text)
    .join('\n');
  if (
    !system.includes('只输出 SessionDecision JSON') &&
    !system.includes('只输出 SessionConclusion JSON')
  )
    return null;
  const context = body.messages
    .flatMap((m) =>
      typeof m.content === 'string' ? [{ text: m.content }] : m.content,
    )
    .map((p) => {
      try {
        return JSON.parse(p.text);
      } catch {
        return null;
      }
    })
    .find((p) => p?.session);
  if (system.includes('只输出 SessionConclusion JSON'))
    return {
      overview: '完成受控认证和页面可见性检查。',
      caseComments: context.cases.map((c) => ({
        caseId: c.caseId,
        comment: c.outcome,
      })),
      coverageGaps: [],
    };
  const result = {
    action: 'dispatch',
    rationale: '验证已认证入口的可见内容',
    exploreTargets: [],
    cases: [],
    coverageGaps: [],
  };
  if (!context.observations.length) result.exploreTargets = [context.targetUrl];
  else if (!context.cases.length && context.remainingCases)
    result.cases = [
      {
        entryUrl: context.targetUrl,
        title: '已认证页面可见性',
        summary: '受控页面入口检查',
        preconditions: [],
        outline: ['检查可见内容'],
        criteria: [
          {
            id: 'smoke.visible',
            kind: 'element_visible',
            description: '页面内容可见',
            sourceKind: 'generic_smoke',
            sourceRef: 'FR-016',
            sourceQuote: '',
            locator: { by: 'css', value: 'body', name: null },
            expectedValue: null,
          },
        ],
      },
    ];
  else result.action = 'finish';
  return result;
}
