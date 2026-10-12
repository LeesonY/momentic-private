import React from 'react';
import { AppIcon, type AppIconName } from './AppIcon.tsx';

interface EmptyStateProps {
  title: string;
  description?: string;
  actionText?: string;
  onAction?: () => void;
  icon?: AppIconName;
  compact?: boolean;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  actionText,
  onAction,
  icon = 'inbox',
  compact = false,
}) => (
  <div
    className={`empty-state ${compact ? 'is-compact' : ''}`}
    data-testid="empty-state"
  >
    <span className="empty-state-icon">
      <AppIcon name={icon} size={22} />
    </span>
    <h3 className="empty-state-title">{title}</h3>
    {description && <p className="empty-state-description">{description}</p>}
    {actionText && onAction && (
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={onAction}
      >
        {actionText}
      </button>
    )}
  </div>
);
