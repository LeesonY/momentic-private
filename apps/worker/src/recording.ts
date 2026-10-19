import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Artifact, TaskRecording } from '@localqa/contracts';

/** Compressed rrweb evidence cap for one task (contract in docs/02). */
export const MAX_RECORDING_COMPRESSED_BYTES = 20 * 1024 * 1024;

export interface PackedRrwebRecording {
  bytes: Buffer | null;
  status: 'available' | 'degraded' | 'missing';
  error: string | null;
  kept: number;
  lastTimestamp: number | null;
}

/**
 * Gzip a task's rrweb event stream. Replay needs the earliest full snapshot,
 * so an over-limit stream keeps its earliest events and drops the tail.
 */
export function packRrwebRecording(
  events: readonly unknown[],
  maxBytes = MAX_RECORDING_COMPRESSED_BYTES,
): PackedRrwebRecording {
  if (events.length === 0)
    return {
      bytes: null,
      status: 'missing',
      error: null,
      kept: 0,
      lastTimestamp: null,
    };
  const lastTimestamp = (list: readonly unknown[]): number | null => {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const item = list[index] as { timestamp?: unknown } | null;
      if (
        item &&
        typeof item === 'object' &&
        typeof item.timestamp === 'number' &&
        Number.isFinite(item.timestamp)
      )
        return item.timestamp;
    }
    return null;
  };
  const gzip = (list: readonly unknown[]): Buffer =>
    gzipSync(Buffer.from(JSON.stringify(list)));
  const whole = gzip(events);
  if (whole.byteLength <= maxBytes)
    return {
      bytes: whole,
      status: 'available',
      error: null,
      kept: events.length,
      lastTimestamp: lastTimestamp(events),
    };
  // Binary search the largest prefix that still fits the cap.
  let low = 0;
  let high = events.length - 1;
  let kept = 0;
  let bytes: Buffer | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = gzip(events.slice(0, middle + 1));
    if (candidate.byteLength <= maxBytes) {
      kept = middle + 1;
      bytes = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (!bytes)
    return {
      bytes: null,
      status: 'degraded',
      error: `rrweb recording exceeded ${maxBytes} bytes; not even the first event fit and nothing was saved.`,
      kept: 0,
      lastTimestamp: null,
    };
  const saved = events.slice(0, kept);
  return {
    bytes,
    status: 'degraded',
    error: `rrweb recording exceeded ${maxBytes} bytes; saved the earliest ${kept} of ${events.length} events.`,
    kept,
    lastTimestamp: lastTimestamp(saved),
  };
}

export function recordingArtifact(input: {
  projectId: string;
  runId: string;
  taskId: string;
  caseId: string | null;
  kind: 'rrweb' | 'console' | 'network';
  bytes: Uint8Array;
  status: 'available' | 'degraded';
  error: string | null;
}): Artifact {
  const id = randomUUID();
  return {
    id,
    projectId: input.projectId,
    runId: input.runId,
    kind: input.kind,
    status: input.status,
    bytes: input.bytes.byteLength,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    contentUrl: `/api/v1/artifacts/${id}/content`,
    redaction: 'applied',
    error: input.error,
    createdAt: new Date().toISOString(),
    taskId: input.taskId,
    stepId: null,
    caseId: input.caseId,
    snapshotId: null,
  };
}

export function missingRecording(taskId: string, error: string): TaskRecording {
  return {
    taskId,
    status: 'missing',
    rrwebArtifactId: null,
    consoleArtifactId: null,
    networkArtifactId: null,
    startedAt: null,
    endedAt: null,
    viewport: null,
    error,
  };
}
