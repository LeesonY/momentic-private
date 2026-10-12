import React, { useState, useEffect, useRef } from 'react';
import type { InputRequest } from '@localqa/contracts';
import { AppIcon } from '../ui/AppIcon.tsx';

interface InputRequestBarProps {
  request: InputRequest;
  authProfiles?: readonly { id: string; name: string }[];
  onRespond: (
    decision: 'provide' | 'approve' | 'reject',
    text?: string,
  ) => Promise<void>;
}

export const InputRequestBar: React.FC<InputRequestBarProps> = ({
  request,
  onRespond,
  authProfiles = [],
}) => {
  const isAuthKind =
    request.kind === 'auth_profile' || request.kind === 'one_time_code';
  const isOtp = request.kind === 'one_time_code';

  const [decision, setDecision] = useState<'provide' | 'approve' | 'reject'>(
    request.kind === 'clarification' ? 'provide' : 'reject',
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

    setDecision(request.kind === 'clarification' ? 'provide' : 'reject');
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
        : (override ?? decision)
      : decision;

    if (
      (isAuth && !isOtp && effectiveDecision === 'approve') ||
      (isOtp && effectiveDecision === 'approve')
    ) {
      inFlightRef.current = false;
      setError('不允许此认证操作');
      return;
    }

    // For reject, never pass text key
    const effectiveText =
      effectiveDecision === 'reject'
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
        </span>
      </div>

      <p className="lqa-input-request-prompt">{request.prompt}</p>

      {isAuthKind && !isOtp && (
        <p className="field-hint">
          选择已配置的登录账号。AI
          会识别登录页面；账号密码由私有认证通道使用，不进入普通对话。
        </p>
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
              className="form-select"
              aria-label="认证配置"
              data-testid="input-auth-profile"
              value={responseText}
              onChange={(e) => setResponseText(e.target.value)}
              disabled={submitting}
            >
              <option value="">选择登录账号</option>
              {authProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              onClick={() => void handleSubmit('provide')}
              disabled={submitting || !responseText}
              data-testid="btn-submit-input-response"
            >
              使用此账号并继续
            </button>
            <button
              className="btn btn-danger-outline"
              onClick={() => void handleSubmit('reject')}
              disabled={submitting}
            >
              拒绝
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
            ? '如没有可用账号，请先在环境与认证中配置，再刷新此页面。'
            : '输入等待最长 300 秒，超时后系统会保留已有结果并自动退出，不会无限期挂起。'}
      </p>
    </section>
  );
};
