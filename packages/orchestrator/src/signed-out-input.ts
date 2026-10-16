import type { ToolCall } from '@localqa/contracts';

/**
 * Mo's subagents may TYPE into a password box. A session-managed smoke run's
 * immutable signed-out case (`requiresLogin === false`) may therefore use an
 * obviously fictional test value on a password/sensitive input, while hidden
 * inputs stay forbidden, saved credentials are refused before the grant, and
 * every other lane (signed-in cases, explorers, regression runs) keeps the
 * original rule.
 */
export const SIGNED_OUT_SENSITIVE_TOOLS: readonly string[] = Object.freeze([
  'type_text',
  'click',
  'press',
  'select_option',
]);

/**
 * A saved value shorter than this is only compared by equality: matching a
 * short common string as a substring would deny ordinary test data (a two
 * character password, "id", "1", ...) without protecting anything.
 */
export const SAVED_VALUE_CONTAINMENT_MIN = 4;

export interface SensitiveInputNode {
  sensitive?: boolean | undefined;
  inputType?: string | null | undefined;
  role?: string | null | undefined;
}

/** A hidden input is never typed into, released lane or not. */
export function isHiddenInput(node: SensitiveInputNode): boolean {
  return node.inputType === 'hidden' || node.role === 'hidden';
}

/** Password fields and inputs the snapshot explicitly marked sensitive. */
export function isSensitiveInput(node: SensitiveInputNode): boolean {
  return (
    node.sensitive === true ||
    node.inputType === 'password' ||
    node.role === 'password'
  );
}

/** The input/click tools the released signed-out lane may use on such a node. */
export function isReleasedSensitiveTool(tool: string): boolean {
  return SIGNED_OUT_SENSITIVE_TOOLS.includes(tool);
}

/** The one text value an input action carries, if any. */
export function inputValueOf(call: ToolCall): string | null {
  if (call.name === 'type_text') return call.args.text;
  if (call.name === 'select_option') return call.args.value;
  return null;
}

/**
 * True when a would-be input is a saved credential: equality always matches;
 * a saved value of at least SAVED_VALUE_CONTAINMENT_MIN characters also
 * matches as a substring of the input. Comparison is exact and case
 * sensitive; the caller never logs or returns either value.
 */
export function matchesSavedCredential(
  value: string,
  saved: readonly string[],
): boolean {
  if (value.length === 0) return false;
  for (const candidate of saved) {
    if (candidate.length === 0) continue;
    if (value === candidate) return true;
    if (
      candidate.length >= SAVED_VALUE_CONTAINMENT_MIN &&
      value.includes(candidate)
    )
      return true;
  }
  return false;
}
