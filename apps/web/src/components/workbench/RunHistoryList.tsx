import React, { useState } from 'react';
import type { Run } from '@localqa/contracts';
import { StatusBadge } from '../ui/Badge.tsx';

interface RunHistoryListProps {
  runs: Run[];
  activeRunId: string;
  onSelectRun: (runId: string) => void;
}

export const RunHistoryList: React.FC<RunHistoryListProps> = ({
  runs,
  activeRunId,
  onSelectRun,
}) => {
  const [filter, setFilter] = useState<'all' | 'running' | 'completed'>('all');

  const filtered = runs.filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'running')
      return ['running', 'awaiting_input', 'queued'].includes(r.status);
    if (filter === 'completed')
      return ['completed', 'cancelled', 'failed'].includes(r.status);
    return true;
  });

  return (
    <section
      className="card workbench-column lqa-run-history"
      data-testid="run-history-panel"
    >
      <div className="lqa-run-history-header">
        <h3 className="card-title">运行历史</h3>
        <select
          className="form-select lqa-compact-select"
          aria-label="按状态筛选运行"
          value={filter}
          onChange={(e) =>
            setFilter(e.target.value as 'all' | 'running' | 'completed')
          }
          data-testid="run-history-filter"
        >
          <option value="all">全部</option>
          <option value="running">进行中</option>
          <option value="completed">已结束</option>
        </select>
      </div>

      <div className="lqa-run-history-list">
        {filtered.length === 0 && (
          <p className="muted text-sm lqa-run-history-empty">
            没有符合条件的运行。
          </p>
        )}
        {filtered.map((r) => {
          const isSelected = r.id === activeRunId;
          return (
            <button
              type="button"
              key={r.id}
              className={`lqa-run-item ${isSelected ? 'is-active' : ''}`}
              aria-current={isSelected ? 'true' : undefined}
              onClick={() => onSelectRun(r.id)}
              data-testid={`history-item-${r.id}`}
            >
              <span className="lqa-run-item-top">
                <span className="lqa-run-item-id" title={r.id}>
                  {r.id}
                </span>
                <StatusBadge
                  status={r.completion === 'partial' ? 'partial' : r.status}
                  size="sm"
                />
              </span>
              <span className="lqa-run-item-url" title={r.targetUrl}>
                {r.targetUrl}
              </span>
              <span className="lqa-run-item-meta">
                {new Date(r.createdAt).toLocaleTimeString()}
                {r.budgetUsed &&
                  ` · ${r.budgetUsed.actions} 动作 · ${r.budgetUsed.modelCalls} 次模型调用`}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};
