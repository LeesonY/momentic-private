/**
 * Pure verification helpers for LocalQA T10 Case Library & Regression verification.
 * Independent of DOM/browser, fully unit-testable in Node.js.
 */

import { validateContract } from '../../../packages/contracts/dist/index.js';

export const REQUIRED_MODEL_ROLES = [
  'coordinator',
  'explorer',
  'executor',
  'assertion',
  'reproducer',
];

/**
 * 1. Validate active project and frozen default model profile.
 * - Confirms active project exists and matches target controlled projectIdSeed
 * - Confirms project has a demonstrable frozen defaultModelProfileId
 * - If modelProfileIdSeed is supplied, asserts exact match (forbids silent mutation)
 */
export function validateProjectAndModelProfile({
  activeProject,
  targetProjectId = '',
  modelProfileIdSeed = '',
}) {
  if (!activeProject || typeof activeProject !== 'object') {
    return {
      valid: false,
      code: 'ACTIVE_PROJECT_MISSING',
      message:
        'Active project object is not loaded or missing from application context',
    };
  }

  if (targetProjectId && activeProject.id !== targetProjectId) {
    return {
      valid: false,
      code: 'PROJECT_ID_MISMATCH',
      message: `Active project ID "${activeProject.id}" does not match target controlled projectId "${targetProjectId}"`,
      expected: targetProjectId,
      actual: activeProject.id,
    };
  }

  const frozenDefaultModel = activeProject.defaultModelProfileId;
  if (
    !frozenDefaultModel ||
    typeof frozenDefaultModel !== 'string' ||
    !frozenDefaultModel.trim()
  ) {
    return {
      valid: false,
      code: 'PROJECT_DEFAULT_MODEL_MISSING',
      message: `Active project "${activeProject.id}" has no frozen defaultModelProfileId configured`,
      projectId: activeProject.id,
    };
  }

  if (modelProfileIdSeed && modelProfileIdSeed.trim()) {
    if (modelProfileIdSeed.trim() !== frozenDefaultModel.trim()) {
      return {
        valid: false,
        code: 'MODEL_PROFILE_MISMATCH',
        message: `Specified model profile seed "${modelProfileIdSeed}" does not match project's frozen defaultModelProfileId "${frozenDefaultModel}". Mutating pre-existing project configuration is forbidden.`,
        expected: frozenDefaultModel,
        actual: modelProfileIdSeed,
      };
    }
  }

  return {
    valid: true,
    code: 'OK',
    projectId: activeProject.id,
    effectiveModelProfileId: frozenDefaultModel.trim(),
    modelProfileIdSeed:
      modelProfileIdSeed || '(omitted, using project default)',
  };
}

/**
 * 2. Validate regression run HTTP response effectiveConfig.models role bindings.
 * Verifies that the created Run's effectiveConfig.models actually binds each role
 * to the declared frozen model profile ID.
 */
