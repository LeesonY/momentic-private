import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { RegressionModuleRecord, Member } from '@localqa/contracts';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { Section } from '../components/ui/Section.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
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
    <Page
      testId="modules-page"
      width="wide"
      title={
        <>
          模块库
          <span className="badge badge-primary">{permissions.roleLabel}</span>
        </>
      }
      description="管理可被多个用例复用的受控步骤模块：按版本递增注册，以 Canonical JSON 指纹标识内容，并经负责人两阶段人工审批后才能用于回归。"
      actions={
        <button
          className="btn btn-primary"
          onClick={handleOpenRegisterNew}
          disabled={!permissions.canRegister}
          title={
            !permissions.canRegister
              ? '仅负责人和操作员可以注册模块'
              : undefined
          }
          data-testid="btn-register-module"
        >
          <AppIcon name="plus" size={15} />
          注册模块
        </button>
      }
    >
      {permissions.isReadOnly && (
        <Alert tone="info">
          当前账号为只读成员，可以查看模块与历史指纹，但不能注册或审批。
        </Alert>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      <Section
        icon="boxes"
        title="项目模块"
        description={`共 ${modules.length} 个受控模块`}
        actions={
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => loadModules()}
            disabled={loading}
          >
            <AppIcon name="refresh" size={13} />
            刷新
          </button>
        }
      >
        {loading ? (
          <p className="muted text-sm">加载模块数据中...</p>
        ) : modules.length === 0 ? (
          <EmptyState
            compact
            icon="boxes"
            title="暂无受控模块"
            description="点击右上角「注册模块」，把可复用的步骤沉淀为模块。"
          />
        ) : (
          <div className="table-container">
            <table className="data-table" data-testid="modules-table">
              <thead>
                <tr>
                  <th>模块</th>
                  <th>最新版本</th>
                  <th>审查状态</th>
                  <th>文档指纹</th>
                  <th>创建</th>
                  <th>审批</th>
                  <th className="cell-actions">操作</th>
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
                      className={isSelected ? 'is-selected' : ''}
                      data-testid={`module-row-${mod.name}`}
                    >
                      <td>
                        <div className="cell-title mono">{mod.name}</div>
                        <div className="cell-sub">{mod.document.name}</div>
                      </td>
                      <td>
                        <span className="badge badge-neutral">
                          v{mod.version}
                        </span>
                      </td>
                      <td>
                        <StatusBadge status={mod.reviewStatus} size="sm" />
                      </td>
                      <td>
                        <code className="text-xs" title={mod.sha256}>
                          {mod.sha256.slice(0, 16)}…
                        </code>
                      </td>
                      <td className="text-sm">
                        {mod.createdBy
                          ? `用户 ${mod.createdBy.slice(0, 8)}`
                          : '系统'}
                        <div className="cell-sub">
                          {mod.createdAt
                            ? new Date(mod.createdAt).toLocaleDateString()
                            : '历史基线'}
                        </div>
                      </td>
                      <td className="text-sm">
                        {mod.reviewedBy ? (
                          `审批者 ${mod.reviewedBy.slice(0, 8)}`
                        ) : (
                          <span className="subtle">—</span>
                        )}
                        <div className="cell-sub">
                          {mod.reviewedAt
                            ? new Date(mod.reviewedAt).toLocaleDateString()
                            : ''}
                        </div>
                      </td>
                      <td className="cell-actions">
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleSelectModule(mod)}
                          data-testid={`btn-view-history-${mod.name}`}
                        >
                          历史版本
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {modulesCursor && (
          <div className="lqa-load-more">
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleLoadMoreModules}
              disabled={loadingMoreModules}
              data-testid="btn-load-more-modules"
            >
              {loadingMoreModules ? '加载更多模块中...' : '加载更多模块'}
            </button>
          </div>
        )}
      </Section>

      {selectedModule && (
        <Section
          icon="history"
          title={
            <>
              版本历史 · <code>{selectedModule.name}</code>
            </>
          }
          description="列出该模块的全部历史版本，只有已批准的版本可供受控用例执行。"
          testId="module-history-card"
          actions={
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleCloseHistory}
            >
              收起
            </button>
          }
        >
          {loadingHistory ? (
            <p className="muted text-sm">加载版本历史...</p>
          ) : (
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>状态</th>
                    <th>文档 SHA-256</th>
                    <th>准则</th>
                    <th>步骤</th>
                    <th>创建</th>
                    <th>审批</th>
                    <th className="cell-actions">操作</th>
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
                        <td className="strong">v{ver.version}</td>
                        <td>
                          <StatusBadge status={ver.reviewStatus} size="sm" />
                          {isDraft && (
                            <div className="cell-sub text-warning">
                              未批准，不可用于回归
                            </div>
                          )}
                        </td>
                        <td>
                          <code className="text-xs break-all">
                            {ver.sha256}
                          </code>
                        </td>
                        <td className="nowrap">
                          {ver.document.criteria.length} 项
                        </td>
                        <td className="nowrap">
                          {ver.document.steps.length} 步
                        </td>
                        <td className="text-sm">
                          {ver.createdBy || '系统导入'}
                          <div className="cell-sub">
                            {ver.createdAt
                              ? new Date(ver.createdAt).toLocaleString()
                              : '历史数据'}
                          </div>
                        </td>
                        <td className="text-sm">
                          {ver.reviewedBy
                            ? `审批者 ${ver.reviewedBy}`
                            : '待审批'}
                          <div className="cell-sub">
                            {ver.reviewedAt
                              ? new Date(ver.reviewedAt).toLocaleString()
                              : ''}
                          </div>
                        </td>
                        <td className="cell-actions">
                          <button
                            className="btn btn-ghost btn-sm"
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
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {historyCursor && (
            <div className="lqa-load-more">
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleLoadMoreHistory}
                disabled={loadingMoreHistory}
                data-testid="btn-load-more-history"
              >
                {loadingMoreHistory ? '加载更多版本历史中...' : '加载更多版本'}
              </button>
            </div>
          )}
        </Section>
      )}

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
