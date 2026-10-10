import React, { useState } from 'react';
import type {
  RegressionModuleRecord,
  RegressionModuleReviewPreview,
} from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
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

  return (
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      data-testid="module-review-modal"
    >
      <div
        className="card"
        style={{
          width: '90%',
          maxWidth: '680px',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '24px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
          }}
        >
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>
            两阶段人工审批: {module.name} (v{module.version})
          </h2>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Target Module Metadata */}
        <div
          style={{
            padding: '10px 14px',
            backgroundColor: 'var(--color-bg-subtle)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.8rem',
            marginBottom: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          <div>
            <strong>目标模块:</strong> <code>{module.name}</code> (版本 v
            {module.version})
          </div>
          <div>
            <strong>文档指纹 (SHA-256):</strong> <code>{module.sha256}</code>
          </div>
          <div>
            <strong>当前状态:</strong>{' '}
            <span
              className={`badge ${module.reviewStatus === 'draft' ? 'badge-warning' : 'badge-neutral'}`}
            >
              {module.reviewStatus.toUpperCase()}
            </span>
          </div>
        </div>

        {error && (
          <div
            className="card"
            style={{
              padding: '8px 12px',
              backgroundColor: 'var(--color-danger-bg)',
              borderColor: 'var(--color-danger-border)',
              color: 'var(--color-danger-text)',
              marginBottom: '16px',
              fontSize: '0.85rem',
            }}
            data-testid="module-review-error"
          >
            {error}
          </div>
        )}

        {/* Stage 1: Form & Generate Preview */}
        <form onSubmit={handleGeneratePreview}>
          <div style={{ marginBottom: '16px' }}>
            <label
              style={{
                display: 'block',
                fontWeight: 600,
                fontSize: '0.85rem',
                marginBottom: '6px',
              }}
            >
              审批决议 (Decision)
            </label>
            <div style={{ display: 'flex', gap: '16px' }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="review-decision"
                  value="approve"
                  checked={decision === 'approve'}
                  onChange={() => handleDecisionChange('approve')}
                  disabled={loading}
                />
                <span
                  style={{
                    fontWeight: 600,
                    color: 'var(--color-success-text)',
                  }}
                >
                  ✓ 批准 (Approve)
                </span>
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="review-decision"
                  value="reject"
                  checked={decision === 'reject'}
                  onChange={() => handleDecisionChange('reject')}
                  disabled={loading}
                />
                <span
                  style={{ fontWeight: 600, color: 'var(--color-danger-text)' }}
                >
                  ✗ 驳回 (Reject)
                </span>
              </label>
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label
              style={{
                display: 'block',
                fontWeight: 600,
                fontSize: '0.85rem',
                marginBottom: '6px',
              }}
            >
              决议说明与审查理由 (Reason)
            </label>
            <textarea
              className="form-input"
              rows={3}
              value={reason}
              onChange={(e) => handleReasonChange(e.target.value)}
              disabled={loading}
              placeholder="请输入清晰可审查的人工审查理由..."
              style={{ width: '100%', fontSize: '0.85rem' }}
              data-testid="module-review-reason-input"
            />
            {preview === null && reason.trim().length > 0 && (
              <span
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--color-text-muted)',
                }}
              >
                * 输入内容已修改，须点击下方生成审查预览
              </span>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginBottom: '16px',
            }}
          >
            <button
              type="submit"
              className="btn btn-secondary btn-sm"
              disabled={loading || !reason.trim()}
              data-testid="btn-generate-module-preview"
            >
              {loading ? '生成中...' : '第 1 阶段：生成审查预览'}
            </button>
          </div>
        </form>

        {/* Stage 2: Preview Confirmation Card */}
        {preview && (
          <div
            className="card"
            style={{
              backgroundColor: 'var(--color-bg-subtle)',
              border: '2px solid var(--color-primary-border)',
              padding: '16px',
              marginBottom: '20px',
            }}
            data-testid="module-review-preview-card"
          >
            <div
              style={{
                fontWeight: 700,
                fontSize: '0.9rem',
                color: 'var(--color-primary)',
                marginBottom: '8px',
              }}
            >
              第 2 阶段：核验审查预览并确认提交
            </div>

            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--color-text-muted)',
                marginBottom: '8px',
              }}
            >
              确认 Token:{' '}
              <code>{preview.confirmationToken.slice(0, 16)}...</code> |
              有效截至: {new Date(preview.expiresAt).toLocaleTimeString()}
            </div>

            <div style={{ marginBottom: '10px' }}>
              <strong style={{ fontSize: '0.8rem' }}>变更概要:</strong>
              <pre
                style={{
                  backgroundColor: 'var(--color-bg-surface)',
                  padding: '8px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.75rem',
                  fontFamily: 'monospace',
                  margin: '4px 0',
                  maxHeight: '120px',
                  overflowY: 'auto',
                }}
              >
                {preview.diff}
              </pre>
            </div>

            {preview.risks.length > 0 && (
              <div style={{ marginBottom: '12px' }}>
                <strong
                  style={{
                    fontSize: '0.8rem',
                    color: 'var(--color-warning-text)',
                  }}
                >
                  风险提示:
                </strong>
                <ul
                  style={{
                    margin: '4px 0 0 16px',
                    fontSize: '0.75rem',
                    color: 'var(--color-warning-text)',
                  }}
                >
                  {preview.risks.map((risk, idx) => (
                    <li key={idx}>{risk}</li>
                  ))}
                </ul>
              </div>
            )}

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
              }}
            >
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setPreview(null)}
                disabled={loading}
              >
                重设预览
              </button>
              <button
                type="button"
                className={`btn ${decision === 'approve' ? 'btn-primary' : 'btn-danger'} btn-sm`}
                onClick={handleConfirmReview}
                disabled={loading}
                data-testid="btn-confirm-module-review"
              >
                {loading
                  ? '提交确认中...'
                  : decision === 'approve'
                    ? '确认批准生效 (Commit Approve)'
                    : '确认驳回该版本 (Commit Reject)'}
              </button>
            </div>
          </div>
        )}

        <div
          style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}
        >
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={loading}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
