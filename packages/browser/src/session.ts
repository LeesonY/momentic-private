import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { randomUUID } from 'node:crypto';
import type {
  ToolCall,
  Locator,
  NodeTarget,
  ToolResult,
  BrowserSnapshot,
  Artifact,
} from '@localqa/contracts';
import type { BrowserPort, BrowserSession } from './port.js';
import type { BrowserSessionOptions, SessionRecording } from './types.js';
import { getRrwebScript } from './rrweb-script.js';
import { PolicyInterceptor } from './policy.js';
import { SessionRecorder, isValidUuid } from './recorder.js';
import { WaitAndRecoveryManager } from './waiter.js';
import { ToolExecutor } from './executor.js';
import { captureBrowserSnapshot } from './snapshot.js';
import {
  resolveRegressionLocator,
  resolveCachedRegressionLocator,
} from './regression-locator.js';

const RRWEB_RECORDER_SCRIPT = `
(() => {
  // Only the top document records. This keeps cross-origin (and same-origin)
  // iframe contents out of the replay instead of starting a second recorder.
  if (window.top !== window) return;
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    try { window.__localqa_rrweb_emit(batch); } catch {}
  };
  window.__localqa_rrweb_stop = null;
  window.__localqa_rrweb_flush = flush;
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  setInterval(flush, 1000);
  const start = () => {
    if (window.__localqa_rrweb_stop || !window.rrweb || typeof window.rrweb.record !== 'function') return;
    try {
      window.__localqa_rrweb_stop = window.rrweb.record({
        emit(event) {
          if (event && event.type === 4 && event.data && typeof event.data.href === 'string') {
            try {
              const parsed = new URL(event.data.href);
              if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
                event.data.href = parsed.origin + parsed.pathname;
            } catch {}
          }
          buffer.push(event);
        },
        maskAllInputs: true,
        recordCanvas: false,
        blockSelector: 'input[type="hidden"]',
        maskInputFn: () => '***',
        inlineStylesheet: true,
        collectFonts: false,
        recordCrossOriginIframes: false,
      });
    } catch {
      window.__localqa_rrweb_stop = null;
    }
  };
  if (document.readyState === 'complete') setTimeout(start, 0);
  else window.addEventListener('load', () => setTimeout(start, 0), { once: true });
})();
`;

export class BrowserSessionImpl implements BrowserSession {
  public readonly id: string;
  public readonly taskId: string;
  public activePageId: string;
  public isClosed = false;

  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly recorder: SessionRecorder;
  private readonly recordingEnabled: boolean;
  private readonly maxRecordingBytes: number;
  private readonly recordingViewport: { width: number; height: number };
  private rrwebEvents: unknown[] = [];
  private rrwebRawBytes = 0;
  private recordingStatus: 'recording' | 'available' | 'degraded' = 'recording';
  private recordingError: string | null = null;
  private recordingStartedAt: number | null = null;
  private recordingEndedAt: number | null = null;
  private recordingStopped = false;
  private readonly policy: PolicyInterceptor;
  private readonly waiter: WaitAndRecoveryManager;
  private readonly executor: ToolExecutor;
  private currentSnapshot: BrowserSnapshot | null = null;
  private stateVersion = 1;
  private readonly abortController = new AbortController();
  // Serialize all state-changing tool dispatch and snapshot refreshes in a
  // browser session. Otherwise two concurrent uses of the *same* approved
  // snapshot can both click even after the first action was consumed.
  private operationTail: Promise<void> = Promise.resolve();

