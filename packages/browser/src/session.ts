import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { randomUUID } from 'node:crypto';
import type {
  ToolCall,
  ToolResult,
  BrowserSnapshot,
  Artifact,
} from '@localqa/contracts';
import type { BrowserPort, BrowserSession } from './port.js';
import type { BrowserSessionOptions } from './types.js';
import { PolicyInterceptor } from './policy.js';
import { SessionRecorder, isValidUuid } from './recorder.js';
import { WaitAndRecoveryManager } from './waiter.js';
import { ToolExecutor } from './executor.js';
import { captureBrowserSnapshot } from './snapshot.js';

export class BrowserSessionImpl implements BrowserSession {
  public readonly id: string;
  public readonly taskId: string;
  public activePageId: string;
  public isClosed = false;

  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly recorder: SessionRecorder;
  private readonly policy: PolicyInterceptor;
  private readonly waiter: WaitAndRecoveryManager;
  private readonly executor: ToolExecutor;
  private currentSnapshot: BrowserSnapshot | null = null;
  private stateVersion = 1;
  private readonly abortController = new AbortController();

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
    });

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
    if (this.isClosed) {
      throw new Error(`BrowserSession '${this.id}' is closed.`);
    }

    // Combine session abort signal with caller signal
    const combinedController = new AbortController();
    if (this.abortController.signal.aborted) {
      combinedController.abort(this.abortController.signal.reason);
    } else {
      this.abortController.signal.addEventListener('abort', () =>
        combinedController.abort(this.abortController.signal.reason),
      );
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        combinedController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener('abort', () =>
          combinedController.abort(options.signal?.reason),
        );
      }
    }

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
    this.stateVersion = snapshot.stateVersion;

    return result;
  }

  public async getSnapshot(options?: {
    forceFresh?: boolean;
  }): Promise<BrowserSnapshot> {
    if (this.isClosed) {
      throw new Error(`BrowserSession '${this.id}' is closed.`);
    }
    if (!this.currentSnapshot || options?.forceFresh) {
      this.currentSnapshot = await captureBrowserSnapshot(this.page, {
        pageId: this.activePageId,
        stateVersion: ++this.stateVersion,
        recorder: this.recorder,
      });
    }
    return this.currentSnapshot;
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

    try {
      await this.recorder.stopTrace(this.context);
    } catch {
      // Ignore
    }

    try {
      await this.context.close();
    } catch {
      // Ignore
    }
  }

  public getPage(): Page {
    return this.page;
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
  private readonly sessions = new Map<string, BrowserSessionImpl>();

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        args: [], // DO NOT pass --no-sandbox
      });
    }
    return this.browser;
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
    };
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

    return session;
  }

  public async close(): Promise<void> {
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