export function validateRegressionRunModelBindings({
  run,
  expectedModelProfileId,
  expectedModelProfileVersion,
}) {
  if (!run || typeof run !== 'object') {
    return {
      valid: false,
      code: 'MISSING_RUN_OBJECT',
      message: 'Run response payload is missing or not an object',
    };
  }

  const effectiveModels = run.effectiveConfig?.models;
  if (!effectiveModels || typeof effectiveModels !== 'object') {
    return {
      valid: false,
      code: 'MISSING_EFFECTIVE_MODELS',
      message: 'Run object is missing effectiveConfig.models configuration',
    };
  }

  if (!expectedModelProfileId || typeof expectedModelProfileId !== 'string') {
    return {
      valid: false,
      code: 'MISSING_EXPECTED_PROFILE',
      message: 'expectedModelProfileId must be a non-empty string',
    };
  }

  const mismatchedRoles = [];
  for (const role of REQUIRED_MODEL_ROLES) {
    const roleBinding = effectiveModels[role];
    const profileMatch =
      roleBinding && roleBinding.profileId === expectedModelProfileId;
    const versionMatch =
      expectedModelProfileVersion === undefined ||
      (roleBinding && roleBinding.version === expectedModelProfileVersion);

    if (!profileMatch || !versionMatch) {
      mismatchedRoles.push({
        role,
        expectedProfileId: expectedModelProfileId,
        actualProfileId: roleBinding?.profileId || null,
        expectedVersion: expectedModelProfileVersion ?? null,
        actualVersion: roleBinding?.version ?? null,
      });
    }
  }

  if (mismatchedRoles.length > 0) {
    return {
      valid: false,
      code: 'ROLE_MODEL_BINDING_MISMATCH',
      message: `One or more role model bindings do not match expected frozen profile "${expectedModelProfileId}" (version: ${expectedModelProfileVersion ?? 'any'})`,
      expectedModelProfileId,
      expectedModelProfileVersion: expectedModelProfileVersion ?? null,
      mismatchedRoles,
    };
  }

  return {
    valid: true,
    code: 'OK',
    boundModelProfileId: expectedModelProfileId,
    boundModelProfileVersion: expectedModelProfileVersion ?? null,
    verifiedRoles: [...REQUIRED_MODEL_ROLES],
  };
}

function isPositiveInteger(val) {
  if (val === null || val === undefined || val === '') return false;
  const num = Number(val);
  return Number.isInteger(num) && num > 0;
}

/**
 * 3. Validate parent SavedCase.version vs child SavedCaseVersion.version differentiation.
 * Proves that:
 * - Parent SavedCase.version, child version, and reviewExpectedVersion are ALL positive integers (> 0).
 * - Parent SavedCase.version and child version are strictly DIFFERENT numbers.
 * - The review request/commit expectedVersion strictly equals child version.
 * - The review request/commit expectedVersion strictly DOES NOT equal parent version.
 */
export function validateVersionDifferentiation({
  parentCaseVersion,
  childVersion,
  reviewExpectedVersion,
}) {
  if (
    !isPositiveInteger(parentCaseVersion) ||
    !isPositiveInteger(childVersion) ||
    !isPositiveInteger(reviewExpectedVersion)
  ) {
    return {
      valid: false,
      code: 'INVALID_VERSION_FORMAT',
      message:
        'parentCaseVersion, childVersion, and reviewExpectedVersion must all be positive integers (> 0)',
      parentCaseVersion,
      childVersion,
      reviewExpectedVersion,
    };
  }

  const pVer = Number(parentCaseVersion);
  const cVer = Number(childVersion);
  const rVer = Number(reviewExpectedVersion);

  const isDifferent = pVer !== cVer;
  const usesChild = rVer === cVer;
  const notUsingParent = rVer !== pVer;
  const valid = isDifferent && usesChild && notUsingParent;

  return {
    valid,
    code: valid ? 'OK' : 'VERSION_DIFFERENTIATION_FAILED',
    parentCaseVersion: pVer,
    childVersion: cVer,
    reviewExpectedVersion: rVer,
    isDifferent,
    usesChild,
    notUsingParent,
    message: valid
      ? `Verified: review expectedVersion (${rVer}) matches child version (${cVer}) and strictly differs from parent SavedCase.version (${pVer})`
      : `Differentiation check failed: parent=${pVer}, child=${cVer}, reviewExpected=${rVer}`,
  };
}

/**
 * 4. Step Recorder with explicit passed / failed / unverified accounting.
 * Ensures unverified items are NEVER counted into passedCount and ALWAYS prevent allPassed=true.
 * Authority over 'status' and 'passed' is strictly preserved; details payload cannot overwrite them.
 */
