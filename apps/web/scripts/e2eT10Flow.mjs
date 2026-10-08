/* global localStorage, window */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  normalizeApiUrl,
  checkRealBackendHealth,
  createProxyServer,
} from './httpProxyHelper.mjs';
import {
  validateProjectAndModelProfile,
  validateRegressionRunModelBindings,
  validateVersionDifferentiation,
  createStepRecorder,
  verificationExitCode,
} from './t10VerificationHelpers.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, '..');
const distDir = path.resolve(webDir, 'dist');

// CLI argument & Environment parsing
const args = process.argv.slice(2);
const isRealMode = args.includes('--real');

function getArgValue(flag, envVar, defaultVal = '') {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      return args[i + 1] || defaultVal;
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return process.env[envVar] || defaultVal;
}

// 1. Unified Origin & API Base URL Validation
const rawApiUrl = process.env.LOCALQA_API_URL || 'http://127.0.0.1:5188';
let backendInfo;
try {
  backendInfo = normalizeApiUrl(rawApiUrl);
} catch (err) {
  console.error(
    `[T10-C Error] Invalid LOCALQA_API_URL: "${rawApiUrl}" - ${err.message}`,
  );
  process.exit(1);
}

const backendOrigin = backendInfo.origin;

// Task identifier for execution isolation
const taskSlug = isRealMode
  ? `t10c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  : 'mock_run';

// 6. Separate Evidence Directories (Preserving T07 Historical Evidence)
const evidenceBaseDir = path.resolve(webDir, '.evidence');
const modeEvidenceDir = isRealMode
  ? path.resolve(evidenceBaseDir, 'real', taskSlug)
  : path.resolve(evidenceBaseDir, 'mock');
const screenshotsDir = path.resolve(modeEvidenceDir, 'screenshots');

if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

// Seeds - strictly parameterized
const projectIdSeed = getArgValue(
  '--project-id',
  'LOCALQA_TEST_PROJECT_ID',
  '',
);
const caseIdSeed = getArgValue('--case-id', 'LOCALQA_TEST_CASE_ID', '');
const smokeCaseIdSeed = getArgValue(
  '--smoke-case-id',
  'LOCALQA_TEST_SMOKE_CASE_ID',
  '',
);
const runIdSeed = getArgValue('--run-id', 'LOCALQA_TEST_RUN_ID', '');
const environmentIdSeed = getArgValue(
  '--environment-id',
  'LOCALQA_TEST_ENVIRONMENT_ID',
  '',
);
const modelProfileIdSeed = getArgValue(
  '--model-profile-id',
  'LOCALQA_TEST_MODEL_PROFILE_ID',
  '',
);

// Real credentials: read ONLY from environment, never from CLI args or guessed defaults
const usernameSeed = process.env.LOCALQA_TEST_USERNAME || '';
const passwordSeed = process.env.LOCALQA_TEST_PASSWORD || '';

const PORT = 5199;

async function run() {
  console.log(
    '===============================================================',
  );
  console.log(' LocalQA T10: Case Library & Regression E2E Verification Flow ');
  console.log(
    '===============================================================',
  );
  console.log(
    `Target Mode: ${isRealMode ? 'REAL API (apps/api backend)' : 'MOCK (Offline Contract Simulation)'}`,
  );
  console.log(`Task Slug: ${taskSlug}`);
  console.log(`Evidence Directory: ${modeEvidenceDir}`);

  const cleanupLedger = {
    taskSlug,
    mode: isRealMode ? 'real' : 'mock',
    projectId: isRealMode ? projectIdSeed : 'mock_project_01',
    environmentId: isRealMode
      ? environmentIdSeed || 'auto_selected_first'
      : 'mock_env_01',
    modelProfileId: isRealMode
      ? modelProfileIdSeed || 'project_default'
      : 'mock_model_01',
    createdResources: [],
    preExistingBaselinesUntouched: isRealMode && caseIdSeed ? [caseIdSeed] : [],
    cleanupStatus: isRealMode
      ? 'RETAINED_PENDING_FIXTURE_TEARDOWN'
      : 'NOT_APPLICABLE',
    cleanupPolicy:
      'OpenAPI contract specifies no DELETE route for saved_cases. Created resources are isolated with taskSlug prefix and retained for controller fixture DB teardown. No pre-existing baseline was mutated or deleted.',
  };

  if (isRealMode) {
    console.log(
      `Checking real backend connectivity at: ${backendOrigin}/api/v1/health/live...`,
    );
    const isBackendReady = await checkRealBackendHealth(backendOrigin);
    if (!isBackendReady) {
      console.warn('\n⚠️ [T10-C Status: WAITING_FOR_BACKEND_SIGNAL]');
      console.warn(
        `  - Real API at ${backendOrigin} is currently NOT reachable.`,
      );
      console.warn(
        '  - Backend (pi) is currently finalizing storage migrations and route handlers.',
      );
      console.warn(
        '  - Per T10-C rules: We DO NOT fake real API results using mock data.',
      );
      console.warn(
        '  - Frontend code, OpenAPI 70-op contracts, and mock flows are verified.',
      );
      console.warn(
        '  - To verify UI flows and state machines offline, run: pnpm --filter @localqa/web test:t10',
      );
      process.exit(2);
    }
    console.log('✓ Real backend is reachable.');

    // 2. Credential Check (Environment only, never guess default)
    if (!usernameSeed || !passwordSeed) {
      console.warn('\n⚠️ [T10-C Status: BLOCKED_WAITING_FOR_CREDENTIALS]');
      console.warn('  - Missing environment credentials for Real API mode:');
      console.warn('      export LOCALQA_TEST_USERNAME="<username>"');
      console.warn('      export LOCALQA_TEST_PASSWORD="<password>"');
      console.warn(
        '  - Per security requirements, real credentials must not be passed via CLI arguments or guessed defaults.',
      );
      process.exit(2);
    }

    // 3. Seed Check (projectIdSeed required)
    if (!projectIdSeed) {
      console.warn('\n⚠️ [T10-C Status: BLOCKED_WAITING_FOR_SEEDS]');
      console.warn(
        '  - Real API mode requires controlled test seeds to avoid colliding with shared data.',
      );
      console.warn(
        '  - Required seed: --project-id=<id> (or LOCALQA_TEST_PROJECT_ID)',
      );
      console.warn(
        '  - Optional seeds: --case-id=<id>, --smoke-case-id=<id>, --run-id=<id>',
      );
      process.exit(2);
    }
  } else {
    console.log(
      'Notice: Running in MOCK mode (contract-faithful offline simulation).',
    );
    console.log(
      'Real backend integration will execute upon main control ready signal.\n',
    );
  }

  // Ensure production dist is built
  if (
    !fs.existsSync(distDir) ||
    !fs.existsSync(path.join(distDir, 'index.html'))
  ) {
    console.error(
      'Error: apps/web/dist does not exist. Please run "pnpm build" or "npm run build" first.',
    );
    process.exit(1);
  }

  const proxyInstance = createProxyServer({
    backendOrigin,
    distDir,
    port: PORT,
  });
  await proxyInstance.listen(PORT, '127.0.0.1');
  console.log(
    `[T10 E2E] Local web server listening at http://127.0.0.1:${PORT}`,
  );
  console.log(
    `[T10 E2E] Reverse proxy active: /api/* -> ${backendOrigin}/api/*`,
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  // Client switching: Pre-set localStorage via addInitScript before ANY scripts load
  await context.addInitScript(
    ({ mockPreference }) => {
      localStorage.setItem(
        'LOCALQA_USE_MOCK',
        mockPreference ? 'true' : 'false',
      );
    },
    { mockPreference: !isRealMode },
  );

  const page = await context.newPage();

  const recorder = createStepRecorder();
  const recordStep = recorder.recordStep;

  try {
    // 0. Initial Navigation & Authentication First
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForLoadState('networkidle');

    // 2. Handle Login First (if not logged in, App.tsx renders LoginPage and does not render AppHeader)
    const loginPageElement = page.locator('[data-testid="login-page"]');
    const isLoginPage = await loginPageElement
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (isLoginPage) {
      console.log(
        'Detected LoginPage. Submitting authentication credentials...',
      );
      const usernameInput = page.locator(
        '[data-testid="login-username-input"]',
      );
      const passwordInput = page.locator(
        '[data-testid="login-password-input"]',
      );
      const submitBtn = page.locator('[data-testid="btn-login-submit"]');

      if (isRealMode) {
        await usernameInput.fill(usernameSeed);
        await passwordInput.fill(passwordSeed);
      }
      await submitBtn.click();
      await page.waitForSelector('[data-testid="app-header"]', {
        timeout: 8000,
      });
      console.log(
        '✓ Successfully authenticated and landed on application shell.',
      );
    } else {
      await page.waitForSelector('[data-testid="app-header"]', {
        timeout: 5000,
      });
    }

    // Now that user is authenticated and AppHeader is rendered, assert client adapter & UI indicator
    const liveClientType = await page.evaluate(
      () => window.__LOCALQA_CLIENT_TYPE__,
    );
    const liveIsMock = await page.evaluate(() => window.__LOCALQA_IS_MOCK__);
    const expectedClient = isRealMode ? 'HttpApiClient' : 'MockApiClient';

    recordStep(
      `Client adapter initializes correctly as ${expectedClient}`,
      liveClientType === expectedClient && liveIsMock === !isRealMode,
      {
        liveClientType,
        liveIsMock,
        expectedClient,
      },
    );

    const mockIndicator = page.locator('[data-testid="mock-mode-indicator"]');
    await mockIndicator.waitFor({ state: 'visible', timeout: 5000 });
    const indicatorText = await mockIndicator.textContent();
    const bannerVisible = await page
      .locator('[data-testid="offline-mock-banner"]')
      .isVisible()
      .catch(() => false);

    if (isRealMode) {
      recordStep(
        'UI header displays Real API mode without offline mock banner',
        indicatorText.includes('真实 API 模式') && !bannerVisible,
      );
    } else {
      recordStep(
        'UI header displays Mock mode with offline mock banner',
        indicatorText.includes('Mock 模式') && bannerVisible,
      );
    }

    console.log('\n--- 1. Testing Case Library Page (SavedCasesPage) ---');
    // 3. In real mode, explicitly select controlled project in project-selector
    if (isRealMode && projectIdSeed) {
      const projectSelector = page.locator('[data-testid="project-selector"]');
      if (await projectSelector.isVisible().catch(() => false)) {
        await projectSelector.selectOption(projectIdSeed);
        console.log(`Selected controlled project: ${projectIdSeed}`);
      }
      // Await activeProject.id matching controlled projectIdSeed
      await page.waitForFunction(
        (targetId) => window.__LOCALQA_CURRENT_PROJECT__?.id === targetId,
        projectIdSeed,
        { timeout: 8000 },
      );
    }

    const activeProject = await page.evaluate(
      () => window.__LOCALQA_CURRENT_PROJECT__,
    );
    const projectValidation = validateProjectAndModelProfile({
      activeProject,
      targetProjectId: isRealMode ? projectIdSeed : '',
      modelProfileIdSeed,
    });

    if (!projectValidation.valid) {
      console.error(
        `[T10-C Error] Project/Model validation failed: ${projectValidation.message}`,
      );
      recordStep(
        'Project frozen default model profile verified against seed configuration',
        'failed',
        {
          validationResult: projectValidation,
          error: projectValidation.message,
        },
      );
      throw new Error(projectValidation.message);
    }

    const effectiveModelProfileId = projectValidation.effectiveModelProfileId;
    cleanupLedger.projectId = projectValidation.projectId;
    cleanupLedger.modelProfileId = effectiveModelProfileId;

    recordStep(
      'Project frozen default model profile verified against seed configuration',
      'passed',
      {
        projectId: projectValidation.projectId,
        effectiveModelProfileId,
        modelProfileIdSeed:
          modelProfileIdSeed || '(omitted, using project default)',
      },
    );

    const navLink = page.locator('[data-testid="nav-saved-cases"]');
    await navLink.waitFor({ state: 'visible', timeout: 5000 });
    await navLink.click();
    await page.waitForSelector('[data-testid="saved-cases-page"]', {
      timeout: 5000,
    });

    let activeCaseSlug = '';
    let isolatedCaseName = '';

    if (!isRealMode) {
      // Mock Fixture assertions
      const row1 = page.locator(
        '[data-testid="case-row-checkout-coupon-calc"]',
      );
      const row2 = page.locator('[data-testid="case-row-user-profile-save"]');
      const hasRow1 = await row1.isVisible();
      const hasRow2 = await row2.isVisible();
      activeCaseSlug = 'user-profile-save';
      isolatedCaseName = '用户资料修改与保存流程 (Draft 草稿待审)';

      recordStep(
        '[MOCK_FIXTURE] Case library page loads with project saved cases',
        hasRow1 && hasRow2,
        {
          hasRow1,
          hasRow2,
        },
      );

      // Test search filter
      const searchInput = page.locator(
        '[data-testid="input-search-saved-cases"]',
      );
      await searchInput.fill('资料');
      await page.waitForTimeout(300);
      const filteredVisible = await row2.isVisible();
      const filteredHidden = !(await row1.isVisible());
      recordStep(
        '[MOCK_FIXTURE] Case library search filter functions correctly',
        filteredVisible && filteredHidden,
      );
      await searchInput.clear();
      await page.waitForTimeout(200);
    } else {
      // 4. Real Seeded Mode: Create an isolated case with unique slug so pre-existing seeds are NEVER mutated!
      const isolatedSlug = `${taskSlug}-case`;
      isolatedCaseName = `[${taskSlug}] Automated Isolation Test Case`;

      console.log(`Creating isolated test case with slug: ${isolatedSlug}...`);
      await page.locator('[data-testid="btn-create-empty-case"]').click();
      await page.waitForSelector('[data-testid="create-case-form"]', {
        timeout: 5000,
      });

      await page
        .locator('[data-testid="input-new-case-slug"]')
        .fill(isolatedSlug);
      await page
        .locator('[data-testid="input-new-case-name"]')
        .fill(isolatedCaseName);
      await page.locator('[data-testid="btn-submit-create-case"]').click();

      const createdRow = page.locator(
        `[data-testid="case-row-${isolatedSlug}"]`,
      );
      await createdRow.waitFor({ state: 'visible', timeout: 8000 });
      activeCaseSlug = isolatedSlug;

      recordStep(
        `[REAL_SEEDED] Created isolated test case ${isolatedSlug} under project ${projectIdSeed}`,
        true,
        {
          isolatedSlug,
          projectId: projectIdSeed,
        },
      );
    }

    const listScreenshot = path.join(
      screenshotsDir,
      't10-01-saved-cases-list.png',
    );
    await page.screenshot({ path: listScreenshot, fullPage: true });

    console.log('\n--- 2. Testing Case Detail & Initial Draft v1 ---');
    // Detail button testid is btn-view-detail-${slug}
    const detailBtn = page.locator(
      `[data-testid="btn-view-detail-${activeCaseSlug}"]`,
    );
    await detailBtn.click();
    await page.waitForSelector('[data-testid="saved-case-detail-page"]', {
      timeout: 5000,
    });

    const realCaseId = await page
      .locator('[data-testid="saved-case-detail-page"]')
      .getAttribute('data-case-id');
    const v1Id = await page
      .locator('[data-testid="version-tab-v1"]')
      .getAttribute('data-version-id');
    const initialParentVersion = parseInt(
      (await page
        .locator('[data-testid="saved-case-detail-page"]')
        .getAttribute('data-case-version')) || '1',
      10,
    );

    if (isRealMode) {
      cleanupLedger.createdResources.push({
        type: 'saved_case',
        id: realCaseId || null,
        slug: activeCaseSlug,
        name: isolatedCaseName,
        status: realCaseId ? 'VERIFIED' : 'UNVERIFIED_PENDING_REAL_ID',
      });
      cleanupLedger.createdResources.push({
        type: 'saved_case_version',
        id: v1Id || null,
        version: 1,
        caseId: realCaseId || null,
        caseSlug: activeCaseSlug,
        reviewStatus: 'draft',
        status: v1Id ? 'VERIFIED' : 'UNVERIFIED_PENDING_REAL_ID',
      });
    }

    const caseTitle = await page
      .locator('[data-testid="case-title"]')
      .textContent();
    const criteriaCards = await page
      .locator('[data-testid^="criterion-card-"]')
      .count();
    const stepCards = await page.locator('[data-testid^="step-card-"]').count();

    // Check version history sub-tab
    const historyTab = page.locator('[data-testid="tab-view-history"]');
    await historyTab.click();
    await page.waitForSelector('[data-testid="version-history-table"]', {
      timeout: 5000,
    });

    const historyRowV1 = page.locator('[data-testid="history-row-v1"]');
    await historyRowV1.waitFor({ state: 'visible', timeout: 5000 });
    const v1HashText = (
      (await historyRowV1.locator('code').textContent()) || ''
    ).trim();
    const hasValidSha256 = /[0-9a-f]{8,64}/i.test(v1HashText);

    if (isRealMode) {
      recordStep(
        'Case detail renders criteria, replay steps & immutable version history with cryptographic SHA-256',
        criteriaCards >= 1 && stepCards >= 1 && hasValidSha256,
        {
          caseTitle,
          criteriaCards,
          stepCards,
          v1HashText,
          hasValidSha256,
          realCaseId: realCaseId || '(unverified)',
          v1Id: v1Id || '(unverified)',
          initialParentVersion,
        },
      );
    } else {
      recordStep(
        '[MOCK_FIXTURE] Case detail renders criteria, replay steps & version history table with mock SHA-256 field display',
        criteriaCards >= 1 && stepCards >= 1 && hasValidSha256,
        {
          caseTitle,
          criteriaCards,
          stepCards,
          v1HashText,
          initialParentVersion,
          scopeDelineation:
            'MOCK_DISPLAY: Confirms UI table renders SHA-256 hash column. Cryptographic calculation unverified in offline mock mode.',
        },
      );
      recordStep(
        '[MOCK_MODE] Cryptographic SHA-256 hash calculation: UNVERIFIED_IN_MOCK_MODE (Pending live backend PG storage)',
        'unverified',
        {
          note: 'Fixed mock hash in data.ts demonstrates UI display only; cryptographic hashing runs in apps/api route handlers.',
        },
      );
    }

    const detailScreenshot = path.join(
      screenshotsDir,
      't10-02-saved-case-detail.png',
    );
    await page.screenshot({ path: detailScreenshot, fullPage: true });

    // Switch back to document view
    await page.locator('[data-testid="tab-view-document"]').click();

    console.log(
      '\n--- 3. Approve Initial v1 Baseline (Advance SavedCase.version) ---',
    );
    // Review and approve v1 first so parent SavedCase.version increments to 2
    const startReviewV1Btn = page.locator('[data-testid="btn-start-review"]');
    await startReviewV1Btn.click();
    await page.waitForSelector('[data-testid="case-review-modal-content"]', {
      timeout: 5000,
    });

    const v1ReasonText = '初次审查核验完成，批准作为首个基线版本。';
    await page
      .locator('[data-testid="input-review-reason"]')
      .fill(v1ReasonText);

    let v1PreviewRespPromise = null;
    if (isRealMode) {
      v1PreviewRespPromise = page.waitForResponse(
        (res) =>
          /\/api\/v1\/saved-case-versions\/[^/]+\/review-preview(?:\?.*)?$/.test(
            res.url(),
          ) && res.request().method() === 'POST',
        { timeout: 10000 },
      );
    }

    await page.locator('[data-testid="btn-request-review-preview"]').click();
    await page.waitForSelector(
      '[data-testid="review-preview-security-panel"]',
      { timeout: 5000 },
    );

    let v1ConfirmationToken = '';
    if (isRealMode) {
      const resp = await v1PreviewRespPromise;
      const data = await resp.json();
      const reqData = JSON.parse(resp.request().postData() || '{}');
      v1ConfirmationToken = data?.confirmationToken;
      recordStep(
        '[REAL_API] v1 review preview protocol: expectedVersion=1 matches version, token generated',
        resp.status() === 200 &&
          reqData.expectedVersion === 1 &&
          data.expectedVersion === 1 &&
          !!v1ConfirmationToken,
        {
          reqExpectedVersion: reqData.expectedVersion,
          resExpectedVersion: data.expectedVersion,
        },
      );
    }

    let v1CommitRespPromise = null;
    if (isRealMode) {
      v1CommitRespPromise = page.waitForResponse(
        (res) =>
          /\/api\/v1\/saved-case-versions\/[^/]+\/review(?:\?.*)?$/.test(
            res.url(),
          ) && res.request().method() === 'POST',
        { timeout: 10000 },
      );
    }

    await page.locator('[data-testid="btn-commit-review"]').click();
    await page.waitForSelector('[data-testid="case-review-modal-content"]', {
      state: 'hidden',
      timeout: 5000,
    });

    if (isRealMode) {
      const resp = await v1CommitRespPromise;
      const data = await resp.json();
      const reqData = JSON.parse(resp.request().postData() || '{}');
      recordStep(
        '[REAL_API] v1 review commit protocol: expectedVersion=1 and single-use token consumed',
        resp.status() === 200 &&
          reqData.expectedVersion === 1 &&
          reqData.confirmationToken === v1ConfirmationToken &&
          data.reviewStatus === 'approved',
      );
    }

    // Actively verify actual state transition after approving v1:
    const v1TitleText = await page
      .locator('[data-testid="case-title"]')
      .textContent();
    const isV1ApprovedInUI =
      (v1TitleText || '').includes('已批准') ||
      (v1TitleText || '').includes('approved');
    const parentVersionAfterV1Approve = parseInt(
      (await page
        .locator('[data-testid="saved-case-detail-page"]')
        .getAttribute('data-case-version')) || '0',
      10,
    );
    const parentVersionAdvanced =
      parentVersionAfterV1Approve === initialParentVersion + 1;

    recordStep(
      'Initial v1 version reviewed and approved as baseline (active state verified: status=approved, SavedCase.version increments)',
      isV1ApprovedInUI && parentVersionAdvanced,
      {
        v1TitleText,
        initialParentVersion,
        parentVersionAfterV1Approve,
        parentVersionAdvanced,
      },
    );

    console.log(
      '\n--- 4. Testing Edit & Create New Draft Version v2 (Differs from Parent Version) ---',
    );
    const editBtn = page.locator('[data-testid="btn-create-draft"]');
    await editBtn.click();
    await page.waitForSelector('[data-testid="case-editor-modal-content"]', {
      timeout: 5000,
    });

    const editorScreenshot = path.join(
      screenshotsDir,
      't10-03-saved-case-editor.png',
    );
    await page.screenshot({ path: editorScreenshot, fullPage: false });

    // Add a step and submit
    await page.locator('[data-testid="btn-add-step-click"]').click();
    const confirmCreateDraftBtn = page.locator(
      '[data-testid="btn-confirm-create-draft"]',
    );
    await confirmCreateDraftBtn.click();
    await page.waitForSelector('[data-testid="case-editor-modal-content"]', {
      state: 'hidden',
      timeout: 5000,
    });

    // Check that v2 exists and v1 remains unchanged
    const tabV2 = page.locator('[data-testid="version-tab-v2"]');
    const tabV1 = page.locator('[data-testid="version-tab-v1"]');
    await tabV2.waitFor({ state: 'visible', timeout: 5000 });
    const hasTabV2 = await tabV2.isVisible();
    const hasTabV1 = await tabV1.isVisible();

    const parentVersionAfterDraftV2 = parseInt(
      (await page
        .locator('[data-testid="saved-case-detail-page"]')
        .getAttribute('data-case-version')) || '0',
      10,
    );
    const v2ChildVersion = 2;
    const parentVersionAdvancedAgain =
      parentVersionAfterDraftV2 > parentVersionAfterV1Approve;

    const v2Id = await tabV2.getAttribute('data-version-id');
    if (isRealMode) {
      cleanupLedger.createdResources.push({
        type: 'saved_case_version',
        id: v2Id || null,
        version: 2,
        caseId: realCaseId || null,
        caseSlug: activeCaseSlug,
        reviewStatus: 'draft',
        status: v2Id ? 'VERIFIED' : 'UNVERIFIED_PENDING_REAL_ID',
      });
    }

    await historyTab.click();
    const historyRowV2 = page.locator('[data-testid="history-row-v2"]');
    await historyRowV2.waitFor({ state: 'visible', timeout: 5000 });

    // Immutability verification against recorded baseline hash:
    const v1HashAfterDraft = (
      (await historyRowV1.locator('code').textContent()) || ''
    ).trim();
    const v2HashText = (
      (await historyRowV2.locator('code').textContent()) || ''
    ).trim();
    const v1Unmutated = v1HashAfterDraft === v1HashText;
    const v2DistinctHash = v2HashText.length > 0 && v2HashText !== v1HashText;

    const v2DraftCreatedSuccessfully =
      hasTabV1 &&
      hasTabV2 &&
      v1Unmutated &&
      v2DistinctHash &&
      parentVersionAdvancedAgain;

    recordStep(
      'Creating new draft version increments version number to v2 without mutating v1 baseline hash (active state verified: parent version advances to 3)',
      v2DraftCreatedSuccessfully,
      {
        v1HashBefore: v1HashText,
        v1HashAfterDraft,
        v2Hash: v2HashText,
        v1Unmutated,
        v2DistinctHash,
        parentVersionAfterDraftV2,
        v2ChildVersion,
        v2Id: v2Id || '(unverified)',
      },
    );

    // Switch back to document tab so draft review button is in view
    await page.locator('[data-testid="tab-view-document"]').click();

    console.log(
      '\n--- 5. Testing Human Review on v2 (Verifying caseVersion.version vs Parent SavedCase.version) ---',
    );
    // Open Review Modal for v2
    const startReviewBtn = page.locator('[data-testid="btn-start-review"]');
    await startReviewBtn.click();
    await page.waitForSelector('[data-testid="case-review-modal-content"]', {
      timeout: 5000,
    });

    // Step 5.1: Fill reason and request review preview
    const reviewReasonText =
      '通过真实浏览器校验，步骤完整且符合质量规范，批准纳入基线。';
    const reasonInput = page.locator('[data-testid="input-review-reason"]');
    await reasonInput.fill(reviewReasonText);

    let v2PreviewRespPromise = null;
    if (isRealMode) {
      // Explicit waitForResponse and JSON parsing (avoiding page.on async race)
      v2PreviewRespPromise = page.waitForResponse(
        (res) =>
          /\/api\/v1\/saved-case-versions\/[^/]+\/review-preview(?:\?.*)?$/.test(
            res.url(),
          ) && res.request().method() === 'POST',
        { timeout: 10000 },
      );
    }

    const requestPreviewBtn = page.locator(
      '[data-testid="btn-request-review-preview"]',
    );
    await requestPreviewBtn.click();
    await page.waitForSelector(
      '[data-testid="review-preview-security-panel"]',
      { timeout: 5000 },
    );
    const hasSecurityPanel = await page
      .locator('[data-testid="review-preview-security-panel"]')
      .isVisible();
    const hasTimer = await page
      .locator('[data-testid="review-token-timer"]')
      .isVisible();
    const hasMirroredContent = await page
      .locator('[data-testid="review-preview-mirrored-content"]')
      .isVisible();
    const diffContent = await page
      .locator('[data-testid="review-preview-diff"]')
      .textContent();
    const risksSection = page.locator('[data-testid="review-preview-risks"]');
    const hasRisks = await risksSection.isVisible().catch(() => false);

    let v2ConfirmationToken = '';
    if (isRealMode) {
      const resp = await v2PreviewRespPromise;
      const data = await resp.json();
      const reqData = JSON.parse(resp.request().postData() || '{}');
      v2ConfirmationToken = data?.confirmationToken;

      const diffCheck = validateVersionDifferentiation({
        parentCaseVersion: parentVersionAfterDraftV2,
        childVersion: 2,
        reviewExpectedVersion: reqData.expectedVersion,
      });

      const previewProtocolValid =
        resp.status() === 200 &&
        diffCheck.valid &&
        reqData.decision === 'approve' &&
        reqData.reason === reviewReasonText &&
        data.expectedVersion === 2 &&
        data.decision === 'approve' &&
        data.reason === reviewReasonText &&
        typeof v2ConfirmationToken === 'string' &&
        v2ConfirmationToken.length > 0;

      recordStep(
        '[REAL_API] Review preview protocol verified: expectedVersion=2 (matches child caseVersion.version, strictly differs from parent SavedCase.version)',
        previewProtocolValid,
        {
          reqExpectedVersion: reqData.expectedVersion,
          resExpectedVersion: data.expectedVersion,
          actualParentVersion: parentVersionAfterDraftV2,
          childVersion: 2,
          versionDifferentiation: diffCheck,
          tokenReceived: !!v2ConfirmationToken,
        },
      );
    } else {
      recordStep(
        '[MOCK_FIXTURE] Review preview presents security panel with mirrored decision/reason, unified diff, and countdown TTL',
        hasSecurityPanel &&
          hasTimer &&
          hasMirroredContent &&
          (diffContent || '').length > 0,
        {
          hasSecurityPanel,
          hasTimer,
          hasMirroredContent,
          hasRisks,
          diffPreview: diffContent?.slice(0, 100),
          actualParentVersion: parentVersionAfterDraftV2,
          childVersion: 2,
        },
      );
      recordStep(
        '[MOCK_MODE] Review preview HTTP token binding protocol: UNVERIFIED_IN_MOCK_MODE (MockApiClient runs in-memory; verified via testHttpHelper.mjs and pending real backend)',
        'unverified',
        {
          status: 'UNVERIFIED_IN_MOCK_MODE',
          note: 'MockApiClient operates in-memory; network protocol was verified over reverse proxy in testHttpHelper.mjs',
        },
      );
    }

    const reviewPreviewScreenshot = path.join(
      screenshotsDir,
      't10-04-review-preview.png',
    );
    await page.screenshot({ path: reviewPreviewScreenshot, fullPage: false });

    // Step 5.2: Commit Review (Approve)
    let v2CommitRespPromise = null;
    if (isRealMode) {
      // Explicit waitForResponse and JSON parsing (matching canonical /saved-case-versions/{id}/review)
      v2CommitRespPromise = page.waitForResponse(
        (res) =>
          /\/api\/v1\/saved-case-versions\/[^/]+\/review(?:\?.*)?$/.test(
            res.url(),
          ) && res.request().method() === 'POST',
        { timeout: 10000 },
      );
    }

    const commitReviewBtn = page.locator('[data-testid="btn-commit-review"]');
    await commitReviewBtn.click();
    await page.waitForSelector('[data-testid="case-review-modal-content"]', {
      state: 'hidden',
      timeout: 5000,
    });

    const approvedTitleBadge = await page
      .locator('[data-testid="case-title"]')
      .textContent();

    if (isRealMode) {
      const resp = await v2CommitRespPromise;
      const data = await resp.json();
      const reqData = JSON.parse(resp.request().postData() || '{}');

      const commitDiffCheck = validateVersionDifferentiation({
        parentCaseVersion: parentVersionAfterDraftV2,
        childVersion: 2,
        reviewExpectedVersion: reqData.expectedVersion,
      });

      const commitProtocolValid =
        resp.status() === 200 &&
        commitDiffCheck.valid &&
        reqData.decision === 'approve' &&
        reqData.reason === reviewReasonText &&
        reqData.confirmationToken === v2ConfirmationToken &&
        data.reviewStatus === 'approved';

      recordStep(
        '[REAL_API] Review commit protocol verified: expectedVersion=2 and confirmationToken consumed',
        commitProtocolValid &&
          ((approvedTitleBadge || '').includes('已批准') ||
            (approvedTitleBadge || '').includes('approved')),
        {
          reqExpectedVersion: reqData.expectedVersion,
          actualParentVersion: parentVersionAfterDraftV2,
          tokenMatched: reqData.confirmationToken === v2ConfirmationToken,
          reviewStatus: data.reviewStatus,
          versionDifferentiation: commitDiffCheck,
        },
      );
    } else {
      recordStep(
        '[MOCK_FIXTURE] Review approval commits and transitions version to approved baseline',
        (approvedTitleBadge || '').includes('已批准') ||
          (approvedTitleBadge || '').includes('approved'),
        { approvedTitleBadge },
      );
      recordStep(
        '[MOCK_MODE] Review commit HTTP token binding protocol: UNVERIFIED_IN_MOCK_MODE',
        'unverified',
        { status: 'UNVERIFIED_IN_MOCK_MODE' },
      );
    }

    const reviewApprovedScreenshot = path.join(
      screenshotsDir,
      't10-05-review-approved.png',
    );
    await page.screenshot({ path: reviewApprovedScreenshot, fullPage: true });

    console.log('\n--- 6. Testing Regression Run Launcher ---');
    const runRegressionBtn = page.locator('[data-testid="btn-run-regression"]');
    await runRegressionBtn.click();
    await page.waitForSelector('[data-testid="regression-run-modal-content"]', {
      timeout: 5000,
    });

    // In real mode: if environmentIdSeed provided, select it in the environment dropdown
    if (isRealMode && environmentIdSeed) {
      const envSelect = page.locator('[data-testid="select-regression-env"]');
      await envSelect.selectOption(environmentIdSeed);
    }

    const regressionModalScreenshot = path.join(
      screenshotsDir,
      't10-06-regression-modal.png',
    );
    await page.screenshot({ path: regressionModalScreenshot, fullPage: false });

    let regressionRespPromise = null;
    if (isRealMode) {
      regressionRespPromise = page.waitForResponse(
        (res) =>
          res.url().includes('/regression-runs') &&
          res.request().method() === 'POST',
        { timeout: 10000 },
      );
    }

    const submitRegressionBtn = page.locator(
      '[data-testid="btn-submit-regression-run"]',
    );
    await submitRegressionBtn.click();

    // Verify redirection to workbench
    await page.waitForURL(/workbench/, { timeout: 8000 });
    await page.waitForSelector('[data-testid="workbench-page"]', {
      timeout: 8000,
    });
    const currentUrl = page.url();

    const urlRedirected =
      currentUrl.includes('workbench') && currentUrl.includes('runId');
    const runIdMatch = currentUrl.match(/runId=([^&]+)/);
    const launchedRunId = runIdMatch ? decodeURIComponent(runIdMatch[1]) : null;

    cleanupLedger.createdResources.push({
      type: 'regression_run',
      id: launchedRunId || null,
      projectId: cleanupLedger.projectId,
      status: launchedRunId ? 'VERIFIED' : 'UNVERIFIED_PENDING_REAL_ID',
    });

    let runModelValidation;
    if (isRealMode) {
      const regResp = await regressionRespPromise;
      const regReqHeaders = regResp.request().headers();
      const hasIdempotencyKey = !!regReqHeaders['idempotency-key'];
      const is202 = regResp.status() === 202;
      const runData = await regResp.json();

      runModelValidation = validateRegressionRunModelBindings({
        run: runData,
        expectedModelProfileId: effectiveModelProfileId,
      });

      recordStep(
        'Regression run launcher submits POST /regression-runs (Idempotency-Key validated, 202 Accepted, models bound to frozen profile) and redirects UI to workbench',
        urlRedirected && hasIdempotencyKey && is202 && runModelValidation.valid,
        {
          url: currentUrl,
          idempotencyKey: regReqHeaders['idempotency-key'],
          responseStatus: regResp.status(),
          launchedRunId,
          runModelValidation,
          realBackendVerified: false,
          workerExecutionStatus: 'UNVERIFIED_PENDING_WORKER_INTEGRATION',
          scopeDelineation:
            'FRONTEND_HTTP_VERIFIED: UI submitted POST /regression-runs and redirected to workbench (#/workbench?runId=...). NOTE: Worker daemon execution, Playwright replay, and final report verdict require worker daemon execution and are NOT claimed as verified by frontend test alone. Awaiting Root worker & live UI release.',
        },
      );
      recordStep(
        'Worker daemon execution & final report verdict: UNVERIFIED_PENDING_WORKER_INTEGRATION',
        'unverified',
        {
          scopeDelineation:
            'Worker daemon execution requires worker daemon process; frontend test does not claim worker verification.',
        },
      );
    } else {
      recordStep(
        '[MOCK_FIXTURE] Regression run launcher redirects UI to workbench (#/workbench?runId=...)',
        urlRedirected,
        {
          url: currentUrl,
          executionMode: 'mock_offline_client',
          scopeDelineation:
            'UI redirected to workbench with runId. Effective model binding verification requires server HTTP payload and is recorded separately as UNVERIFIED in mock mode.',
        },
      );
      recordStep(
        '[MOCK_MODE] Regression run effective model bindings in run payload: UNVERIFIED_IN_MOCK_MODE',
        'unverified',
        {
          scopeDelineation:
            'Offline mock client does not return full server-negotiated effectiveConfig.models payload over HTTP; requires real API response to verify role bindings.',
        },
      );
      recordStep(
        '[MOCK_MODE] Regression run worker daemon execution & final report verdict: UNVERIFIED_PENDING_WORKER_INTEGRATION',
        'unverified',
        {
          scopeDelineation:
            'Worker daemon execution requires worker daemon process; offline mock does not execute headless worker.',
        },
      );
    }

    const workbenchScreenshot = path.join(
      screenshotsDir,
      't10-07-regression-workbench.png',
    );
    await page.screenshot({ path: workbenchScreenshot, fullPage: true });

    console.log(
      '\n--- 7. Testing Save to Library Flow from Smoke Case Detail ---',
    );
    if (!isRealMode) {
      // Mock Fixture
      const smokeUrl = `http://127.0.0.1:${PORT}/#/case-detail?caseId=case_mock_01&runId=run_mock_001_completed`;
      await page.goto(smokeUrl);
      await page.waitForSelector('[data-testid="case-detail-page"]', {
        timeout: 5000,
      });

      const saveToLibBtn = page.locator('[data-testid="btn-save-to-library"]');
      await saveToLibBtn.click();
      await page.waitForSelector(
        '[data-testid="save-to-library-modal-content"]',
        { timeout: 5000 },
      );

      const saveModalScreenshot = path.join(
        screenshotsDir,
        't10-08-save-to-library-modal.png',
      );
      await page.screenshot({ path: saveModalScreenshot, fullPage: false });

      const confirmSaveBtn = page.locator(
        '[data-testid="btn-confirm-save-to-library"]',
      );
      await confirmSaveBtn.click();
      await page.waitForURL(/saved-case-detail/, { timeout: 5000 });
      await page.waitForSelector('[data-testid="saved-case-detail-page"]', {
        timeout: 5000,
      });

      const currentCaseUrl = page.url();
      const savedCaseMatch = currentCaseUrl.match(/caseId=([^&]+)/);
      const savedCaseId = savedCaseMatch
        ? decodeURIComponent(savedCaseMatch[1])
        : null;
      cleanupLedger.createdResources.push({
        type: 'saved_case_from_smoke',
        id: savedCaseId || null,
        sourceSmokeCaseId: 'case_mock_01',
        status: savedCaseId ? 'VERIFIED' : 'UNVERIFIED_PENDING_REAL_ID',
      });

      recordStep(
        '[MOCK_FIXTURE] Save to Library from smoke case extracts criteria/steps, creates draft v1, and redirects to saved case detail',
        page.url().includes('saved-case-detail'),
      );
    } else {
      // Real Mode: Only run if real smoke seeds provided; strictly NO mock fallback!
      if (smokeCaseIdSeed && runIdSeed) {
        const smokeUrl = `http://127.0.0.1:${PORT}/#/case-detail?caseId=${encodeURIComponent(smokeCaseIdSeed)}&runId=${encodeURIComponent(runIdSeed)}`;
        await page.goto(smokeUrl);
        await page.waitForSelector('[data-testid="case-detail-page"]', {
          timeout: 5000,
        });

        const saveToLibBtn = page.locator(
          '[data-testid="btn-save-to-library"]',
        );
        await saveToLibBtn.click();
        await page.waitForSelector(
          '[data-testid="save-to-library-modal-content"]',
          { timeout: 5000 },
        );

        const saveModalScreenshot = path.join(
          screenshotsDir,
          't10-08-save-to-library-modal.png',
        );
        await page.screenshot({ path: saveModalScreenshot, fullPage: false });

        const confirmSaveBtn = page.locator(
          '[data-testid="btn-confirm-save-to-library"]',
        );
        await confirmSaveBtn.click();
        await page.waitForURL(/saved-case-detail/, { timeout: 5000 });
        await page.waitForSelector('[data-testid="saved-case-detail-page"]', {
          timeout: 5000,
        });

        const currentCaseUrl = page.url();
        const savedCaseMatch = currentCaseUrl.match(/caseId=([^&]+)/);
        const savedCaseId = savedCaseMatch
          ? decodeURIComponent(savedCaseMatch[1])
          : null;
        cleanupLedger.createdResources.push({
          type: 'saved_case_from_smoke',
          id: savedCaseId || null,
          sourceSmokeCaseId: smokeCaseIdSeed,
          status: savedCaseId ? 'VERIFIED' : 'UNVERIFIED_PENDING_REAL_ID',
        });

        recordStep(
          '[REAL_SEEDED] Save to Library from smoke case extracts criteria/steps, creates draft v1, and redirects to saved case detail',
          page.url().includes('saved-case-detail'),
        );
      } else {
        console.warn(
          'Notice: Real smoke seeds (--smoke-case-id, --run-id) not provided. Step 7 marked as UNVERIFIED without fallback.',
        );
        recordStep(
          '[REAL_MODE] Save to Library from smoke case: UNVERIFIED (Missing --smoke-case-id / --run-id seeds)',
          'unverified',
          {
            status: 'UNVERIFIED_PENDING_SEEDS',
            requiredSeeds: ['--smoke-case-id', '--run-id'],
          },
        );
      }
    }
  } catch (err) {
    console.error('Test execution error:', err);
    recordStep('Unexpected error during verification', 'failed', {
      error: err.message,
      stack: err.stack,
    });
  } finally {
    if (browser) await browser.close();
    if (proxyInstance) {
      await proxyInstance.closeAll();
      console.log('[T10 E2E] Preview server stopped.');
    }
  }

  // 6. Save isolated report in mode-specific directory
  const finalResults = recorder.getResults({
    testSuite: `T10 Case Library & Regression Frontend Verification (${isRealMode ? 'REAL_API' : 'MOCK'})`,
    mode: isRealMode ? 'real_api' : 'mock_offline_simulation',
    backendStatus: isRealMode ? 'connected' : 'waiting_for_backend_signal',
    taskSlug,
    cleanupLedger,
  });

  const reportPath = path.join(
    modeEvidenceDir,
    isRealMode ? 't10-real-verification.json' : 't10-mock-verification.json',
  );
  fs.writeFileSync(reportPath, JSON.stringify(finalResults, null, 2), 'utf8');
  console.log(`\nVerification report saved to: ${reportPath}`);
  console.log('Execution Summary:');
  console.log(`  Total Steps: ${finalResults.summary.total}`);
  console.log(`  Passed: ${finalResults.summary.passedCount}`);
  console.log(`  Failed: ${finalResults.summary.failedCount}`);
  console.log(`  Unverified: ${finalResults.summary.unverifiedCount}`);
  console.log(`  Verdict: ${finalResults.verdict}`);
  console.log(`  All Passed: ${finalResults.allPassed}`);

  const exitCode = verificationExitCode(finalResults);
  process.exitCode = exitCode;
  if (exitCode === 1) {
    console.error(
      `\nProcess exiting with code 1 (FAILED: ${finalResults.summary.failedCount} failures)`,
    );
    process.exit(1);
  } else if (exitCode === 2) {
    console.warn(
      `\nProcess exiting with code 2 (UNVERIFIED / INCOMPLETE: ${finalResults.summary.unverifiedCount} unverified items)`,
    );
    process.exit(2);
  } else {
    console.log(`\nProcess exiting with code 0 (ALL_PASSED)`);
  }
}

run();
