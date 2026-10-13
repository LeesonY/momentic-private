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
    const effectiveDecision: 'provide' | 'approve' | 'reject' =
      override ?? decision;

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

  const title = isOtp
    ? '需要一次性验证码'
    : isAuthKind
      ? '需要选择登录账号'
      : null;

  return (
    <section
      className={`mo-ask-card ${isAuthKind ? 'is-auth' : ''}`}
      data-testid="input-request-bar"
      data-request-id={request.id}
      data-request-kind={request.kind}
    >
      <div className="mo-ask-head">
        <div>
          {title && (
            <span className="mo-ask-kind" data-testid="input-request-badge">
              <AppIcon name="lock" size={12} /> {title}
            </span>
          )}
          <p className="mo-ask-question">{request.prompt}</p>
        </div>
        <button
          type="button"
          className="mo-ask-skip"
          onClick={() => void handleSubmit('reject')}
          disabled={submitting}
          data-testid={isOtp ? 'btn-reject-otp' : 'btn-skip-input'}
        >
          跳过
        </button>
      </div>

      {isAuthKind && !isOtp && (
        <p className="mo-ask-hint">
          AI 会识别登录页；账号密码只走私有认证通道，不进入对话。
        </p>
      )}
      <div className="mo-ask-answer">
        {isOtp ? (
          <>
            <input
              className="form-input"
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
              className="btn btn-secondary"
              onClick={() => void handleSubmit('provide')}
              disabled={submitting || !/^[A-Za-z0-9]{4,32}$/.test(responseText)}
              data-testid="btn-submit-input-response"
            >
              {submitting ? '提交中…' : '验证'}
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
              className="btn btn-secondary"
              onClick={() => void handleSubmit('provide')}
              disabled={submitting || !responseText}
              data-testid="btn-submit-input-response"
            >
              使用此账号
            </button>
          </>
        ) : (
          <>
            <input
              className="form-input"
              placeholder="写下你的回答…"
              aria-label="回答"
              value={responseText}
              onChange={(e) => setResponseText(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  responseText.trim()
                ) {
                  e.preventDefault();
                  void handleSubmit('provide');
                }
              }}
              disabled={submitting}
              data-testid="input-request-input"
            />
            <button
              className="btn btn-secondary"
              onClick={() => void handleSubmit('provide')}
              disabled={submitting || !responseText.trim()}
              data-testid="btn-submit-input-response"
            >
              {submitting ? '发送中…' : '发送'}
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="field-error" data-testid="input-request-error">
          {error}
        </p>
      )}

      <p className="mo-ask-hint">
        {isOtp
          ? '验证码只提交到私有认证通道，一次有效。'
          : isAuthKind
            ? '没有可用账号时，先在“环境与认证”里配置。'
            : '最多等待 300 秒，超时后保留已有结果并结束。也可以直接在下方输入框回答。'}
      </p>
    </section>
  );
};
