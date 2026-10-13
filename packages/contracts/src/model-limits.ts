/** Shared defaults for stored model profiles, forms and the model gateway. */
export const MODEL_DEFAULT_INPUT_TOKENS = 12_000;
export const MODEL_DEFAULT_OUTPUT_TOKENS = 4_000;
export const MODEL_MIN_OUTPUT_TOKENS = 256;
export const MODEL_MAX_OUTPUT_TOKENS = 32_000;
export const MODEL_MIN_CONTEXT_TOKENS = 1_024;
export const MODEL_MAX_CONTEXT_TOKENS = 2_000_000;

export interface ModelTokenConfig {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export function modelOutputTokenLimit(profile?: ModelTokenConfig): number {
  const configured = profile?.maxOutputTokens;
  return typeof configured === 'number' &&
    Number.isSafeInteger(configured) &&
    configured >= MODEL_MIN_OUTPUT_TOKENS &&
    configured <= MODEL_MAX_OUTPUT_TOKENS
    ? configured
    : MODEL_DEFAULT_OUTPUT_TOKENS;
}

export function modelContextTokenLimit(profile?: ModelTokenConfig): number {
  return (
    profile?.contextWindowTokens ??
    MODEL_DEFAULT_INPUT_TOKENS + modelOutputTokenLimit(profile)
  );
}

export function validModelTokenBudget(profile: ModelTokenConfig): boolean {
  const window = profile.contextWindowTokens;
  return (
    window === undefined ||
    (Number.isSafeInteger(window) &&
      window >= MODEL_MIN_CONTEXT_TOKENS &&
      window <= MODEL_MAX_CONTEXT_TOKENS &&
      window > modelOutputTokenLimit(profile))
  );
}
