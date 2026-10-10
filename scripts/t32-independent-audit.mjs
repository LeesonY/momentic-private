// Read-only reconstruction of the complete T32 denominator. No provider
// calls, no rewriting or retroactively reclassifying a historical sample.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { T26_FIXTURES } from '../apps/worker/test/t26-business-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, 'docs/validation-results');
const rows = readFileSync(join(dir, 'T32-g3-moan2-business.ndjson'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const fixtures = new Map(T26_FIXTURES.map((flow) => [flow.id, flow]));
if (
  !rows.every(
    (r) =>
      r.campaign === 'T32' &&
      r.provider === 'moan2' &&
      r.configuredModel === 'MiniMax-M3' &&
      fixtures.has(r.flowId) &&
      r.pageStructure ===
        (fixtures.get(r.flowId).layoutFamily ?? 'simple_form') &&
      ['healthy', 'faulty'].includes(r.variant) &&
      [
        'TN',
        'TP',
        'execution_failure',
        'inconclusive',
        'potential_FP',
        'potential_FN',
      ].includes(r.classification),
  )
)
  throw new Error('T32_LEDGER_MIXED_OR_TAMPERED');

const successes = rows.filter((r) => r.passed === true);
const failures = rows.filter((r) => r.passed !== true);
const byFlow = [...new Set(rows.map((row) => row.flowId))].map((flowId) => {
  const source = rows.filter((row) => row.flowId === flowId);
  return {
    flowId,
    layoutFamily: fixtures.get(flowId).layoutFamily ?? 'simple_form',
    healthy: {
      correct: source.filter((r) => r.classification === 'TN').length,
      total: source.filter((r) => r.variant === 'healthy').length,
    },
    seededFault: {
      confirmed: source.filter((r) => r.classification === 'TP').length,
      total: source.filter((r) => r.variant === 'faulty').length,
    },
    otherOutcomes: source
      .filter((r) => r.passed !== true)
      .map((r) => ({
        variant: r.variant,
        classification: r.classification,
        reasonCode: r.diagnosticReason ?? null,
      })),
  };
});
const requestRows = rows.filter((r) =>
  Number.isSafeInteger(r.providerRequestsObserved),
);
const settledRows = rows.filter((r) =>
  Number.isSafeInteger(r.settledModelRequestsObserved),
);
const tokenRows = rows.filter((r) => r.tokens?.source === 'reported');
const sum = (array, getter) =>
  array.reduce((total, row) => total + getter(row), 0);
const result = {
  source: 'T32-g3-moan2-business.ndjson',
  model: 'moan2/MiniMax-M3',
  sampleCount: rows.length,
  complete: successes.length,
  incomplete: failures.length,
  healthy: {
    correct: successes.filter((r) => r.classification === 'TN').length,
    total: rows.filter((r) => r.variant === 'healthy').length,
  },
  seededFault: {
    confirmed: successes.filter((r) => r.classification === 'TP').length,
    total: rows.filter((r) => r.variant === 'faulty').length,
  },
  executionFailures: failures.filter(
    (r) => r.classification === 'execution_failure',
  ).length,
  inconclusive: failures.filter((r) => r.classification === 'inconclusive')
    .length,
  timeoutCount: rows.filter((r) => r.diagnosticReason === 'MODEL_TIMEOUT')
    .length,
  flowCount: byFlow.length,
  flows: byFlow,
  attemptsByBatch: [...new Set(rows.map((r) => r.batch))].map((batch) => {
    const group = rows.filter((r) => r.batch === batch);
    return {
      samples: group.length,
      complete: group.filter((r) => r.passed).length,
    };
  }),
  knownModelRequestUsage: {
    rowsWithObservedRequests: requestRows.length,
    observedProviderRequestsLowerBound: sum(
      requestRows,
      (r) => r.providerRequestsObserved,
    ),
    rowsWithObservedSettlements: settledRows.length,
    observedSettledRequestsLowerBound: sum(
      settledRows,
      (r) => r.settledModelRequestsObserved,
    ),
    rowsWithReportedTokens: tokenRows.length,
    knownReportedInputTokens: sum(tokenRows, (r) => r.tokens.input),
    knownReportedOutputTokens: sum(tokenRows, (r) => r.tokens.output),
    commercialCost: null,
  },
  historicRowsReclassified: 0,
  releaseG3Approved: false,
  releaseP0Approved: false,
};
writeFileSync(
  join(dir, 'T32-g3-independent-audit.json'),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(
  'T32_AUDIT',
  JSON.stringify({
    samples: result.sampleCount,
    complete: result.complete,
    healthy: result.healthy,
    seededFault: result.seededFault,
    executionFailures: result.executionFailures,
    inconclusive: result.inconclusive,
    observedProviderRequestsLowerBound:
      result.knownModelRequestUsage.observedProviderRequestsLowerBound,
    fullG3Approved: false,
  }),
);
