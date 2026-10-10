import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { RegressionModuleRecord, Member } from '@localqa/contracts';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { ModuleRegisterModal } from '../components/modules/ModuleRegisterModal.tsx';
import { ModuleReviewModal } from '../components/modules/ModuleReviewModal.tsx';
import { getModuleRolePermissions } from '../utils/moduleRoles.ts';
import {
  mergeModuleRecords,
  resolveLatestModuleVersion,
  fetchModulePage,
  fetchModuleVersionPage,
  RequestScopeGuard,
} from '../utils/modulePagination.ts';

export const ModulesPage: React.FC = () => {
  const { currentProject, currentUser } = useApp();
  const [modules, setModules] = useState<RegressionModuleRecord[]>([]);
  const [modulesCursor, setModulesCursor] = useState<string | null>(null);
  const [loadingMoreModules, setLoadingMoreModules] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selected module for version history inspection
  const [selectedModule, setSelectedModule] =
    useState<RegressionModuleRecord | null>(null);
  const [versionHistory, setVersionHistory] = useState<
    RegressionModuleRecord[]
  >([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);

  // Modals state
  const [registerModalOpen, setRegisterModalOpen] = useState(false);
  const [registerTargetModule, setRegisterTargetModule] = useState<{
    name: string;
    latestVersion: number;
    latestDocument: RegressionModuleRecord['document'];
  } | null>(null);

  const [reviewTargetModule, setReviewTargetModule] =
    useState<RegressionModuleRecord | null>(null);

  // Scope guards to prevent slow stale responses from overwriting current state
  const moduleScopeGuardRef = useRef(new RequestScopeGuard());
  const historyScopeGuardRef = useRef(new RequestScopeGuard());

  // Compute role permissions for current user in current project
  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const permissions = getModuleRolePermissions(
    currentMember?.role,
    currentUser?.globalRole,
  );

  const loadModules = useCallback(
    async (projId?: string) => {
      const targetProjId = projId || currentProject?.id;
      if (!targetProjId) return;

      const scope = { projectId: targetProjId };
      const { isValid } = moduleScopeGuardRef.current.startRequest(scope);

      setLoading(true);
      setError(null);
      try {
        const [modulesRes, membersRes] = await Promise.all([
          fetchModulePage(defaultApiClient, targetProjId, { limit: 20 }),
          defaultApiClient
            .listMembers(targetProjId)
            .catch(() => ({ items: [] })),
        ]);
        if (!isValid()) return;
        setModules(modulesRes.items);
        setModulesCursor(modulesRes.nextCursor || null);
        setMembers(membersRes.items);
      } catch (err) {
        if (!isValid()) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isValid()) {
          setLoading(false);
        }
      }
    },
    [currentProject?.id],
  );

  // Project switching: clear stale state and reload with fresh scope
  useEffect(() => {
    const projId = currentProject?.id || null;
    moduleScopeGuardRef.current.resetScope(
      projId ? { projectId: projId } : null,
    );
    historyScopeGuardRef.current.resetScope(null);

    setModules([]);
    setModulesCursor(null);
    setLoadingMoreModules(false);
    setMembers([]);
    setLoading(false);
    setSelectedModule(null);
    setVersionHistory([]);
    setHistoryCursor(null);
    setLoadingHistory(false);
    setLoadingMoreHistory(false);
    setRegisterModalOpen(false);
    setRegisterTargetModule(null);
    setReviewTargetModule(null);
    setError(null);

    if (projId) {
      loadModules(projId);
    }

    return () => {
      moduleScopeGuardRef.current.resetScope(null);
      historyScopeGuardRef.current.resetScope(null);
    };
  }, [currentProject?.id, loadModules]);

  const handleLoadMoreModules = async () => {
    if (!currentProject || !modulesCursor || loadingMoreModules) return;
    const projId = currentProject.id;
    const scope = { projectId: projId };
    const { isValid } = moduleScopeGuardRef.current.startRequest(scope);

    setLoadingMoreModules(true);
    try {
      const res = await fetchModulePage(defaultApiClient, projId, {
        cursor: modulesCursor,
        limit: 20,
      });
      if (!isValid()) return;
      setModules((prev) => mergeModuleRecords(prev, res.items));
      setModulesCursor(res.nextCursor || null);
    } catch (err) {
      if (!isValid()) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isValid()) {
        setLoadingMoreModules(false);
      }
    }
  };

  const loadVersionHistory = async (moduleName: string) => {
    if (!currentProject) return;
    const projId = currentProject.id;
    const scope = { projectId: projId, moduleName };
    const { isValid } = historyScopeGuardRef.current.startRequest(scope);

    setLoadingHistory(true);
    setLoadingMoreHistory(false);
    setVersionHistory([]);
    setHistoryCursor(null);
    try {
      const res = await fetchModuleVersionPage(
        defaultApiClient,
        projId,
        moduleName,
        { limit: 20 },
      );
      if (!isValid()) return;
      setVersionHistory(res.items);
      setHistoryCursor(res.nextCursor || null);
    } catch (err) {
      if (!isValid()) return;
      console.warn('Failed to load version history:', err);
    } finally {
      if (isValid()) {
        setLoadingHistory(false);
      }
    }
  };

  const handleLoadMoreHistory = async () => {
    if (
      !currentProject ||
      !selectedModule ||
      !historyCursor ||
      loadingMoreHistory
    )
      return;
    const projId = currentProject.id;
    const modName = selectedModule.name;
    const scope = { projectId: projId, moduleName: modName };
    const { isValid } = historyScopeGuardRef.current.startRequest(scope);

    setLoadingMoreHistory(true);
    try {
      const res = await fetchModuleVersionPage(
        defaultApiClient,
        projId,
        modName,
        {
          cursor: historyCursor,
          limit: 20,
        },
      );
      if (!isValid()) return;
      setVersionHistory((prev) => mergeModuleRecords(prev, res.items));
      setHistoryCursor(res.nextCursor || null);
    } catch (err) {
      if (!isValid()) return;
      console.warn('Failed to load more version history:', err);
    } finally {
      if (isValid()) {
        setLoadingMoreHistory(false);
      }
    }
  };

  const handleSelectModule = (mod: RegressionModuleRecord) => {
    setSelectedModule(mod);
    loadVersionHistory(mod.name);
  };

  const handleCloseHistory = () => {
    historyScopeGuardRef.current.resetScope(null);
    setSelectedModule(null);
    setVersionHistory([]);
    setHistoryCursor(null);
    setLoadingHistory(false);
    setLoadingMoreHistory(false);
  };

  const handleOpenRegisterNew = () => {
    setRegisterTargetModule(null);
    setRegisterModalOpen(true);
  };

  const handleOpenNewVersion = (mod: RegressionModuleRecord) => {
    const { latestVersion, latestDocument } = resolveLatestModuleVersion(
      mod,
      modules,
      versionHistory,
    );
    setRegisterTargetModule({
      name: mod.name,
      latestVersion,
      latestDocument,
    });
    setRegisterModalOpen(true);
  };

  const handleOpenReview = (mod: RegressionModuleRecord) => {
    setReviewTargetModule(mod);
  };

  return (
    <Page testId="modules-page">
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '20px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>
              受控回归模块库 (Regression Modules)
            </h1>
            <span className="badge badge-primary">{permissions.roleLabel}</span>
          </div>
          <p
            style={{
              fontSize: '0.875rem',
              color: 'var(--color-text-muted)',
              marginTop: '4px',
            }}
          >
            管理跨用例复用的受控步骤模块，支持版本递增注册、真实 Canonical JSON
            指纹与 Owner 两阶段人工审批基线。
          </p>
        </div>

        <div>
          <button
            className="btn btn-primary"
            onClick={handleOpenRegisterNew}
            disabled={!permissions.canRegister}
            title={
              !permissions.canRegister
                ? '仅 Owner 和 Operator 具备模块注册权限'
                : undefined
            }
            data-testid="btn-register-module"
          >
            + 注册受控模块
          </button>
        </div>
      </div>

      {/* Role permission info banner */}
      {permissions.isReadOnly && (
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
        >
          🔒
          当前账号为查看者（Viewer）角色，拥有只读查看模块与历史指纹权限，无法提交注册或执行审批。
        </div>
      )}

      {error && (
        <div
          className="card"
          style={{
            padding: '12px 16px',
            backgroundColor: 'var(--color-danger-bg)',
            borderColor: 'var(--color-danger-border)',
            color: 'var(--color-danger-text)',
            marginBottom: '16px',
          }}
        >
          {error}
        </div>
      )}

      {/* Modules Table */}
      <div className="card" style={{ marginBottom: '24px' }}>
        <div
          className="card-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <h2 className="card-title">
            项目模块列表 ({modules.length} 个受控模块)
          </h2>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => loadModules()}
            disabled={loading}
          >
            刷新
          </button>
        </div>

        {loading ? (
          <div
            style={{
              padding: '32px',
              textAlign: 'center',
              color: 'var(--color-text-muted)',
            }}
          >
            加载模块数据中...
          </div>
        ) : modules.length === 0 ? (
          <div
            style={{
              padding: '32px',
              textAlign: 'center',
              color: 'var(--color-text-muted)',
            }}
          >
            当前项目暂无受控回归模块。点击右上角“+ 注册受控模块”开始创建。
          </div>
        ) : (
          <div className="table-responsive">
            <table className="table" data-testid="modules-table">
              <thead>
                <tr>
                  <th>模块标识 (Name)</th>
                  <th>当前最新版本</th>
                  <th>审查状态</th>
                  <th>文档指纹 (SHA-256)</th>
                  <th>创建者 / 时间</th>
                  <th>审批者 / 时间</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {modules.map((mod) => {
                  const isDraft = mod.reviewStatus === 'draft';
                  const isSelected =
                    selectedModule?.name === mod.name &&
                    selectedModule?.version === mod.version;

                  return (
                    <tr
                      key={`${mod.name}-v${mod.version}`}
                      style={{
                        backgroundColor: isSelected
                          ? 'var(--color-primary-subtle)'
                          : undefined,
                      }}
                      data-testid={`module-row-${mod.name}`}
                    >
                      <td>
                        <strong>{mod.name}</strong>
                        <div
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--color-text-muted)',
                          }}
                        >
                          {mod.document.name}
                        </div>
                      </td>
                      <td>
                        <span className="badge badge-neutral">
                          v{mod.version}
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={mod.reviewStatus} size="sm" />
                        {isDraft && (
                          <span
                            style={{
                              marginLeft: '6px',
                              fontSize: '0.7rem',
                              color: 'var(--color-warning-text)',
                            }}
                          >
                            (待审批)
                          </span>
                        )}
                      </td>
                      <td>
                        <code
                          style={{ fontSize: '0.75rem' }}
                          title={mod.sha256}
                        >
                          {mod.sha256.slice(0, 16)}...
                        </code>
                      </td>
                      <td style={{ fontSize: '0.8rem' }}>
                        <div>
                          {mod.createdBy
                            ? `用户 ${mod.createdBy.slice(0, 8)}`
                            : '系统'}
                        </div>
                        <div style={{ color: 'var(--color-text-muted)' }}>
                          {mod.createdAt
                            ? new Date(mod.createdAt).toLocaleDateString()
                            : '历史基线'}
                        </div>
                      </td>
                      <td style={{ fontSize: '0.8rem' }}>
                        <div>
                          {mod.reviewedBy
                            ? `审批者 ${mod.reviewedBy.slice(0, 8)}`
                            : '-'}
                        </div>
                        <div style={{ color: 'var(--color-text-muted)' }}>
                          {mod.reviewedAt
                            ? new Date(mod.reviewedAt).toLocaleDateString()
                            : '-'}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'flex-end',
                            gap: '6px',
                          }}
                        >
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleSelectModule(mod)}
                            data-testid={`btn-view-history-${mod.name}`}
                          >
                            历史版本
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleOpenNewVersion(mod)}
                            disabled={!permissions.canRegister}
                            data-testid={`btn-new-version-${mod.name}`}
                          >
                            发布新版
                          </button>
                          {isDraft && permissions.canReview && (
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => handleOpenReview(mod)}
                              data-testid={`btn-review-${mod.name}`}
                            >
                              审批
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {modulesCursor && (
          <div
            style={{
              padding: '12px 16px',
              textAlign: 'center',
              borderTop: '1px solid var(--color-border)',
            }}
          >
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleLoadMoreModules}
              disabled={loadingMoreModules}
              data-testid="btn-load-more-modules"
            >
              {loadingMoreModules
                ? '加载更多模块中...'
                : '加载更多模块 (下一页)'}
            </button>
          </div>
        )}
      </div>

      {/* Version History Drawer / Card */}
      {selectedModule && (
        <div
          className="card"
          style={{
            borderLeft: '4px solid var(--color-primary)',
            marginBottom: '24px',
          }}
          data-testid="module-history-card"
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px',
            }}
          >
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>
                模块版本历史: <code>{selectedModule.name}</code>
              </h3>
              <span
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--color-text-muted)',
                }}
              >
                展示该模块全量历史版本快照，只有 approved
                状态版本可供受控用例执行
              </span>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleCloseHistory}
            >
              收起
            </button>
          </div>

          {loadingHistory ? (
            <div style={{ padding: '16px', textAlign: 'center' }}>
              加载版本历史...
            </div>
          ) : (
            <div className="table-responsive">
              <table className="table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>状态</th>
                    <th>文档完整 SHA-256</th>
                    <th>准则数</th>
                    <th>步骤数</th>
                    <th>创建信息</th>
                    <th>审查审批信息</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {versionHistory.map((ver) => {
                    const isDraft = ver.reviewStatus === 'draft';
                    return (
                      <tr
                        key={ver.version}
                        data-testid={`version-row-${ver.version}`}
                      >
                        <td>
                          <strong>v{ver.version}</strong>
                        </td>
                        <td>
                          <StatusBadge status={ver.reviewStatus} size="sm" />
                          {isDraft && (
                            <div
                              style={{
                                fontSize: '0.7rem',
                                color: 'var(--color-warning-text)',
                                marginTop: '2px',
                              }}
                            >
                              草稿待审 (未批准，不可用于回归执行)
                            </div>
                          )}
                        </td>
                        <td>
                          <code style={{ fontSize: '0.75rem' }}>
                            {ver.sha256}
                          </code>
                        </td>
                        <td>{ver.document.criteria.length} 项</td>
                        <td>{ver.document.steps.length} 步</td>
                        <td style={{ fontSize: '0.8rem' }}>
                          <div>{ver.createdBy || '系统导入'}</div>
                          <div style={{ color: 'var(--color-text-muted)' }}>
                            {ver.createdAt
                              ? new Date(ver.createdAt).toLocaleString()
                              : '历史数据'}
                          </div>
                        </td>
                        <td style={{ fontSize: '0.8rem' }}>
                          <div>
                            {ver.reviewedBy
                              ? `审批者: ${ver.reviewedBy}`
                              : '待审批'}
                          </div>
                          <div style={{ color: 'var(--color-text-muted)' }}>
                            {ver.reviewedAt
                              ? new Date(ver.reviewedAt).toLocaleString()
                              : '-'}
                          </div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleOpenNewVersion(ver)}
                              disabled={!permissions.canRegister}
                              data-testid={`btn-new-version-from-history-${ver.version}`}
                            >
                              发布新版
                            </button>
                            {isDraft && permissions.canReview && (
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => handleOpenReview(ver)}
                                data-testid={`btn-review-version-${ver.version}`}
                              >
                                审查审批
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {historyCursor && (
            <div
              style={{
                padding: '12px 16px',
                textAlign: 'center',
                borderTop: '1px solid var(--color-border)',
              }}
            >
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleLoadMoreHistory}
                disabled={loadingMoreHistory}
                data-testid="btn-load-more-history"
              >
                {loadingMoreHistory
                  ? '加载更多版本历史中...'
                  : '加载更多版本历史 (下一页)'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Registration Modal */}
      {registerModalOpen && currentProject && (
        <ModuleRegisterModal
          projectId={currentProject.id}
          isOpen={registerModalOpen}
          existingModule={registerTargetModule}
          onClose={() => setRegisterModalOpen(false)}
          onCreated={(newMod) => {
            loadModules();
            if (selectedModule?.name === newMod.name) {
              loadVersionHistory(newMod.name);
            }
          }}
        />
      )}

      {/* Two-Stage Review Modal */}
      {reviewTargetModule && currentProject && (
        <ModuleReviewModal
          projectId={currentProject.id}
          module={reviewTargetModule}
          isOpen={!!reviewTargetModule}
          onClose={() => setReviewTargetModule(null)}
          onReviewed={() => {
            loadModules();
            if (selectedModule?.name === reviewTargetModule.name) {
              loadVersionHistory(reviewTargetModule.name);
            }
          }}
        />
      )}
    </Page>
  );
};
