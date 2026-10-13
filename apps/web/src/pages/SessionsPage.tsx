import React, { useEffect, useMemo, useState } from 'react';
import type { Run } from '@localqa/contracts';
import { defaultApiClient } from '../api/index.ts';
import { useApp } from '../state/AppContext.tsx';
import { Page } from '../components/layout/Page.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import {
  isRunActive,
  runStats,
  relativeTime,
  sessionStatusLabel,
  sessionStatusMeta,
  sessionTitle,
} from '../components/sessions/sessionMeta.ts';

type StatusFilter =
  'all' | 'needs-you' | 'running' | 'review' | 'bugs' | 'unfinished';

const filters: {
  key: StatusFilter;
  label: string;
  match: (run: Run) => boolean;
}[] = [
  { key: 'all', label: '全部', match: () => true },
  {
    key: 'needs-you',
    label: '等你回复',
    match: (run) => run.status === 'awaiting_input',
  },
  {
    key: 'running',
    label: '运行中',
    match: (run) => isRunActive(run) && run.status !== 'awaiting_input',
  },
  {
    key: 'review',
    label: '待查看',
    match: (run) => run.status === 'completed',
  },
  {
    key: 'unfinished',
    label: '未完成',
    match: (run) => run.status === 'failed' || run.status === 'cancelled',
  },
];

/** Passed of all cases as Mo's "1/1" bar, plus bugs when there are any. */
const SessionProgress: React.FC<{ run: Run }> = ({ run }) => {
  const stats = runStats(run);
  if (!stats || stats.cases === 0) return <span />;
  return (
    <span
      className="mo-session-progress"
      title={`通过 ${stats.passed} / 共 ${stats.cases} 个用例${stats.findings ? `，${stats.findings} 个缺陷` : ''}`}
    >
      <span className="mo-mono">
        {stats.passed}/{stats.cases}
      </span>
      <span className="mo-progress-bar">
        <span
          className={stats.issues > 0 ? 'is-issue' : ''}
          style={{
            width: `${Math.round((stats.passed / stats.cases) * 100)}%`,
          }}
        />
      </span>
      {stats.findings > 0 && (
        <span className="mo-session-bugs">{stats.findings} 缺陷</span>
      )}
    </span>
  );
};

/** Mo's Sessions page: every run of the project, searchable and filtered by
 * what it needs from you. */
export const SessionsPage: React.FC = () => {
  const { currentProject, currentUser, setRoute } = useApp();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState<'anyone' | 'me'>('anyone');
  const [status, setStatus] = useState<StatusFilter>('all');
  const projectId = currentProject?.id;

  useEffect(() => {
    setRuns(null);
    setCursor(null);
    setError('');
    if (!projectId) return;
    let cancelled = false;
    defaultApiClient
      .listRuns({ projectId, limit: 100 })
      .then((page) => {
        if (cancelled) return;
        setRuns(page.items);
        setCursor(page.nextCursor ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setRuns([]);
          setError('会话读取失败，请刷新后重试');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const loadMore = async () => {
    if (!projectId || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await defaultApiClient.listRuns({
        projectId,
        limit: 100,
        cursor,
      });
      setRuns((old) => [
        ...(old ?? []),
        ...page.items.filter((run) => !old?.some((item) => item.id === run.id)),
      ]);
      setCursor(page.nextCursor ?? null);
    } catch {
      setError('更多会话读取失败，请重试');
    } finally {
      setLoadingMore(false);
    }
  };

  const ownerRuns = useMemo(
    () =>
      (runs ?? []).filter(
        (run) => owner === 'anyone' || run.creatorId === currentUser?.id,
      ),
    [runs, owner, currentUser?.id],
  );
  const needle = query.trim().toLowerCase();
  const visible = ownerRuns.filter(
    (run) =>
      filters.find((item) => item.key === status)!.match(run) &&
      (!needle ||
        sessionTitle(run).toLowerCase().includes(needle) ||
        run.targetUrl.toLowerCase().includes(needle) ||
        run.id.startsWith(needle)),
  );

  return (
    <Page testId="sessions-page" title="会话" width="wide">
      {!currentProject ? (
        <EmptyState icon="folder" title="请先选择或创建项目" />
      ) : (
        <>
          <div className="mo-list-toolbar">
            <label className="mo-search">
              <AppIcon name="search" size={15} />
              <input
                type="search"
                placeholder="搜索会话…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                data-testid="sessions-search"
              />
            </label>
            <label className="mo-filter-chip">
              <AppIcon name="users" size={14} />
              <span>创建人</span>
              <span className="mo-filter-chip-op">是</span>
              <select
                value={owner}
                onChange={(event) =>
                  setOwner(event.target.value as 'anyone' | 'me')
                }
                aria-label="按创建人筛选"
                data-testid="sessions-owner-filter"
              >
                <option value="anyone">任何人</option>
                <option value="me">我</option>
              </select>
            </label>
          </div>
          <div className="segmented mo-status-tabs" role="tablist">
            {filters
              .filter(
                (item) =>
                  item.key !== 'bugs' ||
                  (runs ?? []).some((run) => runStats(run) !== null),
              )
              .map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={status === item.key}
                  className={status === item.key ? 'is-active' : ''}
                  onClick={() => setStatus(item.key)}
                  data-testid={`sessions-filter-${item.key}`}
                >
                  {item.label}
                </button>
              ))}
          </div>
          {error && (
            <Alert tone="danger" role="alert">
              {error}
            </Alert>
          )}
          {runs === null ? (
            <p className="muted text-sm">正在读取会话…</p>
          ) : runs.length === 0 ? (
            <EmptyState
              icon="activity"
              title="还没有会话"
              description="新建一个会话，告诉 AI 要测试哪个流程。"
              actionText="新建会话"
              onAction={() => setRoute('home')}
            />
          ) : (
            <>
              <ul className="mo-session-list" data-testid="sessions-list">
                {visible.map((run) => {
                  const meta = sessionStatusMeta[run.status];
                  return (
                    <li key={run.id}>
                      <button
                        type="button"
                        className="mo-session-row"
                        onClick={() => setRoute('workbench', { runId: run.id })}
                        title={`${run.targetUrl}\n${run.id}`}
                        data-testid={`session-row-${run.id}`}
                      >
                        <AppIcon
                          name={meta.icon}
                          size={16}
                          className={`mo-status-icon is-${meta.tone}`}
                        />
                        <span className="mo-session-title">
                          {sessionTitle(run)}
                        </span>
                        <span className={`mo-session-status is-${meta.tone}`}>
                          {sessionStatusLabel(run)}
                        </span>
                        <SessionProgress run={run} />
                        <span className="mo-session-time">
                          {relativeTime(run.createdAt)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mo-list-count">
                {visible.length === ownerRuns.length
                  ? `${visible.length} 个会话`
                  : `${visible.length} / ${ownerRuns.length} 个会话`}
              </p>
              {cursor && (
                <div className="mo-list-more">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore ? '读取中…' : '加载更多'}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Page>
  );
};