export function createStepRecorder() {
  const tests = [];
  const summary = {
    total: 0,
    passedCount: 0,
    failedCount: 0,
    unverifiedCount: 0,
  };

  function recordStep(name, statusOrPassed, details = {}) {
    let status;
    if (typeof statusOrPassed === 'boolean') {
      status = statusOrPassed ? 'passed' : 'failed';
    } else if (
      statusOrPassed === 'passed' ||
      statusOrPassed === 'failed' ||
      statusOrPassed === 'unverified'
    ) {
      status = statusOrPassed;
    } else {
      status = 'failed';
    }

    summary.total++;
    if (status === 'passed') {
      summary.passedCount++;
    } else if (status === 'unverified') {
      summary.unverifiedCount++;
    } else {
      summary.failedCount++;
    }

    // Filter out status and passed from details to guarantee authoritative bookkeeping
    const {
      status: _ignoredStatus,
      passed: _ignoredPassed,
      ...safeDetails
    } = details || {};
    const entry = {
      ...safeDetails,
      name,
      status,
      passed: status === 'passed',
    };
    tests.push(entry);

    const symbol =
      status === 'passed' ? '✓' : status === 'unverified' ? '⚠' : '✗';
    console.log(`  ${symbol} [${status.toUpperCase()}] ${name}`);
    return entry;
  }

  function getResults(metadata = {}) {
    const allPassed =
      summary.failedCount === 0 &&
      summary.unverifiedCount === 0 &&
      summary.total > 0;
    let verdict;
    if (summary.failedCount > 0) {
      verdict = 'FAILED';
    } else if (summary.unverifiedCount > 0) {
      verdict = 'COMPLETED_WITH_UNVERIFIED_ITEMS';
    } else if (summary.total === 0) {
      verdict = 'EMPTY_RUN';
    } else {
      verdict = 'ALL_PASSED';
    }

    return {
      ...metadata,
      timestamp: new Date().toISOString(),
      summary: { ...summary },
      verdict,
      allPassed,
      tests,
    };
  }

  return {
    recordStep,
    getResults,
    summary,
    tests,
  };
}

/**
 * 5. Calculate process exit code based on verification summary.
 * Returns:
 * - 1: if failedCount > 0 (Hard failure)
 * - 2: if unverifiedCount > 0 or total === 0 (Incomplete run / pending verification / empty run)
 * - 0: if failedCount === 0 and unverifiedCount === 0 and total > 0 (All passed strictly verified)
 */
export function verificationExitCode(summaryOrResults) {
  const summary = summaryOrResults?.summary || summaryOrResults || {};
  const total = Number(summary.total ?? summary.totalCount ?? 0);
  const failed = Number(summary.failedCount ?? summary.failed ?? 0);
  const unverified = Number(summary.unverifiedCount ?? summary.unverified ?? 0);

  if (failed > 0) {
    return 1;
  }
  if (unverified > 0 || total === 0) {
    return 2;
  }
  return 0;
}

/**
 * 6. Validate canonical regression run, case definition bindings, and step regressionSource.
 * Proves that:
 * - Run executionMode is strictly "regression".
 * - Case definitions are associated with the run (c.definition.runId === run.id).
 * - CaseDefinition.regression strictly satisfies canonical RegressionBinding schema:
 *   - sourceVersionId must match UUID format.
 *   - sourceDocumentSha256 must match 64-char lowercase hex pattern.
 *   - document must be valid canonical RegressionDocument.
 *   - moduleSnapshots must be valid array of RegressionModuleVersion.
 *   - snapshotDocumentSha256 is optional for legacy historical cases, but if present must match 64-char lowercase hex pattern.
 * - Step.regressionSource strictly satisfies canonical RegressionStepSource schema:
 *   - documentId must be non-empty string and match associated case document id.
 *   - modulePath must be valid array.
 *   - stepIndex must be non-negative integer (<= 99) and within bounds of the associated case document steps.
 */
