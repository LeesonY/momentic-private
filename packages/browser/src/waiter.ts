import type { Page, Response } from 'playwright';
import { createHash } from 'node:crypto';
import type { BrowserSnapshot, NodeTarget } from '@localqa/contracts';
import { STABLE_REASON_CODES } from './types.js';

export interface WaitOptions {
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export class WaitAndRecoveryManager {
  private readonly defaultActionTimeoutMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly maxRecoveries: number;
  private readonly maxRepeatedActions: number;

  private recoveryCount = 0;
  private actionHistory: Array<{ actionKey: string; fingerprint: string }> = [];

  constructor(options: {
    defaultActionTimeoutMs?: number | undefined;
    navigationTimeoutMs?: number | undefined;
    maxRecoveries?: number | undefined;
    maxRepeatedActions?: number | undefined;
  } = {}) {
    this.defaultActionTimeoutMs = options.defaultActionTimeoutMs || 15000;
    this.navigationTimeoutMs = options.navigationTimeoutMs || 30000;
    this.maxRecoveries = options.maxRecoveries || 2;
    this.maxRepeatedActions = options.maxRepeatedActions || 3;
  }

  /**
   * Navigates to URL waiting for DOMContentLoaded (strictly NO networkidle).
   */
  public async navigate(page: Page, url: string, options: WaitOptions = {}): Promise<Response | null> {
    const timeout = options.timeoutMs ?? this.navigationTimeoutMs;

    if (options.signal?.aborted) {
      throw new Error(STABLE_REASON_CODES.ACTION_CANCELLED);
    }

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout
      });

      return response;
    } catch (err) {
      if (options.signal?.aborted) {
        throw new Error(STABLE_REASON_CODES.ACTION_CANCELLED);
      }
      throw err;
    }
  }

  /**
   * Waits for a state-based condition (no networkidle).
   */
  public async waitForState(
    page: Page,
    condition: 'dom_ready' | 'navigation' | 'element_visible' | 'spinner_detach',
    options: WaitOptions & { selector?: string; target?: NodeTarget } = {}
  ): Promise<void> {
    const timeout = options.timeoutMs ?? this.defaultActionTimeoutMs;

    if (options.signal?.aborted) {
      throw new Error(STABLE_REASON_CODES.ACTION_CANCELLED);
    }

    if (condition === 'dom_ready') {
      await page.waitForLoadState('domcontentloaded', { timeout });
      return;
    }

    if (condition === 'navigation') {
      await page.waitForURL('**/*', { waitUntil: 'domcontentloaded', timeout });
      return;
    }

    if (condition === 'element_visible' && options.selector) {
      await page.waitForSelector(options.selector, { state: 'visible', timeout });
      return;
    }

    if (condition === 'spinner_detach') {
      // FIX-02 pattern: Wait for spinner to detach and ready element to appear
      const spinnerSelector = '[data-testid="loading-spinner"], .loading-spinner, .spinner';
      const readySelector = '[data-testid="delayed-content-ready"]';

      try {
        await page.waitForSelector(spinnerSelector, { state: 'detached', timeout: Math.min(timeout, 10000) });
      } catch {
        // Spinner may have already detached
      }

      await page.waitForSelector(readySelector, { state: 'visible', timeout });
      return;
    }
  }

  /**
   * Calculates a structural page fingerprint to detect loops.
   */
  public computeFingerprint(snapshot: BrowserSnapshot): string {
    const raw = `${snapshot.displayUrl}|${snapshot.title}|${snapshot.nodes.length}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  /**
   * Records an action execution and checks for infinite loop repetitions.
   */
  public recordAction(actionName: string, targetKey: string, fingerprint: string): void {
    const actionKey = `${actionName}:${targetKey}`;

    // Count identical consecutive actions with identical fingerprint
    let consecutiveCount = 1;
    for (let i = this.actionHistory.length - 1; i >= 0; i--) {
      const prev = this.actionHistory[i]!;
      if (prev.actionKey === actionKey && prev.fingerprint === fingerprint) {
        consecutiveCount++;
      } else {
        break;
      }
    }

    this.actionHistory.push({ actionKey, fingerprint });
    if (this.actionHistory.length > 50) {
      this.actionHistory.shift();
    }

    if (consecutiveCount >= this.maxRepeatedActions) {
      throw new Error(
        `${STABLE_REASON_CODES.REPEATED_ACTION_LIMIT}: Action '${actionName}' on target '${targetKey}' repeated ${consecutiveCount} times on identical page state.`
      );
    }
  }

  /**
   * Tracks non-destructive recovery attempts.
   */
  public recordRecoveryAttempt(): void {
    this.recoveryCount++;
    if (this.recoveryCount > this.maxRecoveries) {
      throw new Error(
        `${STABLE_REASON_CODES.MAX_RECOVERIES_EXCEEDED}: Maximum non-destructive recoveries (${this.maxRecoveries}) exceeded.`
      );
    }
  }

  public resetRecoveries(): void {
    this.recoveryCount = 0;
  }
}
