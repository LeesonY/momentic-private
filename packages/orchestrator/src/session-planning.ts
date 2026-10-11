import {
  parseContract,
  type CandidateCase,
  type Criterion,
  type SessionDecision,
} from '@localqa/contracts';
import { displayUrl, validateTarget, DomainError } from '@localqa/domain';
import { hashPayload } from '@localqa/storage';

export type SessionSource = {
  kind: Criterion['sourceKind'];
  ref: string;
  text: string;
};
export type PlannedSessionCase = CandidateCase & { entryUrl: string };
export interface PlanningContext {
  targetUrl: string;
  allowedOrigins: readonly string[];
  protectedOrigins: readonly string[];
  remainingCases: number;
  remainingPages: number;
  sources: readonly SessionSource[];
  existingCases: readonly (CandidateCase & { entryUrl?: string })[];
  exploredUrls: readonly string[];
  imageInput?: boolean;
}
const normalize = (text: string) =>
  text.trim().replace(/\s+/g, ' ').toLowerCase();
export function sessionCaseFingerprint(
  c: CandidateCase & { entryUrl?: string },
  fallback: string,
): string {
  const navigation = c.outline[0]?.startsWith('Navigate ')
    ? c.outline[0].slice(9)
    : null;
  return hashPayload({
    entry: displayUrl(c.entryUrl ?? navigation ?? fallback),
    preconditions: c.preconditions.map(normalize),
    outline: (navigation ? c.outline.slice(1) : c.outline).map(normalize),
    criteria: c.criteria.map(({ id: _id, ...criterion }) => ({
      ...criterion,
      description: normalize(criterion.description),
    })),
  });
}
export interface AcceptedSessionDecision {
  action: SessionDecision['action'];
  rationale: string;
  cases: PlannedSessionCase[];
  exploreTargets: string[];
  coverageGaps: string[];
}
/** Proposal validation never gives the model database IDs or permission to change an old case. */
export function reviewSessionProposal(
  input: unknown,
  context: PlanningContext,
): AcceptedSessionDecision {
  const proposal = parseContract('SessionDecision', input);
  if (
    proposal.action === 'finish' &&
    (proposal.cases.length || proposal.exploreTargets.length)
  )
    throw new DomainError('VALIDATION_ERROR');
  const coverageGaps = [...proposal.coverageGaps];
  const seen = new Set(
    context.existingCases.map((c) =>
      sessionCaseFingerprint(c, context.targetUrl),
    ),
  );
  const cases: PlannedSessionCase[] = [];
  for (const candidate of proposal.cases) {
    const entryUrl = displayUrl(
      validateTarget(
        candidate.entryUrl,
        context.allowedOrigins,
        context.protectedOrigins,
      ).toString(),
    );
    const ids = new Set<string>();
    const criteria = candidate.criteria.map((item): Criterion => {
      if (ids.has(item.id)) throw new DomainError('VALIDATION_ERROR');
      ids.add(item.id);
      const { sourceQuote, locator, expectedValue, ...base } = item;
      if (item.sourceKind === 'generic_smoke') {
        if (
          item.kind === 'http_status' &&
          item.sourceRef === 'FR-013/016' &&
          expectedValue === null
        )
          return {
            ...base,
            description: '入口返回成功的 HTTP 响应',
            expectedValue: { min: 200, max: 399 },
          };
        if (
          item.kind === 'element_visible' &&
          item.sourceRef === 'FR-016' &&
          locator?.by === 'css' &&
          locator.value === 'body'
        )
          return {
            ...base,
            description: '页面显示可见内容',
            locator: { by: 'css', value: 'body' },
          };
        throw new DomainError('VALIDATION_ERROR');
      }
      const source = context.sources.find(
        (s) => s.ref === item.sourceRef && s.kind === item.sourceKind,
      );
      if (
        !source ||
        item.sourceKind === 'saved_case' ||
        (item.sourceKind !== 'inferred' &&
          (!sourceQuote.trim() || !source.text.includes(sourceQuote)))
      )
        throw new DomainError('VALIDATION_ERROR');
      return parseContract('Criterion', {
        ...base,
        ...(locator
          ? {
              locator: {
                by: locator.by,
                value: locator.value,
                ...(locator.name !== null ? { name: locator.name } : {}),
              },
            }
          : {}),
        ...(expectedValue !== null ? { expectedValue } : {}),
      });
    });
    const c = {
      ...parseContract('CandidateCase', {
        title: candidate.title,
        summary: candidate.summary,
        preconditions: candidate.preconditions,
        outline: candidate.outline,
        criteria,
      }),
      entryUrl,
    };
    const fingerprint = sessionCaseFingerprint(c, context.targetUrl);
    if (
      c.criteria.some((criterion) => criterion.kind === 'visual') &&
      context.imageInput !== true
    ) {
      coverageGaps.push(
        `模型没有获准的图片验收能力，未执行视觉用例：${candidate.title}`,
      );
      continue;
    }
    if (seen.has(fingerprint)) {
      coverageGaps.push(`重复用例已跳过：${candidate.title}`);
      continue;
    }
    if (cases.length >= context.remainingCases) {
      coverageGaps.push(`用例预算不足，未执行：${candidate.title}`);
      continue;
    }
    seen.add(fingerprint);
    cases.push(c);
  }
  const explored = new Set(context.exploredUrls.map(displayUrl));
  const exploreTargets: string[] = [];
  for (const target of proposal.exploreTargets) {
    const url = displayUrl(
      validateTarget(
        target,
        context.allowedOrigins,
        context.protectedOrigins,
      ).toString(),
    );
    if (explored.has(url) || exploreTargets.includes(url)) continue;
    if (exploreTargets.length >= context.remainingPages) {
      coverageGaps.push(`页面预算不足，未探索：${url}`);
      continue;
    }
    exploreTargets.push(url);
  }
  return {
    action: proposal.action,
    rationale: proposal.rationale,
    cases,
    exploreTargets,
    coverageGaps: [...new Set(coverageGaps)].slice(0, 100),
  };
}
