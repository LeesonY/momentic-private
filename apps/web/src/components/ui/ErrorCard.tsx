import React from 'react';

export type ErrorType =
  | 'forbidden'
  | 'unauthenticated'
  | 'missing_evidence'
  | 'model_error'
  | 'budget_exhausted'
  | 'partial_report'
  | 'generic';

interface ErrorCardProps {
  type?: ErrorType;
  message?: string;
  details?: string;
  onRetry?: () => void;
}

const errorConfigs: Record<
  ErrorType,
  {
    title: string;
    defaultMessage: string;
    badge: string;
    color: string;
    bg: string;
    border: string;
    icon: string;
  }
> = {
  forbidden: {
    title: '403 无访问权限 (Forbidden)',
    defaultMessage:
      '您当前的角色权限不足以执行此操作或访问该项目资源。请联系项目 Owner 授予权限。',
    badge: '权限受限',
    color: 'var(--color-danger-text)',
    bg: 'var(--color-danger-bg)',
    border: 'var(--color-danger-border)',
    icon: '🚫',
  },
  unauthenticated: {
    title: '401 登录认证失效 (Unauthenticated)',
    defaultMessage: '会话已过期或尚未登录系统，请重新输入凭据登录。',
    badge: '会话失效',
    color: 'var(--color-danger-text)',
    bg: 'var(--color-danger-bg)',
    border: 'var(--color-danger-border)',
    icon: '🔒',
  },
  missing_evidence: {
    title: '证据缺失或已过期清理 (Missing Evidence)',
    defaultMessage:
      '未查询到对应的录屏或截图材料。证据可能因超出保留期已按策略清理，或在采集阶段发生容量降级。',
    badge: '证据缺失',
    color: 'var(--color-warning-text)',
    bg: 'var(--color-warning-bg)',
    border: 'var(--color-warning-border)',
    icon: '⚠️',
  },
  model_error: {
    title: 'AI 模型调用异常 (Model Failure)',
    defaultMessage:
      '模型网关返回错误响应、超时或所需能力（如视觉识别/工具调用）未被当前模型提供方支持。',
    badge: '模型异常',
    color: 'var(--color-danger-text)',
    bg: 'var(--color-danger-bg)',
    border: 'var(--color-danger-border)',
    icon: '⚡',
  },
  budget_exhausted: {
    title: '运行预算已用尽 (Budget Limit Exceeded)',
    defaultMessage:
      '该次运行已达最大预设预算阈值（用例数/操作步数/模型调用/运行时间），已触发非破坏性保护收尾。',
    badge: '预算耗尽',
    color: 'var(--color-warning-text)',
    bg: 'var(--color-warning-bg)',
    border: 'var(--color-warning-border)',
    icon: '⏱️',
  },
  partial_report: {
    title: '部分完成报告 (Partial Report)',
    defaultMessage:
      '本次测试由于预算限制或人工取消未全部执行完毕。报告已自动聚合当前已判定的真实结论，未探索区域列入缺口。',
    badge: 'Partial 报告',
    color: 'var(--color-info-text)',
    bg: 'var(--color-info-bg)',
    border: 'var(--color-info-border)',
    icon: '📑',
  },
  generic: {
    title: '发生错误',
    defaultMessage: '系统操作异常，请检查网络或配置后重试。',
    badge: '错误',
    color: 'var(--color-danger-text)',
    bg: 'var(--color-danger-bg)',
    border: 'var(--color-danger-border)',
    icon: '⚠️',
  },
};

export const ErrorCard: React.FC<ErrorCardProps> = ({
  type = 'generic',
  message,
  details,
  onRetry,
}) => {
  const cfg = errorConfigs[type];

  return (
    <div
      style={{
        backgroundColor: cfg.bg,
        border: `1px solid ${cfg.border}`,
        borderRadius: 'var(--radius-lg)',
        padding: '16px 20px',
        margin: '12px 0',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '14px',
      }}
      data-testid={`error-card-${type}`}
    >
      <div style={{ fontSize: '1.75rem', lineHeight: 1 }}>{cfg.icon}</div>
      <div style={{ flex: 1 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '4px',
          }}
        >
          <h4
            style={{ fontSize: '0.95rem', fontWeight: 600, color: cfg.color }}
          >
            {cfg.title}
          </h4>
          <span
            className="badge"
            style={{ backgroundColor: cfg.border, color: cfg.color }}
          >
            {cfg.badge}
          </span>
        </div>
        <p
          style={{
            fontSize: '0.85rem',
            color: cfg.color,
            marginBottom: details ? '8px' : '0',
          }}
        >
          {message || cfg.defaultMessage}
        </p>
        {details && (
          <pre
            style={{
              fontSize: '0.75rem',
              backgroundColor: 'rgba(0,0,0,0.05)',
              padding: '6px 10px',
              borderRadius: 'var(--radius-sm)',
              overflowX: 'auto',
              color: 'var(--color-text-main)',
            }}
          >
            {details}
          </pre>
        )}
      </div>
      {onRetry && (
        <button className="btn btn-secondary btn-sm" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
};
