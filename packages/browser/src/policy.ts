import type { ToolCall } from '@localqa/contracts';
import {
  STABLE_REASON_CODES,
  type ActionTargetMetadata,
  type ExecutionMode,
  type PolicyCheckResult,
} from './types.js';

/** Non-text keyboard navigation. No modifiers except Shift+Tab: combinations
 * such as Control+V or Alt+ArrowLeft must not masquerade as navigation. */
export function isNavigationKey(key: string): boolean {
  return /^(?:tab|shift\+tab|escape|arrowup|arrowdown|arrowleft|arrowright)$/i.test(key);
}

/** Focus and plain Enter do not inject text into an input. Enter still goes
 * through the equivalent-button policy in both the grant and browser layers. */
export function isNonInputInteraction(call: ToolCall): boolean {
  return call.name === 'click' ||
    (call.name === 'press' &&
      (isNavigationKey(call.args.key) || /^(?:enter|numpadenter)$/i.test(call.args.key)));
}

export interface PolicyOptions {
  mode?: ExecutionMode | undefined;
  allowedOrigins?: string[] | undefined;
  restrictedPaths?: string[] | undefined;
  forbiddenSchemes?: string[] | undefined;
  writeScope?: readonly string[] | undefined;
  /**
   * Permit restricted literal hosts (loopback/private/link-local/metadata).
   * A restricted host whose exact origin is already in `allowedOrigins` is
   * treated as administrator-approved regardless; this flag additionally
   * covers sessions that deliberately run without a precise origin list.
   * Defaults to false.
   */
  allowRestricted?: boolean | undefined;
}

const RESTRICTED_LITERAL_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
  'metadata.goog',
  'instance-data',
]);

function normalizeLiteralHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function restrictedIpv4Octets(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this-net/unspecified, RFC1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15
  if (a >= 224) return true; // multicast, reserved and broadcast
  return false;
}

function restrictedIpv4Literal(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false;
  return restrictedIpv4Octets(octets[0]!, octets[1]!, octets[2]!);
}

