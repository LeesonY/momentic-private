import React, { useEffect, useId, useRef, useState } from 'react';

/**
 * A small anchored panel like Mo's composer menus: opens from its trigger,
 * closes on Escape or a click outside.
 */
export const Popover: React.FC<{
  /** Renders the trigger; spread the props onto a button. */
  trigger: (props: {
    'aria-expanded': boolean;
    'aria-controls': string;
    onClick: () => void;
  }) => React.ReactNode;
  title?: React.ReactNode;
  align?: 'start' | 'end';
  /** Opens upward, for triggers near the bottom of the screen. */
  placement?: 'below' | 'above';
  className?: string;
  testId?: string;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
}> = ({
  trigger,
  title,
  align = 'start',
  placement = 'below',
  className = '',
  testId,
  children,
}) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="mo-popover-root" ref={rootRef}>
      {trigger({
        'aria-expanded': open,
        'aria-controls': id,
        onClick: () => setOpen((value) => !value),
      })}
      {open && (
        <div
          id={id}
          role="dialog"
          className={`mo-popover is-${align} is-${placement} ${className}`}
          data-testid={testId}
        >
          {title && <div className="mo-popover-title">{title}</div>}
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
};
