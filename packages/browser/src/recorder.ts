import type { Page, BrowserContext, Request, Response } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Artifact, NetworkEntry } from '@localqa/contracts';
import { validateContract } from '@localqa/contracts';
import { sanitizeUrl, sanitizeText } from './redaction.js';
import type { RecorderOptions } from './types.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isValidUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

export class SessionRecorder {
  private readonly maxConsoleSummary: number;
  private readonly maxNetworkSummary: number;
  private readonly maxConsoleBuffer: number;
  private readonly maxNetworkBuffer: number;
  private readonly artifactsDir: string | null;
  private readonly actionAuditPath: string | null;

  private consoleLogs: string[] = [];
  private networkEntries: NetworkEntry[] = [];
  private privateAuthentication = false;
  private readonly sensitiveValues: string[] = [];

  /** Login diagnostics must never survive into a task's later observations. */
  public beginPrivateAuthentication(): void {
    this.privateAuthentication = true;
    this.consoleLogs = [];
    this.networkEntries = [];
  }

  public endPrivateAuthentication(): void {
    this.consoleLogs = [];
    this.networkEntries = [];
    this.privateAuthentication = false;
  }

  /** Trusted auth material only, retained privately for this browser's lifetime. */
  public rememberAuthenticationValue(value: string): void {
    if (value && !this.sensitiveValues.includes(value))
      this.sensitiveValues.push(value);
  }

  public clearAuthenticationValues(): void {
    this.sensitiveValues.length = 0;
  }

  public redactAuthenticationText(text: string): string {
    let result = text;
    for (const value of this.sensitiveValues) {
      result = result.split(value).join('•');
      const encoded = encodeURIComponent(value);
      if (encoded !== value) result = result.split(encoded).join('%E2%80%A2');
    }
    return result;
  }

  private isTracing = false;
  private traceDegraded = false;
  private rrwebDegraded = true; // rrweb gracefully marked degraded by default unless explicit injector active
  private degradationReasons: string[] = [];

  private readonly projectId: string;
  private readonly runId: string;
  private readonly taskId: string | null;

  constructor(options: RecorderOptions) {
    if (!options?.projectId || !isValidUuid(options.projectId)) {
      throw new Error(
        `SessionRecorder requires a valid UUID 'projectId', got: ${options?.projectId}`,
      );
    }
    if (!options?.runId || !isValidUuid(options.runId)) {
      throw new Error(
        `SessionRecorder requires a valid UUID 'runId', got: ${options?.runId}`,
      );
    }
    if (options.taskId && !isValidUuid(options.taskId)) {
      throw new Error(
        `SessionRecorder 'taskId' must be a valid UUID or null, got: ${options.taskId}`,
      );
    }

    this.projectId = options.projectId;
    this.runId = options.runId;
    this.taskId = options.taskId ?? null;
    this.maxConsoleSummary = options.maxConsoleSummary || 50;
    this.maxNetworkSummary = options.maxNetworkSummary || 100;
    this.maxConsoleBuffer = options.maxConsoleBuffer || 500;
    this.maxNetworkBuffer = options.maxNetworkBuffer || 1000;
    this.artifactsDir = options.artifactsDir || null;
    this.actionAuditPath = this.artifactsDir
      ? path.join(this.artifactsDir, `action-audit-${randomUUID()}.ndjson`)
      : null;

    if (this.artifactsDir && !fs.existsSync(this.artifactsDir)) {
      fs.mkdirSync(this.artifactsDir, { recursive: true });
    }
  }

  public getProjectId(): string {
    return this.projectId;
  }

  public getRunId(): string {
    return this.runId;
  }

  public getTaskId(): string | null {
    return this.taskId;
  }