export function validateRegressionRunProvenance({
  run,
  cases = [],
  steps = [],
}) {
  const issues = [];
  let unverifiedCount = 0;

  if (!run || typeof run !== 'object') {
    return {
      valid: false,
      code: 'MISSING_RUN_OBJECT',
      unverifiedCount: 1,
      issues: ['Run object is missing or invalid'],
    };
  }

  if (run.executionMode !== 'regression') {
    issues.push(
      `Run executionMode is "${run.executionMode}", expected "regression"`,
    );
    unverifiedCount++;
  }

  const caseMap = new Map();
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const caseId = c?.definition?.id || c?.id || `case_${i}`;
    caseMap.set(caseId, c);

    // 1. Run/Case association check
    const caseRunId = c?.definition?.runId || c?.runId;
    if (run.id && caseRunId && caseRunId !== run.id) {
      issues.push(
        `Case "${caseId}" runId mismatch (case.runId="${caseRunId}" !== run.id="${run.id}")`,
      );
      unverifiedCount++;
    }

    // 2. Canonical CaseDefinition.regression binding validation
    const reg = c?.definition?.regression;
    if (!reg || typeof reg !== 'object') {
      issues.push(
        `Case "${caseId}" missing canonical CaseDefinition.regression binding`,
      );
      unverifiedCount++;
      continue;
    }

    // Validate using canonical RegressionBinding schema from @localqa/contracts
    const bindingValidation = validateContract('RegressionBinding', reg);
    if (!bindingValidation.success) {
      for (const err of bindingValidation.errors || []) {
        issues.push(
          `Case "${caseId}" RegressionBinding schema violation at ${err.instancePath || '/'}: ${err.message}`,
        );
      }
      unverifiedCount++;
    }
  }

  for (const st of steps) {
    const stepSeq = st?.seq ?? 'unknown';
    const caseId = st?.caseId;
    const isRegressionCaseStep = caseId ? caseMap.has(caseId) : true;

    if (isRegressionCaseStep) {
      const regSource = st?.regressionSource;
      if (!regSource || typeof regSource !== 'object') {
        issues.push(`Step #${stepSeq} missing canonical Step.regressionSource`);
        unverifiedCount++;
        continue;
      }

      // Validate using canonical RegressionStepSource schema from @localqa/contracts
      const stepValidation = validateContract(
        'RegressionStepSource',
        regSource,
      );
      if (!stepValidation.success) {
        for (const err of stepValidation.errors || []) {
          issues.push(
            `Step #${stepSeq} RegressionStepSource schema violation at ${err.instancePath || '/'}: ${err.message}`,
          );
        }
        unverifiedCount++;
        continue;
      }

      // Check documentId and stepIndex bounds against associated case document if present
      if (caseId && caseMap.has(caseId)) {
        const associatedCase = caseMap.get(caseId);
        const caseDoc = associatedCase?.definition?.regression?.document;
        if (caseDoc) {
          if (caseDoc.id && regSource.documentId !== caseDoc.id) {
            issues.push(
              `Step #${stepSeq} regressionSource.documentId ("${regSource.documentId}") does not match case document id ("${caseDoc.id}")`,
            );
            unverifiedCount++;
          }
          if (
            Array.isArray(caseDoc.steps) &&
            regSource.stepIndex >= caseDoc.steps.length
          ) {
            issues.push(
              `Step #${stepSeq} regressionSource.stepIndex (${regSource.stepIndex}) is out of bounds for document with ${caseDoc.steps.length} steps`,
            );
            unverifiedCount++;
          }
        }
      }
    }
  }

  return {
    valid: unverifiedCount === 0 && issues.length === 0,
    code: unverifiedCount === 0 ? 'OK' : 'REGRESSION_PROVENANCE_UNVERIFIED',
    unverifiedCount,
    issues,
    summary: {
      totalCases: cases.length,
      totalSteps: steps.length,
      executionMode: run.executionMode,
    },
  };
}

/**
 * 7. Validate case verdict derivation and queued/not_run state.
 * Enforces:
 * - queued/not_run must NOT be displayed as completed replay (isCompletedReplay === false).
 * - When verdict is null (e.g. queued/not_run), verdictStatus is null, never passed or inconclusive.
 * - Fail closed: if verdict is undefined/null/not an object for non-not_run outcomes (e.g. { outcome: 'passed' }),
 *   strictly fails without throwing TypeError and NEVER claims completed or passed.
 * - Through/inconclusive must be strictly judged from real verdict.status.
 */
