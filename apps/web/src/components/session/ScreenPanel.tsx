import React, { useEffect, useMemo, useState } from 'react';
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

/** Steps of one agent, re-read every few seconds while it is running. */
export function useTaskSteps(taskId: string | null, active: boolean) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    let history: TaskStepHistory | undefined;
    setSteps([]);
    setError('');
    setHasMore(false);
    if (!taskId) return;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
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
      }
    };
    void load();
    // Finished long runs still need to drain historical pages past the
    // bounded initial load. Once caught up, stop polling completed tasks.
    const timer = window.setInterval(() => {
      if (active || history?.hasMore) void load();
    }, 2500);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
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

/**
 * Mo's screen, from what the worker actually captured: screenshots stepped
 * through like a replay, with each step's type and time. It is not a video.
 */
export const ScreenPanel: React.FC<{
  task: Task | null;
  live: boolean;
  targetUrl: string;
}> = ({ task, live, targetUrl }) => {
  const { steps, error, hasMore } = useTaskSteps(task?.id ?? null, live);
  const frames = useMemo(
    () => steps.filter((step) => step.evidenceRefs.length > 0),
    [steps],
  );
  const [index, setIndex] = useState<number | null>(null);
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
        <p>采集到的截图，按步骤回放；不是实时视频。</p>
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
          {frame ? (
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