/** Canonical (URL-parsed) IPv6 literal to 16 bytes; null when malformed. */
function ipv6LiteralToBytes(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const doubleIndex = host.indexOf('::');
  let groups: string[];
  if (doubleIndex !== -1) {
    if (host.indexOf('::', doubleIndex + 1) !== -1) return null;
    const left = host.slice(0, doubleIndex);
    const right = host.slice(doubleIndex + 2);
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
    groups = host.split(':');
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

function restrictedIpv6Literal(host: string): boolean {
  const bytes = ipv6LiteralToBytes(host);
  if (!bytes) return false;
  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (bytes[15] === 1 && bytes.slice(0, 15).every((byte) => byte === 0))
    return true; // ::1
  const mapped =
    bytes[10] === 0xff &&
    bytes[11] === 0xff &&
    bytes.slice(0, 10).every((byte) => byte === 0);
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b;
  if (mapped || compatible || nat64)
    return restrictedIpv4Octets(bytes[12]!, bytes[13]!, bytes[14]!);
  const first = bytes[0]!;
  const second = bytes[1]!;
  if (first === 0x20 && second === 0x02)
    // 6to4 embeds the IPv4 destination
    return restrictedIpv4Octets(bytes[2]!, bytes[3]!, bytes[4]!);
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10
  if (first === 0xff) return true; // ff00::/8
  return false;
}

function isRestrictedLiteralHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (RESTRICTED_LITERAL_HOSTNAMES.has(host)) return true;
  if (host.includes(':')) return restrictedIpv6Literal(host);
  return restrictedIpv4Literal(host);
}

const BUTTONISH_INPUT_TYPES = new Set(['submit', 'button', 'image', 'reset']);

/**
 * A control that activates itself when it has focus and Enter is pressed: a
 * button, a button role, an input button type, or a link. Kept in sync with
 * the snapshot's own `isButtonLike`.
 */
export function isButtonLikeNode(node: {
  role?: string | null;
  inputType?: string | null;
}): boolean {
  return (
    node.role === 'button' ||
    node.role === 'link' ||
    (typeof node.inputType === 'string' &&
      BUTTONISH_INPUT_TYPES.has(node.inputType))
  );
}

export function withinWriteScope(
  url: string,
  scope: readonly string[],
): boolean {
  try {
    const page = new URL(url);
    return scope.some((value) => {
      const approved = new URL(value);
      const prefix = decodeURIComponent(approved.pathname).replace(/\/$/, '');
      const path = decodeURIComponent(page.pathname);
      return (
        page.origin === approved.origin &&
        (path === prefix || path.startsWith(`${prefix}/`))
      );
    });
  } catch {
    return false;
  }
}

/**
 * PolicyInterceptor validates scope, target origins, and mutation risks
 * before executing browser actions.
 */
export class PolicyInterceptor {
  private readonly mode: ExecutionMode;
  private readonly allowedOrigins: Set<string>;
  private readonly restrictedPaths: string[];
  private readonly forbiddenSchemes: Set<string>;
  private readonly writeScope: readonly string[];
  private readonly allowRestricted: boolean;

  constructor(options: PolicyOptions = {}) {
    this.mode = options.mode || 'non_submitting';
    this.writeScope = options.writeScope ?? [];
    this.allowRestricted = options.allowRestricted === true;
    this.allowedOrigins = new Set(
      (options.allowedOrigins || []).map((o) => this.normalizeOrigin(o)),
    );
    this.restrictedPaths = options.restrictedPaths || [
      '/api/records/delete',
      '/api/messages/send',
      '/api/danger-get',
      '/api/autosave',
    ];
    this.forbiddenSchemes = new Set(
      options.forbiddenSchemes || [
        'javascript:',
        'file:',
        'data:',
        'vbscript:',
      ],
    );
  }

  private normalizeOrigin(originOrUrl: string): string {
    try {
      const u = new URL(originOrUrl);
      return u.origin.toLowerCase();
    } catch {
      return originOrUrl.toLowerCase();
    }
  }

  /**
   * True when the run's action policy restricts keyboard activation on this
   * page: a non-submitting run, or an approved-workflow run outside its frozen
   * write scope. Inside the write scope the old rule never restricted Enter,
   * so callers must not add stricter checks there.
   */
  public restrictsActivation(pageUrl = ''): boolean {
    return (
      this.mode === 'non_submitting' ||
      (this.mode === 'approved_workflows' &&
        !withinWriteScope(pageUrl, this.writeScope))
    );
  }

  /**
   * Validates whether a navigation target URL is within approved scope.
   */
  public checkNavigationUrl(urlStr: string): PolicyCheckResult {
    try {
      const parsed = new URL(urlStr);
      const scheme = parsed.protocol.toLowerCase();

      if (this.forbiddenSchemes.has(scheme)) {
        return {
          allowed: false,
          reasonCode: STABLE_REASON_CODES.TARGET_NOT_ALLOWED,
          reason: `Navigation to scheme '${scheme}' is strictly prohibited.`,
        };
      }

      if (scheme !== 'http:' && scheme !== 'https:') {
        return {
          allowed: false,
          reasonCode: STABLE_REASON_CODES.TARGET_NOT_ALLOWED,
          reason: `Navigation protocol must be http: or https:, got '${scheme}'.`,
        };
      }

      // Check userinfo in URL (security risk: http://user:pass@host)
      if (parsed.username || parsed.password) {
        return {
          allowed: false,
          reasonCode: STABLE_REASON_CODES.TARGET_NOT_ALLOWED,
          reason: 'URLs containing userinfo (username/password) are rejected.',
        };
      }

      // A literal loopback/private/link-local/metadata host is rejected even
      // when no origin list is configured. An administrator-approved internal
      // environment is signalled by the exact origin already being allow-listed.
      if (isRestrictedLiteralHost(normalizeLiteralHost(parsed.hostname))) {
        const approved =
          this.allowRestricted ||
          this.allowedOrigins.has(parsed.origin.toLowerCase());
        if (!approved) {
          return {
            allowed: false,
            reasonCode: STABLE_REASON_CODES.TARGET_NOT_ALLOWED,
            reason: `Target host '${parsed.hostname}' is a restricted address.`,
          };
        }
      }

      // Scope is an exact web origin (scheme + hostname + effective port).
      // A hostname-only fallback permitted HTTP downgrade and arbitrary ports;
      // localhost and 127.0.0.1 are not interchangeable security principals.
      if (this.allowedOrigins.size > 0) {
        const origin = parsed.origin.toLowerCase();
        if (!this.allowedOrigins.has(origin)) {
          return {
            allowed: false,
            reasonCode: STABLE_REASON_CODES.TARGET_NOT_ALLOWED,
            reason: `Target origin '${parsed.origin}' is outside permitted origins.`,
          };
        }
      }

      // Check restricted paths in non-submitting mode
      if (this.mode === 'non_submitting') {
        const path = parsed.pathname.toLowerCase();
        if (this.restrictedPaths.some((p) => path.includes(p.toLowerCase()))) {
          return {
            allowed: false,
            reasonCode: STABLE_REASON_CODES.POLICY_DENIED,
            reason: `Path '${path}' is restricted in non_submitting mode.`,
          };
        }
      }

      return { allowed: true };
    } catch {
      return {
        allowed: false,
        reasonCode: STABLE_REASON_CODES.TARGET_NOT_ALLOWED,
        reason: `Malformed URL: '${urlStr}'`,
      };
    }
  }

  /**
   * Validates tool call against execution mode and target metadata.
   */
  public checkAction(
    toolCall: ToolCall,
    targetMeta?: ActionTargetMetadata,
    pageUrl = '',
  ): PolicyCheckResult {
    // Prohibited tools: evaluate, shell, file io, etc.
    const toolName = toolCall.name as string;
    const prohibitedTools = new Set([
      'evaluate',
      'eval',
      'exec',
      'shell',
      'read_file',
      'write_file',
    ]);
    if (prohibitedTools.has(toolName)) {
      return {
        allowed: false,
        reasonCode: STABLE_REASON_CODES.POLICY_DENIED,
        reason: `Tool '${toolName}' is prohibited in LocalQA browser executor.`,
      };
    }

    // Keyboard activation can submit a form without a target; never let it
    // bypass a frozen non-submitting policy or approved write scope. A plain
    // Enter *with* a target is judged by the button it activates: the executor
    // re-resolves that button live and applies the click checks. Without a
    // target the focus is unknown, and Space or a modifier combination is not
    // a form's default activation, so those stay refused here.
    if (toolName === 'press' && this.restrictsActivation(pageUrl)) {
      const key = String(
        (toolCall.args as { key?: string }).key ?? '',
      ).toLowerCase();
      const hasTarget = Boolean(
        (toolCall.args as { target?: unknown }).target,
      );
      // Navigation keys never activate an equivalent button or type text.
      const plainEnter = !isNavigationKey(key) &&
        isNonInputInteraction(toolCall) && hasTarget;
      if (
        !(plainEnter && hasTarget) &&
        /(?:^|\+)(?:enter|numpadenter|space)$/.test(key)
      )
        return {
          allowed: false,
          reasonCode: STABLE_REASON_CODES.POLICY_DENIED,
          reason: 'Activating key forbidden outside approved write scope.',
        };
    }

    // In P0 non_submitting mode, check if target has dangerous mutation intent
    if (targetMeta?.href) {
      const navigation = this.checkNavigationUrl(targetMeta.href);
      if (!navigation.allowed) return navigation;
    }
    if (targetMeta?.actionUrl) {
      const navigation = this.checkNavigationUrl(targetMeta.actionUrl);
      if (!navigation.allowed) return navigation;
    }
    if (
      (this.mode === 'non_submitting' ||
        (this.mode === 'approved_workflows' &&
          !withinWriteScope(pageUrl, this.writeScope))) &&
      targetMeta
    ) {
      if (targetMeta.isDangerousMutation) {
        return {
          allowed: false,
          reasonCode: STABLE_REASON_CODES.POLICY_DENIED,
          reason: `Action on target '${targetMeta.name || targetMeta.nodeId}' is a hazardous mutation, prohibited in non_submitting mode.`,
        };
      }

      // Check if target link points outside scope
      if (targetMeta.href) {
        const navCheck = this.checkNavigationUrl(targetMeta.href);
        if (!navCheck.allowed) {
          return navCheck;
        }
      }

      // Check for destructive action keywords on buttons
      const textSample =
        `${targetMeta.name || ''} ${targetMeta.text || ''}`.toLowerCase();
      const destructiveKeywords = [
        '保存',
        'save',
        '创建',
        'create',
        '新增',
        '新建',
        '提交',
        'submit',
        '删除',
        'delete',
        'remove',
        '发送',
        'send message',
        'submit order',
        '立即购买',
      ];
      const hasDestructiveText = destructiveKeywords.some((kw) =>
        textSample.includes(kw),
      );

      if (
        hasDestructiveText &&
        (targetMeta.role === 'button' || targetMeta.tag === 'button')
      ) {
        return {
          allowed: false,
          reasonCode: STABLE_REASON_CODES.POLICY_DENIED,
          reason: `Target element contains destructive intent ('${textSample.trim()}'), forbidden in non_submitting mode.`,
        };
      }
    }

    return { allowed: true };
  }
}
