import type {
  Locator,
  RegressionDocument,
  RepairSuggestionRecord,
  SavedCaseVersion,
} from '@localqa/contracts';

export interface LocatorMaintenancePreview {
  document: RegressionDocument;
  stepIndex: number;
  before: Locator;
  after: Locator;
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\s\u00a0]+/gu, ' ')
    .trim();
}

/**
 * Transform a reviewed-version execution hint into a FULL, non-executable
 * draft preview. Reject any hint that could change oracles, modules, business
 * semantics or unrelated actions. The caller still needs to explicitly
 * create a DRAFT and use the ordinary independent review workflow.
 */
export function previewLocatorMaintenance(
  baseline: SavedCaseVersion,
  record: RepairSuggestionRecord,
): LocatorMaintenancePreview {
  const refuse = (): never => {
    throw new Error('证据或已批准版本不匹配，不能自动生成维护候选');
  };
  const hint = record.suggestion;
  const source = hint.source;
  const steps = baseline.document.steps;
  if (
    baseline.reviewStatus !== 'approved' ||
    baseline.id !== record.sourceVersionId ||
    hint.kind !== 'locator_name_variation' ||
    hint.reasonCode !== 'LOCATOR_NOT_FOUND' ||
    !hint.reviewRequired ||
    hint.verification !== 'not_run' ||
    source.documentId !== baseline.document.id ||
    source.modulePath.length !== 0 ||
    !Number.isSafeInteger(source.stepIndex) ||
    source.stepIndex < 0 ||
    source.stepIndex >= steps.length
  )
    return refuse();
  const target = steps[source.stepIndex]!;
  if (target.kind !== 'click' && target.kind !== 'type_text') return refuse();
  const actual = target.locator;
  if (
    actual.by !== hint.original.by ||
    actual.value !== hint.original.value ||
    ('name' in actual ? actual.name : undefined) !== hint.original.name ||
    hint.proposed.by !== 'role' ||
    !hint.proposed.name ||
    hint.proposed.name.length < 4 ||
    hint.proposed.name.length > 120 ||
    !['role', 'label'].includes(actual.by)
  )
    return refuse();
  const oldName = actual.by === 'role' ? actual.name : actual.value;
  if (
    !oldName ||
    normalized(oldName).length < 4 ||
    normalized(oldName) !== normalized(hint.proposed.name) ||
    (actual.by === 'role' && actual.value !== hint.proposed.value) ||
    (actual.by === 'role' &&
      actual.value === hint.proposed.value &&
      actual.name === hint.proposed.name) ||
    (target.kind === 'type_text' &&
      !['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(
        hint.proposed.value,
      ))
  )
    return refuse();
  // The hint must have been observed on one of the frozen navigated origins,
  // not on a foreign page. Unknown/templated destinations are not guessed.
  const navigations = steps.filter((step) => step.kind === 'navigate');
  if (
    !navigations.some((step) => {
      try {
        return new URL(step.url).origin === hint.observedOrigin;
      } catch {
        return false;
      }
    })
  )
    return refuse();
  const document = structuredClone(baseline.document);
  const patched = document.steps[source.stepIndex]!;
  if (patched.kind !== 'click' && patched.kind !== 'type_text') return refuse();
  patched.locator = structuredClone(hint.proposed);
  return {
    document,
    stepIndex: source.stepIndex,
    before: structuredClone(actual),
    after: structuredClone(hint.proposed),
  };
}
