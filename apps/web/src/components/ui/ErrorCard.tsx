import React from 'react';
import { AppIcon, type AppIconName } from './AppIcon.tsx';

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
    tone: 'danger' | 'warning' | 'info';
    icon: AppIconName;
  }
> = {
  forbidden: {
    title: '无访问权限',
    defaultMessage:
      '您当前的角色权限不足以执行此操作或访问该项目资源。请联系项目负责人授予权限。',
    tone: 'danger',
    icon: 'lock',
  },
  unauthenticated: {
    title: '登录已失效',
    defaultMessage: '会话已过期或尚未登录系统，请重新输入凭据登录。',
    tone: 'danger',
    icon: 'lock',
  },
  missing_evidence: {
    title: '证据缺失或已清理',
    defaultMessage:
      '未查询到对应的录屏或截图材料。证据可能因超出保留期已按策略清理，或在采集阶段发生容量降级。',
    tone: 'warning',
    icon: 'image',
  },
  model_error: {
    title: '模型调用异常',
    defaultMessage:
      '模型网关返回错误响应、超时，或当前模型提供方不支持所需能力（如视觉识别、工具调用）。',
    tone: 'danger',
    icon: 'cpu',
  },
  budget_exhausted: {
    title: '运行预算已用尽',
    defaultMessage:
      '该次运行已达预设预算上限（用例数、操作步数、模型调用或运行时长），已触发非破坏性收尾。',
    tone: 'warning',
    icon: 'clock',
  },
  partial_report: {
    title: '部分完成的报告',
    defaultMessage:
      '本次测试因预算限制或人工取消未全部执行完毕。报告汇总了已判定的结论，未探索的区域列为覆盖缺口。',
    tone: 'info',
    icon: 'file-text',
  },
  generic: {
    title: '操作失败',
    defaultMessage: '系统操作异常，请检查网络或配置后重试。',
    tone: 'danger',
    icon: 'alert-circle',
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
      className={`alert alert-${cfg.tone} lqa-error-card`}
      data-testid={`error-card-${type}`}
    >
      <AppIcon name={cfg.icon} size={18} />
      <div className="alert-body">
        <div className="alert-title">{cfg.title}</div>
        <p>{message || cfg.defaultMessage}</p>
        {details && <pre className="lqa-error-details">{details}</pre>}
      </div>
      {onRetry && (
        <div className="alert-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onRetry}
          >
            重试
          </button>
        </div>
      )}
    </div>
  );
};
