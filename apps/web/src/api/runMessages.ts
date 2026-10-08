/**
 * Run Messages API & Presentation Telemetry.
 *
 * Implements strict schema validation, message polling/fetching,
 * and same-clock presentation telemetry for event-to-UI benchmarking.
 */

import type { RunMessage } from './types.ts';

export function parseRunMessage(data: unknown): RunMessage {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid RunMessage: payload must be an object');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.id !== 'string' || obj.id.trim() === '') {
    throw new Error('Invalid RunMessage: id must be a non-empty string');
  }
  if (obj.projectId !== undefined && typeof obj.projectId !== 'string') {
    throw new Error('Invalid RunMessage: projectId must be a string');
  }
  if (typeof obj.runId !== 'string') {
    throw new Error('Invalid RunMessage: runId must be a string');
  }
  if (typeof obj.actorId !== 'string') {
    throw new Error('Invalid RunMessage: actorId must be a string');
  }
  if (
    typeof obj.contextVersion !== 'number' ||
    Number.isNaN(obj.contextVersion)
  ) {
    throw new Error(
      'Invalid RunMessage: contextVersion must be a valid number',
    );
  }
  if (typeof obj.redactedText !== 'string') {
    throw new Error('Invalid RunMessage: redactedText must be a string');
  }
  if (
    typeof obj.createdAt !== 'string' ||
    Number.isNaN(Date.parse(obj.createdAt))
  ) {
    throw new Error(
      'Invalid RunMessage: createdAt must be a valid ISO date string',
    );
  }

  return {
    id: obj.id,
    runId: obj.runId,
    actorId: obj.actorId,
    contextVersion: obj.contextVersion,
    redactedText: obj.redactedText,
    createdAt: obj.createdAt,
  };
}

export interface MessageTelemetry {
  marker: string;
  uiRenderedAt: number;
  dbCommitAt?: number;
  latencyMs?: number;
}

declare global {
  interface Window {
    __messageTelemetryHistory?: MessageTelemetry[];
    __lastMessageRenderedAt?: MessageTelemetry;
    __renderedMessages?: Map<string, number>;
  }
}

// Eagerly initialize telemetry history on window to ensure it is defined as an array
// even before the first message is fetched or rendered, preventing 'undefined' in test harnesses.
if (typeof window !== 'undefined') {
  window.__messageTelemetryHistory = window.__messageTelemetryHistory || [];
  window.__renderedMessages = window.__renderedMessages || new Map();
}

/**
 * Record message presentation timestamp using the unified browser clock.
 */
export function recordMessageRendered(
  marker: string,
  createdAtStr?: string,
): MessageTelemetry {
  const now = Date.now();
  const dbCommitAt = createdAtStr ? Date.parse(createdAtStr) : undefined;
  const latencyMs =
    dbCommitAt && !Number.isNaN(dbCommitAt)
      ? Math.max(0, now - dbCommitAt)
      : undefined;

  const telemetry: MessageTelemetry = {
    marker,
    uiRenderedAt: now,
    dbCommitAt,
    latencyMs,
  };

  if (typeof window !== 'undefined') {
    window.__messageTelemetryHistory = window.__messageTelemetryHistory || [];
    window.__renderedMessages = window.__renderedMessages || new Map();

    if (!window.__renderedMessages.has(marker)) {
      window.__renderedMessages.set(marker, now);
      window.__messageTelemetryHistory.push(telemetry);
      window.__lastMessageRenderedAt = telemetry;
    }
  }

  return telemetry;
}

/**
 * Fetch run messages from the API endpoint.
 * Gracefully handles 404 or backend absence by returning an empty array.
 */
export async function fetchRunMessages(
  baseUrl = '/api/v1',
  runId: string,
): Promise<RunMessage[]> {
  const rootUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const url = `${rootUrl}/runs/${encodeURIComponent(runId)}/messages`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      credentials: 'include',
    });

    if (!res.ok) {
      return [];
    }

    const contentType = res.headers?.get?.('content-type') || '';
    if (contentType && !contentType.includes('application/json')) {
      return [];
    }

    const json = await res.json();
    const rawList = Array.isArray(json)
      ? json
      : json &&
          typeof json === 'object' &&
          'items' in json &&
          Array.isArray((json as { items: unknown[] }).items)
        ? (json as { items: unknown[] }).items
        : [];

    return rawList.map((item) => parseRunMessage(item));
  } catch (err) {
    console.warn('[RunMessages] Failed to fetch messages:', err);
    return [];
  }
}
