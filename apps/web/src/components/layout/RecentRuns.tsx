import React, { useEffect, useState } from 'react';
import type { Run } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { useApp } from '../../state/AppContext.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';
import { Modal } from '../ui/Modal.tsx';
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
  const { currentProject, currentUser, currentRoute, routeParams, setRoute } =
    useApp();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [canDelete, setCanDelete] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleteNotice, setDeleteNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const projectId = currentProject?.id;
  const anyActive = runs?.some(isRunActive) ?? false;

  useEffect(() => {
    setRuns(null);
    setSelectedIds([]);
    setSelecting(false);
    setConfirmIds(null);
    setDeleteError('');
    setDeleteNotice('');
  }, [projectId]);

  // Same owner/admin affordance as Workbench. Every deletion still requires
  // independent server-side permission, version and terminal-state checks.
  useEffect(() => {
    let cancelled = false;
    setCanDelete(currentUser?.globalRole === 'admin');
    if (projectId && currentUser && currentUser.globalRole !== 'admin') {
      void defaultApiClient
        .listMembers(projectId, { limit: 100 })
        .then((page) => {
          if (!cancelled)
            setCanDelete(
              page.items.some(
                (member) =>
                  member.userId === currentUser.id && member.role === 'owner',
              ),
            );
        })
        .catch(() => {
          if (!cancelled) setCanDelete(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [projectId, currentUser?.id, currentUser?.globalRole]);

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
          setSelectedIds((ids) =>
            ids.filter((id) =>
              page.items.some((run) => run.id === id && !isRunActive(run)),
            ),
          );
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
  }, [projectId, currentRoute, routeParams.runId, anyActive, refreshKey]);

  if (!projectId) return null;

  const visible = (runs ?? []).filter((run) =>
    filter === 'all'
      ? true
      : filter === 'active'
        ? isRunActive(run)
        : !isRunActive(run),
  );
  const eligible = visible.filter((run) => !isRunActive(run));
  const selectedEligible = eligible.filter((run) =>
    selectedIds.includes(run.id),
  );
  const allVisibleSelected =
    eligible.length > 0 &&
    eligible.every((run) => selectedIds.includes(run.id));
  const confirmingRuns = (runs ?? []).filter((run) =>
    confirmIds?.includes(run.id),
  );

  const confirmDeletion = async () => {
    if (!canDelete || deleting || !runs || !confirmIds?.length) return;
    const targets = runs.filter((run) => confirmIds.includes(run.id));
    if (targets.length !== confirmIds.length || targets.some(isRunActive)) {
      setDeleteError('会话状态已变化，请刷新后重新选择。');
      return;
    }
    setDeleting(true);
    setDeleteError('');
    setDeleteNotice('');
    const removed: string[] = [];
    const errors: string[] = [];
    // Reuse the audited tombstone API; every version is validated separately.
    for (const run of targets) {
      try {
        await defaultApiClient.deleteRun(run.id, {
          expectedVersion: run.version,
          confirmRunId: run.id,
        });
        removed.push(run.id);
      } catch (error) {
        errors.push(
          `${sessionTitle(run)}：${error instanceof Error ? error.message : '删除失败'}`,
        );
      }
    }
    setRuns(
      (previous) =>
        previous?.filter((run) => !removed.includes(run.id)) ?? null,
    );
    setSelectedIds((ids) => ids.filter((id) => !removed.includes(id)));
    setConfirmIds(null);
    setDeleting(false);
    if (
      currentRoute === 'workbench' &&
      routeParams.runId &&
      removed.includes(routeParams.runId)
    )
      setRoute('sessions');
    if (errors.length) {
      setDeleteError(
        `已删除 ${removed.length} 条，失败 ${errors.length} 条。${errors.slice(0, 2).join('；')}`,
      );
    } else {
      setDeleteNotice(`已删除 ${removed.length} 条会话记录。`);
      if (selecting) {
        setSelecting(false);
        setSelectedIds([]);
      }
    }
    setRefreshKey((key) => key + 1);
  };

  return (
    <section
      className="lqa-recent-runs"
      aria-label="会话记录"
      data-testid="sidebar-runs"
    >
      <div className="lqa-recent-runs-head">
        <span>会话</span>
        <div className="lqa-recent-runs-head-actions">
          {canDelete && (
            <button
              type="button"
              className="lqa-recent-runs-action"
              aria-pressed={selecting}
              disabled={deleting}
              onClick={() => {
                setSelecting((value) => !value);
                setSelectedIds([]);
                setDeleteError('');
                setDeleteNotice('');
              }}
              data-testid="sidebar-runs-bulk-toggle"
            >
              {selecting ? '取消选择' : '批量删除'}
            </button>
          )}
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
      </div>
      {selecting && (
        <div
          className="lqa-recent-runs-bulk"
          data-testid="sidebar-runs-bulk-toolbar"
        >
          <label className="lqa-recent-runs-select-all">
            <input
              type="checkbox"
              aria-label="全选当前列表中已结束的会话"
              checked={allVisibleSelected}
              disabled={eligible.length === 0 || deleting}
              onChange={(event) => {
                const visibleIds = new Set(eligible.map((run) => run.id));
                setSelectedIds((ids) =>
                  event.target.checked
                    ? [...new Set([...ids, ...visibleIds])]
                    : ids.filter((id) => !visibleIds.has(id)),
                );
              }}
              data-testid="sidebar-runs-select-all"
            />
            全选
          </label>
          <button
            type="button"
            className="lqa-recent-runs-danger"
            disabled={selectedEligible.length === 0 || deleting}
            onClick={() => {
              setDeleteError('');
              setConfirmIds(selectedEligible.map((run) => run.id));
            }}
            data-testid="sidebar-runs-delete-selected"
          >
            删除已选（{selectedEligible.length}）
          </button>
        </div>
      )}
      {deleteNotice && (
        <p role="status" className="lqa-recent-runs-feedback">
          {deleteNotice}
        </p>
      )}
      {deleteError && (
        <p role="alert" className="lqa-recent-runs-feedback is-error">
          {deleteError}
        </p>
      )}
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
            const finished = !isRunActive(run);
            return (
              <li key={run.id} className="lqa-recent-run-row">
                {selecting && (
                  <input
                    type="checkbox"
                    className="lqa-recent-run-checkbox"
                    checked={selectedIds.includes(run.id)}
                    disabled={!finished || deleting}
                    aria-label={`选择会话：${sessionTitle(run)}`}
                    title={finished ? '选择此会话' : '进行中的会话不可删除'}
                    onChange={(event) =>
                      setSelectedIds((ids) =>
                        event.target.checked
                          ? [...new Set([...ids, run.id])]
                          : ids.filter((id) => id !== run.id),
                      )
                    }
                    data-testid={`sidebar-runs-select-${run.id}`}
                  />
                )}
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
                {canDelete && !selecting && finished && (
                  <button
                    type="button"
                    className="lqa-recent-run-delete"
                    aria-label={`删除会话：${sessionTitle(run)}`}
                    title="删除会话"
                    onClick={() => {
                      setDeleteError('');
                      setConfirmIds([run.id]);
                    }}
                    data-testid={`sidebar-runs-delete-${run.id}`}
                  >
                    <AppIcon name="trash" size={15} />
                  </button>
                )}
              </li>
            );
          })}
          {runs.length > 0 && (
            <li className="lqa-recent-runs-end">
              {hasMore
                ? '仅显示最近的会话；批量操作只作用于当前显示的记录'
                : '已显示全部会话'}
            </li>
          )}
        </ul>
      )}
      {confirmIds && (
        <Modal
          title={confirmIds.length === 1 ? '删除会话' : '批量删除会话'}
          testId="sidebar-runs-delete-dialog"
          closeOnOverlay={!deleting}
          onClose={() => {
            if (!deleting) setConfirmIds(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deleting}
                onClick={() => setConfirmIds(null)}
                data-testid="sidebar-runs-delete-cancel"
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={
                  deleting || confirmingRuns.length !== confirmIds.length
                }
                onClick={() => void confirmDeletion()}
                data-testid="sidebar-runs-delete-confirm"
              >
                {deleting ? '删除中…' : `确认删除 ${confirmIds.length} 条`}
              </button>
            </>
          }
        >
          <p>
            确认删除 {confirmIds.length} 条已结束的会话记录？
            删除后会话和报告不再展示，但已保存用例及审计记录仍保留。
          </p>
          {confirmIds.length === 1 && confirmingRuns[0] && (
            <p className="text-sm">
              <code>{confirmingRuns[0].id}</code>
            </p>
          )}
          {hasMore && confirmIds.length > 1 && (
            <p className="text-sm">本次仅删除当前列表中选中的记录。</p>
          )}
          {deleteError && <p role="alert">{deleteError}</p>}
        </Modal>
      )}
    </section>
  );
};
