// Heterogeneous real provider acceptance. Unlike T25's repeated T18 fixture,
// T26 exercises independent business computations and a wrong-but-visible
// result in each faulty variant. All results are retained, failures included.
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
import { T26_FIXTURES } from '../apps/worker/test/t26-business-fixtures.mjs';
import {
  browserActionsWithinApprovedBounds,
  modelRequestsWithinApprovedBounds,
} from './t32-model-request-bounds.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const provider = process.argv[6] ?? 'deepseek';
const campaign = process.argv[8] ?? 'T26';
if (
  ![
    'T26',
    'T27',
    'T28',
    'T29',
    'T30',
    'T31',
    'T32',
    'T33',
    'T34',
    'T35',
    'T36',
    'T37',
    'T38',
  ].includes(campaign)
)
  throw new Error('T26_INVALID_LEDGER_CAMPAIGN');
const configuredModel =
  provider === 'moan2' ? process.argv[7] : 'deepseek-flash';
if (
  !['deepseek', 'moan2'].includes(provider) ||
  (provider === 'moan2' && (!configuredModel || configuredModel.length > 64))
)
  throw new Error('T26_EXPLICIT_APPROVED_REAL_PROVIDER_AND_MODEL_REQUIRED');
const reportedModel = provider === 'moan2' ? configuredModel : 'deepseek-flash';
const ledger = join(
  root,
  `docs/validation-results/${campaign}-g3-${provider}-business.ndjson`,
);
const summaryFile = join(
  root,
  `docs/validation-results/${campaign}-g3-${provider}-summary.json`,
);
const from = Number(process.argv[2] ?? 0);
const to = Number(process.argv[3] ?? T26_FIXTURES.length);
const repetitions = Number(process.argv[4] ?? 1);
const selectedMode = process.argv[5] ?? 'both';
if (
  !Number.isInteger(from) ||
  !Number.isInteger(to) ||
  from < 0 ||
  to > T26_FIXTURES.length ||
  from >= to ||
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 10 ||
  !['healthy', 'faulty', 'both'].includes(selectedMode)
)
  throw new Error('T26_INVALID_BOUNDED_MATRIX');
