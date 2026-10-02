import type {
  BrowserSnapshot,
  NodeTarget,
  ToolCall,
  ToolResult,
  Artifact,
  CriterionResult,
  NetworkEntry
} from '@localqa/contracts';

/**
 * Stable reason codes for tool execution, target resolution, and policy denials.
 */
export const STABLE_REASON_CODES = Object.freeze({
  // Target resolution errors
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  TARGET_HIDDEN: 'TARGET_HIDDEN',
  TARGET_DISABLED: 'TARGET_DISABLED',
  SNAPSHOT_STALE: 'SNAPSHOT_STALE',
  TARGET_SEMANTICS_CHANGED: 'TARGET_SEMANTICS_CHANGED',

  // Policy & scope errors
  POLICY_DENIED: 'POLICY_DENIED',
  TARGET_NOT_ALLOWED: 'TARGET_NOT_ALLOWED',
  MUTATION_FORBIDDEN: 'MUTATION_FORBIDDEN',

  // Lifecycle & timeout errors
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  NAVIGATION_TIMEOUT: 'NAVIGATION_TIMEOUT',
  ACTION_CANCELLED: 'ACTION_CANCELLED',
  REPEATED_ACTION_LIMIT: 'REPEATED_ACTION_LIMIT',
  MAX_RECOVERIES_EXCEEDED: 'MAX_RECOVERIES_EXCEEDED',

  // Tool validation & execution
  INVALID_TOOL_ARGUMENTS: 'INVALID_TOOL_ARGUMENTS',
  PROHIBITED_TOOL: 'PROHIBITED_TOOL',
  FRAME_INACCESSIBLE: 'FRAME_INACCESSIBLE',
  BROWSER_ERROR: 'BROWSER_ERROR'
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
  projectId?: string | undefined;
  taskId: string;
  runId?: string | undefined;
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
  projectId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  maxConsoleSummary?: number | undefined;
  maxNetworkSummary?: number | undefined;
  maxConsoleBuffer?: number | undefined;
  maxNetworkBuffer?: number | undefined;
  artifactsDir?: string | undefined;
}
