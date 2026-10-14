import type { RepairSuggestionRecord, SavedCaseVersion } from '@localqa/contracts';
import {
  previewLocatorMaintenance,
  type LocatorMaintenancePreview,
} from './locatorMaintenanceDraft.ts';

/** Structural shortlist only: never an equivalence or verification verdict.
 * The server re-binds the original Worker witness at draft-creation time. */
export interface RankedLocatorCandidate {
  record: RepairSuggestionRecord;
  preview: LocatorMaintenancePreview;
  originalIndex: number;
  suggestionIndex: number;
  priority: number;
  rationale: string;
  newestTask: boolean;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

function compareNames(original: string, proposed: string): {
  priority: number;
  rationale: string;
} {
  const oldName = normalized(original);
  const newName = normalized(proposed);
  if (newName.startsWith(oldName) || oldName.startsWith(newName))
    return { priority: 200, rationale: '名称包含原有动作词；仍需核对业务含义' };
  const tokens = oldName.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3);
  if (tokens.length && tokens.some((token) => newName.includes(token)))
    return { priority: 150, rationale: '部分动作词重合；需要额外人工判断' };
  return { priority: 100, rationale: '语义候选仅通过浏览器唯一性检查；不可推定业务等价' };
}

export function rankLocatorMaintenanceCandidates(
  baseline: SavedCaseVersion | null,
  records: readonly RepairSuggestionRecord[],
): {
  candidates: RankedLocatorCandidate[];
  recommended: RankedLocatorCandidate | null;
  excludedCount: number;
} {
  if (!baseline || !records.length)
    return { candidates: [], recommended: null, excludedCount: records.length };

  // The API returns tasks newest-first; never silently switch to an older
  // task's suggestion when the newest failure cannot be safely screened.
  const newestTaskId = records[0]?.taskId;
  const seen = new Set<string>();
  const candidates: RankedLocatorCandidate[] = [];
  let excludedCount = 0;
  for (const [originalIndex, record] of records.entries()) {
    try {
      // The same pure preview is used in API draft creation. It rejects a
      // stale baseline, unsupported action, changed assertion or module path.
      const preview = previewLocatorMaintenance(baseline, record);
      // The evidence index must match the original DB-bound Worker array.
      const suggestionIndex = records
        .slice(0, originalIndex)
        .filter((row) => row.taskId === record.taskId).length;
      if (suggestionIndex > 2) throw Error('invalid suggestion index');
      const target = preview.after;
      const unique = [
        record.taskId, preview.stepIndex, target.by,
        target.value, normalized(target.name ?? ''),
      ].join('|');
      if (seen.has(unique)) {
        excludedCount++;
        continue;
      }
      seen.add(unique);
      const oldLabel = preview.before.by === 'role'
        ? preview.before.name ?? ''
        : preview.before.value;
      const similarity = compareNames(oldLabel, target.name ?? '');
      const structural = record.suggestion.kind === 'locator_name_variation';
      candidates.push({
        record, preview, originalIndex, suggestionIndex,
        priority: structural ? 300 : similarity.priority,
        rationale: structural
          ? '仅名称大小写或空格归一化差异，原步骤和角色保持不变'
          : similarity.rationale,
        newestTask: record.taskId === newestTaskId,
      });
    } catch {
      // Unsafe, malformed or stale suggestions are neither recommended nor
      // silently converted into editable versions.
      excludedCount++;
    }
  }
  candidates.sort((left, right) =>
    Number(right.newestTask) - Number(left.newestTask) ||
    right.priority - left.priority ||
    left.originalIndex - right.originalIndex,
  );
  const first = candidates[0];
  // Ambiguous competing candidates must never be auto-preselected. A low
  // lexical match may be useful for manual inspection, but is not recommended.
  const second = candidates[1];
  const recommended =
    first?.newestTask && first.priority >= 200 &&
    !(second?.newestTask && second.priority === first.priority)
      ? first
      : null;
  return { candidates, recommended, excludedCount };
}
