import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserSession } from '@localqa/browser';

// Live diagnostics intentionally store *only* enumerated event kinds and
// HTTP status integers. Never persist Console text, URLs, cookies, headers,
// selectors, response bodies or the browser's potentially sensitive pixels.
const ROOT = join(process.env.DATA_DIR ?? '/var/localqa/data', 'live-frames');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERIOD_MS = 1250;
const MAX_EVENTS = 12;

export type DiagnosticKind = 'console_error' | 'page_error' | 'http_error' | 'network_failed';
type DiagnosticEvent = { kind: DiagnosticKind; at: number; status: number | null };

export function startLiveDiagnostics(
  session: BrowserSession,
  input: { taskId: string; runId: string; projectId: string; fencingToken: number },
): { stop(): Promise<void> } {
  if (![input.taskId, input.runId, input.projectId].every((id) => UUID.test(id)))
    throw new Error('DIAGNOSTICS_INVALID_ID');
  if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1)
    throw new Error('DIAGNOSTICS_INVALID_FENCE');

  const page = session.getPageById?.(session.activePageId);
  if (!page) return { async stop() {} };
  const filename = join(ROOT, `${input.taskId}.${input.fencingToken}.diag.json`);
  const events: DiagnosticEvent[] = [];
  const counts = { consoleErrors: 0, pageErrors: 0, httpErrors: 0, networkFailures: 0 };
  let stopped = false;
  let busy = false;
  let current: Promise<void> | null = null;
  let sequence = 0;

  const record = (kind: DiagnosticKind, status: number | null = null) => {
    if (stopped) return;
    if (kind === 'console_error') counts.consoleErrors++;
    if (kind === 'page_error') counts.pageErrors++;
    if (kind === 'http_error') counts.httpErrors++;
    if (kind === 'network_failed') counts.networkFailures++;
    events.push({ kind, at: Date.now(), status });
    if (events.length > MAX_EVENTS) events.shift();
  };

  const onConsole = (msg: { type(): string }) => {
    if (msg.type() === 'error') record('console_error');
  };
  const onPageError = () => record('page_error');
  const onResponse = (response: { status(): number }) => {
    const status = response.status();
    if (status >= 400 && status <= 599) record('http_error', status);
  };
  const onFailed = (request: { failure(): { errorText: string } | null }) => {
    // Aborted pre-navigation resources are not actionable network errors.
    if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
    record('network_failed');
  };
  page?.on('console', onConsole);
  page?.on('pageerror', onPageError);
  page?.on('response', onResponse);
  page?.on('requestfailed', onFailed);

  const publish = async () => {
    if (stopped || busy || session.isClosed) return;
    busy = true;
    const temp = join(ROOT, `${input.taskId}.${input.fencingToken}.diag.${++sequence}.tmp`);
    try {
      await mkdir(ROOT, { recursive: true, mode: 0o700 });
      const body = JSON.stringify({
        schema: 1,
        ...input,
        capturedAt: Date.now(),
        counts: { ...counts },
        // Very old events must not invalidate an otherwise fresh live feed.
        events: events.filter((event) => Date.now() - event.at <= 3600_000),
      });
      if (Buffer.byteLength(body) > 4096) return;
      await writeFile(temp, body, { flag: 'wx', mode: 0o600 });
      if (!stopped) await rename(temp, filename);
    } catch {
      // Diagnostic telemetry can never change the tested action or verdict.
    } finally {
      await unlink(temp).catch(() => {});
      busy = false;
    }
  };
  current = publish();
  const timer = setInterval(() => {
    if (!stopped && !busy) current = publish();
  }, PERIOD_MS);
  timer.unref();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      page?.off('console', onConsole);
      page?.off('pageerror', onPageError);
      page?.off('response', onResponse);
      page?.off('requestfailed', onFailed);
      await current?.catch(() => {});
      await unlink(filename).catch(() => {});
    },
  };
}
