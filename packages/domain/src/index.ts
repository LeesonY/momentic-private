import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import {
  parseContract,
  getRootValidator,
  type Run,
  type AuthProfile,
  type BudgetLimits,
  type BudgetUsed,
  type CaseDefinition,
  type Criterion,
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
export type TargetHostResolver = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

export interface TargetHostClassification {
  /** Lowercased, trailing-dot stripped; IPv4 numeric literals are canonicalized. */
  host: string;
  kind: 'address' | 'hostname';
  /** Loopback, private, link-local/cloud-metadata, CGNAT, unspecified,
   *  multicast, broadcast, unique-local and IPv4-mapped restricted addresses. */
  restricted: boolean;
  restrictedReason: string | null;
}

export interface TargetGuardOptions {
  /**
   * Permit restricted (loopback/private/link-local/metadata) targets because
   * the caller already froze them in an approved Environment. Defaults to
   * false: a URL a user submitted on its own never reaches an internal host.
   */
  allowRestricted?: boolean;
  /** Hostname resolver; injectable so tests never touch real DNS. */
  resolveHost?: TargetHostResolver;
}

const CLOUD_METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.google.com',
  'metadata.goog',
  'instance-data',
]);

// Exact hosts every caller rejects regardless of the approved origin list.
const FORBIDDEN_TARGET_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'fe80::1',
]);

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Lowercases, strips IPv6 brackets/zone and trailing dots. */
export function normalizeHostname(rawHost: string): string {
  let host = stripIpv6Brackets(rawHost.trim().toLowerCase());
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/** inet_aton parsing: accepts decimal, hexadecimal (0x) and octal (0...) parts. */
function parseIpv4Number(host: string): number | null {
  if (host.length === 0 || host.includes(':')) return null;
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0x[0-9a-f]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part, 8);
    else if (/^[0-9]+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    values.push(value);
  }
  const last = values[values.length - 1]!;
  let combined = 0;
  for (let i = 0; i < values.length - 1; i++) {
    const part = values[i]!;
    if (part > 0xff) return null;
    combined = combined * 256 + part;
  }
  const remainingBits = 32 - 8 * (values.length - 1);
  if (last >= 2 ** remainingBits) return null;
  return (combined * 2 ** remainingBits + last) >>> 0;
}

