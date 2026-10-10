// Product functional check: real React + HttpApiClient + Chromium.
// Only localhost API responses are isolated fixtures, not paid model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../docs/examples/report.sample.json', import.meta.url),
    ),
    'utf8',
  ),
);
const projectId = randomUUID();
const modelId = randomUUID();
const environmentId = randomUUID();
const authProfileId = randomUUID();
const runId = randomUUID();
const admin = {
  id: randomUUID(),
  email: 'admin@localqa.test',
  displayName: 'Admin',
  globalRole: 'admin',
  disabled: false,
  version: 1,
};
const operator = {
  id: randomUUID(),
  email: 'operator@localqa.test',
  displayName: 'Operator',
  globalRole: 'member',
  disabled: false,
  version: 1,
};
const project = {
  id: projectId,
  name: '完整业务流程',
  status: 'active',
  version: 1,
  createdAt: new Date().toISOString(),
  defaultModelProfileId: null,
};
const model = {
  id: modelId,
  name: 'Approved Fixture Model',
  configuredModelId: 'fixture-1',
  endpoint: 'https://model.example.test/v1',
  adapter: 'openai_compatible',
  dataBoundary: 'external',
  capabilities: {
    structuredOutput: true,
    nativeTools: true,
    imageInput: false,
  },
  status: 'ready',
  version: 1,
};
const environment = {
  id: environmentId,
  projectId,
  name: '预发布环境',
  baseUrl: 'https://fixture.example.test/checkout?region=cn',
  allowedOrigins: ['https://fixture.example.test'],
  excludedPaths: ['/admin/delete', '/checkout/payment'],
  tlsPolicy: 'strict',
  defaultAuthProfileId: null,
  version: 1,
};
const anonymousAuth = {
  id: authProfileId,
  projectId,
  environmentId,
  name: '匿名访问测试',
  mode: 'none',
  allowedOrigins: environment.allowedOrigins,
  sharingPolicy: 'exclusive_run',
  hasSecret: false,
  version: 1,
  status: 'active',
  formConfig: null,
};
const json = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const vite = await createViteServer({
  root,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await vite.listen();
  const address = vite.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let created = false;
  let granted = false;
  let grantCount = 0;
  let savedDefault = false;
  let runPayload = null;
  let envCreated = false;
  let authCreated = false;
  let envUpdated = false;
  let idempotency = null;
  let memberList = [{ userId: admin.id, role: 'owner' }];
  let memberUpdates = 0;
  let archived = false;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/v1/auth/me') return route.fulfill(json(admin));
    if (pathname === '/api/v1/users')
      return route.fulfill(
        json({ items: [admin, operator], nextCursor: null }),
      );
    if (pathname === '/api/v1/projects' && request.method() === 'GET')
      return route.fulfill(
        json({ items: created ? [project] : [], nextCursor: null }),
      );
    if (pathname === '/api/v1/projects' && request.method() === 'POST') {
      assert.equal(request.postDataJSON().name, project.name);
      created = true;
      return route.fulfill(json(project, 201));
    }
    if (
      pathname === `/api/v1/projects/${projectId}` &&
      request.method() === 'GET'
    )
      return route.fulfill(json(project));
    if (
      pathname === `/api/v1/projects/${projectId}` &&
      request.method() === 'PATCH'
    ) {
      const patch = request.postDataJSON();
      assert.equal(patch.expectedVersion, project.version);
      if (patch.status === 'archived') {
        assert.equal(savedDefault, true);
        assert.equal(memberUpdates, 3);
        project.status = 'archived';
        archived = true;
      } else {
        assert.equal(patch.defaultModelProfileId, modelId);
        assert.equal(granted, true);
        project.defaultModelProfileId = modelId;
        savedDefault = true;
      }
      project.version++;
      return route.fulfill(json(project));
    }
    if (pathname === `/api/v1/projects/${projectId}/members`) {
      if (request.method() === 'PUT') {
        const input = request.postDataJSON();
        if (input.expectedVersion !== project.version)
          return route.fulfill(
            json(
              { code: 'VERSION_CONFLICT', message: 'project version changed' },
              409,
            ),
          );
        assert.ok(input.members.some((member) => member.role === 'owner'));
        memberList = input.members;
        project.version++;
        memberUpdates++;
        return route.fulfill(json(project));
      }
      return route.fulfill(json({ items: memberList, nextCursor: null }));
    }
    if (pathname === `/api/v1/projects/${projectId}/environments`) {
      if (request.method() === 'POST') {
        const payload = request.postDataJSON();
        assert.equal(payload.baseUrl, environment.baseUrl);
        assert.deepEqual(payload.allowedOrigins, environment.allowedOrigins);
        assert.deepEqual(payload.excludedPaths, environment.excludedPaths);
        assert.equal(payload.tlsPolicy, 'strict');
        envCreated = true;
        return route.fulfill(json(environment, 201));
      }
      return route.fulfill(
        json({ items: envCreated ? [environment] : [], nextCursor: null }),
      );
    }
    if (
      pathname === `/api/v1/environments/${environmentId}` &&
      request.method() === 'PATCH'
    ) {
      const { expectedVersion, ...patch } = request.postDataJSON();
      assert.equal(expectedVersion, environment.version);
      assert.equal(patch.defaultAuthProfileId, authProfileId);
      assert.equal(patch.name, '预发布环境（已维护）');
      assert.deepEqual(patch.allowedOrigins, environment.allowedOrigins);
      Object.assign(environment, patch, { version: expectedVersion + 1 });
      envUpdated = true;
      return route.fulfill(json(environment));
    }
    if (pathname === `/api/v1/projects/${projectId}/auth-profiles`) {
      if (request.method() === 'POST') {
        const payload = request.postDataJSON();
        assert.equal(payload.mode, 'none');
        assert.equal(payload.environmentId, environmentId);
        assert.equal('secretInput' in payload, false);
        authCreated = true;
        return route.fulfill(json(anonymousAuth, 201));
      }
      return route.fulfill(
        json({ items: authCreated ? [anonymousAuth] : [], nextCursor: null }),
      );
    }
    if (pathname === '/api/v1/model-profiles')
      return route.fulfill(json({ items: [model], nextCursor: null }));
    if (pathname === `/api/v1/projects/${projectId}/model-profiles`) {
      if (request.method() === 'POST') {
        assert.equal(request.postDataJSON().modelProfileId, modelId);
        granted = true;
        grantCount++;
        return route.fulfill(json(model, 201));
      }
      return route.fulfill(
        json({ items: granted ? [model] : [], nextCursor: null }),
      );
    }
    if (pathname === '/api/v1/runs' && request.method() === 'POST') {
      runPayload = request.postDataJSON();
      idempotency = request.headers()['idempotency-key'];
      return route.fulfill(
        json(
          {
            ...example.run,
            id: runId,
            projectId,
            creatorId: admin.id,
            targetUrl: runPayload.targetUrl,
            status: 'queued',
            phase: 'preflight',
            completion: 'none',
            terminationReason: null,
            effectiveConfig: {
              ...example.run.effectiveConfig,
              allowedOrigins: [new URL(runPayload.targetUrl).origin],
              models: Object.fromEntries(
                Object.keys(example.run.effectiveConfig.models).map((role) => [
                  role,
                  { profileId: modelId, version: 1 },
                ]),
              ),
            },
          },
          202,
        ),
      );
    }
    return route.fulfill(
      json({ code: 'NOT_FOUND', message: 'unused fixture endpoint' }, 404),
    );
  });
  await page.goto(origin);
  await page.getByTestId('no-project-empty-state').waitFor();
  await page.getByTestId('btn-create-project').click();
  await page.getByTestId('new-project-name').fill('完整业务流程');
  await page.getByRole('button', { name: '创建并进入项目' }).click();
  await page
    .getByTestId('create-project-dialog')
    .waitFor({ state: 'detached' });
  await page.getByTestId('project-home-page').waitFor();
  assert.equal(
    await page.getByTestId('project-selector').inputValue(),
    projectId,
  );
  // A newly created project cannot run before an explicit authorized grant.
  await page.getByTestId('model-unconfigured-notice').waitFor();
  assert.equal(
    await page.getByTestId('btn-start-smoke-run').isDisabled(),
    true,
  );
  await page.getByTestId('nav-models').click();
  await page.getByTestId('project-model-settings').waitFor();
  await page.getByTestId('grant-model-select').selectOption(modelId);
  await page.getByTestId('btn-grant-model').click();
  await page
    .getByTestId('project-grants-summary')
    .getByText('Approved Fixture Model')
    .waitFor();
  await page.getByTestId('default-model-select').selectOption(modelId);
  await page.getByTestId('btn-save-default-model').click();
  await page.waitForFunction(
    () =>
      globalThis.window.__LOCALQA_CURRENT_PROJECT__?.defaultModelProfileId !==
      null,
  );
  assert.equal(savedDefault, true);
  assert.equal(grantCount, 1);
  await page.getByTestId('nav-environments').click();
  await page.getByTestId('environments-page').waitFor();
  await page.getByTestId('environments-empty-state').waitFor();
  await page.getByTestId('environment-name').fill(environment.name);
  await page.getByTestId('environment-base-url').fill(environment.baseUrl);
  await page
    .getByTestId('environment-origins')
    .fill('https://other.example.test');
  await page.getByTestId('btn-create-environment').click();
  await page.getByTestId('environment-create-error').waitFor();
  assert.equal(
    envCreated,
    false,
    'unexpected origin scope must fail before API',
  );
  await page
    .getByTestId('environment-origins')
    .fill('https://fixture.example.test');
  await page
    .getByTestId('environment-excluded')
    .fill('/admin/delete\n/checkout/payment');
  await page.getByTestId('btn-create-environment').click();
  await page.getByTestId(`env-row-${environmentId}`).waitFor();
  assert.equal(envCreated, true);
  await page.getByTestId('auth-profile-name').fill(anonymousAuth.name);
  await page.getByTestId('auth-profile-mode').selectOption('none');
  await page
    .getByTestId('auth-profile-origins')
    .fill('https://outside.example.test');
  await page.getByTestId('btn-create-auth-profile').click();
  await page.getByRole('alert').last().waitFor();
  assert.equal(
    authCreated,
    false,
    'auth scope must not be broader than environment scope',
  );
  await page
    .getByTestId('auth-profile-origins')
    .fill(environment.allowedOrigins[0]);
  await page.getByTestId('btn-create-auth-profile').click();
  await page.getByTestId(`auth-row-${authProfileId}`).waitFor();
  assert.equal(authCreated, true);
  assert.equal(
    await page
      .getByTestId(`auth-row-${authProfileId}`)
      .getByText('无密钥')
      .count(),
    1,
  );
  await page.getByTestId(`btn-edit-env-${environmentId}`).click();
  await page.getByTestId('edit-environment-name').fill('预发布环境（已维护）');
  await page
    .getByTestId('edit-environment-default-auth')
    .selectOption(authProfileId);
  await page
    .getByTestId('edit-environment-origins')
    .fill('https://unapproved.example.test');
  await page.getByTestId('btn-save-environment').click();
  await page.getByTestId('edit-environment-error').waitFor();
  assert.equal(envUpdated, false, 'invalid Origin must not reach API');
  await page
    .getByTestId('edit-environment-origins')
    .fill('https://fixture.example.test');
  await page.getByTestId('btn-save-environment').click();
  await page
    .getByTestId('edit-environment-form')
    .waitFor({ state: 'detached' });
  assert.equal(envUpdated, true);
  assert.equal(environment.version, 2);
  await page
    .getByTestId(`env-row-${environmentId}`)
    .getByText(anonymousAuth.name)
    .waitFor();
  await page.getByTestId('nav-home').click();
  await page.getByTestId('project-home-page').waitFor();
  await page.waitForFunction(
    (id) =>
      globalThis.document.querySelector('[data-testid="select-environment"]')
        ?.value === id,
    environmentId,
  );
  assert.equal(
    await page.getByTestId('select-environment').inputValue(),
    environmentId,
  );
  assert.equal(
    await page.getByTestId('input-target-url').inputValue(),
    environment.baseUrl,
  );
  assert.equal(
    await page.getByTestId('select-auth-profile').inputValue(),
    authProfileId,
    'active default authentication must be selected from the saved environment',
  );
  await page.getByTestId('default-auth-notice').waitFor();
  await page.getByTestId('select-auth-profile').selectOption('');
  assert.equal(
    await page.getByTestId('select-auth-profile').inputValue(),
    '',
    'users must be able to override default auth with anonymous access',
  );
  await page.getByTestId('select-model-profile').selectOption(modelId);
  await page.getByTestId('select-auth-profile').selectOption(authProfileId);
  const targetUrl = 'https://fixture.example.test/checkout?region=cn';
  await page.getByTestId('input-target-url').fill(targetUrl);
  await page.getByTestId('btn-start-smoke-run').click();
  await page.waitForURL((url) =>
    url.hash.includes(`/workbench?runId=${runId}`),
  );
  assert.equal(runPayload?.projectId, projectId);
  assert.equal(runPayload?.modelProfileId, modelId);
  assert.equal(runPayload?.environmentId, environmentId);
  assert.equal(runPayload?.authProfileId, authProfileId);
  assert.equal(runPayload?.targetUrl, targetUrl);
  assert.equal(runPayload?.config, undefined);
  assert.ok(idempotency, 'each browser run sends an idempotency key');
  await page.getByTestId('nav-members-ops').click();
  await page.getByTestId('members-editor').waitFor();
  await page.getByTestId('audit-unavailable-notice').waitFor();
  assert.equal(
    await page.getByTestId(`remove-member-${admin.id}`).isDisabled(),
    true,
    'current account must not remove itself in the Web editor',
  );
  await page.getByTestId('member-user-directory').selectOption(operator.id);
  await page.getByTestId('member-new-role').selectOption('operator');
  await page.getByTestId('btn-add-member').click();
  await page.getByTestId(`member-row-${operator.id}`).waitFor();
  assert.equal(
    await page.getByTestId('btn-save-members').isDisabled(),
    true,
    'full member replacement requires explicit confirmation',
  );
  await page.getByTestId('confirm-member-changes').check();
  await page.getByTestId('btn-save-members').click();
  await page.getByTestId('members-save-success').waitFor();
  assert.equal(memberUpdates, 1);
  assert.equal(
    memberList.find((m) => m.userId === operator.id)?.role,
    'operator',
  );
  // Simulate a concurrent writer that increments the authoritative version
  // after the Web page cached its previous project version.
  project.version++;
  await page.getByTestId(`member-role-${operator.id}`).selectOption('viewer');
  await page.getByTestId('confirm-member-changes').check();
  await page.getByTestId('btn-save-members').click();
  await page.getByTestId('members-save-error').waitFor();
  assert.equal(memberUpdates, 1, 'stale member replacement must not commit');
  await page.getByTestId('btn-reload-members').click();
  await page.waitForFunction(
    () => globalThis.window.__LOCALQA_CURRENT_PROJECT__?.version === 4,
  );
  await page.getByTestId(`member-role-${operator.id}`).selectOption('viewer');
  await page.getByTestId('confirm-member-changes').check();
  await page.getByTestId('btn-save-members').click();
  await page.waitForFunction(
    () => globalThis.window.__LOCALQA_CURRENT_PROJECT__?.version === 5,
  );
  assert.equal(memberUpdates, 2);
  assert.equal(
    memberList.find((m) => m.userId === operator.id)?.role,
    'viewer',
  );
  await page.getByTestId(`remove-member-${operator.id}`).click();
  await page.getByTestId('confirm-member-changes').check();
  await page.getByTestId('btn-save-members').click();
  await page.waitForFunction(
    () => globalThis.window.__LOCALQA_CURRENT_PROJECT__?.version === 6,
  );
  assert.equal(memberUpdates, 3);
  assert.deepEqual(memberList, [{ userId: admin.id, role: 'owner' }]);
  await page.getByTestId('archive-project-name').fill('incorrect name');
  await page.getByTestId('confirm-project-archive').check();
  assert.equal(
    await page.getByTestId('btn-archive-project').isDisabled(),
    true,
  );
  await page.getByTestId('archive-project-name').fill(project.name);
  await page.getByTestId('btn-archive-project').click();
  await page.getByTestId('project-home-page').waitFor();
  assert.equal(archived, true);
  assert.equal(project.status, 'archived');
  assert.equal(
    await page.getByTestId('btn-start-smoke-run').isDisabled(),
    true,
  );
  await page.close();
  console.log(
    'T43_PRODUCT_UI_ACCEPTED project + model + environment + auth + URL run + member RBAC + archive',
  );
} finally {
  await browser?.close();
  await vite.close();
}
