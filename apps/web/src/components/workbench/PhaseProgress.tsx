import React from 'react';

export interface PhaseStepState {
  key: string;
  name: string;
  stateClass: 'completed' | 'active' | 'failed' | 'cancelled' | 'skipped' | '';
  isCompleted: boolean;
  label: string;
}

export interface PhaseProgressProps {
  currentPhase: string;
  status: string;
  executionMode?: 'smoke' | 'regression';
  terminationPhase?: string;
}

export const PHASES = [
  { key: 'preflight', name: '1. 预检 (Preflight)' },
  { key: 'auth', name: '2. 认证 (Auth)' },
  { key: 'explore', name: '3. 探索 (Explore)' },
  { key: 'plan', name: '4. 计划 (Plan)' },
  { key: 'execute', name: '5. 执行 (Execute)' },
  { key: 'reproduce', name: '6. 复现 (Reproduce)' },
  { key: 'finalize', name: '7. 报告 (Finalize)' },
];

/**
 * Pure helper to compute phase states according to actual execution and termination.
 * Guarantees:
 * - When status is cancelled/failed, phases subsequent to the termination phase are NEVER marked completed.
 * - In regression mode, explore and plan phases are skipped and NEVER claimed as completed.
 * - When queued, zero phases are marked active or completed.
 */
export function computePhaseTimeline({
  currentPhase = '',
  status = '',
  executionMode = 'smoke',
  terminationPhase,
}: {
  currentPhase?: string;
  status?: string;
  executionMode?: 'smoke' | 'regression';
  terminationPhase?: string;
}): PhaseStepState[] {
  const normStatus = (status || '').toLowerCase();
  const normPhase = (
    ['failed', 'cancelled', 'interrupted'].includes(normStatus)
      ? (terminationPhase ?? (currentPhase === 'finalize' ? '' : currentPhase))
      : currentPhase || ''
  ).toLowerCase();
  const isQueued = normStatus === 'queued';
  const isFailed = normStatus === 'failed';
  const isCancelled =
    normStatus === 'cancelled' || normStatus === 'interrupted';
  const isCompleted = normStatus === 'completed';
  const isRegression = executionMode === 'regression';

  const currentIndex = isQueued
    ? -1
    : PHASES.findIndex((p) => p.key === normPhase);

  return PHASES.map((p, idx) => {
    const isRegressionSkipped =
      isRegression && (p.key === 'explore' || p.key === 'plan');

    let stateClass:
      'completed' | 'active' | 'failed' | 'cancelled' | 'skipped' | '';
    let isPhaseCompleted: boolean;

    if (isQueued) {
      // Queued: no phases started
      stateClass = '';
      isPhaseCompleted = false;
    } else if (isRegressionSkipped) {
      // In regression mode, exploration and planning are skipped (approved cases used directly)
      stateClass = 'skipped';
      isPhaseCompleted = false;
    } else if (isCompleted) {
      // Completed run: all non-skipped phases are completed
      stateClass = 'completed';
      isPhaseCompleted = true;
    } else if (currentIndex === -1) {
      stateClass = '';
      isPhaseCompleted = false;
    } else if (idx < currentIndex) {
      // Executed prior phases
      stateClass = 'completed';
      isPhaseCompleted = true;
    } else if (idx === currentIndex) {
      // Terminating or active phase
      if (isFailed) {
        stateClass = 'failed';
        isPhaseCompleted = false;
      } else if (isCancelled) {
        stateClass = 'cancelled';
        isPhaseCompleted = false;
      } else {
        stateClass = 'active';
        isPhaseCompleted = false;
      }
    } else {
      // Subsequent unreached phases: NEVER completed when cancelled, failed, or running
      stateClass = '';
      isPhaseCompleted = false;
    }

    const displayName = isRegressionSkipped ? `${p.name} [跳过]` : p.name;

    return {
      key: p.key,
      name: displayName,
      stateClass,
      isCompleted: isPhaseCompleted,
      label: p.name,
    };
  });
}

// "1. 预检 (Preflight)" → "预检"
const shortName = (name: string) =>
  name.replace(/^\d+\.\s*/, '').replace(/\s*\(.*\)$/, '');

export const PhaseProgress: React.FC<PhaseProgressProps> = ({
  currentPhase,
  status,
  executionMode = 'smoke',
  terminationPhase,
}) => {
  const isQueued = status.toLowerCase() === 'queued';
  const timeline = computePhaseTimeline({
    currentPhase,
    status,
    executionMode,
    terminationPhase,
  });
  const terminated = ['failed', 'cancelled', 'interrupted'].includes(
    status.toLowerCase(),
  );
  const displayedPhase = terminated
    ? (terminationPhase ?? (currentPhase === 'finalize' ? '' : currentPhase))
    : currentPhase;
  const current = PHASES.find((p) => p.key === displayedPhase.toLowerCase());

  return (
    <section className="card lqa-phase-card" data-testid="phase-progress-bar">
      <div className="lqa-phase-header">
        <span className="card-title">运行阶段</span>
        <span className="text-xs muted">
          {terminated ? '终止阶段：' : '当前：'}
          <strong>
            {isQueued
              ? '排队等待 Worker'
              : current
                ? shortName(current.name)
                : displayedPhase || '待确认'}
          </strong>
          {executionMode === 'regression' ? ' · 回归模式' : ''}
        </span>
      </div>

      <ol className="phase-bar">
        {timeline.map((p, index) => (
          <li
            key={p.key}
            className={`phase-item ${p.stateClass}`.trim()}
            data-testid={`phase-step-${p.key}`}
            data-phase-completed={p.isCompleted}
            data-phase-state={p.stateClass || 'pending'}
            title={p.name}
          >
            <span className="phase-index">
              {p.stateClass === 'completed' ? '✓' : index + 1}
            </span>
            <span>{shortName(p.label)}</span>
            {p.stateClass === 'skipped' && (
              <span className="phase-note">跳过</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};
