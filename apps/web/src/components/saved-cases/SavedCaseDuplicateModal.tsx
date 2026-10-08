import React, { useState, useEffect, useRef } from 'react';
import type { SavedCase, SavedCaseVersion } from '../../api/types.ts';
import type { Member } from '@localqa/contracts';
import { useApp } from '../../state/AppContext.tsx';
import { defaultApiClient } from '../../api/index.ts';
import { ErrorCard } from '../ui/ErrorCard.tsx';
import {
  LifecycleScopeGuard,
  isSameCaseId,
} from '../../utils/lifecycleScope.ts';

export interface SavedCaseDuplicateModalProps {
  caseRecord: SavedCase | null;
  versions: SavedCaseVersion[];
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (newCase: SavedCase) => void;
}

const SLUG_REGEX = /^[a-zA-Z0-9_.-]+$/;

export const SavedCaseDuplicateModal: React.FC<
  SavedCaseDuplicateModalProps
> = ({ caseRecord, versions, isOpen, onClose, onSuccess }) => {
  const { currentProject, projects, currentUser } = useApp();

  const [sourceVersionId, setSourceVersionId] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newName, setNewName] = useState('');
  const [targetProjectId, setTargetProjectId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Target project member check state
  const [targetMembers, setTargetMembers] = useState<Member[]>([]);
  const [loadingTargetMembers, setLoadingTargetMembers] = useState(false);

  const scopeGuardRef = useRef(new LifecycleScopeGuard());
  const targetScopeGuardRef = useRef(new LifecycleScopeGuard());

  const caseVersions = caseRecord
    ? versions.filter((v) => !v.caseId || isSameCaseId(v.caseId, caseRecord.id))
    : [];

  useEffect(() => {
    if (isOpen && caseRecord) {
      scopeGuardRef.current.resetScope({
        projectId: caseRecord.projectId,
        caseId: caseRecord.id,
      });
      const validVers = versions.filter(
        (v) => !v.caseId || isSameCaseId(v.caseId, caseRecord.id),
      );
      const initVerId =
        caseRecord.currentApprovedVersionId || (validVers[0]?.id ?? '');
      setSourceVersionId(initVerId);
      setNewSlug(`${caseRecord.slug}-copy`);
      setNewName(`${caseRecord.name} (副本)`);
      setTargetProjectId(caseRecord.projectId || currentProject?.id || '');
      setError(null);
      setLoading(false);
    } else {
      scopeGuardRef.current.resetScope(null);
      targetScopeGuardRef.current.resetScope(null);
      setLoading(false);
      setError(null);
      setTargetMembers([]);
      setLoadingTargetMembers(false);
    }

    return () => {
      scopeGuardRef.current.resetScope(null);
      targetScopeGuardRef.current.resetScope(null);
    };
  }, [isOpen, caseRecord, versions, currentProject?.id]);

  // Load target project members when targetProjectId changes
  useEffect(() => {
    if (!isOpen || !targetProjectId) {
      targetScopeGuardRef.current.resetScope(null);
      setTargetMembers([]);
      setLoadingTargetMembers(false);
      return;
    }

    const scopeContext = { projectId: targetProjectId, caseId: caseRecord?.id };
    targetScopeGuardRef.current.resetScope(scopeContext);
    const { isValid } = targetScopeGuardRef.current.startRequest(scopeContext);

    setLoadingTargetMembers(true);
    defaultApiClient
      .listMembers(targetProjectId)
      .then((res) => {
        if (!isValid()) return;
        setTargetMembers(res.items || []);
      })
      .catch(() => {
        if (!isValid()) return;
        setTargetMembers([]);
      })
      .finally(() => {
        if (isValid()) {
          setLoadingTargetMembers(false);
        }
      });

    return () => {
      targetScopeGuardRef.current.resetScope(null);
      setLoadingTargetMembers(false);
    };
  }, [isOpen, targetProjectId, caseRecord?.id]);

  const isGlobalAdmin = currentUser?.globalRole === 'admin';
  const targetMember = targetMembers.find((m) =>
    isSameCaseId(m.userId, currentUser?.id),
  );
  const hasTargetOperatorPlus =
    isGlobalAdmin ||
    targetMember?.role === 'owner' ||
    targetMember?.role === 'operator';

  if (!isOpen || !caseRecord) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedSlug = newSlug.trim();
    const trimmedName = newName.trim();

    if (!trimmedSlug || !SLUG_REGEX.test(trimmedSlug)) {
      setError('Slug 格式不合法：只允许字母、数字、下划线、短横线与点号');
      return;
    }
    if (!trimmedName) {
      setError('用例名称不能为空');
      return;
    }
    if (!sourceVersionId) {
      setError('请选择要复制的源版本');
      return;
    }
    if (!hasTargetOperatorPlus) {
      setError(
        '目标项目权限不足：创建用例副本要求目标项目的操作员 (Operator) 或所有者 (Owner) 权限',
      );
      return;
    }

    const submitScopeContext = {
      projectId: targetProjectId,
      caseId: caseRecord.id,
    };
    const { isValid } =
      targetScopeGuardRef.current.captureScope(submitScopeContext);

    if (!isValid()) return;
    setLoading(true);
    setError(null);
    try {
      const created = await defaultApiClient.duplicateSavedCase(caseRecord.id, {
        newSlug: trimmedSlug,
        newName: trimmedName,
        sourceVersionId,
        targetProjectId: targetProjectId || undefined,
      });
      if (!isValid()) return;
      onSuccess(created);
    } catch (err) {
      if (!isValid()) return;
      setError(err instanceof Error ? err.message : '复制用例失败');
    } finally {
      if (isValid()) {
        setLoading(false);
      }
    }
  };

  const selectedVer = caseVersions.find((v) =>
    isSameCaseId(v.id, sourceVersionId),
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '20px',
      }}
      data-testid="saved-case-duplicate-modal"
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: '560px',
          maxHeight: '90vh',
          overflowY: 'auto',
          backgroundColor: 'var(--color-bg-surface)',
          padding: 0,
        }}
      >
        <div
          className="card-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 20px',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <div>
            <h3
              className="card-title"
              style={{ margin: 0, fontSize: '1.1rem' }}
            >
              复制测试用例副本 (Duplicate Case)
            </h3>
            <span
              style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}
            >
              源用例: <code>{caseRecord.slug}</code> ({caseRecord.name})
            </span>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            disabled={loading}
            data-testid="btn-cancel-duplicate"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px' }}>
          {error && (
            <div style={{ marginBottom: '16px' }}>
              <ErrorCard message={error} />
            </div>
          )}

          {/* Safety Notice */}
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: 'var(--radius-md)',
              color: '#1e40af',
              fontSize: '0.8rem',
              marginBottom: '16px',
            }}
          >
            🔒 <strong>受控副本说明：</strong>
            复制操作将在目标项目中创建全新的独立用例，其初始版本
            <strong>始终为未批准草稿 (Draft)</strong>。需要目标项目管理员
            (Owner) 人工审批后方可纳入回归基线。
          </div>

          {/* Source Version Selection */}
          <div style={{ marginBottom: '14px' }}>
            <label
              style={{
                display: 'block',
                fontSize: '0.85rem',
                fontWeight: 600,
                marginBottom: '4px',
              }}
            >
              来源快照版本 (Source Version) *
            </label>
            <select
              className="input"
              value={sourceVersionId}
              onChange={(e) => setSourceVersionId(e.target.value)}
              required
              data-testid="select-source-version"
              style={{ width: '100%' }}
            >
              {caseVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version} ·{' '}
                  {v.reviewStatus === 'approved' ? '✓ 已批准基线' : '⏳ 草稿'}{' '}
                  (SHA: {v.sha256.slice(0, 10)}...)
                </option>
              ))}
            </select>
            {selectedVer && (
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--color-text-muted)',
                  marginTop: '4px',
                }}
              >
                选定版本创建于:{' '}
                {new Date(selectedVer.createdAt).toLocaleString()} · 包含{' '}
                {selectedVer.document.steps?.length ?? 0} 个步骤
              </div>
            )}
          </div>

          {/* Target Project Selection */}
          <div style={{ marginBottom: '14px' }}>
            <label
              style={{
                display: 'block',
                fontSize: '0.85rem',
                fontWeight: 600,
                marginBottom: '4px',
              }}
            >
              目标项目 (Target Project)
            </label>
            <select
              className="input"
              value={targetProjectId}
              onChange={(e) => setTargetProjectId(e.target.value)}
              data-testid="select-target-project"
              style={{ width: '100%' }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.id === currentProject?.id ? '(当前项目)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Target Project Permission Warning */}
          {!loadingTargetMembers && !hasTargetOperatorPlus && (
            <div
              style={{
                padding: '10px 14px',
                backgroundColor: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 'var(--radius-md)',
                color: '#991b1b',
                fontSize: '0.8rem',
                marginBottom: '16px',
              }}
              data-testid="target-permission-warning"
            >
              ⚠️ <strong>权限不足：</strong>
              您在所选目标项目中仅有只读权限 (Viewer)
              或非成员。跨项目复制要求目标项目的操作员 (Operator) 或所有者
              (Owner) 权限。
            </div>
          )}

          {/* New Slug */}
          <div style={{ marginBottom: '14px' }}>
            <label
              style={{
                display: 'block',
                fontSize: '0.85rem',
                fontWeight: 600,
                marginBottom: '4px',
              }}
            >
              新用例唯一标识 (New Slug) *
            </label>
            <input
              type="text"
              className="input"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder="e.g. checkout-flow-variant"
              required
              data-testid="input-duplicate-slug"
              style={{ width: '100%' }}
            />
            <span
              style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}
            >
              限小写字母、数字、点号、下划线及短横线
            </span>
          </div>

          {/* New Name */}
          <div style={{ marginBottom: '20px' }}>
            <label
              style={{
                display: 'block',
                fontSize: '0.85rem',
                fontWeight: 600,
                marginBottom: '4px',
              }}
            >
              新用例标题 (New Name) *
            </label>
            <input
              type="text"
              className="input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. 购物车优惠券抵扣结算流程 (新变体)"
              required
              data-testid="input-duplicate-name"
              style={{ width: '100%' }}
            />
          </div>

          {/* Actions */}
          <div
            style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={loading}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                loading ||
                loadingTargetMembers ||
                !hasTargetOperatorPlus ||
                !newSlug.trim() ||
                !newName.trim() ||
                !sourceVersionId
              }
              data-testid="btn-submit-duplicate"
            >
              {loading
                ? '正在复制...'
                : loadingTargetMembers
                  ? '正在核验权限...'
                  : '确认复制为新用例'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
