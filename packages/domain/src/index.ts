import { createHash, randomUUID } from 'node:crypto';
import {
  parseContract,
  getRootValidator,
  type Run,
  type BudgetLimits,
  type BudgetUsed,
  type CaseDefinition,
  type CriterionResult,
  type BrowserSnapshot,
  type Summary,
  type Task,
  type ToolCall,
  type Verdict,
} from '@localqa/contracts';

export class DomainError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DomainError';
  }
}
export const TERMINAL = new Set<Run['status']>([
  'completed',
  'cancelled',
  'failed',
]);
export const PHASES: readonly Run['phase'][] = [
  'preflight',
  'auth',
  'explore',
  'plan',
  'execute',
  'reproduce',
  'finalize',
];
const TRANSITIONS: Record<Run['status'], readonly Run['status'][]> = {
  draft: ['queued', 'cancelled'],
  queued: ['running', 'cancelling', 'failed'],
  running: ['awaiting_input', 'cancelling', 'completed', 'failed'],
  awaiting_input: ['running', 'cancelling', 'completed', 'failed'],
  cancelling: ['cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
};
export function transition(
  run: Pick<Run, 'status' | 'phase'>,
  status: Run['status'],
  phase: Run['phase'] = run.phase,
): void {
  if (TERMINAL.has(run.status)) throw new DomainError('TERMINAL_RUN');
  if (status !== run.status && !TRANSITIONS[run.status].includes(status))
    throw new DomainError('INVALID_TRANSITION');
  if (PHASES.indexOf(phase) < PHASES.indexOf(run.phase))
    throw new DomainError('PHASE_REGRESSION');
  if (
    run.status === 'awaiting_input' &&
    status === 'running' &&
    phase !== run.phase
  )
    throw new DomainError('PREVIOUS_PHASE_REQUIRED');
  if (TERMINAL.has(status) && phase !== 'finalize')
    throw new DomainError('FINALIZE_REQUIRED');
}
export function completion(
  reason: Run['terminationReason'],
  summary: Summary,
): Run['completion'] {
  return summary.attempted === 0
    ? 'none'
    : reason === 'normal' && summary.notRun === 0
      ? 'complete'
      : 'partial';
}
export const DEFAULT_LIMITS: BudgetLimits = Object.freeze({
  maxCases: 8,
  maxPages: 6,
  maxDepth: 2,
  maxActiveSeconds: 600,
  maxActionsPerCase: 12,
  maxActions: 120,
  maxModelCalls: 100,
  maxReproductions: 3,
  concurrency: 2,
  maxTotalTokens: 300000,
});
export const EMPTY_USED: BudgetUsed = {
  activeSeconds: 0,
  actions: 0,
  modelCalls: 0,
  reproductions: 0,
  totalTokens: 0,
};
export type Counters = Partial<Record<keyof BudgetUsed, number>>;
const LIMIT: Record<keyof BudgetUsed, keyof BudgetLimits> = {
  activeSeconds: 'maxActiveSeconds',
  actions: 'maxActions',
  modelCalls: 'maxModelCalls',
  reproductions: 'maxReproductions',
  totalTokens: 'maxTotalTokens',
};
export function reserve(
  limits: BudgetLimits,
  used: BudgetUsed,
  reserved: Counters,
  amount: Counters,
): Counters {
  const next = { ...reserved };
  for (const [key, value] of Object.entries(amount)) {
    if (!(key in LIMIT) || !Number.isSafeInteger(value) || value < 0)
      throw new DomainError('VALIDATION_ERROR');
    const k = key as keyof BudgetUsed;
    const n = (used[k] ?? 0) + (reserved[k] ?? 0) + value;
    if (n > limits[LIMIT[k]]) throw new DomainError('BUDGET_EXCEEDED');
    next[k] = (next[k] ?? 0) + value;
  }
  return next;
}
export function validateTarget(
  input: string,
  origins: readonly string[],
  protectedOrigins: readonly string[] = [],
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new DomainError('TARGET_NOT_ALLOWED');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !origins.map((x) => new URL(x).origin).includes(url.origin) ||
    protectedOrigins.includes(url.origin) ||
    ['169.254.169.254', 'metadata.google.internal', '[fe80::1]'].includes(
      url.hostname,
    )
  )
    throw new DomainError('TARGET_NOT_ALLOWED');
  return url;
}
export function displayUrl(input: string): string {
  const url = new URL(input);
  url.search = '';
  url.hash = '';
  return url.toString();
}
export function validateBrowserTool(
  role: Task['role'],
  input: unknown,
  origins: readonly string[],
  protectedOrigins: readonly string[] = [],
): ToolCall {
  const validate = getRootValidator('tools');
  if (!validate(input)) throw new DomainError('VALIDATION_ERROR');
  const call = input as ToolCall;
  if (
    !['explorer', 'executor', 'reproducer'].includes(role) ||
    !['observe', 'navigate', 'capture'].includes(call.name)
  )
    throw new DomainError('POLICY_DENIED');
  if (call.name === 'navigate') {
    const url = validateTarget(call.args.url, origins, protectedOrigins);
    if (
      ['/api/', 'delete', 'autosave', 'send-message'].some((part) =>
        url.pathname.toLowerCase().includes(part),
      )
    )
      throw new DomainError('POLICY_DENIED');
  }
  return call;
}
export function taskKey(
  runId: string,
  role: Task['role'],
  target: string,
  attempt: number,
  contextVersion = 1,
): string {
  return `${runId}:${role}:${target}:v${contextVersion}:${attempt}`;
}
export function canonicalHash(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function criteriaHash(c: CaseDefinition): string {
  return canonicalHash(c.criteria);
}
export class PageGraph {
  readonly pages: { url: string; depth: number; fingerprint: string }[] = [];
  constructor(private limits: Pick<BudgetLimits, 'maxPages' | 'maxDepth'>) {}
  visit(url: string, depth: number, snapshot: BrowserSnapshot): boolean {
    if (
      depth > this.limits.maxDepth ||
      this.pages.length >= this.limits.maxPages
    )
      return false;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify(snapshot.nodes.map((n) => [n.role, n.name, n.text])),
      )
      .digest('hex');
    const display = displayUrl(url);
    if (
      this.pages.some((p) => p.url === display || p.fingerprint === fingerprint)
    )
      return false;
    this.pages.push({ url: display, depth, fingerprint });
    return true;
  }
  canNavigate(url: string, depth: number): boolean {
    return (
      depth <= this.limits.maxDepth &&
      this.pages.length < this.limits.maxPages &&
      !this.pages.some((p) => p.url === displayUrl(url))
    );
  }
}
export function smokeCase(run: Run, url: string, index = 0): CaseDefinition {
  return parseContract('CaseDefinition', {
    id: randomUUID(),
    projectId: run.projectId,
    runId: run.id,
    version: 1,
    title: `Entry smoke ${index + 1}`,
    summary: 'Technical entry/content smoke; not a business-rule oracle',
    preconditions: ['Fresh context; approved authentication only'],
    outline: [`Navigate ${displayUrl(url)}`, 'Observe visible primary content'],
    criteria: [
      {
        id: 'smoke.http',
        kind: 'http_status',
        description: 'Entry is reachable with a successful HTTP response',
        sourceKind: 'generic_smoke',
        sourceRef: 'FR-013/016',
        expectedValue: { min: 200, max: 399 },
      },
      {
        id: 'smoke.visible',
        kind: 'element_visible',
        description: 'Visible primary content',
        sourceKind: 'generic_smoke',
        sourceRef: 'FR-016',
        locator: { by: 'css', value: 'body' },
      },
    ],
  });
}
export function evaluateTechnical(
  c: CaseDefinition,
  snapshot: BrowserSnapshot,
  httpStatus: number | null,
  evidence: string[],
): CriterionResult[] {
  return c.criteria.map((criterion) => {
    let result: CriterionResult['result'] = 'unknown';
    let reason = 'Unsupported oracle; no invented expectation';
    if (
      criterion.kind === 'http_status' &&
      criterion.sourceKind === 'generic_smoke'
    ) {
      result =
        httpStatus !== null && httpStatus >= 200 && httpStatus <= 399
          ? 'passed'
          : 'not_evaluated';
      reason =
        result === 'passed'
          ? 'Observed successful navigation response'
          : 'Infrastructure/entry HTTP response blocks evaluation';
    } else if (criterion.kind === 'element_visible' && criterion.locator) {
      const locator = criterion.locator;
      let matches = snapshot.nodes.filter(
        (n) => n.visible && n.frameId === 'main',
      );
      if (locator.by === 'role')
        matches = matches.filter(
          (n) =>
            n.role === locator.value &&
            (!locator.name || n.name === locator.name),
        );
      else if (locator.by === 'test_id')
        matches = matches.filter((n) => n.nodeId === `testid_${locator.value}`);
      else if (locator.by === 'text')
        matches = matches.filter((n) => n.text === locator.value);
      else if (locator.by === 'css' && locator.value === 'body')
        matches = matches.filter(
          (n) =>
            n.text.trim().length > 0 &&
            !['password', 'hidden', 'canvas'].includes(n.role),
        );
      else matches = [];
      const supported =
        ['role', 'test_id', 'text'].includes(locator.by) ||
        (locator.by === 'css' && locator.value === 'body');
      result = matches.length
        ? 'passed'
        : snapshot.truncated ||
            !supported ||
            criterion.sourceKind === 'generic_smoke'
          ? 'unknown'
          : 'failed';
      reason = matches.length
        ? 'Visible matching node observed'
        : !supported
          ? 'Locator oracle not implemented'
          : snapshot.truncated
            ? 'Truncated observation cannot prove absence'
            : criterion.sourceKind === 'generic_smoke'
              ? 'Snapshot alone cannot prove a blank page'
              : 'Fixed sourced locator absent from fresh observation';
    }
    if (evidence.length === 0 && ['passed', 'failed'].includes(result)) {
      result = 'unknown';
      reason = 'Required owned evidence missing';
    }
    return parseContract('CriterionResult', {
      criterionId: criterion.id,
      result,
      reason,
      evidenceRefs: evidence,
    });
  });
}
export function verdictStatus(
  c: CaseDefinition,
  results: CriterionResult[],
  ownedEvidence: ReadonlySet<string>,
  blockReason?: string,
): Verdict['status'] {
  if (
    results.length !== c.criteria.length ||
    new Set(results.map((r) => r.criterionId)).size !== results.length ||
    results.some(
      (r) =>
        !c.criteria.some((k) => k.id === r.criterionId) ||
        r.evidenceRefs.some((id) => !ownedEvidence.has(id)),
    )
  )
    throw new DomainError('INVALID_CRITERIA_OR_EVIDENCE');
  if (
    results.some(
      (r) =>
        r.result === 'failed' &&
        r.evidenceRefs.length > 0 &&
        c.criteria.find((k) => k.id === r.criterionId)?.sourceKind !==
          'inferred',
    )
  )
    return 'issue_found';
  if (results.every((r) => r.result === 'passed' && r.evidenceRefs.length > 0))
    return 'passed';
  return blockReason || results.some((r) => r.result === 'not_evaluated')
    ? 'blocked'
    : 'inconclusive';
}
export function summarize(
  outcomes: readonly (Verdict['status'] | 'not_run')[],
): Summary {
  const counts = {
    passed: 0,
    issueFound: 0,
    blocked: 0,
    inconclusive: 0,
    notRun: 0,
  };
  for (const status of outcomes) {
    const key = (
      {
        passed: 'passed',
        issue_found: 'issueFound',
        blocked: 'blocked',
        inconclusive: 'inconclusive',
        not_run: 'notRun',
      } as const
    )[status];
    counts[key]++;
  }
  const planned = outcomes.length,
    attempted = planned - counts.notRun,
    evaluated = counts.passed + counts.issueFound;
  return parseContract('Summary', {
    ...counts,
    planned,
    attempted,
    evaluated,
    passRate: evaluated ? counts.passed / evaluated : null,
    attemptRate: planned ? attempted / planned : null,
  });
}
