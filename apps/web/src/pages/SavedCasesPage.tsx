import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { SavedCase, SavedCaseVersion } from '../api/types.ts';
import type { Member } from '@localqa/contracts';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { ErrorCard } from '../components/ui/ErrorCard.tsx';
import { Section } from '../components/ui/Section.tsx';
import { Field } from '../components/ui/Field.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { RegressionRunModal } from '../components/saved-cases/RegressionRunModal.tsx';
import { SavedCaseYamlImportModal } from '../components/saved-cases/SavedCaseYamlImportModal.tsx';
import { SavedCaseDuplicateModal } from '../components/saved-cases/SavedCaseDuplicateModal.tsx';
import { LifecycleScopeGuard } from '../utils/lifecycleScope.ts';
import { isSameProjectId } from '../utils/moduleRoles.ts';
import { fetchSavedCaseVersionsAcrossPages } from '../utils/savedCaseVersionPagination.ts';

export const SavedCasesPage: React.FC = () => {
  const {
    currentProject,
    currentUser,
    projects,
    setCurrentProject,
    setRoute,
    isMock,
  } = useApp();
  const [cases, setCases] = useState<SavedCase[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [versionsMap, setVersionsMap] = useState<
    Record<string, SavedCaseVersion[]>
  >({});
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters: default 'active'
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'active' | 'archived' | 'all'
  >('active');

  // Action busy states per case: { [caseId]: 'archiving' | 'restoring' }
  const [actionLoadingMap, setActionLoadingMap] = useState<
    Record<string, 'archiving' | 'restoring'>
  >({});

  // Duplicate Modal state
  const [duplicateTargetCase, setDuplicateTargetCase] =
    useState<SavedCase | null>(null);

  // Regression Selection
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [regressionModalOpen, setRegressionModalOpen] = useState(false);
  const [modalTargetCases, setModalTargetCases] = useState<
    {
      caseId: string;
      caseName: string;
      versionId: string;
      versionNum: number;
    }[]
  >([]);

  // New Case Creation
  const [creatingCase, setCreatingCase] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [newName, setNewName] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  // YAML Import Modal
  const [yamlImportOpen, setYamlImportOpen] = useState(false);

  // Scope guard ref
  const scopeGuardRef = useRef(new LifecycleScopeGuard());

  // Compute role permissions
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const isOwnerOrOperator =
    currentMember?.role === 'owner' ||
    currentMember?.role === 'operator' ||
    currentUser?.globalRole === 'admin';
  const isReadOnly = !isOwnerOrOperator;

  const fetchCases = useCallback(async () => {
    if (!currentProject) return;
    const scopeContext = { projectId: currentProject.id, statusFilter };
    const { isValid } = scopeGuardRef.current.startRequest(scopeContext);
    setLoading(true);
    setError(null);
    try {
      const [res, membersRes] = await Promise.all([
        defaultApiClient.listSavedCases(currentProject.id, {
          status: statusFilter,
          limit: 20,
        }),
        defaultApiClient
          .listMembers(currentProject.id)
          .catch(() => ({ items: [] })),
      ]);
      if (!isValid()) return;
      setCases(res.items);
      setNextCursor(res.nextCursor || null);
      setMembers(membersRes.items);

      // Concurrently load versions for each case so we can inspect approved versions
      const vMap: Record<string, SavedCaseVersion[]> = {};
      await Promise.all(
        res.items.map(async (c) => {
          vMap[c.id] = await fetchSavedCaseVersionsAcrossPages(
            defaultApiClient,
            c.id,
          );
        }),
      );
      if (!isValid()) return;
      setVersionsMap(vMap);
    } catch (err) {
      if (!isValid()) return;
      setError(err instanceof Error ? err.message : '加载用例库列表失败');
    } finally {
      if (isValid()) {
        setLoading(false);
      }
    }
  }, [currentProject?.id, statusFilter]);

  const loadMoreCases = async () => {
    if (!currentProject || !nextCursor || loadingMore || loading) return;
    const scopeContext = { projectId: currentProject.id, statusFilter };
    const lifecycleToken = scopeGuardRef.current.captureScope(scopeContext);
    const readToken = scopeGuardRef.current.startRequest(scopeContext);
    setLoadingMore(true);
    setError(null);
    try {
      const res = await defaultApiClient.listSavedCases(currentProject.id, {
        status: statusFilter,
        cursor: nextCursor,
        limit: 20,
      });
      if (!readToken.isValid()) return;
      setCases((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor || null);

      const vMap: Record<string, SavedCaseVersion[]> = {};
      await Promise.all(
        res.items.map(async (c) => {
          vMap[c.id] = await fetchSavedCaseVersionsAcrossPages(
            defaultApiClient,
            c.id,
          );
        }),
      );
      if (!readToken.isValid()) return;
      setVersionsMap((prev) => ({ ...prev, ...vMap }));
    } catch (err) {
      if (!readToken.isValid()) return;
      setError(err instanceof Error ? err.message : '加载更多用例失败');
    } finally {
      if (lifecycleToken.isValid()) {
        setLoadingMore(false);
      }
    }
  };

  // Project switch & scope reset effect
  useEffect(() => {
    scopeGuardRef.current.resetScope({
      projectId: currentProject?.id || '',
      statusFilter,
    });
    setCases([]);
    setNextCursor(null);
    setLoadingMore(false);
    setVersionsMap({});
    setMembers([]);
    setSelectedCaseIds([]);
    setActionLoadingMap({});
    setDuplicateTargetCase(null);
    setCreatingCase(false);
    setCreateLoading(false);
    setYamlImportOpen(false);
    setRegressionModalOpen(false);
    setError(null);

    if (currentProject) {
      fetchCases();
    } else {
      setLoading(false);
    }

    return () => {
      scopeGuardRef.current.resetScope(null);
      setLoadingMore(false);
      setCreateLoading(false);
      setActionLoadingMap({});
    };
  }, [currentProject?.id, statusFilter, fetchCases]);

  const filteredCases = cases.filter((c) => {
    const matchesSearch =
      !searchText ||
      c.name.toLowerCase().includes(searchText.toLowerCase()) ||
      c.slug.toLowerCase().includes(searchText.toLowerCase());
    return matchesSearch;
  });

  const handleToggleSelect = (caseId: string) => {
    setSelectedCaseIds((prev) =>
      prev.includes(caseId)
        ? prev.filter((id) => id !== caseId)
        : [...prev, caseId],
    );
  };

  const handleSelectAll = () => {
    const approvableIds = filteredCases
      .filter((c) => !!c.currentApprovedVersionId && c.status === 'active')
      .map((c) => c.id);
    if (selectedCaseIds.length === approvableIds.length) {
      setSelectedCaseIds([]);
    } else {
      setSelectedCaseIds(approvableIds);
    }
  };

  const handleStartBatchRegression = () => {
    const targets = selectedCaseIds
      .map((caseId) => {
        const c = cases.find((x) => x.id === caseId);
        if (!c || !c.currentApprovedVersionId) return null;
        const versions = versionsMap[caseId] || [];
        const approvedVer = versions.find(
          (v) => v.id === c.currentApprovedVersionId,
        );
        if (!approvedVer) return null;
        return {
          caseId: c.id,
          caseName: c.name,
          versionId: c.currentApprovedVersionId,
          versionNum: approvedVer.version,
        };
      })
      .filter(Boolean) as {
      caseId: string;
      caseName: string;
      versionId: string;
      versionNum: number;
    }[];

    if (targets.length === 0) return;
    setModalTargetCases(targets);
    setRegressionModalOpen(true);
  };

  const handleStartSingleRegression = (c: SavedCase) => {
    if (!c.currentApprovedVersionId || c.status !== 'active') return;
    const versions = versionsMap[c.id] || [];
    const approvedVer = versions.find(
      (v) => v.id === c.currentApprovedVersionId,
    );
    if (!approvedVer) {
      setError(`用例 ${c.slug} 的批准基线版本未找到，无法发起回归`);
      return;
    }
    setModalTargetCases([
      {
        caseId: c.id,
        caseName: c.name,
        versionId: c.currentApprovedVersionId,
        versionNum: approvedVer.version,
      },
    ]);
    setRegressionModalOpen(true);
  };

  const handleCreateCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentProject || !newSlug.trim() || !newName.trim() || isReadOnly)
      return;
    const scopeContext = { projectId: currentProject.id, statusFilter };
    const { isValid } = scopeGuardRef.current.captureScope(scopeContext);

    if (!isValid()) return;
    setCreateLoading(true);
    setError(null);
    try {
      const created = await defaultApiClient.createSavedCase(
        currentProject.id,
        {
          slug: newSlug.trim(),
          name: newName.trim(),
          document: {
            schemaVersion: 1,
            kind: 'localqa/test',
            id: newSlug.trim(),
            name: newName.trim(),
            variables: {},
            criteria: [
              {
                id: 'crit-01',
                kind: 'element_visible',
                description: '主容器渲染完成',
                sourceKind: 'saved_case',
                sourceRef: newSlug.trim(),
                locator: { by: 'css', value: '#app, body' },
              },
            ],
            steps: [
              { kind: 'navigate', url: 'http://localhost:8080/' },
              { kind: 'assert', criterionId: 'crit-01' },
            ],
            fixtureRefs: [],
          },
        },
      );
      if (!isValid()) return;
      setCreatingCase(false);
      setNewSlug('');
      setNewName('');
      await fetchCases();
      if (!isValid()) return;
      setRoute('saved-case-detail', { caseId: created.id });
    } catch (err) {
      if (!isValid()) return;
      setError(err instanceof Error ? err.message : '创建用例失败');
    } finally {
      if (isValid()) {
        setCreateLoading(false);
      }
    }
  };

  const handleArchiveCase = async (c: SavedCase) => {
    if (isReadOnly || !currentProject) return;
    const scopeContext = { projectId: currentProject.id, statusFilter };
    const { isValid } = scopeGuardRef.current.captureScope(scopeContext);

    if (!isValid()) return;
    setActionLoadingMap((prev) => ({ ...prev, [c.id]: 'archiving' }));
    setError(null);
    try {
      await defaultApiClient.archiveSavedCase(c.id, {
        expectedVersion: c.version,
      });
      if (!isValid()) return;
      await fetchCases();
    } catch (err) {
      if (!isValid()) return;
      setError(err instanceof Error ? err.message : `归档用例 ${c.slug} 失败`);
    } finally {
      if (isValid()) {
        setActionLoadingMap((prev) => {
          const next = { ...prev };
          delete next[c.id];
          return next;
        });
      }
    }
  };

  const handleRestoreCase = async (c: SavedCase) => {
    if (isReadOnly || !currentProject) return;
    const scopeContext = { projectId: currentProject.id, statusFilter };
    const { isValid } = scopeGuardRef.current.captureScope(scopeContext);

    if (!isValid()) return;
    setActionLoadingMap((prev) => ({ ...prev, [c.id]: 'restoring' }));
    setError(null);
    try {
      await defaultApiClient.restoreSavedCase(c.id, {
        expectedVersion: c.version,
      });
      if (!isValid()) return;
      await fetchCases();
    } catch (err) {
      if (!isValid()) return;
      setError(err instanceof Error ? err.message : `恢复用例 ${c.slug} 失败`);
    } finally {
      if (isValid()) {
        setActionLoadingMap((prev) => {
          const next = { ...prev };
          delete next[c.id];
          return next;
        });
      }
    }
  };

  return (
    <Page
      testId="saved-cases-page"
      width="wide"
      title={
        <>
          用例库
          {isMock && (
            <span
              className="badge badge-warning"
              data-testid="mock-indicator-badge"
            >
              演示数据
            </span>
          )}
        </>
      }
      description={
        <>
          {currentProject?.name || '未选项目'} ·
          管理已固化的测试用例、版本草稿与经过审查的回归基线。
        </>
      }
      actions={
        <>
          <button
            className="btn btn-secondary"
            onClick={() => setYamlImportOpen(true)}
            disabled={isReadOnly}
            title={isReadOnly ? '只读角色无法导入用例' : undefined}
            data-testid="btn-import-yaml-case"
          >
            <AppIcon name="upload" size={15} />
            导入 YAML
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setCreatingCase(true)}
            disabled={isReadOnly}
            title={isReadOnly ? '只读角色无法新建用例' : undefined}
            data-testid="btn-create-empty-case"
          >
            <AppIcon name="plus" size={15} />
            新建用例
          </button>
          <button
            className="btn btn-primary"
            disabled={selectedCaseIds.length === 0}
            onClick={handleStartBatchRegression}
            data-testid="btn-batch-regression-run"
          >
            <AppIcon name="play" size={14} />
            发起回归（{selectedCaseIds.length}）
          </button>
        </>
      }
    >
      {isReadOnly && (
        <Alert tone="info" testId="viewer-readonly-banner">
          当前账号为只读成员，可以查看用例与版本历史，但不能新建、复制、归档或恢复用例。
        </Alert>
      )}

      {error && <ErrorCard message={error} />}

      {creatingCase && (
        <Section
          title="新建测试用例"
          description="创建后会同时生成 v1 草稿，审查通过后才能用于回归。"
          testId="create-case-form"
          actions={
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setCreatingCase(false)}
            >
              取消
            </button>
          }
        >
          <form onSubmit={handleCreateCase} className="lqa-inline-form">
            <Field label="Slug（唯一标识）" required htmlFor="new-case-slug">
              <input
                id="new-case-slug"
                type="text"
                className="input"
                placeholder="例如 checkout-calc"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                required
                data-testid="input-new-case-slug"
              />
            </Field>
            <Field label="用例名称" required htmlFor="new-case-name">
              <input
                id="new-case-name"
                type="text"
                className="input"
                placeholder="例如 购物车优惠券抵扣结算与页面断言"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                data-testid="input-new-case-name"
              />
            </Field>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={createLoading || !newSlug.trim() || !newName.trim()}
              data-testid="btn-submit-create-case"
            >
              {createLoading ? '创建中...' : '确认创建'}
            </button>
          </form>
        </Section>
      )}

      <div>
        <div className="toolbar">
          <input
            type="search"
            className="input lqa-search-input"
            placeholder="搜索用例名称或 Slug"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            data-testid="input-search-saved-cases"
          />
          <div className="segmented" role="group" aria-label="按状态筛选">
            {(
              [
                ['active', '活跃'],
                ['archived', '已归档'],
                ['all', '全部'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={statusFilter === value ? 'is-active' : ''}
                aria-pressed={statusFilter === value}
                onClick={() => setStatusFilter(value)}
                data-testid={`filter-status-${value}`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="toolbar-meta">
            共 <strong>{filteredCases.length}</strong> 条 · 已选{' '}
            <strong>{selectedCaseIds.length}</strong> 条用于回归
          </span>
        </div>

        {loading ? (
          <div className="lqa-session-loading is-inline">
            正在加载用例库列表...
          </div>
        ) : filteredCases.length === 0 ? (
          <EmptyState
            icon="layers"
            title="暂无匹配的用例"
            description={
              statusFilter === 'archived'
                ? '当前项目下暂无已归档的测试用例。'
                : '可以点击右上角新建用例，或在运行工作台的用例详情中「保存到用例库」，把一次执行固化下来。'
            }
            actionText={statusFilter === 'archived' ? undefined : '新建用例'}
            onAction={
              statusFilter === 'archived'
                ? undefined
                : () => setCreatingCase(true)
            }
          />
        ) : (
          <div className="card card-flush">
            <div className="table-container">
              <table className="data-table" data-testid="saved-cases-table">
                <thead>
                  <tr>
                    <th className="cell-check">
                      <input
                        type="checkbox"
                        checked={
                          selectedCaseIds.length > 0 &&
                          selectedCaseIds.length ===
                            filteredCases.filter(
                              (c) =>
                                !!c.currentApprovedVersionId &&
                                c.status === 'active',
                            ).length
                        }
                        onChange={handleSelectAll}
                        title="全选所有具备已批准版本的活跃用例"
                        aria-label="全选可回归用例"
                        data-testid="checkbox-select-all"
                      />
                    </th>
                    <th>用例</th>
                    <th>回归基线</th>
                    <th>当前版本</th>
                    <th>状态</th>
                    <th>创建时间</th>
                    <th className="cell-actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCases.map((c) => {
                    const versions = versionsMap[c.id] || [];
                    const approvedVer = versions.find(
                      (v) => v.id === c.currentApprovedVersionId,
                    );
                    const isSelectable =
                      !!c.currentApprovedVersionId && c.status === 'active';
                    const isChecked = selectedCaseIds.includes(c.id);
                    const busyAction = actionLoadingMap[c.id];

                    return (
                      <tr
                        key={c.id}
                        className={`${isChecked ? 'is-selected' : ''} ${c.status === 'archived' ? 'is-archived' : ''}`}
                        data-testid={`case-row-${c.slug}`}
                      >
                        <td className="cell-check">
                          <input
                            type="checkbox"
                            disabled={!isSelectable}
                            checked={isChecked}
                            onChange={() => handleToggleSelect(c.id)}
                            title={
                              !isSelectable
                                ? '只有活跃且具备已批准版本的用例可用于回归'
                                : ''
                            }
                            aria-label={`选择 ${c.name}`}
                            data-testid={`checkbox-case-${c.slug}`}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-link cell-title"
                            onClick={() =>
                              setRoute('saved-case-detail', { caseId: c.id })
                            }
                          >
                            {c.name}
                          </button>
                          <div className="cell-sub mono">{c.slug}</div>
                        </td>
                        <td>
                          {approvedVer ? (
                            <span
                              className="badge badge-success"
                              data-testid={`approved-version-badge-${c.slug}`}
                            >
                              <AppIcon name="check" size={12} />v
                              {approvedVer.version} 已生效
                            </span>
                          ) : (
                            <span
                              className="badge badge-warning"
                              data-testid={`pending-approval-badge-${c.slug}`}
                            >
                              <AppIcon name="clock" size={12} />
                              草稿待审
                            </span>
                          )}
                        </td>
                        <td>
                          v{c.version}
                          <div className="cell-sub">
                            共 {versions.length} 个版本
                          </div>
                        </td>
                        <td>
                          <StatusBadge status={c.status} size="sm" />
                        </td>
                        <td className="muted nowrap">
                          {new Date(c.createdAt).toLocaleDateString()}
                        </td>
                        <td className="cell-actions">
                          {isSelectable && (
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleStartSingleRegression(c)}
                              data-testid={`btn-run-regression-${c.slug}`}
                              title="使用当前批准基线发起一次回归测试"
                            >
                              重跑
                            </button>
                          )}
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setDuplicateTargetCase(c)}
                            title="复制此用例为新草稿副本"
                            data-testid={`btn-duplicate-case-${c.slug}`}
                          >
                            复制
                          </button>
                          {c.status === 'active' ? (
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleArchiveCase(c)}
                              disabled={isReadOnly || !!busyAction}
                              title={
                                isReadOnly
                                  ? '只读角色无法归档用例'
                                  : '归档此用例（不删除历史版本）'
                              }
                              data-testid={`btn-archive-case-${c.slug}`}
                            >
                              {busyAction === 'archiving'
                                ? '归档中...'
                                : '归档'}
                            </button>
                          ) : (
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleRestoreCase(c)}
                              disabled={isReadOnly || !!busyAction}
                              title={
                                isReadOnly
                                  ? '只读角色无法恢复用例'
                                  : '恢复此用例为活跃状态'
                              }
                              data-testid={`btn-restore-case-${c.slug}`}
                            >
                              {busyAction === 'restoring'
                                ? '恢复中...'
                                : '恢复'}
                            </button>
                          )}
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() =>
                              setRoute('saved-case-detail', { caseId: c.id })
                            }
                            data-testid={`btn-view-detail-${c.slug}`}
                          >
                            详情
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {nextCursor && (
          <div className="lqa-load-more">
            <button
              className="btn btn-secondary"
              onClick={loadMoreCases}
              disabled={loadingMore || loading}
              data-testid="btn-load-more-cases"
            >
              {loadingMore ? '正在加载更多用例...' : '加载更多'}
            </button>
          </div>
        )}
      </div>

      {duplicateTargetCase && (
        <SavedCaseDuplicateModal
          caseRecord={duplicateTargetCase}
          versions={versionsMap[duplicateTargetCase.id] || []}
          isOpen={!!duplicateTargetCase}
          onClose={() => setDuplicateTargetCase(null)}
          onSuccess={async (newCase) => {
            setDuplicateTargetCase(null);
            const targetProject = projects.find((p) =>
              isSameProjectId(p.id, newCase.projectId),
            );
            if (
              targetProject &&
              !isSameProjectId(targetProject.id, currentProject?.id || '')
            ) {
              setCurrentProject(targetProject);
              setRoute('saved-case-detail', { caseId: newCase.id });
            } else if (
              isSameProjectId(newCase.projectId, currentProject?.id || '')
            ) {
              await fetchCases();
              setRoute('saved-case-detail', { caseId: newCase.id });
            } else {
              await fetchCases();
            }
          }}
        />
      )}

      <RegressionRunModal
        projectId={currentProject?.id || ''}
        selectedCases={modalTargetCases}
        isOpen={regressionModalOpen}
        onClose={() => setRegressionModalOpen(false)}
        onStarted={(run) => {
          setRegressionModalOpen(false);
          setRoute('workbench', { runId: run.id });
        }}
      />

      {currentProject && (
        <SavedCaseYamlImportModal
          projectId={currentProject.id}
          isOpen={yamlImportOpen}
          onClose={() => setYamlImportOpen(false)}
          onSuccess={async (createdCase) => {
            setYamlImportOpen(false);
            await fetchCases();
            setRoute('saved-case-detail', { caseId: createdCase.id });
          }}
        />
      )}
    </Page>
  );
};
