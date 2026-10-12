// docs/03-data-and-api.md §7: HTTP errors and run reasons are distinct.
// null means the document specifies a run/input/action reason, not an HTTP status.
export const ERROR_HTTP_STATUS = Object.freeze({
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  TARGET_NOT_ALLOWED: 422,
  MODEL_NOT_CONFIGURED: 409,
  CONFIG_IN_USE: 409,
  MODEL_BILLING_REQUIRED: 402,
  PROJECT_ARCHIVED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  EVENTS_EXPIRED: 410,
  RATE_LIMITED: 429,
  BROWSER_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  ARTIFACT_TOO_LARGE: 413,
  LEASE_EXPIRED: 409,
  ACTION_OUTCOME_UNKNOWN: 409,
  AUTH_REQUIRED: null,
  AUTH_FAILED: null,
  CAPTCHA_REQUIRED: null,
  MODEL_CAPABILITY_MISSING: null,
  MODEL_TIMEOUT: null,
  MODEL_OUTPUT_TRUNCATED: null,
  MODEL_INVALID_JSON: null,
  MODEL_SCHEMA_MISMATCH: null,
  MODEL_TOOL_CONTRACT_INVALID: null,
  POLICY_DENIED: null,
  SCOPE_CHANGED: null,
  BUDGET_EXCEEDED: null,
  INPUT_TIMEOUT: null,
  USER_CANCELLED: null,
} as const);
export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;
export const ERROR_CODES = Object.freeze(
  Object.keys(ERROR_HTTP_STATUS) as ErrorCode[],
);
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_HTTP_STATUS, value);
}
// Error.code and Verdict.reasonCode remain strings exactly as specified by the
// JSON contracts (examples also use NORMAL/CRITERION_FAILED). No enum narrowing
// is applied to their runtime schemas here.
