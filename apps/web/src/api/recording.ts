import type { Artifact } from '@localqa/contracts';
import { defaultApiClient } from './index.ts';
import type {
  ConsoleLine,
  NetworkLine,
  RecordingInfo,
  RecordingStatus,
} from '../utils/recording.ts';

/**
 * Loading a task's replay evidence.
 *
 * The routing/format rules live here so the player only deals with data:
 * `getTaskRecording` names the evidence artifacts, each artifact is downloaded
 * through the existing project-scoped download endpoint, and the rrweb evidence
 * is a gzipped `eventWithTime[]` while console/network are plain JSON arrays.
 * Both formats are accepted in both directions (a stored blob is sniffed for the
 * gzip magic), so a recorder change cannot silently produce an empty player.
 */

const RECORDING_STATUSES = new Set<RecordingStatus>([
  'recording',
  'available',
  'degraded',
  'missing',
]);

export const canLoadRecordings = (): boolean =>
  typeof defaultApiClient.getTaskRecording === 'function';

/**
 * The server's answer, defensively normalized: an unexpected status or a
 * hand-made object must not crash the player, it degrades to "missing".
 */
export function normalizeRecording(
  value: Partial<RecordingInfo> | null | undefined,
  taskId: string,
): RecordingInfo {
  const status =
    value && RECORDING_STATUSES.has(value.status as RecordingStatus)
      ? (value.status as RecordingStatus)
      : 'missing';
  const stringOrNull = (input: unknown): string | null =>
    typeof input === 'string' && input.length > 0 ? input : null;
  const viewport =
    value?.viewport &&
    Number.isFinite(value.viewport.width) &&
    Number.isFinite(value.viewport.height) &&
    value.viewport.width > 0 &&
    value.viewport.height > 0
      ? { width: value.viewport.width, height: value.viewport.height }
      : null;
  return {
    taskId: value?.taskId ?? taskId,
    status,
    rrwebArtifactId: stringOrNull(value?.rrwebArtifactId),
    consoleArtifactId: stringOrNull(value?.consoleArtifactId),
    networkArtifactId: stringOrNull(value?.networkArtifactId),
    startedAt: stringOrNull(value?.startedAt),
    endedAt: stringOrNull(value?.endedAt),
    viewport,
    error: stringOrNull(value?.error),
  };
}

/**
 * A server that predates the replay contract answers 404 for this endpoint, so
 * that is "this task has no recording" rather than a broken page: the caller can
 * fall back to screenshots instead of showing an error.
 */
export async function loadTaskRecording(
  taskId: string,
): Promise<RecordingInfo> {
  if (!canLoadRecordings())
    return normalizeRecording({ status: 'missing' }, taskId);
  try {
    return normalizeRecording(
      await defaultApiClient.getTaskRecording(taskId),
      taskId,
    );
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 404)
      return normalizeRecording({ status: 'missing' }, taskId);
    throw error;
  }
}

export type EvidenceDecision =
  | { download: true; warning: string | null }
  | { download: false; reason: string };

/**
 * Whether an evidence artifact may be downloaded, and what to say about it.
 *
 * A degraded artifact is still replayed: hitting the size cap cuts a recording
 * short, it does not break the part that was recorded, so it plays with the
 * artifact's own error as the hint. Missing/failed evidence has nothing to
 * show. A failed redaction is refused outright, whatever the status says — the
 * point of redaction is that unredacted bytes never reach the browser.
 */
export function evidencePolicy(
  artifact: Pick<Artifact, 'status' | 'redaction' | 'error'>,
): EvidenceDecision {
  const detail = artifact.error?.trim();
  if (artifact.redaction === 'failed')
    return { download: false, reason: '录像证据脱敏失败，已拒绝回放' };
  if (artifact.status === 'available') return { download: true, warning: null };
  if (artifact.status === 'degraded')
    return {
      download: true,
      warning: detail || '录像证据不完整（录制被截断）',
    };
  return { download: false, reason: detail || '录像证据不可用' };
}

/** Download one evidence artifact, keeping the existing ownership checks. */
async function downloadEvidence(
  artifactId: string,
  runId: string | null,
): Promise<{ blob: Blob; warning: string | null }> {
  const artifact = await defaultApiClient.getArtifact(artifactId);
  if (runId && artifact.runId !== runId)
    throw new Error('录像证据不属于这个会话');
  const decision = evidencePolicy(artifact);
  if (!decision.download) throw new Error(decision.reason);
  const blob = await defaultApiClient.downloadArtifact(artifactId);
  if (!blob.size) throw new Error('录像证据是空的');
  return { blob, warning: decision.warning };
}

const GZIP_MAGIC = [0x1f, 0x8b];

/** Gunzip when the blob is gzipped, parse as UTF-8 JSON either way. */
export async function readJsonBlob<T>(blob: Blob): Promise<T> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzipped =
    head.length === 2 && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
  let text: string;
  if (gzipped) {
    if (typeof DecompressionStream === 'undefined')
      throw new Error('浏览器不支持解压录像');
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = await blob.text();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('录像内容不是合法的 JSON');
  }
}

export interface RecordingPayload {
  events: unknown[];
  consoleLines: ConsoleLine[];
  networkLines: NetworkLine[];
  /** Degraded evidence that still replays, with the reason to show. */
  warnings: string[];
}

/** Fetch every part of a recording that is present, tolerating a missing one. */
export async function loadRecordingPayload(
  recording: RecordingInfo,
  runId: string | null = null,
): Promise<RecordingPayload> {
  const warnings: string[] = [];
  const read = async <T>(artifactId: string | null): Promise<T[]> => {
    if (!artifactId) return [];
    const { blob, warning } = await downloadEvidence(artifactId, runId);
    if (warning && !warnings.includes(warning)) warnings.push(warning);
    const parsed = await readJsonBlob<T[]>(blob);
    return Array.isArray(parsed) ? parsed : [];
  };
  const [events, consoleLines, networkLines] = await Promise.all([
    read<unknown>(recording.rrwebArtifactId),
    read<ConsoleLine>(recording.consoleArtifactId),
    read<NetworkLine>(recording.networkArtifactId),
  ]);
  if (!events.length && recording.rrwebArtifactId)
    throw new Error('录像里没有可回放的事件');
  return { events, consoleLines, networkLines, warnings };
}
