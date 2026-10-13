import type { BrowserSnapshot, Locator } from '@localqa/contracts';
import type { CompiledRegressionStep } from '@localqa/orchestrator';

/** An inert suggestion attached to a failed replay, never an executable
 * fallback target or a version mutation. Human review and independent
 * verification remain mandatory before changing an approved case. */
export interface LocatorRepairSuggestion {
  kind: 'locator_name_variation';
  source: CompiledRegressionStep['source'];
  original: Locator;
  proposed: Locator;
  reasonCode: 'LOCATOR_NOT_FOUND';
  snapshotId: string;
  pageId: string;
  observedOrigin: string;
  reviewRequired: true;
  verification: 'not_run';
}

const normalizeName = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\s\u00a0]+/gu, ' ')
    .trim();

/** Conservative, evidence-only candidate generation: no AI call, no click,
 * no mutation and no guessing across roles/frames or truncated snapshots.
 * Only a unique case/spacing/name variation may be proposed. */
export function suggestLocatorRepair(input: {
  locator: Locator;
  source: CompiledRegressionStep['source'];
  snapshot: BrowserSnapshot | null;
  reasonCode: string | null;
}): LocatorRepairSuggestion | null {
  const { locator, source, snapshot, reasonCode } = input;
  if (
    reasonCode !== 'LOCATOR_NOT_FOUND' ||
    !snapshot?.redacted ||
    snapshot.truncated ||
    !['role', 'label'].includes(locator.by)
  )
    return null;
  const originalName = locator.by === 'role' ? locator.name : locator.value;
  if (!originalName || originalName.length < 4 || originalName.length > 120)
    return null;
  const normalized = normalizeName(originalName);
  if (normalized.length < 4) return null;
  const eligible = snapshot.nodes.filter(
    (node) =>
      node.frameId === 'main' &&
      node.visible &&
      node.enabled &&
      !node.sensitive &&
      node.inputType !== 'password' &&
      node.role.length > 0 &&
      node.role !== 'generic' &&
      (locator.by !== 'label' ||
        ['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(
          node.role,
        )) &&
      node.name.length >= 4 &&
      node.name.length <= 120 &&
      normalizeName(node.name) === normalized &&
      (locator.by === 'label' || node.role === locator.value),
  );
  if (eligible.length !== 1) return null;
  const candidate = eligible[0]!;
  const proposed: Locator = {
    by: 'role',
    value: candidate.role,
    name: candidate.name,
  };
  // An unchanged frozen semantic locator that unexpectedly failed needs
  // diagnosis, not a bogus repair proposal.
  if (
    locator.by === 'role' &&
    proposed.value === locator.value &&
    proposed.name === locator.name
  )
    return null;
  let observedOrigin: string;
  try {
    const url = new URL(snapshot.displayUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    observedOrigin = url.origin; // never persist URL query tokens or fragments
  } catch {
    return null;
  }
  return {
    kind: 'locator_name_variation',
    source,
    original: locator,
    proposed,
    reasonCode: 'LOCATOR_NOT_FOUND',
    snapshotId: snapshot.snapshotId,
    pageId: snapshot.pageId,
    observedOrigin,
    reviewRequired: true,
    verification: 'not_run',
  };
}