  private async withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      if (this.isClosed)
        throw new Error(`BrowserSession '${this.id}' is closed.`);
      return await operation();
    } finally {
      release();
    }
  }

  private readonly pages = new Map<string, Page>();
  private readonly pageIds = new Map<Page, string>();

  constructor(
    id: string,
    options: BrowserSessionOptions,
    context: BrowserContext,
    page: Page,
    pageId: string,
  ) {
    this.id = id;
    this.taskId = options.taskId;
    this.activePageId = pageId;
    this.context = context;
    this.page = page;

    this.pages.set(pageId, page);
    this.pageIds.set(page, pageId);

    this.policy = new PolicyInterceptor({
      mode: options.mode,
      allowedOrigins: options.allowedOrigins,
      restrictedPaths: options.restrictedPaths,
      writeScope: options.writeScope,
    });

    this.recordingEnabled = options.enableRecording === true;
    this.maxRecordingBytes = options.maxRecordingBytes ?? 20 * 1024 * 1024;
    this.recordingViewport = options.viewport ?? { width: 1280, height: 720 };

    this.recorder = new SessionRecorder({
      projectId: options.projectId,
      runId: options.runId,
      taskId: options.taskId,
      artifactsDir: options.artifactsDir,
    });
    this.recorder.attachToPage(page);

    this.waiter = new WaitAndRecoveryManager({
      defaultActionTimeoutMs: options.defaultActionTimeoutMs,
      navigationTimeoutMs: options.navigationTimeoutMs,
    });

    this.executor = new ToolExecutor();

    // Listen for new tabs/popups and attach recorder
    this.context.on('page', (newPage) => {
      const newPageId = randomUUID();
      this.pages.set(newPageId, newPage);
      this.pageIds.set(newPage, newPageId);
      this.recorder.attachToPage(newPage);
      newPage.on('close', () => {
        this.pages.delete(newPageId);
        this.pageIds.delete(newPage);
      });
    });
  }

  /** Context binding target: bounded batches of rrweb events from any page. */
  public addRrwebEvents(batch: unknown): void {
    if (!this.recordingEnabled || this.recordingStopped) return;
    if (!Array.isArray(batch)) return;
    try {
      for (const item of batch) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const event = item as { timestamp?: unknown };
        if (
          typeof event.timestamp !== 'number' ||
          !Number.isFinite(event.timestamp)
        )
          continue;
        // Cross-document streams can restart their clock; keep one monotonic
        // timeline so replay and anchors cannot move backwards.
        const timestamp = Math.max(
          event.timestamp,
          this.recordingEndedAt ?? event.timestamp,
        );
        (event as { timestamp: number }).timestamp = timestamp;
        this.recordingStartedAt ??= timestamp;
        this.recordingEndedAt = timestamp;
        this.rrwebEvents.push(event);
        this.rrwebRawBytes += JSON.stringify(event).length;
        if (this.rrwebRawBytes > this.maxRecordingBytes) {
          this.recordingStatus = 'degraded';
          this.recordingError = `rrweb recording exceeded ${this.maxRecordingBytes} bytes; recording stopped and the recorded part was kept.`;
          this.stopRrwebRecording();
          break;
        }
      }
    } catch (error) {
      this.recordingStatus = 'degraded';
      this.recordingError = `rrweb recording failed: ${(error as Error).message || 'unknown error'}`;
      this.stopRrwebRecording();
    }
  }

  public markRecordingDegraded(message: string): void {
    this.recordingStatus = 'degraded';
    this.recordingError = message;
    this.stopRrwebRecording();
  }

  private stopRrwebRecording(): void {
    if (!this.recordingEnabled || this.recordingStopped) return;
    this.recordingStopped = true;
    for (const page of this.pages.values()) {
      void page
        .evaluate(() => {
          const stop = (window as { __localqa_rrweb_stop?: unknown })
            .__localqa_rrweb_stop;
          if (typeof stop === 'function') stop();
        })
        .catch(() => {});
    }
  }

  /** Ask every page to flush its pending rrweb batch before snapshotting. */
  public async flushRecording(): Promise<void> {
    if (!this.recordingEnabled || this.recordingStopped) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(
          [...this.pages.values()].map((page) =>
            page
              .evaluate(() => {
                const flush = (window as { __localqa_rrweb_flush?: unknown })
                  .__localqa_rrweb_flush;
                if (typeof flush === 'function') return flush();
              })
              .catch(() => {}),
          ),
        ),
        // A crashed or wedged page must not hold the task finish open.
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public getRecording(): SessionRecording | null {
    if (!this.recordingEnabled) return null;
    return {
      events: this.rrwebEvents.map((event) => ({ ...(event as object) })),
      consoleEntries: this.recorder.getRecordingConsoleEntries(),
      networkEntries: this.recorder.getRecordingNetworkEntries(),
      status: this.recordingStatus,
      error: this.recordingError,
      notes: this.recorder.getRecordingNotes(),
      startedAt: this.recordingStartedAt
        ? new Date(this.recordingStartedAt).toISOString()
        : null,
      endedAt: this.recordingEndedAt
        ? new Date(this.recordingEndedAt).toISOString()
        : null,
      viewport: { ...this.recordingViewport },
    };
  }

  public getPageById(id: string): Page | undefined {
    return this.pages.get(id);
  }

  public getPageId(page: Page): string | undefined {
    return this.pageIds.get(page);
  }

  public async executeTool(
    toolCall: ToolCall,
    options?: { signal?: AbortSignal },
  ): Promise<ToolResult> {
    return this.withSessionLock(async () => {
      // Write-ahead intent is fsynced before any potentially mutating
      // browser command. The journal holds IDs and allowlisted tool names
      // only, never URL, text input, locator, cookie or model content.
      const mutatingToolNames = new Set([
        'navigate',
        'click',
        'type_text',
        'select_option',
        'press',
        'scroll',
      ]);
      const mutating = mutatingToolNames.has(toolCall.name);
      const attemptId = randomUUID();
      if (mutating)
        this.recorder.recordActionAudit({
          attemptId,
          tool: toolCall.name,
          phase: 'intent',
        });
      const combinedController = new AbortController();
      const sessionSignal = this.abortController.signal;
      const callerSignal = options?.signal;
      const sessionAborted = () =>
        combinedController.abort(sessionSignal.reason);
      const callerAborted = () =>
        combinedController.abort(callerSignal?.reason);
      if (sessionSignal.aborted) sessionAborted();
      else
        sessionSignal.addEventListener('abort', sessionAborted, { once: true });
      if (callerSignal?.aborted) callerAborted();
      else
        callerSignal?.addEventListener('abort', callerAborted, { once: true });
      try {
        const { result, snapshot } = await this.executor.execute(toolCall, {
          page: this.page,
          pageId: this.activePageId,
          getPage: (id: string) => this.pages.get(id),
          stateVersion: this.stateVersion,
          currentSnapshot: this.currentSnapshot,
          policy: this.policy,
          recorder: this.recorder,
          waiter: this.waiter,
          signal: combinedController.signal,
        });
        this.currentSnapshot = snapshot;
        // The task continues in its login browser. Known auth values remain
        // private even if the application echoes them on a later page.
        if (result.data === (snapshot as unknown as ToolResult['data']))
          result.data = this.redactAuthenticationSnapshot(
            snapshot,
          ) as unknown as ToolResult['data'];
        this.stateVersion = snapshot.stateVersion;
        if (mutating)
          this.recorder.recordActionAudit({
            attemptId,
            tool: toolCall.name,
            phase: 'settlement',
            outcome: result.status,
            reasonCode: result.reasonCode,
            actionId: result.actionId,
          });
        return result;
      } finally {
        sessionSignal.removeEventListener('abort', sessionAborted);
        callerSignal?.removeEventListener('abort', callerAborted);
      }
    });
  }

  public async resolveRegressionLocator(
    locator: Locator,
    signal?: AbortSignal,
  ): Promise<NodeTarget> {
    // Worker must observe through the budgeted port immediately before resolving.
    // Keep that snapshot identity so the grant can verify persisted ownership.
    const snapshot = await this.getSnapshot();
    return resolveRegressionLocator(this.page, locator, snapshot, signal);
  }
  public async resolveCachedRegressionLocator(
    locator: Locator,
    candidate: NodeTarget,
    signal?: AbortSignal,
  ): Promise<NodeTarget | null> {
    const snapshot = await this.getSnapshot();
    return resolveCachedRegressionLocator(
      this.page,
      locator,
      candidate,
      snapshot,
      signal,
    );
  }
  public async getSnapshot(options?: {
    forceFresh?: boolean;
  }): Promise<BrowserSnapshot> {
    return this.withSessionLock(async () => {
      if (!this.currentSnapshot || options?.forceFresh) {
        this.currentSnapshot = await captureBrowserSnapshot(this.page, {
          pageId: this.activePageId,
          stateVersion: ++this.stateVersion,
          recorder: this.recorder,
        });
      }
      return this.redactAuthenticationSnapshot(this.currentSnapshot);
    });
  }

  /** Trusted Worker lifecycle only; not a model/browser tool. */
  public beginPrivateAuthentication(): void {
    this.recorder.beginPrivateAuthentication();
  }

  public endPrivateAuthentication(): void {
    this.recorder.endPrivateAuthentication();
  }

  public rememberAuthenticationValue(value: string): void {
    this.recorder.rememberAuthenticationValue(value);
  }

  private redactAuthenticationSnapshot(
    snapshot: BrowserSnapshot,
  ): BrowserSnapshot {
    const text = (value: string) =>
      this.recorder.redactAuthenticationText(value);
    return {
      ...snapshot,
      displayUrl: text(snapshot.displayUrl),
      title: text(snapshot.title),
      nodes: snapshot.nodes.map((node) => ({
        ...node,
        role: text(node.role),
        name: text(node.name),
        text: text(node.text),
        // A control's current content is redacted like any other visible text:
        // after an in-place sign-in the account box already holds the saved
        // account, and the model must never read it back. Its placeholder hint
        // can carry the same account.
        ...(node.value !== undefined ? { value: text(node.value) } : {}),
        ...(node.placeholder !== undefined
          ? { placeholder: text(node.placeholder) }
          : {}),
      })),
      consoleSummary: snapshot.consoleSummary.map(text),
      networkSummary: snapshot.networkSummary.map((entry) => ({
        ...entry,
        url: text(entry.url),
        summary: text(entry.summary ?? ''),
      })),
    };
  }

  public async captureScreenshot(options?: {
    fullPage?: boolean;
  }): Promise<Artifact> {
    if (this.isClosed) {
      throw new Error(`BrowserSession '${this.id}' is closed.`);
    }
    return this.recorder.captureScreenshot(this.page, options);
  }

  public async cancel(reason = 'Action cancelled by caller'): Promise<void> {
    this.abortController.abort(reason);
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    await this.flushRecording();
    this.stopRrwebRecording();

    try {
      await this.recorder.stopTrace(this.context);
    } catch {
      // Ignore
    }

    try {
      await this.context.close();
    } catch {
      // Ignore
    } finally {
      this.recorder.clearAuthenticationValues();
    }
  }

  public getPage(): Page {
    return this.page;
  }

  public async waitForReadableBody(timeoutMs = 5000): Promise<boolean> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
      throw new Error('Invalid bounded body wait');
    if (this.isClosed) return false;
    try {
      await this.page
        .locator('body')
        .filter({ hasText: /\S/ })
        .waitFor({ state: 'visible', timeout: timeoutMs });
      return !this.isClosed;
    } catch {
      // The caller must record a fresh snapshot and produce an unknown result
      // if the page never renders; a timeout is not evidence of success.
      return false;
    }
  }

  public getContext(): BrowserContext {
    return this.context;
  }
}

