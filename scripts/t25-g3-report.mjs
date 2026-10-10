// Deterministic read-only aggregation of T25's append-only G3 evidence.
// Does NOT call a model or recompute verdicts from model narratives.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = join(root, 'docs/validation-results');
function readJson(name) {
  return JSON.parse(readFileSync(join(data, name), 'utf8'));
}
function readLines(name) {
  const content = readFileSync(join(data, name), 'utf8');
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const repeated = readLines('T25-g3-deepseek-pilot-samples.ndjson');
const breadth = readLines('T25-g3-deepseek-breadth.ndjson');
const latest = new Map();
const first = new Map();
for (const sample of breadth) {
  if (!first.has(sample.scenario)) first.set(sample.scenario, sample);
  latest.set(sample.scenario, sample);
}
const breadthResults = Array.from(latest, ([scenario, last]) => ({
  scenario,
  firstResult: first.get(scenario).classification,
  latestResult: last.classification,
  totalObserved: breadth.filter((x) => x.scenario === scenario).length,
  postFixPass:
    first.get(scenario).classification !== 'expected' &&
    last.classification === 'expected',
  hasUnresolvedFailure: last.classification !== 'expected',
}));
const quality = readJson('T25-g3-deepseek-pilot-summary.json');
if (quality.allResults !== repeated.length)
  throw Error('T25_PILOT_LEDGER_SUMMARY_MISMATCH');
const aggregate = {
  generatedAt: new Date().toISOString(),
  provider: 'DeepSeek',
  model: 'deepseek-flash',
  benchmark: 'G3 real model + localhost approved technical oracle',
  repeatedTwoStep: {
    healthy: quality.healthy,
    faulty: quality.faulty,
    calls: quality.providerCallsRecorded,
    reportedTokens: quality.reportedTokens,
    sampleCount: repeated.length,
    executionFailures: quality.executionFailures,
    inconclusive: quality.inconclusive,
    differentBusinessFixtures: 1,
  },
  breadth: {
    initialSamples: first.size,
    totalHistoricalAttempts: breadth.length,
    initiallyExpected: Array.from(first.values()).filter(
      (v) => v.classification === 'expected',
    ).length,
    initialDegraded: Array.from(first.values()).filter(
      (v) => v.classification === 'safe_degraded_incomplete_reproduction',
    ).length,
    currentExpected: breadthResults.filter((v) => v.latestResult === 'expected')
      .length,
    currentUnresolved: breadthResults.filter((v) => v.hasUnresolvedFailure)
      .length,
    cases: breadthResults,
  },
  normativeGate: {
    distinctHealthyFlowsRequired: 10,
    firstHealthyResultsRequired: 100,
    distinctFaultsRequired: 10,
    faultResultsRequired: 30,
    coverageSatisfied: false,
    signedOff: false,
    p0Approved: false,
    note: 'Repeating one known fixture does not satisfy distinct-flow coverage; stable fault and transient outage must not share one quality denominator.',
  },
  pricing: null,
  credentialMaterialIncluded: false,
};
const output = join(data, 'T25-g3-real-deepseek-current-summary.json');
writeFileSync(output, JSON.stringify(aggregate, null, 2) + '\n', 'utf8');
console.log(
  'T25_REPORT',
  JSON.stringify({
    repeatedSamples: repeated.length,
    breadthCategories: first.size,
    breadthCurrentExpected: aggregate.breadth.currentExpected,
    breadthUnresolved: aggregate.breadth.currentUnresolved,
    normativeG3Passed: false,
  }),
);