export function validateCaseVerdictState({
  caseRecord,
  claimedPassed = false,
}) {
  if (!caseRecord || typeof caseRecord !== 'object') {
    return {
      valid: false,
      code: 'MISSING_CASE_RECORD',
      isCompletedReplay: false,
      verdictStatus: null,
      message: 'Case record object is missing',
    };
  }

  const outcome = caseRecord.outcome;
  const verdict = caseRecord.verdict;

  // Case 1: queued or not_run case
  if (outcome === 'not_run') {
    if (claimedPassed) {
      return {
        valid: false,
        code: 'FORGED_PASSED_STATE',
        isCompletedReplay: false,
        verdictStatus: null,
        message: 'Cannot claim passed for a case with not_run outcome',
        outcome,
        hasVerdict: !!verdict,
      };
    }

    return {
      valid: true,
      code: 'OK_NOT_RUN',
      isCompletedReplay: false,
      verdictStatus: null,
      displayState: 'not_run',
      message:
        'Verified: queued/not_run case is not treated as completed replay',
    };
  }

  // Case 2: outcome is not 'not_run', but verdict is missing / undefined / null / not an object
  // Fail closed: never throw TypeError, never claim completed replay or passed!
  if (!verdict || typeof verdict !== 'object') {
    return {
      valid: false,
      code: 'MISSING_VERDICT',
      isCompletedReplay: false,
      verdictStatus: null,
      outcome,
      hasVerdict: false,
      message: `Case outcome is "${outcome}" but verdict object is missing or null; failing closed without claiming completed replay or passed`,
    };
  }

  // Case 3: case with verdict object
  const validVerdictStatuses = [
    'passed',
    'issue_found',
    'blocked',
    'inconclusive',
  ];
  if (!verdict.status || !validVerdictStatuses.includes(verdict.status)) {
    return {
      valid: false,
      code: 'INVALID_VERDICT_STATUS',
      isCompletedReplay: false,
      verdictStatus: null,
      message: `Verdict status "${verdict.status}" is not a canonical verdict status`,
      actual: verdict.status,
    };
  }

  if (claimedPassed && verdict.status !== 'passed') {
    return {
      valid: false,
      code: 'VERDICT_MISMATCH',
      isCompletedReplay: true,
      verdictStatus: verdict.status,
      message: `Cannot claim passed when real verdict status is "${verdict.status}"`,
      expected: 'passed',
      actual: verdict.status,
    };
  }

  return {
    valid: true,
    code: 'OK_EVALUATED',
    isCompletedReplay: true,
    verdictStatus: verdict.status,
    displayState: verdict.status,
    summary: verdict.summary,
    message: `Verified: case verdict strictly derived from real verdict.status="${verdict.status}"`,
  };
}

/**
 * 8. Validate Phase Timeline States (PhaseProgress verification helper).
 * Enforces:
 * - When queued, zero phases can be marked active or completed.
 * - In regression mode, explore and plan phases are skipped and NEVER completed.
 * - When status is cancelled or failed, the current phase and all subsequent phases must NEVER be marked completed.
 */
export const PHASE_KEYS = [
  'preflight',
  'auth',
  'explore',
  'plan',
  'execute',
  'reproduce',
  'finalize',
];

