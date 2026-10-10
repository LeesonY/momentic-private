import React, { useEffect, useId } from 'react';
import { AppIcon } from './AppIcon.tsx';

interface ModalProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  onClose: () => void;
  /** md ≈ 560px, lg ≈ 760px, xl ≈ 1040px */
  size?: 'md' | 'lg' | 'xl';
  /** Buttons pinned below the scrolling body. */
  footer?: React.ReactNode;
  /** Clicking the dimmed backdrop closes the dialog (default true). */
  closeOnOverlay?: boolean;
  overlayTestId?: string;
  testId?: string;
  closeTestId?: string;
  children: React.ReactNode;
}

/** Centered dialog with a scrolling body; Escape and the backdrop close it. */
export const Modal: React.FC<ModalProps> = ({
  title,
  description,
  onClose,
  size = 'md',
  footer,
  closeOnOverlay = true,
  overlayTestId,
  testId,
  closeTestId,
  children,
}) => {
  const titleId = useId();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      data-testid={overlayTestId}
      onClick={(event) => {
        if (closeOnOverlay && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal-panel is-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
      >
        <div className="modal-header">
          <div className="modal-heading">
            <h2 id={titleId} className="dialog-title">
              {title}
            </h2>
            {description && <p className="dialog-description">{description}</p>}
          </div>
          <button
            type="button"
            className="lqa-icon-button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
            data-testid={closeTestId}
          >
            <AppIcon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
};
