import React, { useState, useEffect } from 'react';
import type {
  SavedCase,
  SavedCaseVersion,
  ReviewPreview,
} from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';

interface SavedCaseReviewModalProps {
  caseRecord: SavedCase;
  caseVersion: SavedCaseVersion;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (updatedVersion: SavedCaseVersion) => void;
}

export const SavedCaseReviewModal: React.FC<SavedCaseReviewModalProps> = ({
  caseRecord,
  caseVersion,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [reason, setReason] = useState<string>('');
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState<
    number | null
  >(null);

  // Clear preview if version or decision or reason changes
  useEffect(() => {
    setPreview(null);
    setError(null);
  }, [caseVersion.id, caseVersion.version]);

  // Expiration countdown timer
  useEffect(() => {
    if (!preview?.expiresAt) {
      setTimeRemainingSeconds(null);
      return;
    }

    const updateTimer = () => {
      const remaining = Math.max(
        0,
        Math.floor((new Date(preview.expiresAt).getTime() - Date.now()) / 1000),
      );
      setTimeRemainingSeconds(remaining);
      if (remaining <= 0) {
        setPreview(null);
        setError('审查预览安全令牌已过期，请重新生成审查预览');
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [preview?.expiresAt]);

  if (!isOpen) return null;

  const handleDecisionChange = (newDecision: 'approve' | 'reject') => {
    setDecision(newDecision);
    if (preview) setPreview(null);
  };

  const handleReasonChange = (newReason: string) => {
    setReason(newReason);
    if (preview) setPreview(null);
  };

  const handleRequestPreview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError('请输入具体的审查判定理由（说明批准或拒绝的依据）');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const p = await defaultApiClient.previewSavedCaseReview(caseVersion.id, {
        expectedVersion: caseVersion.version,
        decision,
        reason: reason.trim(),
      });
      setPreview(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成审查预览失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!preview) return;
    if (timeRemainingSeconds !== null && timeRemainingSeconds <= 0) {
      setError('审查预览安全令牌已过期，请重新生成审查预览');
      setPreview(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const updated = await defaultApiClient.commitSavedCaseReview(
        caseVersion.id,
        {
          expectedVersion: preview.expectedVersion,
          decision: preview.decision,
          reason: preview.reason,
          confirmationToken: preview.confirmationToken,
        },
      );
      onSuccess(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '确认提交审查决议失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="dialog-overlay"
      onClick={onClose}
      data-testid="case-review-modal-overlay"
    >
      <div
        className="dialog-content"
        style={{
          maxWidth: '680px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid="case-review-modal-content"
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px',
            borderBottom: '1px solid var(--color-border-subtle)',
            paddingBottom: '12px',
          }}
        >
          <div>
            <h3 style={{ fontSize: '1.15rem', fontWeight: 600, margin: 0 }}>
              {preview
                ? '确认用例审查决议预览 (Review Preview)'
                : '人工审查用例版本 (Case Version Review)'}
            </h3>
            <p
              style={{
                fontSize: '0.85rem',
                color: 'var(--color-text-muted)',
                margin: '4px 0 0 0',
              }}
            >
              用例: <strong>{caseRecord.name}</strong> ({caseRecord.slug}) ·
              版本: <strong>v{caseVersion.version}</strong>
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            data-testid="btn-close-review-modal"
          >
            ✕
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'var(--color-danger-bg)',
              border: '1px solid var(--color-danger-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-danger-text)',
              marginBottom: '16px',
              fontSize: '0.85rem',
            }}
            data-testid="review-error-banner"
          >
            {error}
          </div>
        )}

        {!preview ? (
          /* Step 1: Decision & Audit Reason Form */
          <form onSubmit={handleRequestPreview}>
            <div style={{ marginBottom: '16px' }}>
              <label
                style={{
                  display: 'block',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  marginBottom: '8px',
                }}
              >
                审查决议 (Review Decision)
              </label>
              <div style={{ display: 'flex', gap: '16px' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                  }}
                >
                  <input
                    type="radio"
                    name="decision"
                    value="approve"
                    checked={decision === 'approve'}
                    onChange={() => handleDecisionChange('approve')}
                    data-testid="radio-decision-approve"
                  />
                  <span
                    style={{ color: 'var(--color-success)', fontWeight: 600 }}
                  >
                    批准并生效 (Approve)
                  </span>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    - 成为项目当前推荐回归基线
                  </span>
                </label>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                  }}
                >
                  <input
                    type="radio"
                    name="decision"
                    value="reject"
                    checked={decision === 'reject'}
                    onChange={() => handleDecisionChange('reject')}
                    data-testid="radio-decision-reject"
                  />
                  <span
                    style={{ color: 'var(--color-danger)', fontWeight: 600 }}
                  >
                    拒绝此草稿 (Reject)
                  </span>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    - 标记为已退回，不纳入回归
                  </span>
                </label>
              </div>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label
                htmlFor="review-reason"
                style={{
                  display: 'block',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  marginBottom: '6px',
                }}
              >
                审查判定依据与理由 (Audit Reason){' '}
                <span style={{ color: 'var(--color-danger)' }}>*</span>
              </label>
              <textarea
                id="review-reason"
                rows={4}
                className="input"
                style={{ width: '100%', resize: 'vertical' }}
                placeholder="请详细说明准则校验结果、步骤合理性及风险评估依据..."
                value={reason}
                onChange={(e) => handleReasonChange(e.target.value)}
                required
                data-testid="input-review-reason"
              />
              <p
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--color-text-muted)',
                  margin: '4px 0 0 0',
                }}
              >
                必须与 P0
                人工审查机制严格一致：提交理由将被持久化并永久记录于版本审计链中。
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                borderTop: '1px solid var(--color-border-subtle)',
                paddingTop: '16px',
              }}
            >
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
              >
                取消
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || !reason.trim()}
                data-testid="btn-request-review-preview"
              >
                {loading ? '正在生成差异预览...' : '下一步：生成审查差异预览'}
              </button>
            </div>
          </form>
        ) : (
          /* Step 2: Review Preview, Security Token & Unified Diff Confirmation */
          <div>
            {/* Token & Expiry Card */}
            <div
              style={{
                backgroundColor: 'var(--color-bg-base)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 16px',
                marginBottom: '16px',
              }}
              data-testid="review-preview-security-panel"
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '8px',
                }}
              >
                <span
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--color-primary)',
                  }}
                >
                  🛡️ 审查安全确认（已绑定目标版本 v{preview.expectedVersion}{' '}
                  与决议内容）
                </span>
                <span
                  style={{
                    fontSize: '0.8rem',
                    color:
                      timeRemainingSeconds !== null && timeRemainingSeconds < 60
                        ? 'var(--color-danger)'
                        : 'var(--color-text-muted)',
                    fontWeight: 600,
                  }}
                  data-testid="review-token-timer"
                >
                  {timeRemainingSeconds !== null && timeRemainingSeconds > 0
                    ? `令牌有效期剩余: ${Math.floor(timeRemainingSeconds / 60)} 分 ${timeRemainingSeconds % 60} 秒`
                    : '⚠️ 令牌已过期，请重新生成'}
                </span>
              </div>
              <div
                style={{
                  fontSize: '0.85rem',
                  backgroundColor: 'var(--color-bg-surface)',
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border-subtle)',
                }}
                data-testid="review-preview-mirrored-content"
              >
                <div>
                  <strong>拟提交决议: </strong>
                  <span
                    style={{
                      fontWeight: 600,
                      color:
                        preview.decision === 'approve'
                          ? 'var(--color-success)'
                          : 'var(--color-danger)',
                    }}
                    data-testid="review-preview-mirrored-decision"
                  >
                    {preview.decision === 'approve'
                      ? '批准并生效 (Approve)'
                      : '拒绝此草稿 (Reject)'}
                  </span>
                </div>
                <div
                  style={{ marginTop: '4px', color: 'var(--color-text-main)' }}
                >
                  <strong>审查理由: </strong>
                  <span data-testid="review-preview-mirrored-reason">
                    {preview.reason}
                  </span>
                </div>
              </div>
            </div>

            {/* Risks Section */}
            {preview.risks && preview.risks.length > 0 && (
              <div
                style={{
                  backgroundColor: 'var(--color-warning-bg)',
                  border: '1px solid var(--color-warning-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px 16px',
                  marginBottom: '16px',
                }}
                data-testid="review-preview-risks"
              >
                <div
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--color-warning-text)',
                    marginBottom: '6px',
                  }}
                >
                  ⚠️ 识别到版本潜在风险事项 ({preview.risks.length} 项):
                </div>
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: '20px',
                    fontSize: '0.85rem',
                    color: 'var(--color-warning-text)',
                  }}
                >
                  {preview.risks.map((risk, idx) => (
                    <li key={idx} style={{ marginBottom: '4px' }}>
                      {risk}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Unified Diff View */}
            <div style={{ marginBottom: '16px' }}>
              <label
                style={{
                  display: 'block',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  marginBottom: '6px',
                }}
              >
                版本变更差异对比 (Unified Diff):
              </label>
              <pre
                style={{
                  backgroundColor: 'var(--color-bg-base)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px',
                  fontSize: '0.8rem',
                  lineHeight: '1.4',
                  maxHeight: '240px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  fontFamily: 'monospace',
                }}
                data-testid="review-preview-diff"
              >
                {preview.diff || '(无文本差异)'}
              </pre>
            </div>

            {/* Decision Summary */}
            <div
              style={{
                backgroundColor: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '10px 14px',
                marginBottom: '16px',
                fontSize: '0.85rem',
              }}
            >
              <div>
                <strong>拟定决议: </strong>
                <span
                  style={{
                    fontWeight: 600,
                    color:
                      preview.decision === 'approve'
                        ? 'var(--color-success)'
                        : 'var(--color-danger)',
                  }}
                  data-testid="review-decision-summary"
                >
                  {preview.decision === 'approve'
                    ? '批准 (APPROVE)'
                    : '拒绝 (REJECT)'}
                </span>
              </div>
              <div style={{ marginTop: '4px' }}>
                <strong>决议理由: </strong>
                <span data-testid="review-reason-summary">
                  {preview.reason}
                </span>
              </div>
            </div>

            {/* Footer Buttons */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderTop: '1px solid var(--color-border-subtle)',
                paddingTop: '16px',
              }}
            >
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setPreview(null)}
                data-testid="btn-re-preview"
              >
                ← 修改决议与理由
              </button>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onClose}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={`btn ${decision === 'approve' ? 'btn-primary' : 'btn-danger'}`}
                  onClick={handleCommit}
                  disabled={
                    loading ||
                    (timeRemainingSeconds !== null && timeRemainingSeconds <= 0)
                  }
                  data-testid="btn-commit-review"
                >
                  {loading
                    ? '正在确认提交...'
                    : decision === 'approve'
                      ? '确认批准生效 (Commit Approve)'
                      : '确认退回拒绝 (Commit Reject)'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
