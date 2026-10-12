// One real provider planning request. No browser workflow or deployed user data
// is modified; only a disposable database and a copied frozen model are used.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from '../../../packages/storage/node_modules/pg/lib/index.js';
import {
  Database,
  AccountsRepository,
  ProjectRepository,
  ModelRepository,
  migrate,
} from '@localqa/storage';
import { DEFAULT_LIMITS } from '@localqa/domain';
import {
  Coordinator,
  ArtifactStore,
  RuntimeClient,
  createWorkerModelOptions,
  sessionOutputSchema,
  sessionModelContext,
} from '@localqa/orchestrator';
import { reviewSessionProposal } from '../../../packages/orchestrator/dist/session-planning.js';
import { loadDatabaseUrl } from '../../../deploy/images/database-url.mjs';
import { loadProtectedKek } from '../../../deploy/images/kek.mjs';

test(
  'configured provider accepts the session planning schema and generates a sourced business case',
  { timeout: 70000 },
  async () => {
    const base = await loadDatabaseUrl();
    const vault = await loadProtectedKek();
    const source = new Database(base);
    const control = new pg.Client({ connectionString: base });
    const name = `localqa_session_provider_${randomBytes(8).toString('hex')}`;
    assert.match(name, /^localqa_session_provider_[a-f0-9]{16}$/);
    assert.notEqual(new URL(base).pathname, `/${name}`);
    const scratch = await mkdtemp(join(tmpdir(), 'localqa-session-provider-'));
    let db,
      created = false;
    try {
      const admin = await source.auth(
        async (c) =>
          (
            await c.query(
              "SELECT id FROM users WHERE global_role='admin' AND NOT disabled ORDER BY created_at LIMIT 1",
            )
          ).rows[0].id,
      );
      const profile = await source.actor(
        { userId: admin },
        async (c) =>
          (
            await c.query(
              `SELECT p.id,p.version FROM model_profiles p JOIN model_profile_versions v ON v.profile_id=p.id AND v.version=p.version
       WHERE p.deleted_at IS NULL AND v.document->>'status' IN ('ready','degraded')
       ORDER BY CASE WHEN v.document->>'configuredModelId' ILIKE '%minimax%' THEN 0 ELSE 1 END,p.created_at LIMIT 1`,
            )
          ).rows[0],
      );
      assert.ok(profile, 'No configured provider is available');
      const frozen = await new ModelRepository(source, vault).readVersion(
        { userId: admin },
        profile.id,
        profile.version,
      );
      await control.connect();
      await control.query(`CREATE DATABASE "${name}"`);
      created = true;
      const connection = new URL(base);
      connection.pathname = `/${name}`;
      await migrate(
        connection.href,
        new URL('../../../packages/storage/migrations/', import.meta.url),
      );
      db = new Database(connection.href);
      const owner = await new AccountsRepository(db).bootstrap({
        email: 'provider-plan@localqa.test',
        displayName: 'Provider Plan',
        password: 'OwnedPlanningProvider123!',
      });
      const actor = { userId: owner.id };
      const project = await new ProjectRepository(db).create(actor, {
        name: 'Provider planning fixture',
      });
      const models = new ModelRepository(db, vault);
      const copied = await models.create(actor, {
        name: 'Frozen planning provider',
        endpoint: frozen.document.endpoint,
        configuredModelId: frozen.document.configuredModelId,
        adapter: frozen.document.adapter,
        responseFormat: frozen.document.responseFormat ?? 'json_object',
        dataBoundary: frozen.document.dataBoundary,
        maxOutputTokens: frozen.document.maxOutputTokens ?? 4000,
        ...(frozen.apiKey ? { apiKey: frozen.apiKey } : {}),
      });
      const model = await models.recordProbe(actor, copied.id, 1, {
        status: 'ready',
        capabilities: frozen.document.capabilities,
      });
      await models.grant(actor, project.id, model.id);
      const target = 'http://fixture.example.test/';
      const brief =
        '点击查看明细后，页面应显示订单明细。不创建、修改、提交或删除业务数据。';
      const coordinator = new Coordinator({ db, vault, serviceActor: actor });
      const binding = { profileId: model.id, version: model.version };
      const run = await coordinator.start(
        actor,
        { projectId: project.id, targetUrl: target, brief },
        {
          allowedOrigins: [new URL(target).origin],
          actionPolicy: 'non_submitting',
          budget: {
            ...DEFAULT_LIMITS,
            maxCases: 1,
            maxModelCalls: 2,
            maxTotalTokens: 80000,
          },
          environmentVersion: null,
          authProfileVersion: null,
          models: {
            coordinator: binding,
            explorer: binding,
            executor: binding,
            assertion: binding,
            reproducer: binding,
          },
          knowledgeVersionIds: [],
        },
        randomUUID(),
      );
      await coordinator.tick(project.id);
      let calls = 0;
      const options = createWorkerModelOptions({
        transport: async (url, init) => {
          calls++;
          return globalThis.fetch(url, init);
        },
        load: (id, version) =>
          models.readVersion(actor, id, version, project.id),
      });
      const runtime = new RuntimeClient(
        coordinator,
        { workerId: 'provider-plan-compatibility', projectId: project.id },
        new ArtifactStore(scratch),
        options,
      );
      const lease = await runtime.claim(45);
      assert.ok(lease);
      const proof = {
        taskId: lease.task.id,
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
        contextVersion: lease.contextVersion,
      };
      const work = await runtime.work(proof);
      assert.ok(work.session);
      const payload = sessionModelContext(work.session);
      const response = await runtime.model(proof, 'planner', {
        purpose: 'plan',
        outputSchema: sessionOutputSchema('SessionDecision'),
        messages: [
          {
            role: 'system',
            content: [
              {
                type: 'text',
                text: '你是测试会话负责人。只输出符合 SessionDecision 的 JSON。本次兼容性检查已有页面观察：有标题订单列表和按钮查看明细。根据给定测试说明规划一条业务用例，action=dispatch、exploreTargets=[]。引用 sources 中 user_spec 的真实 ref，并将对应需求逐字放入 sourceQuote；kind=semantic。不需要定位器或固定值时填 null，不得编造来源、权限或执行结果。',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  targetUrl: target,
                  allowedOrigins: [new URL(target).origin],
                  ...payload,
                }),
              },
            ],
          },
        ],
      });
      assert.ok(
        ['ok', 'repaired'].includes(response.requestResult),
        response.errorCode ?? response.requestResult,
      );
      const accepted = reviewSessionProposal(response.data, {
        targetUrl: target,
        allowedOrigins: [new URL(target).origin],
        protectedOrigins: [],
        remainingCases: 1,
        remainingPages: 0,
        sources: work.session.sources,
        existingCases: [],
        exploredUrls: [target],
      });
      assert.equal(accepted.cases.length, 1);
      assert.ok(
        accepted.cases[0].criteria.some((k) => k.sourceKind === 'user_spec'),
      );
      assert.equal(calls, 1, 'one provider request only');
      await coordinator.cancel(actor, project.id, run.id);
      await coordinator.tick(project.id);
      console.log(
        'SESSION_PROVIDER_ACCEPTED: real configured provider, sourced business planning, one request',
      );
    } finally {
      await db?.close();
      await source.close();
      if (created) await control.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await control.end();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
