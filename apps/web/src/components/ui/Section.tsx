import React from 'react';
import { AppIcon, type AppIconName } from './AppIcon.tsx';

interface SectionProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: AppIconName;
  actions?: React.ReactNode;
  tone?: 'default' | 'danger';
  /** No inner padding: for tables/lists that run edge to edge. */
  flush?: boolean;
  className?: string;
  testId?: string;
  children?: React.ReactNode;
}

/** A titled card: the standard grouping block on every page. */
export const Section: React.FC<SectionProps> = ({
  title,
  description,
  icon,
  actions,
  tone = 'default',
  flush = false,
  className = '',
  testId,
  children,
}) => (
  <section
    className={`card ${flush ? 'card-flush' : ''} ${tone === 'danger' ? 'is-danger' : ''} ${className}`}
    data-testid={testId}
  >
    {(title || actions) && (
      <div className="card-header">
        <div className="card-heading">
          {title && (
            <h2 className="card-title">
              {icon && <AppIcon name={icon} size={17} />}
              {title}
            </h2>
          )}
          {description && <p className="card-description">{description}</p>}
        </div>
        {actions && <div className="btn-group">{actions}</div>}
      </div>
    )}
    {children}
  </section>
);