function formatIpv4(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

function ipv6ToBytes(host: string): number[] | null {
  let normalized = stripIpv6Brackets(host);
  if (!normalized.includes(':')) return null;
  const lastColon = normalized.lastIndexOf(':');
  const tail = normalized.slice(lastColon + 1);
  if (tail.includes('.')) {
    const embedded = parseIpv4Number(tail);
    if (embedded === null) return null;
    normalized =
      normalized.slice(0, lastColon + 1) +
      ((embedded >>> 16) & 0xffff).toString(16) +
      ':' +
      (embedded & 0xffff).toString(16);
  }
  const doubleIndex = normalized.indexOf('::');
  let groups: string[];
  if (doubleIndex !== -1) {
    if (normalized.indexOf('::', doubleIndex + 1) !== -1) return null;
    const left = normalized.slice(0, doubleIndex);
    const right = normalized.slice(doubleIndex + 2);
    const leftGroups = left === '' ? [] : left.split(':');
    const rightGroups = right === '' ? [] : right.split(':');
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 1) return null;
    groups = [
      ...leftGroups,
      ...Array.from({ length: missing }, () => '0'),
      ...rightGroups,
    ];
  } else {
    groups = normalized.split(':');
    if (groups.length !== 8) return null;
  }
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

function isRestrictedIpv4(value: number): boolean {
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  if (a === 0) return true; // 0.0.0.0/8: unspecified / "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0 && ((value >>> 8) & 0xff) === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a >= 224) return true; // multicast, reserved and broadcast
  return false;
}

function ipv4FromBytes(bytes: readonly number[]): number {
  return (
    ((bytes[12]! << 24) |
      (bytes[13]! << 16) |
      (bytes[14]! << 8) |
      bytes[15]!) >>>
    0
  );
}

function isRestrictedIpv6(bytes: readonly number[]): {
  restricted: boolean;
  reason: string | null;
} {
  const first = bytes[0]!;
  const second = bytes[1]!;
  if (bytes.every((byte) => byte === 0))
    return { restricted: true, reason: 'unspecified' };
  if (bytes[15] === 1 && bytes.slice(0, 15).every((byte) => byte === 0))
    return { restricted: true, reason: 'loopback' };
  const mapped =
    bytes[10] === 0xff &&
    bytes[11] === 0xff &&
    bytes.slice(0, 10).every((x) => x === 0);
  if (mapped)
    return isRestrictedIpv4(ipv4FromBytes(bytes))
      ? { restricted: true, reason: 'ipv4-mapped-restricted' }
      : { restricted: false, reason: null };
  // ::a.b.c.d and NAT64 64:ff9b::/96 embed an IPv4 destination.
  const embedsIpv4 =
    bytes.slice(0, 12).every((x) => x === 0) ||
    (first === 0x00 &&
      second === 0x64 &&
      bytes[2] === 0xff &&
      bytes[3] === 0x9b);
  if (embedsIpv4)
    return isRestrictedIpv4(ipv4FromBytes(bytes))
      ? { restricted: true, reason: 'ipv4-embedded-restricted' }
      : { restricted: false, reason: null };
  // 6to4 2002::/16 embeds the IPv4 address in the next 32 bits.
  if (first === 0x20 && second === 0x02) {
    const embedded =
      ((bytes[2]! << 24) | (bytes[3]! << 16) | (bytes[4]! << 8) | bytes[5]!) >>>
      0;
    return isRestrictedIpv4(embedded)
      ? { restricted: true, reason: 'six-to-four-restricted' }
      : { restricted: false, reason: null };
  }
  if ((first & 0xfe) === 0xfc)
    return { restricted: true, reason: 'unique-local' }; // fc00::/7
  if (first === 0xfe && (second & 0xc0) === 0x80)
    return { restricted: true, reason: 'link-local' }; // fe80::/10
  if (first === 0xff) return { restricted: true, reason: 'multicast' }; // ff00::/8
  return { restricted: false, reason: null };
}

/** True when the address literal is not a public internet destination. */
export function isRestrictedIpAddress(address: string): boolean {
  const host = normalizeHostname(address);
  if (host.includes(':')) {
    const bytes = ipv6ToBytes(host);
    return bytes ? isRestrictedIpv6(bytes).restricted : false;
  }
  const ipv4 = parseIpv4Number(host);
  return ipv4 === null ? false : isRestrictedIpv4(ipv4);
}

/**
 * Literal classification without DNS. Hostnames only become restricted here
 * when they are loopback/metadata names; resolved-address checks live in
 * {@link assertPublicOrApprovedTarget}.
 */
export function classifyTargetHost(rawHost: string): TargetHostClassification {
  const host = normalizeHostname(rawHost);
  if (host === 'localhost' || host.endsWith('.localhost'))
    return {
      host,
      kind: 'hostname',
      restricted: true,
      restrictedReason: 'loopback-name',
    };
  if (CLOUD_METADATA_HOSTNAMES.has(host))
    return {
      host,
      kind: 'hostname',
      restricted: true,
      restrictedReason: 'cloud-metadata',
    };
  if (host.includes(':')) {
    const bytes = ipv6ToBytes(host);
    if (bytes) {
      const result = isRestrictedIpv6(bytes);
      return {
        host,
        kind: 'address',
        restricted: result.restricted,
        restrictedReason: result.reason,
      };
    }
  } else {
    const ipv4 = parseIpv4Number(host);
    if (ipv4 !== null) {
      const restricted = isRestrictedIpv4(ipv4);
      return {
        host: formatIpv4(ipv4),
        kind: 'address',
        restricted,
        restrictedReason: restricted ? 'restricted-ipv4' : null,
      };
    }
  }
  return { host, kind: 'hostname', restricted: false, restrictedReason: null };
}

function parseAllowedTargetUrl(
  input: string,
  origins: readonly string[],
  protectedOrigins: readonly string[],
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
    url.password
  )
    throw new DomainError('TARGET_NOT_ALLOWED');
  let originMatches: boolean;
  try {
    originMatches = origins
      .map((origin) => new URL(origin).origin)
      .includes(url.origin);
  } catch {
    throw new DomainError('TARGET_NOT_ALLOWED');
  }
  if (!originMatches || protectedOrigins.includes(url.origin))
    throw new DomainError('TARGET_NOT_ALLOWED');
  return url;
}

/**
 * Synchronous scope check kept signature-compatible for existing callers.
 * Rejects the always-forbidden metadata hosts after canonicalizing the host,
 * which also closes decimal/hex/trailing-dot variants of those literals.
 */
export function validateTarget(
  input: string,
  origins: readonly string[],
  protectedOrigins: readonly string[] = [],
): URL {
  const url = parseAllowedTargetUrl(input, origins, protectedOrigins);
  if (FORBIDDEN_TARGET_HOSTS.has(classifyTargetHost(url.hostname).host))
    throw new DomainError('TARGET_NOT_ALLOWED');
  return url;
}

const defaultResolveHost: TargetHostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family,
  }));
};

