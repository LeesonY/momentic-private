/**
 * Editable session budget defaults for the new-session composer.
 *
 * Mirrors the server's SESSION_DEFAULT_LIMITS (packages/domain/src/index.ts):
 * `{ ...DEFAULT_LIMITS, maxActiveSeconds: 3600, maxActionsPerCase: 24,
 * maxModelCalls: 300, maxTotalTokens: 3000000, maxActions: 200 }`.
 * The web app cannot import @localqa/domain (it is server-side and not a web
 * dependency), so the values are copied here; keep them in sync with the source
 * — `sessionBudget.test.mjs` asserts the numbers the composer shows.
 *
 * Only user-editable fields are listed. Non-editable limits
 * (maxModelCalls, maxReproductions, maxTotalTokens) are never sent from the
 * client so the server default always applies.
 */
export const SESSION_BUDGET_DEFAULTS = {
  maxCases: 8,
  maxPages: 6,
  maxDepth: 2,
  maxActiveSeconds: 3600,
  maxActions: 200,
  maxActionsPerCase: 24,
  concurrency: 2,
};
