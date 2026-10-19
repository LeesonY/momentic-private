import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EventType, Replayer, type eventWithTime } from 'rrweb';
import 'rrweb/dist/style.css';
import type { Step } from '@localqa/contracts';
import { AppIcon } from '../ui/AppIcon.tsx';
import { Alert } from '../ui/Alert.tsx';
import { stepLabel } from '../session/sessionFeed.ts';
import {
  LANE_LABELS,
  consoleLevelRank,
  filterConsole,
  filterNetwork,
  activityRows,
  filterActivity,
  formatClock,
  mergeNetworkLines,
  networkName,
  percentAt,
  problemTicks,
  recordingStatusView,
  reproMarkers,
  shortUrl,
  sortSteps,
  stepBlocks,
  timelineRange,
  urlAt,
  type ConsoleLevel,
  type ConsoleLine,
  type NetworkFilters,
  type NetworkLine,
  type RecordingInfo,
  type RecordingWindow,
  type ReproStepMark,
  type StepLane,
} from '../../utils/recording.ts';

/** Steps carry the agent's own thought (Mo's THOUGHT rows) once pi1 adds it. */
type ReplayStep = Step & { thought?: string | null };

export interface RecordingPlayerProps {
  /** What the server said about this task's recording. */
  recording: RecordingInfo;
  events: unknown[];
  consoleLines?: ConsoleLine[];
  networkLines?: ConsoleLine[] | NetworkLine[];
  /** Degraded evidence the player still replays (a recording cut at the cap). */
  warnings?: string[];
  /** Why the steps could not be read (the activity list is then not "empty"). */
  stepsError?: string | null;
  /** More steps exist than were read; the activity list is cut. */
  stepsTruncated?: boolean;
  steps?: ReplayStep[];
  /** Defect replay: only this slice is on the axis, the events stay whole. */
  window?: RecordingWindow | null;
  /** Reproduction steps of the defect, with their places in the recording. */
  reproSteps?: string[];
  reproMarks?: ReproStepMark[];
  /** 「完整录像 ↗」: open the session's screen panel on the full recording. */
  onOpenFullRecording?: () => void;
  /** Title line: 「复现」 for a defect, nothing for a full recording. */
  heading?: string;
  /** Shown when the recording is unavailable instead of the player. */
  fallback?: React.ReactNode;
  testId?: string;
}

const SPEEDS = [1, 2, 4] as const;
const CONSOLE_LEVELS: Array<ConsoleLevel | 'all'> = [
  'all',
  'log',
  'info',
  'warn',
  'error',
];
const LEVEL_LABELS: Record<ConsoleLevel | 'all', string> = {
  all: '全部级别',
  log: 'log',
  info: 'info',
  warn: 'warn',
  error: 'error',
};
const LANES: StepLane[] = ['navigate', 'click', 'type', 'observe', 'other'];

const clockOf = (at: string): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('zh-CN', { hour12: false });
};

const LEVEL_CLASS: Record<ConsoleLevel, string> = {
  log: 'is-log',
  info: 'is-info',
  warn: 'is-warn',
  error: 'is-error',
};

/**
 * Mo's replay: one rrweb player over the task's whole recording, with the
 * defect's window on the axis, three marker tracks (steps, problems,
 * reproduction steps) and the activity/console/network tabs underneath.
 *
 * The events are always the complete recording: a defect window narrows what
 * the user sees and seeks to, never the DOM history the replay needs.
 */
