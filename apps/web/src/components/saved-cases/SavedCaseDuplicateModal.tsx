import React, { useState, useEffect, useRef } from 'react';
import type { SavedCase, SavedCaseVersion } from '../../api/types.ts';
import type { Member } from '@localqa/contracts';
import { useApp } from '../../state/AppContext.tsx';
import { defaultApiClient } from '../../api/index.ts';
import { ErrorCard } from '../ui/ErrorCard.tsx';
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';
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

  const close = () => {
    if (!loading) onClose();
  };

  return (
    <Modal
      title="复制用例"
      description={
        <>
          源用例 <code>{caseRecord.slug}</code>（{caseRecord.name}）
        </>
      }
      onClose={close}
      closeOnOverlay={false}
      overlayTestId="saved-case-duplicate-modal"
      closeTestId="btn-cancel-duplicate"
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={close}
            disabled={loading}
          >
            取消
          </button>
          <button
            type="submit"
            form="duplicate-case-form"
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
                : '复制为新用例'}
          </button>
        </>
      }
    >
      <form id="duplicate-case-form" onSubmit={handleSubmit}>
        <div className="stack stack-sm lqa-modal-alert">
          {error && <ErrorCard message={error} />}
          <Alert tone="info" title="副本是独立的草稿">
            复制会在目标项目中创建全新的独立用例，初始版本
            <strong>始终为未批准的草稿</strong>
            ，需要目标项目负责人审批后才能成为回归基线。
          </Alert>
        </div>

        <Field
          label="来源版本"
          required
          htmlFor="select-source-version"
          hint={
            selectedVer
              ? `创建于 ${new Date(selectedVer.createdAt).toLocaleString()} · 包含 ${selectedVer.document.steps?.length ?? 0} 个步骤`
              : undefined
          }
        >
          <select
            id="select-source-version"
            className="input"
            value={sourceVersionId}
            onChange={(e) => setSourceVersionId(e.target.value)}
            required
            data-testid="select-source-version"
          >
            {caseVersions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version} ·{' '}
                {v.reviewStatus === 'approved' ? '已批准基线' : '草稿'}（SHA{' '}
                {v.sha256.slice(0, 10)}…）
              </option>
            ))}
          </select>
        </Field>

        <Field label="目标项目" htmlFor="select-target-project">
          <select
            id="select-target-project"
            className="input"
            value={targetProjectId}
            onChange={(e) => setTargetProjectId(e.target.value)}
            data-testid="select-target-project"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === currentProject?.id ? '（当前项目）' : ''}
              </option>
            ))}
          </select>
        </Field>

        {!loadingTargetMembers && !hasTargetOperatorPlus && (
          <Alert
            tone="danger"
            title="权限不足"
            testId="target-permission-warning"
            className="lqa-modal-alert"
          >
            你在所选目标项目中只有只读权限或不是成员。跨项目复制需要目标项目的操作员或负责人权限。
          </Alert>
        )}

        <Field
          label="新用例标识（Slug）"
          required
          htmlFor="input-duplicate-slug"
          hint="只允许小写字母、数字、点、下划线和中划线。"
        >
          <input
            id="input-duplicate-slug"
            type="text"
            className="input is-mono"
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value)}
            placeholder="例如 checkout-flow-variant"
            required
            data-testid="input-duplicate-slug"
          />
        </Field>

        <Field label="新用例名称" required htmlFor="input-duplicate-name">
          <input
            id="input-duplicate-name"
            type="text"
            className="input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="例如 购物车优惠券抵扣结算流程（新变体）"
            required
            data-testid="input-duplicate-name"
          />
        </Field>
      </form>
    </Modal>
  );
};
