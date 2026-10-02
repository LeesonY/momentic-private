import React, { useState } from 'react';
import type { InputRequest } from '@localqa/contracts';

interface InputRequestBarProps {
  request: InputRequest;
  onRespond: (
    decision: 'provide' | 'approve' | 'reject',
    text?: string,
  ) => Promise<void>;
}

export const InputRequestBar: React.FC<InputRequestBarProps> = ({
  request,
  onRespond,
}) => {
  const [decision, setDecision] = useState<'provide' | 'approve' | 'reject'>(
    'approve',
  );
  const [responseText, setResponseText] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await onRespond(decision, responseText || undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        backgroundColor: 'var(--color-warning-bg)',
        border: '1px solid var(--color-warning-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '16px 20px',
        marginBottom: '16px',
        boxShadow: 'var(--shadow-sm)',
      }}
      data-testid="input-request-bar"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '8px',
        }}
      >
        <span style={{ fontSize: '1.2rem' }}>⚠️</span>
        <h4
          style={{
            fontSize: '0.95rem',
            fontWeight: 600,
            color: 'var(--color-warning-text)',
          }}
        >
          运行暂停：等待人工补充输入 (Awaiting Input)
        </h4>
        <span
          className="badge"
          style={{
            backgroundColor: 'var(--color-warning-border)',
            color: 'var(--color-warning-text)',
          }}
        >
          类型: {request.kind}
        </span>
      </div>

      <p
        style={{
          fontSize: '0.875rem',
          color: 'var(--color-text-main)',
          marginBottom: '12px',
        }}
      >
        {request.prompt}
      </p>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <select
          className="form-select"
          style={{ width: 'auto', minWidth: '160px' }}
          value={decision}
          onChange={(e) =>
            setDecision(e.target.value as 'provide' | 'approve' | 'reject')
          }
          data-testid="input-decision-select"
        >
          <option value="approve">批准继续 (Approve)</option>
          <option value="provide">提供材料 (Provide)</option>
          <option value="reject">拒绝操作 (Reject)</option>
        </select>

        <input
          className="form-input"
          style={{ width: 'auto', minWidth: '240px' }}
          placeholder="可选输入补充文本/验证码..."
          value={responseText}
          onChange={(e) => setResponseText(e.target.value)}
          data-testid="input-request-input"
        />

        <button
          className="btn btn-primary"
          onClick={handleSubmit}
          disabled={submitting}
          data-testid="btn-submit-input-response"
        >
          {submitting ? '提交中...' : '提交答复并恢复执行'}
        </button>
      </div>

      <p
        style={{
          fontSize: '0.75rem',
          color: 'var(--color-warning-text)',
          marginTop: '8px',
        }}
      >
        * 提示：根据 SRS 约束，输入等待最长 300
        秒，超时后系统将保留已有结果并自动退出，不会无限期挂起。
      </p>
    </div>
  );
};
