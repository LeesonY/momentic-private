import type { Step } from '@localqa/contracts';

/** Enumerated-looking reason codes only; anything else is not diagnostic. */
const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
const FALLBACK_REASON_CODE = 'BROWSER_FAILED';

/**
 * A browser action's reason code is diagnostic metadata. Only a bounded,
 * code-shaped value is kept: an arbitrary message could carry typed text,
 * credentials or a URL query string, so anything else is replaced by a generic
 * code instead of being persisted or shown to a user.
 */
export function safeStepReasonCode(
  reasonCode: string | null | undefined,
): string | null {
  if (!reasonCode) return null;
  return SAFE_REASON_CODE.test(reasonCode)
    ? reasonCode
    : FALLBACK_REASON_CODE;
}

/**
 * The step document once a browser action settles. A failed, cancelled or
 * unknown action carries its reason code so the cause can be read from the
 * database without replaying worker logs; a succeeded action carries none.
 */
export function settledStep(
  current: Step,
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown',
  evidence: readonly string[],
  reasonCode?: string | null,
  finishedAt: string = new Date().toISOString(),
): Step {
  const safe =
    status === 'succeeded' ? null : safeStepReasonCode(reasonCode);
  return {
    ...current,
    status,
    evidenceRefs: [...evidence],
    finishedAt,
    summary: `Browser ${status}`,
    ...(safe ? { reasonCode: safe } : {}),
  };
}
