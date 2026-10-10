import React, { useState, useEffect } from 'react';
import type {
  SavedCase,
  SavedCaseVersion,
  ReviewPreview,
} from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';
import { Modal } from '../ui/Modal.tsx';
import { Alert } from '../ui/Alert.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';

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

  const tokenExpired =
    timeRemainingSeconds !== null && timeRemainingSeconds <= 0;

  return (
    <Modal
      title={preview ? '确认审查决议' : '人工审查用例版本'}
      description={
        <>
          用例 <strong>{caseRecord.name}</strong>（{caseRecord.slug}）· 版本{' '}
          <strong>v{caseVersion.version}</strong>
        </>
      }
      onClose={onClose}
      size="lg"
      overlayTestId="case-review-modal-overlay"
      testId="case-review-modal-content"
      closeTestId="btn-close-review-modal"
      footer={
        !preview ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              form="case-review-form"
              className="btn btn-primary"
              disabled={loading || !reason.trim()}
              data-testid="btn-request-review-preview"
            >
              {loading ? '正在生成差异预览...' : '下一步：生成审查预览'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-ghost modal-footer-start"
              onClick={() => setPreview(null)}
              data-testid="btn-re-preview"
            >
              <AppIcon name="chevron-left" size={14} />
              修改决议与理由
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className={`btn ${decision === 'approve' ? 'btn-primary' : 'btn-danger'}`}
              onClick={handleCommit}
              disabled={loading || tokenExpired}
              data-testid="btn-commit-review"
            >
              {loading
                ? '正在确认提交...'
                : decision === 'approve'
                  ? '确认批准生效'
                  : '确认退回'}
            </button>
          </>
        )
      }
    >
      {error && (
        <Alert
          tone="danger"
          testId="review-error-banner"
          className="lqa-modal-alert"
        >
          {error}
        </Alert>
      )}

      {!preview ? (
        <form id="case-review-form" onSubmit={handleRequestPreview}>
          <div className="field">
            <span className="field-label">审查决议</span>
            <div className="lqa-choice-group">
              <label
                className={`lqa-choice ${decision === 'approve' ? 'is-selected is-success' : ''}`}
              >
                <input
                  type="radio"
                  name="decision"
                  value="approve"
                  checked={decision === 'approve'}
                  onChange={() => handleDecisionChange('approve')}
                  data-testid="radio-decision-approve"
                />
                <span>
                  <span className="lqa-choice-title">批准并生效</span>
                  <span className="lqa-choice-hint">
                    成为项目当前的回归基线
                  </span>
                </span>
              </label>
              <label
                className={`lqa-choice ${decision === 'reject' ? 'is-selected is-danger' : ''}`}
              >
                <input
                  type="radio"
                  name="decision"
                  value="reject"
                  checked={decision === 'reject'}
                  onChange={() => handleDecisionChange('reject')}
                  data-testid="radio-decision-reject"
                />
                <span>
                  <span className="lqa-choice-title">拒绝此草稿</span>
                  <span className="lqa-choice-hint">
                    标记为已退回，不纳入回归
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="review-reason">
              判定依据与理由<span className="field-required">*</span>
            </label>
            <textarea
              id="review-reason"
              rows={4}
              className="input"
              placeholder="说明准则校验结果、步骤是否合理以及风险评估依据…"
              value={reason}
              onChange={(e) => handleReasonChange(e.target.value)}
              required
              data-testid="input-review-reason"
            />
            <p className="field-hint">
              理由会被持久化，并永久记录在版本审计链中。
            </p>
          </div>
        </form>
      ) : (
        <div className="stack">
          <div
            className="panel stack stack-sm"
            data-testid="review-preview-security-panel"
          >
            <div className="row row-wrap spread">
              <span className="row text-sm strong lqa-review-bound">
                <AppIcon name="shield" size={15} />
                已绑定目标版本 v{preview.expectedVersion} 与决议内容
              </span>
              <span
                className={`text-xs strong ${timeRemainingSeconds !== null && timeRemainingSeconds < 60 ? 'text-danger' : 'muted'}`}
                data-testid="review-token-timer"
              >
                {timeRemainingSeconds !== null && timeRemainingSeconds > 0
                  ? `令牌剩余 ${Math.floor(timeRemainingSeconds / 60)} 分 ${timeRemainingSeconds % 60} 秒`
                  : '令牌已过期，请重新生成'}
              </span>
            </div>
            <dl
              className="kv lqa-review-mirror"
              data-testid="review-preview-mirrored-content"
            >
              <dt>拟提交决议</dt>
              <dd
                className={`strong ${preview.decision === 'approve' ? 'text-success' : 'text-danger'}`}
                data-testid="review-preview-mirrored-decision"
              >
                {preview.decision === 'approve' ? '批准并生效' : '拒绝此草稿'}
              </dd>
              <dt>审查理由</dt>
              <dd data-testid="review-preview-mirrored-reason">
                {preview.reason}
              </dd>
            </dl>
          </div>

          {preview.risks && preview.risks.length > 0 && (
            <div
              className="alert alert-warning"
              data-testid="review-preview-risks"
            >
              <AppIcon name="alert-triangle" size={15} />
              <div className="alert-body">
                <div className="alert-title">
                  识别到 {preview.risks.length} 项潜在风险
                </div>
                <ul className="lqa-bullets">
                  {preview.risks.map((risk, idx) => (
                    <li key={idx}>{risk}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="field">
            <span className="field-label">版本变更差异</span>
            <pre className="lqa-diff" data-testid="review-preview-diff">
              {preview.diff || '（无文本差异）'}
            </pre>
          </div>

          <dl className="kv panel">
            <dt>拟定决议</dt>
            <dd
              className={`strong ${preview.decision === 'approve' ? 'text-success' : 'text-danger'}`}
              data-testid="review-decision-summary"
            >
              {preview.decision === 'approve' ? '批准' : '拒绝'}
            </dd>
            <dt>决议理由</dt>
            <dd data-testid="review-reason-summary">{preview.reason}</dd>
          </dl>
        </div>
      )}
    </Modal>
  );
};
