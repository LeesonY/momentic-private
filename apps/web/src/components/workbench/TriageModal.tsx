import React, { useState } from 'react';
import type { Finding, TriagePreview } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';

interface TriageModalProps {
  finding: Finding;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (updatedFinding: Finding) => void;
}

type TriageDisposition =
  | 'accepted'
  | 'duplicate'
  | 'works_as_intended'
  | 'cannot_reproduce'
  | 'closed';

export const TriageModal: React.FC<TriageModalProps> = ({
  finding,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [disposition, setDisposition] = useState<TriageDisposition>('accepted');
  const [reason, setReason] = useState<string>('');
  const [preview, setPreview] = useState<TriagePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleRequestPreview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError('请输入具体的审查判定理由');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const p = await defaultApiClient.previewTriage(
        finding.id,
        disposition,
        reason,
        finding.version,
      );
      setPreview(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成审查预览失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!preview) return;
    setLoading(true);
    setError(null);
    try {
      const updated = await defaultApiClient.commitTriage(finding.id, {
        expectedVersion: finding.version,
        confirmationToken: preview.confirmationToken,
        disposition: preview.disposition,
        reason: preview.reason,
      });
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
      data-testid="triage-modal-overlay"
    >
      <div
        className="dialog-content"
        onClick={(e) => e.stopPropagation()}
        data-testid="triage-modal-content"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px',
          }}
        >
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            {preview
              ? '确认人工审查决议预览 (Triage Preview)'
              : '人工审查与缺陷决议 (Finding Triage)'}
          </h3>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: '1.25rem',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'var(--color-danger-bg)',
              color: 'var(--color-danger-text)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.85rem',
              marginBottom: '14px',
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            marginBottom: '16px',
            padding: '10px 14px',
            backgroundColor: 'var(--color-bg-subtle)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
            正在审查的问题缺陷:
          </div>
          <div
            style={{
              fontSize: '0.9rem',
              fontWeight: 600,
              color: 'var(--color-text-main)',
              marginTop: '2px',
            }}
          >
            {finding.title}
          </div>
        </div>

        {!preview ? (
          <form onSubmit={handleRequestPreview}>
            <div className="form-group">
              <label className="form-label">审查决议动作 (Disposition)</label>
              <select
                className="form-select"
                value={disposition}
                onChange={(e) =>
                  setDisposition(e.target.value as TriageDisposition)
                }
                data-testid="triage-disposition-select"
              >
                <option value="accepted">接受为有效 Bug (Accepted)</option>
                <option value="duplicate">标记为重复缺陷 (Duplicate)</option>
                <option value="works_as_intended">
                  按预期设计无需修复 (Works as Intended)
                </option>
                <option value="cannot_reproduce">
                  无法重现 (Cannot Reproduce)
                </option>
                <option value="closed">直接关闭 (Closed)</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">判定依据与详细说明 (Reason)</label>
              <textarea
                className="form-textarea"
                rows={4}
                placeholder="详细记录审查理由、业务预期来源或修复交接备注..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="triage-reason-textarea"
              />
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                marginTop: '20px',
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
                disabled={loading}
                data-testid="btn-request-triage-preview"
              >
                {loading ? '生成预览中...' : '生成决议预览 (Preview)'}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <div
              style={{
                border: '1px solid var(--color-info-border)',
                backgroundColor: 'var(--color-info-bg)',
                borderRadius: 'var(--radius-md)',
                padding: '14px',
                marginBottom: '16px',
              }}
              data-testid="triage-preview-card"
            >
              <h4
                style={{
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  color: 'var(--color-info-text)',
                  marginBottom: '8px',
                }}
              >
                决议变更内容核对:
              </h4>
              <ul
                style={{
                  fontSize: '0.85rem',
                  color: 'var(--color-text-main)',
                  paddingLeft: '20px',
                  lineHeight: 1.6,
                }}
              >
                <li>
                  变更后审查状态: <strong>{preview.disposition}</strong>
                </li>
                <li>判定依据: {preview.reason}</li>
                <li>
                  确认凭证 Token: <code>{preview.confirmationToken}</code>
                </li>
                <li>
                  凭证有效期至:{' '}
                  {new Date(preview.expiresAt).toLocaleTimeString()} (300
                  秒内有效)
                </li>
              </ul>
            </div>

            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--color-text-muted)',
                marginBottom: '20px',
              }}
            >
              *
              依据设计规范，人工审查提交具备严格不可撤回性，点击确认后将记录权威审计日志并推进问题状态。
            </p>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
              }}
            >
              <button
                className="btn btn-secondary"
                onClick={() => setPreview(null)}
              >
                返回修改
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCommit}
                disabled={loading}
                data-testid="btn-commit-triage-confirm"
              >
                {loading ? '提交中...' : '确认并正式提交决议'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
