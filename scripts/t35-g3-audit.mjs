// Read-only, provider-isolated verification of the append-only real-model
// samples. This helper NEVER calls the model or edits original ledger rows.
export function auditT35(rows) {
  if (!Array.isArray(rows)) throw new Error('T35_LEDGER_NOT_AN_ARRAY');
  const expectedStructures = {
    'support-priority': 'same_origin_iframe_async_confirmation',
    'room-upgrade': 'nested_open_shadow_async_confirmation',
  };
  const ids = new Set();
  for (const r of rows) {
    if (
      !r ||
      r.campaign !== 'T35' ||
      r.provider !== 'moan2' ||
      r.configuredModel !== 'MiniMax-M3' ||
      !Object.hasOwn(expectedStructures, r.flowId) ||
      r.pageStructure !== expectedStructures[r.flowId] ||
      !['healthy', 'faulty'].includes(r.variant) ||
      ![
        'TN',
        'TP',
        'execution_failure',
        'inconclusive',
        'potential_FP',
        'potential_FN',
      ].includes(r.classification) ||
      r.passed !== (r.classification === 'TN' || r.classification === 'TP') ||
      (r.variant === 'healthy' && r.classification === 'TP') ||
      (r.variant === 'faulty' && r.classification === 'TN') ||
      typeof r.id !== 'string' ||
      ids.has(r.id)
    )
      throw new Error('T35_LEDGER_INVALID_OR_MIXED_MODEL');
    ids.add(r.id);
  }
  const byFlow = Object.keys(expectedStructures).map((flowId) => {
    const selection = rows.filter((r) => r.flowId === flowId);
    return {
      flowId,
      pageStructure: expectedStructures[flowId],
      healthy: {
        correct: selection.filter((r) => r.classification === 'TN').length,
        total: selection.filter((r) => r.variant === 'healthy').length,
      },
      seededFault: {
        confirmed: selection.filter((r) => r.classification === 'TP').length,
        total: selection.filter((r) => r.variant === 'faulty').length,
      },
      unsuccessful: selection
        .filter((r) => !r.passed)
        .map((r) => ({
          variant: r.variant,
          classification: r.classification,
          diagnosticReason: r.diagnosticReason ?? null,
          failureTag: r.failureTag ?? null,
        })),
    };
  });
  const observedCalls = rows.filter((r) =>
    Number.isSafeInteger(r.providerRequestsObserved),
  );
  const settledCalls = rows.filter((r) =>
    Number.isSafeInteger(r.settledModelRequestsObserved),
  );
  const withTokens = rows.filter(
    (r) =>
      r.tokens?.source === 'reported' &&
      Number.isSafeInteger(r.tokens.input) &&
      Number.isSafeInteger(r.tokens.output),
  );
  const sum = (selected, field) =>
    selected.reduce((count, row) => count + field(row), 0);
  return {
    source: 'T35-g3-moan2-business.ndjson',
    provider: 'moan2',
    model: 'MiniMax-M3',
    sampleCount: rows.length,
    complete: rows.filter((r) => r.passed).length,
    failed: rows.filter((r) => !r.passed).length,
    healthy: {
      correct: rows.filter((r) => r.classification === 'TN').length,
      total: rows.filter((r) => r.variant === 'healthy').length,
    },
    seededFault: {
      confirmed: rows.filter((r) => r.classification === 'TP').length,
      total: rows.filter((r) => r.variant === 'faulty').length,
    },
    reasons: Object.fromEntries(
      [
        ...new Set(
          rows
            .filter((r) => !r.passed)
            .map((r) => r.diagnosticReason ?? 'unknown'),
        ),
      ].map((reason) => [
        reason,
        rows.filter(
          (r) => !r.passed && (r.diagnosticReason ?? 'unknown') === reason,
        ).length,
      ]),
    ),
    byFlow,
    batches: [...new Set(rows.map((r) => r.batch))].map((batch) => {
      const related = rows.filter((r) => r.batch === batch);
      return {
        batch,
        samples: related.length,
        complete: related.filter((r) => r.passed).length,
      };
    }),
    usage: {
      observedProviderCallRows: observedCalls.length,
      observedProviderRequestsLowerBound: sum(
        observedCalls,
        (r) => r.providerRequestsObserved,
      ),
      observedSettlementRows: settledCalls.length,
      observedSettledRequestsLowerBound: sum(
        settledCalls,
        (r) => r.settledModelRequestsObserved,
      ),
      reportedTokenRows: withTokens.length,
      knownReportedInputTokens: sum(withTokens, (r) => r.tokens.input),
      knownReportedOutputTokens: sum(withTokens, (r) => r.tokens.output),
      vendorInvoice: null,
    },
    historicRowsReclassified: 0,
    formalG3Approved: false,
    p0Approved: false,
  };
}
