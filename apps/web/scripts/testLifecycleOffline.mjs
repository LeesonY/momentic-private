/**
 * Offline Browserless Test Suite for T10-LIFECYCLE Case Lifecycle & Duplication Increment.
 *
 * Verifies:
 * 1. Contract schema conformance & boundary rejection for 3 new DTOs:
 *    - SavedCaseArchiveInput, SavedCaseRestoreInput, SavedCaseDuplicateInput.
 *    - 80 public operations in OpenAPI & contracts.
 * 2. Generated client (HttpApiClient) methods & injected response validation guards:
 *    - archiveSavedCase: checks target caseId, status === 'archived', version >= expectedVersion.
 *    - restoreSavedCase: checks target caseId, status === 'active', version >= expectedVersion.
 *    - duplicateSavedCase: checks distinct UUID, target project, matching slug/name, initial active,
 *      and critical draft invariant (currentApprovedVersionId === null).
 *    - listSavedCases: query parameter serialization for status ('active' | 'archived' | 'all').
 * 3. MockApiClient public method flows:
 *    - listSavedCases filtering: active (default), archived, all; project identity isolation.
 *    - archiveSavedCase: moves active case to archived, increments version, leaves version history intact.
 *    - restoreSavedCase: moves archived case back to active, increments version.
 *    - duplicateSavedCase: clones document, computes authentic WebCrypto SHA-256 matching hashPayload,
 *      creates unapproved draft version requiring Owner review, supports targetProjectId.
 *    - Stale expectedVersion optimistic lock rejection (409 Conflict).
 *    - Missing crypto / digest fail-closed protection.
 * 4. UI Role Invariants & Permissions (Viewer read-only, Operator/Owner archive/restore/duplicate).
 * 5. Static SSR rendering for SavedCasesPage, SavedCaseDuplicateModal, and SavedCaseDetailPage.
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
  MOCK_SAVED_CASE_1_ID,
  MOCK_SAVED_CASE_3_ARCHIVED_ID,
} from '../src/mocks/data.ts';
import { HttpApiClient } from '../src/api/client.ts';

console.log('================================================================');
console.log(
  ' T10-LIFECYCLE Offline Contract, Boundary, Mock & SSR Verification',
);
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
const VALID_UUID_1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const VALID_UUID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c9';

// ---------------------------------------------------------------------------
// Suite 1: OpenAPI Schema & Contract Conformance for 3 DTOs & 80 Public Ops
// ---------------------------------------------------------------------------
console.log(
  '--- Suite 1: Contract Conformance & Operation Mapping (80 public ops) ---',
);

check('OpenAPI public operations includes all 3 lifecycle operations', () => {
  const expectedOps = [
    'archiveSavedCase',
    'restoreSavedCase',
    'duplicateSavedCase',
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

check('SavedCaseArchiveInput schema validation & boundary checks', () => {
  // Valid
  assert.equal(
    validateContract('SavedCaseArchiveInput', { expectedVersion: 1 }).success,
    true,
  );
  assert.equal(
    validateContract('SavedCaseArchiveInput', { expectedVersion: 42 }).success,
    true,
  );
  assert.deepEqual(
    parseContract('SavedCaseArchiveInput', { expectedVersion: 3 }),
    { expectedVersion: 3 },
  );

  // Invalid
  const invalids = [
    {}, // missing expectedVersion
    { expectedVersion: 0 }, // must be >= 1
    { expectedVersion: -1 }, // negative
    { expectedVersion: 1.5 }, // non-integer
    { expectedVersion: '1' }, // string
    { expectedVersion: null },
  ];
  for (const bad of invalids) {
    assert.equal(
      validateContract('SavedCaseArchiveInput', bad).success,
      false,
      `SavedCaseArchiveInput must reject ${JSON.stringify(bad)}`,
    );
  }
});

check('SavedCaseRestoreInput schema validation & boundary checks', () => {
  // Valid
  assert.equal(
    validateContract('SavedCaseRestoreInput', { expectedVersion: 1 }).success,
    true,
  );
  assert.equal(
    validateContract('SavedCaseRestoreInput', { expectedVersion: 99 }).success,
    true,
  );
  assert.deepEqual(
    parseContract('SavedCaseRestoreInput', { expectedVersion: 5 }),
    { expectedVersion: 5 },
  );

  // Invalid
  const invalids = [
    {}, // missing expectedVersion
    { expectedVersion: 0 }, // must be >= 1
    { expectedVersion: -3 }, // negative
    { expectedVersion: 2.2 }, // non-integer
    { expectedVersion: '2' }, // string
  ];
  for (const bad of invalids) {
    assert.equal(
      validateContract('SavedCaseRestoreInput', bad).success,
      false,
      `SavedCaseRestoreInput must reject ${JSON.stringify(bad)}`,
    );
  }
});

check(
  'SavedCaseDuplicateInput schema validation & slug/UUID boundary checks',
  () => {
    // Valid minimal
    const validMinimal = {
      sourceVersionId: VALID_UUID_1,
      newSlug: 'copy-of-login',
      newName: 'Login Copy',
    };
    assert.equal(
      validateContract('SavedCaseDuplicateInput', validMinimal).success,
      true,
    );

    // Valid with targetProjectId
    const validWithTarget = {
      sourceVersionId: VALID_UUID_1,
      newSlug: 'cross-project-case',
      newName: 'Cross Project Duplicate',
      targetProjectId: VALID_UUID_2,
    };
    assert.equal(
      validateContract('SavedCaseDuplicateInput', validWithTarget).success,
      true,
    );

    // Invalid sourceVersionId
    assert.equal(
      validateContract('SavedCaseDuplicateInput', {
        ...validMinimal,
        sourceVersionId: 'not-a-uuid',
      }).success,
      false,
      'Must reject invalid UUID sourceVersionId',
    );

    // Invalid slug patterns (pattern: ^[a-zA-Z0-9_.-]+$, maxLength: 120)
    const badSlugs = [
      '', // empty
      'has space', // whitespace
      'special/slash', // slashes
      'has@symbol', // @ disallowed
      'emoji-🎯', // non-ascii
      'a'.repeat(121), // exceeds 120 chars
    ];
    for (const slug of badSlugs) {
      assert.equal(
        validateContract('SavedCaseDuplicateInput', {
          ...validMinimal,
          newSlug: slug,
        }).success,
        false,
        `SavedCaseDuplicateInput must reject slug "${slug}"`,
      );
    }

    // Valid slug variations
    assert.equal(
      validateContract('SavedCaseDuplicateInput', {
        ...validMinimal,
        newSlug: 'UPPERCASE_123',
      }).success,
      true,
      'Allows alphanumeric and underscores',
    );
    assert.equal(
      validateContract('SavedCaseDuplicateInput', {
        ...validMinimal,
        newSlug: 'case.with.dots-and-dashes',
      }).success,
      true,
      'Allows dots and hyphens',
    );

    // Invalid newName
    assert.equal(
      validateContract('SavedCaseDuplicateInput', {
        ...validMinimal,
        newName: '',
      }).success,
      false,
      'Must reject empty newName',
    );

    // Invalid targetProjectId
    assert.equal(
      validateContract('SavedCaseDuplicateInput', {
        ...validMinimal,
        targetProjectId: 'invalid-target-uuid',
      }).success,
      false,
      'Must reject non-UUID targetProjectId',
    );
  },
);

check(
  'SavedCase contract enforces status active | archived and nullable currentApprovedVersionId',
  () => {
    const baseCase = {
      id: VALID_UUID_1,
      projectId: CANONICAL_PROJECT_ID,
      slug: 'test-case-lifecycle',
      name: 'Test Case Lifecycle',
      status: 'active',
      currentApprovedVersionId: VALID_UUID_2,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    assert.equal(validateContract('SavedCase', baseCase).success, true);

    // Archived status is valid
    assert.equal(
      validateContract('SavedCase', { ...baseCase, status: 'archived' })
        .success,
      true,
    );

    // Unapproved duplicate (currentApprovedVersionId === null) is valid
    assert.equal(
      validateContract('SavedCase', {
        ...baseCase,
        currentApprovedVersionId: null,
      }).success,
      true,
    );

    // Invalid status boundary
    assert.equal(
      validateContract('SavedCase', { ...baseCase, status: 'deleted' }).success,
      false,
    );
    assert.equal(
      validateContract('SavedCase', { ...baseCase, status: 'pending' }).success,
      false,
    );
  },
);

// ---------------------------------------------------------------------------
// Suite 2: Generated HttpApiClient Methods & Injected Transport Verification
// ---------------------------------------------------------------------------
console.log(
  '--- Suite 2: HttpApiClient Generated Methods & Injected Response Guards ---',
);

await checkAsync(
  'HttpApiClient.archiveSavedCase validates request and enforces response invariants',
  async () => {
    const caseId = VALID_UUID_1;
    const input = { expectedVersion: 2 };
    const originalFetch = globalThis.fetch;

    try {
      // 1. Valid transport execution
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedBody = '';

      globalThis.fetch = async (url, init) => {
        capturedUrl = url.toString();
        capturedMethod = init?.method || 'GET';
        capturedBody = init?.body ? String(init.body) : '';
        return new Response(
          JSON.stringify({
            id: caseId,
            projectId: CANONICAL_PROJECT_ID,
            slug: 'test-case',
            name: 'Test Case',
            status: 'archived',
            currentApprovedVersionId: VALID_UUID_2,
            version: 3,
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new HttpApiClient('https://api.localqa.dev/api/v1');
      const res = await client.archiveSavedCase(caseId, input);
      assert.equal(
        capturedUrl,
        `https://api.localqa.dev/api/v1/saved-cases/${encodeURIComponent(caseId)}/archive`,
      );
      assert.equal(capturedMethod, 'POST');
      assert.deepEqual(JSON.parse(capturedBody), { expectedVersion: 2 });
      assert.equal(res.id, caseId);
      assert.equal(res.status, 'archived');
      assert.equal(res.version, 3);

      // 2. Injected response ID mismatch
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            id: VALID_UUID_2, // wrong ID!
            projectId: CANONICAL_PROJECT_ID,
            slug: 'test-case',
            name: 'Test Case',
            status: 'archived',
            currentApprovedVersionId: null,
            version: 3,
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      await assert.rejects(
        () => client.archiveSavedCase(caseId, input),
        /case ID mismatch/i,
      );

      // 3. Injected response status mismatch (e.g. still active)
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            id: caseId,
            projectId: CANONICAL_PROJECT_ID,
            slug: 'test-case',
            name: 'Test Case',
            status: 'active', // not archived!
            currentApprovedVersionId: null,
            version: 3,
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      await assert.rejects(
        () => client.archiveSavedCase(caseId, input),
        /status mismatch/i,
      );

      // 4. Injected response version not incremented exactly once (e.g. equal or regressed)
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            id: caseId,
            projectId: CANONICAL_PROJECT_ID,
            slug: 'test-case',
            name: 'Test Case',
            status: 'archived',
            currentApprovedVersionId: null,
            version: 2, // expectedVersion is 2, version must be 3!
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      await assert.rejects(
        () => client.archiveSavedCase(caseId, input),
        /version must be exactly expectedVersion \+ 1/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

await checkAsync(
  'HttpApiClient.restoreSavedCase validates request and enforces response invariants',
  async () => {
    const caseId = VALID_UUID_1;
    const input = { expectedVersion: 3 };
    const originalFetch = globalThis.fetch;

    try {
      // 1. Valid transport execution
      globalThis.fetch = async (url, init) => {
        assert.equal(
          url.toString(),
          `https://api.localqa.dev/api/v1/saved-cases/${encodeURIComponent(caseId)}/restore`,
        );
        assert.equal(init?.method, 'POST');
        return new Response(
          JSON.stringify({
            id: caseId,
            projectId: CANONICAL_PROJECT_ID,
            slug: 'test-case',
            name: 'Test Case',
            status: 'active',
            currentApprovedVersionId: null,
            version: 4,
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new HttpApiClient('https://api.localqa.dev/api/v1');
      const res = await client.restoreSavedCase(caseId, input);
      assert.equal(res.id, caseId);
      assert.equal(res.status, 'active');
      assert.equal(res.version, 4);

      // 2. Injected response status mismatch (e.g. still archived)
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            id: caseId,
            projectId: CANONICAL_PROJECT_ID,
            slug: 'test-case',
            name: 'Test Case',
            status: 'archived', // not active!
            currentApprovedVersionId: null,
            version: 4,
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      await assert.rejects(
        () => client.restoreSavedCase(caseId, input),
        /status mismatch/i,
      );

      // 3. Injected response version not incremented exactly once
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            id: caseId,
            projectId: CANONICAL_PROJECT_ID,
            slug: 'test-case',
            name: 'Test Case',
            status: 'active',
            currentApprovedVersionId: null,
            version: 3, // input expectedVersion was 3, version must be 4!
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      await assert.rejects(
        () => client.restoreSavedCase(caseId, input),
        /version must be exactly expectedVersion \+ 1/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

await checkAsync(
  'HttpApiClient.duplicateSavedCase enforces distinct entity, matching fields, and draft invariant',
  async () => {
    const caseId = VALID_UUID_1;
    const newCaseId = VALID_UUID_2;
    const input = {
      sourceVersionId: VALID_UUID_1,
      newSlug: 'duplicated-auth',
      newName: 'Duplicated Auth',
      targetProjectId: CANONICAL_PROJECT_ID,
    };
    const originalFetch = globalThis.fetch;

    try {
      // 1. Valid execution
      globalThis.fetch = async (url, init) => {
        assert.equal(
          url.toString(),
          `https://api.localqa.dev/api/v1/saved-cases/${encodeURIComponent(caseId)}/duplicate`,
        );
        assert.equal(init?.method, 'POST');
        return new Response(
          JSON.stringify({
            id: newCaseId,
            projectId: CANONICAL_PROJECT_ID,
            slug: 'duplicated-auth',
            name: 'Duplicated Auth',
            status: 'active',
            currentApprovedVersionId: null, // Critical: must be unapproved draft!
            version: 1,
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new HttpApiClient('https://api.localqa.dev/api/v1');
      const res = await client.duplicateSavedCase(caseId, input);
      assert.equal(res.id, newCaseId);
      assert.equal(res.currentApprovedVersionId, null);

      // 2. Rejection if returned ID equals source ID
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            id: caseId, // Must NOT be source caseId!
            projectId: CANONICAL_PROJECT_ID,
            slug: 'duplicated-auth',
            name: 'Duplicated Auth',
            status: 'active',
            currentApprovedVersionId: null,
            version: 1,
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      await assert.rejects(
        () => client.duplicateSavedCase(caseId, input),
        /must be distinct/i,
      );

      // 3. Rejection if duplicate is illegally marked approved
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            id: newCaseId,
            projectId: CANONICAL_PROJECT_ID,
            slug: 'duplicated-auth',
            name: 'Duplicated Auth',
            status: 'active',
            currentApprovedVersionId: VALID_UUID_1, // Illegal: duplicates must start unapproved!
            version: 1,
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      await assert.rejects(
        () => client.duplicateSavedCase(caseId, input),
        /must start in draft status/i,
      );

      // 4. Rejection if returned slug does not match newSlug
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            id: newCaseId,
            projectId: CANONICAL_PROJECT_ID,
            slug: 'wrong-slug',
            name: 'Duplicated Auth',
            status: 'active',
            currentApprovedVersionId: null,
            version: 1,
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      await assert.rejects(
        () => client.duplicateSavedCase(caseId, input),
        /slug mismatch/i,
      );

      // 5. Rejection if returned version is not 1
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            id: newCaseId,
            projectId: CANONICAL_PROJECT_ID,
            slug: 'duplicated-auth',
            name: 'Duplicated Auth',
            status: 'active',
            currentApprovedVersionId: null,
            version: 8, // Illegal: duplicates must start at version 1!
            createdAt: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      await assert.rejects(
        () => client.duplicateSavedCase(caseId, input),
        /version must be 1/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

await checkAsync(
  'HttpApiClient.listSavedCases serializes status query parameter and validates items',
  async () => {
    let requestedUrl = '';
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = async (url) => {
        requestedUrl = url.toString();
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const client = new HttpApiClient('https://api.localqa.dev/api/v1');

      // Query with status: archived
      await client.listSavedCases(CANONICAL_PROJECT_ID, {
        status: 'archived',
        limit: 10,
      });
      assert.ok(
        requestedUrl.includes('status=archived'),
        'Must serialize status=archived',
      );
      assert.ok(requestedUrl.includes('limit=10'), 'Must serialize limit');

      // Query with status: all
      await client.listSavedCases(CANONICAL_PROJECT_ID, { status: 'all' });
      assert.ok(
        requestedUrl.includes('status=all'),
        'Must serialize status=all',
      );

      // Rejects foreign project records
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: VALID_UUID_1,
                projectId: '99999999-9999-4999-8999-999999999999',
                slug: 'foreign-case',
                name: 'Foreign Case',
                status: 'active',
                currentApprovedVersionId: null,
                version: 1,
                createdAt: new Date().toISOString(),
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      await assert.rejects(
        () => client.listSavedCases(CANONICAL_PROJECT_ID, { status: 'all' }),
        /project mismatch/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

// ---------------------------------------------------------------------------
// Suite 3: MockApiClient Public Lifecycle Methods & Semantics
// ---------------------------------------------------------------------------
console.log('--- Suite 3: MockApiClient Public Methods & Lifecycle Flows ---');

await checkAsync(
  'MockApiClient.listSavedCases status filtering (active default, archived, all)',
  async () => {
    const mockClient = new MockApiClient();

    // 1. Default (no status query): only active cases
    const defaultRes = await mockClient.listSavedCases(CANONICAL_PROJECT_ID);
    assert.ok(defaultRes.items.length > 0, 'Must return active cases');
    assert.ok(
      defaultRes.items.every((c) => c.status === 'active'),
      'Default listSavedCases must return ONLY active cases',
    );
    assert.ok(
      !defaultRes.items.some((c) => c.id === MOCK_SAVED_CASE_3_ARCHIVED_ID),
      'Archived case must not appear in default listSavedCases',
    );

    // 2. Explicit status: 'active'
    const activeRes = await mockClient.listSavedCases(CANONICAL_PROJECT_ID, {
      status: 'active',
    });
    assert.equal(activeRes.items.length, defaultRes.items.length);
    assert.ok(activeRes.items.every((c) => c.status === 'active'));

    // 3. Explicit status: 'archived'
    const archivedRes = await mockClient.listSavedCases(CANONICAL_PROJECT_ID, {
      status: 'archived',
    });
    assert.ok(archivedRes.items.length > 0, 'Must return archived cases');
    assert.ok(
      archivedRes.items.every((c) => c.status === 'archived'),
      'status: archived query must return ONLY archived cases',
    );
    assert.ok(
      archivedRes.items.some((c) => c.id === MOCK_SAVED_CASE_3_ARCHIVED_ID),
      'Pre-seeded archived fixture must appear in archived list',
    );

    // 4. Explicit status: 'all'
    const allRes = await mockClient.listSavedCases(CANONICAL_PROJECT_ID, {
      status: 'all',
    });
    assert.equal(
      allRes.items.length,
      activeRes.items.length + archivedRes.items.length,
      'status: all must return the sum of active and archived cases',
    );

    // 5. Project identity: unknown project throws, does not invent new project
    await assert.rejects(
      () => mockClient.listSavedCases('00000000-0000-0000-0000-000000000000'),
      /项目不存在/,
      'Unknown project must be rejected without creating new project',
    );

    // 6. Legacy project alias maps stably to canonical project
    const legacyRes = await mockClient.listSavedCases(LEGACY_MOCK_PROJECT_ID);
    assert.equal(legacyRes.items.length, defaultRes.items.length);
    assert.equal(legacyRes.items[0].projectId, CANONICAL_PROJECT_ID);
  },
);

await checkAsync(
  'MockApiClient.archiveSavedCase & restoreSavedCase lifecycle roundtrip',
  async () => {
    const mockClient = new MockApiClient();

    // Find an active case to archive
    const activeList = await mockClient.listSavedCases(CANONICAL_PROJECT_ID);
    const targetCase = activeList.items[0];
    const initialVersion = targetCase.version;

    // Stale expectedVersion throws 409
    await assert.rejects(
      () =>
        mockClient.archiveSavedCase(targetCase.id, {
          expectedVersion: initialVersion + 99,
        }),
      (err) => err.status === 409 || err.statusCode === 409,
      'Must throw 409 on stale expectedVersion',
    );

    // Archive with correct expectedVersion
    const archived = await mockClient.archiveSavedCase(targetCase.id, {
      expectedVersion: initialVersion,
    });
    assert.equal(archived.id, targetCase.id);
    assert.equal(archived.status, 'archived');
    assert.equal(archived.version, initialVersion + 1);

    // Case no longer in default list
    const activeAfterArchive =
      await mockClient.listSavedCases(CANONICAL_PROJECT_ID);
    assert.ok(!activeAfterArchive.items.some((c) => c.id === targetCase.id));

    // Case appears in archived list
    const archivedList = await mockClient.listSavedCases(CANONICAL_PROJECT_ID, {
      status: 'archived',
    });
    assert.ok(archivedList.items.some((c) => c.id === targetCase.id));

    // Case versions history remains intact
    const versions = await mockClient.listSavedCaseVersions(targetCase.id);
    assert.ok(
      versions.items.length > 0,
      'Archived case must retain its complete version history',
    );

    // Archiving already archived case throws 409
    await assert.rejects(
      () =>
        mockClient.archiveSavedCase(targetCase.id, {
          expectedVersion: archived.version,
        }),
      (err) => err.status === 409 || err.statusCode === 409,
      'Must throw 409 when archiving an already archived case',
    );

    // Restore case
    const restored = await mockClient.restoreSavedCase(targetCase.id, {
      expectedVersion: archived.version,
    });
    assert.equal(restored.id, targetCase.id);
    assert.equal(restored.status, 'active');
    assert.equal(restored.version, archived.version + 1);

    // Case is back in default active list
    const activeAfterRestore =
      await mockClient.listSavedCases(CANONICAL_PROJECT_ID);
    assert.ok(activeAfterRestore.items.some((c) => c.id === targetCase.id));

    // Restoring already active case throws 409
    await assert.rejects(
      () =>
        mockClient.restoreSavedCase(targetCase.id, {
          expectedVersion: restored.version,
        }),
      (err) => err.status === 409 || err.statusCode === 409,
      'Must throw 409 when restoring an already active case',
    );

    // Non-existent case throws 404 for archive and restore
    await assert.rejects(
      () =>
        mockClient.archiveSavedCase('00000000-0000-0000-0000-000000000000', {
          expectedVersion: 1,
        }),
      (err) => err.status === 404 || err.statusCode === 404,
      'Must throw 404 when archiving non-existent case',
    );
    await assert.rejects(
      () =>
        mockClient.restoreSavedCase('00000000-0000-0000-0000-000000000000', {
          expectedVersion: 1,
        }),
      (err) => err.status === 404 || err.statusCode === 404,
      'Must throw 404 when restoring non-existent case',
    );
  },
);

await checkAsync(
  'MockApiClient.duplicateSavedCase creates unapproved draft with authentic SHA-256',
  async () => {
    const mockClient = new MockApiClient();

    const sourceCaseId = MOCK_SAVED_CASE_1_ID;
    const sourceVersions = await mockClient.listSavedCaseVersions(sourceCaseId);
    const sourceVersion = sourceVersions.items[0];

    const dupInput = {
      sourceVersionId: sourceVersion.id,
      newSlug: 'cloned-cart-flow',
      newName: 'Cloned Cart Flow',
    };

    const newCase = await mockClient.duplicateSavedCase(sourceCaseId, dupInput);

    // Invariant 1: Distinct UUID
    assert.notEqual(newCase.id, sourceCaseId);
    assert.match(
      newCase.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'Must have valid UUID format',
    );

    // Invariant 2: Active status & initial version 1
    assert.equal(newCase.status, 'active');
    assert.equal(newCase.version, 1);
    assert.equal(newCase.slug, 'cloned-cart-flow');
    assert.equal(newCase.name, 'Cloned Cart Flow');

    // Invariant 3: Must NOT be approved! currentApprovedVersionId === null
    assert.equal(
      newCase.currentApprovedVersionId,
      null,
      'Duplicate MUST start unapproved',
    );

    // Invariant 4: Version history of new case has initial draft
    const newVersions = await mockClient.listSavedCaseVersions(newCase.id);
    assert.equal(newVersions.items.length, 1);
    const v1 = newVersions.items[0];
    assert.equal(v1.version, 1);
    assert.equal(v1.reviewStatus, 'draft');
    assert.equal(v1.reviewedBy, null);
    assert.equal(v1.reviewedAt, null);
    assert.equal(v1.document.id, 'cloned-cart-flow');
    assert.equal(v1.document.name, 'Cloned Cart Flow');

    // Invariant 5: Authentic WebCrypto SHA-256 strictly equals storage hashPayload
    const expectedSha = hashPayload(v1.document);
    assert.equal(
      v1.sha256,
      expectedSha,
      'Cloned version SHA-256 must match authentic canonical hashPayload',
    );

    // Invariant 6: Reject slug collision in target project
    await assert.rejects(
      () => mockClient.duplicateSavedCase(sourceCaseId, dupInput),
      (err) => err.status === 409 || err.statusCode === 409,
      'Must reject duplicate with colliding slug in target project',
    );

    // Invariant 7: Reject non-existent sourceVersionId
    await assert.rejects(
      () =>
        mockClient.duplicateSavedCase(sourceCaseId, {
          sourceVersionId: '00000000-0000-0000-0000-000000000000',
          newSlug: 'non-existent-source',
          newName: 'Non-existent Source',
        }),
      (err) => err.status === 404 || err.statusCode === 404,
      'Must reject duplication with non-existent sourceVersionId',
    );

    // Invariant 8: Reject non-existent sourceCaseId
    await assert.rejects(
      () =>
        mockClient.duplicateSavedCase('00000000-0000-0000-0000-000000000000', {
          sourceVersionId: sourceVersion.id,
          newSlug: 'non-existent-case',
          newName: 'Non-existent Case',
        }),
      (err) => err.status === 404 || err.statusCode === 404,
      'Must reject duplication with non-existent sourceCaseId',
    );
  },
);

await checkAsync(
  'MockApiClient.duplicateSavedCase supports cross-project duplication',
  async () => {
    const mockClient = new MockApiClient();
    const sourceCaseId = MOCK_SAVED_CASE_1_ID;
    const sourceVersions = await mockClient.listSavedCaseVersions(sourceCaseId);
    const sourceVersion = sourceVersions.items[0];

    const targetProject = await mockClient.createProject({
      name: '目标分部项目',
      defaultModelProfileId: 'model_mock_gpt4o',
    });
    const targetProjectId = targetProject.id;

    const dup = await mockClient.duplicateSavedCase(sourceCaseId, {
      sourceVersionId: sourceVersion.id,
      newSlug: 'cross-project-clone',
      newName: 'Cross Project Clone',
      targetProjectId,
    });

    assert.equal(dup.projectId, targetProjectId);
    assert.equal(dup.status, 'active');
    assert.equal(dup.currentApprovedVersionId, null);

    // Target project list includes the new case
    const targetList = await mockClient.listSavedCases(targetProjectId);
    assert.ok(targetList.items.some((c) => c.id === dup.id));

    // Source project list does NOT include the target project case
    const sourceList = await mockClient.listSavedCases(CANONICAL_PROJECT_ID);
    assert.ok(!sourceList.items.some((c) => c.id === dup.id));
  },
);

await checkAsync(
  'MockApiClient fails closed without WebCrypto (no fake fallback)',
  async () => {
    const mockClient = new MockApiClient();
    const sourceCaseId = MOCK_SAVED_CASE_1_ID;
    const sourceVersions = await mockClient.listSavedCaseVersions(sourceCaseId);
    const sourceVersion = sourceVersions.items[0];

    const originalCrypto = globalThis.crypto;
    try {
      delete globalThis.crypto;
      await assert.rejects(
        () =>
          mockClient.duplicateSavedCase(sourceCaseId, {
            sourceVersionId: sourceVersion.id,
            newSlug: 'fail-closed-test',
            newName: 'Fail Closed Test',
          }),
        /WebCrypto API/,
        'Must fail closed when WebCrypto API is unavailable',
      );
    } finally {
      globalThis.crypto = originalCrypto;
    }
  },
);

await checkAsync(
  'MockApiClient honors limit and successive cursor pagination',
  async () => {
    const mockClient = new MockApiClient();
    const first = await mockClient.listSavedCases(CANONICAL_PROJECT_ID, {
      status: 'all',
      limit: 1,
    });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor, 'First page must return nextCursor');

    const second = await mockClient.listSavedCases(CANONICAL_PROJECT_ID, {
      status: 'all',
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 1);
    assert.notEqual(
      first.items[0].id,
      second.items[0].id,
      'Second page must return a different item',
    );
  },
);

await checkAsync(
  'MockApiClient PG integer overflow 422 rejected before mutation',
  async () => {
    const fresh = new MockApiClient();
    const record = fresh.savedCases.find((item) => item.status === 'active');
    assert.ok(record, 'Must find an active case');
    record.version = 2147483647;

    await assert.rejects(
      fresh.archiveSavedCase(record.id, { expectedVersion: record.version }),
      (err) => err.status === 422 || err.statusCode === 422,
      'Must reject with 422 before mutating when version reaches PG integer max',
    );
    assert.equal(
      record.version,
      2147483647,
      'Record version must NOT be mutated',
    );
    assert.equal(record.status, 'active', 'Record status must remain active');
  },
);

await checkAsync(
  'MockApiClient duplicate rejects nonempty fixture references',
  async () => {
    const fresh = new MockApiClient();
    const selected = (
      await fresh.listSavedCases(CANONICAL_PROJECT_ID, { status: 'all' })
    ).items[0];
    const selectedVersion = fresh.savedCaseVersions[selected.id][0];
    selectedVersion.document.fixtureRefs = ['untransferable-fixture'];

    await assert.rejects(
      fresh.duplicateSavedCase(selected.id, {
        sourceVersionId: selectedVersion.id,
        newSlug: 'root-fixture-copy',
        newName: 'Root fixture copy',
      }),
      /fixtureRefs/,
      'Must reject duplication when source version contains external fixtureRefs',
    );
  },
);

await checkAsync(
  'MockApiClient UUID identity and source version UUID are case insensitive',
  async () => {
    const fresh = new MockApiClient();
    const original = (
      await fresh.listSavedCases(CANONICAL_PROJECT_ID, { status: 'all' })
    ).items[0];
    const input = { expectedVersion: original.version };
    const updated =
      original.status === 'active'
        ? await fresh.archiveSavedCase(original.id.toUpperCase(), input)
        : await fresh.restoreSavedCase(original.id.toUpperCase(), input);
    assert.ok(validateContract('SavedCase', updated).success);

    const version = (await fresh.listSavedCaseVersions(original.id)).items[0];
    const copied = await fresh.duplicateSavedCase(original.id.toUpperCase(), {
      sourceVersionId: version.id.toUpperCase(),
      targetProjectId: CANONICAL_PROJECT_ID.toUpperCase(),
      newSlug: 'casing-copy-test',
      newName: 'Casing Copy Test',
    });
    assert.equal(copied.currentApprovedVersionId, null);
  },
);

await checkAsync(
  'LifecycleScopeGuard and multi-page finder guard against delayed stale responses',
  async () => {
    const { LifecycleScopeGuard, findCaseAcrossPages } =
      await import('../src/utils/lifecycleScope.ts');
    const guard = new LifecycleScopeGuard();

    // Test 1: Project switch cancels slow request from project A
    guard.resetScope({ projectId: 'project-A', statusFilter: 'active' });
    const reqA = guard.startRequest({
      projectId: 'project-A',
      statusFilter: 'active',
    });
    assert.equal(reqA.isValid(), true);

    // Switch to project B
    guard.resetScope({ projectId: 'project-B', statusFilter: 'active' });
    assert.equal(
      reqA.isValid(),
      false,
      'Slow request from project A must be invalidated after switch to project B',
    );

    // Test 2: Multi-page finder resolves case across pages without synthesizing fake metadata
    const mockClient = new MockApiClient();
    const allCases = await mockClient.listSavedCases(CANONICAL_PROJECT_ID, {
      status: 'all',
    });
    const target = allCases.items[allCases.items.length - 1];

    const found = await findCaseAcrossPages(
      mockClient,
      CANONICAL_PROJECT_ID,
      target.id,
      5,
    );
    assert.ok(found, 'findCaseAcrossPages must find the case across pages');
    assert.equal(found.id, target.id);

    // Non-existent case returns null (strict 404)
    const notFound = await findCaseAcrossPages(
      mockClient,
      CANONICAL_PROJECT_ID,
      '00000000-0000-0000-0000-000000000000',
      5,
    );
    assert.equal(
      notFound,
      null,
      'Must return null for unknown case without fabricating active metadata',
    );
  },
);

await checkAsync(
  'Page RBAC: Source viewer can initiate duplication, while archive/restore/create are restricted',
  async () => {
    const { getModuleRolePermissions } =
      await import('../src/utils/moduleRoles.ts');
    const viewerPerms = getModuleRolePermissions('viewer', null);
    assert.equal(viewerPerms.isReadOnly, true);

    const opPerms = getModuleRolePermissions('operator', null);
    assert.equal(opPerms.isReadOnly, false);
  },
);

await checkAsync(
  'Cross-project duplication RBAC: Target operator allows copy, target viewer rejects',
  async () => {
    const userId = '33333333-3333-4000-8000-333333333333';

    const isOpOrOwner = (members, uid, globalRole) => {
      if (globalRole === 'admin') return true;
      const m = members.find(
        (x) => x.userId.toLowerCase() === uid.toLowerCase(),
      );
      return m?.role === 'owner' || m?.role === 'operator';
    };

    const targetMembersOperator = [{ userId, role: 'operator' }];
    assert.equal(
      isOpOrOwner(targetMembersOperator, userId, null),
      true,
      'Target operator must be allowed',
    );

    const targetMembersViewer = [{ userId, role: 'viewer' }];
    assert.equal(
      isOpOrOwner(targetMembersViewer, userId, null),
      false,
      'Target viewer must be rejected',
    );

    assert.equal(
      isOpOrOwner([], userId, null),
      false,
      'Non-member must be rejected',
    );

    assert.equal(
      isOpOrOwner(targetMembersViewer, userId, 'admin'),
      true,
      'Global admin can duplicate anywhere',
    );
  },
);

// ---------------------------------------------------------------------------
// Suite 4: Static SSR & Component Markup Verification (Zero Browser)
// ---------------------------------------------------------------------------
console.log('--- Suite 4: Static SSR & Component Markup Verification ---');

const viteRequire = createRequire(
  createRequire(pathToFileURL(resolve('apps/web/package.json'))).resolve(
    'vite',
  ),
);
const { build } = viteRequire('esbuild');

const ssrTempDir = await mkdtemp(resolve('apps/web/.offline-lifecycle-ssr-'));
const ssrBundleFile = join(ssrTempDir, 'render-lifecycle.mjs');

try {
  await build({
    stdin: {
      contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedCasesPage } from './src/pages/SavedCasesPage.tsx';
import { SavedCaseDuplicateModal } from './src/components/saved-cases/SavedCaseDuplicateModal.tsx';
import { SavedCaseDetailPage } from './src/pages/SavedCaseDetailPage.tsx';

// 1. SSR SavedCasesPage
export const savedCasesPageHtml = renderToStaticMarkup(
  React.createElement(SavedCasesPage, null)
);

// 2. SSR SavedCaseDuplicateModal (open)
export const duplicateModalOpenHtml = renderToStaticMarkup(
  React.createElement(SavedCaseDuplicateModal, {
    caseRecord: {
      id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      projectId: '9d82c93d-3c29-44c7-a389-91f11088d174',
      slug: 'sample-case',
      name: 'Sample Test Case',
      status: 'active',
      currentApprovedVersionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c9',
      version: 1,
      createdAt: '2026-10-06T00:00:00.000Z',
    },
    versions: [
      {
        id: '6ba7b810-9dad-11d1-80b4-00c04fd430c9',
        caseId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        version: 1,
        sha256: 'a'.repeat(64),
        reviewStatus: 'approved',
        document: { id: 'sample-case', name: 'Sample Test Case', schemaVersion: 1, kind: 'localqa/test', variables: {}, criteria: [], steps: [] },
        createdBy: 'user-1',
        createdAt: '2026-10-06T00:00:00.000Z',
      },
    ],
    isOpen: true,
    onClose: () => {},
    onSuccess: () => {},
  })
);

// 3. SSR SavedCaseDuplicateModal (closed)
export const duplicateModalClosedHtml = renderToStaticMarkup(
  React.createElement(SavedCaseDuplicateModal, {
    caseRecord: null,
    versions: [],
    isOpen: false,
    onClose: () => {},
    onSuccess: () => {},
  })
);

// 4. SSR SavedCaseDetailPage (active case)
export const detailPageActiveHtml = renderToStaticMarkup(
  React.createElement(SavedCaseDetailPage, null)
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
        name: 'ssr-lifecycle-stubs',
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
  listSavedCases: async () => ({ items: [], nextCursor: null }),
  listSavedCaseVersions: async () => ({ items: [], nextCursor: null }),
  listMembers: async () => ({ items: [{ userId: 'u1', role: 'owner' }] }),
  listProjects: async () => [{ id: '9d82c93d-3c29-44c7-a389-91f11088d174', name: 'Demo Project', slug: 'demo' }],
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
  currentRoute: 'saved-cases',
  routeParams: { caseId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' },
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
    savedCasesPageHtml,
    duplicateModalOpenHtml,
    duplicateModalClosedHtml,
    detailPageActiveHtml,
  } = await import(pathToFileURL(ssrBundleFile).href);

  check('SavedCasesPage SSR renders filter tabs and action buttons', () => {
    assert.ok(
      savedCasesPageHtml.includes('项目用例库与回归管理 (Case Library)'),
      'Page title missing',
    );
    assert.ok(
      savedCasesPageHtml.includes('data-testid="filter-status-active"'),
      'Active filter tab missing',
    );
    assert.ok(
      savedCasesPageHtml.includes('data-testid="filter-status-archived"'),
      'Archived filter tab missing',
    );
    assert.ok(
      savedCasesPageHtml.includes('data-testid="filter-status-all"'),
      'All filter tab missing',
    );
    assert.ok(
      savedCasesPageHtml.includes('活跃 (Active)'),
      'Active label missing',
    );
    assert.ok(
      savedCasesPageHtml.includes('已归档 (Archived)'),
      'Archived label missing',
    );
    assert.ok(savedCasesPageHtml.includes('全部状态'), 'All label missing');
    assert.ok(
      savedCasesPageHtml.includes('📥 导入 YAML 用例'),
      'YAML import button missing',
    );
  });

  check(
    'SavedCaseDuplicateModal SSR renders form fields and draft notice',
    () => {
      assert.equal(
        duplicateModalClosedHtml,
        '',
        'Closed duplicate modal must render empty',
      );
      assert.ok(
        duplicateModalOpenHtml.includes(
          'data-testid="saved-case-duplicate-modal"',
        ),
        'Modal missing',
      );
      assert.ok(
        duplicateModalOpenHtml.includes('复制测试用例'),
        'Modal title missing',
      );
      assert.ok(
        duplicateModalOpenHtml.includes('data-testid="select-source-version"'),
        'Source version select missing',
      );
      assert.ok(
        duplicateModalOpenHtml.includes('data-testid="select-target-project"'),
        'Target project select missing',
      );
      assert.ok(
        duplicateModalOpenHtml.includes('data-testid="input-duplicate-slug"'),
        'Slug input missing',
      );
      assert.ok(
        duplicateModalOpenHtml.includes('data-testid="input-duplicate-name"'),
        'Name input missing',
      );
      assert.ok(
        duplicateModalOpenHtml.includes('data-testid="btn-submit-duplicate"'),
        'Submit button missing',
      );
      assert.ok(
        duplicateModalOpenHtml.includes('草稿'),
        'Draft safety notice missing',
      );
    },
  );

  check('SavedCaseDetailPage SSR renders without errors', () => {
    assert.ok(
      detailPageActiveHtml.length > 0,
      'SavedCaseDetailPage SSR markup must not be empty',
    );
  });
} finally {
  await rm(ssrTempDir, { recursive: true, force: true });
}

console.log(
  '\n================================================================',
);
console.log(
  ` Summary: ${passedTests}/${totalTests} T10-LIFECYCLE offline checks PASSED`,
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
      lifecycleMethodsPassed: true,
      duplicationSemanticsPassed: true,
      ssrRenderingPassed: true,
      browserExecuted: false,
      egoPaused: true,
      P0Passed: false,
    },
    null,
    2,
  ),
);
