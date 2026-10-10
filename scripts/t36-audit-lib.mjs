// Read-only classification of the append-only real-model T36 ledger.
// Never infer missing provider billing, reclassify past failures, or pool G2.
export function auditT36(rows, campaign = 'T36') {
  if (!['T36', 'T37', 'T38'].includes(campaign) || !Array.isArray(rows))
    throw new Error('T36_INVALID_LEDGER');
  const expected = {
    'support-priority': 'reloaded_same_origin_iframe_confirmation',
    'room-upgrade': 'remounted_nested_open_shadow_confirmation',
  };
  const ids = new Set();
  for (const row of rows) {
    if (
      row?.campaign !== campaign ||
      row.provider !== 'moan2' ||
      row.configuredModel !== 'MiniMax-M3' ||
      !Object.hasOwn(expected, row.flowId) ||
      row.pageStructure !== expected[row.flowId] ||
      !['healthy', 'faulty'].includes(row.variant) ||
      ![
        'TN',
        'TP',
        'execution_failure',
        'inconclusive',
        'potential_FP',
        'potential_FN',
      ].includes(row.classification) ||
      typeof row.id !== 'string' ||
      ids.has(row.id) ||
      (row.passed === true) !== ['TN', 'TP'].includes(row.classification) ||
      (row.classification === 'TN' && row.variant !== 'healthy') ||
      (row.classification === 'TP' && row.variant !== 'faulty') ||
      (row.passed === true && row.approvedActions !== true) ||
      (row.classification === 'TP' &&
        (row.findingStatus !== 'confirmed' ||
          row.distinctContexts !== 2 ||
          row.distinctEvidence !== true ||
          JSON.stringify(row.verdicts) !== '["issue_found","issue_found"]')) ||
      (row.classification === 'TN' &&
        JSON.stringify(row.verdicts) !== '["passed"]')
    )
      throw new Error('T36_INVALID_LEDGER');
    ids.add(row.id);
  }
  const sum = (array, field) =>
    array.reduce((total, row) => total + field(row), 0);
  const observed = rows.filter((row) =>
    Number.isSafeInteger(row.providerRequestsObserved),
  );
  const settled = rows.filter((row) =>
    Number.isSafeInteger(row.settledModelRequestsObserved),
  );
  const tokens = rows.filter(
    (row) =>
      row.tokens?.source === 'reported' &&
      Number.isSafeInteger(row.tokens.input) &&
      Number.isSafeInteger(row.tokens.output),
  );
  return {
    source: `${campaign}-g3-moan2-business.ndjson`,
    campaign,
    model: 'moan2/MiniMax-M3',
    samples: rows.length,
    complete: rows.filter((row) => row.passed).length,
    incomplete: rows.filter((row) => !row.passed).length,
    healthy: {
      correct: rows.filter((row) => row.classification === 'TN').length,
      total: rows.filter((row) => row.variant === 'healthy').length,
    },
    seededFault: {
      confirmed: rows.filter((row) => row.classification === 'TP').length,
      total: rows.filter((row) => row.variant === 'faulty').length,
    },
    byFlow: Object.keys(expected).map((flowId) => {
      const selected = rows.filter((row) => row.flowId === flowId);
      return {
        flowId,
        pageStructure: expected[flowId],
        healthy: {
          correct: selected.filter((r) => r.classification === 'TN').length,
          total: selected.filter((r) => r.variant === 'healthy').length,
        },
        seededFault: {
          confirmed: selected.filter((r) => r.classification === 'TP').length,
          total: selected.filter((r) => r.variant === 'faulty').length,
        },
        unsuccessful: selected
          .filter((r) => !r.passed)
          .map((r) => ({
            variant: r.variant,
            reason: r.diagnosticReason ?? null,
            classification: r.classification,
          })),
      };
    }),
    knownUsage: {
      requestObservationRows: observed.length,
      observedProviderRequestsLowerBound: sum(
        observed,
        (r) => r.providerRequestsObserved,
      ),
      settlementRows: settled.length,
      observedSettlementsLowerBound: sum(
        settled,
        (r) => r.settledModelRequestsObserved,
      ),
      tokenRows: tokens.length,
      reportedInputTokens: sum(tokens, (r) => r.tokens.input),
      reportedOutputTokens: sum(tokens, (r) => r.tokens.output),
      commercialCost: null,
    },
    reclassifiedHistoricalRows: 0,
    formalG3Approved: false,
    p0Approved: false,
  };
}
