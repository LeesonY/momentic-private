const SOURCE_KINDS = new Set([
  'generic_smoke',
  'user_spec',
  'project_knowledge',
  'saved_case',
  'inferred',
]);

export interface PlanReview {
  accepted: boolean;
  reason: 'sourced' | 'missing_source';
  missing: string[];
}

/** Planner output is rejected unless every criterion carries an explicit source. */
export function reviewPlan(input: unknown): PlanReview {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { accepted: false, reason: 'missing_source', missing: ['plan'] };
  }
  const criteria = (input as { criteria?: unknown }).criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { accepted: false, reason: 'missing_source', missing: ['criteria'] };
  }
  const missing: string[] = [];
  for (const [index, item] of criteria.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      missing.push(`${index}`);
      continue;
    }
    const row = item as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || row['id'].length === 0) missing.push(`${index}.id`);
    if (typeof row['sourceKind'] !== 'string' || !SOURCE_KINDS.has(row['sourceKind'])) {
      missing.push(`${index}.sourceKind`);
    }
    if (typeof row['sourceRef'] !== 'string' || row['sourceRef'].length === 0) {
      missing.push(`${index}.sourceRef`);
    }
  }
  if (missing.length > 0) return { accepted: false, reason: 'missing_source', missing };
  return { accepted: true, reason: 'sourced', missing: [] };
}
