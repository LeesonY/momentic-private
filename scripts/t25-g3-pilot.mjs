// T25 live-provider quality pilot. Each sample runs a new disposable
// PostgreSQL18 container, fresh Chromium context and real model requests.
// Only allowlisted metadata is stored. Raw provider responses, prompts,
// secrets and complete child stdout/stderr are NEVER written to the ledger.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const count = Number(process.argv[2] ?? '4');
if (!Number.isInteger(count) || count < 1 || count > 20)
  throw Error('T25_EXPECTED_POSITIVE_PAIR_COUNT_1_TO_20');

const ledgerPath = join(
  root,
  'docs/validation-results/T25-g3-deepseek-pilot-samples.ndjson',
);
const summaryPath = join(
  root,
  'docs/validation-results/T25-g3-deepseek-pilot-summary.json',
);
const runId = randomUUID();
const durationCapMs = 200000;
mkdirSync(dirname(ledgerPath), { recursive: true });
const previous = readFileSync(ledgerPath, { encoding: 'utf8', flag: 'a+' })
  .trim()
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

function testOne(scenario, index) {
  const started = Date.now();
  const argv = [
    'scripts/t18-real-interactive.mjs',
    'deepseek',
    ...(scenario === 'faulty' ? ['broken'] : []),
  ];
  return new Promise((resolve) => {
    let output = '';
    let overflow = false;
    let exited = false;
    let timedOut = false;
    const child = spawn(process.execPath, argv, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, LOCALQA_T25_SAMPLE: '1' },
    });
    const collect = (chunk) => {
      if (output.length + chunk.length > 250000) {
        overflow = true;
        return;
      }
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const watchdog = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        const killer = spawn(
          'taskkill',
          ['/PID', String(child.pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true },
        );
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    }, durationCapMs);
    child.once('error', () => {
      clearTimeout(watchdog);
      if (exited) return;
      exited = true;
      resolve(
        sanitize(
          null,
          scenario,
          index,
          Date.now() - started,
          false,
          'process_error',
        ),
      );
    });
    child.once('close', (exitCode) => {
      clearTimeout(watchdog);
      if (exited) return;
      exited = true;
      const structured =
        output.split(/\r?\n/).flatMap((line) => {
          if (!line.startsWith('{"gate":')) return [];
          try {
            const parsed = JSON.parse(line);
            return parsed.gate?.startsWith('T18 real AI') ? [parsed] : [];
          } catch {
            return [];
          }
        })[0] ?? null;
      resolve(
        sanitize(
          structured,
          scenario,
          index,
          Date.now() - started,
          exitCode === 0 && !overflow && !timedOut,
          timedOut
            ? 'process_timeout'
            : overflow
              ? 'output_limit'
              : exitCode !== 0
                ? 'assertion_or_provider_failure'
                : null,
        ),
      );
    });
  });
}

