import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { SavedCase, SavedCaseVersion } from '../api/types.ts';
import type { Member } from '@localqa/contracts';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppHeader } from '../components/layout/AppHeader.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { ErrorCard } from '../components/ui/ErrorCard.tsx';
import { SavedCaseReviewModal } from '../components/saved-cases/SavedCaseReviewModal.tsx';
import { SavedCaseEditorModal } from '../components/saved-cases/SavedCaseEditorModal.tsx';
import { RegressionRunModal } from '../components/saved-cases/RegressionRunModal.tsx';
import { SavedCaseYamlExportModal } from '../components/saved-cases/SavedCaseYamlExportModal.tsx';
import { SavedCaseDuplicateModal } from '../components/saved-cases/SavedCaseDuplicateModal.tsx';
import {
  LifecycleScopeGuard,
  findCaseAcrossPages,
  isSameCaseId,
  LifecycleSearchError,
} from '../utils/lifecycleScope.ts';
import {
  fetchSavedCaseVersionsAcrossPages,
  SavedCaseVersionPageError,
} from '../utils/savedCaseVersionPagination.ts';
import { isSameProjectId } from '../utils/moduleRoles.ts';

export const SavedCaseDetailPage: React.FC = () => {
  const {
    routeParams,
    setRoute,
    currentProject,
    currentUser,
    projects,
    setCurrentProject,
  } = useApp();
  const caseId = routeParams.caseId;

  const [caseRecord, setCaseRecord] = useState<SavedCase | null>(null);
  const [versions, setVersions] = useState<SavedCaseVersion[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'document' | 'history'>(
    'document',
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals state
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [editorModalOpen, setEditorModalOpen] = useState(false);
  const [regressionModalOpen, setRegressionModalOpen] = useState(false);
  const [yamlExportOpen, setYamlExportOpen] = useState(false);
  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState<
    'archiving' | 'restoring' | null
  >(null);

  // Scope guard ref
  const scopeGuardRef = useRef(new LifecycleScopeGuard());

  const fetchCaseAndVersions = useCallback(async () => {
    if (!caseId || !currentProject) return;
    const scopeContext = { projectId: currentProject.id, caseId };
    const { isValid } = scopeGuardRef.current.startRequest(scopeContext);
    setLoading(true);
    setError(null);
    try {
      // Strictly resolve real case across all pages; never synthesize active metadata
      let foundCase: SavedCase | null = null;
      try {
        foundCase = await findCaseAcrossPages(
          defaultApiClient,
          currentProject.id,
          caseId,
        );
      } catch (err) {
        if (!isValid()) return;
        if (err instanceof LifecycleSearchError) {
          if (err.code === 'SEARCH_LIMIT') {
            setError('遍历已达到搜索页数上限，未能完整查找用例');
          } else if (err.code === 'REPEATED_CURSOR') {
            setError('检测到分页游标循环，已终止查询');
          } else if (err.code === 'PROJECT_MISMATCH') {
            setError('查询到的记录所属项目与当前项目不匹配');
          } else {
            setError(err.message);
          }
          return;
        }
        setError(err instanceof Error ? err.message : '查询用例失败');
        return;
      }

      if (!isValid()) return;
      if (!foundCase) {
        setCaseRecord(null);
        setVersions([]);
        setError('未找到该测试用例记录 (404)');
        return;
      }

      let caseVers: SavedCaseVersion[] = [];
      try {
        const [vers, memRes] = await Promise.all([
          fetchSavedCaseVersionsAcrossPages(defaultApiClient, caseId),
          defaultApiClient
            .listMembers(currentProject.id)
            .catch(() => ({ items: [] })),
        ]);
        if (!isValid()) return;
        caseVers = vers;
        setMembers(memRes.items);
      } catch (err) {
        if (!isValid()) return;
        if (err instanceof SavedCaseVersionPageError) {
          if (err.code === 'SEARCH_LIMIT') {
            setError('遍历已达到版本页数上限，未能完整查找版本历史');
          } else if (err.code === 'REPEATED_CURSOR') {
            setError('检测到版本分页游标循环，已终止查询');
          } else if (err.code === 'CASE_MISMATCH') {
            setError('查询到的版本所属用例与当前用例不匹配');
          } else if (err.code === 'CONTENT_CONFLICT') {
            setError('检测到不同页面返回了冲突的版本内容');
          } else if (err.code === 'VALIDATION_ERROR') {
            setError('用例ID格式无效');
          } else {
            setError(err.message);
          }
          return;
        }
        setError(err instanceof Error ? err.message : '加载用例版本详情失败');
        return;
      }

      setCaseRecord(foundCase);
      setVersions(caseVers);
      if (caseVers.length > 0) {
        setSelectedVersionId((prev) =>
          prev && caseVers.some((v) => isSameCaseId(v.id, prev))
            ? prev
            : caseVers[0].id,
        );
      }
    } catch (err) {
      if (!isValid()) return;
      setError(err instanceof Error ? err.message : '加载用例版本详情失败');
    } finally {
      if (isValid()) {
        setLoading(false);
      }
    }
  }, [caseId, currentProject?.id]);

  useEffect(() => {
    scopeGuardRef.current.resetScope({
      projectId: currentProject?.id || '',
      caseId: caseId || '',
    });
    setCaseRecord(null);
    setVersions([]);
    setMembers([]);
    setSelectedVersionId('');
    setActionLoading(null);
    setReviewModalOpen(false);
    setEditorModalOpen(false);
    setRegressionModalOpen(false);
    setYamlExportOpen(false);
    setDuplicateModalOpen(false);
    setError(null);

    if (caseId && currentProject) {
      fetchCaseAndVersions();
    } else {
      setLoading(false);
    }

    return () => {
      scopeGuardRef.current.resetScope(null);
    };
  }, [caseId, currentProject?.id, fetchCaseAndVersions]);

  const activeVersion =
    versions.find((v) => v.id === selectedVersionId) || versions[0] || null;

  if (loading) {
    return (
      <div className="app-container" data-testid="saved-case-detail-loading">
        <AppHeader />
        <main
          className="main-content"
          style={{
            padding: '60px 0',
            textAlign: 'center',
            color: 'var(--color-text-muted)',
          }}
        >
          正在加载用例详情与版本历史...
        </main>
      </div>
    );
  }

  if (error || !caseRecord || !activeVersion) {
    return (
      <div className="app-container" data-testid="saved-case-detail-error">
        <AppHeader />
        <main className="main-content">
          <ErrorCard message={error || '未找到该测试用例记录'} />
          <button
            className="btn btn-secondary"
            onClick={() => setRoute('saved-cases')}
            style={{ marginTop: '16px' }}
          >
            ← 返回用例库
          </button>
        </main>
      </div>
    );
  }

  const isApproved = activeVersion.reviewStatus === 'approved';
  const isDraft = activeVersion.reviewStatus === 'draft';
  const isArchived = caseRecord.status === 'archived';

  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const isOwnerOrOperator =
    currentMember?.role === 'owner' ||
    currentMember?.role === 'operator' ||
    currentUser?.globalRole === 'admin';
  const isReadOnly = !isOwnerOrOperator;

  const handleArchive = async () => {
    if (!caseRecord || actionLoading || !currentProject) return;
    const scopeContext = {
      projectId: currentProject.id,
      caseId: caseRecord.id,
    };
    const { isValid } = scopeGuardRef.current.captureScope(scopeContext);

    if (!isValid()) return;
    setActionLoading('archiving');
    setError(null);
    try {
      await defaultApiClient.archiveSavedCase(caseRecord.id, {
        expectedVersion: caseRecord.version,
      });
      if (!isValid()) return;
      await fetchCaseAndVersions();
    } catch (err) {
      if (!isValid()) return;
      setError(err instanceof Error ? err.message : '归档用例失败');
    } finally {
      if (isValid()) {
        setActionLoading(null);
      }
    }
  };

  const handleRestore = async () => {
    if (!caseRecord || actionLoading || !currentProject) return;
    const scopeContext = {
      projectId: currentProject.id,
      caseId: caseRecord.id,
    };
    const { isValid } = scopeGuardRef.current.captureScope(scopeContext);

    if (!isValid()) return;
    setActionLoading('restoring');
    setError(null);
    try {
      await defaultApiClient.restoreSavedCase(caseRecord.id, {
        expectedVersion: caseRecord.version,
      });
      if (!isValid()) return;
      await fetchCaseAndVersions();
    } catch (err) {
      if (!isValid()) return;
      setError(err instanceof Error ? err.message : '恢复用例失败');
    } finally {
      if (isValid()) {
        setActionLoading(null);
      }
    }
  };

  return (
    <div
      className="app-container"
      data-testid="saved-case-detail-page"
      data-case-id={caseRecord.id}
      data-case-version={caseRecord.version}
    >
      <AppHeader />
      <main className="main-content">
        {/* Navigation Breadcrumb & Actions */}
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
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.85rem',
              }}
            >
              <span
                style={{ color: 'var(--color-primary)', cursor: 'pointer' }}
                onClick={() => setRoute('saved-cases')}
                data-testid="btn-back-to-library"
              >
                用例库 (Case Library)
              </span>
              <span>/</span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                {caseRecord.slug}
              </span>
            </div>
            <h1
              style={{
                fontSize: '1.4rem',
                fontWeight: 700,
                margin: '6px 0 0 0',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
              }}
              data-testid="case-title"
            >
              {caseRecord.name}
              <StatusBadge status={activeVersion.reviewStatus} />
              {isArchived && (
                <span
                  className="badge badge-neutral"
                  style={{
                    backgroundColor: '#64748b',
                    color: '#fff',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                  }}
                  data-testid="case-archived-badge"
                >
                  📦 已归档
                </span>
              )}
            </h1>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button
              className="btn btn-secondary"
              onClick={() => setRoute('saved-cases')}
            >
              ← 返回列表
            </button>

            {/* Duplicate button */}
            <button
              className="btn btn-secondary"
              onClick={() => setDuplicateModalOpen(true)}
              data-testid="btn-duplicate-case"
              title="基于选定版本创建独立草稿用例"
            >
              📋 复制用例
            </button>

            {/* Archive / Restore button */}
            {isOwnerOrOperator && !isArchived && (
              <button
                className="btn btn-secondary"
                disabled={actionLoading !== null}
                onClick={handleArchive}
                data-testid="btn-archive-case"
                title="归档此测试用例（可在归档视图中查看与恢复）"
              >
                {actionLoading === 'archiving' ? '归档中...' : '📦 归档用例'}
              </button>
            )}
            {isOwnerOrOperator && isArchived && (
              <button
                className="btn btn-secondary"
                disabled={actionLoading !== null}
                onClick={handleRestore}
                data-testid="btn-restore-case"
                title="恢复此测试用例为活跃状态"
              >
                {actionLoading === 'restoring' ? '恢复中...' : '♻️ 恢复用例'}
              </button>
            )}

            {/* Regression Run button */}
            <button
              className="btn btn-primary"
              disabled={!isApproved || isArchived}
              onClick={() => setRegressionModalOpen(true)}
              data-testid="btn-run-regression"
              title={
                isArchived
                  ? '已归档用例不可发起回归重跑'
                  : !isApproved
                    ? '仅已批准通过的有效基线版本可用于回归重跑'
                    : ''
              }
            >
              🚀 发起回归重跑
            </button>

            {/* Create New Draft button */}
            <button
              className="btn btn-secondary"
              disabled={isReadOnly || isArchived}
              onClick={() => setEditorModalOpen(true)}
              data-testid="btn-create-draft"
              title={
                isArchived
                  ? '已归档用例处于只读状态，不可编辑'
                  : isReadOnly
                    ? '仅拥有 Operator 或 Owner 权限方可创建新草稿'
                    : ''
              }
            >
              ✏️ 编辑创建新草稿 (v{caseRecord.version + 1})
            </button>

            {/* Export YAML button */}
            <button
              className="btn btn-secondary"
              onClick={() => setYamlExportOpen(true)}
              data-testid="btn-export-yaml-case"
              title="导出当前版本 YAML 规范与 SHA-256 校验码"
            >
              📤 导出 YAML
            </button>

            {/* Human Review button (if draft) */}
            {isDraft && !isArchived && (
              <button
                className="btn btn-warning"
                style={{
                  backgroundColor: '#f59e0b',
                  borderColor: '#d97706',
                  color: '#fff',
                  fontWeight: 600,
                }}
                disabled={isReadOnly}
                onClick={() => setReviewModalOpen(true)}
                data-testid="btn-start-review"
                title={
                  isReadOnly
                    ? '仅拥有 Operator 或 Owner 权限方可提交人工审查'
                    : ''
                }
              >
                ⚖️ 提交人工审查与批准
              </button>
            )}
          </div>
        </div>

        {/* Archived Banner Notice */}
        {isArchived && (
          <div
            style={{
              padding: '12px 16px',
              backgroundColor: 'var(--color-bg-warning-subtle, #fef3c7)',
              border: '1px solid var(--color-border-warning, #f59e0b)',
              borderRadius: 'var(--radius-md)',
              marginBottom: '16px',
              color: '#92400e',
              fontSize: '0.875rem',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
            data-testid="archived-notice-banner"
          >
            <span>📦</span>
            <span>
              <strong>该测试用例已被归档</strong>
              ，当前处于只读保护状态。版本历史可完整查阅与导出；若需继续编辑或用于回归运行，请使用上方“恢复用例”按钮恢复为活跃状态。
            </span>
          </div>
        )}

        {/* Version Selector Tabs & Notice */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
            backgroundColor: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-lg)',
            padding: '8px 16px',
          }}
        >
          {/* Version buttons */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              overflowX: 'auto',
            }}
          >
            <span
              style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                color: 'var(--color-text-muted)',
              }}
            >
              版本切换:
            </span>
            {versions.map((v) => {
              const isSelected = v.id === activeVersion.id;
              return (
                <button
                  key={v.id}
                  className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  onClick={() => setSelectedVersionId(v.id)}
                  data-testid={`version-tab-v${v.version}`}
                  data-version-id={v.id}
                >
                  <span>v{v.version}</span>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      opacity: 0.85,
                      textTransform: 'uppercase',
                    }}
                  >
                    ({v.reviewStatus})
                  </span>
                </button>
              );
            })}
          </div>

          {/* Sub-tab view switch: document vs history */}
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              className={`btn btn-sm ${activeTab === 'document' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('document')}
              data-testid="tab-view-document"
            >
              契约定义与步骤
            </button>
            <button
              className={`btn btn-sm ${activeTab === 'history' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('history')}
              data-testid="tab-view-history"
            >
              版本历史链 ({versions.length})
            </button>
          </div>
        </div>

        {activeTab === 'document' ? (
          /* Tab 1: Current Version Document (Criteria & Replay Steps) */
          <div>
            {/* Version Meta Banner */}
            <div
              className="card"
              style={{
                marginBottom: '16px',
                padding: '14px 20px',
                backgroundColor: 'var(--color-bg-surface)',
              }}
              data-testid="version-meta-card"
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '12px',
                  fontSize: '0.85rem',
                }}
              >
                <div>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    当前版本:{' '}
                  </span>
                  <strong>v{activeVersion.version}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    审查状态:{' '}
                  </span>
                  <StatusBadge status={activeVersion.reviewStatus} size="sm" />
                </div>
                <div>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    创建作者:{' '}
                  </span>
                  <code>{activeVersion.createdBy.slice(0, 16)}</code>
                </div>
                <div>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    创建时间:{' '}
                  </span>
                  <span>
                    {new Date(activeVersion.createdAt).toLocaleString()}
                  </span>
                </div>
                {activeVersion.reviewedAt && (
                  <div>
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      审查时间:{' '}
                    </span>
                    <span>
                      {new Date(activeVersion.reviewedAt).toLocaleString()}
                    </span>
                  </div>
                )}
                <div style={{ gridColumn: '1 / -1' }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    不可变密码学指纹 (SHA-256):{' '}
                  </span>
                  <code
                    style={{
                      fontSize: '0.75rem',
                      backgroundColor: 'var(--color-bg-base)',
                      padding: '2px 6px',
                      borderRadius: 'var(--radius-sm)',
                    }}
                    data-testid="version-sha256"
                  >
                    {activeVersion.sha256}
                  </code>
                </div>
              </div>
            </div>

            {/* Criteria & Replay Steps Grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '20px',
              }}
            >
              {/* Left Column: Criteria */}
              <div className="card" data-testid="criteria-card">
                <div className="card-header">
                  <h3 className="card-title">
                    判定准则 (Criteria -{' '}
                    {activeVersion.document.criteria.length} 项)
                  </h3>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  {activeVersion.document.criteria.map((c, i) => (
                    <div
                      key={c.id || i}
                      style={{
                        backgroundColor: 'var(--color-bg-base)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-md)',
                        padding: '12px',
                        fontSize: '0.85rem',
                      }}
                      data-testid={`criterion-card-${c.id}`}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '6px',
                        }}
                      >
                        <code
                          style={{
                            fontWeight: 600,
                            color: 'var(--color-primary)',
                          }}
                        >
                          {c.id}
                        </code>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            backgroundColor: '#e0e7ff',
                            color: '#3730a3',
                            padding: '1px 6px',
                            borderRadius: 'var(--radius-sm)',
                            fontWeight: 600,
                          }}
                        >
                          {c.kind}
                        </span>
                      </div>
                      <div style={{ fontWeight: 500, marginBottom: '6px' }}>
                        {c.description}
                      </div>
                      {c.locator && (
                        <div
                          style={{
                            color: 'var(--color-text-muted)',
                            fontSize: '0.8rem',
                          }}
                        >
                          定位器 ({c.locator.by}):{' '}
                          <code>{c.locator.value}</code>
                        </div>
                      )}
                      {c.expectedValue !== undefined && (
                        <div
                          style={{
                            color: 'var(--color-text-muted)',
                            fontSize: '0.8rem',
                            marginTop: '2px',
                          }}
                        >
                          期望值: <code>{String(c.expectedValue)}</code>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Right Column: Replay Steps */}
              <div className="card" data-testid="steps-card">
                <div className="card-header">
                  <h3 className="card-title">
                    回放步骤序列 (Replay Steps -{' '}
                    {activeVersion.document.steps.length} 步)
                  </h3>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  {activeVersion.document.steps.map((st, i) => (
                    <div
                      key={i}
                      style={{
                        backgroundColor: 'var(--color-bg-base)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-md)',
                        padding: '10px 14px',
                        fontSize: '0.85rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                      }}
                      data-testid={`step-card-${i}`}
                    >
                      <span
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          backgroundColor: 'var(--color-primary)',
                          color: '#fff',
                          width: '22px',
                          height: '22px',
                          borderRadius: '50%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {i + 1}
                      </span>
                      <div style={{ flex: 1 }}>
                        <span
                          style={{
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            marginRight: '8px',
                            color: 'var(--color-text-main)',
                          }}
                        >
                          {st.kind}
                        </span>
                        {st.kind === 'navigate' && <code>{st.url}</code>}
                        {st.kind === 'click' && <code>{st.locator.value}</code>}
                        {st.kind === 'type_text' && (
                          <span>
                            在 <code>{st.locator.value}</code> 输入{' '}
                            <code>"{st.text}"</code>
                          </span>
                        )}
                        {st.kind === 'assert' && (
                          <span>
                            验证准则 <code>{st.criterionId}</code>
                          </span>
                        )}
                        {st.kind === 'ai_action' && <span>{st.goal}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Tab 2: Version History Immutable Audit Trail */
          <div
            className="card"
            style={{ padding: 0, overflow: 'hidden' }}
            data-testid="version-history-card"
          >
            <div
              style={{
                padding: '14px 20px',
                borderBottom: '1px solid var(--color-border-subtle)',
                backgroundColor: 'var(--color-bg-base)',
                fontSize: '0.85rem',
              }}
            >
              🔒 <strong>不可变审计保障: </strong>
              用例库中每次编辑均派生递增的新版本（Draft），不覆写或擦除任何历史记录；审查结论与批准操作严格永久绑定特定版本快照与
              SHA-256 哈希。
            </div>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                textAlign: 'left',
                fontSize: '0.9rem',
              }}
              data-testid="version-history-table"
            >
              <thead>
                <tr
                  style={{
                    backgroundColor: 'var(--color-bg-surface)',
                    borderBottom: '1px solid var(--color-border-subtle)',
                  }}
                >
                  <th style={{ padding: '12px 16px' }}>版本号</th>
                  <th style={{ padding: '12px 16px' }}>审查状态</th>
                  <th style={{ padding: '12px 16px' }}>创建人 / 创建时间</th>
                  <th style={{ padding: '12px 16px' }}>审查人 / 审查时间</th>
                  <th style={{ padding: '12px 16px' }}>密码学指纹 (SHA-256)</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => {
                  const isCurrentViewing = v.id === activeVersion.id;
                  const isBaseApproved =
                    v.id === caseRecord.currentApprovedVersionId;

                  return (
                    <tr
                      key={v.id}
                      style={{
                        borderBottom: '1px solid var(--color-border-subtle)',
                        backgroundColor: isCurrentViewing
                          ? 'rgba(59, 130, 246, 0.05)'
                          : 'transparent',
                      }}
                      data-testid={`history-row-v${v.version}`}
                      data-version-id={v.id}
                    >
                      <td style={{ padding: '12px 16px', fontWeight: 600 }}>
                        v{v.version}{' '}
                        {isBaseApproved && (
                          <span
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--color-success)',
                              fontWeight: 600,
                            }}
                          >
                            [当前基线]
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <StatusBadge status={v.reviewStatus} size="sm" />
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: '0.85rem' }}>
                        <div>{v.createdBy.slice(0, 16)}</div>
                        <div
                          style={{
                            color: 'var(--color-text-muted)',
                            fontSize: '0.75rem',
                          }}
                        >
                          {new Date(v.createdAt).toLocaleString()}
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: '0.85rem' }}>
                        {v.reviewedBy ? (
                          <>
                            <div>{v.reviewedBy.slice(0, 16)}</div>
                            <div
                              style={{
                                color: 'var(--color-text-muted)',
                                fontSize: '0.75rem',
                              }}
                            >
                              {new Date(v.reviewedAt!).toLocaleString()}
                            </div>
                          </>
                        ) : (
                          <span style={{ color: 'var(--color-text-muted)' }}>
                            - 尚未审查 -
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <code
                          style={{
                            fontSize: '0.75rem',
                            backgroundColor: 'var(--color-bg-base)',
                            padding: '2px 6px',
                            borderRadius: 'var(--radius-sm)',
                          }}
                        >
                          {v.sha256.slice(0, 16)}...
                        </code>
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                        <button
                          className={`btn btn-sm ${isCurrentViewing ? 'btn-secondary' : 'btn-primary'}`}
                          onClick={() => {
                            setSelectedVersionId(v.id);
                            setActiveTab('document');
                          }}
                          data-testid={`btn-inspect-v${v.version}`}
                        >
                          {isCurrentViewing ? '正在查看' : '查看此版本'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Modals */}
        <SavedCaseReviewModal
          caseRecord={caseRecord}
          caseVersion={activeVersion}
          isOpen={reviewModalOpen}
          onClose={() => setReviewModalOpen(false)}
          onSuccess={async () => {
            setReviewModalOpen(false);
            await fetchCaseAndVersions();
          }}
        />

        <SavedCaseEditorModal
          caseRecord={caseRecord}
          baseVersion={activeVersion}
          isOpen={editorModalOpen}
          onClose={() => setEditorModalOpen(false)}
          onSuccess={async (newVersion) => {
            setEditorModalOpen(false);
            setSelectedVersionId(newVersion.id);
            await fetchCaseAndVersions();
          }}
        />

        <RegressionRunModal
          projectId={currentProject?.id || ''}
          selectedCases={[
            {
              caseId: caseRecord.id,
              caseName: caseRecord.name,
              versionId: activeVersion.id,
              versionNum: activeVersion.version,
            },
          ]}
          isOpen={regressionModalOpen}
          onClose={() => setRegressionModalOpen(false)}
          onStarted={(run) => {
            setRegressionModalOpen(false);
            setRoute('workbench', { runId: run.id });
          }}
        />

        {/* YAML Export Modal */}
        <SavedCaseYamlExportModal
          versionId={activeVersion.id}
          versionNum={activeVersion.version}
          caseSlug={caseRecord.slug}
          isOpen={yamlExportOpen}
          onClose={() => setYamlExportOpen(false)}
        />

        {/* Duplicate Modal */}
        <SavedCaseDuplicateModal
          caseRecord={caseRecord}
          versions={versions}
          isOpen={duplicateModalOpen}
          onClose={() => setDuplicateModalOpen(false)}
          onSuccess={(newCase) => {
            setDuplicateModalOpen(false);
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
              setRoute('saved-case-detail', { caseId: newCase.id });
            }
          }}
        />
      </main>
    </div>
  );
};
