import assert from 'node:assert/strict';
import { before, after, test as nodeTest } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connect } from 'node:net';
import pg from 'pg';
import {
  Database,
  migrate,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  SecretVault,
  hashPayload,
} from '@localqa/storage';
import { createApiContext, createApiServer } from '../dist/index.js';

const tag = randomUUID();
const dir = mkdtempSync(join(tmpdir(), 'localqa-t10-yaml-'));
const facts = {
  task: 'T10-YAML-1',
  tag,
  evidenceDir: dir,
  tests: [],
  modelTransportCalls: 0,
  ownership: { containerId: null, volumes: [] },
  limitations: [
    'PG/API admission only; no browser, Worker.once, worker-entry or real model',
    'Import creates draft only; execution blocked until approved review',
    'FakeBrowser and real model acceptance still unverified; P0=false',
  ],
};
const ownershipPath = join(dir, 'ownership.json');
function saveEvidence() {
  writeFileSync(
    ownershipPath,
    JSON.stringify(facts.ownership, null, 2) + '\n',
    {
      mode: 0o600,
    },
  );
}
function test(name, fn) {
  nodeTest(name, async () => {
    try {
      await fn();
      facts.tests.push({ name, passed: true });
    } catch (error) {
      facts.tests.push({
        name,
        passed: false,
        code: error.code ?? 'TEST_FAILED',
        message: error.message,
      });
      throw error;
    }
  });
}

let db,
  context,
  server,
  actor,
  project,
  otherProject,
  cookie,
  viewerCookie,
  url,
  pgPort,
  apiPort;
const envFile = join(dir, 'pg.env');
const kekFile = join(dir, 'kek.json');

