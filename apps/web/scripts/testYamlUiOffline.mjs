/**
 * Offline Browserless Test for T10-YAML-UI Contracts, Boundaries, Real Helpers & Mock Safety.
 *
 * Verifies:
 * 1. Generator operation counts & OpenAPI mapping for importSavedCaseYaml & exportSavedCaseYaml (72 operations).
 * 2. Contract validation via validateContract and parseContract for SavedCase, SavedCaseVersion, SavedCaseYamlImport, SavedCaseYamlExport.
 * 3. MockApiClient boundary invariants & Root counter-examples:
 *    - import into selected current mock project remains visible in its list and returnedProjectMatches is true
 *    - mock import produces queryable synthetic draft version in listSavedCaseVersions (valid UUIDs, reviewStatus === 'draft')
 *    - synthetic draft SHA represents the actual synthetic document (strictly equal to shared hashPayload)
 *    - mock import rejects unknown project without silently creating new projects
 *    - mock export preserves target version's actual stored sha256
 * 4. Generated HttpApiClient rejects response if returned versionId does not match requested versionId.
 * 5. Real helper validateYamlImportInput UTF-8 multi-byte byte limit (256 KiB) and DTO char limit (262,144 chars).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  parseContract,
  validateContract,
  publicOperationIds,
} from '@localqa/contracts';
import { hashPayload } from '../../../packages/storage/dist/crypto.js';
import { MockApiClient } from '../src/mocks/mockClient.ts';
import { HttpApiClient } from '../src/api/client.ts';
import {
  validateYamlImportInput,
  getUtf8ByteLength,
  MAX_YAML_BYTES,
  MAX_YAML_CHARS,
} from '../src/utils/yamlValidation.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

console.log('================================================================');
console.log(
  ' T10-YAML-UI Offline Contract, Boundary & Real Helper Verification',
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
  }
}

// ---------------------------------------------------------------------------
// Suite 1: OpenAPI & Generator Operation Count Verification (80 public ops)
// ---------------------------------------------------------------------------
console.log(
  '--- Suite 1: OpenAPI Schema & Operation Count (80 Operations) ---',
);

const openApiRaw = await readFile(`${root}docs/contracts/openapi.json`, 'utf8');
const openApi = JSON.parse(openApiRaw);

const publicOps = [];
for (const [path, methods] of Object.entries(openApi.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (op.tags && op.tags.includes('Internal')) continue;
    publicOps.push({
      operationId: op.operationId,
      path,
      method: method.toUpperCase(),
      requestBodyRef:
        op.requestBody?.content?.['application/json']?.schema?.$ref,
      response200Ref:
        op.responses?.['200']?.content?.['application/json']?.schema?.$ref,
      response201Ref:
        op.responses?.['201']?.content?.['application/json']?.schema?.$ref,
    });
  }
}

check('OpenAPI exposes exactly 80 public operations', () => {
  assert.equal(
    publicOps.length,
    80,
    `Expected 80 public operations in openapi.json, found ${publicOps.length}`,
  );
});

check('contracts package publicOperationIds contains 80 operations', () => {
  assert.equal(publicOperationIds.length, 80);
  assert.ok(publicOperationIds.includes('importSavedCaseYaml'));
  assert.ok(publicOperationIds.includes('exportSavedCaseYaml'));
  assert.ok(publicOperationIds.includes('createRegressionModule'));
  assert.ok(publicOperationIds.includes('listRegressionModules'));
  assert.ok(publicOperationIds.includes('listRegressionModuleVersions'));
  assert.ok(publicOperationIds.includes('previewRegressionModuleReview'));
  assert.ok(publicOperationIds.includes('reviewRegressionModuleVersion'));
});

check(
  'POST /projects/{projectId}/saved-cases/import endpoint contract is correct',
  () => {
    const op = publicOps.find((o) => o.operationId === 'importSavedCaseYaml');
    assert.ok(op, 'importSavedCaseYaml operation must exist');
    assert.equal(op.method, 'POST');
    assert.equal(op.path, '/api/v1/projects/{projectId}/saved-cases/import');
    assert.ok(op.requestBodyRef?.includes('SavedCaseYamlImport'));
    assert.ok(op.response201Ref?.includes('SavedCase'));
  },
);

check(
  'GET /saved-case-versions/{versionId}/yaml endpoint contract is correct',
  () => {
    const op = publicOps.find((o) => o.operationId === 'exportSavedCaseYaml');
    assert.ok(op, 'exportSavedCaseYaml operation must exist');
    assert.equal(op.method, 'GET');
    assert.equal(op.path, '/api/v1/saved-case-versions/{versionId}/yaml');
    assert.ok(op.response200Ref?.includes('SavedCaseYamlExport'));
  },
);

// ---------------------------------------------------------------------------
// Suite 2: Contract Conformance & Boundary Rejection via validateContract
// ---------------------------------------------------------------------------
console.log('\n--- Suite 2: Contract Conformance & Boundary Rejection ---');

check('SavedCaseYamlImport accepts valid payload', () => {
  const payload = {
    slug: 'checkout-smoke-test',
    name: '冒烟测试结算流程',
    yaml: 'schemaVersion: 1\nkind: localqa/test\nsteps:\n  - kind: navigate\n',
  };
  const validated = parseContract('SavedCaseYamlImport', payload);
  assert.deepEqual(validated, payload);
});

check('SavedCaseYamlImport rejects yaml exceeding 262144 characters', () => {
  const payload = {
    slug: 'big-case',
    name: '超长用例',
    yaml: 'a'.repeat(262145),
  };
  const result = validateContract('SavedCaseYamlImport', payload);
  assert.equal(result.success, false);
});

check('SavedCaseYamlImport accepts yaml exactly at 262144 characters', () => {
  const payload = {
    slug: 'boundary-case',
    name: '极限边界用例',
    yaml: 'b'.repeat(262144),
  };
  const result = validateContract('SavedCaseYamlImport', payload);
  assert.equal(result.success, true);
});

check(
  'SavedCaseYamlImport rejects invalid slug format (spaces and symbols)',
  () => {
    const payload = {
      slug: 'Invalid Slug With Spaces!',
      name: '非法字符用例',
      yaml: 'valid: true\n',
    };
    const result = validateContract('SavedCaseYamlImport', payload);
    assert.equal(result.success, false);
  },
);

check('SavedCaseYamlExport accepts valid immutable version payload', () => {
  const payload = {
    versionId: '123e4567-e89b-12d3-a456-426614174000',
    sourceDocumentSha256:
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    yaml: 'name: "immutable test"\n',
  };
  const validated = parseContract('SavedCaseYamlExport', payload);
  assert.deepEqual(validated, payload);
});

check('SavedCaseYamlExport rejects non-hex or non-64-char sha256', () => {
  const payload = {
    versionId: '123e4567-e89b-12d3-a456-426614174000',
    sourceDocumentSha256: 'NOT_HEX_STRING_TOO_SHORT',
    yaml: 'name: "bad sha test"\n',
  };
  const result = validateContract('SavedCaseYamlExport', payload);
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Suite 3: MockApiClient Public Method Flow & Root Counter-Examples
// ---------------------------------------------------------------------------
console.log(
  '\n--- Suite 3: MockApiClient Public Method Flow & Root Counter-Examples ---',
);

const mockClient = new MockApiClient();

await checkAsync(
  'import into selected current mock project remains visible in its list (listProjects -> import -> listSavedCases)',
  async () => {
    const projects = await mockClient.listProjects();
    assert.ok(projects.items.length > 0, 'Must have at least one mock project');
    const currentProject = projects.items[0];

    const created = await mockClient.importSavedCaseYaml(currentProject.id, {
      slug: 'selected-proj-yaml-case',
      name: '当前项目导入用例',
      yaml: 'steps: []\n',
    });

    // 1. Project identity must strictly match selected project (returnedProjectMatches === true)
    assert.equal(
      created.projectId,
      currentProject.id,
      'created.projectId must strictly match currentProject.id',
    );

    // 2. Validate canonical SavedCase contract
    const caseValidation = validateContract('SavedCase', created);
    assert.equal(
      caseValidation.success,
      true,
      `validateContract SavedCase failed: ${JSON.stringify(caseValidation.issues)}`,
    );
    assert.equal(
      created.currentApprovedVersionId,
      null,
      'Must be unapproved draft',
    );
    assert.equal(created.status, 'active');
    assert.equal(created.version, 1);

    // 3. Must be visible in listSavedCases(currentProject.id)
    const casesPage = await mockClient.listSavedCases(currentProject.id);
    const found = casesPage.items.find((c) => c.id === created.id);
    assert.ok(
      found,
      'Newly imported case must be visible in listSavedCases for the selected project',
    );
    assert.equal(found.projectId, currentProject.id);
  },
);

await checkAsync(
  'synthetic draft SHA represents the actual synthetic document (hashPayload consistency)',
  async () => {
    const projects = await mockClient.listProjects();
    const currentProject = projects.items[0];

    const created = await mockClient.importSavedCaseYaml(currentProject.id, {
      slug: 'canonical-sha-verification-case',
      name: '规范 SHA 验证用例',
      yaml: 'steps:\n  - kind: assert\n',
    });

    const versionsPage = await mockClient.listSavedCaseVersions(created.id);
    assert.equal(
      versionsPage.items.length,
      1,
      'Draft version must be queryable',
    );
    const draftVersion = versionsPage.items[0];

    // Validate canonical SavedCaseVersion contract
    const verValidation = validateContract('SavedCaseVersion', draftVersion);
    assert.equal(
      verValidation.success,
      true,
      `validateContract SavedCaseVersion failed: ${JSON.stringify(verValidation.issues)}`,
    );
    assert.equal(draftVersion.reviewStatus, 'draft');
    assert.equal(draftVersion.version, 1);

    // Canonical SHA consistency: draftVersion.sha256 must strictly equal hashPayload(draftVersion.document)
    const expectedSha = hashPayload(draftVersion.document);
    assert.equal(
      draftVersion.sha256,
      expectedSha,
      'draftVersion.sha256 must strictly equal hashPayload of the actual synthetic document',
    );
  },
);

await checkAsync(
  'MockApiClient.importSavedCaseYaml rejects unknown project without silently creating new project',
  async () => {
    await assert.rejects(
      () =>
        mockClient.importSavedCaseYaml('00000000-0000-0000-0000-999999999999', {
          slug: 'unknown-project-case',
          name: '未知项目用例',
          yaml: 'steps: []\n',
        }),
      /项目不存在/,
    );
  },
);

await checkAsync(
  'MockApiClient.exportSavedCaseYaml preserves selected version stored source SHA',
  async () => {
    const projects = await mockClient.listProjects();
    const currentProject = projects.items[0];

    const testCase = await mockClient.importSavedCaseYaml(currentProject.id, {
      slug: 'sha-preservation-case',
      name: 'SHA 保留验证用例',
      yaml: 'steps:\n  - kind: assert\n',
    });

    const versionsPage = await mockClient.listSavedCaseVersions(testCase.id);
    assert.ok(versionsPage.items.length > 0);
    const targetVer = versionsPage.items[0];

    const exported = await mockClient.exportSavedCaseYaml(targetVer.id);
    assert.equal(exported.versionId, targetVer.id);
    assert.equal(
      exported.sourceDocumentSha256,
      targetVer.sha256,
      'Exported sourceDocumentSha256 must strictly equal target version sha256',
    );
  },
);

await checkAsync(
  'MockApiClient.exportSavedCaseYaml dynamically tracks modified version sha256',
  async () => {
    const projects = await mockClient.listProjects();
    const currentProject = projects.items[0];

    const testCase = await mockClient.importSavedCaseYaml(currentProject.id, {
      slug: 'sha-dynamic-test',
      name: '动态 SHA 测试',
      yaml: 'steps:\n  - kind: assert\n',
    });

    const versionsPage = await mockClient.listSavedCaseVersions(testCase.id);
    const targetVer = versionsPage.items[0];
    const customSha =
      '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
    targetVer.sha256 = customSha;

    const exported = await mockClient.exportSavedCaseYaml(targetVer.id);
    assert.equal(
      exported.sourceDocumentSha256,
      customSha,
      'Must not return hardcoded SHA',
    );
  },
);

await checkAsync(
  'MockApiClient.importSavedCaseYaml enforces character length limit <= 262144',
  async () => {
    const projects = await mockClient.listProjects();
    const currentProject = projects.items[0];

    await assert.rejects(
      () =>
        mockClient.importSavedCaseYaml(currentProject.id, {
          slug: 'too-big',
          name: '超长用例',
          yaml: 'x'.repeat(262145),
        }),
      /exceeds maximum 262144 characters/,
    );
  },
);

await checkAsync(
  'MockApiClient.importSavedCaseYaml rejects empty fields',
  async () => {
    const projects = await mockClient.listProjects();
    const currentProject = projects.items[0];

    await assert.rejects(
      () =>
        mockClient.importSavedCaseYaml(currentProject.id, {
          slug: '   ',
          name: '有效名称',
          yaml: 'yaml: true',
        }),
      /slug cannot be empty/,
    );
    await assert.rejects(
      () =>
        mockClient.importSavedCaseYaml(currentProject.id, {
          slug: 'valid-slug',
          name: '',
          yaml: 'yaml: true',
        }),
      /name cannot be empty/,
    );
  },
);

await checkAsync(
  'MockApiClient.exportSavedCaseYaml throws on non-existent versionId',
  async () => {
    await assert.rejects(
      () =>
        mockClient.exportSavedCaseYaml('00000000-0000-0000-0000-000000000000'),
      /SavedCaseVersion not found/,
    );
  },
);

await checkAsync(
  'legacy project compatibility returns canonical identity and stays queryable',
  async () => {
    const projects = await mockClient.listProjects();
    const canonicalProject = projects.items[0];
    const legacy = 'proj_mock_ecommerce_01';

    const item = await mockClient.importSavedCaseYaml(legacy, {
      slug: 'legacy-compat-case',
      name: '兼容模式测试用例',
      yaml: 'steps: []\n',
    });

    assert.equal(
      item.projectId,
      canonicalProject.id,
      'Must return canonical project UUID',
    );
    assert.ok(
      validateContract('SavedCase', item).success,
      'Must conform to SavedCase contract with valid UUID',
    );

    const legacyList = await mockClient.listSavedCases(legacy);
    assert.ok(
      legacyList.items.some((c) => c.id === item.id),
      'Must be queryable via legacy project ID',
    );

    const canonicalList = await mockClient.listSavedCases(canonicalProject.id);
    assert.ok(
      canonicalList.items.some((c) => c.id === item.id),
      'Must be queryable via canonical project ID',
    );
  },
);

await checkAsync(
  'listSchedules and listApiKeys fixtures are visible via both legacy and canonical project ID',
  async () => {
    const projects = await mockClient.listProjects();
    const canonicalProject = projects.items[0];
    const legacy = 'proj_mock_ecommerce_01';

    for (const method of ['listSchedules', 'listApiKeys']) {
      const legacyItems = (await mockClient[method](legacy)).items;
      const canonicalItems = (await mockClient[method](canonicalProject.id))
        .items;
      assert.ok(
        legacyItems.length > 0,
        `Baseline fixtures exist for ${method}`,
      );
      assert.equal(
        canonicalItems.length,
        legacyItems.length,
        `Counts match between legacy and canonical for ${method}`,
      );
      assert.deepEqual(
        canonicalItems.map((x) => x.id),
        legacyItems.map((x) => x.id),
        `Item IDs match for ${method}`,
      );
    }
  },
);

await checkAsync(
  'missing WebCrypto and digest rejection reject import without persistence or fake SHA',
  async () => {
    const projects = await mockClient.listProjects();
    const currentProject = projects.items[0];

    for (const [mode, value] of [
      ['missing WebCrypto', undefined],
      [
        'digest rejection',
        {
          subtle: {
            async digest() {
              throw new Error('injected digest failure');
            },
          },
        },
      ],
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
      const beforeCount = (await mockClient.listSavedCases(currentProject.id))
        .items.length;
      try {
        Object.defineProperty(globalThis, 'crypto', {
          value,
          writable: true,
          configurable: true,
        });
        await assert.rejects(
          mockClient.importSavedCaseYaml(currentProject.id, {
            slug: `hash-fail-${mode.replace(/\s+/g, '-')}`,
            name: 'Fail Case',
            yaml: 'steps: []\n',
          }),
        );
      } finally {
        if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
        else delete globalThis.crypto;
      }
      const afterCount = (await mockClient.listSavedCases(currentProject.id))
        .items.length;
      assert.equal(afterCount, beforeCount, `Zero state persisted on ${mode}`);
    }
  },
);

// ---------------------------------------------------------------------------
// Suite 4: Generated HttpApiClient Injected Response Verification
// ---------------------------------------------------------------------------
console.log(
  '\n--- Suite 4: Generated Client Version Binding & Mismatch Rejection ---',
);

await checkAsync(
  'generated export client rejects a response for a different selected version',
  async () => {
    const originalFetch = globalThis.fetch;
    const requestedVersionId = '123e4567-e89b-12d3-a456-426614174000';
    const injectedDifferentVersionId = '987fcdeb-51a2-43d7-b890-123456789abc';

    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            versionId: injectedDifferentVersionId,
            sourceDocumentSha256:
              '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            yaml: 'steps: []\n',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );

      const client = new HttpApiClient('http://localhost:3000/api/v1');
      await assert.rejects(
        () => client.exportSavedCaseYaml(requestedVersionId),
        /Exported version mismatch/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

await checkAsync(
  'generated export client accepts matching response with valid SavedCaseYamlExport',
  async () => {
    const originalFetch = globalThis.fetch;
    const targetVersionId = '123e4567-e89b-12d3-a456-426614174000';

    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            versionId: targetVersionId,
            sourceDocumentSha256:
              '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            yaml: 'steps: []\n',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );

      const client = new HttpApiClient('http://localhost:3000/api/v1');
      const result = await client.exportSavedCaseYaml(targetVersionId);
      assert.equal(result.versionId, targetVersionId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

// ---------------------------------------------------------------------------
// Suite 5: Real Helper validateYamlImportInput UTF-8 & Size Pre-flight
// ---------------------------------------------------------------------------
console.log(
  '\n--- Suite 5: Real Helper validateYamlImportInput (UTF-8 Bytes & Length) ---',
);

check('validateYamlImportInput accepts valid ASCII payload', () => {
  const res = validateYamlImportInput({
    slug: 'checkout-flow',
    name: '结算流程',
    yaml: 'steps:\n  - kind: navigate\n',
  });
  assert.equal(res.valid, true);
  assert.equal(res.isByteOverLimit, false);
  assert.equal(res.isCharOverLimit, false);
});

check(
  'validateYamlImportInput accepts valid UTF-8 Chinese payload under 256 KiB',
  () => {
    const chineseText = '测试中文步骤说明: 验证主界面加载完成\n'.repeat(100);
    const res = validateYamlImportInput({
      slug: 'chinese-flow',
      name: '中文测试用例',
      yaml: chineseText,
    });
    assert.equal(res.valid, true);
    assert.equal(res.isByteOverLimit, false);
  },
);

check(
  'validateYamlImportInput rejects multi-byte UTF-8 when byte size exceeds 256 KiB (char count < 262144)',
  () => {
    // Chinese characters are 3 bytes in UTF-8. 90,000 characters = 270,000 bytes > 262,144 bytes,
    // but 90,000 characters < 262,144 characters!
    const longChineseText = '测'.repeat(90000);
    assert.ok(
      longChineseText.length < MAX_YAML_CHARS,
      'Char length must be under 262,144',
    );
    assert.ok(
      getUtf8ByteLength(longChineseText) > MAX_YAML_BYTES,
      'Byte length must exceed 262,144',
    );

    const res = validateYamlImportInput({
      slug: 'chinese-overflow',
      name: '中文超限用例',
      yaml: longChineseText,
    });
    assert.equal(res.valid, false);
    assert.equal(res.isByteOverLimit, true);
    assert.ok(res.errors.yaml?.includes('256 KiB'));
  },
);

check(
  'validateYamlImportInput rejects character count exceeding 262144 chars',
  () => {
    const overCharText = 'a'.repeat(262145);
    const res = validateYamlImportInput({
      slug: 'char-overflow',
      name: '字符超限用例',
      yaml: overCharText,
    });
    assert.equal(res.valid, false);
    assert.equal(res.isCharOverLimit, true);
  },
);

check(
  'validateYamlImportInput catches invalid slug and empty name simultaneously',
  () => {
    const res = validateYamlImportInput({
      slug: 'Bad Slug Spaces!',
      name: '',
      yaml: 'steps: []',
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.slug);
    assert.ok(res.errors.name);
  },
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(
  '\n================================================================',
);
console.log(
  ` Summary: ${passedTests}/${totalTests} T10-YAML-UI offline checks PASSED`,
);
console.log(
  '================================================================\n',
);

if (passedTests !== totalTests) {
  process.exit(1);
}
