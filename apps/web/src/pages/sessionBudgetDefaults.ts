/**
 * Editable session budget defaults for the new-session composer.
 *
 * Mirrors the server's SESSION_DEFAULT_LIMITS (packages/domain/src/index.ts,
 * merged to deploy/mo-next-66 in 631540e): `{ ...DEFAULT_LIMITS,
 * maxActiveSeconds: 1800, maxActionsPerCase: 24, maxModelCalls: 300,
 * maxTotalTokens: 1500000 }`.
 * This branch predates that merge, so the constant is copied here with the
 * source noted; switch to importing it from @localqa/domain once available.
 *
 * Only user-editable fields are listed. Non-editable limits
 * (maxModelCalls, maxReproductions, maxTotalTokens) are never sent from the
 * client so the server default always applies.
 */
export const SESSION_BUDGET_DEFAULTS = {
  maxCases: 8,
  maxPages: 6,
  maxDepth: 2,
  maxActiveSeconds: 1800,
  maxActions: 120,
  maxActionsPerCase: 24,
  concurrency: 2,
};
