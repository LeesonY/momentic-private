import React, { useState } from 'react';
import type {
  RegressionModuleRecord,
  RegressionModuleReviewPreview,
} from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { Modal } from '../ui/Modal.tsx';
import { Alert } from '../ui/Alert.tsx';
import { StatusBadge } from '../ui/Badge.tsx';
import { validateModuleReviewPreview } from '../../utils/moduleRoles.ts';

interface ModuleReviewModalProps {
  projectId: string;
  module: RegressionModuleRecord;
  isOpen: boolean;
  onClose: () => void;
  onReviewed: (record: RegressionModuleRecord) => void;
}

export const ModuleReviewModal: React.FC<ModuleReviewModalProps> = ({
  projectId,
  module,
  isOpen,
  onClose,
  onReviewed,
}) => {
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<RegressionModuleReviewPreview | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  // Clear preview whenever decision or reason changes to enforce clean re-preview
  const handleDecisionChange = (newDecision: 'approve' | 'reject') => {
    setDecision(newDecision);
    setPreview(null);
    setError(null);
  };

  const handleReasonChange = (newReason: string) => {
    setReason(newReason);
    setPreview(null);
    setError(null);
  };

  // Stage 1: Generate review preview
  const handleGeneratePreview = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError('请输入审查决议理由说明 (Reason 必填)');
      return;
    }
    if (trimmedReason.length > 2000) {
      setError('审查理由说明不能超过 2000 字符');
      return;
    }

    try {
      setLoading(true);
      const res = await defaultApiClient.previewRegressionModuleReview(
        projectId,
        module.name,
        module.version,
        {
          expectedVersion: module.version,
          decision,
          reason: trimmedReason,
        },
      );

      // Verify invariant bounds on received preview
      const valResult = validateModuleReviewPreview(res, {
        projectId,
        moduleName: module.name,
        version: module.version,
        documentSha256: module.sha256,
        expectedVersion: module.version,
        decision,
        reason: trimmedReason,
      });

      if (!valResult.valid) {
        setError(`审查预览校验失败: ${valResult.issues.join('; ')}`);
        setPreview(null);
        return;
      }

      setPreview(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  // Stage 2: Confirm and commit review using preview token
  const handleConfirmReview = async () => {
    if (!preview) {
      setError('尚未生成审查预览，无法提交确认');
      return;
    }

    const trimmedReason = reason.trim();
    const valResult = validateModuleReviewPreview(preview, {
      projectId,
      moduleName: module.name,
      version: module.version,
      documentSha256: module.sha256,
      expectedVersion: module.version,
      decision,
      reason: trimmedReason,
    });

    if (!valResult.valid) {
      setError(`提交前校验失败: ${valResult.issues.join('; ')}`);
      return;
    }

    try {
      setLoading(true);
      const reviewed = await defaultApiClient.reviewRegressionModuleVersion(
        projectId,
        module.name,
        module.version,
        {
          expectedVersion: module.version,
          decision,
          reason: trimmedReason,
          confirmationToken: preview.confirmationToken,
        },
      );

      if (
        reviewed.name !== module.name ||
        reviewed.version !== module.version
      ) {
        throw new Error(
          `审批返回模块不匹配: 期望 ${module.name}@v${module.version}, 实际 ${reviewed.name}@v${reviewed.version}`,
        );
      }

      onReviewed(reviewed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const close = () => {
    if (!loading) onClose();
  };

  return (
    <Modal
      title={`两阶段人工审批：${module.name}（v${module.version}）`}
      onClose={close}
      size="lg"
      closeOnOverlay={false}
      overlayTestId="module-review-modal"
      footer={
        <button
          type="button"
          className="btn btn-ghost"
          onClick={close}
          disabled={loading}
        >
          关闭
        </button>
      }
    >
      <div className="stack">
        <dl className="kv panel">
          <dt>目标模块</dt>
          <dd>
            <code>{module.name}</code>（v{module.version}）
          </dd>
          <dt>文档指纹</dt>
          <dd>
            <code className="break-all">{module.sha256}</code>
          </dd>
          <dt>当前状态</dt>
          <dd>
            <StatusBadge status={module.reviewStatus} size="sm" />
          </dd>
        </dl>

        {error && (
          <Alert tone="danger" testId="module-review-error">
            {error}
          </Alert>
        )}

        <form onSubmit={handleGeneratePreview} className="stack stack-sm">
          <div className="section-label lqa-flush-label">
            第 1 阶段 · 填写决议并生成预览
          </div>
          <div className="lqa-choice-group">
            <label
              className={`lqa-choice ${decision === 'approve' ? 'is-selected is-success' : ''}`}
            >
              <input
                type="radio"
                name="review-decision"
                value="approve"
                checked={decision === 'approve'}
                onChange={() => handleDecisionChange('approve')}
                disabled={loading}
              />
              <span className="lqa-choice-title">批准</span>
            </label>
            <label
              className={`lqa-choice ${decision === 'reject' ? 'is-selected is-danger' : ''}`}
            >
              <input
                type="radio"
                name="review-decision"
                value="reject"
                checked={decision === 'reject'}
                onChange={() => handleDecisionChange('reject')}
                disabled={loading}
              />
              <span className="lqa-choice-title">驳回</span>
            </label>
          </div>

          <div className="field lqa-flush-field">
            <label className="field-label" htmlFor="module-review-reason">
              决议说明与审查理由
            </label>
            <textarea
              id="module-review-reason"
              className="form-textarea"
              rows={3}
              value={reason}
              onChange={(e) => handleReasonChange(e.target.value)}
              disabled={loading}
              placeholder="输入清晰、可审查的审查理由…"
              data-testid="module-review-reason-input"
            />
            {preview === null && reason.trim().length > 0 && (
              <p className="field-hint">内容有修改，需要重新生成审查预览。</p>
            )}
          </div>

          <div className="row">
            <button
              type="submit"
              className="btn btn-secondary btn-sm push"
              disabled={loading || !reason.trim()}
              data-testid="btn-generate-module-preview"
            >
              {loading ? '生成中...' : '生成审查预览'}
            </button>
          </div>
        </form>

        {preview && (
          <div
            className="panel stack stack-sm lqa-review-preview"
            data-testid="module-review-preview-card"
          >
            <div className="section-label lqa-flush-label">
              第 2 阶段 · 核对预览并确认提交
            </div>
            <p className="text-xs muted">
              确认令牌 <code>{preview.confirmationToken.slice(0, 16)}…</code>
              ，有效至 {new Date(preview.expiresAt).toLocaleTimeString()}
            </p>
            <div>
              <div className="text-sm strong">变更概要</div>
              <pre className="lqa-diff">{preview.diff}</pre>
            </div>
            {preview.risks.length > 0 && (
              <div className="alert alert-warning">
                <div className="alert-body">
                  <div className="alert-title">风险提示</div>
                  <ul className="lqa-bullets">
                    {preview.risks.map((risk, idx) => (
                      <li key={idx}>{risk}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <div className="row">
              <button
                type="button"
                className="btn btn-ghost btn-sm push"
                onClick={() => setPreview(null)}
                disabled={loading}
              >
                重新预览
              </button>
              <button
                type="button"
                className={`btn btn-sm ${decision === 'approve' ? 'btn-primary' : 'btn-danger'}`}
                onClick={handleConfirmReview}
                disabled={loading}
                data-testid="btn-confirm-module-review"
              >
                {loading
                  ? '提交确认中...'
                  : decision === 'approve'
                    ? '确认批准生效'
                    : '确认驳回该版本'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
