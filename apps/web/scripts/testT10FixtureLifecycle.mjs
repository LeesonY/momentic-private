import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import {
  prepareFixture,
  verifyFixtureHealth,
  verifyRegressionRunApiProvenance,
  cleanupFixture,
} from './t10FixtureLifecycle.mjs';
import {
  validateRegressionRunModelBindings,
  validateRegressionRunProvenance,
  validateCaseVerdictState,
} from './t10VerificationHelpers.mjs';

console.log('===============================================================');
console.log(' LocalQA: T10-C Fixture Lifecycle Self-Check (Browserless)    ');
console.log(
  '===============================================================\n',
);

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

async function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

async function runSelfCheck() {
  let fixture = null;

  console.log('========================================================');
  console.log(' Suite 1: Full Normal Fixture Lifecycle with Model Probe');
  console.log('========================================================');
  try {
    console.log('\n--- Step 1: Prepare Isolated Fixture ---');
    fixture = await prepareFixture({
      tag: `s1${Date.now().toString(36).slice(-4)}`,
    });

    // 1. Check returned IDs structure including probed model version
    assert(
      fixture.createdIds &&
        typeof fixture.createdIds.userId === 'string' &&
        typeof fixture.createdIds.projectId === 'string' &&
        typeof fixture.createdIds.environmentId === 'string' &&
        typeof fixture.createdIds.modelProfileId === 'string' &&
        typeof fixture.createdIds.modelProfileVersion === 'number' &&
        fixture.createdIds.modelProfileVersion >= 2 &&
        typeof fixture.createdIds.runId === 'string' &&
        typeof fixture.createdIds.sourceRunCaseId === 'string',
      'prepareFixture returns complete set of isolated created IDs including probed model version (>=2)',
      `project=${fixture.createdIds.projectId}, model=${fixture.createdIds.modelProfileId}, version=${fixture.createdIds.modelProfileVersion}`,
    );

    // 2. Check credentials file mode 0600
    const credPath = fixture.credentialsFile;
    assert(
      fs.existsSync(credPath),
      'Credentials file exists in isolated directory',
      credPath,
    );

    const stat = fs.statSync(credPath);
    const modeOctal = (stat.mode & 0o777).toString(8);
    assert(
      (stat.mode & 0o777) === 0o600,
      'Credentials file strictly protected with mode 0600',
      `actual mode: 0${modeOctal}`,
    );

    // 3. Check credentials are not in returned summary object root
    assert(
      !('password' in fixture) &&
        !('adminPassword' in fixture) &&
        !('sessionCookie' in fixture) &&
        !('modelApiKey' in fixture),
      'Credentials (user password, session cookie, model API key) are not leaked in returned summary root object',
    );

    // 4. Check source RunCase notice
    assert(
      fixture.sourceRunCaseNotice &&
        fixture.sourceRunCaseNotice.includes('未经真实冒烟执行'),
      'sourceRunCase fixture explicitly marked as unexecuted by real worker',
    );

    // 5. Check model probe evidence from prepare phase
    assert(
      fixture.modelProbeEvidence &&
        fixture.modelProbeEvidence.status === 'degraded' &&
        fixture.modelProbeEvidence.capabilities?.structuredOutput === true &&
        fixture.modelProbeEvidence.probedVersion ===
          fixture.createdIds.modelProfileVersion &&
        fixture.modelProbeEvidence.recordedCallsCount >= 1,
      'Model profile capability probe verified: degraded status, structuredOutput capability, probedVersion, and recorded call',
    );

    // 6. Check ledger format with exact containerId and modelProfileVersion
    assert(
      fixture.ledger &&
        fixture.ledger.ownership === 'T10-C' &&
        fixture.ledger.status === 'active' &&
        fixture.ledger.containerId &&
        fixture.ledger.containerId.length >= 12 &&
        fixture.ledger.createdIds?.modelProfileVersion ===
          fixture.createdIds.modelProfileVersion,
      'Cleanup ledger records exact container ID, ports, directory, probed model version, and T10-C ownership',
    );

    console.log('\n--- Step 2: Verify Fixture Health (Read-Only) ---');
    const health = await verifyFixtureHealth(fixture);

    assert(health.healthy === true, 'All read-only health checks passed');
    assert(
      health.checks.healthLive === true,
      'Canonical API health check (/api/v1/health/live) is ok',
    );
    assert(
      health.checks.testAppLive === true,
      'Controlled HTML test app is verified live at environment.baseUrl (not relying on API 404)',
      fixture.testAppUrl,
    );
    assert(
      health.checks.authMe === true,
      'Auth session matches created admin user',
    );
    assert(
      health.checks.project === true,
      'Project exists and defaultModelProfileId matches isolated model',
    );
    assert(
      health.checks.environment === true,
      'Isolated environment exists and points to test app baseUrl',
    );
    assert(
      health.checks.modelProfile === true,
      'Model profile in DB is verified degraded with structuredOutput capability and internal dataBoundary',
    );
    assert(
      health.checks.runModelBindings === true,
      'Run effectiveConfig.models binds all 5 roles to frozen model profile and probed version',
    );
    assert(
      health.checks.sourceRunCase === true,
      'Synthetic source run case exists in database',
    );

    console.log(
      '\n--- Step 2b: Counterexample Verifications (Bad Version Detection) ---',
    );
    const creds = JSON.parse(fs.readFileSync(fixture.credentialsFile, 'utf8'));
    const runRes = await fetch(
      `${fixture.baseUrl}/api/v1/runs/${fixture.createdIds.runId}`,
      {
        headers: { Cookie: creds.sessionCookie },
      },
    );
    const runData = await runRes.json();

    // Positive check using validateRegressionRunModelBindings helper
    const posCheck = validateRegressionRunModelBindings({
      run: runData,
      expectedModelProfileId: fixture.createdIds.modelProfileId,
      expectedModelProfileVersion: fixture.createdIds.modelProfileVersion,
    });
    assert(
      posCheck.valid &&
        posCheck.boundModelProfileVersion ===
          fixture.createdIds.modelProfileVersion,
      'validateRegressionRunModelBindings confirms all 5 roles match frozen probed version',
      `probedVersion=${posCheck.boundModelProfileVersion}`,
    );

    // Negative counterexample 1: Stale version 1 (before probe)
    const tamperedStaleRun = JSON.parse(JSON.stringify(runData));
    tamperedStaleRun.effectiveConfig.models.reproducer.version = 1;
    const staleCheck = validateRegressionRunModelBindings({
      run: tamperedStaleRun,
      expectedModelProfileId: fixture.createdIds.modelProfileId,
      expectedModelProfileVersion: fixture.createdIds.modelProfileVersion,
    });
    assert(
      !staleCheck.valid &&
        staleCheck.code === 'ROLE_MODEL_BINDING_MISMATCH' &&
        staleCheck.mismatchedRoles.some(
          (r) => r.role === 'reproducer' && r.actualVersion === 1,
        ),
      'Counterexample: Rejects run with stale/pre-probe version 1 on reproducer role',
    );

    // Negative counterexample 2: Un-probed rogue future version 99
    const tamperedRogueRun = JSON.parse(JSON.stringify(runData));
    for (const r of [
      'coordinator',
      'explorer',
      'executor',
      'assertion',
      'reproducer',
    ]) {
      tamperedRogueRun.effectiveConfig.models[r].version = 99;
    }
    const rogueCheck = validateRegressionRunModelBindings({
      run: tamperedRogueRun,
      expectedModelProfileId: fixture.createdIds.modelProfileId,
      expectedModelProfileVersion: fixture.createdIds.modelProfileVersion,
    });
    assert(
      !rogueCheck.valid &&
        rogueCheck.code === 'ROLE_MODEL_BINDING_MISMATCH' &&
        rogueCheck.mismatchedRoles.length === 5,
      'Counterexample: Rejects run where roles bind to rogue/unfrozen version 99',
    );

    console.log(
      '\n--- Step 2c: Regression Run API Provenance & Queued/Not_Run Verification ---',
    );
    const regData = await verifyRegressionRunApiProvenance(fixture);

    // 1. Verify Regression Run executionMode and queued status
    assert(
      regData.regressionRun &&
        regData.regressionRun.executionMode === 'regression' &&
        regData.regressionRun.status === 'queued',
      'API regression run returns executionMode="regression" and initial status="queued"',
      `runId=${regData.regressionRun.id}`,
    );

    // 2. Verify CaseRecord outcome is "not_run" and verdict is strictly null
    assert(
      regData.firstCaseDetail &&
        regData.firstCaseDetail.outcome === 'not_run' &&
        regData.firstCaseDetail.verdict === null,
      'API regression case starts with outcome="not_run" and verdict=null (strictly not completed replay)',
      `caseId=${regData.firstCaseDetail.definition?.id}`,
    );

    // 3. Verify CaseDefinition.regression canonical binding
    const regBinding = regData.firstCaseDetail?.definition?.regression;
    assert(
      regBinding &&
        typeof regBinding.sourceVersionId === 'string' &&
        typeof regBinding.sourceDocumentSha256 === 'string' &&
        typeof regBinding.snapshotDocumentSha256 === 'string' &&
        Array.isArray(regBinding.moduleSnapshots),
      'API case includes canonical regression provenance (sourceVersionId, sourceDocumentSha256, snapshotDocumentSha256, moduleSnapshots)',
      `sourceVersionId=${regBinding?.sourceVersionId}`,
    );

    // 4. Validate through validateCaseVerdictState guard
    const verdictCheck = validateCaseVerdictState({
      caseRecord: regData.firstCaseDetail,
      claimedPassed: false,
    });
    assert(
      verdictCheck.valid &&
        verdictCheck.isCompletedReplay === false &&
        verdictCheck.verdictStatus === null,
      'validateCaseVerdictState confirms case is not treated as completed replay and verdictStatus is null',
    );

    // 5. Anti-counterexample: Attempting to claim passed on queued/not_run case must be rejected
    const falseClaimCheck = validateCaseVerdictState({
      caseRecord: regData.firstCaseDetail,
      claimedPassed: true,
    });
    assert(
      !falseClaimCheck.valid && falseClaimCheck.code === 'FORGED_PASSED_STATE',
      'Counterexample: validateCaseVerdictState rejects claiming passed on queued/not_run case',
    );

    // 6. Validate through validateRegressionRunProvenance guard
    const provCheck = validateRegressionRunProvenance({
      run: regData.regressionRun,
      cases: regData.cases,
      steps: [],
    });
    assert(
      provCheck.valid && provCheck.unverifiedCount === 0,
      'validateRegressionRunProvenance confirms 100% verified provenance across API run and regression cases',
      `unverifiedCount=${provCheck.unverifiedCount}`,
    );
  } finally {
    if (fixture) {
      console.log('\n--- Step 3: Cleanup Fixture (Self-destruction) ---');
      const containerId = fixture.ledger.containerId;
      const apiPort = fixture.apiPort;
      const appPort = fixture.appPort;
      const dir = fixture.ledger.dir;

      await cleanupFixture(fixture);

      // Verify container is removed by ID
      const checkPs = spawnSync(
        'docker',
        ['ps', '-a', '--filter', `id=${containerId}`, '--format', '{{.ID}}'],
        {
          encoding: 'utf8',
        },
      );
      const containerExists = (checkPs.stdout || '')
        .trim()
        .includes(containerId.slice(0, 12));
      assert(
        !containerExists,
        'Isolated PG container completely destroyed by exact ID',
        containerId.slice(0, 12),
      );

      // Verify directory is deleted
      const dirExists = fs.existsSync(dir);
      assert(
        !dirExists,
        'Isolated temporary directory completely removed',
        dir,
      );

      // Verify API port and Test App port are closed
      const apiPortStillOpen = await isPortOpen(apiPort);
      assert(
        !apiPortStillOpen,
        'Dedicated API port is closed and released',
        `port ${apiPort}`,
      );

      const appPortStillOpen = await isPortOpen(appPort);
      assert(
        !appPortStillOpen,
        'Controlled Test App port is closed and released',
        `port ${appPort}`,
      );
    }
  }

  console.log('\n========================================================');
  console.log(' Suite 2: Fault Injection & Mid-Flight Rollback Cleanup  ');
  console.log('========================================================');
  let injectedErrorCaught = false;

  try {
    console.log('\n--- Injected Failure at before_run_creation ---');
    await prepareFixture({
      tag: `err${Date.now().toString(36).slice(-4)}`,
      faultInjection: { failAt: 'before_run_creation' },
    });
  } catch (err) {
    injectedErrorCaught = true;
    console.log(
      `  ✓ Successfully intercepted injected error: "${err.message}"`,
    );
    assert(
      err.message.includes(
        'Simulated failure triggered at step: "before_run_creation"',
      ),
      'prepareFixture rejects with exact injected fault message',
    );
  }

  assert(
    injectedErrorCaught,
    'prepareFixture cleanly failed and triggered rollback on fault injection',
  );

  // Verify that docker ps -a contains zero localqa-t10c-pg-* containers
  const checkLingering = spawnSync(
    'docker',
    ['ps', '-a', '--filter', 'name=localqa-t10c-pg-', '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  );
  const lingeringContainers = (checkLingering.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert(
    lingeringContainers.length === 0,
    'Rollback guarantees zero lingering PG containers left after aborted setup',
    `lingering: ${lingeringContainers.join(', ') || 'none'}`,
  );

  console.log(
    '\n===============================================================',
  );
  console.log(`Results: ${passedTests}/${totalTests} Passed`);
  console.log(
    `Overall: ${passedTests === totalTests ? 'ALL FIXTURE TESTS PASS ✓' : 'FAILED ✗'}`,
  );
  console.log(
    '===============================================================\n',
  );

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runSelfCheck().catch((err) => {
  console.error('Self-check encountered unexpected error:', err);
  process.exit(1);
});
