/**
 * Offline Browserless Test Suite for T10-MODULES Regression Modules Increment.
 *
 * Verifies:
 * 1. Contract schema conformance & boundary rejection for all 6 new DTOs:
 *    - RegressionModuleCreate, RegressionModuleRecord, RegressionModuleRecordPage,
 *      RegressionModuleReviewCommit, RegressionModuleReviewPreview, RegressionModuleReviewPreviewInput.
 * 2. Generated client (HttpApiClient) path encoding, PG integer version bounds (1..2147483647),
 *    and injected target response verification (mismatched project/module/version rejected).
 * 3. Role & Permission helper invariants (owner / operator / viewer separation, preview validation, draft non-execution).
 * 4. MockApiClient public method flows:
 *    - Project ID normalization and unknown project rejection.
 *    - Synthetic document registration, authentic SHA-256 (hashPayload equivalence), draft status.
 *    - Stage 1 preview generation, token issuance, 300s TTL.
 *    - Stage 2 review commit, status transition to approved, single-use token consumption.
 *    - Missing crypto / digest fail-closed protection.
 * 5. Static SSR rendering for ModulesPage, ModuleRegisterModal, and ModuleReviewModal with role assertions.
 *
 * Zero browser execution, zero networking, Ego paused, P0Passed: false.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  parseContract,
  validateContract,
  publicOperationIds,
} from '@localqa/contracts';
import { hashPayload } from '../../../packages/storage/dist/crypto.js';
import { MockApiClient } from '../src/mocks/mockClient.ts';
import {
  MOCK_PROJECT_ID,
  LEGACY_MOCK_PROJECT_ID,
  MOCK_ADMIN_USER_UUID,
} from '../src/mocks/data.ts';
import { HttpApiClient } from '../src/api/client.ts';
import {
  getModuleRolePermissions,
  validateModuleReviewPreview,
  isModuleApproved,
  assertValidModuleVersion,
} from '../src/utils/moduleRoles.ts';
import {
  mergeModuleRecords,
  resolveLatestModuleVersion,
  fetchModulePage,
  fetchModuleVersionPage,
  RequestScopeGuard,
} from '../src/utils/modulePagination.ts';

console.log('================================================================');
console.log(' T10-MODULES Offline Contract, Boundary, Mock & SSR Verification');
console.log(
  '================================================================\n',
);

let totalTests = 0;
let passedTests = 0;

function check(desc, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ [PASS] ${desc}`);
  } catch (err) {
    console.error(`  ✗ [FAIL] ${desc}: ${err.message}`);
    throw err;
  }
}

async function checkAsync(desc, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ [PASS] ${desc}`);
  } catch (err) {
    console.error(`  ✗ [FAIL] ${desc}: ${err.message}`);
    throw err;
  }
}

const CANONICAL_PROJECT_ID = MOCK_PROJECT_ID;
const SAMPLE_DOC = {
  schemaVersion: 1,
  kind: 'localqa/test',
  id: 'auth_helper',
  name: '基础登录与鉴权模块',
  variables: {},
  criteria: [
    {
      id: 'crit-auth-01',
      kind: 'element_visible',
      description: '登录输入表单存在且可见',
      sourceKind: 'saved_case',
      sourceRef: 'auth_helper',
      locator: { by: 'css', value: '#login-form' },
    },
  ],
  steps: [
    { kind: 'navigate', url: 'http://localhost:8080/login.html' },
    { kind: 'assert', criterionId: 'crit-auth-01' },
  ],
  fixtureRefs: [],
};

// ---------------------------------------------------------------------------
// Suite 1: OpenAPI Schema & Contract Conformance for 6 DTOs & 5 Operations
// ---------------------------------------------------------------------------
console.log(
  '--- Suite 1: Contract Conformance & Operation Mapping (80 public ops) ---',
);

check('OpenAPI public operations includes all 5 module operations', () => {
  const expectedOps = [
    'createRegressionModule',
    'listRegressionModules',
    'listRegressionModuleVersions',
    'previewRegressionModuleReview',
    'reviewRegressionModuleVersion',
  ];
  for (const op of expectedOps) {
    assert.ok(
      publicOperationIds.includes(op),
      `contracts must include operation ${op}`,
    );
  }
  assert.equal(
    publicOperationIds.length,
    80,
    'Must have exactly 80 public operations',
  );
});

check(
  'RegressionModuleCreate schema validation & name regex boundaries',
  () => {
    // Valid payload
    const valid = {
      name: 'auth/login-helper',
      document: SAMPLE_DOC,
    };
    assert.equal(
      validateContract('RegressionModuleCreate', valid).success,
      true,
    );
    assert.deepEqual(
      parseContract('RegressionModuleCreate', valid).name,
      'auth/login-helper',
    );

    // Invalid module names
    const invalidNames = [
      '', // empty
      '../escape', // path traversal
      './relative', // dot relative
      '/leading-slash', // leading slash
      'trailing-slash/', // trailing slash
      'has space', // whitespace
      'double//slash', // consecutive slashes
      'special@char', // disallowed character
    ];

    for (const badName of invalidNames) {
      const invalid = {
        name: badName,
        document: SAMPLE_DOC,
      };
      assert.equal(
        validateContract('RegressionModuleCreate', invalid).success,
        false,
        `RegressionModuleCreate should reject invalid name: "${badName}"`,
      );
    }

    // Invalid document (missing schemaVersion / criteria / steps)
    assert.equal(
      validateContract('RegressionModuleCreate', {
        name: 'valid-name',
        document: { invalid: true },
      }).success,
      false,
      'RegressionModuleCreate should reject non-conforming RegressionDocument',
    );
  },
);

check(
  'RegressionModuleRecord schema validation (nullable audit fields)',
  () => {
    const validRecord = {
      projectId: CANONICAL_PROJECT_ID,
      name: 'auth/login-helper',
      version: 1,
      sha256: 'a'.repeat(64),
      document: SAMPLE_DOC,
      reviewStatus: 'draft',
      createdBy: CANONICAL_PROJECT_ID,
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
    };
    assert.equal(
      validateContract('RegressionModuleRecord', validRecord).success,
      true,
    );

    // Review status enum boundary
    const badStatus = { ...validRecord, reviewStatus: 'unknown' };
    assert.equal(
      validateContract('RegressionModuleRecord', badStatus).success,
      false,
    );

    // Non-64-hex SHA
    const badSha = { ...validRecord, sha256: 'short-sha' };
    assert.equal(
      validateContract('RegressionModuleRecord', badSha).success,
      false,
    );
  },
);

check('RegressionModuleRecordPage schema validation', () => {
  const validPage = {
    items: [
      {
        projectId: CANONICAL_PROJECT_ID,
        name: 'auth/login-helper',
        version: 1,
        sha256: 'b'.repeat(64),
        document: SAMPLE_DOC,
        reviewStatus: 'approved',
        createdBy: null,
        createdAt: null,
        reviewedBy: CANONICAL_PROJECT_ID,
        reviewedAt: new Date().toISOString(),
      },
    ],
    nextCursor: null,
  };
  assert.equal(
    validateContract('RegressionModuleRecordPage', validPage).success,
    true,
  );
});

check('RegressionModuleReviewPreviewInput schema validation', () => {
  const validInput = {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'Verified against specification',
  };
  assert.equal(
    validateContract('RegressionModuleReviewPreviewInput', validInput).success,
    true,
  );

  // Decision must be 'approve' or 'reject'
  assert.equal(
    validateContract('RegressionModuleReviewPreviewInput', {
      ...validInput,
      decision: 'invalid-decision',
    }).success,
    false,
  );

  // Expected version must be >= 1
  assert.equal(
    validateContract('RegressionModuleReviewPreviewInput', {
      ...validInput,
      expectedVersion: 0,
    }).success,
    false,
  );

  // Empty reason rejected
  assert.equal(
    validateContract('RegressionModuleReviewPreviewInput', {
      ...validInput,
      reason: '',
    }).success,
    false,
  );
});

check('RegressionModuleReviewPreview schema validation', () => {
  const validPreview = {
    projectId: CANONICAL_PROJECT_ID,
    moduleName: 'auth/login-helper',
    version: 1,
    documentSha256: 'c'.repeat(64),
    expectedVersion: 1,
    decision: 'approve',
    reason: 'Verified by reviewer',
    diff: '+ criteria: 1\n+ steps: 2',
    risks: ['Affects downstream login test flows'],
    confirmationToken: 'd'.repeat(64),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  };
  assert.equal(
    validateContract('RegressionModuleReviewPreview', validPreview).success,
    true,
  );

  // Mismatched or non-hex token
  assert.equal(
    validateContract('RegressionModuleReviewPreview', {
      ...validPreview,
      documentSha256: 'not-hex',
    }).success,
    false,
  );
});

check('RegressionModuleReviewCommit schema validation', () => {
  const validCommit = {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'LGTM',
    confirmationToken: 'e'.repeat(64),
  };
  assert.equal(
    validateContract('RegressionModuleReviewCommit', validCommit).success,
    true,
  );

  // Missing token
  assert.equal(
    validateContract('RegressionModuleReviewCommit', {
      expectedVersion: 1,
      decision: 'approve',
      reason: 'LGTM',
    }).success,
    false,
  );
});

// ---------------------------------------------------------------------------
// Suite 2: Version Range Bounds & Generated Client Response Invariant Verification
// ---------------------------------------------------------------------------
console.log(
  '--- Suite 2: Version Range Bounds & Response Invariant Verification ---',
);

check(
  'assertValidModuleVersion enforces positive integer within Postgres bounds (1..2147483647)',
  () => {
    // Valid bounds
    assert.equal(assertValidModuleVersion(1), 1);
    assert.equal(assertValidModuleVersion(42), 42);
    assert.equal(assertValidModuleVersion(2147483647), 2147483647);
    assert.equal(assertValidModuleVersion('10'), 10);

    // Invalid values
    const invalidVersions = [
      0,
      -1,
      -999,
      1.5,
      NaN,
      'abc',
      2147483648,
      null,
      undefined,
    ];
    for (const inv of invalidVersions) {
      assert.throws(
        () => assertValidModuleVersion(inv),
        /Invalid module version/,
        `Should throw on invalid version: ${inv}`,
      );
    }
  },
);

await checkAsync(
  'HttpApiClient validates version bounds before sending requests',
  async () => {
    const client = new HttpApiClient('http://localhost:9999/api/v1');

    await assert.rejects(
      () =>
        client.previewRegressionModuleReview(
          CANONICAL_PROJECT_ID,
          'test/mod',
          0,
          {
            expectedVersion: 0,
            decision: 'approve',
            reason: 'test',
          },
        ),
      /Invalid module version/,
    );

    await assert.rejects(
      () =>
        client.reviewRegressionModuleVersion(
          CANONICAL_PROJECT_ID,
          'test/mod',
          2147483648,
          {
            expectedVersion: 1,
            decision: 'approve',
            reason: 'test',
            confirmationToken: 'token',
          },
        ),
      /Invalid module version/,
    );
  },
);

await checkAsync(
  'HttpApiClient rejects preview response if target identifiers mismatch',
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            projectId: CANONICAL_PROJECT_ID,
            moduleName: 'wrong/module-name',
            version: 1,
            documentSha256: 'a'.repeat(64),
            expectedVersion: 1,
            decision: 'approve',
            reason: 'test',
            diff: 'diff',
            risks: [],
            confirmationToken: 'tok123',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );

      const client = new HttpApiClient('http://localhost:9999/api/v1');
      await assert.rejects(
        () =>
          client.previewRegressionModuleReview(
            CANONICAL_PROJECT_ID,
            'expected/module-name',
            1,
            {
              expectedVersion: 1,
              decision: 'approve',
              reason: 'test',
            },
          ),
        /Preview response target mismatch/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

await checkAsync(
  'HttpApiClient rejects review commit response if target module or version mismatch',
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            projectId: CANONICAL_PROJECT_ID,
            name: 'target/module',
            version: 99, // Mismatched version
            sha256: 'a'.repeat(64),
            document: SAMPLE_DOC,
            reviewStatus: 'approved',
            createdBy: null,
            createdAt: null,
            reviewedBy: CANONICAL_PROJECT_ID,
            reviewedAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );

      const client = new HttpApiClient('http://localhost:9999/api/v1');
      await assert.rejects(
        () =>
          client.reviewRegressionModuleVersion(
            CANONICAL_PROJECT_ID,
            'target/module',
            1, // requested v1, response gave v99
            {
              expectedVersion: 1,
              decision: 'approve',
              reason: 'test',
              confirmationToken: 'tok123',
            },
          ),
        /Reviewed module mismatch/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

await checkAsync(
  'HttpApiClient accepts canonical lowercase UUID response when requested with uppercase UUID',
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            projectId: CANONICAL_PROJECT_ID.toLowerCase(),
            moduleName: 'test/mod',
            version: 1,
            documentSha256: 'a'.repeat(64),
            expectedVersion: 1,
            decision: 'approve',
            reason: 'test',
            diff: 'diff',
            risks: [],
            confirmationToken: 'tok123',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );

      const client = new HttpApiClient('http://localhost:9999/api/v1');
      const preview = await client.previewRegressionModuleReview(
        CANONICAL_PROJECT_ID.toUpperCase(),
        'test/mod',
        1,
        {
          expectedVersion: 1,
          decision: 'approve',
          reason: 'test',
        },
      );
      assert.equal(preview.projectId, CANONICAL_PROJECT_ID.toLowerCase());
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

await checkAsync(
  'HttpApiClient rejects injected preview response if reason is whitespace-padded or criteria mismatch',
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            projectId: CANONICAL_PROJECT_ID,
            moduleName: 'test/mod',
            version: 1,
            documentSha256: 'a'.repeat(64),
            expectedVersion: 1,
            decision: 'approve',
            reason: ' ' + 'exact reason' + ' ',
            diff: 'diff',
            risks: [],
            confirmationToken: 'tok123',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );

      const client = new HttpApiClient('http://localhost:9999/api/v1');
      await assert.rejects(
        () =>
          client.previewRegressionModuleReview(
            CANONICAL_PROJECT_ID,
            'test/mod',
            1,
            {
              expectedVersion: 1,
              decision: 'approve',
              reason: 'exact reason',
            },
          ),
        /Preview response review criteria mismatch/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

// ---------------------------------------------------------------------------
// Suite 3: Role & Permission Helper Tests
// ---------------------------------------------------------------------------
console.log('--- Suite 3: Role & Permission Helper Invariants ---');

check('getModuleRolePermissions isolates owner / operator / viewer', () => {
  // Owner: can register and review
  const owner = getModuleRolePermissions('owner');
  assert.equal(owner.canRegister, true);
  assert.equal(owner.canReview, true);
  assert.equal(owner.isReadOnly, false);

  // Global admin: treated as owner
  const admin = getModuleRolePermissions('viewer', 'admin');
  assert.equal(admin.canRegister, true);
  assert.equal(admin.canReview, true);
  assert.equal(admin.isReadOnly, false);

  // Operator: can register, CANNOT review
  const operator = getModuleRolePermissions('operator');
  assert.equal(operator.canRegister, true);
  assert.equal(operator.canReview, false);
  assert.equal(operator.isReadOnly, false);

  // Viewer: strictly read-only
  const viewer = getModuleRolePermissions('viewer');
  assert.equal(viewer.canRegister, false);
  assert.equal(viewer.canReview, false);
  assert.equal(viewer.isReadOnly, true);

  // Unknown role: defaults to viewer read-only
  const unknown = getModuleRolePermissions(null);
  assert.equal(unknown.canRegister, false);
  assert.equal(unknown.canReview, false);
  assert.equal(unknown.isReadOnly, true);
});

check(
  'validateModuleReviewPreview enforces all 7 target invariants and expiry',
  () => {
    const target = {
      projectId: CANONICAL_PROJECT_ID,
      moduleName: 'auth/login-helper',
      version: 1,
      documentSha256: 'f'.repeat(64),
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Verified',
    };

    const validPreview = {
      projectId: CANONICAL_PROJECT_ID,
      moduleName: 'auth/login-helper',
      version: 1,
      documentSha256: 'f'.repeat(64),
      expectedVersion: 1,
      decision: 'approve',
      reason: 'Verified',
      diff: '+ test',
      risks: [],
      confirmationToken: 'tok1',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };

    // Valid preview matches
    const res1 = validateModuleReviewPreview(validPreview, target);
    assert.equal(res1.valid, true);
    assert.equal(res1.issues.length, 0);

    // Expired preview
    const expiredPreview = {
      ...validPreview,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const resExpired = validateModuleReviewPreview(expiredPreview, target);
    assert.equal(resExpired.valid, false);
    assert.ok(resExpired.issues.some((i) => i.includes('过期')));

    // Modified reason after preview generation
    const resChangedReason = validateModuleReviewPreview(validPreview, {
      ...target,
      reason: 'Changed reason after preview',
    });
    assert.equal(resChangedReason.valid, false);
    assert.ok(resChangedReason.issues.some((i) => i.includes('理由已变更')));

    // Whitespace-padded reason counterexample (T10-module-preview-reason-controller.json)
    const resPaddedReason = validateModuleReviewPreview(
      { ...validPreview, reason: ' ' + target.reason + ' ' },
      target,
    );
    assert.equal(
      resPaddedReason.valid,
      false,
      'Preview validation must reject whitespace-padded reason without implicit trim',
    );
    assert.ok(resPaddedReason.issues.some((i) => i.includes('理由已变更')));

    // Case-insensitive UUID match in preview validation (lowercase response for uppercase target)
    const resCaseInsensitive = validateModuleReviewPreview(validPreview, {
      ...target,
      projectId: target.projectId.toUpperCase(),
    });
    assert.equal(
      resCaseInsensitive.valid,
      true,
      'Preview validation must accept canonical lowercase UUID for uppercase target',
    );
  },
);

check(
  'isModuleApproved disallows drafts or rejected modules from playback execution',
  () => {
    assert.equal(isModuleApproved({ reviewStatus: 'approved' }), true);
    assert.equal(isModuleApproved({ reviewStatus: 'draft' }), false);
    assert.equal(isModuleApproved({ reviewStatus: 'rejected' }), false);
    assert.equal(isModuleApproved(null), false);
    assert.equal(isModuleApproved(undefined), false);
  },
);

// ---------------------------------------------------------------------------
// Suite 3b: Module Pagination & Version Resolution Helpers
// ---------------------------------------------------------------------------
console.log(
  '--- Suite 3b: Module Pagination & Version Resolution Invariants ---',
);

await checkAsync(
  'fetchModulePage and mergeModuleRecords paginate and combine multiple pages without duplication',
  async () => {
    const mockApi = {
      listRegressionModules: async (projId, query) => {
        if (!query?.cursor) {
          return {
            items: [
              {
                projectId: projId,
                name: 'mod-a',
                version: 2,
                sha256: 'a'.repeat(64),
                document: SAMPLE_DOC,
                reviewStatus: 'approved',
                createdBy: null,
                createdAt: null,
                reviewedBy: null,
                reviewedAt: null,
              },
              {
                projectId: projId,
                name: 'mod-a',
                version: 1,
                sha256: 'b'.repeat(64),
                document: SAMPLE_DOC,
                reviewStatus: 'approved',
                createdBy: null,
                createdAt: null,
                reviewedBy: null,
                reviewedAt: null,
              },
            ],
            nextCursor: 'cursor_page_2',
          };
        }
        return {
          items: [
            {
              projectId: projId,
              name: 'mod-b',
              version: 1,
              sha256: 'c'.repeat(64),
              document: SAMPLE_DOC,
              reviewStatus: 'draft',
              createdBy: null,
              createdAt: null,
              reviewedBy: null,
              reviewedAt: null,
            },
          ],
          nextCursor: null,
        };
      },
    };

    const page1 = await fetchModulePage(mockApi, CANONICAL_PROJECT_ID, {
      limit: 2,
    });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.nextCursor, 'cursor_page_2');

    const page2 = await fetchModulePage(mockApi, CANONICAL_PROJECT_ID, {
      cursor: page1.nextCursor,
      limit: 2,
    });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextCursor, null);

    const combined = mergeModuleRecords(page1.items, page2.items);
    assert.equal(combined.length, 3);

    // Re-merging page 1 does not introduce duplicate keys
    const reMerged = mergeModuleRecords(combined, page1.items);
    assert.equal(reMerged.length, 3);
  },
);

check(
  'resolveLatestModuleVersion accurately targets maximum version when clicked from old version row',
  () => {
    const docV1 = { ...SAMPLE_DOC, name: 'Doc v1' };
    const docV2 = { ...SAMPLE_DOC, name: 'Doc v2' };
    const docV3 = { ...SAMPLE_DOC, name: 'Doc v3' };

    const modV1 = {
      projectId: CANONICAL_PROJECT_ID,
      name: 'auth_helper',
      version: 1,
      sha256: '1'.repeat(64),
      document: docV1,
      reviewStatus: 'approved',
      createdBy: null,
      createdAt: null,
      reviewedBy: null,
      reviewedAt: null,
    };

    const modV2 = {
      ...modV1,
      version: 2,
      document: docV2,
    };

    const modV3 = {
      ...modV1,
      version: 3,
      document: docV3,
    };

    // User clicked on old version v1 row, but v2 is in loaded modules
    const resolvedFromModules = resolveLatestModuleVersion(modV1, [
      modV2,
      modV1,
    ]);
    assert.equal(
      resolvedFromModules.latestVersion,
      2,
      'Must resolve to true highest version v2',
    );
    assert.deepEqual(
      resolvedFromModules.latestDocument,
      docV2,
      'Must resolve to v2 document',
    );

    // User clicked on v1, and history contains v3
    const resolvedWithHistory = resolveLatestModuleVersion(
      modV1,
      [modV2, modV1],
      [modV3],
    );
    assert.equal(
      resolvedWithHistory.latestVersion,
      3,
      'Must resolve to history highest version v3',
    );
    assert.deepEqual(
      resolvedWithHistory.latestDocument,
      docV3,
      'Must resolve to v3 document',
    );
  },
);

check(
  'resolveLatestModuleVersion ignores candidates from another project',
  () => {
    const FOREIGN_PROJECT_ID = '11111111-2222-3333-4444-555555555555';
    const docProjAv1 = { ...SAMPLE_DOC, name: 'ProjA Doc v1' };
    const docProjAv2 = { ...SAMPLE_DOC, name: 'ProjA Doc v2' };
    const docProjBv99 = { ...SAMPLE_DOC, name: 'ProjB Doc v99' };

    const targetA_v1 = {
      projectId: CANONICAL_PROJECT_ID,
      name: 'auth_helper',
      version: 1,
      sha256: '1'.repeat(64),
      document: docProjAv1,
      reviewStatus: 'approved',
      createdBy: null,
      createdAt: null,
      reviewedBy: null,
      reviewedAt: null,
    };

    const candidateA_v2 = {
      ...targetA_v1,
      version: 2,
      document: docProjAv2,
    };

    const candidateB_v99 = {
      ...targetA_v1,
      projectId: FOREIGN_PROJECT_ID,
      version: 99,
      document: docProjBv99,
    };

    // Known modules & history contain both foreign Project B v99 and local Project A v2
    const resolved = resolveLatestModuleVersion(
      targetA_v1,
      [candidateB_v99, candidateA_v2],
      [candidateB_v99],
    );
    assert.equal(
      resolved.latestVersion,
      2,
      'Must ignore Project B version 99 and resolve to Project A version 2',
    );
    assert.deepEqual(
      resolved.latestDocument,
      docProjAv2,
      'Must resolve to Project A v2 document',
    );

    // Case-insensitive UUID match (e.g. uppercase target with lowercase candidate of the same project)
    const targetUpper = {
      ...targetA_v1,
      projectId: CANONICAL_PROJECT_ID.toUpperCase(),
    };
    const resolvedCase = resolveLatestModuleVersion(targetUpper, [
      candidateB_v99,
      candidateA_v2,
    ]);
    assert.equal(
      resolvedCase.latestVersion,
      2,
      'Must match project ID case-insensitively for UUIDs',
    );
  },
);

await checkAsync(
  'fetchModulePage rejects responses containing items from foreign project',
  async () => {
    const FOREIGN_PROJECT_ID = '11111111-2222-3333-4444-555555555555';
    const foreignApi = {
      listRegressionModules: async () => ({
        items: [
          {
            projectId: FOREIGN_PROJECT_ID,
            name: 'foreign-mod',
            version: 1,
            sha256: 'a'.repeat(64),
            document: SAMPLE_DOC,
            reviewStatus: 'draft',
            createdBy: null,
            createdAt: null,
            reviewedBy: null,
            reviewedAt: null,
          },
        ],
        nextCursor: null,
      }),
    };

    await assert.rejects(
      () => fetchModulePage(foreignApi, CANONICAL_PROJECT_ID),
      /mismatched project/,
    );

    // Case-insensitive UUID matching succeeds
    const caseApi = {
      listRegressionModules: async () => ({
        items: [
          {
            projectId: CANONICAL_PROJECT_ID.toLowerCase(),
            name: 'case-mod',
            version: 1,
            sha256: 'a'.repeat(64),
            document: SAMPLE_DOC,
            reviewStatus: 'approved',
            createdBy: null,
            createdAt: null,
            reviewedBy: null,
            reviewedAt: null,
          },
        ],
        nextCursor: null,
      }),
    };
    const validCasePage = await fetchModulePage(
      caseApi,
      CANONICAL_PROJECT_ID.toUpperCase(),
    );
    assert.equal(validCasePage.items.length, 1);
  },
);

await checkAsync(
  'fetchModuleVersionPage rejects responses containing foreign project or module items',
  async () => {
    const FOREIGN_PROJECT_ID = '11111111-2222-3333-4444-555555555555';
    const mismatchedProjApi = {
      listRegressionModuleVersions: async () => ({
        items: [
          {
            projectId: FOREIGN_PROJECT_ID,
            name: 'target_module',
            version: 1,
            sha256: 'a'.repeat(64),
            document: SAMPLE_DOC,
            reviewStatus: 'draft',
            createdBy: null,
            createdAt: null,
            reviewedBy: null,
            reviewedAt: null,
          },
        ],
        nextCursor: null,
      }),
    };

    await assert.rejects(
      () =>
        fetchModuleVersionPage(
          mismatchedProjApi,
          CANONICAL_PROJECT_ID,
          'target_module',
        ),
      /mismatched project/,
    );

    const mismatchedModApi = {
      listRegressionModuleVersions: async () => ({
        items: [
          {
            projectId: CANONICAL_PROJECT_ID,
            name: 'wrong_module',
            version: 1,
            sha256: 'a'.repeat(64),
            document: SAMPLE_DOC,
            reviewStatus: 'draft',
            createdBy: null,
            createdAt: null,
            reviewedBy: null,
            reviewedAt: null,
          },
        ],
        nextCursor: null,
      }),
    };

    await assert.rejects(
      () =>
        fetchModuleVersionPage(
          mismatchedModApi,
          CANONICAL_PROJECT_ID,
          'target_module',
        ),
      /mismatched module/,
    );
  },
);

check(
  'mergeModuleRecords isolates records by project identity and prevents cross-project collision',
  () => {
    const FOREIGN_PROJECT_ID = '11111111-2222-3333-4444-555555555555';
    const recordProjA = {
      projectId: CANONICAL_PROJECT_ID,
      name: 'auth_helper',
      version: 1,
      sha256: 'a'.repeat(64),
      document: SAMPLE_DOC,
      reviewStatus: 'approved',
      createdBy: null,
      createdAt: null,
      reviewedBy: null,
      reviewedAt: null,
    };

    const recordProjB = {
      projectId: FOREIGN_PROJECT_ID,
      name: 'auth_helper',
      version: 1,
      sha256: 'b'.repeat(64),
      document: SAMPLE_DOC,
      reviewStatus: 'approved',
      createdBy: null,
      createdAt: null,
      reviewedBy: null,
      reviewedAt: null,
    };

    const merged = mergeModuleRecords([recordProjA], [recordProjB]);
    assert.equal(
      merged.length,
      2,
      'Both projects must retain their respective modules even with identical name and version',
    );
    assert.equal(merged[0].projectId, CANONICAL_PROJECT_ID);
    assert.equal(merged[1].projectId, FOREIGN_PROJECT_ID);

    // Upper/lower case UUID variations of the same record are deduplicated
    const recordProjAUpper = {
      ...recordProjA,
      projectId: CANONICAL_PROJECT_ID.toUpperCase(),
    };
    const reMerged = mergeModuleRecords(merged, [recordProjAUpper]);
    assert.equal(
      reMerged.length,
      2,
      'Uppercase UUID duplicate must be deduplicated',
    );
  },
);

await checkAsync(
  'RequestScopeGuard simulates 2 delayed responses and prevents Project A from overwriting Project B',
  async () => {
    const guard = new RequestScopeGuard();
    const PROJ_A = CANONICAL_PROJECT_ID;
    const PROJ_B = '22222222-3333-4444-5555-666666666666';

    let committedProject = null;
    let committedModules = null;
    let activeLoading = false;

    async function simulateLoadModules(projectId, delayMs, payload) {
      const scopeHandle = guard.startRequest({ projectId });
      activeLoading = true;
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        if (!scopeHandle.isValid()) {
          return; // Stale delayed response discarded
        }
        committedProject = projectId;
        committedModules = payload;
      } finally {
        if (scopeHandle.isValid()) {
          activeLoading = false;
        }
      }
    }

    // 1. User starts loading Project A (slow, 60ms delay)
    const promiseA = simulateLoadModules(PROJ_A, 60, [
      { name: 'proj-a-module' },
    ]);

    // 2. User quickly switches to Project B after 10ms (fast, 20ms delay)
    await new Promise((r) => setTimeout(r, 10));
    const promiseB = simulateLoadModules(PROJ_B, 20, [
      { name: 'proj-b-module' },
    ]);

    // Wait for both asynchronous tasks to finish
    await Promise.all([promiseA, promiseB]);

    // Project B should have won and Project A should NOT overwrite Project B
    assert.equal(
      committedProject,
      PROJ_B,
      'Committed project must remain Project B',
    );
    assert.deepEqual(
      committedModules,
      [{ name: 'proj-b-module' }],
      'Committed modules must belong to Project B',
    );
    assert.equal(
      activeLoading,
      false,
      'Loading flag properly cleared by the valid request',
    );

    // Test resetScope invalidates in-flight requests
    const resetHandle = guard.startRequest({ projectId: PROJ_B });
    assert.equal(resetHandle.isValid(), true);
    guard.resetScope(null);
    assert.equal(
      resetHandle.isValid(),
      false,
      'resetScope must invalidate pending requests',
    );
  },
);

// ---------------------------------------------------------------------------
// Suite 4: MockApiClient Public Method Flows & Two-Stage Review Lifecycle
// ---------------------------------------------------------------------------
console.log('--- Suite 4: MockApiClient Two-Stage Review & Public Flows ---');

await checkAsync(
  'MockApiClient lists initial synthetic regression modules',
  async () => {
    const mockClient = new MockApiClient();
    const list = await mockClient.listRegressionModules(CANONICAL_PROJECT_ID);
    assert.ok(
      list.items.length >= 1,
      'Should contain pre-seeded module fixture',
    );

    const authModule = list.items.find((m) => m.name === 'auth_helper');
    assert.ok(authModule, 'Fixture auth_helper must exist');
    assert.equal(authModule.projectId, CANONICAL_PROJECT_ID);

    // Versions endpoint lists all versions (v1 approved, v2 draft)
    const versions = await mockClient.listRegressionModuleVersions(
      CANONICAL_PROJECT_ID,
      'auth_helper',
    );
    assert.equal(versions.items.length, 2);
    const v1 = versions.items.find((v) => v.version === 1);
    const v2 = versions.items.find((v) => v.version === 2);
    assert.equal(v1.reviewStatus, 'approved');
    assert.equal(v2.reviewStatus, 'draft');
  },
);

await checkAsync(
  'MockApiClient project isolation and legacy normalization',
  async () => {
    const mockClient = new MockApiClient();
    // Legacy project id maps to canonical project
    const listLegacy = await mockClient.listRegressionModules(
      LEGACY_MOCK_PROJECT_ID,
    );
    assert.ok(listLegacy.items.length >= 1);

    // Unknown UUID project is rejected
    await assert.rejects(
      () =>
        mockClient.listRegressionModules(
          '00000000-0000-0000-0000-000000000000',
        ),
      /项目不存在/,
    );
  },
);

await checkAsync(
  'MockApiClient registers new module with authentic SHA-256 and draft status',
  async () => {
    const mockClient = new MockApiClient();
    const newModName = 'checkout/payment-flow';

    const created = await mockClient.createRegressionModule(
      CANONICAL_PROJECT_ID,
      {
        name: newModName,
        document: SAMPLE_DOC,
      },
    );

    assert.equal(created.name, newModName);
    assert.equal(created.version, 1);
    assert.equal(created.reviewStatus, 'draft');
    assert.equal(created.createdBy, MOCK_ADMIN_USER_UUID);
    assert.ok(created.createdAt);
    assert.ok(
      validateContract('RegressionModuleRecord', created).success,
      'Created module must satisfy canonical schema',
    );

    // Verify authentic canonical JSON SHA-256 equivalence with shared hashPayload
    const expectedSha = hashPayload(SAMPLE_DOC);
    assert.equal(
      created.sha256,
      expectedSha,
      'Synthetic document SHA must equal canonical hashPayload without fallback',
    );

    // Visible in listRegressionModules
    const list = await mockClient.listRegressionModules(CANONICAL_PROJECT_ID);
    assert.ok(validateContract('RegressionModuleRecordPage', list).success);
    const found = list.items.find((m) => m.name === newModName);
    assert.ok(found);
    assert.equal(found.version, 1);
    assert.equal(found.reviewStatus, 'draft');
    assert.equal(
      isModuleApproved(found),
      false,
      'New draft module must not be approved',
    );
  },
);

await checkAsync(
  'MockApiClient requires explicit expectedVersion for existing modules (no silent append)',
  async () => {
    const mockClient = new MockApiClient();
    const targetName = 'auth_helper';

    const beforeVersions = (
      await mockClient.listRegressionModuleVersions(
        CANONICAL_PROJECT_ID,
        targetName,
      )
    ).items;
    const beforeCount = beforeVersions.length;
    const maxVer = Math.max(...beforeVersions.map((v) => v.version));

    // 1. Omitting expectedVersion on existing module is rejected
    await assert.rejects(
      () =>
        mockClient.createRegressionModule(CANONICAL_PROJECT_ID, {
          name: targetName,
          document: SAMPLE_DOC,
        }),
      /expectedVersion/,
    );

    // 2. Mismatched expectedVersion is rejected
    await assert.rejects(
      () =>
        mockClient.createRegressionModule(CANONICAL_PROJECT_ID, {
          name: targetName,
          document: SAMPLE_DOC,
          expectedVersion: maxVer - 1,
        }),
      /版本冲突/,
    );

    // Verify no versions were appended
    const afterFailed = (
      await mockClient.listRegressionModuleVersions(
        CANONICAL_PROJECT_ID,
        targetName,
      )
    ).items;
    assert.equal(afterFailed.length, beforeCount);

    // 3. New module with expectedVersion != 0 is rejected
    await assert.rejects(
      () =>
        mockClient.createRegressionModule(CANONICAL_PROJECT_ID, {
          name: 'brand-new-module',
          document: SAMPLE_DOC,
          expectedVersion: 1,
        }),
      /expectedVersion/,
    );

    // 4. Correct expectedVersion succeeds
    const nextVer = await mockClient.createRegressionModule(
      CANONICAL_PROJECT_ID,
      {
        name: targetName,
        document: SAMPLE_DOC,
        expectedVersion: maxVer,
      },
    );
    assert.equal(nextVer.version, maxVer + 1);
    assert.ok(validateContract('RegressionModuleRecord', nextVer).success);
  },
);

await checkAsync(
  'MockApiClient lists all versions sorted by name ASC, version DESC',
  async () => {
    const mockClient = new MockApiClient();
    const page = await mockClient.listRegressionModules(CANONICAL_PROJECT_ID);
    assert.ok(validateContract('RegressionModuleRecordPage', page).success);

    // Verify all versions of auth_helper are returned (v1 and v2)
    const authHelperVersions = page.items.filter(
      (item) => item.name === 'auth_helper',
    );
    const actualVersions = (
      await mockClient.listRegressionModuleVersions(
        CANONICAL_PROJECT_ID,
        'auth_helper',
      )
    ).items;
    assert.equal(authHelperVersions.length, actualVersions.length);
    assert.equal(authHelperVersions[0].version, 2);
    assert.equal(authHelperVersions[1].version, 1);

    // Verify global sorting: name ASC, version DESC
    const expectedSorted = [...page.items].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : b.version - a.version,
    );
    assert.deepEqual(
      page.items.map((item) => [item.name, item.version]),
      expectedSorted.map((item) => [item.name, item.version]),
    );
  },
);

await checkAsync(
  'MockApiClient pagination limit and cursor exposes distinct slices',
  async () => {
    const mockClient = new MockApiClient();

    // 1. Module list pagination
    const page1 = await mockClient.listRegressionModules(CANONICAL_PROJECT_ID, {
      limit: 1,
    });
    assert.equal(page1.items.length, 1);
    assert.ok(page1.nextCursor);

    const page2 = await mockClient.listRegressionModules(CANONICAL_PROJECT_ID, {
      limit: 1,
      cursor: page1.nextCursor,
    });
    assert.equal(page2.items.length, 1);
    assert.notDeepEqual(
      [page1.items[0].name, page1.items[0].version],
      [page2.items[0].name, page2.items[0].version],
    );

    // 2. Version list pagination
    const verPage1 = await mockClient.listRegressionModuleVersions(
      CANONICAL_PROJECT_ID,
      'auth_helper',
      { limit: 1 },
    );
    assert.equal(verPage1.items.length, 1);
    assert.ok(verPage1.nextCursor);

    const verPage2 = await mockClient.listRegressionModuleVersions(
      CANONICAL_PROJECT_ID,
      'auth_helper',
      {
        limit: 1,
        cursor: verPage1.nextCursor,
      },
    );
    assert.equal(verPage2.items.length, 1);
    assert.equal(verPage1.items[0].version, 2);
    assert.equal(verPage2.items[0].version, 1);
  },
);

await checkAsync(
  'MockApiClient isolates independent projects and rejects unknown projects',
  async () => {
    const mockClient = new MockApiClient();

    // Create an independent project
    const independent = await mockClient.createProject({
      name: 'Independent Project',
    });
    assert.equal(
      (await mockClient.listRegressionModules(independent.id)).items.length,
      0,
    );

    // Create module in independent project
    const created = await mockClient.createRegressionModule(independent.id, {
      name: 'independent/auth',
      document: SAMPLE_DOC,
    });
    assert.equal(created.projectId, independent.id);
    assert.equal(
      (await mockClient.listRegressionModules(independent.id)).items.length,
      1,
    );

    // Independent module does not leak into canonical project
    const canonicalList =
      await mockClient.listRegressionModules(CANONICAL_PROJECT_ID);
    assert.equal(
      canonicalList.items.some((item) => item.name === created.name),
      false,
    );

    // Unknown project UUID is rejected
    await assert.rejects(
      () =>
        mockClient.createRegressionModule(
          '11111111-2222-3333-4444-555555555555',
          {
            name: 'fail-project',
            document: SAMPLE_DOC,
          },
        ),
      /项目不存在/,
    );
  },
);

await checkAsync(
  'MockApiClient enforces Postgres integer upper bound (2147483647)',
  async () => {
    const mockClient = new MockApiClient();
    const modName = 'pg-overflow-test';

    // Seed a fixture directly into internal list with version 2147483647
    mockClient['regressionModules'].push({
      projectId: CANONICAL_PROJECT_ID,
      name: modName,
      version: 2147483647,
      sha256: '0'.repeat(64),
      document: SAMPLE_DOC,
      reviewStatus: 'approved',
      createdBy: MOCK_ADMIN_USER_UUID,
      createdAt: new Date().toISOString(),
      reviewedBy: MOCK_ADMIN_USER_UUID,
      reviewedAt: new Date().toISOString(),
    });

    // Attempting to increment beyond 2147483647 must reject cleanly without integer overflow
    await assert.rejects(
      () =>
        mockClient.createRegressionModule(CANONICAL_PROJECT_ID, {
          name: modName,
          document: SAMPLE_DOC,
          expectedVersion: 2147483647,
        }),
      /2147483647/,
    );
  },
);

await checkAsync(
  'MockApiClient handles uppercase project UUIDs canonically across create, list, preview, and review (no 409)',
  async () => {
    const mockClient = new MockApiClient();
    const upperProjId = CANONICAL_PROJECT_ID.toUpperCase();
    const testModName = 'uppercase-uuid/test-module';

    // 1. Create with uppercase project UUID -> returns canonical lowercase UUID
    const created = await mockClient.createRegressionModule(upperProjId, {
      name: testModName,
      document: SAMPLE_DOC,
    });
    assert.equal(created.projectId, CANONICAL_PROJECT_ID.toLowerCase());
    assert.ok(validateContract('RegressionModuleRecord', created).success);

    // 2. List with uppercase project UUID -> returns the created module
    const list = await mockClient.listRegressionModules(upperProjId);
    assert.ok(validateContract('RegressionModuleRecordPage', list).success);
    const found = list.items.find((m) => m.name === testModName);
    assert.ok(found);
    assert.equal(found.projectId, CANONICAL_PROJECT_ID.toLowerCase());

    // 3. Preview with uppercase project UUID -> succeeds 200, returns canonical lowercase UUID
    const preview = await mockClient.previewRegressionModuleReview(
      upperProjId,
      testModName,
      1,
      {
        expectedVersion: 1,
        decision: 'approve',
        reason: 'Uppercase UUID acceptance',
      },
    );
    assert.equal(preview.projectId, CANONICAL_PROJECT_ID.toLowerCase());
    assert.ok(
      validateContract('RegressionModuleReviewPreview', preview).success,
    );

    // 4. Review commit with uppercase project UUID -> succeeds 200 (not 409!)
    const reviewed = await mockClient.reviewRegressionModuleVersion(
      upperProjId,
      testModName,
      1,
      {
        expectedVersion: 1,
        decision: 'approve',
        reason: 'Uppercase UUID acceptance',
        confirmationToken: preview.confirmationToken,
      },
    );
    assert.equal(reviewed.projectId, CANONICAL_PROJECT_ID.toLowerCase());
    assert.equal(reviewed.reviewStatus, 'approved');
    assert.ok(validateContract('RegressionModuleRecord', reviewed).success);
  },
);

await checkAsync(
  'MockApiClient legacy text alias requires exact match (rejects altered casing)',
  async () => {
    const mockClient = new MockApiClient();

    // Valid legacy alias resolves to canonical mock project
    const validList = await mockClient.listRegressionModules(
      LEGACY_MOCK_PROJECT_ID,
    );
    assert.ok(validList.items.length >= 1);

    // Uppercase legacy text alias is NOT a UUID, must be rejected
    await assert.rejects(
      () =>
        mockClient.listRegressionModules(LEGACY_MOCK_PROJECT_ID.toUpperCase()),
      /项目不存在/,
    );
  },
);

await checkAsync(
  'MockApiClient Two-Stage Review: Preview -> Token Verification -> Approved Commit',
  async () => {
    const mockClient = new MockApiClient();
    const moduleName = 'auth_helper';
    const targetVersion = 2; // v2 is draft

    // Stage 1: Request preview
    const preview = await mockClient.previewRegressionModuleReview(
      CANONICAL_PROJECT_ID,
      moduleName,
      targetVersion,
      {
        expectedVersion: targetVersion,
        decision: 'approve',
        reason: 'Stage 1 manual code inspection complete',
      },
    );

    assert.equal(preview.projectId, CANONICAL_PROJECT_ID);
    assert.equal(preview.moduleName, moduleName);
    assert.equal(preview.version, targetVersion);
    assert.equal(preview.decision, 'approve');
    assert.ok(preview.diff.includes('auth_helper'));
    assert.ok(preview.risks.length >= 1);
    assert.ok(preview.confirmationToken.length >= 64);
    assert.ok(Date.parse(preview.expiresAt) > Date.now());

    // Expected version mismatch in review preview causes rejection
    await assert.rejects(
      () =>
        mockClient.previewRegressionModuleReview(
          CANONICAL_PROJECT_ID,
          moduleName,
          targetVersion,
          {
            expectedVersion: 999, // Mismatch
            decision: 'approve',
            reason: 'Test mismatch',
          },
        ),
      /版本冲突/,
    );

    // Stage 2: Commit review with confirmation token
    const committed = await mockClient.reviewRegressionModuleVersion(
      CANONICAL_PROJECT_ID,
      moduleName,
      targetVersion,
      {
        expectedVersion: targetVersion,
        decision: 'approve',
        reason: 'Stage 1 manual code inspection complete',
        confirmationToken: preview.confirmationToken,
      },
    );

    assert.equal(committed.name, moduleName);
    assert.equal(committed.version, targetVersion);
    assert.equal(committed.reviewStatus, 'approved');
    assert.equal(committed.reviewedBy, MOCK_ADMIN_USER_UUID);
    assert.ok(committed.reviewedAt);
    assert.ok(validateContract('RegressionModuleRecord', committed).success);

    // Verify status is now approved in listRegressionModuleVersions
    const versions = await mockClient.listRegressionModuleVersions(
      CANONICAL_PROJECT_ID,
      moduleName,
    );
    const updatedV2 = versions.items.find((v) => v.version === targetVersion);
    assert.equal(updatedV2.reviewStatus, 'approved');
    assert.equal(
      isModuleApproved(updatedV2),
      true,
      'Approved module is now eligible',
    );

    // Single-use token enforcement: reusing the token must be rejected
    await assert.rejects(
      () =>
        mockClient.reviewRegressionModuleVersion(
          CANONICAL_PROJECT_ID,
          moduleName,
          targetVersion,
          {
            expectedVersion: targetVersion,
            decision: 'approve',
            reason: 'Attempt reuse',
            confirmationToken: preview.confirmationToken,
          },
        ),
      /无效或不存在/,
    );
  },
);

await checkAsync(
  'MockApiClient rejects review commit when token is expired',
  async () => {
    const mockClient = new MockApiClient();
    const moduleName = 'auth_helper';
    const targetVersion = 2;

    // Generate preview
    const preview = await mockClient.previewRegressionModuleReview(
      CANONICAL_PROJECT_ID,
      moduleName,
      targetVersion,
      {
        expectedVersion: targetVersion,
        decision: 'approve',
        reason: 'Expiry test',
      },
    );

    // Artificially expire the preview in mockClient state
    const storedPreview =
      mockClient['activeModuleReviewPreviews'][preview.confirmationToken];
    assert.ok(storedPreview);
    storedPreview.expiresAt = new Date(Date.now() - 1000).toISOString();

    await assert.rejects(
      () =>
        mockClient.reviewRegressionModuleVersion(
          CANONICAL_PROJECT_ID,
          moduleName,
          targetVersion,
          {
            expectedVersion: targetVersion,
            decision: 'approve',
            reason: 'Expiry test',
            confirmationToken: preview.confirmationToken,
          },
        ),
      /Token 已过期/,
    );
  },
);

await checkAsync(
  'MockApiClient fails closed without WebCrypto (no fake fallback)',
  async () => {
    const mockClient = new MockApiClient();
    const originalCrypto = globalThis.crypto;
    try {
      delete globalThis.crypto;
      await assert.rejects(
        () =>
          mockClient.createRegressionModule(CANONICAL_PROJECT_ID, {
            name: 'fail-closed/test',
            document: SAMPLE_DOC,
          }),
        /WebCrypto API/,
      );
    } finally {
      globalThis.crypto = originalCrypto;
    }
  },
);

// ---------------------------------------------------------------------------
// Suite 5: Static SSR & Markup Rendering (Zero Browser)
// ---------------------------------------------------------------------------
console.log('--- Suite 5: Static SSR & Component Markup Verification ---');

const viteRequire = createRequire(
  createRequire(pathToFileURL(resolve('apps/web/package.json'))).resolve(
    'vite',
  ),
);
const { build } = viteRequire('esbuild');

const ssrTempDir = await mkdtemp(resolve('apps/web/.offline-module-ssr-'));
const ssrBundleFile = join(ssrTempDir, 'render-modules.mjs');

try {
  await build({
    stdin: {
      contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModulesPage } from './src/pages/ModulesPage.tsx';
import { ModuleRegisterModal } from './src/components/modules/ModuleRegisterModal.tsx';
import { ModuleReviewModal } from './src/components/modules/ModuleReviewModal.tsx';

// 1. SSR ModulesPage for Owner
export const modulesPageOwnerHtml = renderToStaticMarkup(
  React.createElement(ModulesPage, null)
);

// 2. SSR ModuleRegisterModal open (New Module)
export const registerModalNewHtml = renderToStaticMarkup(
  React.createElement(ModuleRegisterModal, {
    projectId: '9d82c93d-3c29-44c7-a389-91f11088d174',
    isOpen: true,
    existingModule: null,
    onClose: () => {},
    onCreated: () => {},
  })
);

// 3. SSR ModuleRegisterModal open (New Version)
export const registerModalNewVersionHtml = renderToStaticMarkup(
  React.createElement(ModuleRegisterModal, {
    projectId: '9d82c93d-3c29-44c7-a389-91f11088d174',
    isOpen: true,
    existingModule: {
      name: 'auth_helper',
      latestVersion: 1,
      latestDocument: ${JSON.stringify(SAMPLE_DOC)},
    },
    onClose: () => {},
    onCreated: () => {},
  })
);

// 4. SSR ModuleReviewModal open
export const reviewModalHtml = renderToStaticMarkup(
  React.createElement(ModuleReviewModal, {
    projectId: '9d82c93d-3c29-44c7-a389-91f11088d174',
    module: {
      projectId: '9d82c93d-3c29-44c7-a389-91f11088d174',
      name: 'auth_helper',
      version: 2,
      sha256: '${'a'.repeat(64)}',
      document: ${JSON.stringify(SAMPLE_DOC)},
      reviewStatus: 'draft',
      createdBy: 'mock-user',
      createdAt: '2026-10-06T00:00:00.000Z',
      reviewedBy: null,
      reviewedAt: null,
    },
    isOpen: true,
    onClose: () => {},
    onReviewed: () => {},
  })
);

// 5. SSR closed modals
export const closedRegisterModalHtml = renderToStaticMarkup(
  React.createElement(ModuleRegisterModal, {
    projectId: '9d82c93d-3c29-44c7-a389-91f11088d174',
    isOpen: false,
    existingModule: null,
    onClose: () => {},
    onCreated: () => {},
  })
);

export const closedReviewModalHtml = renderToStaticMarkup(
  React.createElement(ModuleReviewModal, {
    projectId: '9d82c93d-3c29-44c7-a389-91f11088d174',
    module: {
      projectId: '9d82c93d-3c29-44c7-a389-91f11088d174',
      name: 'auth_helper',
      version: 2,
      sha256: '${'a'.repeat(64)}',
      document: ${JSON.stringify(SAMPLE_DOC)},
      reviewStatus: 'draft',
      createdBy: null,
      createdAt: null,
      reviewedBy: null,
      reviewedAt: null,
    },
    isOpen: false,
    onClose: () => {},
    onReviewed: () => {},
  })
);
`,
      resolveDir: resolve('apps/web'),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: ssrBundleFile,
    external: ['react', 'react-dom/server'],
    define: { 'import.meta.env': '{}' },
    plugins: [
      {
        name: 'ssr-module-stubs',
        setup(builder) {
          builder.onResolve({ filter: /api\/index\.ts$/ }, () => ({
            path: 'ssr-api-stub',
            namespace: 'ssr-api-stub',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'ssr-api-stub' }, () => ({
            contents: `
export const isUsingMock = () => false;
export const setUseMock = () => {};
export const defaultApiClient = {
  listRegressionModules: async () => ({ items: [], total: 0 }),
  listRegressionModuleVersions: async () => ({ items: [], total: 0 }),
  listMembers: async () => ({ items: [{ userId: 'u1', role: 'owner' }] }),
  currentUser: async () => ({ id: 'u1', email: 'owner@localqa.dev', role: 'admin' }),
};
`,
            loader: 'js',
          }));

          builder.onResolve({ filter: /state\/AppContext\.tsx$/ }, () => ({
            path: 'ssr-app-context-stub',
            namespace: 'ssr-app-context-stub',
          }));
          builder.onLoad(
            { filter: /.*/, namespace: 'ssr-app-context-stub' },
            () => ({
              contents: `
export const useApp = () => ({
  currentUser: { id: 'u1', name: 'Test Owner', email: 'owner@example.com', role: 'admin' },
  currentProject: { id: '9d82c93d-3c29-44c7-a389-91f11088d174', name: 'Demo Project', slug: 'demo' },
  projects: [{ id: '9d82c93d-3c29-44c7-a389-91f11088d174', name: 'Demo Project', slug: 'demo' }],
  currentRoute: 'modules',
  routeParams: {},
  isMock: false,
  sessionLoading: false,
  setRoute: () => {},
  setCurrentProject: () => {},
  toggleMock: () => {},
  logout: async () => {},
  login: async () => {},
});
export const AppProvider = ({ children }) => children;
`,
              loader: 'js',
            }),
          );
        },
      },
    ],
  });

  const {
    modulesPageOwnerHtml,
    registerModalNewHtml,
    registerModalNewVersionHtml,
    reviewModalHtml,
    closedRegisterModalHtml,
    closedReviewModalHtml,
  } = await import(pathToFileURL(ssrBundleFile).href);

  check(
    'ModulesPage SSR renders table container and registration CTA for Owner',
    () => {
      assert.ok(
        modulesPageOwnerHtml.includes('data-testid="modules-page"'),
        'ModulesPage container missing',
      );
      assert.ok(
        modulesPageOwnerHtml.includes('受控回归模块库'),
        'Page title missing',
      );
      assert.ok(
        modulesPageOwnerHtml.includes('data-testid="btn-register-module"'),
        'Register button missing',
      );
      assert.ok(
        modulesPageOwnerHtml.includes('+ 注册受控模块'),
        'Register button text missing',
      );
    },
  );

  check(
    'ModuleRegisterModal SSR renders input fields and safety notices',
    () => {
      assert.equal(
        closedRegisterModalHtml,
        '',
        'Closed register modal must render empty',
      );
      assert.ok(
        registerModalNewHtml.includes('data-testid="module-register-modal"'),
        'Modal missing',
      );
      assert.ok(
        registerModalNewHtml.includes('data-testid="module-name-input"'),
        'Name input missing',
      );
      assert.ok(
        registerModalNewHtml.includes(
          'data-testid="module-document-json-input"',
        ),
        'Document editor missing',
      );
      assert.ok(
        registerModalNewHtml.includes(
          'data-testid="btn-submit-register-module"',
        ),
        'Submit button missing',
      );
      assert.ok(
        registerModalNewHtml.includes('草稿'),
        'Draft status indicator missing',
      );

      // New version modal shows fixed name and incremented version notice
      assert.ok(
        registerModalNewVersionHtml.includes('发布模块新版本: auth_helper'),
        'New version title missing',
      );
      assert.ok(
        registerModalNewVersionHtml.includes('目标 v2'),
        'Version increment label missing',
      );
    },
  );

  check(
    'ModuleReviewModal SSR renders two-stage review inputs and token guard',
    () => {
      assert.equal(
        closedReviewModalHtml,
        '',
        'Closed review modal must render empty',
      );
      assert.ok(
        reviewModalHtml.includes('data-testid="module-review-modal"'),
        'Review modal missing',
      );
      assert.ok(
        reviewModalHtml.includes('两阶段人工审批: auth_helper'),
        'Review modal title missing',
      );
      assert.ok(
        reviewModalHtml.includes('审批决议 (Decision)'),
        'Decision label missing',
      );
      assert.ok(
        reviewModalHtml.includes('data-testid="module-review-reason-input"'),
        'Reason textarea missing',
      );
      assert.ok(
        reviewModalHtml.includes('data-testid="btn-generate-module-preview"'),
        'Stage 1 preview button missing',
      );
      assert.ok(
        reviewModalHtml.includes('第 1 阶段：生成审查预览'),
        'Stage 1 button text missing',
      );
      assert.ok(
        reviewModalHtml.includes('目标模块'),
        'Target module section missing',
      );
    },
  );
} finally {
  await rm(ssrTempDir, { recursive: true, force: true });
}

console.log(
  '\n================================================================',
);
console.log(
  ` Summary: ${passedTests}/${totalTests} T10-MODULES offline checks PASSED`,
);
console.log('================================================================');

console.log(
  JSON.stringify(
    {
      totalTests,
      passedTests,
      contractChecksPassed: true,
      boundaryChecksPassed: true,
      injectedResponseGuardPassed: true,
      twoStageReviewPassed: true,
      roleGatePassed: true,
      ssrRenderingPassed: true,
      browserExecuted: false,
      egoPaused: true,
      P0Passed: false,
    },
    null,
    2,
  ),
);
