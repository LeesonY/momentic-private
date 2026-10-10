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
  not_evaluated: { className: 'badge-neutral', text: '未判定' },
  unknown: { className: 'badge-neutral', text: '未知' },

  // Execution modes
  regression: { className: 'badge-primary', text: '回归模式' },
  smoke: { className: 'badge-info', text: '冒烟模式' },

  // Finding confirmations
  confirmed: { className: 'badge-danger', text: '已复现确认' },
  suspected: { className: 'badge-warning', text: '疑似待复现' },
  unconfirmed: { className: 'badge-neutral', text: '无法复现' },

  // Run status
  queued: { className: 'badge-info', text: '排队中' },
  running: { className: 'badge-info', text: '执行中' },
  awaiting_input: { className: 'badge-warning', text: '等待补充输入' },
  completed: { className: 'badge-success', text: '调度已完成' },
  cancelled: { className: 'badge-neutral', text: '已取消' },
  failed: { className: 'badge-danger', text: '异常终止' },
  cancelling: { className: 'badge-warning', text: '正在取消' },

  // Task status
  waiting: { className: 'badge-warning', text: '等待中' },
  succeeded: { className: 'badge-success', text: '已完成' },
  interrupted: { className: 'badge-warning', text: '已中断' },

  // Completion
  complete: { className: 'badge-success', text: '完整执行' },
  partial: { className: 'badge-warning', text: '部分执行' },
  none: { className: 'badge-danger', text: '未执行' },

  // Role
  admin: { className: 'badge-primary', text: '平台管理员' },
  owner: { className: 'badge-primary', text: '项目负责人' },
  operator: { className: 'badge-info', text: '操作员' },
  viewer: { className: 'badge-neutral', text: '只读成员' },

  // Case Review Status
  draft: { className: 'badge-warning', text: '草稿待审' },
  approved: { className: 'badge-success', text: '已批准' },
  rejected: { className: 'badge-danger', text: '已拒绝' },
  active: { className: 'badge-success', text: '活跃' },
  archived: { className: 'badge-neutral', text: '已归档' },
};

export const StatusBadge: React.FC<BadgeProps> = ({
  status,
  label,
  size = 'md',
}) => {
  const normalizedStatus = (status || 'unknown').toLowerCase();
  const meta = statusMap[normalizedStatus] || {
    className: 'badge-neutral',
    text: label || status || '未知',
  };
  return (
    <span
      className={`badge ${meta.className} ${size === 'sm' ? 'badge-sm' : ''}`}
      data-testid={`badge-${normalizedStatus}`}
    >
      {label || meta.text}
    </span>
  );
};