async function request(path, body, userCookie = cookie, key = randomUUID()) {
  const response = await fetch(`${url}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Cookie: userCookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function portClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error('port recheck timed out'));
    });
  });
}

before(async () => {
  console.log(`[T10-YAML evidence] ${dir}`);
  saveEvidence();
  const password = randomBytes(24).toString('hex');
  writeFileSync(
    envFile,
    `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  const launched = spawnSync(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      `localqa-t10-yaml-${tag}`,
      '--publish',
      '127.0.0.1::5432',
      '--env-file',
      envFile,
      'postgres:16-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(launched.status, 0, launched.stderr);
  facts.ownership.containerId = launched.stdout.trim();
  assert.match(facts.ownership.containerId, /^[a-f0-9]{64}$/);
  saveEvidence();

  const inspect = spawnSync(
    'docker',
    ['inspect', facts.ownership.containerId],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(inspect.status, 0);
  facts.ownership.volumes = JSON.parse(inspect.stdout)[0]
    .Mounts.filter((mount) => mount.Type === 'volume')
    .map((mount) => mount.Name);

  const portResult = spawnSync(
    'docker',
    ['port', facts.ownership.containerId, '5432/tcp'],
    { encoding: 'utf8' },
  );
  assert.equal(portResult.status, 0);
  pgPort = Number(portResult.stdout.trim().split(':').at(-1));
  assert.ok(pgPort > 0);
  facts.ownership.pgPort = pgPort;
  saveEvidence();

  const connection = `postgres://localqa:${password}@127.0.0.1:${pgPort}/localqa`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      await migrate(
        connection,
        new URL('../../../packages/storage/migrations/', import.meta.url),
      );
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, 'migrations ready');

  writeFileSync(
    kekFile,
    JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    }),
    { mode: 0o600 },
  );
  const vault = await SecretVault.fromProtectedFile(kekFile);
  db = new Database(connection);

  const accounts = new AccountsRepository(db);
  const adminUser = await accounts.bootstrap({
    email: `yaml-admin-${tag}@localqa.test`,
    displayName: 'YAML Admin',
    password: 'YamlPassword123!',
  });
  actor = { userId: adminUser.id };

  const viewerUser = await accounts.create(actor, {
    email: `yaml-viewer-${tag}@localqa.test`,
    displayName: 'YAML Viewer',
    password: 'ViewerPassword123!',
    globalRole: 'member',
  });

  const projects = new ProjectRepository(db);
  project = await projects.create(actor, { name: `YAML Project ${tag}` });
  otherProject = await projects.create(actor, {
    name: `Other YAML Project ${tag}`,
  });

  // Assign viewer role in project
  await db.actor(actor, async (client) => {
    await client.query(
      "INSERT INTO project_members(project_id, user_id, role) VALUES($1, $2, 'viewer')",
      [project.id, viewerUser.id],
    );
  });

  const model = await new ModelRepository(db, vault).create(actor, {
    name: 'Never called',
    endpoint: 'https://unused.example.test/v1',
    configuredModelId: 'unused',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
  });
  project = await projects.update(actor, project.id, {
    expectedVersion: project.version,
    defaultModelProfileId: model.id,
  });

  // Register an approved module in the project for module-ref tests
  const childDoc = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: 'child-mod',
    name: 'Approved Child Module',
    variables: {},
    criteria: [
      {
        id: 'mod-crit',
        kind: 'element_visible',
        description: 'Module element visible',
        sourceKind: 'user_spec',
        sourceRef: 'module',
        locator: { by: 'test_id', value: 'mod-loaded' },
      },
    ],
    steps: [
      { kind: 'navigate', url: 'http://localhost:8080/module' },
      { kind: 'assert', criterionId: 'mod-crit' },
    ],
  };
  const childSha = hashPayload(childDoc);
  const superClient = new pg.Client({ connectionString: connection });
  await superClient.connect();
  try {
    await superClient.query(
      "INSERT INTO regression_module_versions(project_id, name, version, sha256, document, review_status) VALUES($1, 'approvedMod', 1, $2, $3, 'approved')",
      [project.id, childSha, childDoc],
    );
  } finally {
    await superClient.end();
  }

  context = createApiContext({
    connectionString: connection,
    vault,
    serviceActor: actor,
    artifactsDir: join(dir, 'artifacts'),
    publicOrigin: 'http://localhost',
    modelTransport: async () => {
      facts.modelTransportCalls++;
      throw new Error('External model calls forbidden');
    },
  });

  server = createApiServer(context);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiPort = server.address().port;
  url = `http://127.0.0.1:${apiPort}`;
  facts.ownership.apiPort = apiPort;
  facts.ownership.apiPid = process.pid;
  saveEvidence();

  // Acquire admin cookie
  const loginRes = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: adminUser.email,
      password: 'YamlPassword123!',
    }),
  });
  assert.equal(loginRes.status, 200);
  cookie = loginRes.headers.get('set-cookie').split(';')[0];

  // Acquire viewer cookie
  const vLoginRes = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: viewerUser.email,
      password: 'ViewerPassword123!',
    }),
  });
  assert.equal(vLoginRes.status, 200);
  viewerCookie = vLoginRes.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  if (server)
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  await context?.db.close();
  await db?.close();

  const cleanup = { apiClosed: !server?.listening };
  if (facts.ownership.containerId) {
    const removed = spawnSync(
      'docker',
      ['rm', '--force', '--volumes', facts.ownership.containerId],
      { encoding: 'utf8' },
    );
    cleanup.removeStatus = removed.status;
    const checked = spawnSync(
      'docker',
      ['container', 'inspect', facts.ownership.containerId],
      { encoding: 'utf8' },
    );
    cleanup.containerAbsent =
      checked.status !== 0 && /no such container/i.test(checked.stderr);
    cleanup.volumes = facts.ownership.volumes.map((id) => {
      const result = spawnSync('docker', ['volume', 'inspect', id], {
        encoding: 'utf8',
      });
      return {
        id,
        absent: result.status !== 0 && /no such volume/i.test(result.stderr),
      };
    });
  }

  rmSync(envFile, { force: true });
  rmSync(kekFile, { force: true });
  cleanup.credentialsAbsent = !existsSync(envFile) && !existsSync(kekFile);
  if (pgPort) cleanup.pgPortClosed = await portClosed(pgPort);
  if (apiPort) cleanup.apiPortClosed = await portClosed(apiPort);
  facts.ownership.cleanup = cleanup;
  saveEvidence();

  facts.summary = {
    passed: facts.tests.filter((item) => item.passed).length,
    failed: facts.tests.filter((item) => !item.passed).length,
  };
  const results = new URL(
    `../../../docs/validation-results/T10-YAML-1-${tag}.json`,
    import.meta.url,
  );
  writeFileSync(results, JSON.stringify(facts, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    join(dir, 'results.json'),
    JSON.stringify(facts, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(`[T10-YAML results] ${results.pathname}`);

  assert.equal(cleanup.credentialsAbsent, true);
  if (facts.ownership.containerId) {
    assert.equal(cleanup.removeStatus, 0);
    assert.equal(cleanup.containerAbsent, true);
    assert.ok(cleanup.volumes.every((item) => item.absent));
  }
  if (pgPort) assert.equal(cleanup.pgPortClosed, true);
  if (apiPort) assert.equal(cleanup.apiPortClosed, true);
  assert.equal(facts.modelTransportCalls, 0);
});

test('valid Chinese text, variables, all five canonical locator strategies, and module refs roundtrip', async () => {
  const yamlContent = `schemaVersion: 1
kind: localqa/test
id: yaml-roundtrip-test
name: 完整中文测试用例 & 特殊符号 * 结账流程
variables:
  API_URL: http://localhost:8080/api
  TIMEOUT: 5000
criteria:
  - id: title-check
    kind: element_visible
    description: 页面标题 & 导航可见 *
    sourceKind: user_spec
    sourceRef: smoke
    locator:
      by: test_id
      value: main-title
  - id: role-button
    kind: element_visible
    description: 登录按钮角色可见
    sourceKind: user_spec
    sourceRef: smoke
    locator:
      by: role
      value: button
      name: 登录
  - id: label-input
    kind: element_visible
    description: 用户名输入框
    sourceKind: user_spec
    sourceRef: smoke
    locator:
      by: label
      value: 用户名
  - id: text-match
    kind: element_visible
    description: 版权文字
    sourceKind: user_spec
    sourceRef: smoke
    locator:
      by: text
      value: "© 2026 LocalQA & Co.*"
  - id: css-check
    kind: element_visible
    description: CSS容器元素
    sourceKind: user_spec
    sourceRef: smoke
    locator:
      by: css
      value: "div#root"
steps:
  - kind: navigate
    url: "{{env.BASE_URL}}/checkout"
  - kind: assert
    criterionId: title-check
  - kind: click
    locator:
      by: test_id
      value: cart-submit
  - kind: type_text
    locator:
      by: css
      value: 'input[name="notes"]'
    text: "请加急处理 & 注意包裹 *"
  - kind: module
    ref: approvedMod@1
    arguments:
      CURRENCY: CNY
      AMOUNT: 99
  - kind: ai_action
    goal: "确认最终订单详情并核对支付结果 & 发票 *"
    criteriaIds:
      - title-check
      - text-match
`;

  // 1. Import YAML
  const imported = await request(`/projects/${project.id}/saved-cases/import`, {
    slug: `yaml-test-${tag}`,
    name: 'YAML Roundtrip Case',
    yaml: yamlContent,
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.slug, `yaml-test-${tag}`);
  assert.equal(imported.body.name, 'YAML Roundtrip Case');
  assert.equal(imported.body.status, 'active');
  assert.equal(imported.body.currentApprovedVersionId, null);

  // 2. Verify stored draft version and SHA
  const versionsRes = await request(
    `/saved-cases/${imported.body.id}/versions`,
  );
  assert.equal(versionsRes.status, 200);
  const version = versionsRes.body.items[0];
  assert.equal(version.reviewStatus, 'draft');
  assert.equal(version.version, 1);
  const storedSha = version.sha256;

  // 3. Export YAML
  const exported = await request(`/saved-case-versions/${version.id}/yaml`);
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.versionId, version.id);
  assert.equal(exported.body.sourceDocumentSha256, storedSha);
  assert.ok(
    exported.body.yaml.includes('完整中文测试用例 & 特殊符号 * 结账流程'),
  );
  assert.ok(exported.body.yaml.includes('approvedMod@1'));

  // 4. Re-import exported YAML into another case and verify byte-for-byte canonical SHA match
  const reimported = await request(
    `/projects/${project.id}/saved-cases/import`,
    {
      slug: `yaml-reimport-${tag}`,
      name: 'Reimported YAML Case',
      yaml: exported.body.yaml,
    },
  );
  assert.equal(reimported.status, 201);
  const reVersions = await request(
    `/saved-cases/${reimported.body.id}/versions`,
  );
  const reVersion = reVersions.body.items[0];
  assert.equal(reVersion.sha256, storedSha);
});

test('HTTP viewer and cross-project isolation for import and export', async () => {
  const yamlContent = `schemaVersion: 1
kind: localqa/test
id: viewer-isolation-test
name: 权限隔离测试
variables: {}
criteria:
  - id: c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: body
steps:
  - kind: navigate
    url: http://localhost:8080/
  - kind: assert
    criterionId: c1
`;

  // 1. Viewer cannot import into project (requires operator) -> 403 FORBIDDEN
  const viewerImport = await request(
    `/projects/${project.id}/saved-cases/import`,
    { slug: `v-import-${tag}`, name: 'Viewer Import', yaml: yamlContent },
    viewerCookie,
  );
  assert.equal(viewerImport.status, 403);
  assert.equal(viewerImport.body.code, 'FORBIDDEN');

  // 2. Admin imports a case
  const adminImport = await request(
    `/projects/${project.id}/saved-cases/import`,
    { slug: `adm-imp-${tag}`, name: 'Admin Import', yaml: yamlContent },
  );
  assert.equal(adminImport.status, 201);
  const versions = await request(
    `/saved-cases/${adminImport.body.id}/versions`,
  );
  const versionId = versions.body.items[0].id;

  // 3. Viewer CAN export YAML from project where they are a member -> 200 OK
  const viewerExport = await request(
    `/saved-case-versions/${versionId}/yaml`,
    null,
    viewerCookie,
  );
  assert.equal(viewerExport.status, 200);
  assert.equal(viewerExport.body.versionId, versionId);

  // 4. Cross-project isolation: non-member of otherProject cannot import -> 404 NOT_FOUND
  const crossImport = await request(
    `/projects/${otherProject.id}/saved-cases/import`,
    { slug: `cross-imp-${tag}`, name: 'Cross Import', yaml: yamlContent },
    viewerCookie,
  );
  assert.equal(crossImport.status, 404);
  assert.equal(crossImport.body.code, 'NOT_FOUND');

  // 5. Cross-project isolation: non-member queries existing version in another project -> 404 NOT_FOUND
  // Create version in otherProject first as admin
  const otherImport = await request(
    `/projects/${otherProject.id}/saved-cases/import`,
    { slug: `oth-imp-${tag}`, name: 'Other Import', yaml: yamlContent },
  );
  assert.equal(otherImport.status, 201);
  const otherVersions = await request(
    `/saved-cases/${otherImport.body.id}/versions`,
  );
  const otherVersionId = otherVersions.body.items[0].id;

  const crossExport = await request(
    `/saved-case-versions/${otherVersionId}/yaml`,
    null,
    viewerCookie,
  );
  assert.equal(crossExport.status, 404);
  assert.equal(crossExport.body.code, 'NOT_FOUND');
});

test('parser negative cases: duplicate keys, multi-docs, dangerous keys, tags, depth, anchors, unknown fields/steps/version/locators and zero persistence', async () => {
  const negativeSlugs = [];
  const baseValid = `schemaVersion: 1
kind: localqa/test
id: base-neg-test
name: 基础负例用例
variables: {}
criteria:
  - id: c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: body
steps:
  - kind: navigate
    url: http://localhost:8080/
  - kind: assert
    criterionId: c1
`;

  // 1. Duplicate keys in mapping
  const dupKeys = `schemaVersion: 1
kind: localqa/test
id: dup-test
id: dup-test-2
name: 重复键测试
variables: {}
criteria:
  - id: c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: body
steps:
  - kind: navigate
    url: http://localhost:8080/
`;
  const slugDup = `dup-${randomUUID()}`;
  negativeSlugs.push(slugDup);
  const resDup = await request(`/projects/${project.id}/saved-cases/import`, {
    slug: slugDup,
    name: 'Duplicate Keys',
    yaml: dupKeys,
  });
  assert.equal(resDup.status, 422, JSON.stringify(resDup.body));
  assert.equal(resDup.body.code, 'VALIDATION_ERROR');

  // 2. Multiple documents
  const multiDoc = `${baseValid}\n---\n${baseValid}`;
  const slugMulti = `multi-${randomUUID()}`;
  negativeSlugs.push(slugMulti);
  const resMulti = await request(`/projects/${project.id}/saved-cases/import`, {
    slug: slugMulti,
    name: 'Multi Doc',
    yaml: multiDoc,
  });
  assert.equal(resMulti.status, 422, JSON.stringify(resMulti.body));
  assert.equal(resMulti.body.code, 'VALIDATION_ERROR');

  // 3. Dangerous object keys (__proto__, constructor, prototype)
  for (const dangerousKey of ['__proto__', 'constructor', 'prototype']) {
    const dangerYaml = `${baseValid}\n${dangerousKey}: { hacked: true }\n`;
    const slugDanger = `danger-${randomUUID()}`;
    negativeSlugs.push(slugDanger);
    const resDanger = await request(
      `/projects/${project.id}/saved-cases/import`,
      {
        slug: slugDanger,
        name: 'Dangerous Key',
        yaml: dangerYaml,
      },
    );
    assert.equal(resDanger.status, 422, JSON.stringify(resDanger.body));
    assert.equal(resDanger.body.code, 'VALIDATION_ERROR');
  }

  // 4. Unknown executable tags (!exec, !js/eval, !custom)
  for (const tagSample of [
    '!exec "rm -rf /"',
    '!js/eval "1+1"',
    '!custom tag',
  ]) {
    const tagYaml = `schemaVersion: 1
kind: localqa/test
id: tag-test
name: ${tagSample}
variables: {}
criteria:
  - id: c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: body
steps:
  - kind: navigate
    url: http://localhost:8080/
`;
    const slugTag = `tag-${randomUUID()}`;
    negativeSlugs.push(slugTag);
    const resTag = await request(`/projects/${project.id}/saved-cases/import`, {
      slug: slugTag,
      name: 'Custom Tag',
      yaml: tagYaml,
    });
    assert.equal(resTag.status, 422, JSON.stringify(resTag.body));
    assert.equal(resTag.body.code, 'VALIDATION_ERROR');
  }

  // 5. Anchors and aliases (&anchor and *alias)
  const anchorYaml = `schemaVersion: 1
kind: localqa/test
id: anchor-test
name: 锚点测试
variables: &varAnchor
  KEY: value
criteria:
  - id: c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: body
steps:
  - kind: navigate
    url: http://localhost:8080/
extra: *varAnchor
`;
  const slugAnchor = `anchor-${randomUUID()}`;
  negativeSlugs.push(slugAnchor);
  const resAnchor = await request(
    `/projects/${project.id}/saved-cases/import`,
    {
      slug: slugAnchor,
      name: 'Anchor Test',
      yaml: anchorYaml,
    },
  );
  assert.equal(resAnchor.status, 422, JSON.stringify(resAnchor.body));
  assert.equal(resAnchor.body.code, 'VALIDATION_ERROR');

  // 6. Quoted * and & in strings must NOT be rejected
  const quotedValid = `schemaVersion: 1
kind: localqa/test
id: quoted-test
name: "合法包含 * 星号与 & 符号的名称"
variables:
  PARAM: "a=1&b=2*"
criteria:
  - id: c1
    kind: element_visible
    description: "描述中含 * 和 & 符号"
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: "div[data-val='*&']"
steps:
  - kind: navigate
    url: "http://localhost:8080/?q=*&v=1"
  - kind: assert
    criterionId: c1
`;
  const resQuoted = await request(
    `/projects/${project.id}/saved-cases/import`,
    {
      slug: `quoted-${randomUUID()}`,
      name: 'Quoted Valid',
      yaml: quotedValid,
    },
  );
  assert.equal(resQuoted.status, 201, JSON.stringify(resQuoted.body));

  // 7. Excessive collection depth (> 32)
  let deepYaml = 'leaf: "end"';
  for (let i = 0; i < 35; i++) {
    deepYaml = `nested_${i}:\n  ${deepYaml.replace(/\n/g, '\n  ')}`;
  }
  const deepDoc = `schemaVersion: 1\nkind: localqa/test\nid: deep-test\nname: Deep\nvariables: {}\ncriteria:\n  - id: c1\n    kind: element_visible\n    description: 深度测试\n    sourceKind: user_spec\n    sourceRef: test\n    locator:\n      by: css\n      value: body\nsteps:\n  - kind: navigate\n    url: http://localhost:8080/\n${deepYaml}`;
  const slugDeep = `deep-${randomUUID()}`;
  negativeSlugs.push(slugDeep);
  const resDeep = await request(`/projects/${project.id}/saved-cases/import`, {
    slug: slugDeep,
    name: 'Deep YAML',
    yaml: deepDoc,
  });
  assert.equal(resDeep.status, 422, JSON.stringify(resDeep.body));
  assert.equal(resDeep.body.code, 'VALIDATION_ERROR');

  // 8. Size limit (> 262144 bytes)
  const oversizedYaml = `schemaVersion: 1\nkind: localqa/test\nid: big-test\nname: Big\nvariables: {}\ncriteria:\n  - id: c1\n    kind: element_visible\n    description: 大尺寸测试\n    sourceKind: user_spec\n    sourceRef: test\n    locator:\n      by: css\n      value: body\nsteps:\n  - kind: navigate\n    url: http://localhost:8080/\n# ${'x'.repeat(270000)}`;
  const slugBig = `big-${randomUUID()}`;
  negativeSlugs.push(slugBig);
  const resBig = await request(`/projects/${project.id}/saved-cases/import`, {
    slug: slugBig,
    name: 'Oversized YAML',
    yaml: oversizedYaml,
  });
  assert.equal(resBig.status, 422, JSON.stringify(resBig.body));
  assert.equal(resBig.body.code, 'VALIDATION_ERROR');

  // 9. Unregistered module reference (with valid criteria array)
  const unregModYaml = `schemaVersion: 1
kind: localqa/test
id: unreg-mod-test
name: 未注册模块
variables: {}
criteria:
  - id: c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: body
steps:
  - kind: module
    ref: nonexistentModule@1
`;
  const slugUnreg = `unreg-${randomUUID()}`;
  negativeSlugs.push(slugUnreg);
  const resUnreg = await request(`/projects/${project.id}/saved-cases/import`, {
    slug: slugUnreg,
    name: 'Unregistered Module',
    yaml: unregModYaml,
  });
  assert.equal(resUnreg.status, 422, JSON.stringify(resUnreg.body));
  assert.equal(resUnreg.body.code, 'VALIDATION_ERROR');

  // 10. Unknown top-level field
  const unknownFieldYaml = `schemaVersion: 1
kind: localqa/test
id: unk-field-test
name: 未知字段测试
unexpectedProperty: "should_fail"
variables: {}
criteria:
  - id: c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: body
steps:
  - kind: navigate
    url: http://localhost:8080/
`;
  const slugUnknownField = `unk-field-${randomUUID()}`;
  negativeSlugs.push(slugUnknownField);
  const resUnknownField = await request(
    `/projects/${project.id}/saved-cases/import`,
    {
      slug: slugUnknownField,
      name: 'Unknown Field',
      yaml: unknownFieldYaml,
    },
  );
  assert.equal(
    resUnknownField.status,
    422,
    JSON.stringify(resUnknownField.body),
  );
  assert.equal(resUnknownField.body.code, 'VALIDATION_ERROR');

  // 11. Unknown step kind
  const unknownStepYaml = `schemaVersion: 1
kind: localqa/test
id: unk-step-test
name: 未知步骤测试
variables: {}
criteria:
  - id: c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: body
steps:
  - kind: unknown_action
    target: something
`;
  const slugUnknownStep = `unk-step-${randomUUID()}`;
  negativeSlugs.push(slugUnknownStep);
  const resUnknownStep = await request(
    `/projects/${project.id}/saved-cases/import`,
    {
      slug: slugUnknownStep,
      name: 'Unknown Step',
      yaml: unknownStepYaml,
    },
  );
  assert.equal(resUnknownStep.status, 422, JSON.stringify(resUnknownStep.body));
  assert.equal(resUnknownStep.body.code, 'VALIDATION_ERROR');

  // 12. Invalid schemaVersion
  const invalidVersionYaml = `schemaVersion: 99
kind: localqa/test
id: inv-ver-test
name: 非法版本测试
variables: {}
criteria:
  - id: c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: body
steps:
  - kind: navigate
    url: http://localhost:8080/
`;
  const slugInvalidVersion = `inv-ver-${randomUUID()}`;
  negativeSlugs.push(slugInvalidVersion);
  const resInvalidVersion = await request(
    `/projects/${project.id}/saved-cases/import`,
    {
      slug: slugInvalidVersion,
      name: 'Invalid Version',
      yaml: invalidVersionYaml,
    },
  );
  assert.equal(
    resInvalidVersion.status,
    422,
    JSON.stringify(resInvalidVersion.body),
  );
  assert.equal(resInvalidVersion.body.code, 'VALIDATION_ERROR');

  // 13. Invalid locator strategy
  const invalidLocatorYaml = `schemaVersion: 1
kind: localqa/test
id: inv-loc-test
name: 非法定位符测试
variables: {}
criteria:
  - id: c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: invalid_strategy
      value: body
steps:
  - kind: navigate
    url: http://localhost:8080/
`;
  const slugInvalidLocator = `inv-loc-${randomUUID()}`;
  negativeSlugs.push(slugInvalidLocator);
  const resInvalidLocator = await request(
    `/projects/${project.id}/saved-cases/import`,
    {
      slug: slugInvalidLocator,
      name: 'Invalid Locator',
      yaml: invalidLocatorYaml,
    },
  );
  assert.equal(
    resInvalidLocator.status,
    422,
    JSON.stringify(resInvalidLocator.body),
  );
  assert.equal(resInvalidLocator.body.code, 'VALIDATION_ERROR');

  // Verify ZERO rows were persisted across all negative cases (零落库)
  const persistedCount = await db.actor(actor, async (client) => {
    const queryRes = await client.query(
      'SELECT count(*)::integer AS n FROM saved_cases WHERE project_id = $1 AND slug = ANY($2::text[])',
      [project.id, negativeSlugs],
    );
    return queryRes.rows[0].n;
  });
  assert.equal(
    persistedCount,
    0,
    'Negative parser requests must not persist any saved cases in database',
  );
});

test('imported draft cannot be executed in regression; approved review allows execution with unchanged SHA', async () => {
  const yamlContent = `schemaVersion: 1
kind: localqa/test
id: exec-review-test
name: 审查重跑执行测试
variables: {}
criteria:
  - id: exec-c1
    kind: element_visible
    description: 元素可见
    sourceKind: user_spec
    sourceRef: test
    locator:
      by: css
      value: body
steps:
  - kind: navigate
    url: http://localhost:8080/
  - kind: assert
    criterionId: exec-c1
`;

  // 1. Import YAML -> Creates draft version
  const imported = await request(`/projects/${project.id}/saved-cases/import`, {
    slug: `exec-test-${tag}`,
    name: 'Exec Review Case',
    yaml: yamlContent,
  });
  assert.equal(imported.status, 201);
  const versions = await request(`/saved-cases/${imported.body.id}/versions`);
  const version = versions.body.items[0];
  assert.equal(version.reviewStatus, 'draft');
  const originalSha = version.sha256;

  // 2. Attempt to create regression run with draft version -> MUST be rejected (422)
  const draftRun = await request('/regression-runs', {
    projectId: project.id,
    caseVersionIds: [version.id],
  });
  assert.equal(draftRun.status, 422);
  assert.equal(draftRun.body.code, 'VALIDATION_ERROR');

  // 3. Human review preview & commit approval
  const reviewInput = {
    expectedVersion: 1,
    decision: 'approve',
    reason: 'Approved YAML import for regression',
  };
  const preview = await request(
    `/saved-case-versions/${version.id}/review-preview`,
    reviewInput,
  );
  assert.equal(preview.status, 200);

  const reviewRes = await request(`/saved-case-versions/${version.id}/review`, {
    ...reviewInput,
    confirmationToken: preview.body.confirmationToken,
  });
  assert.equal(reviewRes.status, 200);
  assert.equal(reviewRes.body.reviewStatus, 'approved');
  assert.equal(reviewRes.body.sha256, originalSha);

  // 4. Now create regression run with approved version -> 202 Accepted
  const regressionRun = await request('/regression-runs', {
    projectId: project.id,
    caseVersionIds: [version.id],
  });
  assert.equal(regressionRun.status, 202, JSON.stringify(regressionRun.body));
  assert.equal(regressionRun.body.executionMode, 'regression');

  // 5. Verify the regression binding in database retains the exact approved sourceDocumentSha256
  const binding = await db.actor(actor, async (client) => {
    const row = await client.query(
      'SELECT binding, source_sha256 FROM run_case_regression_bindings WHERE project_id=$1 AND run_id=$2',
      [project.id, regressionRun.body.id],
    );
    return row.rows[0];
  });
  assert.ok(binding);
  assert.equal(binding.source_sha256, originalSha);
  assert.equal(binding.binding.sourceDocumentSha256, originalSha);
});

test('JSON-saved document with deep semantic criterion (>32 levels) explicitly fails YAML export with 422 while retaining original document and SHA', async () => {
  let deepObj = 'leaf';
  for (let i = 0; i < 35; i++) {
    deepObj = { [`nest_${i}`]: deepObj };
  }
  const deepDoc = {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: `deep-semantic-${tag}`,
    name: 'Deep Semantic Document in JSON',
    variables: {},
    criteria: [
      {
        id: 'deep-c1',
        kind: 'semantic',
        description: 'Deep semantic criterion',
        sourceKind: 'user_spec',
        sourceRef: 'smoke',
        expectedValue: deepObj,
      },
    ],
    steps: [
      { kind: 'navigate', url: 'http://localhost:8080/' },
      { kind: 'assert', criterionId: 'deep-c1' },
    ],
  };

  // 1. Saved via the standard JSON API -> 201 Created (valid under JSON schema)
  const created = await request(`/projects/${project.id}/saved-cases`, {
    slug: `deep-json-${tag}`,
    name: 'Deep JSON Case',
    document: deepDoc,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const versions = await request(`/saved-cases/${created.body.id}/versions`);
  const version = versions.body.items[0];
  const originalSha = version.sha256;
  assert.equal(originalSha, hashPayload(deepDoc));

  // 2. Exporting YAML fails with 422 VALIDATION_ERROR due to YAML depth limit (> 32)
  const exportRes = await request(`/saved-case-versions/${version.id}/yaml`);
  assert.equal(exportRes.status, 422, JSON.stringify(exportRes.body));
  assert.equal(exportRes.body.code, 'VALIDATION_ERROR');

  // 3. Database row and SHA remain completely intact and unchanged
  const stored = await db.actor(actor, async (client) => {
    const row = await client.query(
      'SELECT document, sha256 FROM saved_case_versions WHERE id = $1',
      [version.id],
    );
    return row.rows[0];
  });
  assert.ok(stored);
  assert.equal(stored.sha256, originalSha);
  assert.equal(hashPayload(stored.document), originalSha);
});
