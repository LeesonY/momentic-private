import type {
  ConsoleEntry,
  Finding,
  NetworkEntry,
  Step,
  TaskRecording,
} from '@localqa/contracts';

/**
 * The rules behind the replay UI: how a recording window maps onto the time
 * axis, which lane a step belongs to, how problems and reproduction steps
 * become markers, and how the activity/console/network lists are filtered.
 *
 * Kept free of React and of the network so they can be tested offline.
 */

// The replay UI speaks the contract types directly; the aliases keep the
// component props readable.
export type RecordingStatus = TaskRecording['status'];
export type RecordingInfo = TaskRecording;
export type ConsoleLevel = ConsoleEntry['level'];
export type ConsoleLine = ConsoleEntry;
export type NetworkLine = NetworkEntry;

/** The reproduction metadata a defect carries (`Finding.recording`). */
export type FindingRecording = NonNullable<Finding['recording']>;

/** A reproduction step's position inside the recording. */
export type ReproStepMark = FindingRecording['steps'][number];

/** The slice of a task's recording a defect replays. */
export interface RecordingWindow {
  startAt: string;
  endAt: string;
}

export interface TimelineRange {
  startMs: number;
  endMs: number;
  /** Total length in ms, never zero (a single instant still draws). */
  spanMs: number;
}

export function timelineRange(
  window: RecordingWindow | null,
  fallback: { startAt: string | null; endAt: string | null },
): TimelineRange | null {
  const start = window?.startAt ?? fallback.startAt;
  const end = window?.endAt ?? fallback.endAt;
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const spanMs = endMs - startMs;
  return { startMs, endMs, spanMs: spanMs > 0 ? spanMs : 1 };
}

/** Where one instant sits on the range, clamped to 0–100. */
export function percentAt(at: string | number, range: TimelineRange): number {
  const atMs = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(atMs)) return 0;
  const ratio = (atMs - range.startMs) / range.spanMs;
  return Math.max(0, Math.min(100, ratio * 100));
}

export const inRange = (at: string, range: TimelineRange): boolean => {
  const atMs = Date.parse(at);
  return Number.isFinite(atMs) && atMs >= range.startMs && atMs <= range.endMs;
};

export type StepLane = 'navigate' | 'click' | 'type' | 'observe' | 'other';

const LANE_BY_TOOL: Record<string, StepLane> = {
  navigate: 'navigate',
  click: 'click',
  type_text: 'type',
  select_option: 'type',
  press: 'type',
  observe: 'observe',
  capture: 'observe',
  wait_for: 'observe',
};

/** Mo's legend: Navigate / Click / Type / Observe, everything else stays grey. */
export function stepLane(toolName: string): StepLane {
  const name = toolName.replace(/^browser[._]/, '').toLowerCase();
  return LANE_BY_TOOL[name] ?? 'other';
}

export const LANE_LABELS: Record<StepLane, string> = {
  navigate: '导航',
  click: '点击',
  type: '输入',
  observe: '观察',
  other: '其他',
};

export interface TimelineBlock {
  id: string;
  seq: number;
  lane: StepLane;
  label: string;
  leftPct: number;
  widthPct: number;
  at: string;
}

/** One block per step, clamped into the window (a step may span its edge). */
export function stepBlocks(
  steps: readonly Pick<
    Step,
    'id' | 'seq' | 'toolName' | 'createdAt' | 'finishedAt' | 'summary'
  >[],
  range: TimelineRange,
): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  for (const step of steps) {
    const startedAt = Date.parse(step.createdAt);
    if (!Number.isFinite(startedAt)) continue;
    const finished = step.finishedAt ? Date.parse(step.finishedAt) : NaN;
    const endedAt =
      Number.isFinite(finished) && finished > startedAt
        ? finished
        : startedAt + 250;
    if (endedAt < range.startMs || startedAt > range.endMs) continue;
    const left = percentAt(Math.max(startedAt, range.startMs), range);
    const right = percentAt(Math.min(endedAt, range.endMs), range);
    blocks.push({
      id: step.id,
      seq: step.seq,
      lane: stepLane(step.toolName),
      label: step.summary,
      leftPct: left,
      widthPct: Math.max(0.6, right - left),
      at: new Date(startedAt).toISOString(),
    });
  }
  return blocks;
}

export interface Tick {
  at: string;
  leftPct: number;
  title: string;
}

/** Console errors, page errors, failed or ≥400 responses — Mo's Problems row. */
export function problemTicks(
  consoleLines: readonly ConsoleLine[],
  networkLines: readonly NetworkLine[],
  range: TimelineRange,
): Tick[] {
  const ticks: Tick[] = [];
  for (const line of consoleLines) {
    if (!inRange(line.at, range)) continue;
    if (line.level !== 'error' && line.source !== 'pageerror') continue;
    ticks.push({
      at: line.at,
      leftPct: percentAt(line.at, range),
      title:
        `${clockOf(line.at)} ${line.source === 'pageerror' ? '页面脚本异常' : 'Console 错误'}：${line.text}`.slice(
          0,
          300,
        ),
    });
  }
  for (const line of networkLines) {
    if (!inRange(line.at, range)) continue;
    if (!line.failed && !(line.status !== null && line.status >= 400)) continue;
    ticks.push({
      at: line.at,
      leftPct: percentAt(line.at, range),
      title: `${clockOf(line.at)} ${line.method} ${shortUrl(line.url)} → ${line.failed ? '请求失败' : line.status}`,
    });
  }
  return ticks.sort((left, right) => left.leftPct - right.leftPct);
}

