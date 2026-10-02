import { validateContract } from '@localqa/contracts';

export interface PlanReview {
  accepted: boolean;
  reason: 'sourced' | 'missing_source';
  missing: string[];
}

function criterionGaps(index: number, item: unknown): string[] {
  const result = validateContract('Criterion', item);
  if (result.success) return [];
  const gaps = new Set<string>();
  for (const error of result.errors) {
    const missingProperty =
      typeof error.params['missingProperty'] === 'string' ? error.params['missingProperty'] : null;
    const path = error.instancePath.replace(/^\//, '').replaceAll('/', '.');
    if (missingProperty) {
      gaps.add(path ? `${index}.${path}.${missingProperty}` : `${index}.${missingProperty}`);
      continue;
    }
    if (path) gaps.add(`${index}.${path}`);
  }
  if (gaps.size === 0) gaps.add(`${index}`);
  return [...gaps];
}

/** Planner output is rejected unless every criterion matches the Criterion contract. */
export function reviewPlan(input: unknown): PlanReview {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { accepted: false, reason: 'missing_source', missing: ['plan'] };
  }
  const criteria = (input as { criteria?: unknown }).criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { accepted: false, reason: 'missing_source', missing: ['criteria'] };
  }
  const missing = criteria.flatMap((item, index) => criterionGaps(index, item));
  if (missing.length > 0) return { accepted: false, reason: 'missing_source', missing };
  return { accepted: true, reason: 'sourced', missing: [] };
}
