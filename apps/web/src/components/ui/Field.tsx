import React from 'react';

interface FieldProps {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  required?: boolean;
  optional?: boolean;
  className?: string;
  children: React.ReactNode;
}

/** Label + control + hint, stacked. */
export const Field: React.FC<FieldProps> = ({
  label,
  htmlFor,
  hint,
  required,
  optional,
  className = '',
  children,
}) => (
  <div className={`field ${className}`}>
    <label className="field-label" htmlFor={htmlFor}>
      {label}
      {required && (
        <span className="field-required" aria-hidden="true">
          *
        </span>
      )}
      {optional && <span className="field-optional">可选</span>}
    </label>
    {children}
    {hint && <p className="field-hint">{hint}</p>}
  </div>
);
