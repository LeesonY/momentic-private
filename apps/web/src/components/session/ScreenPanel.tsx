import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Step, Task } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { AppIcon } from '../ui/AppIcon.tsx';
import { EvidencePreview } from '../workbench/TaskExecutionDetail.tsx';
import { stepLabel } from './sessionFeed.ts';
import {
  MAX_STEP_PAGES,
  readTaskStepHistory,
  type TaskStepHistory,
} from './taskStepHistory.ts';

/** Event-led, bounded screenshot step refresh; periodic polling is a fallback. */
export function useTaskSteps(
  taskId: string | null,
  active: boolean,
  stepSignal = 0,
) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const refreshRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    let dirty = false;
    let pendingTimer: number | null = null;
    let lastStarted = 0;
    let history: TaskStepHistory | undefined;
    setSteps([]);
    setError('');
    setHasMore(false);
    if (!taskId) {
      refreshRef.current = null;
      return;
    }
    const schedule = () => {
      if (!mounted) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      if (pendingTimer !== null) return;
      // At most two event-triggered reads per second for one visible panel.
      // A burst during one in-flight query is represented by one trailing read.
      const wait = Math.max(180, 500 - (Date.now() - lastStarted));
      pendingTimer = window.setTimeout(() => {
        pendingTimer = null;
        void load();
      }, wait);
    };
    const load = async () => {
      if (!mounted) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      lastStarted = Date.now();
      try {
        const page = await readTaskStepHistory(
          (query) => defaultApiClient.listTaskSteps(taskId, query),
          history,
        );
        if (!mounted) return;
        history = page;
        setSteps(page.steps);
        setHasMore(page.hasMore);
        setError('');
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : '步骤读取失败');
      } finally {
        inFlight = false;
        if (dirty && mounted) {
          dirty = false;
          schedule();
        }
      }
    };
    refreshRef.current = schedule;
    void load();
    // Finished long runs still need to drain historical pages past the
    // bounded initial load. Once caught up, stop polling completed tasks.
    const timer = window.setInterval(() => {
      if (activeRef.current || history?.hasMore) schedule();
    }, 2500);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
      if (refreshRef.current === schedule) refreshRef.current = null;
    };
  }, [taskId]);
  // All events originate in the existing run-authenticated SSE stream. They
  // only invalidate cached steps, never supply unverified screenshot URLs.
  useEffect(() => {
    if (stepSignal > 0) refreshRef.current?.();
  }, [taskId, stepSignal]);
  // A terminal task update must request one last page, even if SSE step
  // events arrive late or its last screenshot was not yet persisted.
  useEffect(() => {
    if (!active) refreshRef.current?.();
  }, [taskId, active]);
  return { steps, error, hasMore };
}

const laneOf = (step: Step) => {
  const label = stepLabel(step);
  if (label === '打开页面') return 'navigate';
  if (label === '点击') return 'click';
  if (label === '输入' || label === '选择' || label === '按键') return 'type';
  return 'observe';
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });

/** Opt-in by capabilities, never by fabricated playback. Live frames only
 * exist during anonymous, non-submitting tasks; the API enforces project,
 * run, task, expiry and checksum independently on every request. */
