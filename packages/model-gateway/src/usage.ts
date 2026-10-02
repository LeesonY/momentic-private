export type UsageSource = 'reported' | 'estimated' | 'mixed' | 'unknown';

/** Empty text has no token count. A non-empty text is never estimated as zero. */
export function estimateTokens(text: string): number | null {
  if (text.length === 0) return null;
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface UsageAttempt {
  source: 'reported' | 'estimated';
  inputTokens: number;
  outputTokens: number | null;
}

export interface CombinedUsage {
  usageSource: UsageSource;
  inputTokens: number | null;
  outputTokens: number | null;
  requests: number;
}

export function combineUsage(parts: readonly UsageAttempt[]): CombinedUsage {
  if (parts.length === 0) {
    return {
      usageSource: 'unknown',
      inputTokens: null,
      outputTokens: null,
      requests: 0,
    };
  }
  const sources = new Set(parts.map((part) => part.source));
  const usageSource = sources.size === 1 ? [...sources][0]! : 'mixed';
  const inputTokens = parts.reduce((sum, part) => sum + part.inputTokens, 0);
  const outputKnown = parts.every((part) => part.outputTokens !== null);
  const outputTokens = outputKnown
    ? parts.reduce((sum, part) => sum + (part.outputTokens ?? 0), 0)
    : null;
  return { usageSource, inputTokens, outputTokens, requests: parts.length };
}
