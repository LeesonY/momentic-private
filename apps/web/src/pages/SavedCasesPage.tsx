import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { SavedCase, SavedCaseVersion } from '../api/types.ts';
import type { Member } from '@localqa/contracts';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppHeader } from '../components/layout/AppHeader.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { ErrorCard } from '../components/ui/ErrorCard.tsx';
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
    <div className="app-container" data-testid="saved-cases-page">
      <AppHeader />
      <main className="main-content">
        {/* Page Title & Stats Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '20px',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0 }}>
                项目用例库与回归管理 (Case Library)
              </h1>
              {isMock && (
                <span
                  style={{
                    fontSize: '0.75rem',
                    backgroundColor: 'var(--color-warning-bg)',
                    color: 'var(--color-warning-text)',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-sm)',
                    fontWeight: 600,
                  }}
                  data-testid="mock-indicator-badge"
                >
                  [Mock 数据演示]
                </span>
              )}
            </div>
            <p
              style={{
                fontSize: '0.85rem',
                color: 'var(--color-text-muted)',
                margin: '4px 0 0 0',
              }}
            >
              项目: <strong>{currentProject?.name || '未选项目'}</strong> ·
              管理已固化用例、多版本演进草稿与不可变审查基线。
            </p>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              className="btn btn-secondary"
              onClick={() => setYamlImportOpen(true)}
              disabled={isReadOnly}
              title={isReadOnly ? '只读角色无法导入用例' : undefined}
              data-testid="btn-import-yaml-case"
            >
              📥 导入 YAML 用例
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setCreatingCase(true)}
              disabled={isReadOnly}
              title={isReadOnly ? '只读角色无法新建用例' : undefined}
              data-testid="btn-create-empty-case"
            >
              + 新建测试用例
            </button>
            <button
              className="btn btn-primary"
              disabled={selectedCaseIds.length === 0}
              onClick={handleStartBatchRegression}
              data-testid="btn-batch-regression-run"
            >
              🚀 发起回归测试 ({selectedCaseIds.length})
            </button>
          </div>
        </div>

        {/* Viewer Readonly Notice */}
        {isReadOnly && (
          <div
            className="card"
            style={{
              padding: '8px 12px',
              backgroundColor: 'var(--color-info-bg)',
              borderColor: 'var(--color-info-border)',
              color: 'var(--color-info-text)',
              fontSize: '0.8rem',
              marginBottom: '16px',
            }}
            data-testid="viewer-readonly-banner"
          >
            🔒
            当前账号为查看者（Viewer）角色，拥有只读查看用例与版本历史权限，无法新建、复制、归档或恢复用例。
          </div>
        )}

        {error && (
          <div style={{ marginBottom: '16px' }}>
            <ErrorCard message={error} />
          </div>
        )}

        {/* Create Case Inline Modal */}
        {creatingCase && (
          <div
            className="card"
            style={{
              marginBottom: '20px',
              border: '2px solid var(--color-primary)',
              backgroundColor: 'var(--color-bg-surface)',
            }}
            data-testid="create-case-form"
          >
            <div className="card-header">
              <h3 className="card-title">新建测试用例并初始化 v1 草稿</h3>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setCreatingCase(false)}
              >
                ✕ 取消
              </button>
            </div>
            <form onSubmit={handleCreateCase}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '240px 1fr 120px',
                  gap: '12px',
                  alignItems: 'flex-end',
                }}
              >
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      marginBottom: '4px',
                    }}
                  >
                    Slug (唯一标识) *
                  </label>
                  <input
                    type="text"
                    className="input"
                    placeholder="e.g. checkout-calc"
                    value={newSlug}
                    onChange={(e) => setNewSlug(e.target.value)}
                    required
                    data-testid="input-new-case-slug"
                  />
                </div>
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      marginBottom: '4px',
                    }}
                  >
                    用例标题 Name *
                  </label>
                  <input
                    type="text"
                    className="input"
                    placeholder="e.g. 购物车优惠券抵扣结算与页面断言"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    required
                    data-testid="input-new-case-name"
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={createLoading || !newSlug.trim() || !newName.trim()}
                  data-testid="btn-submit-create-case"
                >
                  {createLoading ? '创建中...' : '确认创建'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Toolbar: Search, Filter, Batch Selection */}
        <div
          className="card"
          style={{
            marginBottom: '16px',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: '12px',
              alignItems: 'center',
              flex: 1,
            }}
          >
            <input
              type="text"
              className="input"
              style={{ maxWidth: '320px', width: '100%' }}
              placeholder="搜索用例名称或 Slug..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              data-testid="input-search-saved-cases"
            />
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                className={`btn btn-sm ${statusFilter === 'active' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setStatusFilter('active')}
                data-testid="filter-status-active"
              >
                活跃 (Active)
              </button>
              <button
                className={`btn btn-sm ${statusFilter === 'archived' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setStatusFilter('archived')}
                data-testid="filter-status-archived"
              >
                已归档 (Archived)
              </button>
              <button
                className={`btn btn-sm ${statusFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setStatusFilter('all')}
                data-testid="filter-status-all"
              >
                全部状态
              </button>
            </div>
          </div>

          <div
            style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}
          >
            共 <strong>{filteredCases.length}</strong> 条用例 · 已勾选回归基线:{' '}
            <strong>{selectedCaseIds.length}</strong> 项
          </div>
        </div>

        {/* Case List Content */}
        {loading ? (
          <div
            style={{
              padding: '60px 0',
              textAlign: 'center',
              color: 'var(--color-text-muted)',
            }}
          >
            正在加载用例库列表...
          </div>
        ) : filteredCases.length === 0 ? (
          <EmptyState
            title="暂无匹配用例"
            description={
              statusFilter === 'archived'
                ? '当前项目下暂无已归档测试用例。'
                : '当前项目下尚未保存测试用例。您可以点击右上角新建用例，或在冒烟运行工作台的用例详情页点击【保存到用例库】固化执行链路。'
            }
            actionText={
              statusFilter === 'archived' ? undefined : '+ 立即新建测试用例'
            }
            onAction={
              statusFilter === 'archived'
                ? undefined
                : () => setCreatingCase(true)
            }
          />
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                textAlign: 'left',
                fontSize: '0.9rem',
              }}
              data-testid="saved-cases-table"
            >
              <thead>
                <tr
                  style={{
                    backgroundColor: 'var(--color-bg-base)',
                    borderBottom: '1px solid var(--color-border-subtle)',
                  }}
                >
                  <th style={{ padding: '12px 16px', width: '40px' }}>
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
                      data-testid="checkbox-select-all"
                    />
                  </th>
                  <th style={{ padding: '12px 16px' }}>
                    用例信息 (Slug / 名称)
                  </th>
                  <th style={{ padding: '12px 16px', width: '160px' }}>
                    有效回归基线
                  </th>
                  <th style={{ padding: '12px 16px', width: '110px' }}>
                    当前 Head
                  </th>
                  <th style={{ padding: '12px 16px', width: '100px' }}>状态</th>
                  <th style={{ padding: '12px 16px', width: '140px' }}>
                    创建时间
                  </th>
                  <th
                    style={{
                      padding: '12px 16px',
                      width: '280px',
                      textAlign: 'right',
                    }}
                  >
                    操作
                  </th>
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
                      style={{
                        borderBottom: '1px solid var(--color-border-subtle)',
                        backgroundColor: isChecked
                          ? 'rgba(59, 130, 246, 0.04)'
                          : c.status === 'archived'
                            ? '#fafafa'
                            : 'transparent',
                        opacity: c.status === 'archived' ? 0.85 : 1,
                      }}
                      data-testid={`case-row-${c.slug}`}
                    >
                      <td style={{ padding: '14px 16px' }}>
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
                          data-testid={`checkbox-case-${c.slug}`}
                        />
                      </td>
                      <td style={{ padding: '14px 16px' }}>
                        <div
                          style={{
                            fontWeight: 600,
                            color: 'var(--color-primary)',
                            cursor: 'pointer',
                          }}
                          onClick={() =>
                            setRoute('saved-case-detail', { caseId: c.id })
                          }
                        >
                          {c.name}
                        </div>
                        <code
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--color-text-muted)',
                          }}
                        >
                          {c.slug}
                        </code>
                      </td>
                      <td style={{ padding: '14px 16px' }}>
                        {approvedVer ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              backgroundColor: 'var(--color-success-bg)',
                              color: 'var(--color-success-text)',
                              padding: '2px 8px',
                              borderRadius: 'var(--radius-sm)',
                              fontSize: '0.8rem',
                              fontWeight: 600,
                            }}
                            data-testid={`approved-version-badge-${c.slug}`}
                          >
                            ✓ v{approvedVer.version} (已生效)
                          </span>
                        ) : (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              backgroundColor: 'var(--color-warning-bg)',
                              color: 'var(--color-warning-text)',
                              padding: '2px 8px',
                              borderRadius: 'var(--radius-sm)',
                              fontSize: '0.8rem',
                              fontWeight: 500,
                            }}
                            data-testid={`pending-approval-badge-${c.slug}`}
                          >
                            ⏳ 无基线 (草稿待审)
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '14px 16px' }}>
                        <span style={{ fontSize: '0.85rem' }}>
                          v{c.version} ({versions.length} 版本)
                        </span>
                      </td>
                      <td style={{ padding: '14px 16px' }}>
                        <StatusBadge status={c.status} size="sm" />
                      </td>
                      <td
                        style={{
                          padding: '14px 16px',
                          fontSize: '0.8rem',
                          color: 'var(--color-text-muted)',
                        }}
                      >
                        {new Date(c.createdAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                        <div
                          style={{
                            display: 'flex',
                            gap: '6px',
                            justifyContent: 'flex-end',
                            flexWrap: 'wrap',
                          }}
                        >
                          {isSelectable && (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleStartSingleRegression(c)}
                              data-testid={`btn-run-regression-${c.slug}`}
                              title="使用当前批准基线发起一次回归测试"
                            >
                              重跑
                            </button>
                          )}
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setDuplicateTargetCase(c)}
                            title="复制此用例为新草稿副本"
                            data-testid={`btn-duplicate-case-${c.slug}`}
                          >
                            复制
                          </button>
                          {c.status === 'active' ? (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleArchiveCase(c)}
                              disabled={isReadOnly || !!busyAction}
                              title={
                                isReadOnly
                                  ? '只读角色无法归档用例'
                                  : '归档此用例 (不删除历史版本)'
                              }
                              data-testid={`btn-archive-case-${c.slug}`}
                            >
                              {busyAction === 'archiving'
                                ? '归档中...'
                                : '归档'}
                            </button>
                          ) : (
                            <button
                              className="btn btn-secondary btn-sm"
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
                            className="btn btn-primary btn-sm"
                            onClick={() =>
                              setRoute('saved-case-detail', { caseId: c.id })
                            }
                            data-testid={`btn-view-detail-${c.slug}`}
                          >
                            详情 / 历史
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination: Load More */}
        {nextCursor && (
          <div
            style={{
              textAlign: 'center',
              marginTop: '16px',
              marginBottom: '24px',
            }}
          >
            <button
              className="btn btn-secondary"
              onClick={loadMoreCases}
              disabled={loadingMore || loading}
              data-testid="btn-load-more-cases"
            >
              {loadingMore ? '正在加载更多用例...' : '加载更多用例 (Load More)'}
            </button>
          </div>
        )}

        {/* Duplicate Case Modal */}
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

        {/* Regression Modal */}
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

        {/* YAML Import Modal */}
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
      </main>
    </div>
  );
};