function useLiveTaskFrame(taskId: string | null, live: boolean) {
  const [imageUrl, setImageUrl] = useState('');
  const [ageMs, setAgeMs] = useState<number | null>(null);
  useEffect(() => {
    let mounted = true,
      inFlight = false,
      lastUrl = '';
    let lastFrameAt = 0;
    let unavailable = false;
    const controller = new AbortController();
    setImageUrl('');
    setAgeMs(null);
    if (!taskId || !live) return;
    const read = async () => {
      if (
        !mounted ||
        inFlight ||
        unavailable ||
        document.visibilityState === 'hidden'
      )
        return;
      inFlight = true;
      try {
        const response = await fetch(
          `/api/v1/tasks/${encodeURIComponent(taskId)}/live-frame`,
          {
            credentials: 'include',
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(2500),
            ]),
          },
        );
        if (!mounted) return;
        if (response.status === 404 || response.status === 401) {
          unavailable = true;
          return;
        }
        if (response.status === 204) return;
        if (
          !response.ok ||
          !response.headers.get('content-type')?.startsWith('image/jpeg')
        )
          return;
        const size = Number(response.headers.get('content-length') ?? '0');
        if (size > 250_000) return;
        const blob = await response.blob();
        if (!mounted || blob.size < 100 || blob.size > 250_000) return;
        const fresh = URL.createObjectURL(blob);
        const old = lastUrl;
        lastUrl = fresh;
        lastFrameAt = Date.now();
        setImageUrl(fresh);
        const age = Number(response.headers.get('x-capture-age-ms'));
        setAgeMs(Number.isFinite(age) && age >= 0 ? age : null);
        if (old) URL.revokeObjectURL(old);
      } catch {
        // One failed frame cannot turn the browser task into a failed test.
      } finally {
        inFlight = false;
        // Never keep an expired JPEG on screen with a "live" label when
        // Worker frames stop arriving (crash, tab disconnect, lease expiry).
        if (
          mounted &&
          lastUrl &&
          lastFrameAt > 0 &&
          Date.now() - lastFrameAt > 3500
        ) {
          URL.revokeObjectURL(lastUrl);
          lastUrl = '';
          setImageUrl('');
          setAgeMs(null);
        }
      }
    };
    void read();
    const timer = window.setInterval(() => {
      void read();
    }, 850);
    return () => {
      mounted = false;
      controller.abort();
      clearInterval(timer);
      if (lastUrl) URL.revokeObjectURL(lastUrl);
    };
  }, [taskId, live]);
  return { imageUrl, ageMs };
}

/**
 * Mo's screen, from what the worker actually captured: screenshots stepped
 * through like a replay, with each step's type and time. It is not a video.
 */
