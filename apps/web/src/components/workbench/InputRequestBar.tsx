import React, { useState, useEffect, useRef } from 'react';
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
  const isAuthKind =
    request.kind === 'auth_profile' || request.kind === 'one_time_code';

  const [decision, setDecision] = useState<'provide' | 'approve' | 'reject'>(
    isAuthKind ? 'reject' : 'approve',
  );
  const [responseText, setResponseText] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous busy ref to block same-tick double-submits
  const inFlightRef = useRef(false);

  // Identity and epoch ref to invalidate late callbacks across request/run/version switches and unmount
  const requestEpochRef = useRef(0);
  const currentIdentityRef = useRef({
    requestId: request.id,
    runId: request.runId,
    kind: request.kind,
    version: request.version,
    epoch: 0,
  });

  // Track latest props in ref so async callbacks check against CURRENT component state, not stale closure
  currentIdentityRef.current = {
    requestId: request.id,
    runId: request.runId,
    kind: request.kind,
    version: request.version,
    epoch: requestEpochRef.current,
  };

  // Switching request, run, kind, or version resets all previous inputs and decisions
  useEffect(() => {
    requestEpochRef.current += 1;
    currentIdentityRef.current.epoch = requestEpochRef.current;
    inFlightRef.current = false;

    const isAuth =
      request.kind === 'auth_profile' || request.kind === 'one_time_code';
    setDecision(isAuth ? 'reject' : 'approve');
    setResponseText('');
    setSubmitting(false);
    setError(null);

    return () => {
      // Invalidate on unmount
      requestEpochRef.current += 1;
      currentIdentityRef.current.epoch = requestEpochRef.current;
      inFlightRef.current = false;
    };
  }, [request.id, request.runId, request.kind, request.version]);

  const handleSubmit = async () => {
    // 1. Synchronous in-flight guard: blocks same-tick double submits
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    // 2. Capture epoch and identity at dispatch time
    const capturedEpoch = requestEpochRef.current;
    const capturedRequestId = request.id;
    const capturedRunId = request.runId;
    const isAuth =
      request.kind === 'auth_profile' || request.kind === 'one_time_code';

    // Strict boundary: auth kinds can ONLY be rejected; credentials cannot be passed via plain text
    const effectiveDecision: 'provide' | 'approve' | 'reject' = isAuth
      ? 'reject'
      : decision;

    if (isAuth && effectiveDecision !== 'reject') {
      inFlightRef.current = false;
      setError('认证服务当前尚未接线，仅允许拒绝操作');
      return;
    }

    // For reject, never pass text key
    const effectiveText =
      effectiveDecision === 'reject' || isAuth
        ? undefined
        : responseText.trim() || undefined;

    setSubmitting(true);
    setError(null);
    try {
      await onRespond(effectiveDecision, effectiveText);
      // Late response guard using latest mutable ref:
      // If epoch changed, or current identity does not match captured dispatch, drop it completely!
      if (
        requestEpochRef.current !== capturedEpoch ||
        currentIdentityRef.current.requestId !== capturedRequestId ||
        currentIdentityRef.current.runId !== capturedRunId
      ) {
        return;
      }
    } catch (err) {
      // Late response guard on failure: do not set error on a superseded request
      if (
        requestEpochRef.current !== capturedEpoch ||
        currentIdentityRef.current.requestId !== capturedRequestId ||
        currentIdentityRef.current.runId !== capturedRunId
      ) {
        return;
      }
      setError(err instanceof Error ? err.message : '提交答复失败');
    } finally {
      // Only clear busy flag if the request has not been superseded
      if (
        requestEpochRef.current === capturedEpoch &&
        currentIdentityRef.current.requestId === capturedRequestId &&
        currentIdentityRef.current.runId === capturedRunId
      ) {
        inFlightRef.current = false;
        setSubmitting(false);
      }
    }
  };

  return (
    <div
      style={{
        backgroundColor: isAuthKind
          ? 'var(--color-danger-subtle, #fff5f5)'
          : 'var(--color-warning-bg)',
        border: `1px solid ${
          isAuthKind
            ? 'var(--color-danger-border, #feb2b2)'
            : 'var(--color-warning-border)'
        }`,
        borderRadius: 'var(--radius-lg)',
        padding: '16px 20px',
        marginBottom: '16px',
        boxShadow: 'var(--shadow-sm)',
      }}
      data-testid="input-request-bar"
      data-request-id={request.id}
      data-request-kind={request.kind}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '8px',
        }}
      >
        <span style={{ fontSize: '1.2rem' }}>{isAuthKind ? '🛑' : '⚠️'}</span>
        <h4
          style={{
            fontSize: '0.95rem',
            fontWeight: 600,
            color: isAuthKind
              ? 'var(--color-danger-text, #c53030)'
              : 'var(--color-warning-text)',
          }}
        >
          {isAuthKind
            ? '认证受阻：认证执行尚未接入 (Authentication Blocked)'
            : '运行暂停：等待人工补充输入 (Awaiting Input)'}
        </h4>
        <span
          className="badge"
          style={{
            backgroundColor: isAuthKind
              ? 'var(--color-danger-bg, #fed7d7)'
              : 'var(--color-warning-border)',
            color: isAuthKind
              ? 'var(--color-danger-text, #9b2c2c)'
              : 'var(--color-warning-text)',
          }}
          data-testid="input-request-badge"
        >
          类型: {request.kind}
          {isAuthKind ? ' (尚未接线)' : ''}
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

      {/* Blocked state explanation for auth kinds */}
      {isAuthKind && (
        <div
          style={{
            padding: '10px 14px',
            backgroundColor: 'var(--color-danger-bg, #fed7d7)',
            borderRadius: 'var(--radius-sm, 4px)',
            border: '1px solid var(--color-danger-border, #feb2b2)',
            color: 'var(--color-danger-text, #9b2c2c)',
            fontSize: '0.85rem',
            lineHeight: 1.5,
            marginBottom: '12px',
          }}
          data-testid="auth-blocked-notice"
        >
          <strong>安全受阻提示：</strong>
          当前执行环境尚未接入安全认证执行会话与安全 OTP
          消费通道。系统严禁通过普通文本或未经安全会话提交账号凭据/一次性验证码，不支持批准继续。本阶段仅允许
          <strong>拒绝操作 (Reject)</strong> 以安全中止当前认证请求。
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        {isAuthKind ? (
          <>
            <select
              className="form-select"
              style={{ width: 'auto', minWidth: '160px' }}
              value="reject"
              disabled
              data-testid="input-decision-select"
            >
              <option value="reject">仅支持拒绝操作 (Reject)</option>
            </select>

            <button
              className="btn btn-danger"
              onClick={handleSubmit}
              disabled={submitting}
              data-testid="btn-submit-input-response"
            >
              {submitting ? '提交中...' : '拒绝此请求 (Reject)'}
            </button>
          </>
        ) : (
          <>
            <select
              className="form-select"
              style={{ width: 'auto', minWidth: '160px' }}
              value={decision}
              onChange={(e) =>
                setDecision(e.target.value as 'provide' | 'approve' | 'reject')
              }
              disabled={submitting}
              data-testid="input-decision-select"
            >
              <option value="approve">批准继续 (Approve)</option>
              <option value="provide">提供材料 (Provide)</option>
              <option value="reject">拒绝操作 (Reject)</option>
            </select>

            <input
              className="form-input"
              style={{ width: 'auto', minWidth: '240px' }}
              placeholder="输入补充说明..."
              value={responseText}
              onChange={(e) => setResponseText(e.target.value)}
              disabled={submitting}
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
          </>
        )}
      </div>

      {error && (
        <div
          style={{
            marginTop: '8px',
            color: 'var(--color-danger-text, #c53030)',
            fontSize: '0.85rem',
          }}
          data-testid="input-request-error"
        >
          ⚠️ {error}
        </div>
      )}

      <p
        style={{
          fontSize: '0.75rem',
          color: isAuthKind
            ? 'var(--color-danger-text, #c53030)'
            : 'var(--color-warning-text)',
          marginTop: '8px',
        }}
      >
        {isAuthKind
          ? '* 提示：在接入安全会话前，拒绝此请求可安全解锁流程或标记该任务失败，避免长时间超时挂起。'
          : '* 提示：根据 SRS 约束，输入等待最长 300 秒，超时后系统将保留已有结果并自动退出，不会无限期挂起。'}
      </p>
    </div>
  );
};