export interface ReproMarker extends Tick {
  index: number;
}

/** Numbered markers for the defect's own reproduction steps. */
export function reproMarkers(
  marks: readonly ReproStepMark[],
  reproSteps: readonly string[],
  range: TimelineRange,
): ReproMarker[] {
  return [...marks]
    .filter((mark) => inRange(mark.at, range))
    .sort((left, right) => left.index - right.index)
    .map((mark) => ({
      index: mark.index,
      at: mark.at,
      leftPct: percentAt(mark.at, range),
      title: `第 ${mark.index} 步：${(reproSteps[mark.index - 1] ?? '').slice(0, 300)}  ${clockOf(mark.at)}`,
    }));
}

/** m:ss, matching Mo's player clock. */
export function formatClock(ms: number): string {
  // Floored like Mo's player clock: 1.86 s reads 0:01, never 0:02.
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const clockOf = (at: string): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('zh-CN', { hour12: false });
};

export const shortUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};

/** The last path segment, which is what Mo shows in the Name column. */
export const networkName = (url: string): string => {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments.at(-1) ?? parsed.hostname;
  } catch {
    return url;
  }
};

const LEVEL_ORDER: Record<ConsoleLevel, number> = {
  log: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function filterConsole(
  lines: readonly ConsoleLine[],
  filters: { query?: string; level?: ConsoleLevel | 'all' },
): ConsoleLine[] {
  const query = (filters.query ?? '').trim().toLowerCase();
  const level = filters.level ?? 'all';
  return lines.filter((line) => {
    if (level !== 'all' && line.level !== level) return false;
    if (query && !line.text.toLowerCase().includes(query)) return false;
    return true;
  });
}

export interface NetworkFilters {
  query?: string;
  method?: string | 'all';
  status?: 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'failed';
  resourceType?: string | 'all';
  onlyFailed?: boolean;
}

export function filterNetwork(
  lines: readonly NetworkLine[],
  filters: NetworkFilters,
): NetworkLine[] {
  const query = (filters.query ?? '').trim().toLowerCase();
  return lines.filter((line) => {
    if (filters.onlyFailed && !line.failed) return false;
    if (
      filters.method &&
      filters.method !== 'all' &&
      line.method.toUpperCase() !== filters.method.toUpperCase()
    )
      return false;
    const status = filters.status ?? 'all';
    if (status === 'failed') {
      if (!line.failed) return false;
    } else if (status !== 'all') {
      const bucket = status.slice(0, 1);
      if (line.status === null || String(line.status)[0] !== bucket)
        return false;
    }
    if (
      filters.resourceType &&
      filters.resourceType !== 'all' &&
      line.resourceType !== filters.resourceType
    )
      return false;
    if (query) {
      const haystack = `${line.url} ${line.method}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export const consoleLevelRank = (level: ConsoleLevel): number =>
  LEVEL_ORDER[level];

export interface RecordingStatusView {
  tone: 'info' | 'warning' | 'neutral' | 'danger';
  label: string;
  detail: string | null;
  /** False only when there is nothing to play. */
  playable: boolean;
}

/**
 * FR-030: a missing or unfinished recording says so and never fabricates a
 * link; a degraded one still plays and carries its error next to it.
 */
export function recordingStatusView(
  info: RecordingInfo | null,
  error: string | null = null,
): RecordingStatusView {
  if (error)
    return {
      tone: 'danger',
      label: '录像读取失败',
      detail: error,
      playable: false,
    };
  if (!info)
    return {
      tone: 'neutral',
      label: '没有录像',
      detail: '这个任务没有可回放的录像。',
      playable: false,
    };
  switch (info.status) {
    case 'recording':
      return {
        tone: 'info',
        label: '录制中',
        detail: '任务还没有结束，录像在任务结束后可回放。',
        playable: false,
      };
    case 'available':
      return { tone: 'neutral', label: '录像', detail: null, playable: true };
    case 'degraded':
      return {
        tone: 'warning',
        label: '录像不完整',
        detail: info.error
          ? `录像不完整：${info.error}`
          : '录像不完整：录制提前结束，已录部分仍可回放。',
        playable: info.rrwebArtifactId !== null,
      };
    case 'missing':
    default:
      return {
        tone: 'neutral',
        label: '没有录像',
        detail: info.error ?? '这个任务没有可回放的录像。',
        playable: false,
      };
  }
}

/** Steps of one task, oldest first, as the activity list wants them. */
export function sortSteps<T extends { seq: number }>(steps: readonly T[]): T[] {
  return [...steps].sort((left, right) => left.seq - right.seq);
}

/** The URL that was live at a playhead, from the recording's meta events. */
export function urlAt(
  metas: readonly { at: number; href: string }[],
  atMs: number,
): string | null {
  let current: string | null = null;
  for (const meta of metas) {
    if (meta.at > atMs) break;
    current = meta.href;
  }
  return current;
}

/** Resolve the playhead of a window onto an offset inside the full events. */
export function windowOffset(range: TimelineRange, atMs: number): number {
  return Math.max(0, Math.min(range.spanMs, atMs - range.startMs));
}