export function computePhaseTimeline({
  currentPhase = '',
  status = '',
  executionMode = 'smoke',
}) {
  const normStatus = (status || '').toLowerCase();
  const normPhase = (currentPhase || '').toLowerCase();
  const isQueued = normStatus === 'queued';
  const isFailed = normStatus === 'failed';
  const isCancelled =
    normStatus === 'cancelled' || normStatus === 'interrupted';
  const isCompleted = normStatus === 'completed';
  const isRegression = executionMode === 'regression';

  const currentIndex = isQueued ? -1 : PHASE_KEYS.indexOf(normPhase);

  return PHASE_KEYS.map((key, idx) => {
    const isRegressionSkipped =
      isRegression && (key === 'explore' || key === 'plan');

    let stateClass;
    let isPhaseCompleted;

    if (isQueued) {
      stateClass = '';
      isPhaseCompleted = false;
    } else if (isRegressionSkipped) {
      stateClass = 'skipped';
      isPhaseCompleted = false;
    } else if (isCompleted) {
      stateClass = 'completed';
      isPhaseCompleted = true;
    } else if (currentIndex === -1) {
      stateClass = '';
      isPhaseCompleted = false;
    } else if (idx < currentIndex) {
      stateClass = 'completed';
      isPhaseCompleted = true;
    } else if (idx === currentIndex) {
      if (isFailed) {
        stateClass = 'failed';
        isPhaseCompleted = false;
      } else if (isCancelled) {
        stateClass = 'cancelled';
        isPhaseCompleted = false;
      } else {
        stateClass = 'active';
        isPhaseCompleted = false;
      }
    } else {
      stateClass = '';
      isPhaseCompleted = false;
    }

    return {
      key,
      stateClass,
      isCompleted: isPhaseCompleted,
    };
  });
}

export function validatePhaseTimelineStates({
  currentPhase = '',
  status = '',
  executionMode = 'smoke',
}) {
  const timeline = computePhaseTimeline({
    currentPhase,
    status,
    executionMode,
  });
  const completedPhases = timeline.filter((p) => p.isCompleted);
  const skippedPhases = timeline.filter((p) => p.stateClass === 'skipped');
  const activePhases = timeline.filter((p) => p.stateClass === 'active');
  const failedPhases = timeline.filter((p) => p.stateClass === 'failed');
  const cancelledPhases = timeline.filter((p) => p.stateClass === 'cancelled');

  const normStatus = (status || '').toLowerCase();
  const normPhase = (currentPhase || '').toLowerCase();
  const currentIndex = PHASE_KEYS.indexOf(normPhase);

  // Assertion 1: When queued, 0 completed and 0 active
  if (
    normStatus === 'queued' &&
    (completedPhases.length > 0 || activePhases.length > 0)
  ) {
    return {
      valid: false,
      code: 'QUEUED_PHASE_ACTIVE_OR_COMPLETED',
      message:
        'When status is queued, zero phases can be marked active or completed',
    };
  }

  // Assertion 2: In regression mode, explore and plan must NEVER be completed
  if (executionMode === 'regression') {
    const hasExploreOrPlanCompleted = completedPhases.some(
      (p) => p.key === 'explore' || p.key === 'plan',
    );
    if (hasExploreOrPlanCompleted) {
      return {
        valid: false,
        code: 'REGRESSION_EXPLORE_PLAN_MARKED_COMPLETED',
        message:
          'In regression mode, explore and plan phases must be skipped and NEVER completed',
      };
    }
  }

  // Assertion 3: When cancelled or failed, current and subsequent phases (idx >= currentIndex) must NEVER be completed
  if (normStatus === 'cancelled' || normStatus === 'failed') {
    if (currentIndex >= 0) {
      const subsequentCompleted = timeline.some(
        (p, idx) => idx >= currentIndex && p.isCompleted,
      );
      if (subsequentCompleted) {
        return {
          valid: false,
          code: 'TERMINATED_SUBSEQUENT_PHASES_COMPLETED',
          message: `When status is ${normStatus} at phase ${normPhase}, the current and subsequent phases must NEVER be marked completed`,
        };
      }
    }
  }

  return {
    valid: true,
    code: 'OK',
    completedCount: completedPhases.length,
    skippedCount: skippedPhases.length,
    activeCount: activePhases.length,
    failedCount: failedPhases.length,
    cancelledCount: cancelledPhases.length,
    timeline,
  };
}
