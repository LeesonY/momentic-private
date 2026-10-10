import { readFileSync } from 'node:fs';
import { isValidUuid } from './recorder.js';

export interface ActionAuditRecovery {
  attemptId: string;
  tool: string;
  status: 'settled' | 'outcome_unknown';
  outcome: string | null;
  reasonCode: string | null;
  actionId: string | null;
  requiresReview: boolean;
}

/** Recovery is read-only. An orphan intent, cancelled action with a
 * non-null actionId or failed action after dispatch must NOT be replayed.
 * No DOM content or tool payload is trusted from this file.
 */
export function inspectActionAudit(filePath: string): ActionAuditRecovery[] {
  const raw = readFileSync(filePath, 'utf8');
  if (raw.length > 10_000_000) throw new Error('ACTION_AUDIT_TOO_LARGE');
  const attempts = new Map<string, ActionAuditRecovery>();
  let scope: string | null = null;
  let count = 0;
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    if (++count > 20000) throw new Error('ACTION_AUDIT_TOO_LARGE');
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error('ACTION_AUDIT_CORRUPT');
    }
    if (
      row.schema !== 1 ||
      !isValidUuid(row.attemptId) ||
      !isValidUuid(row.runId) ||
      !isValidUuid(row.projectId) ||
      !['intent', 'settlement'].includes(String(row.phase)) ||
      ![
        'navigate',
        'click',
        'type_text',
        'select_option',
        'press',
        'scroll',
      ].includes(String(row.tool))
    )
      throw new Error('ACTION_AUDIT_CORRUPT');
    const rowScope = JSON.stringify([row.projectId, row.runId, row.taskId]);
    if (scope !== null && rowScope !== scope)
      throw new Error('ACTION_AUDIT_MIXED_SCOPE');
    scope = rowScope;
    const id = row.attemptId as string;
    if (row.phase === 'intent') {
      if (attempts.has(id)) throw new Error('ACTION_AUDIT_CORRUPT');
      attempts.set(id, {
        attemptId: id,
        tool: row.tool as string,
        status: 'outcome_unknown',
        outcome: null,
        reasonCode: null,
        actionId: null,
        requiresReview: true,
      });
    } else {
      const pending = attempts.get(id);
      if (
        !pending ||
        pending.status !== 'outcome_unknown' ||
        pending.tool !== row.tool ||
        ![
          'succeeded',
          'failed',
          'denied',
          'cancelled',
          'blocked',
          'unknown',
        ].includes(String(row.outcome)) ||
        (row.actionId !== null && !isValidUuid(row.actionId)) ||
        (row.reasonCode !== null &&
          (typeof row.reasonCode !== 'string' || row.reasonCode.length > 80))
      )
        throw new Error('ACTION_AUDIT_CORRUPT');
      pending.status = 'settled';
      pending.outcome = row.outcome as string;
      pending.reasonCode = row.reasonCode as string | null;
      pending.actionId = row.actionId as string | null;
      pending.requiresReview =
        row.outcome === 'unknown' ||
        (row.actionId !== null && row.outcome !== 'succeeded');
    }
  }
  return [...attempts.values()];
}
