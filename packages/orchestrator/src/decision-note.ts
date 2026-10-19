import { sanitizeText } from '@localqa/browser';

/** Stored annotations are public evidence, never private reasoning or raw
 * model output. Fail closed on any saved credential match, before truncating:
 * a credential in the dropped tail must discard the entire annotation too. */
export function cleanDecisionNote(
  value: unknown,
  savedValues: readonly string[],
): string | null {
  if (typeof value !== 'string') return null;
  if (savedValues.some((secret) => secret.length > 0 && value.includes(secret)))
    return null;
  const sanitized = sanitizeText(value).replace(/\s+/g, ' ').trim();
  if (
    savedValues.some(
      (secret) => secret.length > 0 && sanitized.includes(secret),
    )
  )
    return null;
  const note = Array.from(sanitized).slice(0, 300).join('');
  return note || null;
}
