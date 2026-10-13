import React, { useEffect, useState } from 'react';
import type { Run } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { useApp } from '../../state/AppContext.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';
import {
  isRunActive,
  relativeTime,
  sessionStatusLabel,
  sessionStatusMeta,
  sessionTitle,
} from '../sessions/sessionMeta.ts';

type Filter = 'all' | 'active' | 'finished';

const POLL_MS = 15000;

/**
 * Sidebar list of the current project's runs, like Mo's "My sessions". It
 * reloads on navigation and, while a run is still active, every few seconds.
 */
export const RecentRuns: React.FC<{ onNavigate: () => void }> = ({
  onNavigate,
}) => {
  const { currentProject, currentRoute, routeParams, setRoute } = useApp();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const projectId = currentProject?.id;
  const anyActive = runs?.some(isRunActive) ?? false;

  useEffect(() => {
    if (!projectId) {
      setRuns(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      defaultApiClient
        .listRuns(projectId)
        .then((page) => {
          if (cancelled) return;
          setRuns(page.items);
          setHasMore(Boolean(page.nextCursor));
        })
        .catch(() => {
          if (!cancelled) setRuns((previous) => previous ?? []);
        });
    void load();
    const timer = anyActive ? window.setInterval(load, POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [projectId, currentRoute, routeParams.runId, anyActive]);

  if (!projectId) return null;

  const visible = (runs ?? []).filter((run) =>
    filter === 'all'
      ? true
      : filter === 'active'
        ? isRunActive(run)
        : !isRunActive(run),
  );

  return (
    <section
      className="lqa-recent-runs"
      aria-label="会话记录"
      data-testid="sidebar-runs"
    >
      <div className="lqa-recent-runs-head">
        <span>会话</span>
        <select
          className="lqa-recent-runs-filter"
          aria-label="按状态筛选会话"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          data-testid="sidebar-runs-filter"
        >
          <option value="all">全部</option>
          <option value="active">进行中</option>
          <option value="finished">已结束</option>
        </select>
      </div>
      {runs === null ? (
        <p className="lqa-recent-runs-empty">正在读取…</p>
      ) : visible.length === 0 ? (
        <p className="lqa-recent-runs-empty">
          {runs.length === 0 ? '还没有会话' : '没有符合条件的会话'}
        </p>
      ) : (
        <ul>
          {visible.map((run) => {
            const meta = sessionStatusMeta[run.status];
            const active =
              currentRoute === 'workbench' && routeParams.runId === run.id;
            return (
              <li key={run.id}>
                <button
                  type="button"
                  className={`lqa-recent-run ${active ? 'is-active' : ''}`}
                  aria-current={active ? 'true' : undefined}
                  title={`${run.targetUrl}\n${run.id}`}
                  onClick={() => {
                    onNavigate();
                    setRoute('workbench', { runId: run.id });
                  }}
                  data-testid={`history-item-${run.id}`}
                >
                  <AppIcon
                    name={meta.icon}
                    size={15}
                    className={`lqa-recent-run-icon is-${meta.tone}`}
                  />
                  <span className="lqa-recent-run-text">
                    <span className="lqa-recent-run-title">
                      {sessionTitle(run)}
                    </span>
                    <span className="lqa-recent-run-meta">
                      <span className={`is-${meta.tone}`}>
                        {sessionStatusLabel(run)}
                      </span>
                      <span>{relativeTime(run.createdAt)}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {runs.length > 0 && (
            <li className="lqa-recent-runs-end">
              {hasMore ? '仅显示最近的会话' : '已显示全部会话'}
            </li>
          )}
        </ul>
      )}
    </section>
  );
};