export const ScreenPanel: React.FC<{
  task: Task | null;
  live: boolean;
  targetUrl: string;
  stepSignal?: number;
}> = ({ task, live, targetUrl, stepSignal = 0 }) => {
  const { imageUrl: liveImage, ageMs: liveAge } = useLiveTaskFrame(
    task?.id ?? null,
    live,
  );
  const { steps, error, hasMore } = useTaskSteps(
    task?.id ?? null,
    live,
    stepSignal,
  );
  const frames = useMemo(
    () => steps.filter((step) => step.evidenceRefs.length > 0),
    [steps],
  );
  const [index, setIndex] = useState<number | null>(null);
  const failedCount = useMemo(
    () => steps.filter((step) => step.status === 'failed').length,
    [steps],
  );
  const pendingCount = useMemo(
    () => steps.filter((step) => step.status === 'running').length,
    [steps],
  );
  // Follow the newest frame unless the user picked one.
  const current =
    index === null ? frames.length - 1 : Math.min(index, frames.length - 1);
  const frame = frames[current];

  useEffect(() => setIndex(null), [task?.id]);

  if (!task)
    return (
      <div className="mo-pane-empty">
        <AppIcon name="monitor" size={20} />
        <p>还没有浏览器代理，暂时没有画面。</p>
      </div>
    );

  return (
    <div className="mo-screen" data-testid="browser-evidence-panel">
      <div className="mo-screen-head">
        <span className={`mo-pill ${live ? 'is-info' : 'is-muted'}`}>
          {live ? '进行中' : '回放'}
        </span>
        <h3>AI 的画面</h3>
        <p>
          {liveImage
            ? '匿名非提交任务：约 1 帧/秒的连续浏览器画面；表单字段已遮挡。不等于完整视频录制。'
            : '根据步骤事件同步已采集截图，断线由轮询补齐；非实时视频。'}
        </p>
        {liveImage && (
          <p className="text-xs muted" role="status">
            实时画面帧 · 采集至 API 约 {liveAge ?? '—'} ms · 不作测试通过证据
          </p>
        )}
        <p className="text-xs muted" role="status">
          已读取 {steps.length} 步 · 执行中 {pendingCount} 步 · 失败{' '}
          {failedCount} 步
          {frame ? ` · 最近画面 ${clock(frame.createdAt)}` : ' · 暂无画面'}
          {hasMore ? ' · 历史还在加载' : ''}
        </p>
      </div>
      <div className="mo-browser">
        <div className="mo-browser-bar">
          <span className="mo-browser-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="mo-browser-url">
            <AppIcon name="lock" size={11} />
            {targetUrl.replace(/^https?:\/\//, '')}
          </span>
        </div>
        <div className="mo-browser-view">
          {liveImage ? (
            <img
              src={liveImage}
              alt="匿名非提交任务的连续浏览器画面帧，敏感输入控件已遮挡"
              className="mo-live-frame"
            />
          ) : frame ? (
            <EvidencePreview
              artifactId={frame.evidenceRefs[0]!}
              runId={task.runId}
            />
          ) : (
            <div className="mo-browser-placeholder">
              <AppIcon name="image" size={20} />
              <span>
                {live ? '等待代理回传第一张截图…' : '这个代理没有采集到截图。'}
              </span>
            </div>
          )}
        </div>
        {frames.length > 0 && (
          <div className="mo-player">
            <div className="mo-player-controls">
              <button
                type="button"
                aria-label="上一张"
                disabled={current <= 0}
                onClick={() => setIndex(Math.max(0, current - 1))}
              >
                <AppIcon name="chevron-left" size={14} />
              </button>
              <span className="mo-player-count">
                {current + 1} / {frames.length}
              </span>
              {index !== null && (
                <button
                  type="button"
                  aria-label="跟随最新画面"
                  title="解除手动回放，跟随新采集的画面"
                  onClick={() => setIndex(null)}
                >
                  最新
                </button>
              )}
              <button
                type="button"
                aria-label="下一张"
                disabled={current >= frames.length - 1}
                onClick={() =>
                  setIndex(
                    current + 1 >= frames.length - 1 ? null : current + 1,
                  )
                }
              >
                <AppIcon name="chevron-right" size={14} />
              </button>
              {frame && (
                <span
                  className="mo-player-caption"
                  title={frame.targetDescription}
                >
                  {stepLabel(frame)}
                  {frame.targetDescription
                    ? ` · ${frame.targetDescription}`
                    : ''}
                </span>
              )}
            </div>
            <div className="mo-player-lane" aria-label="步骤时间轴">
              {frames.map((step, i) => (
                <button
                  type="button"
                  key={step.id}
                  className={`is-${laneOf(step)} ${i === current ? 'is-current' : ''}`}
                  title={`${stepLabel(step)} · ${clock(step.createdAt)}`}
                  aria-label={`第 ${i + 1} 张：${stepLabel(step)}`}
                  onClick={() => setIndex(i === frames.length - 1 ? null : i)}
                />
              ))}
            </div>
            <div className="mo-player-legend">
              <span className="is-navigate">打开页面</span>
              <span className="is-click">点击</span>
              <span className="is-type">输入</span>
              <span className="is-observe">观察</span>
            </div>
          </div>
        )}
      </div>

      <div className="mo-log">
        <div className="mo-log-head">
          <span>时间</span>
          <span>类型</span>
          <span>内容</span>
        </div>
        {error && (
          <p className="mo-log-note" role="alert">
            步骤读取失败：{error}。不能据此认定没有执行。
          </p>
        )}
        {!error && steps.length === 0 && (
          <p className="mo-log-note">代理还没有回传步骤。</p>
        )}
        {steps.map((step) => (
          <div
            key={step.id}
            className={`mo-log-row ${step.status === 'failed' ? 'is-failed' : ''}`}
            data-testid={`task-step-${step.id}`}
          >
            <span>{clock(step.createdAt)}</span>
            <span>{stepLabel(step)}</span>
            <div className="mo-log-detail">
              <details>
                <summary title={step.targetDescription || step.summary}>
                  {step.targetDescription || step.summary || `步骤 ${step.seq}`}
                  {step.status !== 'succeeded' && step.status !== 'running'
                    ? `（${step.status}）`
                    : ''}
                </summary>
                <span>
                  步骤 #{step.seq} · {step.toolName} · {step.status}
                </span>
                {step.summary && step.summary !== step.targetDescription && (
                  <p>{step.summary}</p>
                )}
                {step.finishedAt && <p>结束：{clock(step.finishedAt)}</p>}
                {step.regressionSource && (
                  <p>回归来源：步骤 {step.regressionSource.stepIndex + 1}</p>
                )}
                <p>关联截图/证据：{step.evidenceRefs.length} 项</p>
              </details>
            </div>
          </div>
        ))}
        {hasMore && (
          <p className="mo-log-note" role="status">
            步骤超过 {MAX_STEP_PAGES * 100}{' '}
            条或当前历史尚未追平；正在继续分页加载，不能据此判断执行已结束。
          </p>
        )}
      </div>
    </div>
  );
};
