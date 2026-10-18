/**
 * Reason codes for an action refused before execution (the grant/ledger
 * stage). The browser execution layer has its own set (`STABLE_REASON_CODES`);
 * these are the orchestration-side refusals that surface in the same
 * `ToolResult.reasonCode` field, so the model can tell "snapshot is stale,
 * retry with the newest observation" from "this action is forbidden by
 * design, stop trying".
 *
 * Registered in docs/03 §7.1.
 */
export const ACTION_DENIAL_CODES = Object.freeze({
  POLICY_DENIED: 'POLICY_DENIED',
  TARGET_NOT_ALLOWED: 'TARGET_NOT_ALLOWED',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_HIDDEN: 'TARGET_HIDDEN',
  TARGET_DISABLED: 'TARGET_DISABLED',
  HIDDEN_INPUT_FORBIDDEN: 'HIDDEN_INPUT_FORBIDDEN',
  SENSITIVE_INPUT_FORBIDDEN: 'SENSITIVE_INPUT_FORBIDDEN',
  SAVED_CREDENTIAL_INPUT: 'SAVED_CREDENTIAL_INPUT',
  OUT_OF_SCOPE_MUTATION: 'OUT_OF_SCOPE_MUTATION',
  CASE_ACTION_LIMIT: 'CASE_ACTION_LIMIT',
} as const);

export type ActionDenialCode =
  (typeof ACTION_DENIAL_CODES)[keyof typeof ACTION_DENIAL_CODES];

export function isActionDenialCode(code: unknown): code is ActionDenialCode {
  return typeof code === 'string' && Object.hasOwn(ACTION_DENIAL_CODES, code);
}