  /** Synchronously durable intent and settlement records. Never include
   * tool arguments, URLs, credentials, DOM, exception or provider bodies.
   * An unmatched intent means the action outcome is UNKNOWN, not safe to retry.
   */
  public recordActionAudit(entry: {
    attemptId: string;
    tool: string;
    phase: 'intent' | 'settlement';
    outcome?:
      'succeeded' | 'failed' | 'denied' | 'cancelled' | 'blocked' | 'unknown';
    reasonCode?: string | null;
    actionId?: string | null;
  }): void {
    if (!this.actionAuditPath) return;
    if (
      !isValidUuid(entry.attemptId) ||
      ![
        'navigate',
        'click',
        'type_text',
        'select_option',
        'press',
        'scroll',
      ].includes(entry.tool) ||
      !['intent', 'settlement'].includes(entry.phase) ||
      (entry.phase === 'settlement' && entry.outcome === undefined) ||
      (entry.actionId != null && !isValidUuid(entry.actionId)) ||
      (entry.outcome !== undefined &&
        ![
          'succeeded',
          'failed',
          'denied',
          'cancelled',
          'blocked',
          'unknown',
        ].includes(entry.outcome))
    )
      throw new Error('ACTION_AUDIT_INVALID_METADATA');
    const safeReason =
      entry.reasonCode === null || entry.reasonCode === undefined
        ? null
        : /^[A-Z0-9_]{1,80}$/.test(entry.reasonCode)
          ? entry.reasonCode
          : 'UNRECOGNIZED_REASON';
    const row = {
      schema: 1,
      attemptId: entry.attemptId,
      projectId: this.projectId,
      runId: this.runId,
      taskId: this.taskId,
      phase: entry.phase,
      tool: entry.tool,
      outcome: entry.outcome ?? null,
      reasonCode: safeReason,
      actionId: isValidUuid(entry.actionId) ? entry.actionId : null,
      at: new Date().toISOString(),
    };
    const fd = fs.openSync(this.actionAuditPath, 'a', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(row) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  public getActionAuditPath(): string | null {
    return this.actionAuditPath;
  }

  /**
   * Attaches listeners to a new or existing Playwright page.
   */
  public attachToPage(page: Page): void {
    page.on('console', (msg) => {
      if (this.privateAuthentication) return;
      try {
        const text = sanitizeText(this.redactAuthenticationText(msg.text()));
        const entry = `[${msg.type()}] ${text}`;
        if (this.consoleLogs.length >= this.maxConsoleBuffer) {
          this.consoleLogs.shift();
          this.recordDegradation(
            'Console buffer limit exceeded (500 logs max)',
          );
        }
        this.consoleLogs.push(entry.slice(0, 1000));
      } catch {
        // Ignore logging failures
      }
    });

    page.on('pageerror', (err) => {
      if (this.privateAuthentication) return;
      try {
        const entry = `[error] ${sanitizeText(this.redactAuthenticationText(err.message || String(err)))}`;
        if (this.consoleLogs.length >= this.maxConsoleBuffer) {
          this.consoleLogs.shift();
          this.recordDegradation(
            'Console buffer limit exceeded (500 logs max)',
          );
        }
        this.consoleLogs.push(entry.slice(0, 1000));
      } catch {
        // Error handling and logging must not propagate to page execution.
      }
    });

    page.on('request', (req: Request) => {
      if (this.privateAuthentication) return;
      try {
        const sanitizedUrl = sanitizeUrl(
          this.redactAuthenticationText(req.url()),
        );
        // Record request entry
        this.appendNetworkEntry({
          url: sanitizedUrl.slice(0, 8192),
          method: req.method().slice(0, 20),
          status: null,
          resourceType: req.resourceType().slice(0, 40),
          summary: `[REQ] ${req.method()} ${sanitizedUrl}`.slice(0, 1000),
        });
      } catch {
        // Non-blocking
      }
    });

    page.on('response', (res: Response) => {
      if (this.privateAuthentication) return;
      try {
        const sanitizedUrl = sanitizeUrl(
          this.redactAuthenticationText(res.url()),
        );
        this.appendNetworkEntry({
          url: sanitizedUrl.slice(0, 8192),
          method: res.request().method().slice(0, 20),
          status: res.status(),
          resourceType: res.request().resourceType().slice(0, 40),
          summary:
            `[${res.status()}] ${res.request().method()} ${sanitizedUrl}`.slice(
              0,
              1000,
            ),
        });
      } catch {
        // Non-blocking
      }
    });

    page.on('requestfailed', (req: Request) => {
      if (this.privateAuthentication) return;
      try {
        const sanitizedUrl = sanitizeUrl(
          this.redactAuthenticationText(req.url()),
        );
        const failure = this.redactAuthenticationText(
          req.failure()?.errorText || 'Unknown',
        );
        this.appendNetworkEntry({
          url: sanitizedUrl.slice(0, 8192),
          method: req.method().slice(0, 20),
          status: null,
          resourceType: req.resourceType().slice(0, 40),
          summary:
            `[FAILED] ${req.method()} ${sanitizedUrl} - ${failure}`.slice(
              0,
              1000,
            ),
        });
      } catch {
        // Non-blocking
      }
    });
  }

  private appendNetworkEntry(entry: NetworkEntry): void {
    entry = {
      ...entry,
      url: this.redactAuthenticationText(entry.url),
      summary: this.redactAuthenticationText(entry.summary),
    };
    if (this.networkEntries.length >= this.maxNetworkBuffer) {
      this.networkEntries.shift();
      this.recordDegradation('Network buffer limit reached (1000 entries max)');
    }
    this.networkEntries.push(entry);
  }

  private recordDegradation(reason: string): void {
    if (!this.degradationReasons.includes(reason)) {
      this.degradationReasons.push(reason);
    }
  }

  /**
   * Starts Playwright tracing on a BrowserContext.
   */
  public async startTrace(context: BrowserContext): Promise<void> {
    try {
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: false,
      });
      this.isTracing = true;
    } catch (err) {
      this.traceDegraded = true;
      this.recordDegradation(
        `Failed to start Playwright trace: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Stops Playwright tracing and persists trace artifact.
   */
  public async stopTrace(
    context: BrowserContext,
    fileName?: string,
  ): Promise<Artifact | null> {
    if (!this.isTracing) return null;
    this.isTracing = false;

    const traceId = randomUUID();
    const traceName = fileName || `trace-${traceId}.zip`;
    const targetPath = this.artifactsDir
      ? path.join(this.artifactsDir, traceName)
      : path.join('/tmp', traceName);

    try {
      await context.tracing.stop({ path: targetPath });
      const stats = fs.statSync(targetPath);

      // Check max trace size limit (50MB)
      const isTooLarge = stats.size > 50 * 1024 * 1024;
      if (isTooLarge) {
        this.traceDegraded = true;
        this.recordDegradation(
          'ARTIFACT_TOO_LARGE: Playwright trace exceeded 50MB capacity limit',
        );
      }

      const fileBuffer = fs.readFileSync(targetPath);
      const sha256 = createHash('sha256').update(fileBuffer).digest('hex');

      const artifact: Artifact = {
        id: traceId,
        projectId: this.projectId,
        runId: this.runId,
        kind: 'trace',
        status: isTooLarge ? 'degraded' : 'available',
        bytes: stats.size,
        sha256,
        contentUrl: `file://${targetPath}`,
        redaction: 'applied',
        error: isTooLarge
          ? 'ARTIFACT_TOO_LARGE: Playwright trace exceeded 50MB capacity limit'
          : null,
        createdAt: new Date().toISOString(),
        taskId: this.taskId,
        stepId: null,
        caseId: null,
        snapshotId: null,
      };

      const validation = validateContract('Artifact', artifact);
      if (!validation.success) {
        const errorDetails = validation.errors
          .map((e) => `${e.instancePath} ${e.message}`)
          .join(', ');
        throw new Error(
          `Generated trace Artifact violated contract schema: ${errorDetails}`,
        );
      }

      return artifact;
    } catch (err) {
      this.traceDegraded = true;
      this.recordDegradation(
        `Failed to save Playwright trace: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Takes screenshot, computes SHA-256 and writes to artifact dir if configured.
   */
  public async captureScreenshot(
    page: Page,
    options: { fullPage?: boolean } = {},
  ): Promise<Artifact> {
    const screenshotId = randomUUID();
    // `caret: 'hide'` (Playwright's default) writes `caret-color` into the
    // active input's inline style and restores it, which trips the DOM
    // witness and makes the observation the model is acting on look stale.
    // Evidence screenshots keep the caret instead.
    const buffer = await page.screenshot({
      fullPage: options.fullPage ?? true,
      caret: 'initial',
    });
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    let storageUri = `memory://${screenshotId}.png`;
    if (this.artifactsDir) {
      const filePath = path.join(
        this.artifactsDir,
        `screenshot-${screenshotId}.png`,
      );
      fs.writeFileSync(filePath, buffer);
      // Windows drive paths (E:\\...) are not valid URI references when
      // concatenated after file://. Use Node's canonical URL encoder so the
      // Artifact contract accepts it and fileURLToPath can read it back.
      storageUri = pathToFileURL(filePath).href;
    }

    const artifact: Artifact = {
      id: screenshotId,
      projectId: this.projectId,
      runId: this.runId,
      kind: 'screenshot',
      status: 'available',
      bytes: buffer.length,
      sha256,
      contentUrl: storageUri,
      redaction: 'not_needed',
      error: null,
      createdAt: new Date().toISOString(),
      taskId: this.taskId,
      stepId: null,
      caseId: null,
      snapshotId: null,
    };

    const validation = validateContract('Artifact', artifact);
    if (!validation.success) {
      const errorDetails = validation.errors
        .map((e) => `${e.instancePath} ${e.message}`)
        .join(', ');
      throw new Error(
        `Generated screenshot Artifact violated contract schema: ${errorDetails}`,
      );
    }

    return artifact;
  }

  /**
   * Retrieves sanitized summaries for BrowserSnapshot.
   */
  public getSnapshotSummaries(): {
    networkSummary: NetworkEntry[];
    consoleSummary: string[];
    truncated: boolean;
    redacted: boolean;
    degraded: boolean;
    degradationReasons: string[];
  } {
    const truncated =
      this.consoleLogs.length > this.maxConsoleSummary ||
      this.networkEntries.length > this.maxNetworkSummary;

    return {
      networkSummary: this.networkEntries.slice(-this.maxNetworkSummary),
      consoleSummary: this.consoleLogs.slice(-this.maxConsoleSummary),
      truncated,
      redacted: true,
      degraded:
        this.traceDegraded ||
        this.rrwebDegraded ||
        this.degradationReasons.length > 0,
      degradationReasons: [...this.degradationReasons],
    };
  }

  public getRawConsole(): string[] {
    return [...this.consoleLogs];
  }

  public getRawNetwork(): NetworkEntry[] {
    return [...this.networkEntries];
  }
}
