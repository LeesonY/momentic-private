import type { JSHandle, Page, Response, Request } from 'playwright';
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

  constructor(
    options: {
      defaultActionTimeoutMs?: number | undefined;
      navigationTimeoutMs?: number | undefined;
      maxRecoveries?: number | undefined;
      maxRepeatedActions?: number | undefined;
    } = {},
  ) {
    this.defaultActionTimeoutMs = options.defaultActionTimeoutMs || 15000;
    this.navigationTimeoutMs = options.navigationTimeoutMs || 30000;
    this.maxRecoveries = options.maxRecoveries || 2;
    this.maxRepeatedActions = options.maxRepeatedActions || 3;
  }

  /**
   * Navigates to URL waiting for DOMContentLoaded (strictly NO networkidle).
   */
  public async navigate(
    page: Page,
    url: string,
    options: WaitOptions = {},
  ): Promise<Response | null> {
    const timeout = options.timeoutMs ?? this.navigationTimeoutMs;

    if (options.signal?.aborted) {
      throw new Error(STABLE_REASON_CODES.USER_CANCELLED);
    }

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });

      return response;
    } catch (err) {
      if (options.signal?.aborted) {
        throw new Error(STABLE_REASON_CODES.USER_CANCELLED, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Waits for a state-based condition (no networkidle).
   */
  public async waitForState(
    page: Page,
    condition:
      'dom_ready' | 'navigation' | 'element_visible' | 'spinner_detach',
    options: WaitOptions & { selector?: string; target?: NodeTarget } = {},
  ): Promise<void> {
    const timeout = options.timeoutMs ?? this.defaultActionTimeoutMs;

    if (options.signal?.aborted) {
      throw new Error(STABLE_REASON_CODES.USER_CANCELLED);
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
      await page.waitForSelector(options.selector, {
        state: 'visible',
        timeout,
      });
      return;
    }

    if (condition === 'spinner_detach') {
      // FIX-02 pattern: Wait for spinner to detach and ready element to appear
      const spinnerSelector =
        '[data-testid="loading-spinner"], .loading-spinner, .spinner';
      const readySelector = '[data-testid="delayed-content-ready"]';

      try {
        await page.waitForSelector(spinnerSelector, {
          state: 'detached',
          timeout: Math.min(timeout, 10000),
        });
      } catch {
        // Spinner may have already detached
      }

      await page.waitForSelector(readySelector, { state: 'visible', timeout });
      return;
    }
  }

  /**
   * Starts tracking non-idempotent requests so a click's response can be
   * awaited. Must be called before dispatching the click; otherwise a request
   * issued synchronously by the click handler is missed.
   */
  public beginNetworkSettle(
    page: Page,
    options: {
      graceMs?: number | undefined;
      quietMs?: number | undefined;
      maxMs?: number | undefined;
    } = {},
  ): { settle: (signal?: AbortSignal) => Promise<void>; stop: () => void } {
    const graceMs = options.graceMs ?? 250;
    const quietMs = options.quietMs ?? 250;
    const maxMs = options.maxMs ?? 2500;
    let pending: Promise<unknown> | null = null;
    const onRequest = (request: Request) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method().toUpperCase()))
        return;
      // Resolves with the response (or null on a network failure).
      pending ??= request.response().catch(() => null);
    };
    page.on('request', onRequest);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      page.off('request', onRequest);
    };
    return {
      stop,
      settle: async (signal?: AbortSignal) => {
        try {
          // A click that triggers a mutating request renders its result
          // (toast, inline error, redirect) a moment after the response.
          // Wait for that response plus a short quiet period so the returned
          // observation can carry it; a click with no such request returns
          // after a short grace. This never blocks an action indefinitely
          // and never treats absence of a response as a failure.
          await new Promise((resolve) => setTimeout(resolve, graceMs));
          if (!pending || signal?.aborted) return;
          await Promise.race([
            pending,
            new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, maxMs - graceMs)),
            ),
          ]);
          if (signal?.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, quietMs));
        } finally {
          stop();
        }
      },
    };
  }

  /**
   * Watches the page's *structure* while an action takes effect, so the
   * observation is captured after the UI has finished rearranging itself.
   *
   * A click re-renders validation messages with an enter/leave transition: the
   * old message is removed a few hundred milliseconds after the click, and a
   * snapshot taken before that shows a state the user never sees (the 66 run
   * reported "密码已填写却仍提示请输入密码" exactly this way).
   *
   * The criterion is deliberately narrow: only childList mutations (a node
   * added or removed) count as "the page is still changing". Attribute-only
   * changes are Vue/Element transition classes and inline styles, and
   * characterData changes are timers and counters; neither means the page is
   * still rearranging, and treating them as churn made every animated page wait
   * out the cap. A page with no structural change settles immediately.
   */
  public async beginDomSettle(
    page: Page,
    options: { quietMs?: number | undefined; maxMs?: number | undefined } = {},
  ): Promise<{
    settle: (signal?: AbortSignal) => Promise<{
      stable: boolean;
      waitedMs: number;
    }>;
    stop: () => Promise<void>;
  }> {
    const quietMs = options.quietMs ?? 300;
    const maxMs = options.maxMs ?? 1500;
    const pollMs = 50;
    let installed: JSHandle<{
      state: () => { structural: number; lastAt: number; now: number };
      stop: () => void;
    }>;
    try {
      installed = await page.evaluateHandle(() => {
        let structural = 0;
        let lastAt = performance.now();
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type !== 'childList') continue;
            if (!record.addedNodes.length && !record.removedNodes.length)
              continue;
            structural += 1;
            lastAt = performance.now();
            return;
          }
        });
        observer.observe(document, { childList: true, subtree: true });
        return {
          state: () => ({ structural, lastAt, now: performance.now() }),
          stop: () => observer.disconnect(),
        };
      });
    } catch {
      // A page that cannot be instrumented (closing, detached) simply does not
      // settle; the action still returns its own snapshot.
      return {
        settle: async () => ({ stable: true, waitedMs: 0 }),
        stop: async () => {},
      };
    }
    let stopped = false;
    return {
      settle: async (signal?: AbortSignal) => {
        const started = Date.now();
        try {
          for (;;) {
            if (signal?.aborted)
              return { stable: false, waitedMs: Date.now() - started };
            const state = await installed
              .evaluate((probe) => probe.state())
              .catch(() => null);
            if (!state) return { stable: true, waitedMs: Date.now() - started };
            const elapsed = Date.now() - started;
            // With no structural change yet the page is already as it will be
            // (a value change does not rearrange anything): wait out the quiet
            // window once and stop. After a change, wait for the UI to finish.
            const quietFor =
              state.structural > 0 ? state.now - state.lastAt : elapsed;
            if (quietFor >= quietMs) return { stable: true, waitedMs: elapsed };
            if (elapsed >= maxMs) return { stable: false, waitedMs: elapsed };
            await new Promise((resolve) => setTimeout(resolve, pollMs));
          }
        } finally {
          await installed.evaluate((probe) => probe.stop()).catch(() => {});
        }
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await installed.dispose().catch(() => {});
      },
    };
  }

  /**
   * Records a successful action that can change page or form state. It does
   * not participate in the repeat guard itself, but it breaks a run of
   * identical clicks so "submit, fix a field, submit" is not mistaken for a
   * loop. The page fingerprint cannot see typed values, so the action itself
   * is the evidence that the state moved.
   */
  public recordStateChange(actionName: string, targetKey: string): void {
    this.actionHistory.push({
      actionKey: `${actionName}:${targetKey}`,
      fingerprint: '',
    });
    if (this.actionHistory.length > 50) this.actionHistory.shift();
  }

  /**
   * Calculates a structural page fingerprint to detect loops.
   */
  public computeFingerprint(snapshot: BrowserSnapshot): string {
    // The previous URL/title/node-count fingerprint treated a wizard's
    // successive buttons as identical whenever each DOM replacement kept
    // the same number of nodes. Node IDs can also be reused across fresh
    // snapshots. Hash stable *semantic structure* instead of ephemeral IDs,
    // timestamps or screenshot bytes; no raw labels leave this process.
    const controls = snapshot.nodes
      .filter(
        (node) =>
          node.visible &&
          !node.sensitive &&
          node.role !== 'generic' &&
          node.name.length > 0,
      )
      .map((node) =>
        JSON.stringify([
          node.frameId,
          node.role,
          node.name.slice(0, 160),
          node.enabled,
        ]),
      )
      .sort();
    const raw = JSON.stringify([
      snapshot.displayUrl,
      snapshot.title,
      snapshot.nodes.length,
      controls,
    ]);
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  /**
   * Records an action execution and checks for infinite loop repetitions.
   */
  public recordAction(
    actionName: string,
    targetKey: string,
    fingerprint: string,
  ): void {
    this.assertActionPermitted(actionName, targetKey, fingerprint);
    const actionKey = `${actionName}:${targetKey}`;
    this.actionHistory.push({ actionKey, fingerprint });
    if (this.actionHistory.length > 50) {
      this.actionHistory.shift();
    }
  }

  /** Reject loops before potentially mutating browser actions are dispatched.
   * A post-click failure cannot retroactively undo the browser side effect. */
  public assertActionPermitted(
    actionName: string,
    targetKey: string,
    fingerprint: string,
  ): void {
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

    if (consecutiveCount >= this.maxRepeatedActions) {
      throw new Error(
        `${STABLE_REASON_CODES.REPEATED_ACTION_LIMIT}: Action '${actionName}' on target '${targetKey}' repeated ${consecutiveCount} times on identical page state.`,
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
        `${STABLE_REASON_CODES.REPEATED_ACTION_LIMIT}: Maximum non-destructive recoveries (${this.maxRecoveries}) exceeded.`,
      );
    }
  }

  public resetRecoveries(): void {
    this.recoveryCount = 0;
  }
}
