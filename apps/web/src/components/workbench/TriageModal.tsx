import React, { useState } from 'react';
import type { Finding, TriagePreview } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';

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

  const dispositionLabels: Record<string, string> = {
    accepted: '接受为有效缺陷',
    duplicate: '标记为重复缺陷',
    works_as_intended: '符合预期，无需修复',
    cannot_reproduce: '无法复现',
    closed: '直接关闭',
  };

  return (
    <Modal
      title={preview ? '确认审查决议' : '人工审查缺陷'}
      description={finding.title}
      onClose={onClose}
      overlayTestId="triage-modal-overlay"
      testId="triage-modal-content"
      footer={
        !preview ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              form="triage-form"
              className="btn btn-primary"
              disabled={loading}
              data-testid="btn-request-triage-preview"
            >
              {loading ? '生成预览中...' : '生成决议预览'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-ghost modal-footer-start"
              onClick={() => setPreview(null)}
            >
              <AppIcon name="chevron-left" size={14} />
              返回修改
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleCommit}
              disabled={loading}
              data-testid="btn-commit-triage-confirm"
            >
              {loading ? '提交中...' : '确认提交决议'}
            </button>
          </>
        )
      }
    >
      {error && (
        <Alert tone="danger" className="lqa-modal-alert">
          {error}
        </Alert>
      )}

      {!preview ? (
        <form id="triage-form" onSubmit={handleRequestPreview}>
          <Field label="审查决议" htmlFor="triage-disposition">
            <select
              id="triage-disposition"
              className="form-select"
              value={disposition}
              onChange={(e) =>
                setDisposition(e.target.value as TriageDisposition)
              }
              data-testid="triage-disposition-select"
            >
              <option value="accepted">接受为有效缺陷</option>
              <option value="duplicate">标记为重复缺陷</option>
              <option value="works_as_intended">符合预期，无需修复</option>
              <option value="cannot_reproduce">无法复现</option>
              <option value="closed">直接关闭</option>
            </select>
          </Field>

          <Field label="判定依据与说明" htmlFor="triage-reason">
            <textarea
              id="triage-reason"
              className="form-textarea"
              rows={4}
              placeholder="记录审查理由、业务预期来源或修复交接备注…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="triage-reason-textarea"
            />
          </Field>
        </form>
      ) : (
        <div className="stack">
          <dl className="kv panel" data-testid="triage-preview-card">
            <dt>变更后状态</dt>
            <dd className="strong" title={preview.disposition}>
              {dispositionLabels[preview.disposition] ?? preview.disposition}
            </dd>
            <dt>判定依据</dt>
            <dd>{preview.reason}</dd>
            <dt>确认令牌</dt>
            <dd>
              <code className="break-all">{preview.confirmationToken}</code>
            </dd>
            <dt>有效期至</dt>
            <dd>
              {new Date(preview.expiresAt).toLocaleTimeString()}（300 秒内有效）
            </dd>
          </dl>
          <Alert tone="warning">
            人工审查提交后不可撤回：确认后会写入权威审计日志并推进缺陷状态。
          </Alert>
        </div>
      )}
    </Modal>
  );
};
