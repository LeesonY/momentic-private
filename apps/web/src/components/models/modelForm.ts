import type { ModelProfile } from '@localqa/contracts';
import {
  MODEL_DEFAULT_OUTPUT_TOKENS,
  MODEL_MIN_OUTPUT_TOKENS,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_MIN_CONTEXT_TOKENS,
  MODEL_MAX_CONTEXT_TOKENS,
  validModelTokenBudget,
} from '@localqa/contracts';
export { modelContextTokenLimit } from '@localqa/contracts';

/** Mirrors the gateway default and contract bounds for a per-call output cap. */
export const DEFAULT_OUTPUT_TOKENS = MODEL_DEFAULT_OUTPUT_TOKENS;
export const MIN_OUTPUT_TOKENS = MODEL_MIN_OUTPUT_TOKENS;
export const MAX_OUTPUT_TOKENS = MODEL_MAX_OUTPUT_TOKENS;
export const OUTPUT_TOKENS_RANGE_ERROR = `单次输出上限需为 ${MIN_OUTPUT_TOKENS}–${MAX_OUTPUT_TOKENS} 的整数`;

export const parseOutputTokens = (value: string): number | null => {
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= MIN_OUTPUT_TOKENS && n <= MAX_OUTPUT_TOKENS
    ? n
    : null;
};

export const parseContextTokens = (value: string): number | null => {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isInteger(number) &&
    number >= MODEL_MIN_CONTEXT_TOKENS &&
    number <= MODEL_MAX_CONTEXT_TOKENS
    ? number
    : null;
};
export const CONTEXT_TOKENS_RANGE_ERROR = `上下文窗口需为 ${MODEL_MIN_CONTEXT_TOKENS}–${MODEL_MAX_CONTEXT_TOKENS} 的整数`;
export const validateContextBudget = (
  contextWindowTokens: number | undefined,
  maxOutputTokens: number | undefined,
) => validModelTokenBudget({ contextWindowTokens, maxOutputTokens });

export const adapterLabels: Record<ModelProfile['adapter'], string> = {
  anthropic_messages: 'Anthropic Messages',
  openai_compatible: 'OpenAI 兼容',
};

export const statusMeta: Record<
  ModelProfile['status'],
  { label: string; className: string }
> = {
  untested: { label: '未探测', className: 'badge-neutral' },
  ready: { label: '可用', className: 'badge-success' },
  degraded: { label: '降级可用', className: 'badge-warning' },
  disabled: { label: '已停用', className: 'badge-danger' },
};
