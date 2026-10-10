// Independently recompute G3 *coverage*, using existing live-provider ledgers.
// Coverage and correctness are not the same as signed-off G3/P0 release.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { T26_FIXTURES } from '../apps/worker/test/t26-business-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, 'docs/validation-results');
function loadRows(name) {
  return readFileSync(join(dir, name), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((row) => JSON.parse(row));
}
const t25Repetitions = loadRows('T25-g3-deepseek-pilot-samples.ndjson');
const t25Breadth = loadRows('T25-g3-deepseek-breadth.ndjson');
const t26 = loadRows('T26-g3-diverse-business.ndjson');
const firstBreadth = new Map();
for (const row of t25Breadth)
  if (!firstBreadth.has(row.scenario)) firstBreadth.set(row.scenario, row);
const known = T26_FIXTURES.map((f) => f.id);
const rows = [
  {
    id: 'approved-single-step-form',
    provenance: 'T25-breadth first real DeepSeek T17',
    healthyTotal: Number(firstBreadth.has('single_step_healthy')),
    healthyCorrect: Number(
      firstBreadth.get('single_step_healthy')?.classification === 'expected',
    ),
    faultsTotal: Number(firstBreadth.has('single_step_fault')),
    faultsCorrect: Number(
      firstBreadth.get('single_step_fault')?.classification === 'expected',
    ),
  },
  {
    id: 'approved-dynamic-order-preview',
    provenance: 'T25 independent real DeepSeek T18',
    healthyTotal: t25Repetitions.filter((row) => row.scenario === 'healthy')
      .length,
    healthyCorrect: t25Repetitions.filter(
      (row) => row.scenario === 'healthy' && row.classification === 'TN',
    ).length,
    faultsTotal: t25Repetitions.filter((row) => row.scenario === 'faulty')
      .length,
    faultsCorrect: t25Repetitions.filter(
      (row) => row.scenario === 'faulty' && row.classification === 'TP',
    ).length,
  },
  ...T26_FIXTURES.map((f) => {
    const cases = t26.filter((row) => row.flowId === f.id);
    const modelBackedFaults = cases.filter(
      (row) =>
        row.variant === 'faulty' &&
        row.classification !== 'execution_failure' &&
        row.providerCalls !== null,
    );
    return {
      id: f.id,
      provenance: 'T26 real DeepSeek frozen exact-business-value oracle',
      healthyTotal: cases.filter((row) => row.variant === 'healthy').length,
      healthyCorrect: cases.filter(
        (row) => row.variant === 'healthy' && row.classification === 'TN',
      ).length,
      faultsTotal: modelBackedFaults.length,
      faultsCorrect: cases.filter(
        (row) => row.variant === 'faulty' && row.classification === 'TP',
      ).length,
      faultExecutionFailures: cases.filter(
        (row) =>
          row.variant === 'faulty' &&
          row.classification === 'execution_failure',
      ).length,
      faultyAttemptsIncludingInfrastructure: cases.filter(
        (row) => row.variant === 'faulty',
      ).length,
    };
  }),
];
const total = (field) => rows.reduce((sum, row) => sum + row[field], 0);
const coverage = rows.map((row) => ({
  ...row,
  healthQuotaMet: row.healthyTotal >= 10,
  faultQuotaMet: row.faultsTotal >= 3,
}));
const healthyExecuted = total('healthyTotal');
const faultsExecuted = total('faultsTotal');
const result = {
  generatedAt: new Date().toISOString(),
  currentDate: '2026-10-09',
  model: 'deepseek-flash',
  genuineProviderEvidence: true,
  distinctScriptedWorkflows: coverage.length,
  newT26BusinessRules: known.length,
  healthy: {
    executed: healthyExecuted,
    correct: total('healthyCorrect'),
    minimum: 100,
    passTargetPercent: 95,
  },
  faults: {
    executed: faultsExecuted,
    confirmed: total('faultsCorrect'),
    minimum: 30,
    passTargetPercent: 90,
  },
  externalInfrastructure: {
    t26ModelPreflightFailures: t26.filter(
      (row) =>
        row.classification === 'execution_failure' &&
        row.providerCalls === null,
    ).length,
    verifiedDeepSeekHttpStatus: 402,
    diagnosis:
      'provider payment-required verified independently; no model-backed verdict. Do not score as false negative or confirmed bug.',
  },
  quotas: {
    healthFlowsMeeting10: coverage.filter((row) => row.healthQuotaMet).length,
    faultFlowsMeeting3: coverage.filter((row) => row.faultQuotaMet).length,
  },
  missingHealthExecutions: coverage.reduce(
    (n, row) => n + Math.max(0, 10 - row.healthyTotal),
    0,
  ),
  missingFaultExecutions: coverage.reduce(
    (n, row) => n + Math.max(0, 3 - row.faultsTotal),
    0,
  ),
  sourceMix: {
    t25RepeatedSamples: t25Repetitions.length,
    t25BreadthInitialSingleStep: 2,
    t26BusinessSamples: t26.length,
  },
  flows: coverage,
  normativeG3CoverageSatisfied:
    coverage.length >= 10 &&
    coverage.every((row) => row.healthQuotaMet && row.faultQuotaMet),
  technicalResultsPass:
    healthyExecuted > 0 &&
    faultsExecuted > 0 &&
    total('healthyCorrect') / healthyExecuted >= 0.95 &&
    total('faultsCorrect') / faultsExecuted >= 0.9 &&
    total('faultsCorrect') === faultsExecuted,
  independentHumanReviewSigned: false,
  G3Passed: false,
  P0Passed: false,
  limitations: [
    'T17 and T18 represent different interaction paths but share related local form semantics.',
    'All eight new workflows use two-stage DOM buttons. This does not test arbitrary websites, iframe/canvas, payment, or complex table widgets.',
    'Provider usage and model outputs are judged by independently frozen DOM criteria, not by model self-assessment.',
    'A true G3 release requires human review of the seeded oracle and any failures; G0–G4 P0 requirements are independent.',
  ],
};
writeFileSync(
  join(dir, 'T26-g3-coverage-current.json'),
  JSON.stringify(result, null, 2) + '\n',
  'utf8',
);
console.log(
  'T26_COVERAGE',
  JSON.stringify({
    flows: result.distinctScriptedWorkflows,
    healthy: result.healthy,
    faults: result.faults,
    missingHealth: result.missingHealthExecutions,
    missingFaults: result.missingFaultExecutions,
    coverageSatisfied: result.normativeG3CoverageSatisfied,
    p0Passed: false,
  }),
);
