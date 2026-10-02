import type {
  ToolCall,
  ToolResult,
  BrowserSnapshot,
  Artifact
} from '@localqa/contracts';
import type { BrowserSessionOptions } from './types.js';

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
  executeTool(toolCall: ToolCall, options?: { signal?: AbortSignal }): Promise<ToolResult>;

  /**
   * Captures the current fresh BrowserSnapshot of the active page.
   */
  getSnapshot(options?: { forceFresh?: boolean }): Promise<BrowserSnapshot>;

  /**
   * Captures a screenshot artifact with sensitive data redacted.
   */
  captureScreenshot(options?: { fullPage?: boolean }): Promise<Artifact>;

  /**
   * Aborts active actions in this session with a reason.
   */
  cancel(reason?: string): Promise<void>;

  /**
   * Cleanly closes the session, context, and associated resources.
   */
  close(): Promise<void>;
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