const batch = randomUUID();
mkdirSync(dirname(ledger), { recursive: true });
function existing() {
  try {
    return readFileSync(ledger, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function sample(flow, mode, iteration) {
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [
      'scripts/t26-real-flow.mjs',
      flow.id,
      mode,
      provider,
      ...(provider === 'moan2' ? [configuredModel, campaign] : []),
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let output = '';
  let overflow = false;
  let timedOut = false;
  let spawnError = false;
  const collect = (chunk) => {
    if (output.length + chunk.length > 180000) overflow = true;
    else output += chunk.toString('utf8');
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const kill = () => {
    timedOut = true;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => child.kill());
    } else child.kill('SIGKILL');
  };
  const watchdog = setTimeout(kill, 155000);
  const result = await new Promise((resolve) => {
    child.once('error', () => {
      spawnError = true;
      resolve(false);
    });
    child.once('close', (code) => resolve(code === 0));
  });
  clearTimeout(watchdog);
  const parsed =
    output
      .split(/\r?\n/)
      .flatMap((line) => {
        if (!line.startsWith('{"fixtureId":')) return [];
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .find((row) => row.fixtureId === flow.id) ?? null;
  const preflight =
    output.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith('T26_PROVIDER_PREFLIGHT ')) return [];
      try {
        return [JSON.parse(line.slice('T26_PROVIDER_PREFLIGHT '.length))];
      } catch {
        return [];
      }
    })[0] ?? null;
  const modelProgress =
    output.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith('T26_ALTERNATE_MODEL_PROGRESS ')) return [];
      try {
        return [JSON.parse(line.slice('T26_ALTERNATE_MODEL_PROGRESS '.length))];
      } catch {
        return [];
      }
    })[0] ?? null;
  const outputShapes = output.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('T31_OUTPUT_SHAPE ')) return [];
    try {
      const parsed = JSON.parse(line.slice('T31_OUTPUT_SHAPE '.length));
      if (
        Array.isArray(parsed.shapeTrace) &&
        parsed.shapeTrace.every((shape) =>
          [
            'empty',
            'json_object_start',
            'json_object_unclosed',
            'json_object_balanced_invalid',
            'json_array_start',
            'code_fence_start',
            'markup_start',
            'other_text',
          ].includes(shape),
        )
      )
        return [
          {
            requestResult: parsed.requestResult,
            validationFailureKind: parsed.validationFailureKind ?? null,
            shapeTrace: parsed.shapeTrace,
            repairCount: parsed.repairCount,
            outputTokens: Number.isSafeInteger(parsed.outputTokens)
              ? parsed.outputTokens
              : null,
            providerCalls: Number.isSafeInteger(parsed.providerCalls)
              ? parsed.providerCalls
              : null,
          },
        ];
    } catch {
      // Not a JSON diagnostic line: skip it.
    }
    return [];
  });
  const diagnosticReason =
    modelProgress?.jobs
      ?.map((job) => job.replay_reason)
      .find(
        (code) =>
          typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code),
      ) ?? null;
  const live =
    parsed?.provider === (provider === 'moan2' ? 'pi-moan2' : 'pi-deepseek') &&
    parsed?.configuredModelId === configuredModel &&
    parsed?.reportedModelIds?.length === 1 &&
    parsed.reportedModelIds[0] === reportedModel &&
    parsed?.usageSources?.length === 1 &&
    parsed.usageSources[0] === 'reported';
  const fault = mode === 'faulty';
  const count = fault ? 4 : 2;
  // Model has at most 4 frozen decision rounds per approval and the gateway
  // may make one *additional* paid format repair in each round. Previous
  // count*2 incorrectly rejected a healthy five-request completed case.
  const modelCallsValid = modelRequestsWithinApprovedBounds(parsed, fault);
  const browserActionsValid = [
    'T32',
    'T33',
    'T34',
    'T35',
    'T36',
    'T37',
    'T38',
  ].includes(campaign)
    ? browserActionsWithinApprovedBounds(parsed, fault)
    : parsed?.browserActions === (fault ? 18 : 9);
  const correct =
    result &&
    !timedOut &&
    !overflow &&
    !spawnError &&
    parsed?.oracleKind === 'text_equals' &&
    parsed?.expectedResult === flow.expected &&
    live &&
    modelCallsValid &&
    browserActionsValid &&
    parsed?.authorizedClicks === (fault ? 4 : 2) &&
    parsed?.typedAction === true &&
    parsed?.allActionsBoundToApprovedVersion === true &&
    parsed?.runStatus === 'completed' &&
    parsed?.completion === 'complete' &&
    (fault
      ? parsed?.findingStatus === 'confirmed' &&
        parsed?.distinctContexts === 2 &&
        parsed?.distinctEvidence === true &&
        parsed?.caseAttempts === 2 &&
        JSON.stringify(parsed?.caseVerdicts) === '["issue_found","issue_found"]'
      : parsed?.caseAttempts === 1 &&
        JSON.stringify(parsed?.caseVerdicts) === '["passed"]');
  const observedBug = parsed?.caseVerdicts?.includes('issue_found') === true;
  const classification = correct
    ? fault
      ? 'TP'
      : 'TN'
    : !result || timedOut || overflow || spawnError || !parsed
      ? 'execution_failure'
      : !fault && observedBug
        ? 'potential_FP'
        : fault && !observedBug
          ? 'potential_FN'
          : 'inconclusive';
  const tokens =
    parsed?.usageTotals?.provenance === 'reported' &&
    Number.isSafeInteger(parsed.usageTotals.inputTokens) &&
    Number.isSafeInteger(parsed.usageTotals.outputTokens)
      ? {
          input: parsed.usageTotals.inputTokens,
          output: parsed.usageTotals.outputTokens,
          source: 'reported',
        }
      : null;
  return {
    schema: 1,
    campaign,
    batch,
    at: new Date().toISOString(),
    id: randomUUID(),
    flowId: flow.id,
    businessRule: flow.title,
    ...(['T32', 'T33', 'T34', 'T35', 'T36', 'T37', 'T38'].includes(campaign)
      ? {
          pageStructure:
            ['T36', 'T37', 'T38'].includes(campaign) &&
            flow.id === 'support-priority'
              ? 'reloaded_same_origin_iframe_confirmation'
              : ['T36', 'T37', 'T38'].includes(campaign) &&
                  flow.id === 'room-upgrade'
                ? 'remounted_nested_open_shadow_confirmation'
                : ['T34', 'T35'].includes(campaign) &&
                    flow.id === 'support-priority'
                  ? 'same_origin_iframe_async_confirmation'
                  : ['T34', 'T35'].includes(campaign) &&
                      flow.id === 'room-upgrade'
                    ? 'nested_open_shadow_async_confirmation'
                    : campaign === 'T33' && flow.id === 'support-priority'
                      ? 'details_and_modal_dialog'
                      : (flow.layoutFamily ?? 'simple_form'),
        }
      : {}),
    variant: mode,
    iteration,
    classification,
    passed: correct,
    durationMs: Date.now() - started,
    provider,
    diagnosticReason,
    ...(['T31', 'T33', 'T34', 'T35', 'T36', 'T37', 'T38'].includes(campaign)
      ? { safeOutputShapes: outputShapes }
      : {}),
    configuredModel,
    reportedModel: parsed?.reportedModelIds?.[0] ?? null,
    model: live ? reportedModel : null,
    oracle: 'user_spec:text_equals',
    fixtureStillHasResultElement: true,
    failureTag: timedOut
      ? 'timeout'
      : overflow
        ? 'excess_stdout'
        : spawnError
          ? 'spawn_error'
          : preflight?.httpStatuses?.includes(503)
            ? 'upstream_http_503'
            : preflight?.requestResult === 'not_configured'
              ? 'upstream_or_account_not_configured'
              : diagnosticReason === 'MODEL_FAILURE'
                ? 'model_request_failed_unclassified'
                : diagnosticReason === 'MODEL_VALIDATION_FAILED'
                  ? 'model_response_validation_failed'
                  : diagnosticReason === 'MODEL_OUTPUT_TRUNCATED'
                    ? 'model_output_exceeded_token_limit'
                    : diagnosticReason === 'MODEL_INVALID_JSON'
                      ? 'model_invalid_json_after_repair'
                      : diagnosticReason === 'MODEL_SCHEMA_MISMATCH'
                        ? 'model_schema_mismatch_after_repair'
                        : diagnosticReason === 'MODEL_TOOL_CONTRACT_INVALID'
                          ? 'model_tool_contract_invalid'
                          : diagnosticReason === 'SERVICE_UNAVAILABLE'
                            ? 'upstream_service_unavailable'
                            : diagnosticReason === 'MODEL_TIMEOUT'
                              ? 'upstream_model_timeout'
                              : diagnosticReason === 'RATE_LIMITED'
                                ? 'upstream_rate_limited'
                                : diagnosticReason === 'MODEL_BILLING_REQUIRED'
                                  ? 'upstream_billing_required'
                                  : diagnosticReason === 'BUDGET_EXCEEDED'
                                    ? 'approved_model_budget_exhausted'
                                    : diagnosticReason ===
                                        'MODEL_NOT_CONFIGURED'
                                      ? 'provider_model_not_configured'
                                      : diagnosticReason ===
                                          'MODEL_CAPABILITY_MISSING'
                                        ? 'provider_capability_missing'
                                        : diagnosticReason === 'AI_NO_PROGRESS'
                                          ? 'ai_no_progress_after_bounded_decisions'
                                          : diagnosticReason ===
                                              'AI_TARGET_INVALID'
                                            ? 'model_cited_invalid_snapshot_or_node'
                                            : diagnosticReason ===
                                                'AI_ACTION_INCOMPLETE'
                                              ? 'minimum_approved_actions_incomplete'
                                              : modelProgress?.attemptedClicks ===
                                                    1 &&
                                                  modelProgress?.verdicts?.includes(
                                                    'blocked',
                                                  )
                                                ? 'model_ended_before_second_approved_click'
                                                : correct
                                                  ? null
                                                  : 'required_evidence_missing',
    providerCalls: Number.isInteger(parsed?.providerCalls)
      ? parsed.providerCalls
      : null,
    // A failed end-to-end sample may still have incurred chargeable model
    // requests. Never treat absence of a final success gate as zero usage.
    // These are safe counts from the diagnostic for this disposable run,
    // not a provider bill or an inference from process exit status.
    providerRequestsObserved: Number.isInteger(parsed?.providerCalls)
      ? parsed.providerCalls
      : Number.isInteger(modelProgress?.providerCalls)
        ? modelProgress.providerCalls
        : null,
    settledModelRequestsObserved: Number.isInteger(parsed?.settledCalls)
      ? parsed.settledCalls
      : Array.isArray(modelProgress?.modelCallStates)
        ? modelProgress.modelCallStates.filter(
            (state) => state.status === 'settled',
          ).length
        : null,
    approvedMinimumModelActionCount: 2,
    // Extra provider requests include *both* reobservations and paid format
    // repairs; do not mislabel these as extra model decisions.
    additionalModelDecisions: [
      'T32',
      'T33',
      'T34',
      'T35',
      'T36',
      'T37',
      'T38',
    ].includes(campaign)
      ? null
      : Number.isInteger(parsed?.providerCalls) && parsed.providerCalls >= count
        ? parsed.providerCalls - count
        : null,
    ...(['T32', 'T33', 'T34', 'T35', 'T36', 'T37', 'T38'].includes(campaign)
      ? {
          extraProviderRequestsAboveMinimum:
            Number.isSafeInteger(parsed?.providerCalls) &&
            parsed.providerCalls >= count
              ? parsed.providerCalls - count
              : null,
        }
      : {}),
    settledModelCalls: Number.isInteger(parsed?.settledCalls)
      ? parsed.settledCalls
      : null,
    browserActions: Number.isInteger(parsed?.browserActions)
      ? parsed.browserActions
      : null,
    ...(['T32', 'T33', 'T34', 'T35', 'T36', 'T37', 'T38'].includes(campaign)
      ? { actionCounts: parsed?.actionCounts ?? null }
      : {}),
    approvedActions: parsed?.allActionsBoundToApprovedVersion === true,
    verdicts: Array.isArray(parsed?.caseVerdicts)
      ? parsed.caseVerdicts.filter((x) =>
          ['passed', 'issue_found', 'blocked', 'inconclusive'].includes(x),
        )
      : [],
    findingStatus: parsed?.findingStatus === 'confirmed' ? 'confirmed' : null,
    distinctContexts: Number.isInteger(parsed?.distinctContexts)
      ? parsed.distinctContexts
      : null,
    distinctEvidence: parsed?.distinctEvidence === true,
    tokens,
  };
}