/**
 * BrowserManager implements BrowserPort, managing Chromium process and session isolation.
 */
export class BrowserManager implements BrowserPort {
  private browser: Browser | null = null;
  private browserFlight: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, BrowserSessionImpl>();

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    // Concurrent agents share one launch, while keeping separate contexts.
    // Without this promise each first caller can launch an untracked process.
    const flight = (this.browserFlight ??= chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: [], // DO NOT pass --no-sandbox
    }));
    try {
      this.browser = await flight;
      return this.browser;
    } finally {
      if (this.browserFlight === flight) this.browserFlight = null;
    }
  }

  public async createSession(
    options: BrowserSessionOptions,
  ): Promise<BrowserSession> {
    if (!options?.projectId || !isValidUuid(options.projectId)) {
      throw new Error(
        `BrowserSessionOptions requires a valid UUID 'projectId', got: ${options?.projectId}`,
      );
    }
    if (!options?.runId || !isValidUuid(options.runId)) {
      throw new Error(
        `BrowserSessionOptions requires a valid UUID 'runId', got: ${options?.runId}`,
      );
    }
    if (!options?.taskId || !isValidUuid(options.taskId)) {
      throw new Error(
        `BrowserSessionOptions requires a valid UUID 'taskId', got: ${options?.taskId}`,
      );
    }

    const browser = await this.ensureBrowser();
    const sessionId = options.sessionId || randomUUID();

    // 1. Task-isolated context: completely fresh, zero state leakage
    const contextOptions: Parameters<Browser['newContext']>[0] = {
      viewport: options.viewport || { width: 1280, height: 720 },
      locale: options.locale || 'zh-CN',
      timezoneId: options.timezoneId || 'Asia/Shanghai',
      // Service workers can bypass Playwright's route interception. Blocking
      // them is required for the trusted auth origin/redirect network gate.
      serviceWorkers: 'block',
    };
    if (options.tlsPolicy === 'allow_self_signed') {
      // Playwright's setting applies to the entire browser context, not to a
      // single hostname. Only relax trust for an isolated HTTPS context whose
      // single approved origin is pinned by the server-frozen environment.
      const origins = options.allowedOrigins ?? [];
      if (
        origins.length !== 1 ||
        !origins[0] ||
        !origins[0].startsWith('https://') ||
        new URL(origins[0]).origin !== origins[0]
      ) {
        throw new Error('Self-signed TLS requires one exact HTTPS origin');
      }
      contextOptions.ignoreHTTPSErrors = true;
    }
    if (options.userAgent) {
      contextOptions.userAgent = options.userAgent;
    }
    const context = await browser.newContext(contextOptions);

    // 2. Auth state: ONLY imported if explicitly approved
    if (options.approvedAuthState) {
      if (options.approvedAuthState.cookies?.length) {
        await context.addCookies(options.approvedAuthState.cookies);
      }
      if (options.approvedAuthState.origins?.length) {
        for (const originEntry of options.approvedAuthState.origins) {
          const page = await context.newPage();
          await page
            .goto(originEntry.origin, { waitUntil: 'domcontentloaded' })
            .catch(() => {});
          await page.evaluate((items) => {
            for (const item of items) {
              window.localStorage.setItem(item.name, item.value);
            }
          }, originEntry.localStorage);
          await page.close();
        }
      }
    }

    // 3. Optional Trace start
    if (options.enableTrace) {
      await context.tracing
        .start({ screenshots: true, snapshots: true })
        .catch(() => {});
    }

    const page = await context.newPage();
    const pageId = randomUUID();

    const session = new BrowserSessionImpl(
      sessionId,
      options,
      context,
      page,
      pageId,
    );
    this.sessions.set(sessionId, session);

    if (options.enableRecording) {
      try {
        await context.exposeBinding(
          '__localqa_rrweb_emit',
          (_source, batch: unknown) => {
            try {
              session.addRrwebEvents(batch);
            } catch (error) {
              session.markRecordingDegraded(
                `rrweb recording failed: ${(error as Error).message || 'unknown error'}`,
              );
            }
          },
        );
        // Both scripts run before any page script, in registration order: the
        // rrweb UMD bundle first, then the recorder that starts on load.
        await context.addInitScript({ content: getRrwebScript() });
        await context.addInitScript({ content: RRWEB_RECORDER_SCRIPT });
      } catch (error) {
        // Missing/broken recording must not make the browser task fail.
        session.markRecordingDegraded(
          `rrweb recording setup failed: ${(error as Error).message || 'unknown error'}`,
        );
      }
    }

    return session;
  }

  public async close(): Promise<void> {
    await this.browserFlight?.catch(() => {});
    for (const session of this.sessions.values()) {
      await session.close().catch(() => {});
    }
    this.sessions.clear();

    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
