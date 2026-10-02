import React, { useState } from 'react';
import type { Run } from '@localqa/contracts';
import { StatusBadge } from '../ui/Badge.tsx';

interface RunHistoryListProps {
  runs: Run[];
  activeRunId: string;
  onSelectRun: (runId: string) => void;
}

export const RunHistoryList: React.FC<RunHistoryListProps> = ({ runs, activeRunId, onSelectRun }) => {
  const [filter, setFilter] = useState<'all' | 'running' | 'completed'>('all');

  const filtered = runs.filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'running') return ['running', 'awaiting_input', 'queued'].includes(r.status);
    if (filter === 'completed') return ['completed', 'cancelled', 'failed'].includes(r.status);
    return true;
  });

  return (
    <div
      className="card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: '16px',
        overflow: 'hidden'
      }}
      data-testid="run-history-panel"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 600 }}>运行历史 (Runs)</h3>
        <select
          className="form-select"
          style={{ width: 'auto', padding: '2px 8px', fontSize: '0.75rem' }}
          value={filter}
          onChange={(e) => setFilter(e.target.value as 'all' | 'running' | 'completed')}
          data-testid="run-history-filter"
        >
          <option value="all">全部状态</option>
          <option value="running">活跃中</option>
          <option value="completed">已结束</option>
        </select>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {filtered.map((r) => {
          const isSelected = r.id === activeRunId;
          return (
            <div
              key={r.id}
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border-subtle)'}`,
                backgroundColor: isSelected ? 'var(--color-primary-subtle)' : 'var(--color-bg-surface)',
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
              onClick={() => onSelectRun(r.id)}
              data-testid={`history-item-${r.id}`}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-subtle)' }}>
                  {r.id.slice(0, 16)}...
                </span>
                <StatusBadge status={r.completion === 'partial' ? 'partial' : r.status} size="sm" />
              </div>
              <div
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--color-text-main)',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
              >
                {r.targetUrl}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                {new Date(r.createdAt).toLocaleTimeString()}
                {r.budgetUsed && ` · ${r.budgetUsed.actions} 动作 / ${r.budgetUsed.modelCalls} 模型调用`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
