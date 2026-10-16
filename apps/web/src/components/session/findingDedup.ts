import type { Finding } from '@localqa/contracts';

/** The Mo run merge adds `duplicateOf` on the absorbed finding; older
 * servers omit it, so every read goes through this helper. */
export type FindingMaybeMerged = Finding & { duplicateOf?: string | null };

export const findingDuplicateOf = (finding: Finding): string | null => {
  const target = (finding as FindingMaybeMerged).duplicateOf;
  return typeof target === 'string' && target.trim() ? target : null;
};

/** A finding is merged into another one when triageDisposition is
 * 'duplicate' or when the newer backend left a duplicateOf pointer. */
export const isDuplicateFinding = (finding: Finding): boolean =>
  finding.triageDisposition === 'duplicate' ||
  findingDuplicateOf(finding) !== null;

/** Findings that count as real defects: merged duplicates never count. */
export const visibleFindings = (findings: readonly Finding[]): Finding[] =>
  findings.filter((finding) => !isDuplicateFinding(finding));

/** Findings merged into the retained one; shown underneath it. */
export const mergedInto = (
  findings: readonly Finding[],
  retainedId: string,
): Finding[] =>
  findings.filter((finding) => findingDuplicateOf(finding) === retainedId);

/** A merged finding whose target is not in this list is shown on its own
 * and flagged as a duplicate, so nothing silently disappears. */
export const orphanMergedFindings = (
  findings: readonly Finding[],
): Finding[] => {
  const ids = new Set(findings.map((finding) => finding.id));
  return findings.filter((finding) => {
    const target = findingDuplicateOf(finding);
    return isDuplicateFinding(finding) && (!target || !ids.has(target));
  });
};

/** One row of a defects list: a retained finding with the duplicates that
 * were merged into it, or an orphaned duplicate shown on its own. */
export interface FindingGroup {
  finding: Finding;
  merged: Finding[];
  /** True when the row is itself a merged duplicate without its target. */
  orphan: boolean;
}

/** Groups findings the way every defect list presents them: retained
 * findings carry their merged duplicates; duplicates with a visible target
 * never appear as standalone rows. */
export const groupFindings = (findings: readonly Finding[]): FindingGroup[] => {
  const retained = visibleFindings(findings).map((finding) => ({
    finding,
    merged: mergedInto(findings, finding.id),
    orphan: false,
  }));
  const orphans = orphanMergedFindings(findings).map((finding) => ({
    finding,
    merged: [],
    orphan: true,
  }));
  return [...retained, ...orphans];
};

/** The number users see next to "缺陷": duplicates never add to it. */
export const countFindings = (findings: readonly Finding[]): number =>
  visibleFindings(findings).length;
