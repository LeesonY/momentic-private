import React, { useState, useEffect, useRef } from 'react';
import type { InputRequest } from '@localqa/contracts';
import { AppIcon } from '../ui/AppIcon.tsx';

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
  const isOtp = request.kind === 'one_time_code';

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

  const handleSubmit = async (override?: 'provide' | 'reject') => {
    // 1. Synchronous in-flight guard: blocks same-tick double submits
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    // 2. Capture epoch and identity at dispatch time
    const capturedEpoch = requestEpochRef.current;
    const capturedRequestId = request.id;
    const capturedRunId = request.runId;
    const isAuth =
      request.kind === 'auth_profile' || request.kind === 'one_time_code';

    // Only the dedicated OTP channel permits a sensitive value. It is never
    // sent as an ordinary user message or clarification.
    const effectiveDecision: 'provide' | 'approve' | 'reject' = isAuth
      ? isOtp
        ? (override ?? decision)
        : 'reject'
      : decision;

    if (
      (isAuth && !isOtp && effectiveDecision !== 'reject') ||
      (isOtp && effectiveDecision === 'approve')
    ) {
      inFlightRef.current = false;
      setError('不允许此认证操作');
      return;
    }

    // For reject, never pass text key
    const effectiveText =
      effectiveDecision === 'reject' || (isAuth && !isOtp)
        ? undefined
        : isOtp
          ? responseText
          : responseText.trim() || undefined;

    setSubmitting(true);
    setError(null);
    try {
      await onRespond(effectiveDecision, effectiveText);
      if (isOtp) setResponseText('');
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
      setError(
        isOtp
          ? '验证码提交失败或已过期'
          : err instanceof Error
            ? err.message
            : '提交答复失败',
      );
      if (isOtp) setResponseText('');
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
    <section
      className={`card lqa-input-request ${isAuthKind ? 'is-danger' : 'is-warning'}`}
      data-testid="input-request-bar"
      data-request-id={request.id}
      data-request-kind={request.kind}
    >
      <div className="lqa-input-request-head">
        <AppIcon name={isAuthKind ? 'lock' : 'alert-triangle'} size={17} />
        <h4>
          {isOtp
            ? '等待一次性验证码'
            : isAuthKind
              ? '认证受阻：认证执行尚未接入'
              : '运行已暂停，等待人工输入'}
        </h4>
        <span
          className={`badge badge-sm ${isAuthKind ? 'badge-danger' : 'badge-warning'}`}
          data-testid="input-request-badge"
        >
          类型 {request.kind}
          {isAuthKind && !isOtp ? '（尚未接线）' : ''}
        </span>
      </div>

      <p className="lqa-input-request-prompt">{request.prompt}</p>

      {isAuthKind && !isOtp && (
        <div className="alert alert-danger" data-testid="auth-blocked-notice">
          <AppIcon name="alert-circle" size={15} />
          <div className="alert-body">
            <strong>安全受阻：</strong>
            当前执行环境尚未接入安全认证会话与一次性验证码通道，严禁通过普通文本提交账号凭据或验证码，因此不能批准继续，只能
            <strong>拒绝</strong>以安全中止本次认证请求。
          </div>
        </div>
      )}

      <div className="lqa-input-request-controls">
        {isOtp ? (
          <>
            <input
              className="form-input lqa-otp-input"
              type="password"
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={32}
              placeholder="输入一次性验证码"
              aria-label="一次性验证码"
              value={responseText}
              onChange={(e) => setResponseText(e.target.value)}
              disabled={submitting}
              data-testid="input-request-otp"
            />
            <button
              className="btn btn-primary"
              onClick={() => void handleSubmit('provide')}
              disabled={submitting || !/^[A-Za-z0-9]{4,32}$/.test(responseText)}
              data-testid="btn-submit-input-response"
            >
              {submitting ? '提交中...' : '验证'}
            </button>
            <button
              className="btn btn-danger-outline"
              onClick={() => void handleSubmit('reject')}
              disabled={submitting}
              data-testid="btn-reject-otp"
            >
              拒绝
            </button>
          </>
        ) : isAuthKind ? (
          <>
            <select
              className="form-select lqa-decision-select"
              aria-label="答复方式"
              value="reject"
              disabled
              data-testid="input-decision-select"
            >
              <option value="reject">仅支持拒绝</option>
            </select>
            <button
              className="btn btn-danger"
              onClick={() => void handleSubmit()}
              disabled={submitting}
              data-testid="btn-submit-input-response"
            >
              {submitting ? '提交中...' : '拒绝此请求'}
            </button>
          </>
        ) : (
          <>
            <select
              className="form-select lqa-decision-select"
              aria-label="答复方式"
              value={decision}
              onChange={(e) =>
                setDecision(e.target.value as 'provide' | 'approve' | 'reject')
              }
              disabled={submitting}
              data-testid="input-decision-select"
            >
              <option value="approve">批准继续</option>
              <option value="provide">提供材料</option>
              <option value="reject">拒绝</option>
            </select>
            <input
              className="form-input grow"
              placeholder="输入补充说明…"
              aria-label="补充说明"
              value={responseText}
              onChange={(e) => setResponseText(e.target.value)}
              disabled={submitting}
              data-testid="input-request-input"
            />
            <button
              className="btn btn-primary"
              onClick={() => void handleSubmit()}
              disabled={submitting}
              data-testid="btn-submit-input-response"
            >
              {submitting ? '提交中...' : '提交并恢复执行'}
            </button>
          </>
        )}
      </div>

      {error && (
        <p
          className="field-error lqa-input-request-error"
          data-testid="input-request-error"
        >
          {error}
        </p>
      )}

      <p className="field-hint lqa-input-request-note">
        {isOtp
          ? '验证码只提交到私有认证通道并且一次性有效；超时或会话中断后不能重试原验证码。'
          : isAuthKind
            ? '接入安全会话前，拒绝此请求可以安全地结束等待或把该任务标记为失败，避免长时间挂起。'
            : '输入等待最长 300 秒，超时后系统会保留已有结果并自动退出，不会无限期挂起。'}
      </p>
    </section>
  );
};
