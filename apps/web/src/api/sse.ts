import type { RunEvent } from '@localqa/contracts';

export type SseConnectionStatus =
  'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface SseClientOptions {
  runId: string;
  baseUrl?: string;
  onEvent?: (event: RunEvent) => void;
  onStatusChange?: (status: SseConnectionStatus, attempt: number) => void;
  onError?: (err: Error) => void;
}

/**
 * Robust SSE client with:
 * 1. Strict `seq` deduplication (rejects duplicate or out-of-order events)
 * 2. Automatic reconnection with `Last-Event-ID`
 * 3. Connection state projection (strictly avoids infinite spinner)
 */
export class SseClient {
  private readonly runId: string;
  private readonly baseUrl: string;
  private readonly onEvent?: (event: RunEvent) => void;
  private readonly onStatusChange?: (
    status: SseConnectionStatus,
    attempt: number,
  ) => void;
  private readonly onError?: (err: Error) => void;

  private eventSource: EventSource | null = null;
  private lastSeq = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isManuallyClosed = false;
  private currentStatus: SseConnectionStatus = 'disconnected';

  constructor(options: SseClientOptions) {
    this.runId = options.runId;
    this.baseUrl = options.baseUrl || '/api/v1';
    this.onEvent = options.onEvent;
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
  }

  public connect(): void {
    if (this.isManuallyClosed) return;
    // A retry may be requested while the previous EventSource is still
    // connected. Own exactly one stream at a time; obsolete callbacks must
    // never close the new connection or move its event cursor.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.eventSource?.close();
    this.eventSource = null;
    this.setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    const url = new URL(
      `${this.baseUrl}/runs/${this.runId}/events`,
      window.location.origin,
    );
    if (this.lastSeq > 0) {
      url.searchParams.set('lastEventId', String(this.lastSeq));
    }

    try {
      const stream = new EventSource(url.toString(), {
        withCredentials: true,
      });
      this.eventSource = stream;

      stream.onopen = () => {
        if (this.eventSource !== stream || this.isManuallyClosed) return;
        this.reconnectAttempt = 0;
        this.setStatus('connected');
      };

      const onMessage = (e: MessageEvent) => {
        if (this.eventSource !== stream || this.isManuallyClosed) return;
        try {
          const rawEvent = JSON.parse(e.data) as RunEvent;
          if (
            rawEvent.runId !== this.runId ||
            !Number.isSafeInteger(rawEvent.seq) ||
            rawEvent.seq < 1
          )
            return;
          // 1. Strict seq deduplication
          if (rawEvent.seq <= this.lastSeq) {
            return; // Duplicate or out-of-order event, drop silently
          }
          this.lastSeq = rawEvent.seq;

          // Dispatch to consumer
          this.onEvent?.(rawEvent);
        } catch (parseErr) {
          console.error('[SSE] Failed to parse event payload:', parseErr);
        }
      };
      stream.onmessage = onMessage;
      // API SSE frames use `event: input.requested` (and other explicit
      // names). Native EventSource.onmessage only receives unnamed events:
      // without these listeners the Workbench never sees real OTP prompts.
      const eventTypes: RunEvent['type'][] = [
        'run.updated',
        'phase.changed',
        'task.updated',
        'session.updated',
        'case.created',
        'case.result',
        'finding.updated',
        'step.recorded',
        'budget.updated',
        'input.requested',
        'input.resolved',
        'artifact.updated',
        'report.ready',
        'run.finished',
      ];
      for (const eventType of eventTypes)
        stream.addEventListener(eventType, (event) =>
          onMessage(event as MessageEvent),
        );

      stream.onerror = (_err) => {
        if (this.isManuallyClosed || this.eventSource !== stream) return;
        stream.close();
        this.eventSource = null;

        this.reconnectAttempt++;
        this.setStatus('reconnecting');
        this.onError?.(
          new Error(
            `SSE connection interrupted. Reconnecting (attempt ${this.reconnectAttempt})...`,
          ),
        );

        // Exponential backoff up to 10s
        const delay = Math.min(
          1000 * Math.pow(1.5, this.reconnectAttempt),
          10000,
        );
        this.reconnectTimer = setTimeout(() => {
          this.connect();
        }, delay);
      };
    } catch (err) {
      this.setStatus('disconnected');
      this.onError?.(err as Error);
    }
  }

  public retry(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  public disconnect(): void {
    this.isManuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.setStatus('disconnected');
  }

  public getStatus(): SseConnectionStatus {
    return this.currentStatus;
  }

  public getLastSeq(): number {
    return this.lastSeq;
  }

  public getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  private setStatus(status: SseConnectionStatus): void {
    this.currentStatus = status;
    this.onStatusChange?.(status, this.reconnectAttempt);
  }
}
