import type {
  ToolCall,
  Locator,
  NodeTarget,
  ToolResult,
  BrowserSnapshot,
  Artifact,
} from '@localqa/contracts';
import type { BrowserSessionOptions, SessionRecording } from './types.js';

/**
 * BrowserSession represents an isolated browser context dedicated to a specific task.
 * Lifecycle, state, and authentication are strictly scoped to this session.
 */
export interface BrowserSession {
  readonly id: string;
  readonly taskId: string;
  readonly activePageId: string;
  readonly isClosed: boolean;

  /**
   * Executes a typed tool call with schema validation, policy checks,
   * target resolution, and before/after snapshot generation.
   */
  executeTool(
    toolCall: ToolCall,
    options?: { signal?: AbortSignal },
  ): Promise<ToolResult>;

  /**
   * Captures the current fresh BrowserSnapshot of the active page.
   */
  getSnapshot(options?: { forceFresh?: boolean }): Promise<BrowserSnapshot>;
  /**
   * Trusted read-only SPA readiness wait. Does not grant page/DOM mutation
   * capabilities to the model and never constitutes passing evidence.
   */
  waitForReadableBody?(timeoutMs?: number): Promise<boolean>;
  resolveRegressionLocator?(
    locator: Locator,
    signal?: AbortSignal,
  ): Promise<NodeTarget>;
  /** Re-resolve a current-snapshot hint through Playwright DOM uniqueness,
   * operability and element-identity checks; never blindly reuse cached IDs. */
  resolveCachedRegressionLocator?(
    locator: Locator,
    candidate: NodeTarget,
    signal?: AbortSignal,
  ): Promise<NodeTarget | null>;

  /**
   * Captures a screenshot artifact with sensitive data redacted.
   */
  captureScreenshot(options?: { fullPage?: boolean }): Promise<Artifact>;

  /** Flush any pending rrweb batch before snapshotting the recording. */
  flushRecording?(): Promise<void>;

  /** rrweb events plus timestamped console/network evidence, when enabled. */
  getRecording?(): SessionRecording | null;

  /**
   * Aborts active actions in this session with a reason.
   */
  cancel(reason?: string): Promise<void>;

  /**
   * Cleanly closes the session, context, and associated resources.
   */
  close(): Promise<void>;

  /**
   * Looks up a page by its assigned pageId.
   */
  getPageById?(id: string): import('playwright').Page | undefined;

  /**
   * Retrieves the pageId for a specific Playwright Page instance.
   */
  getPageId?(page: import('playwright').Page): string | undefined;
}

/**
 * BrowserPort: Adapter interface for the browser execution subsystem.
 *
 * NOTE: This is a signature draft under integration review.
 * 待集成负责人冻结 (Draft signature pending integration lead freeze).
 */
export interface BrowserPort {
  /**
   * Creates an isolated BrowserSession configured for a specific task.
   */
  createSession(options: BrowserSessionOptions): Promise<BrowserSession>;

  /**
   * Closes the underlying browser process and cleans up shared resources.
   */
  close(): Promise<void>;
}