let failed = 0;
for (let iteration = 1; iteration <= repetitions; iteration++) {
  for (const flow of T26_FIXTURES.slice(from, to)) {
    for (const variant of selectedMode === 'both'
      ? ['healthy', 'faulty']
      : [selectedMode]) {
      const record = await sample(flow, variant, iteration);
      appendFileSync(ledger, JSON.stringify(record) + '\n', 'utf8');
      if (!record.passed) failed++;
      console.log(
        'T26_SAMPLE',
        JSON.stringify({
          flow: record.flowId,
          variant: record.variant,
          classification: record.classification,
          calls: record.providerCalls,
          ms: record.durationMs,
        }),
      );
    }
  }
}
const rows = existing();
const group = (variant) => rows.filter((row) => row.variant === variant);
const current = {
  asOf: new Date().toISOString(),
  provider,
  configuredModel,
  reportedModel,
  model: reportedModel,
  executionKind: 'real G3, isolated PG18 and Chromium per sample',
  distinctNewFlows: new Set(rows.map((r) => r.flowId)).size,
  uniqueHealthyScenarios: new Set(group('healthy').map((r) => r.flowId)).size,
  uniqueFaultScenarios: new Set(group('faulty').map((r) => r.flowId)).size,
  healthy: {
    total: group('healthy').length,
    correct: group('healthy').filter((x) => x.classification === 'TN').length,
  },
  faulty: {
    total: group('faulty').length,
    correct: group('faulty').filter((x) => x.classification === 'TP').length,
  },
  possibleFalsePositives: rows.filter(
    (x) => x.classification === 'potential_FP',
  ).length,
  possibleFalseNegatives: rows.filter(
    (x) => x.classification === 'potential_FN',
  ).length,
  executionFailures: rows.filter(
    (x) => x.classification === 'execution_failure',
  ).length,
  inconclusive: rows.filter((x) => x.classification === 'inconclusive').length,
  providerCalls: rows.reduce((a, r) => a + (r.providerCalls ?? 0), 0),
  ...(campaign === 'T32'
    ? {
        // Failed runs can consume provider requests even if the success
        // fixture summary was never emitted. This is a lower bound, not a
        // charge amount. Expose missing observations rather than zero-fill.
        observedProviderRequestsLowerBound: rows.reduce(
          (sum, row) => sum + (row.providerRequestsObserved ?? 0),
          0,
        ),
        rowsWithRequestObservation: rows.filter((r) =>
          Number.isSafeInteger(r.providerRequestsObserved),
        ).length,
        observedSettledRequestsLowerBound: rows.reduce(
          (sum, row) => sum + (row.settledModelRequestsObserved ?? 0),
          0,
        ),
      }
    : {}),
  providerReportedTokens: {
    input: rows
      .filter((x) => x.tokens?.source === 'reported')
      .reduce((a, r) => a + r.tokens.input, 0),
    output: rows
      .filter((x) => x.tokens?.source === 'reported')
      .reduce((a, r) => a + r.tokens.output, 0),
    samplesWithReportedUsage: rows.filter(
      (x) => x.tokens?.source === 'reported',
    ).length,
  },
  commercialCost: null,
  g3FullGatePassed: false,
  p0Approved: false,
  note: 'Repeated samples are not distinct business flows; T17/T18 existing workflows counted separately only in the final independent scope review.',
};
writeFileSync(summaryFile, JSON.stringify(current, null, 2) + '\n', 'utf8');
console.log('T26_SUMMARY', JSON.stringify(current));
if (failed) process.exitCode = 1;
