import React from 'react';

interface PhaseProgressProps {
  currentPhase: string;
  status: string;
}

const PHASES = [
  { key: 'preflight', name: '1. 预检 (Preflight)' },
  { key: 'auth', name: '2. 认证 (Auth)' },
  { key: 'explore', name: '3. 探索 (Explore)' },
  { key: 'plan', name: '4. 计划 (Plan)' },
  { key: 'execute', name: '5. 执行 (Execute)' },
  { key: 'reproduce', name: '6. 复现 (Reproduce)' },
  { key: 'finalize', name: '7. 报告 (Finalize)' }
];

export const PhaseProgress: React.FC<PhaseProgressProps> = ({ currentPhase, status }) => {
  const currentIndex = PHASES.findIndex((p) => p.key === currentPhase.toLowerCase());
  const isTerminated = ['completed', 'cancelled', 'failed'].includes(status.toLowerCase());

  return (
    <div className="card" style={{ marginBottom: '16px', padding: '14px 18px' }} data-testid="phase-progress-bar">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-muted)' }}>
          运行生命周期阶段推进 (Phase Timeline)
        </span>
        <span style={{ fontSize: '0.8rem', color: 'var(--color-text-subtle)' }}>
          当前阶段: <strong>{currentPhase.toUpperCase()}</strong> ({status})
        </span>
      </div>

      <div className="phase-bar">
        {PHASES.map((p, idx) => {
          let stateClass = '';
          if (isTerminated || idx < currentIndex) {
            stateClass = 'completed';
          } else if (idx === currentIndex) {
            stateClass = 'active';
          }

          return (
            <div
              key={p.key}
              className={`phase-item ${stateClass}`}
              data-testid={`phase-step-${p.key}`}
            >
              <span>{p.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