export const RecordingPlayer: React.FC<RecordingPlayerProps> = ({
  recording,
  events,
  consoleLines = [],
  networkLines = [],
  warnings = [],
  stepsError = null,
  stepsTruncated = false,
  steps = [],
  window: replayWindow = null,
  reproSteps = [],
  reproMarks = [],
  onOpenFullRecording,
  heading,
  fallback = null,
  testId = 'recording-player',
}) => {
  const status = recordingStatusView(recording);
  const rrwebEvents = useMemo(
    () => events as unknown as eventWithTime[],
    [events],
  );
  const metaEvents = useMemo(() => {
    const metas: Array<{ at: number; href: string }> = [];
    for (const event of rrwebEvents) {
      if (event.type !== EventType.Meta) continue;
      const href = (event.data as { href?: unknown }).href;
      if (typeof href === 'string' && href.length > 0)
        metas.push({ at: event.timestamp, href });
    }
    return metas;
  }, [rrwebEvents]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const [meta, setMeta] = useState<{ startMs: number; totalMs: number } | null>(
    null,
  );
  const [playhead, setPlayhead] = useState<number>(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [scale, setScale] = useState(1);
  const [tab, setTab] = useState<'activity' | 'console' | 'network'>(
    'activity',
  );
  const [consoleQuery, setConsoleQuery] = useState('');
  const [consoleLevel, setConsoleLevel] = useState<ConsoleLevel | 'all'>('all');
  const [activityQuery, setActivityQuery] = useState('');
  const [activityKind, setActivityKind] = useState<
    'all' | 'action' | 'thought'
  >('all');
  const [networkQuery, setNetworkQuery] = useState('');
  const [networkFilters, setNetworkFilters] = useState<NetworkFilters>({
    method: 'all',
    status: 'all',
    resourceType: 'all',
    onlyFailed: false,
  });

  const range = useMemo(
    () =>
      timelineRange(replayWindow, {
        startAt: recording.startedAt,
        endAt: recording.endedAt,
      }),
    [replayWindow, recording.startedAt, recording.endedAt],
  );
  const viewport = recording.viewport ?? { width: 1280, height: 720 };

  // The player owns one iframe; it is rebuilt only when the event list or the
  // axis changes, and always destroyed so its listeners do not leak.
  const rangeKey = range ? `${range.startMs}-${range.endMs}` : 'all';
  useEffect(() => {
    const root = stageRef.current;
    if (!root || rrwebEvents.length === 0) return;
    const replayer = new Replayer(rrwebEvents, {
      root,
      speed: 1,
      skipInactive: false,
      showWarning: false,
      showDebug: false,
      triggerFocus: false,
      UNSAFE_replayCanvas: false,
      loadTimeout: 3000,
      mouseTail: { strokeStyle: '#4d7cff', lineWidth: 2, duration: 800 },
    });
    replayerRef.current = replayer;
    const info = replayer.getMetaData();
    const startMs = info.startTime;
    const totalMs = Math.max(1, info.totalTime);
    setMeta({ startMs, totalMs });
    const initial = range ? Math.max(0, range.startMs - startMs) : 0;
    replayer.pause(Math.min(initial, totalMs));
    setPlayhead(startMs + Math.min(initial, totalMs));
    setPlaying(false);
    const onFinish = () => setPlaying(false);
    replayer.on('finish', onFinish);
    return () => {
      replayer.off('finish', onFinish);
      replayer.destroy();
      replayerRef.current = null;
      setMeta(null);
    };
  }, [rrwebEvents, rangeKey]);

  // rrweb 2.x has no "current time" event, so the clock and the playhead are
  // read from the player on each animation frame while it plays.
  useEffect(() => {
    if (!playing || !meta) return;
    let frame = 0;
    const tick = () => {
      const replayer = replayerRef.current;
      if (replayer) setPlayhead(meta.startMs + replayer.getCurrentTime());
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, meta]);

  // Fit the recorded viewport into the pane; Mo keeps the frame legible at any
  // width instead of cropping it.
  useEffect(() => {
    const host = frameRef.current;
    if (!host) return;
    const fit = () => {
      const width = host.clientWidth;
      if (!width) return;
      setScale(Math.min(1, width / viewport.width));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [viewport.width]);

  const seek = useCallback(
    (atMs: number) => {
      const replayer = replayerRef.current;
      if (!replayer || !meta) return;
      const offset = Math.max(0, Math.min(meta.totalMs, atMs - meta.startMs));
      const wasPlaying = playing;
      if (wasPlaying) replayer.pause();
      replayer.pause(offset);
      setPlayhead(meta.startMs + offset);
      setPlaying(false);
    },
    [meta, playing],
  );

  const togglePlay = useCallback(() => {
    const replayer = replayerRef.current;
    if (!replayer || !meta) return;
    if (playing) {
      replayer.pause();
      setPlaying(false);
      return;
    }
    // Restart from the window start when the previous run already finished.
    if (replayer.getCurrentTime() >= meta.totalMs - 40) {
      const initial = range ? Math.max(0, range.startMs - meta.startMs) : 0;
      replayer.play(initial);
    } else {
      replayer.play();
    }
    setPlaying(true);
  }, [playing, meta, range]);

  useEffect(() => {
    replayerRef.current?.setConfig({ speed });
  }, [speed]);

  const currentUrl = useMemo(
    () => (meta ? urlAt(metaEvents, playhead) : null),
    [metaEvents, playhead, meta],
  );

  const blocks = useMemo(
    () => (range ? stepBlocks(sortSteps(steps), range) : []),
    [steps, range],
  );
  // The recorder writes a start and a finish line per request; the axis and the
  // network tab both want one row per request.
  const network = useMemo(
    () =>
      mergeNetworkLines(
        (networkLines as NetworkLine[]).filter(
          (line) => typeof line?.method === 'string',
        ),
      ),
    [networkLines],
  );
  const problems = useMemo(
    () => (range ? problemTicks(consoleLines, network, range) : []),
    [consoleLines, network, range],
  );
  // A marker reads the player clock, whose zero is the start of the whole
  // recording (`meta.startMs`), not the left edge of a defect's slice.
  const clockOriginMs = useMemo(() => {
    if (meta) return meta.startMs;
    const started = recording.startedAt ? Date.parse(recording.startedAt) : NaN;
    return Number.isFinite(started) ? started : null;
  }, [meta, recording.startedAt]);
  const markers = useMemo(
    () =>
      range
        ? reproMarkers(
            reproMarks,
            reproSteps,
            range,
            clockOriginMs ?? range.startMs,
          )
        : [],
    [reproMarks, reproSteps, range, clockOriginMs],
  );

  const totalSpan = meta?.totalMs ?? 0;
  const clockNow = meta
    ? Math.max(0, Math.min(totalSpan, playhead - meta.startMs))
    : 0;
  const progressPct = range ? percentAt(playhead, range) : 0;

  const rows = useMemo(
    () => activityRows(steps, (step) => `${stepLabel(step)} · ${step.summary}`),
    [steps],
  );

  const visibleActivity = useMemo(
    () => filterActivity(rows, { query: activityQuery, kind: activityKind }),
    [rows, activityKind, activityQuery],
  );

  const visibleConsole = useMemo(
    () =>
      [
        ...filterConsole(consoleLines, {
          query: consoleQuery,
          level: consoleLevel,
        }),
      ].sort(
        (left, right) =>
          consoleLevelRank(left.level) - consoleLevelRank(right.level) ||
          left.at.localeCompare(right.at),
      ),
    [consoleLines, consoleQuery, consoleLevel],
  );

  const visibleNetwork = useMemo(
    () =>
      filterNetwork(network, {
        ...networkFilters,
        query: networkQuery,
      }),
    [network, networkFilters, networkQuery],
  );
  const networkSpan = useMemo(() => {
    const durations = network
      .map((line) => line.durationMs ?? 0)
      .filter((value) => value > 0);
    return durations.length ? Math.max(...durations) : 1;
  }, [network]);

  const hintText = useMemo(() => {
    const parts = warnings.map((warning) => warning.trim()).filter(Boolean);
    if (parts.length > 0)
      return status.tone === 'warning'
        ? `录像不完整：${parts.join('；')}`
        : parts.join('；');
    return status.detail;
  }, [status.detail, status.tone, warnings]);

  const activeStepId = useMemo(() => {
    let found: string | undefined;
    for (const block of blocks) {
      if (Date.parse(block.at) <= playhead) found = block.id;
    }
    return found;
  }, [blocks, playhead]);

  if (!status.playable || rrwebEvents.length === 0) {
    return (
      <section
        className="lqa-recording is-empty"
        data-testid={`${testId}-empty`}
      >
        <header className="lqa-recording-head">
          {heading && <h3>{heading}</h3>}
          <span
            className={`badge badge-${status.tone === 'danger' ? 'danger' : status.tone === 'warning' ? 'warning' : 'neutral'}`}
          >
            {status.label}
          </span>
        </header>
        {status.detail && (
          <Alert
            tone={status.tone === 'danger' ? 'danger' : 'info'}
            testId={`${testId}-status`}
          >
            {status.detail}
          </Alert>
        )}
        {warnings
          .filter((warning) => warning.trim().length > 0)
          .map((warning) => (
            <Alert key={warning} tone="warning" testId={`${testId}-warning`}>
              {warning}
            </Alert>
          ))}
        {fallback}
      </section>
    );
  }

  return (
    <section className="lqa-recording" data-testid={testId} ref={containerRef}>
      <header className="lqa-recording-head">
        {heading && <h3>{heading}</h3>}
        <span className="lqa-recording-tabs" role="tablist">
          <span
            className="lqa-recording-tab is-current"
            role="tab"
            aria-selected="true"
          >
            回放
          </span>
          {onOpenFullRecording && (
            <button
              type="button"
              className="lqa-recording-tab"
              onClick={onOpenFullRecording}
              data-testid={`${testId}-full`}
            >
              完整录像
              <AppIcon name="external-link" size={12} />
            </button>
          )}
        </span>
        {hintText && (
          <span
            className="lqa-recording-warning"
            role="status"
            data-testid={`${testId}-warning`}
          >
            <AppIcon name="alert-triangle" size={13} />
            {hintText}
          </span>
        )}
      </header>

      <div className="lqa-recording-frame">
        <div className="lqa-recording-bar">
          <span className="lqa-recording-url" data-testid={`${testId}-url`}>
            <AppIcon name="lock" size={11} />
            {currentUrl?.replace(/^https?:\/\//, '') ?? 'about:blank'}
          </span>
          <span className="lqa-recording-viewport">
            视口 {viewport.width} × {viewport.height}
          </span>
        </div>
        <div
          className="lqa-recording-stage"
          ref={frameRef}
          style={{ height: viewport.height * scale }}
        >
          <div
            className="lqa-recording-canvas"
            style={{ transform: `scale(${scale})`, width: viewport.width }}
          >
            <div ref={stageRef} data-testid={`${testId}-stage`} />
          </div>
          {!playing && (
            <button
              type="button"
              className="lqa-recording-bigplay"
              aria-label="播放录像"
              onClick={togglePlay}
              data-testid={`${testId}-bigplay`}
            >
              <AppIcon name="play" size={22} />
            </button>
          )}
        </div>
      </div>

      <div className="lqa-recording-controls">
        <div className="lqa-recording-scrub">
          <div
            className="lqa-recording-scrub-track"
            role="slider"
            tabIndex={0}
            aria-label="回放进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressPct)}
            onClick={(event) => {
              if (!range) return;
              const box = event.currentTarget.getBoundingClientRect();
              const ratio = Math.max(
                0,
                Math.min(
                  1,
                  (event.clientX - box.left) / Math.max(1, box.width),
                ),
              );
              seek(range.startMs + ratio * range.spanMs);
            }}
            onKeyDown={(event) => {
              if (!range) return;
              if (event.key === 'ArrowRight') seek(playhead + 5000);
              if (event.key === 'ArrowLeft') seek(playhead - 5000);
            }}
            data-testid={`${testId}-scrub`}
          >
            <span
              className="lqa-recording-scrub-fill"
              style={{ width: `${progressPct}%` }}
            />
            <span
              className="lqa-recording-scrub-thumb"
              style={{ left: `${progressPct}%` }}
            />
          </div>
        </div>
        <div className="lqa-recording-buttons">
          <select
            className="form-input lqa-recording-speed"
            aria-label="播放倍速"
            value={speed}
            onChange={(event) =>
              setSpeed(Number(event.target.value) as (typeof SPEEDS)[number])
            }
            data-testid={`${testId}-speed`}
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>
                {value}x
              </option>
            ))}
          </select>
          <button
            type="button"
            className="lqa-icon-button"
            aria-label="后退 5 秒"
            title="后退 5 秒"
            onClick={() => seek(playhead - 5000)}
          >
            <AppIcon name="rotate-ccw" size={15} />
          </button>
          <button
            type="button"
            className="lqa-icon-button"
            aria-label={playing ? '暂停' : '播放'}
            title={playing ? '暂停' : '播放'}
            onClick={togglePlay}
            data-testid={`${testId}-play`}
          >
            <AppIcon name={playing ? 'pause' : 'play'} size={15} />
          </button>
          <button
            type="button"
            className="lqa-icon-button"
            aria-label="前进 5 秒"
            title="前进 5 秒"
            onClick={() => seek(playhead + 5000)}
          >
            <AppIcon name="rotate-cw" size={15} />
          </button>
          <span className="lqa-recording-clock" data-testid={`${testId}-clock`}>
            {formatClock(clockNow)} ({formatClock(totalSpan)})
          </span>
          <button
            type="button"
            className="lqa-icon-button"
            aria-label="全屏"
            title="全屏"
            onClick={() => {
              const host = containerRef.current;
              if (!host) return;
              if (document.fullscreenElement) void document.exitFullscreen();
              else void host.requestFullscreen?.();
            }}
          >
            <AppIcon name="maximize" size={15} />
          </button>
        </div>
      </div>

      {range && (
        <div className="lqa-recording-tracks" data-testid={`${testId}-tracks`}>
          <div className="lqa-recording-track">
            <span className="lqa-recording-track-label">步骤</span>
            <div className="lqa-recording-track-lane">
              {blocks.map((block) => (
                <button
                  key={block.id}
                  type="button"
                  className={`lqa-recording-block is-${block.lane}`}
                  style={{
                    left: `${block.leftPct}%`,
                    width: `${block.widthPct}%`,
                  }}
                  title={`第 ${block.seq} 步 · ${LANE_LABELS[block.lane]} · ${clockOf(block.at)}`}
                  onClick={() => seek(Date.parse(block.at))}
                  data-testid={`${testId}-step-${block.seq}`}
                />
              ))}
            </div>
          </div>
          <div className="lqa-recording-track">
            <span className="lqa-recording-track-label">问题</span>
            <div className="lqa-recording-track-lane">
              {problems.map((tick) => (
                <button
                  key={`${tick.at}:${tick.leftPct}`}
                  type="button"
                  className="lqa-recording-tick"
                  style={{ left: `${tick.leftPct}%` }}
                  title={tick.title}
                  onClick={() => seek(Date.parse(tick.at))}
                />
              ))}
            </div>
          </div>
          {markers.length > 0 && (
            <div className="lqa-recording-track">
              <span className="lqa-recording-track-label">复现步骤</span>
              <div className="lqa-recording-track-lane">
                {markers.map((marker) => (
                  <button
                    key={marker.index}
                    type="button"
                    className="lqa-recording-marker"
                    style={{ left: `${marker.leftPct}%` }}
                    title={marker.title}
                    onClick={() => seek(Date.parse(marker.at))}
                    data-testid={`${testId}-repro-${marker.index}`}
                  >
                    {marker.index}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="lqa-recording-legend">
            {LANES.map((lane) => (
              <span
                key={lane}
                className={`lqa-recording-legend-item is-${lane}`}
              >
                <i />
                {LANE_LABELS[lane]}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="lqa-recording-panels">
        <div className="lqa-recording-panel-tabs" role="tablist">
          {(
            [
              ['activity', '活动', rows.length],
              ['console', '控制台', consoleLines.length],
              ['network', '网络', network.length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`lqa-recording-panel-tab ${tab === key ? 'is-current' : ''}`}
              onClick={() => setTab(key)}
              data-testid={`${testId}-tab-${key}`}
            >
              {label} {count}
            </button>
          ))}
        </div>

        {tab === 'activity' && (
          <div
            className="lqa-recording-panel"
            data-testid={`${testId}-activity`}
          >
            <div className="lqa-recording-filters">
              <input
                className="form-input"
                placeholder="搜索活动"
                value={activityQuery}
                onChange={(event) => setActivityQuery(event.target.value)}
                aria-label="搜索活动"
              />
              <select
                className="form-input"
                aria-label="活动类型"
                value={activityKind}
                onChange={(event) =>
                  setActivityKind(event.target.value as typeof activityKind)
                }
              >
                <option value="all">全部类型</option>
                <option value="action">动作</option>
                <option value="thought">想法</option>
              </select>
            </div>
            {stepsError && (
              <Alert tone="danger" testId={`${testId}-steps-error`}>
                步骤加载失败：{stepsError}
              </Alert>
            )}
            {stepsTruncated && (
              <p className="field-hint" data-testid={`${testId}-steps-cut`}>
                步骤过多，只显示前 {steps.length} 条。
              </p>
            )}
            {visibleActivity.length === 0 ? (
              <p className="field-hint">
                {stepsError ? '步骤没有加载出来。' : '没有匹配的活动。'}
              </p>
            ) : (
              <table className="data-table lqa-recording-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>内容</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleActivity.map((row) => (
                    <tr
                      key={row.key}
                      className={
                        row.stepId && row.stepId === activeStepId
                          ? 'is-current'
                          : ''
                      }
                      onClick={() => seek(Date.parse(row.at))}
                    >
                      <td className="mono">{clockOf(row.at)}</td>
                      <td>
                        <span
                          className={`badge ${row.kind === 'thought' ? 'badge-neutral' : 'badge-info'}`}
                        >
                          {row.kind === 'thought' ? '想法' : '动作'}
                        </span>
                      </td>
                      <td
                        className={row.kind === 'thought' ? 'is-thought' : ''}
                        title={row.text}
                      >
                        {row.kind === 'thought' ? (
                          <span className="lqa-recording-thought">
                            {row.title}
                          </span>
                        ) : (
                          row.title
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'console' && (
          <div
            className="lqa-recording-panel"
            data-testid={`${testId}-console`}
          >
            <div className="lqa-recording-filters">
              <input
                className="form-input"
                placeholder="搜索控制台"
                value={consoleQuery}
                onChange={(event) => setConsoleQuery(event.target.value)}
                aria-label="搜索控制台"
              />
              <select
                className="form-input"
                aria-label="控制台级别"
                value={consoleLevel}
                onChange={(event) =>
                  setConsoleLevel(event.target.value as ConsoleLevel | 'all')
                }
              >
                {CONSOLE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {LEVEL_LABELS[level]}
                  </option>
                ))}
              </select>
            </div>
            {visibleConsole.length === 0 ? (
              <p className="field-hint">没有匹配的控制台记录。</p>
            ) : (
              <table className="data-table lqa-recording-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>级别</th>
                    <th>文本</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleConsole.map((line) => (
                    <tr
                      key={`${line.at}:${line.text}`}
                      onClick={() => seek(Date.parse(line.at))}
                    >
                      <td className="mono">{clockOf(line.at)}</td>
                      <td>
                        <span
                          className={`lqa-console-level ${LEVEL_CLASS[line.level]}`}
                        >
                          {line.source === 'pageerror'
                            ? 'pageerror'
                            : line.level}
                        </span>
                      </td>
                      <td title={line.text}>{line.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'network' && (
          <div
            className="lqa-recording-panel"
            data-testid={`${testId}-network`}
          >
            <div className="lqa-recording-filters">
              <input
                className="form-input"
                placeholder="搜索 URL"
                value={networkQuery}
                onChange={(event) => setNetworkQuery(event.target.value)}
                aria-label="搜索网络请求"
              />
              <select
                className="form-input"
                aria-label="请求方法"
                value={networkFilters.method ?? 'all'}
                onChange={(event) =>
                  setNetworkFilters((previous) => ({
                    ...previous,
                    method: event.target.value,
                  }))
                }
              >
                {['all', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(
                  (method) => (
                    <option key={method} value={method}>
                      {method === 'all' ? '全部方法' : method}
                    </option>
                  ),
                )}
              </select>
              <select
                className="form-input"
                aria-label="响应状态"
                value={networkFilters.status ?? 'all'}
                onChange={(event) =>
                  setNetworkFilters((previous) => ({
                    ...previous,
                    status: event.target.value as NetworkFilters['status'],
                  }))
                }
              >
                <option value="all">全部状态</option>
                <option value="2xx">2xx</option>
                <option value="3xx">3xx</option>
                <option value="4xx">4xx</option>
                <option value="5xx">5xx</option>
                <option value="failed">失败</option>
              </select>
              <label className="check">
                <input
                  type="checkbox"
                  checked={networkFilters.onlyFailed ?? false}
                  onChange={(event) =>
                    setNetworkFilters((previous) => ({
                      ...previous,
                      onlyFailed: event.target.checked,
                    }))
                  }
                  data-testid={`${testId}-only-failed`}
                />
                只看失败
              </label>
            </div>
            {visibleNetwork.length === 0 ? (
              <p className="field-hint">没有匹配的网络请求。</p>
            ) : (
              <table className="data-table lqa-recording-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>状态</th>
                    <th>耗时</th>
                    <th>时间线</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleNetwork.map((line) => (
                    <tr
                      key={`${line.at}:${line.url}`}
                      onClick={() => seek(Date.parse(line.at))}
                    >
                      <td
                        title={
                          typeof line.summary === 'string' && line.summary
                            ? `${line.summary}\n${shortUrl(line.url)}`
                            : shortUrl(line.url)
                        }
                      >
                        {networkName(line.url)}
                      </td>
                      <td
                        className={
                          line.failed || (line.status ?? 0) >= 400
                            ? 'is-error'
                            : ''
                        }
                      >
                        {line.failed ? '失败' : (line.status ?? '—')}
                      </td>
                      <td>
                        {line.durationMs === null
                          ? '—'
                          : `${line.durationMs} ms`}
                      </td>
                      <td className="lqa-network-waterfall">
                        <span
                          style={{
                            width: `${Math.max(
                              4,
                              ((line.durationMs ?? 0) / networkSpan) * 100,
                            )}%`,
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
