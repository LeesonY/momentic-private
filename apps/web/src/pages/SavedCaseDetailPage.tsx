import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { SavedCase, SavedCaseVersion } from '../api/types.ts';
import type { Member } from '@localqa/contracts';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { ErrorCard } from '../components/ui/ErrorCard.tsx';
import { Section } from '../components/ui/Section.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { SavedCaseReviewModal } from '../components/saved-cases/SavedCaseReviewModal.tsx';
import { SavedCaseEditorModal } from '../components/saved-cases/SavedCaseEditorModal.tsx';
import { RegressionRunModal } from '../components/saved-cases/RegressionRunModal.tsx';
import { SavedCaseYamlExportModal } from '../components/saved-cases/SavedCaseYamlExportModal.tsx';
import { SavedCaseDuplicateModal } from '../components/saved-cases/SavedCaseDuplicateModal.tsx';
import { RepairProposalsPanel } from '../components/saved-cases/RepairProposalsPanel.tsx';
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

  const back = {
    label: '返回用例库',
    onClick: () => setRoute('saved-cases'),
    testId: 'btn-back-to-library',
  };

  if (loading) {
    return (
      <Page testId="saved-case-detail-loading" back={back}>
        <div className="lqa-session-loading is-inline">
          正在加载用例详情与版本历史...
        </div>
      </Page>
    );
  }

  if (error || !caseRecord || !activeVersion) {
    return (
      <Page testId="saved-case-detail-error" back={back}>
        <ErrorCard message={error || '未找到该测试用例记录'} />
      </Page>
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
    <Page
      testId="saved-case-detail-page"
      data-case-id={caseRecord.id}
      data-case-version={caseRecord.version}
      width="wide"
      back={back}
      eyebrow={
        <>
          <AppIcon name="layers" size={14} />
          <code>{caseRecord.slug}</code>
        </>
      }
      title={
        <span className="row row-wrap" data-testid="case-title">
          {caseRecord.name}
          <StatusBadge status={activeVersion.reviewStatus} />
          {isArchived && (
            <span
              className="badge badge-neutral"
              data-testid="case-archived-badge"
            >
              <AppIcon name="archive" size={12} />
              已归档
            </span>
          )}
        </span>
      }
      actions={
        <>
          <button
            className="btn btn-ghost"
            onClick={() => setDuplicateModalOpen(true)}
            data-testid="btn-duplicate-case"
            title="基于选定版本创建独立的草稿用例"
          >
            <AppIcon name="copy" size={14} />
            复制
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => setYamlExportOpen(true)}
            data-testid="btn-export-yaml-case"
            title="导出当前版本的 YAML 与 SHA-256 校验码"
          >
            <AppIcon name="download" size={14} />
            导出 YAML
          </button>
          {isOwnerOrOperator && !isArchived && (
            <button
              className="btn btn-ghost"
              disabled={actionLoading !== null}
              onClick={handleArchive}
              data-testid="btn-archive-case"
              title="归档此测试用例（可在归档视图中查看与恢复）"
            >
              <AppIcon name="archive" size={14} />
              {actionLoading === 'archiving' ? '归档中...' : '归档'}
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
              <AppIcon name="rotate-ccw" size={14} />
              {actionLoading === 'restoring' ? '恢复中...' : '恢复用例'}
            </button>
          )}
          {isDraft && !isArchived && (
            <button
              className="btn btn-secondary"
              disabled={isReadOnly}
              onClick={() => setReviewModalOpen(true)}
              data-testid="btn-start-review"
              title={isReadOnly ? '只有操作员或负责人可以提交人工审查' : ''}
            >
              <AppIcon name="flag" size={14} />
              提交审查
            </button>
          )}
          <button
            className="btn btn-secondary"
            disabled={isReadOnly || isArchived}
            onClick={() => setEditorModalOpen(true)}
            data-testid="btn-create-draft"
            title={
              isArchived
                ? '已归档用例为只读状态，不能编辑'
                : isReadOnly
                  ? '只有操作员或负责人可以创建新草稿'
                  : ''
            }
          >
            <AppIcon name="edit" size={14} />
            新建草稿 v{caseRecord.version + 1}
          </button>
          <button
            className="btn btn-primary"
            disabled={!isApproved || isArchived}
            onClick={() => setRegressionModalOpen(true)}
            data-testid="btn-run-regression"
            title={
              isArchived
                ? '已归档用例不能发起回归'
                : !isApproved
                  ? '只有已批准的基线版本可以用于回归'
                  : ''
            }
          >
            <AppIcon name="play" size={13} />
            发起回归
          </button>
        </>
      }
    >
      {isArchived && (
        <Alert
          tone="warning"
          title="该测试用例已归档"
          testId="archived-notice-banner"
        >
          当前处于只读保护状态，版本历史仍可完整查阅与导出。如需继续编辑或用于回归，请先点击上方「恢复用例」。
        </Alert>
      )}

      <div className="toolbar lqa-version-toolbar">
        <span className="text-sm muted">版本</span>
        <div className="segmented lqa-version-tabs">
          {versions.map((v) => {
            const isSelected = v.id === activeVersion.id;
            return (
              <button
                key={v.id}
                type="button"
                className={isSelected ? 'is-active' : ''}
                aria-pressed={isSelected}
                onClick={() => setSelectedVersionId(v.id)}
                data-testid={`version-tab-v${v.version}`}
                data-version-id={v.id}
                title={v.reviewStatus}
              >
                v{v.version}
                <span
                  className={`lqa-version-dot is-${v.reviewStatus}`}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
        <div className="segmented push">
          <button
            type="button"
            className={activeTab === 'document' ? 'is-active' : ''}
            onClick={() => setActiveTab('document')}
            data-testid="tab-view-document"
          >
            准则与步骤
          </button>
          <button
            type="button"
            className={activeTab === 'history' ? 'is-active' : ''}
            onClick={() => setActiveTab('history')}
            data-testid="tab-view-history"
          >
            版本历史（{versions.length}）
          </button>
        </div>
      </div>

      {activeTab === 'document' ? (
        <>
          <section className="card" data-testid="version-meta-card">
            <dl className="kv lqa-version-meta">
              <dt>当前版本</dt>
              <dd className="strong">v{activeVersion.version}</dd>
              <dt>审查状态</dt>
              <dd>
                <StatusBadge status={activeVersion.reviewStatus} size="sm" />
              </dd>
              <dt>创建者</dt>
              <dd>
                <code>{activeVersion.createdBy.slice(0, 16)}</code>
              </dd>
              <dt>创建时间</dt>
              <dd>{new Date(activeVersion.createdAt).toLocaleString()}</dd>
              {activeVersion.reviewedAt && (
                <>
                  <dt>审查时间</dt>
                  <dd>{new Date(activeVersion.reviewedAt).toLocaleString()}</dd>
                </>
              )}
              <dt>SHA-256 指纹</dt>
              <dd>
                <code className="break-all" data-testid="version-sha256">
                  {activeVersion.sha256}
                </code>
              </dd>
            </dl>
          </section>

          <div className="grid-2 lqa-doc-grid">
            <Section
              icon="target"
              title={`判定准则（${activeVersion.document.criteria.length}）`}
              testId="criteria-card"
            >
              <div className="lqa-card-list">
                {activeVersion.document.criteria.map((c, i) => (
                  <div
                    key={c.id || i}
                    className="lqa-item-card"
                    data-testid={`criterion-card-${c.id}`}
                  >
                    <div className="lqa-item-top">
                      <code className="strong">{c.id}</code>
                      <span className="badge badge-primary badge-sm">
                        {c.kind}
                      </span>
                    </div>
                    <div className="lqa-item-title">{c.description}</div>
                    {c.locator && (
                      <div className="text-xs muted">
                        定位器（{c.locator.by}）<code>{c.locator.value}</code>
                      </div>
                    )}
                    {c.expectedValue !== undefined && (
                      <div className="text-xs muted">
                        期望值 <code>{String(c.expectedValue)}</code>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Section>

            <Section
              icon="list"
              title={`回放步骤（${activeVersion.document.steps.length}）`}
              testId="steps-card"
            >
              <div className="lqa-card-list">
                {activeVersion.document.steps.map((st, i) => (
                  <div
                    key={i}
                    className="lqa-item-card lqa-replay-step"
                    data-testid={`step-card-${i}`}
                  >
                    <span className="lqa-step-seq">{i + 1}</span>
                    <div className="grow text-sm">
                      <span className="lqa-timeline-role">{st.kind}</span>{' '}
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
            </Section>
          </div>
        </>
      ) : (
        <section className="card card-flush" data-testid="version-history-card">
          <div className="card-body-flush">
            <Alert tone="neutral" title="历史版本不可变">
              每次编辑都会派生递增的新草稿版本，不覆写或擦除任何历史；审查结论与批准永久绑定到具体版本快照及其
              SHA-256。
            </Alert>
          </div>
          <div className="table-container">
            <table className="data-table" data-testid="version-history-table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>审查状态</th>
                  <th>创建</th>
                  <th>审查</th>
                  <th>SHA-256 指纹</th>
                  <th className="cell-actions">操作</th>
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
                      className={isCurrentViewing ? 'is-selected' : ''}
                      data-testid={`history-row-v${v.version}`}
                      data-version-id={v.id}
                    >
                      <td className="nowrap">
                        <span className="strong">v{v.version}</span>{' '}
                        {isBaseApproved && (
                          <span className="badge badge-success badge-sm">
                            当前基线
                          </span>
                        )}
                      </td>
                      <td>
                        <StatusBadge status={v.reviewStatus} size="sm" />
                      </td>
                      <td className="text-sm">
                        {v.createdBy.slice(0, 16)}
                        <div className="cell-sub">
                          {new Date(v.createdAt).toLocaleString()}
                        </div>
                      </td>
                      <td className="text-sm">
                        {v.reviewedBy ? (
                          <>
                            {v.reviewedBy.slice(0, 16)}
                            <div className="cell-sub">
                              {new Date(v.reviewedAt!).toLocaleString()}
                            </div>
                          </>
                        ) : (
                          <span className="subtle">尚未审查</span>
                        )}
                      </td>
                      <td>
                        <code className="text-xs">
                          {v.sha256.slice(0, 16)}…
                        </code>
                      </td>
                      <td className="cell-actions">
                        <button
                          className={`btn btn-sm ${isCurrentViewing ? 'btn-ghost' : 'btn-secondary'}`}
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
        </section>
      )}

      <RepairProposalsPanel
        key={caseRecord.id}
        caseId={caseRecord.id}
        archived={isArchived}
        canCreate={isOwnerOrOperator}
        caseVersion={caseRecord.version}
        baselineVersion={
          versions.find((v) => v.id === caseRecord.currentApprovedVersionId) ??
          null
        }
        onCandidateCreated={async (versionId) => {
          await fetchCaseAndVersions();
          setSelectedVersionId(versionId);
          setActiveTab('document');
        }}
        canReview={
          currentMember?.role === 'owner' || currentUser?.globalRole === 'admin'
        }
      />

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
    </Page>
  );
};
