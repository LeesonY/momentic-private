// Approval-frozen one-ai_action replay uses at most four model decisions.
// The gateway may issue exactly one additional paid schema-repair request
// per decision, never more. A seeded fault has two independent replays.
// Count actual *provider* requests, not just accepted browser actions.
export function modelRequestsWithinApprovedBounds(parsed, fault) {
  const attempts = fault ? 2 : 1;
  const minimum = attempts * 2; // two distinct, observed DOM clicks each
  const maximum = attempts * 4 * 2; // decisions * (initial + one repair)
  return (
    parsed != null &&
    Number.isSafeInteger(parsed.providerCalls) &&
    parsed.providerCalls >= minimum &&
    parsed.providerCalls <= maximum &&
    parsed.recordedModelCalls === parsed.providerCalls &&
    parsed.settledCalls === parsed.providerCalls
  );
}

// Chromium baseline, independently verified with synthetic G2 on an actual
// local page: capture 1 + click 2 + navigate 1 + observe 4 + type_text 1.
// Each extra bounded model decision adds ONLY a read-only observe. Never
// permit additional click/navigation/type/capture under this tolerance.
export function browserActionsWithinApprovedBounds(parsed, fault) {
  if (!parsed || !parsed.actionCounts || Array.isArray(parsed.actionCounts))
    return false;
  const contexts = fault ? 2 : 1;
  const base = {
    capture: contexts,
    click: contexts * 2,
    navigate: contexts,
    observe: contexts * 4,
    type_text: contexts,
  };
  const counts = parsed.actionCounts;
  const keys = Object.keys(counts);
  if (keys.length !== Object.keys(base).length) return false;
  if (!keys.every((key) => Object.hasOwn(base, key))) return false;
  if (Object.entries(counts).some(([, n]) => !Number.isSafeInteger(n) || n < 0))
    return false;
  if (
    base.capture !== counts.capture ||
    base.click !== counts.click ||
    base.navigate !== counts.navigate ||
    base.type_text !== counts.type_text
  )
    return false;
  if (
    counts.observe < base.observe ||
    counts.observe > base.observe + contexts * 2
  )
    return false;
  return (
    parsed.browserActions ===
    Object.values(counts).reduce((n, total) => n + total, 0)
  );
}