function sanitize(value, scenario, ordinal, durationMs, processOk, issue) {
  const expected = scenario === 'healthy' ? 2 : 4;
  const realModel =
    value?.reportedModelIds?.length === 1 &&
    value.reportedModelIds[0] === 'deepseek-flash';
  const providerSettled =
    value?.providerCalls === expected &&
    value?.recordedModelCalls === expected &&
    value?.settledCalls === expected &&
    value?.usageSources?.length === 1 &&
    value.usageSources[0] === 'reported';
  const browserActions =
    value?.browserActions === (scenario === 'healthy' ? 9 : 18) &&
    value?.authorizedClicks === (scenario === 'healthy' ? 2 : 4) &&
    value?.typedAction === true &&
    value?.allActionsBoundToApprovedVersion === true;
  const oracleOk =
    value?.runStatus === 'completed' &&
    value?.completion === 'complete' &&
    (scenario === 'healthy'
      ? value?.caseAttempts === 1 &&
        value?.artifacts === 1 &&
        value?.regressionReplay === 'completed' &&
        JSON.stringify(value?.caseVerdicts) === '["passed"]'
      : value?.caseAttempts === 2 &&
        value?.artifacts === 2 &&
        value?.regressionReplay === 'failed' &&
        value?.findingStatus === 'confirmed' &&
        value?.distinctContexts === 2 &&
        value?.distinctEvidence === true &&
        JSON.stringify(value?.caseVerdicts) ===
          '["issue_found","issue_found"]');
  const passed = !!(
    processOk &&
    realModel &&
    providerSettled &&
    browserActions &&
    oracleOk
  );
  const detectedBug = value?.caseVerdicts?.includes('issue_found') === true;
  const classification = passed
    ? scenario === 'healthy'
      ? 'TN'
      : 'TP'
    : !processOk || !value
      ? 'execution_failure'
      : scenario === 'healthy' && detectedBug
        ? 'potential_FP'
        : scenario === 'faulty' && !detectedBug
          ? 'potential_FN'
          : 'inconclusive';
  const usage =
    value?.usageTotals?.provenance === 'reported' &&
    Number.isSafeInteger(value.usageTotals.inputTokens) &&
    Number.isSafeInteger(value.usageTotals.outputTokens)
      ? {
          inputTokens: value.usageTotals.inputTokens,
          outputTokens: value.usageTotals.outputTokens,
          source: 'reported',
        }
      : null;
  return {
    version: 1,
    batchId: runId,
    ordinal,
    timestamp: new Date().toISOString(),
    fixture: 'T18-fixed-approved-two-step-zh-CN',
    scenario,
    provider: 'DeepSeek',
    configuredModelId: 'deepseek-flash',
    independentFreshRun: true,
    passed,
    classification,
    failCategory: issue ?? (passed ? null : 'missing_required_evidence'),
    durationMs,
    providerCalls: Number.isInteger(value?.providerCalls)
      ? value.providerCalls
      : null,
    recordedModelCalls: Number.isInteger(value?.recordedModelCalls)
      ? value.recordedModelCalls
      : null,
    modelIds: realModel ? ['deepseek-flash'] : [],
    browserActions: Number.isInteger(value?.browserActions)
      ? value.browserActions
      : null,
    authorizedClicks: Number.isInteger(value?.authorizedClicks)
      ? value.authorizedClicks
      : null,
    approvedVersionBound: value?.allActionsBoundToApprovedVersion === true,
    runStatus: ['completed', 'failed', 'cancelled'].includes(value?.runStatus)
      ? value.runStatus
      : null,
    completion: ['complete', 'partial', 'blocked'].includes(value?.completion)
      ? value.completion
      : null,
    caseVerdicts: Array.isArray(value?.caseVerdicts)
      ? value.caseVerdicts.filter((v) =>
          [
            'passed',
            'issue_found',
            'blocked',
            'inconclusive',
            'failed',
          ].includes(v),
        )
      : [],
    findingStatus: value?.findingStatus === 'confirmed' ? 'confirmed' : null,
    distinctContexts: Number.isInteger(value?.distinctContexts)
      ? value.distinctContexts
      : null,
    distinctEvidence: value?.distinctEvidence === true,
    usage,
  };
}

for (let pair = 0; pair < count; pair++) {
  for (const scenario of ['healthy', 'faulty']) {
    const sample = await testOne(
      scenario,
      previous.length + pair * 2 + (scenario === 'healthy' ? 1 : 2),
    );
    appendFileSync(ledgerPath, JSON.stringify(sample) + '\n', {
      encoding: 'utf8',
    });
    console.log(
      'T25_SAMPLE',
      JSON.stringify({
        ordinal: sample.ordinal,
        scenario,
        classification: sample.classification,
        durationMs: sample.durationMs,
        providerCalls: sample.providerCalls,
        usage: sample.usage,
      }),
    );
  }
}
const rows = readFileSync(ledgerPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((row) => JSON.parse(row));
const by = (name) => rows.filter((x) => x.scenario === name);
const counted = (category) =>
  rows.filter((x) => x.classification === category).length;
const withUsage = rows.filter((x) => x.usage?.source === 'reported');
const summary = {
  asOf: new Date().toISOString(),
  model: 'deepseek-flash',
  fixture:
    'one approved two-step healthy/faulty fixture, repeated independently',
  realCallsOnly: true,
  allResults: rows.length,
  healthy: {
    total: by('healthy').length,
    correct: counted('TN'),
    potentialFalsePositives: counted('potential_FP'),
  },
  faulty: {
    total: by('faulty').length,
    correct: counted('TP'),
    potentialFalseNegatives: counted('potential_FN'),
  },
  executionFailures: counted('execution_failure'),
  inconclusive: counted('inconclusive'),
  providerCallsRecorded: rows.reduce((a, b) => a + (b.providerCalls ?? 0), 0),
  reportedUsageSamples: withUsage.length,
  reportedTokens: {
    input: withUsage.reduce((a, b) => a + b.usage.inputTokens, 0),
    output: withUsage.reduce((a, b) => a + b.usage.outputTokens, 0),
  },
  commercialPriceCost: null,
  distinctFixtureCount: 1,
  normativeG3MinimumNotSatisfied: true,
  normativeHealthyRequirement: '10 distinct healthy flows x 10 runs = 100',
  normativeFaultRequirement: '10 distinct in-scope faults x 3 runs = 30',
  p0Approved: false,
};
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log('T25_SUMMARY', JSON.stringify(summary));
if (rows.some((x) => !x.passed)) process.exitCode = 1;
