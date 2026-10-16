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
export function sessionEntryUrl(
  c: CandidateCase & { entryUrl?: string },
  fallback: string,
): string {
  const navigation = c.outline[0]?.startsWith('Navigate ')
    ? c.outline[0].slice(9)
    : undefined;
  return displayUrl(c.entryUrl ?? navigation ?? fallback);
}
function entryTitleKey(
  c: CandidateCase & { entryUrl?: string },
  fallback: string,
): string {
  return hashPayload({
    entry: sessionEntryUrl(c, fallback),
    title: c.title.replace(/[\s\p{P}]/gu, '').toLowerCase(),
  });
}
export function sessionCaseFingerprint(
  c: CandidateCase & { entryUrl?: string },
  fallback: string,
): string {
  const navigation = c.outline[0]?.startsWith('Navigate ')
    ? c.outline[0].slice(9)
    : null;
  return hashPayload({
    entry: sessionEntryUrl(c, fallback),
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
  duplicateFindings?: NonNullable<SessionDecision['duplicateFindings']>;
  retryCaseIds?: string[];
  title?: string;
}
/** Invalid review/retry entries are recorded independently of the rest of the plan. */
export function parseSessionDecision(input: unknown): {
  decision: SessionDecision;
  notes: string[];
} {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { decision: parseContract('SessionDecision', input), notes: [] };
  const { duplicateFindings, retryCaseIds, ...base } = input as Record<
    string,
    unknown
  >;
  const notes: string[] = [];
  const entries = (value: unknown, field: string): unknown[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      notes.push(`${field} 格式无效，已忽略。`);
      return [];
    }
    if (value.length > 30)
      notes.push(`${field} 超过 30 条，超出的条目已忽略。`);
    return value.slice(0, 30);
  };
  const duplicates: NonNullable<SessionDecision['duplicateFindings']> = [];
  for (const [index, item] of entries(
    duplicateFindings,
    'duplicateFindings',
  ).entries()) {
    try {
      const entry = parseContract('SessionDuplicateFinding', item);
      if (!entry.reason.trim()) throw new DomainError('VALIDATION_ERROR');
      duplicates.push({
        ...entry,
        findingId: entry.findingId.toLowerCase(),
        sameAs: entry.sameAs.toLowerCase(),
      });
    } catch {
      notes.push(`缺陷合并第 ${index + 1} 条格式无效，已忽略。`);
    }
  }
  const retries: string[] = [];
  for (const [index, item] of entries(retryCaseIds, 'retryCaseIds').entries()) {
    if (
      typeof item === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        item,
      )
    )
      retries.push(item.toLowerCase());
    else notes.push(`用例重跑第 ${index + 1} 条标识无效，已忽略。`);
  }
  return {
    decision: parseContract('SessionDecision', {
      ...base,
      duplicateFindings: duplicates,
      retryCaseIds: retries,
    }),
    notes,
  };
}
/** The model may reference old IDs, but only the server validates and applies changes. */
export function reviewSessionProposal(
  input: unknown,
  context: PlanningContext,
): AcceptedSessionDecision {
  const { decision: proposal, notes } = parseSessionDecision(input);
  if (
    proposal.action !== 'dispatch' &&
    (proposal.cases.length || proposal.exploreTargets.length)
  )
    throw new DomainError('VALIDATION_ERROR');
  if (proposal.action === 'ask' && !proposal.question?.trim())
    throw new DomainError('VALIDATION_ERROR');
  const coverageGaps = [...proposal.coverageGaps, ...notes];
  if (proposal.action !== 'dispatch' && proposal.retryCaseIds?.length)
    coverageGaps.push('用例重跑只允许 action=dispatch，已忽略本次重跑请求。');
  const seen = new Set(
    context.existingCases.map((c) =>
      sessionCaseFingerprint(c, context.targetUrl),
    ),
  );
  const seenTitles = new Set(
    context.existingCases.map((c) => entryTitleKey(c, context.targetUrl)),
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
    // Acceptance criteria are the session agent's to write, as in Mo. A
    // citation that does not check out marks the criterion as inferred
    // instead of rejecting the plan; the executing agent judges each one.
    const criteria = candidate.criteria.map((item, index): Criterion => {
      const { sourceQuote, locator, expectedValue, ...base } = item;
      const id = ids.has(item.id)
        ? `${item.id.slice(0, 58)}_${index + 1}`
        : item.id;
      ids.add(id);
      const source = context.sources.find(
        (s) => s.ref === item.sourceRef && s.kind === item.sourceKind,
      );
      const cited =
        !!source &&
        item.sourceKind !== 'saved_case' &&
        item.sourceKind !== 'generic_smoke' &&
        (item.sourceKind === 'inferred' ||
          (!!sourceQuote.trim() && source.text.includes(sourceQuote)));
      const usable = (() => {
        try {
          return parseContract('Criterion', {
            ...base,
            id,
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
            ...(cited
              ? {}
              : { sourceKind: 'inferred', sourceRef: 'session:planner' }),
          });
        } catch {
          return null;
        }
      })();
      // A structured check the planner left incomplete stays a plain
      // observable expectation for the agent to judge.
      return (
        usable ??
        parseContract('Criterion', {
          id,
          kind: 'semantic',
          description: base.description,
          sourceKind: cited ? base.sourceKind : 'inferred',
          sourceRef: cited ? base.sourceRef : 'session:planner',
        })
      );
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
    const titleKey = entryTitleKey(c, context.targetUrl);
    if (seen.has(fingerprint) || seenTitles.has(titleKey)) {
      coverageGaps.push(
        `重复用例已跳过（${seen.has(fingerprint) ? '精确指纹' : '同一入口及规范化标题'}）：${candidate.title}`,
      );
      continue;
    }
    if (cases.length >= context.remainingCases) {
      coverageGaps.push(`用例预算不足，未执行：${candidate.title}`);
      continue;
    }
    seen.add(fingerprint);
    seenTitles.add(titleKey);
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
    duplicateFindings: proposal.duplicateFindings ?? [],
    retryCaseIds:
      proposal.action === 'dispatch' ? (proposal.retryCaseIds ?? []) : [],
    ...(typeof proposal.title === 'string' && proposal.title.trim()
      ? { title: proposal.title.trim() }
      : {}),
  };
}
