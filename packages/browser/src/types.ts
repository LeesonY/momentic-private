/**
 * Stable reason codes for tool execution, target resolution, and policy denials.
 *
 * 包含：
 * 1. 6 个保留在 ToolResult.reasonCode 的执行层专用原因码（承载编排层自愈处置语义）
 * 2. 收敛映射至 docs/03 §7 标准词表的原因码
 */
export const STABLE_REASON_CODES = Object.freeze({
  // 6 个保留的执行层专用原因码（供编排层/Agent 自愈决策）
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  TARGET_HIDDEN: 'TARGET_HIDDEN',
  TARGET_DISABLED: 'TARGET_DISABLED',
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  REPEATED_ACTION_LIMIT: 'REPEATED_ACTION_LIMIT',

  // 收敛映射至 docs/03 §7 标准词表的原因码
  POLICY_DENIED: 'POLICY_DENIED',
  TARGET_NOT_ALLOWED: 'TARGET_NOT_ALLOWED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  USER_CANCELLED: 'USER_CANCELLED',
  BROWSER_UNAVAILABLE: 'BROWSER_UNAVAILABLE',
  VERSION_CONFLICT: 'VERSION_CONFLICT'
} as const);

export type StableReasonCode = (typeof STABLE_REASON_CODES)[keyof typeof STABLE_REASON_CODES];

export type ExecutionMode = 'non_submitting' | 'exploration' | 'full';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ApprovedAuthState {
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  origins?: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface BrowserSessionOptions {
  sessionId?: string | undefined;
  projectId: string;
  runId: string;
  taskId: string;
  mode?: ExecutionMode | undefined;
  viewport?: ViewportSize | undefined;
  userAgent?: string | undefined;
  locale?: string | undefined;
  timezoneId?: string | undefined;
  allowedOrigins?: string[] | undefined;
  restrictedPaths?: string[] | undefined;
  approvedAuthState?: ApprovedAuthState | undefined;
  defaultActionTimeoutMs?: number | undefined;
  navigationTimeoutMs?: number | undefined;
  enableTrace?: boolean | undefined;
  artifactsDir?: string | undefined;
}

export interface ActionTargetMetadata {
  nodeId?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  text?: string | undefined;
  tag?: string | undefined;
  isDangerousMutation?: boolean | undefined;
  href?: string | undefined;
  actionUrl?: string | undefined;
}

export interface PolicyCheckResult {
  allowed: boolean;
  reasonCode?: StableReasonCode | undefined;
  reason?: string | undefined;
}

export interface TargetResolutionResult {
  status: 'resolved' | 'rejected';
  reasonCode?: StableReasonCode | undefined;
  message?: string | undefined;
  matchCount?: number | undefined;
}

export interface RecorderOptions {
  projectId: string;
  runId: string;
  taskId?: string | null | undefined;
  maxConsoleSummary?: number | undefined;
  maxNetworkSummary?: number | undefined;
  maxConsoleBuffer?: number | undefined;
  maxNetworkBuffer?: number | undefined;
  artifactsDir?: string | undefined;
}
