import React from 'react';
import { AppIcon, type AppIconName } from './AppIcon.tsx';

type Tone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

const icons: Record<Tone, AppIconName> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert-triangle',
  danger: 'alert-circle',
  neutral: 'info',
};

interface AlertProps {
  tone?: Tone;
  title?: React.ReactNode;
  action?: React.ReactNode;
  /** Pass "alert" only for errors that must be announced immediately. */
  role?: 'alert' | 'status';
  className?: string;
  testId?: string;
  children?: React.ReactNode;
}

export const Alert: React.FC<AlertProps> = ({
  tone = 'info',
  title,
  action,
  role,
  className = '',
  testId,
  children,
}) => (
  <div
    className={`alert ${tone === 'neutral' ? '' : `alert-${tone}`} ${className}`}
    role={role}
    data-testid={testId}
  >
    <AppIcon name={icons[tone]} size={16} />
    <div className="alert-body">
      {title && <div className="alert-title">{title}</div>}
      {children}
    </div>
    {action && <div className="alert-actions">{action}</div>}
  </div>
);
