import type { ToolCall } from '@localqa/contracts';
import {
  STABLE_REASON_CODES,
  type ActionTargetMetadata,
  type ExecutionMode,
  type PolicyCheckResult,
} from './types.js';

export interface PolicyOptions {
  mode?: ExecutionMode | undefined;
  allowedOrigins?: string[] | undefined;
  restrictedPaths?: string[] | undefined;
  forbiddenSchemes?: string[] | undefined;
  writeScope?: readonly string[] | undefined;
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

  constructor(options: PolicyOptions = {}) {
    this.mode = options.mode || 'non_submitting';
    this.writeScope = options.writeScope ?? [];
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

    // In P0 non_submitting mode, check if target has dangerous mutation intent
    if (targetMeta?.href) {
      const navigation = this.checkNavigationUrl(targetMeta.href);
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
