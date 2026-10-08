import {
  validateProjectAndModelProfile,
  validateRegressionRunModelBindings,
  validateVersionDifferentiation,
  createStepRecorder,
  verificationExitCode,
  validateRegressionRunProvenance,
  validateCaseVerdictState,
  computePhaseTimeline,
  validatePhaseTimelineStates,
  PHASE_KEYS,
  REQUIRED_MODEL_ROLES,
} from './t10VerificationHelpers.mjs';
import { getRegressionProvenanceStatus } from '../src/utils/provenance.ts';

console.log('========================================================');
console.log(' LocalQA: T10 Verification Helpers Browserless Unit Test ');
console.log('========================================================\n');

let totalTests = 0;
let passedTests = 0;

function assert(condition, name, details = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ [PASS] ${name}${details ? ` (${details})` : ''}`);
  } else {
    console.error(`  ✗ [FAIL] ${name}${details ? ` (${details})` : ''}`);
  }
}

// -------------------------------------------------------------
// Suite 1: Project & Model Profile Validation
// -------------------------------------------------------------
console.log('--- Suite 1: validateProjectAndModelProfile ---');

// 1.1 Missing active project
const res1_1 = validateProjectAndModelProfile({ activeProject: null });
assert(
  !res1_1.valid && res1_1.code === 'ACTIVE_PROJECT_MISSING',
  'Rejects missing active project object',
);

// 1.2 Project ID mismatch
const res1_2 = validateProjectAndModelProfile({
  activeProject: { id: 'proj_actual_1', defaultModelProfileId: 'mod_1' },
  targetProjectId: 'proj_seed_expected',
});
assert(
  !res1_2.valid && res1_2.code === 'PROJECT_ID_MISMATCH',
  'Rejects active project ID mismatch against seed',
  `actual=${res1_2.actual}, expected=${res1_2.expected}`,
);

// 1.3 Missing default model profile on project
const res1_3 = validateProjectAndModelProfile({
  activeProject: { id: 'proj_1', defaultModelProfileId: null },
  targetProjectId: 'proj_1',
});
assert(
  !res1_3.valid && res1_3.code === 'PROJECT_DEFAULT_MODEL_MISSING',
  'Rejects project lacking frozen defaultModelProfileId',
);

// 1.4 Seed mismatch against project frozen default model
const res1_4 = validateProjectAndModelProfile({
  activeProject: { id: 'proj_1', defaultModelProfileId: 'model_frozen_gpt4o' },
  targetProjectId: 'proj_1',
  modelProfileIdSeed: 'model_tampered_claude',
});
assert(
  !res1_4.valid && res1_4.code === 'MODEL_PROFILE_MISMATCH',
  'Rejects model profile seed differing from project frozen default',
);

// 1.5 Valid: Seed exactly matches project frozen default
const res1_5 = validateProjectAndModelProfile({
  activeProject: { id: 'proj_1', defaultModelProfileId: 'model_frozen_gpt4o' },
  targetProjectId: 'proj_1',
  modelProfileIdSeed: 'model_frozen_gpt4o',
});
assert(
  res1_5.valid && res1_5.effectiveModelProfileId === 'model_frozen_gpt4o',
  'Accepts matching model profile seed',
);

// 1.6 Valid: Seed omitted, defaults to project frozen default model
const res1_6 = validateProjectAndModelProfile({
  activeProject: { id: 'proj_1', defaultModelProfileId: 'model_frozen_gpt4o' },
  targetProjectId: 'proj_1',
  modelProfileIdSeed: '',
});
assert(
  res1_6.valid && res1_6.effectiveModelProfileId === 'model_frozen_gpt4o',
  'Defaults cleanly to project default model when seed is omitted',
);

// -------------------------------------------------------------
// Suite 2: Regression Run Model Bindings in effectiveConfig
// -------------------------------------------------------------
console.log('\n--- Suite 2: validateRegressionRunModelBindings ---');

assert(
  REQUIRED_MODEL_ROLES.length === 5 &&
    REQUIRED_MODEL_ROLES.every((r) =>
      [
        'coordinator',
        'explorer',
        'executor',
        'assertion',
        'reproducer',
      ].includes(r),
    ),
  'Exports REQUIRED_MODEL_ROLES with all 5 canonical orchestrator roles',
);

// 2.1 Missing run or effectiveConfig.models
const res2_1 = validateRegressionRunModelBindings({
  run: { id: 'r1' },
  expectedModelProfileId: 'model_frozen_gpt4o',
});
assert(
  !res2_1.valid && res2_1.code === 'MISSING_EFFECTIVE_MODELS',
  'Rejects Run missing effectiveConfig.models',
);

// 2.2 Valid: All 5 roles bind to expectedModelProfileId
const validRun = {
  id: 'run_regression_01',
  effectiveConfig: {
    models: {
      coordinator: { profileId: 'model_frozen_gpt4o', version: 1 },
      explorer: { profileId: 'model_frozen_gpt4o', version: 1 },
      executor: { profileId: 'model_frozen_gpt4o', version: 1 },
      assertion: { profileId: 'model_frozen_gpt4o', version: 1 },
      reproducer: { profileId: 'model_frozen_gpt4o', version: 1 },
    },
  },
};
const res2_2 = validateRegressionRunModelBindings({
  run: validRun,
  expectedModelProfileId: 'model_frozen_gpt4o',
});
assert(
  res2_2.valid && res2_2.verifiedRoles.length === 5,
  'Validates that all 5 roles match expected frozen model profile',
  res2_2.verifiedRoles.join(', '),
);

// 2.3 Invalid: One role (e.g. reproducer) bound to different profile
const tamperedRun = {
  id: 'run_regression_02',
  effectiveConfig: {
    models: {
      coordinator: { profileId: 'model_frozen_gpt4o', version: 1 },
      explorer: { profileId: 'model_frozen_gpt4o', version: 1 },
      executor: { profileId: 'model_frozen_gpt4o', version: 1 },
      assertion: { profileId: 'model_frozen_gpt4o', version: 1 },
      reproducer: { profileId: 'model_rogue_unauthorized', version: 1 },
    },
  },
};
const res2_3 = validateRegressionRunModelBindings({
  run: tamperedRun,
  expectedModelProfileId: 'model_frozen_gpt4o',
});
assert(
  !res2_3.valid &&
    res2_3.code === 'ROLE_MODEL_BINDING_MISMATCH' &&
    res2_3.mismatchedRoles[0].role === 'reproducer',
  'Detects role binding profileId mismatch in effectiveConfig.models',
);

// 2.4 Valid: All 5 roles bind to expectedModelProfileId AND expectedModelProfileVersion (2)
const validVersionRun = {
  id: 'run_regression_03',
  effectiveConfig: {
    models: {
      coordinator: { profileId: 'model_frozen_gpt4o', version: 2 },
      explorer: { profileId: 'model_frozen_gpt4o', version: 2 },
      executor: { profileId: 'model_frozen_gpt4o', version: 2 },
      assertion: { profileId: 'model_frozen_gpt4o', version: 2 },
      reproducer: { profileId: 'model_frozen_gpt4o', version: 2 },
    },
  },
};
const res2_4 = validateRegressionRunModelBindings({
  run: validVersionRun,
  expectedModelProfileId: 'model_frozen_gpt4o',
  expectedModelProfileVersion: 2,
});
assert(
  res2_4.valid && res2_4.boundModelProfileVersion === 2,
  'Validates that all 5 roles match expected frozen model profile AND version (2)',
);

// 2.5 Counterexample: Same profileId but stale/old version (version 1 instead of expected probed version 2)
const staleVersionRun = {
  id: 'run_regression_04',
  effectiveConfig: {
    models: {
      coordinator: { profileId: 'model_frozen_gpt4o', version: 2 },
      explorer: { profileId: 'model_frozen_gpt4o', version: 2 },
      executor: { profileId: 'model_frozen_gpt4o', version: 2 },
      assertion: { profileId: 'model_frozen_gpt4o', version: 2 },
      reproducer: { profileId: 'model_frozen_gpt4o', version: 1 }, // Stale version 1!
    },
  },
};
const res2_5 = validateRegressionRunModelBindings({
  run: staleVersionRun,
  expectedModelProfileId: 'model_frozen_gpt4o',
  expectedModelProfileVersion: 2,
});
assert(
  !res2_5.valid &&
    res2_5.code === 'ROLE_MODEL_BINDING_MISMATCH' &&
    res2_5.mismatchedRoles.some(
      (r) => r.role === 'reproducer' && r.actualVersion === 1,
    ),
  'Rejects run where a role binds to stale/different version of the same profile (actual=1, expected=2)',
);

// 2.6 Counterexample: Same profileId but rogue/newer head version (version 99 instead of expected probed version 2)
const rogueVersionRun = {
  id: 'run_regression_05',
  effectiveConfig: {
    models: {
      coordinator: { profileId: 'model_frozen_gpt4o', version: 99 },
      explorer: { profileId: 'model_frozen_gpt4o', version: 99 },
      executor: { profileId: 'model_frozen_gpt4o', version: 99 },
      assertion: { profileId: 'model_frozen_gpt4o', version: 99 },
      reproducer: { profileId: 'model_frozen_gpt4o', version: 99 },
    },
  },
};
const res2_6 = validateRegressionRunModelBindings({
  run: rogueVersionRun,
  expectedModelProfileId: 'model_frozen_gpt4o',
  expectedModelProfileVersion: 2,
});
assert(
  !res2_6.valid &&
    res2_6.code === 'ROLE_MODEL_BINDING_MISMATCH' &&
    res2_6.mismatchedRoles.length === 5,
  'Rejects run where all roles bind to un-probed rogue version (actual=99, expected=2)',
);

// -------------------------------------------------------------
// Suite 3: Parent vs Child Version Differentiation
// -------------------------------------------------------------
console.log('\n--- Suite 3: validateVersionDifferentiation ---');

// 3.1 Failure: Parent version equals child version (not differentiated)
const res3_1 = validateVersionDifferentiation({
  parentCaseVersion: 2,
  childVersion: 2,
  reviewExpectedVersion: 2,
});
assert(
  !res3_1.valid && !res3_1.isDifferent,
  'Rejects identical parent and child versions (undifferentiated)',
);

// 3.2 Failure: Parent is 3, child is 2, but review mistakenly used parent version 3
const res3_2 = validateVersionDifferentiation({
  parentCaseVersion: 3,
  childVersion: 2,
  reviewExpectedVersion: 3, // Bug: sent parent version instead of child version
});
assert(
  !res3_2.valid && !res3_2.usesChild && !res3_2.notUsingParent,
  'Rejects review submission that mistakenly used parent version instead of child version',
);

// 3.3 Success: Parent is 3, child is 2, review strictly sends child version 2
const res3_3 = validateVersionDifferentiation({
  parentCaseVersion: 3,
  childVersion: 2,
  reviewExpectedVersion: 2,
});
assert(
  res3_3.valid &&
    res3_3.isDifferent &&
    res3_3.usesChild &&
    res3_3.notUsingParent,
  'Proves review expectedVersion strictly matches child version (2) and differs from parent (3)',
);

// 3.4 Edge Case Rejections: missing, null, empty string, zero, negative, non-integer
const res3_4a = validateVersionDifferentiation({
  parentCaseVersion: null,
  childVersion: 2,
  reviewExpectedVersion: 2,
});
assert(
  !res3_4a.valid && res3_4a.code === 'INVALID_VERSION_FORMAT',
  'Rejects null parentCaseVersion without coercing to 0 (preventing false differentiation)',
);

const res3_4b = validateVersionDifferentiation({
  parentCaseVersion: '',
  childVersion: 2,
  reviewExpectedVersion: 2,
});
assert(
  !res3_4b.valid && res3_4b.code === 'INVALID_VERSION_FORMAT',
  'Rejects empty string parentCaseVersion',
);

const res3_4c = validateVersionDifferentiation({
  parentCaseVersion: 0,
  childVersion: 2,
  reviewExpectedVersion: 2,
});
assert(
  !res3_4c.valid && res3_4c.code === 'INVALID_VERSION_FORMAT',
  'Rejects 0 parentCaseVersion (versions must be positive integers > 0)',
);

const res3_4d = validateVersionDifferentiation({
  parentCaseVersion: -1,
  childVersion: 2,
  reviewExpectedVersion: 2,
});
assert(
  !res3_4d.valid && res3_4d.code === 'INVALID_VERSION_FORMAT',
  'Rejects negative parentCaseVersion',
);

const res3_4e = validateVersionDifferentiation({
  parentCaseVersion: 2.5,
  childVersion: 2,
  reviewExpectedVersion: 2,
});
assert(
  !res3_4e.valid && res3_4e.code === 'INVALID_VERSION_FORMAT',
  'Rejects non-integer parentCaseVersion',
);

// -------------------------------------------------------------
// Suite 4: Step Recorder & Unverified Accounting
// -------------------------------------------------------------
console.log('\n--- Suite 4: createStepRecorder & Unverified Accounting ---');

const recorder = createStepRecorder();
recorder.recordStep('Step 1: Normal pass', true);
recorder.recordStep('Step 2: Explicit passed', 'passed');
recorder.recordStep('Step 3: Protocol unverified', 'unverified', {
  note: 'Pending live backend release',
});

// 4.1 Detail protection: adversarial detail payload must not overwrite authoritative status or passed
const adversarialEntry = recorder.recordStep(
  'Step 3b: Adversarial detail injection attempt',
  'unverified',
  {
    status: 'passed',
    passed: true,
  },
);
assert(
  adversarialEntry.status === 'unverified' && adversarialEntry.passed === false,
  'createStepRecorder strictly preserves authoritative status and passed over details payload',
);

const report1 = recorder.getResults({ taskSlug: 'test_accounting' });

assert(
  report1.summary.total === 4 &&
    report1.summary.passedCount === 2 &&
    report1.summary.unverifiedCount === 2 &&
    report1.summary.failedCount === 0,
  'Correctly isolates unverifiedCount from passedCount even with adversarial details',
  `passed=${report1.summary.passedCount}, unverified=${report1.summary.unverifiedCount}`,
);

assert(
  report1.allPassed === false,
  'Strictly sets allPassed=false when any unverified items exist',
);

assert(
  report1.verdict === 'COMPLETED_WITH_UNVERIFIED_ITEMS',
  'Sets verdict to COMPLETED_WITH_UNVERIFIED_ITEMS (never ALL_PASSED)',
);

// Add a failing step
recorder.recordStep('Step 4: Hard failure', false);
const report2 = recorder.getResults();
assert(
  report2.verdict === 'FAILED' && report2.allPassed === false,
  'Prioritizes FAILED verdict when failedCount > 0',
);

// Clean recorder without unverified or failed
const cleanRecorder = createStepRecorder();
cleanRecorder.recordStep('Clean 1', true);
cleanRecorder.recordStep('Clean 2', 'passed');
const cleanReport = cleanRecorder.getResults();
assert(
  cleanReport.allPassed === true && cleanReport.verdict === 'ALL_PASSED',
  'Only reports allPassed=true and ALL_PASSED when zero unverified and zero failures',
);

// -------------------------------------------------------------
// Suite 5: verificationExitCode
// -------------------------------------------------------------
console.log('\n--- Suite 5: verificationExitCode ---');

assert(
  verificationExitCode({
    summary: { total: 5, passedCount: 4, failedCount: 1, unverifiedCount: 0 },
  }) === 1,
  'verificationExitCode returns 1 on failure',
);

assert(
  verificationExitCode({
    summary: { total: 5, passedCount: 4, failedCount: 0, unverifiedCount: 1 },
  }) === 2,
  'verificationExitCode returns 2 when unverified items exist',
);

assert(
  verificationExitCode({
    summary: { total: 0, passedCount: 0, failedCount: 0, unverifiedCount: 0 },
  }) === 2,
  'verificationExitCode returns 2 on empty run (total=0)',
);

assert(
  verificationExitCode({
    summary: { total: 5, passedCount: 5, failedCount: 0, unverifiedCount: 0 },
  }) === 0,
  'verificationExitCode returns 0 strictly when all passed with zero unverified and zero failed',
);

assert(
  verificationExitCode({ total: 4, passed: 2, unverified: 2, failed: 0 }) === 2,
  'verificationExitCode supports flat summary objects',
);

// -------------------------------------------------------------
// Suite 6: validateRegressionRunProvenance (Canonical Schema Enforced)
// -------------------------------------------------------------
console.log('\n--- Suite 6: validateRegressionRunProvenance ---');

const canonicalValidDocument = {
  schemaVersion: 1,
  kind: 'localqa/test',
  id: 'doc_regression_01',
  name: 'Regression Checkout Flow',
  criteria: [
    {
      id: 'crit_1',
      kind: 'element_visible',
      description: 'Order total is calculated correctly',
      sourceKind: 'saved_case',
      sourceRef: 'sc_01',
      locator: { by: 'css', value: '#total' },
    },
  ],
  steps: [
    { kind: 'navigate', url: 'http://localhost:3000/cart' },
    { kind: 'click', locator: { by: 'css', value: 'button#checkout' } },
  ],
};

const canonicalValidModuleSnapshot = {
  projectId: 'a0000000-0000-0000-0000-000000000001',
  name: 'auth/login-module',
  version: 1,
  sha256: 'b'.repeat(64),
  document: canonicalValidDocument,
  reviewStatus: 'approved',
};

const canonicalValidBinding = {
  sourceVersionId: 'b0000000-0000-0000-0000-000000000001',
  sourceDocumentSha256: 'a'.repeat(64),
  snapshotDocumentSha256: 'a'.repeat(64),
  document: canonicalValidDocument,
  moduleSnapshots: [canonicalValidModuleSnapshot],
};

const sampleValidRun = {
  id: 'run_reg_01',
  executionMode: 'regression',
};

const sampleValidCase = {
  definition: {
    id: 'case_reg_01',
    runId: 'run_reg_01',
    regression: canonicalValidBinding,
  },
};

const sampleValidStep = {
  id: 'step_reg_01',
  caseId: 'case_reg_01',
  seq: 1,
  regressionSource: {
    documentId: 'doc_regression_01',
    stepIndex: 0,
    modulePath: [
      {
        ref: 'auth/login-module@1',
        sha256: 'b'.repeat(64),
        invocationStepIndex: 0,
      },
    ],
  },
};

// 6.1 Valid regression run, case and step
const res6_1 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [sampleValidCase],
  steps: [sampleValidStep],
});
assert(
  res6_1.valid === true && res6_1.unverifiedCount === 0,
  'Validates complete canonical regression run, case binding and step regressionSource',
);

// 6.2 Non-regression run executionMode
const smokeCase = {
  ...sampleValidCase,
  definition: {
    ...sampleValidCase.definition,
    runId: 'run_smoke_01',
  },
};
const res6_2 = validateRegressionRunProvenance({
  run: { id: 'run_smoke_01', executionMode: 'smoke' },
  cases: [smokeCase],
  steps: [],
});
assert(
  res6_2.valid === false && res6_2.unverifiedCount === 1,
  'Rejects non-regression executionMode ("smoke") as unverified',
);

// 6.3 Case missing regression binding
const res6_3 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [{ definition: { id: 'case_no_binding', runId: 'run_reg_01' } }],
  steps: [],
});
assert(
  res6_3.valid === false && res6_3.unverifiedCount === 1,
  'Rejects regression case lacking CaseDefinition.regression binding',
);

// 6.4 Case regression missing sourceVersionId
const res6_4 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [
    {
      definition: {
        id: 'case_missing_ver',
        runId: 'run_reg_01',
        regression: {
          ...canonicalValidBinding,
          sourceVersionId: '',
        },
      },
    },
  ],
  steps: [],
});
assert(
  res6_4.valid === false && res6_4.unverifiedCount === 1,
  'Rejects case regression missing sourceVersionId as unverified',
);

// 6.5 Counterexample: sourceDocumentSha256 = 'z'.repeat(16) (not 64 lowercase hex)
const res6_5 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [
    {
      definition: {
        id: 'case_bad_sha',
        runId: 'run_reg_01',
        regression: {
          ...canonicalValidBinding,
          sourceDocumentSha256: 'z'.repeat(16),
        },
      },
    },
  ],
  steps: [],
});
assert(
  res6_5.valid === false && res6_5.unverifiedCount > 0,
  'Rejects sourceDocumentSha256="z".repeat(16) via canonical 64-hex schema',
);

// 6.6 Counterexample: missing regression.document
const res6_6 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [
    {
      definition: {
        id: 'case_no_doc',
        runId: 'run_reg_01',
        regression: {
          ...canonicalValidBinding,
          document: undefined,
        },
      },
    },
  ],
  steps: [],
});
assert(
  res6_6.valid === false && res6_6.unverifiedCount > 0,
  'Rejects case regression missing document object via canonical schema',
);

// 6.7 Counterexample: snapshotDocumentSha256 = 'bad'
const res6_7 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [
    {
      definition: {
        id: 'case_bad_snapshot_sha',
        runId: 'run_reg_01',
        regression: {
          ...canonicalValidBinding,
          snapshotDocumentSha256: 'bad',
        },
      },
    },
  ],
  steps: [],
});
assert(
  res6_7.valid === false && res6_7.unverifiedCount > 0,
  'Rejects invalid snapshotDocumentSha256="bad" via canonical 64-hex schema',
);

// 6.8 Valid Legacy Case: omitted snapshotDocumentSha256 must NOT be falsely rejected
const legacyBinding = { ...canonicalValidBinding };
delete legacyBinding.snapshotDocumentSha256;
const res6_8 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [
    {
      definition: {
        id: 'case_legacy_no_snapshot_sha',
        runId: 'run_reg_01',
        regression: legacyBinding,
      },
    },
  ],
  steps: [],
});
assert(
  res6_8.valid === true && res6_8.unverifiedCount === 0,
  'Accepts canonical legacy case with omitted optional snapshotDocumentSha256',
);

// 6.9 Counterexample: moduleSnapshots = [{ name: 'module', version: -1 }]
const res6_9 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [
    {
      definition: {
        id: 'case_bad_module_version',
        runId: 'run_reg_01',
        regression: {
          ...canonicalValidBinding,
          moduleSnapshots: [{ name: 'module', version: -1 }],
        },
      },
    },
  ],
  steps: [],
});
assert(
  res6_9.valid === false && res6_9.unverifiedCount > 0,
  'Rejects moduleSnapshots with version: -1 via canonical RegressionModuleVersion schema',
);

// 6.10 Step missing regressionSource
const res6_10 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [sampleValidCase],
  steps: [{ id: 'step_no_source', caseId: 'case_reg_01', seq: 1 }],
});
assert(
  res6_10.valid === false && res6_10.unverifiedCount === 1,
  'Rejects regression case step lacking canonical Step.regressionSource',
);

// 6.11 Counterexample: Step.regressionSource missing modulePath
const res6_11 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [sampleValidCase],
  steps: [
    {
      id: 'step_no_module_path',
      caseId: 'case_reg_01',
      seq: 1,
      regressionSource: {
        documentId: 'doc_regression_01',
        stepIndex: 0,
      },
    },
  ],
});
assert(
  res6_11.valid === false && res6_11.unverifiedCount > 0,
  'Rejects Step.regressionSource missing modulePath via canonical schema',
);

// 6.12 Counterexample: Step with stepIndex = 100 (exceeds schema maximum 99)
const res6_12 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [sampleValidCase],
  steps: [
    {
      id: 'step_index_100',
      caseId: 'case_reg_01',
      seq: 1,
      regressionSource: {
        documentId: 'doc_regression_01',
        stepIndex: 100,
        modulePath: [],
      },
    },
  ],
});
assert(
  res6_12.valid === false && res6_12.unverifiedCount > 0,
  'Rejects Step.regressionSource with stepIndex=100 via canonical schema (max 99)',
);

// 6.13 Step with stepIndex = 5 when associated case document only has 2 steps (bounds check)
const res6_13 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [sampleValidCase],
  steps: [
    {
      id: 'step_index_out_of_bounds',
      caseId: 'case_reg_01',
      seq: 1,
      regressionSource: {
        documentId: 'doc_regression_01',
        stepIndex: 5,
        modulePath: [],
      },
    },
  ],
});
assert(
  res6_13.valid === false && res6_13.unverifiedCount > 0,
  'Rejects Step.regressionSource with stepIndex out of document steps bounds',
);

// 6.14 Run/Case association check (c.definition.runId !== run.id)
const res6_14 = validateRegressionRunProvenance({
  run: sampleValidRun,
  cases: [
    {
      definition: {
        id: 'case_mismatched_run',
        runId: 'run_other_foreign_id',
        regression: canonicalValidBinding,
      },
    },
  ],
  steps: [],
});
assert(
  res6_14.valid === false && res6_14.unverifiedCount > 0,
  'Rejects case whose runId does not match run.id (association violation)',
);

// -------------------------------------------------------------
// Suite 7: validateCaseVerdictState & Queued/Not_Run Protection
// -------------------------------------------------------------
console.log('\n--- Suite 7: validateCaseVerdictState & Queued/Not_Run ---');

// 7.1 Queued / not_run case with null verdict confirms isCompletedReplay === false
const res7_1 = validateCaseVerdictState({
  caseRecord: {
    outcome: 'not_run',
    verdict: null,
  },
});
assert(
  res7_1.valid === true &&
    res7_1.isCompletedReplay === false &&
    res7_1.verdictStatus === null &&
    res7_1.displayState === 'not_run',
  'Confirms queued/not_run case is strictly not treated as completed replay',
);

// 7.2 Rejects claiming passed for queued/not_run case
const res7_2 = validateCaseVerdictState({
  caseRecord: {
    outcome: 'not_run',
    verdict: null,
  },
  claimedPassed: true,
});
assert(
  res7_2.valid === false && res7_2.code === 'FORGED_PASSED_STATE',
  'Strictly rejects claiming passed for a queued/not_run case with null verdict',
);

// 7.3 Valid passed verdict derives verdictStatus === 'passed'
const res7_3 = validateCaseVerdictState({
  caseRecord: {
    outcome: 'passed',
    verdict: {
      status: 'passed',
      summary: 'All criteria passed',
    },
  },
  claimedPassed: true,
});
assert(
  res7_3.valid === true &&
    res7_3.isCompletedReplay === true &&
    res7_3.verdictStatus === 'passed',
  'Confirms passed case verdict is strictly derived from real verdict.status="passed"',
);

// 7.4 Inconclusive verdict derives verdictStatus === 'inconclusive' (never passed)
const res7_4 = validateCaseVerdictState({
  caseRecord: {
    outcome: 'inconclusive',
    verdict: {
      status: 'inconclusive',
      summary: 'Missing evidence, inconclusive',
    },
  },
});
assert(
  res7_4.valid === true &&
    res7_4.verdictStatus === 'inconclusive' &&
    res7_4.displayState === 'inconclusive',
  'Confirms inconclusive verdict is strictly derived from verdict.status="inconclusive"',
);

// 7.5 Rejects claiming passed when verdict is inconclusive
const res7_5 = validateCaseVerdictState({
  caseRecord: {
    outcome: 'inconclusive',
    verdict: {
      status: 'inconclusive',
      summary: 'Inconclusive verdict',
    },
  },
  claimedPassed: true,
});
assert(
  res7_5.valid === false && res7_5.code === 'VERDICT_MISMATCH',
  'Rejects claiming passed when real verdict status is "inconclusive"',
);

// 7.6 Rejects non-canonical verdict status
const res7_6 = validateCaseVerdictState({
  caseRecord: {
    outcome: 'passed',
    verdict: {
      status: 'bogus_status',
      summary: 'Invalid status',
    },
  },
});
assert(
  res7_6.valid === false && res7_6.code === 'INVALID_VERDICT_STATUS',
  'Rejects non-canonical verdict status',
);

// 7.7 C2-R Fix: Fail-closed on missing/undefined verdict with outcome="passed" (No TypeError)
let threwTypeError = false;
let res7_7;
try {
  res7_7 = validateCaseVerdictState({
    caseRecord: {
      outcome: 'passed',
    },
  });
} catch (_e) {
  threwTypeError = true;
}
assert(
  !threwTypeError &&
    res7_7 &&
    res7_7.valid === false &&
    res7_7.code === 'MISSING_VERDICT' &&
    res7_7.isCompletedReplay === false &&
    res7_7.verdictStatus === null,
  'Fail closed when verdict is undefined on non-not_run case (zero TypeError, never claims passed or completed replay)',
);

// 7.8 C2-R Fix: Fail-closed on null verdict with outcome="failed"
const res7_8 = validateCaseVerdictState({
  caseRecord: {
    outcome: 'failed',
    verdict: null,
  },
});
assert(
  res7_8.valid === false &&
    res7_8.code === 'MISSING_VERDICT' &&
    res7_8.isCompletedReplay === false &&
    res7_8.verdictStatus === null,
  'Fail closed when verdict is null on outcome="failed"',
);

// -------------------------------------------------------------
// Suite 8: PhaseProgress & computePhaseTimeline Verification
// -------------------------------------------------------------
console.log(
  '\n--- Suite 8: computePhaseTimeline & PhaseProgress SSR Protection ---',
);

assert(
  PHASE_KEYS.length === 7 &&
    PHASE_KEYS[0] === 'preflight' &&
    PHASE_KEYS[4] === 'execute' &&
    PHASE_KEYS[6] === 'finalize',
  'Exports PHASE_KEYS with canonical 7 lifecycle phases',
);

// 8.1 Status "cancelled" at phase "execute" (smoke mode)
// Phases 0..3 (preflight, auth, explore, plan) are completed.
// Phase 4 (execute) is cancelled.
// Subsequent phases 5..6 (reproduce, finalize) MUST NOT be completed (empty string).
const t8_1 = computePhaseTimeline({
  currentPhase: 'execute',
  status: 'cancelled',
  executionMode: 'smoke',
});
const completed8_1 = t8_1.filter((p) => p.isCompleted);
const executePhase8_1 = t8_1.find((p) => p.key === 'execute');
const reproducePhase8_1 = t8_1.find((p) => p.key === 'reproduce');
const finalizePhase8_1 = t8_1.find((p) => p.key === 'finalize');
assert(
  completed8_1.length === 4 &&
    executePhase8_1.stateClass === 'cancelled' &&
    !executePhase8_1.isCompleted &&
    reproducePhase8_1.stateClass === '' &&
    !reproducePhase8_1.isCompleted &&
    finalizePhase8_1.stateClass === '' &&
    !finalizePhase8_1.isCompleted,
  'Status cancelled at execute: exactly 4 prior phases completed, execute is cancelled, subsequent phases NEVER completed',
);

// 8.2 Status "failed" at phase "execute" in REGRESSION mode
// In regression mode: explore and plan are skipped (stateClass: skipped, isCompleted: false).
// Prior completed: preflight, auth (2 phases).
// execute is failed (isCompleted: false).
// Subsequent phases: reproduce, finalize are pending (isCompleted: false).
const t8_2 = computePhaseTimeline({
  currentPhase: 'execute',
  status: 'failed',
  executionMode: 'regression',
});
const completed8_2 = t8_2.filter((p) => p.isCompleted);
const skipped8_2 = t8_2.filter((p) => p.stateClass === 'skipped');
const executePhase8_2 = t8_2.find((p) => p.key === 'execute');
assert(
  completed8_2.length === 2 &&
    skipped8_2.length === 2 &&
    executePhase8_2.stateClass === 'failed' &&
    !executePhase8_2.isCompleted,
  'Status failed at execute (regression): explore & plan skipped, exactly 2 prior completed, execute is failed, subsequent empty',
);

// 8.3 Status "queued"
// Zero phases active, zero phases completed, all pending
const t8_3 = computePhaseTimeline({
  currentPhase: 'preflight',
  status: 'queued',
  executionMode: 'regression',
});
const activeOrCompleted8_3 = t8_3.filter(
  (p) =>
    p.isCompleted || p.stateClass === 'active' || p.stateClass === 'completed',
);
assert(
  activeOrCompleted8_3.length === 0,
  'Status queued: zero phases active or completed across timeline',
);

// 8.4 Status "completed" in REGRESSION mode
// Explore and plan are skipped (NEVER completed). Completed count = 5.
const t8_4 = computePhaseTimeline({
  currentPhase: 'finalize',
  status: 'completed',
  executionMode: 'regression',
});
const completed8_4 = t8_4.filter((p) => p.isCompleted);
const explore8_4 = t8_4.find((p) => p.key === 'explore');
const plan8_4 = t8_4.find((p) => p.key === 'plan');
assert(
  completed8_4.length === 5 &&
    explore8_4.stateClass === 'skipped' &&
    !explore8_4.isCompleted &&
    plan8_4.stateClass === 'skipped' &&
    !plan8_4.isCompleted,
  'Status completed (regression): explore & plan skipped, exactly 5 executed phases completed',
);

// 8.5 validatePhaseTimelineStates helper validation
const val8_5a = validatePhaseTimelineStates({
  currentPhase: 'execute',
  status: 'cancelled',
  executionMode: 'regression',
});
assert(
  val8_5a.valid === true &&
    val8_5a.code === 'OK' &&
    val8_5a.completedCount === 2 &&
    val8_5a.cancelledCount === 1,
  'validatePhaseTimelineStates confirms valid cancelled regression timeline',
);

const val8_5b = validatePhaseTimelineStates({
  currentPhase: 'preflight',
  status: 'queued',
  executionMode: 'regression',
});
assert(
  val8_5b.valid === true &&
    val8_5b.completedCount === 0 &&
    val8_5b.activeCount === 0,
  'validatePhaseTimelineStates confirms valid queued timeline',
);

// -------------------------------------------------------------
// Suite 9: getRegressionProvenanceStatus (Direct import from src/utils/provenance.ts)
// -------------------------------------------------------------
console.log(
  '\n--- Suite 9: getRegressionProvenanceStatus (Product UI Helper from src/utils/provenance.ts) ---',
);

// 9.1 Valid canonical regression binding -> complete
const prov9_1 = getRegressionProvenanceStatus(canonicalValidBinding);
assert(
  prov9_1.isComplete === true &&
    prov9_1.statusLabel === '来源信息完整' &&
    prov9_1.badgeVariant === 'success' &&
    prov9_1.missingFields.length === 0,
  'Actual UI helper marks canonical valid regression binding as 来源信息完整',
);

// 9.2 Valid canonical legacy binding (omitted optional snapshot SHA) -> complete
const legacyBinding9_2 = { ...canonicalValidBinding };
delete legacyBinding9_2.snapshotDocumentSha256;
const prov9_2 = getRegressionProvenanceStatus(legacyBinding9_2);
assert(
  prov9_2.isComplete === true &&
    prov9_2.statusLabel === '来源信息完整' &&
    prov9_2.badgeVariant === 'success' &&
    prov9_2.missingFields.length === 0,
  'Actual UI helper cleanly accepts legacy binding with omitted snapshotDocumentSha256',
);

// 9.3 Counterexample: Non-UUID sourceVersionId
const prov9_3 = getRegressionProvenanceStatus({
  ...canonicalValidBinding,
  sourceVersionId: 'not-a-uuid',
});
assert(
  prov9_3.isComplete === false &&
    prov9_3.statusLabel === '来源信息不完整 (未验证)' &&
    prov9_3.badgeVariant === 'warning' &&
    prov9_3.missingFields.some((f) => f.includes('UUID')),
  'Actual UI helper rejects non-UUID sourceVersionId',
);

// 9.4 Counterexample: Invalid sourceDocumentSha256 ('z'.repeat(16))
const prov9_4 = getRegressionProvenanceStatus({
  ...canonicalValidBinding,
  sourceDocumentSha256: 'z'.repeat(16),
});
assert(
  prov9_4.isComplete === false &&
    prov9_4.statusLabel === '来源信息不完整 (未验证)' &&
    prov9_4.badgeVariant === 'warning' &&
    prov9_4.missingFields.some((f) => f.includes('SHA-256')),
  'Actual UI helper rejects invalid sourceDocumentSha256 via canonical schema',
);

// 9.5 Counterexample: Invalid snapshotDocumentSha256 ('bad')
const prov9_5 = getRegressionProvenanceStatus({
  ...canonicalValidBinding,
  snapshotDocumentSha256: 'bad',
});
assert(
  prov9_5.isComplete === false &&
    prov9_5.statusLabel === '来源信息不完整 (未验证)' &&
    prov9_5.badgeVariant === 'warning' &&
    prov9_5.missingFields.some((f) => f.includes('SHA-256')),
  'Actual UI helper rejects invalid snapshotDocumentSha256 via canonical schema',
);

// 9.6 Counterexample: Module snapshot with negative version (version: -1)
const prov9_6 = getRegressionProvenanceStatus({
  ...canonicalValidBinding,
  moduleSnapshots: [{ name: 'module', version: -1 }],
});
assert(
  prov9_6.isComplete === false &&
    prov9_6.statusLabel === '来源信息不完整 (未验证)' &&
    prov9_6.badgeVariant === 'warning' &&
    prov9_6.missingFields.some(
      (f) => f.includes('moduleSnapshots') || f.includes('模块版本快照'),
    ),
  'Actual UI helper rejects module snapshot with negative version',
);

// 9.7 Counterexample: Bad document schema (missing criteria and steps)
const prov9_7 = getRegressionProvenanceStatus({
  ...canonicalValidBinding,
  document: { criteria: [], steps: [] },
});
assert(
  prov9_7.isComplete === false &&
    prov9_7.statusLabel === '来源信息不完整 (未验证)' &&
    prov9_7.badgeVariant === 'warning' &&
    prov9_7.missingFields.some(
      (f) => f.includes('RegressionDocument') || f.includes('用例契约文档'),
    ),
  'Actual UI helper rejects invalid document schema',
);

// 9.8 Counterexample: Null / undefined regression object
const prov9_8a = getRegressionProvenanceStatus(null);
const prov9_8b = getRegressionProvenanceStatus(undefined);
assert(
  prov9_8a.isComplete === false &&
    prov9_8a.statusLabel === '来源信息缺失 (未验证)' &&
    prov9_8a.badgeVariant === 'warning' &&
    prov9_8b.isComplete === false &&
    prov9_8b.statusLabel === '来源信息缺失 (未验证)',
  'Actual UI helper marks null/undefined regression as 来源信息缺失 (未验证)',
);

// 9.9 Consistency check: Provenance status labels never claim "独立验证" and clarify unverified is not a verdict
assert(
  prov9_1.statusLabel === '来源信息完整' &&
    !prov9_1.statusLabel.includes('独立验证') &&
    !prov9_1.statusLabel.includes('通过') &&
    prov9_3.statusLabel === '来源信息不完整 (未验证)' &&
    !prov9_3.statusLabel.includes('失败'),
  'Provenance labels strictly state 来源信息完整 / 未验证 without claiming independent verification or confusing with verdict',
);

console.log('\n========================================================');
console.log(`Results: ${passedTests}/${totalTests} Passed`);
console.log(
  `Overall: ${passedTests === totalTests ? 'ALL UNIT TESTS PASS ✓' : 'FAILED ✗'}`,
);
console.log('========================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
