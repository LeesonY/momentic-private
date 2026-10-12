import type { BrowserSnapshot, CaseDefinition } from '@localqa/contracts';

/** Match the fixed body-visible oracle: ignore loading-only/secret nodes. */
export function hasReadableMainContent(
  snapshot: Pick<BrowserSnapshot, 'nodes'>,
): boolean {
  return snapshot.nodes.some(
    (node) =>
      node.visible &&
      node.frameId === 'main' &&
      node.text.trim().length > 0 &&
      !['password', 'hidden', 'canvas'].includes(node.role),
  );
}

/**
 * Only the exact server-owned FR-013/016 technical baseline needs no AI
 * navigation decisions. No user-authored/business/semantic case can opt in.
 */
export function isFixedTechnicalSmoke(
  definition: Pick<CaseDefinition, 'criteria' | 'outline'> | null,
): boolean {
  return (
    !!definition &&
    definition.outline.length === 2 &&
    definition.outline[0]?.startsWith('Navigate ') === true &&
    definition.outline[1] === 'Observe visible primary content' &&
    definition.criteria.length === 2 &&
    definition.criteria.some((c) => c.id === 'smoke.http') &&
    definition.criteria.some((c) => c.id === 'smoke.visible') &&
    definition.criteria.every(
      (criterion) =>
        criterion.sourceKind === 'generic_smoke' &&
        ((criterion.kind === 'http_status' &&
          criterion.sourceRef === 'FR-013/016' &&
          typeof criterion.expectedValue === 'object' &&
          criterion.expectedValue !== null &&
          !Array.isArray(criterion.expectedValue) &&
          criterion.expectedValue.min === 200 &&
          criterion.expectedValue.max === 399) ||
          (criterion.kind === 'element_visible' &&
            criterion.sourceRef === 'FR-016' &&
            criterion.locator?.by === 'css' &&
            criterion.locator.value === 'body' &&
            criterion.expectedValue === undefined)),
    )
  );
}