/**
 * SSRF guard for user-submitted targets. A restricted (loopback/private/
 * link-local/metadata/...) destination is rejected unless the caller passes
 * `allowRestricted: true` because an approved Environment already froze it.
 * Hostnames are resolved and every returned address is checked; DNS failure
 * fails closed. Public IP literals are accepted without any DNS lookup.
 */
export async function assertPublicOrApprovedTarget(
  input: string,
  origins: readonly string[],
  protectedOrigins: readonly string[] = [],
  options: TargetGuardOptions = {},
): Promise<URL> {
  const url = parseAllowedTargetUrl(input, origins, protectedOrigins);
  if (options.allowRestricted === true) return url;
  const classification = classifyTargetHost(url.hostname);
  if (classification.restricted) throw new DomainError('TARGET_NOT_ALLOWED');
  if (classification.kind === 'address') return url;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  let records: readonly { address: string; family: number }[];
  try {
    records = await resolveHost(classification.host);
  } catch {
    throw new DomainError('TARGET_NOT_ALLOWED');
  }
  if (records.length === 0) throw new DomainError('TARGET_NOT_ALLOWED');
  for (const record of records)
    if (isRestrictedIpAddress(record.address))
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
  sessionInteractions = false,
): ToolCall {
  const validate = getRootValidator('tools');
  if (!validate(input)) throw new DomainError('VALIDATION_ERROR');
  const call = input as ToolCall;
  if (
    !['explorer', 'executor', 'reproducer'].includes(role) ||
    ![
      'observe',
      'navigate',
      'capture',
      ...(sessionInteractions
        ? ['click', 'type_text', 'select_option', 'press', 'scroll', 'wait_for']
        : []),
    ].includes(call.name)
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
type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };
export function canonicalHash(value: unknown): string {
  const canonical = (item: unknown): CanonicalJson =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : (item as CanonicalJson);
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
  c: Pick<CaseDefinition, 'criteria'>,
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
/**
 * Fixed success oracle for agent (Mo-style) sign-in. Users give variables and
 * natural-language instructions, not a success locator, so the server derives
 * success from its own registered observation instead of the model's claim.
 */
export const AGENT_LOGIN_CRITERION: Criterion = Object.freeze({
  id: 'agent_login_completed',
  kind: 'semantic',
  description:
    'Agent sign-in left the sign-in form: no visible password field and no error response',
  sourceKind: 'inferred',
  sourceRef: 'auth:agent_login',
});
/** The one frozen success criterion a profile's auth job must satisfy. */
export function authCriterionFor(
  profile: Pick<AuthProfile, 'mode' | 'formConfig' | 'storageCriterion'>,
): Criterion | null {
  if (profile.mode === 'form')
    return profile.formConfig?.successCriterion ?? null;
  if (profile.mode === 'storage_state') return profile.storageCriterion ?? null;
  if (profile.mode === 'agent') return AGENT_LOGIN_CRITERION;
  return null;
}
/**
 * Deterministic part of agent sign-in success, evaluated on one redacted
 * observation: a healthy response and no visible password input in any frame.
 * The model's own "signed in" claim is necessary upstream but never sufficient.
 */
export function evaluateAgentLogin(
  snapshot: BrowserSnapshot,
  evidence: string[],
): CriterionResult {
  let result: CriterionResult['result'];
  let reason: string;
  if (snapshot.responseStatus !== null && snapshot.responseStatus >= 400) {
    result = 'failed';
    reason = 'Error response after sign-in';
  } else if (snapshot.nodes.length === 0) {
    result = 'unknown';
    reason = 'Empty observation cannot prove sign-in';
  } else if (
    snapshot.nodes.some((node) => node.role === 'password' && node.visible)
  ) {
    result = 'failed';
    reason = 'Visible password field: still on a sign-in form';
  } else {
    result = 'passed';
    reason = 'No visible password field after agent sign-in';
  }
  if (evidence.length === 0 && result !== 'unknown') {
    result = 'unknown';
    reason = 'Required owned evidence missing';
  }
  return parseContract('CriterionResult', {
    criterionId: AGENT_LOGIN_CRITERION.id,
    result,
    reason,
    evidenceRefs: evidence,
  });
}
/** Evaluates a profile's frozen auth criterion exactly as the server does. */
export function evaluateAuthCriterion(
  profile: Pick<AuthProfile, 'mode'>,
  criterion: Criterion,
  snapshot: BrowserSnapshot,
  evidence: string[],
): CriterionResult | undefined {
  if (profile.mode === 'agent') {
    return criterion.id === AGENT_LOGIN_CRITERION.id
      ? evaluateAgentLogin(snapshot, evidence)
      : undefined;
  }
  return evaluateTechnical(
    { criteria: [criterion] },
    snapshot,
    null,
    evidence,
  )[0];
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
