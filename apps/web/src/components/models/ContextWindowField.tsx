import React from 'react';
import {
  MODEL_MIN_CONTEXT_TOKENS,
  MODEL_MAX_CONTEXT_TOKENS,
  modelContextTokenLimit,
} from '@localqa/contracts';
import { Field } from '../ui/Field.tsx';

export function ContextWindowField({
  id,
  value,
  onChange,
  maxOutputTokens,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  maxOutputTokens?: number;
  disabled?: boolean;
}) {
  const fallback = modelContextTokenLimit({ maxOutputTokens });
  return (
    <Field
      label="上下文窗口（token）"
      optional
      htmlFor={id}
      hint={`输入与输出的总额度；需大于单次输出上限。留空使用默认 ${fallback.toLocaleString('en-US')}`}
    >
      <input
        id={id}
        className="form-input"
        type="number"
        min={MODEL_MIN_CONTEXT_TOKENS}
        max={MODEL_MAX_CONTEXT_TOKENS}
        step={1}
        placeholder={`默认 ${fallback}`}
        value={value}
        disabled={disabled}
        data-testid={id}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
