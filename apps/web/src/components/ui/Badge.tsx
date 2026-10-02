import React from 'react';

export interface BadgeProps {
  status: string;
  label?: string;
  size?: 'sm' | 'md';
}

const statusMap: Record<string, { className: string; text: string }> = {
  // Verdicts
  passed: { className: 'badge-success', text: '已通过' },
  issue_found: { className: 'badge-danger', text: '发现缺陷' },
  blocked: { className: 'badge-warning', text: '受阻' },
  inconclusive: { className: 'badge-neutral', text: '不确定' },
  not_run: { className: 'badge-neutral', text: '未执行' },

  // Finding confirmations
  confirmed: { className: 'badge-danger', text: '已独立复现确认' },
  suspected: { className: 'badge-warning', text: '疑似待复现' },
  unconfirmed: { className: 'badge-neutral', text: '无法复现' },

  // Run status
  running: { className: 'badge-info', text: '执行中' },
  awaiting_input: { className: 'badge-warning', text: '等待补充输入' },
  completed: { className: 'badge-success', text: '调度已完成' },
  cancelled: { className: 'badge-neutral', text: '已取消' },
  failed: { className: 'badge-danger', text: '异常终止' },
  cancelling: { className: 'badge-warning', text: '正在取消' },

  // Completion
  complete: { className: 'badge-success', text: '完整执行' },
  partial: { className: 'badge-warning', text: '部分执行 (Partial)' },
  none: { className: 'badge-danger', text: '未执行 (None)' },

  // Role
  admin: { className: 'badge-primary', text: '平台管理员' },
  owner: { className: 'badge-primary', text: '项目 Owner' },
  operator: { className: 'badge-info', text: 'Operator' },
  viewer: { className: 'badge-neutral', text: 'Viewer 只读' },
};

export const StatusBadge: React.FC<BadgeProps> = ({
  status,
  label,
  size = 'md',
}) => {
  const meta = statusMap[status.toLowerCase()] || {
    className: 'badge-neutral',
    text: label || status,
  };
  return (
    <span
      className={`badge ${meta.className} ${size === 'sm' ? 'badge-sm' : ''}`}
      data-testid={`badge-${status.toLowerCase()}`}
    >
      {label || meta.text}
    </span>
  );
};
