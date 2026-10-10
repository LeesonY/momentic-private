import React from 'react';
import { AppIcon } from '../ui/AppIcon.tsx';

interface PageProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'title'
> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  /** Buttons aligned with the title. */
  actions?: React.ReactNode;
  /** Optional "back to list" link above the title. */
  back?: { label: string; onClick: () => void; testId?: string };
  /** default: reading width; wide: tables and dashboards; full: workbench. */
  width?: 'default' | 'wide' | 'full';
  className?: string;
  testId?: string;
  children: React.ReactNode;
}

/** Content area of one route inside AppShell. */
export const Page: React.FC<PageProps> = ({
  title,
  description,
  eyebrow,
  actions,
  back,
  width = 'default',
  className = '',
  testId,
  children,
  ...rest
}) => (
  <div
    {...rest}
    className={`lqa-page is-${width} ${className}`}
    data-testid={testId}
  >
    {back && (
      <button
        type="button"
        className="back-link"
        onClick={back.onClick}
        data-testid={back.testId}
      >
        <AppIcon name="chevron-left" size={15} />
        {back.label}
      </button>
    )}
    {(title || actions) && (
      <header className="page-header">
        <div className="page-heading">
          {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
          {title && <h1 className="page-title">{title}</h1>}
          {description && <p className="page-description">{description}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
    )}
    <div className="page-body">{children}</div>
  </div>
);
