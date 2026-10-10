import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  AccountsRepository,
  Database,
  ModelRepository,
  ProjectRepository,
  SecretVault,
  hashPayload,
  migrate,
} from '@localqa/storage';
import { DEFAULT_LIMITS, smokeCase } from '@localqa/domain';
import { BrowserManager } from '@localqa/browser';
import {
  ArtifactStore,
  Coordinator,
  RuntimeClient,
  createWorkerModelOptions,
} from '@localqa/orchestrator';
import { Worker } from '../dist/index.js';
import {
  createAnthropicAdapter,
  createOpenAIAdapter,
  createGateway,
} from '@localqa/model-gateway';
import { createRegressionPlan } from '@localqa/orchestrator';
import { parseContract } from '@localqa/contracts';
import { getT26Fixture, renderT26Fixture } from './t26-business-fixtures.mjs';

const T26_ID = process.env.LOCALQA_T26_FLOW ?? '';
const T26 = T26_ID ? getT26Fixture(T26_ID) : null;
const MULTI = process.env.LOCALQA_T18_MULTI === '1' || Boolean(T26);
const INTERACTIVE_SIM = process.env.LOCALQA_T17_SIM_INTERACTIVE === '1';
const INTERACTIVE =
  INTERACTIVE_SIM ||
  process.env.LOCALQA_T17_REAL_INTERACTIVE === '1' ||
  Boolean(T26);
const INTERACTIVE_BROKEN =
  INTERACTIVE &&
  (process.env.LOCALQA_T17_BROKEN === '1' ||
    process.env.LOCALQA_T26_FAULT === '1');
const T16 = process.env.LOCALQA_T16_SCENARIO ?? '';
if (T16 && !['unconfirmed', 'blocked', 'interrupted'].includes(T16))
  throw new Error('Invalid T16 scenario');
const FINDING = process.env.LOCALQA_T15_REAL_FINDING === '1' || Boolean(T16);
const REAL =
  (INTERACTIVE && !INTERACTIVE_SIM) ||
  FINDING ||
  process.env.LOCALQA_T14_REAL_MOAN2 === '1';

function loadExistingPiMoan2() {
  const dir = join(tmpdir(), '..');
  // The user's already-authorized Pi configuration is read-only. The secret
  // is only encrypted into a disposable isolated PostgreSQL container.
  const base = join(
    process.env.USERPROFILE ?? process.env.HOME ?? dir,
    '.pi',
    'agent',
  );
  const auth = JSON.parse(readFileSync(join(base, 'auth.json'), 'utf8'));
  const config = JSON.parse(readFileSync(join(base, 'models.json'), 'utf8'));
  const key = auth?.moan2?.key;
  const provider = config?.providers?.moan2;
  if (
    typeof key !== 'string' ||
    !key ||
    provider?.api !== 'anthropic-messages' ||
    typeof provider.baseUrl !== 'string'
  )
    throw new Error('PI_MOAN2_NOT_CONFIGURED');
  const modelId = process.env.LOCALQA_T17_PI_MOAN2_MODEL ?? 'mofree-m1';
  if (
    !Array.isArray(provider.models) ||
    !provider.models.some((entry) => entry?.id === modelId)
  )
    throw new Error('PI_MOAN2_MODEL_NOT_IN_APPROVED_CONFIG');
  return { key, endpoint: provider.baseUrl, model: modelId };
}

function loadExistingPiDeepSeek() {
  const base = join(
    process.env.USERPROFILE ?? process.env.HOME ?? tmpdir(),
    '.pi',
    'agent',
    'auth.json',
  );
  const entry = JSON.parse(readFileSync(base, 'utf8'))?.deepseek;
  if (entry?.type !== 'api_key' || typeof entry.key !== 'string' || !entry.key)
    throw new Error('PI_DEEPSEEK_NOT_CONFIGURED');
  return {
    key: entry.key,
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    adapter: 'openai_compatible',
    label: 'pi-deepseek',
  };
}

// Default: simulated OpenAI-compatible G2 wire. Explicit opt-in T14/T15
// modes call the real moan2 Anthropic Messages model; they must not be
// conflated with a synthetic provider response or autonomous issue discovery.
function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, `isolated docker ${args[0]} must succeed`);
  return result.stdout.trim();
}
test(
  T26
    ? `T26 ${INTERACTIVE_SIM ? 'G2 synthetic' : 'G3 real'} ${T26.id} exact business oracle ${INTERACTIVE_BROKEN ? 'fault reproduced' : 'healthy'}`
    : INTERACTIVE
      ? INTERACTIVE_BROKEN
        ? `${MULTI ? 'T18' : 'T17'} ${INTERACTIVE_SIM ? 'simulated protocol' : 'real AI'} detects broken form state with independent regression reproduction`
        : `${MULTI ? 'T18' : 'T17'} approved ${INTERACTIVE_SIM ? 'simulated protocol' : 'real AI'} ${MULTI ? 'two-step AI flow' : 'click'} + form input -> DOM state evidence on PostgreSQL18/Chromium`
      : T16
        ? `T16 real model independently de-escalates failure to ${T16}`
        : FINDING
          ? 'T15 real AI + PostgreSQL18 + Chromium: sourced failure and independent reproduction'
          : REAL
            ? 'T14 real Pi moan2 model through leased PG18 Worker + Chromium'
            : 'T14 bounded 1.3-second provider-wire response traverses leased PG18 Worker + Chromium',
  {
    timeout: REAL ? 290000 : 110000,
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'localqa-t14-wire-'));
    const pgPassword = randomBytes(24).toString('hex');
    const envFile = join(root, 'pg.env');
    writeFileSync(
      envFile,
      `POSTGRES_USER=localqa\nPOSTGRES_DB=localqa\nPOSTGRES_PASSWORD=${pgPassword}\n`,
      { mode: 0o600 },
    );
    let container = null,
      db = null,
      browser = null,
      fixture = null;
    let fixtureRecovered = false;
    try {
      fixture = createServer((_request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        if (INTERACTIVE) {
          if (T26) {
            response.end(
              renderT26Fixture(
                T26,
                INTERACTIVE_BROKEN,
                process.env.LOCALQA_T36_DOM_VARIANT === 'reload'
                  ? 't36-frame-reload'
                  : process.env.LOCALQA_T36_DOM_VARIANT === 'remount'
                    ? 't36-shadow-remount'
                    : process.env.LOCALQA_T34_DOM_VARIANT === 'iframe'
                      ? 't34-iframe'
                      : process.env.LOCALQA_T34_DOM_VARIANT === 'shadow'
                        ? 't34-shadow'
                        : process.env.LOCALQA_T33_DOM_VARIANT === '1'
                          ? 't33-dialog'
                          : 'historical',
              ),
            );
            return;
          }
          if (MULTI) {
            const finalState = INTERACTIVE_BROKEN
              ? '<p>状态未同步</p>'
              : '<p data-testid="complete-marker">状态匹配</p>';
            response.end(
              `<!doctype html><html lang="zh-CN"><head><title>两阶段受控订单</title></head><body>` +
                `<main><h1>模拟订单预览</h1><form onsubmit="return false">` +
                `<label>订单备注 <input data-testid="order-note" aria-label="订单备注" type="text"></label>` +
                `<button id="preview" type="button" aria-label="预览订单">预览订单</button>` +
                `<section id="result">尚未预览</section></form></main><script>` +
                `document.getElementById('preview').addEventListener('click', () => {` +
                `  const note = document.querySelector('[data-testid="order-note"]').value;` +
                `  const result = document.getElementById('result');` +
                `  if (note !== 'qa-1729') { result.textContent = '备注不匹配'; return; }` +
                `  const confirm = document.createElement('button');` +
                `  confirm.type = 'button'; confirm.textContent = '确认预览';` +
                `  confirm.setAttribute('aria-label', '确认预览');` +
                `  confirm.addEventListener('click', () => { result.innerHTML = ${JSON.stringify(finalState)}; }, { once: true });` +
                `  result.replaceChildren(confirm);` +
                `}, { once: true });` +
                `</script></body></html>`,
            );
            return;
          }
          response.end(
            '<!doctype html><html lang="zh-CN"><head><title>受控业务表单</title></head>' +
              '<body><main><h1>模拟订单确认</h1><form onsubmit="return false">' +
              '<label>订单备注 <input data-testid="order-note" aria-label="订单备注" type="text"></label>' +
              '<button type="button" aria-label="查看校验结果" onclick="' +
              "const note=document.querySelector('[data-testid=order-note]').value;" +
              "document.querySelector('#result').innerHTML=" +
              "note==='qa-1729'?" +
              (INTERACTIVE_BROKEN
                ? "'<p>状态未同步</p>'"
                : "'<p data-testid=complete-marker>状态匹配</p>'") +
              ":'<p>备注不匹配</p>';" +
              '">查看校验结果</button><section id="result">尚未验证</section>' +
              '</form></main></body></html>',
          );
          return;
        }
        if (FINDING) {
          if (fixtureRecovered && T16 === 'blocked') {
            response.statusCode = 503;
            response.end(
              '<!doctype html><title>Temporary outage</title><main>系统暂时不可用</main>',
            );
            return;
          }
          if (fixtureRecovered && T16 === 'unconfirmed') {
            response.end(
              '<!doctype html><html lang="zh-CN"><title>结账结果</title>' +
                '<main><h1>结账结果</h1>' +
                '<p data-testid="checkout-success">订单提交成功</p></main></html>',
            );
            return;
          }
          response.end(
            '<!doctype html><html lang="zh-CN"><title>结账结果</title>' +
              '<main><h1>结账结果</h1>' +
              '<section data-testid="checkout-error">订单处理失败：已支付但订单未创建</section>' +
              '<p>成功状态标记缺失，请联系支持</p></main></html>',
          );
          return;
        }
        response.end(
          '<!doctype html><html><head><title>中文测试页面</title></head>' +
            '<body><main><h1 data-testid="heading">本地真实浏览器冒烟</h1>' +
            '<button type="button" aria-label="查看详情" onclick="document.getElementById(\'details\').textContent=\'已打开详情\'">详情</button>' +
            '<p id="details">尚未展开</p></main></body></html>',
        );
      });
      fixture.listen(0, '127.0.0.1');
      await once(fixture, 'listening');
      const origin = `http://127.0.0.1:${fixture.address().port}`;
      container = docker([
        'run',
        '--detach',
        '--name',
        `localqa-t14-wire-${randomUUID().slice(0, 10)}`,
        '--publish',
        '127.0.0.1::5432',
        '--env-file',
        envFile,
        'postgres:18-alpine',
      ]);
      const pgPort = docker(['port', container, '5432/tcp']).split(':').at(-1);
      const connection = `postgresql://localqa:${pgPassword}@127.0.0.1:${pgPort}/localqa`;
      let schemaReady = false;
      for (let i = 0; i < 75; i++) {
        try {
          await migrate(
            connection,
            new URL('../../../packages/storage/migrations/', import.meta.url),
          );
          schemaReady = true;
          break;
        } catch {
          await delay(150);
        }
      }
      assert.equal(schemaReady, true, 'isolated PostgreSQL18 must migrate');
      db = new Database(connection);
      const vault = new SecretVault(1, new Map([[1, randomBytes(32)]]));
      const admin = await new AccountsRepository(db).bootstrap({
        email: `t14-${randomUUID()}@localqa.test`,
        displayName: 'T14 wire integration administrator',
        password: 'IntegrationTestOnlyPassword!',
      });
      const actor = { userId: admin.id };
      const project = await new ProjectRepository(db).create(actor, {
        name: 'T14 wire integration',
      });
      const modelRepository = new ModelRepository(db, vault);
      const external = globalThis.__localqaT17Model;
      const realProvider = REAL
        ? external
          ? {
              key: external.apiKey,
              endpoint: external.endpoint,
              model: external.model,
              adapter: external.adapter,
              label: 'ephemeral-external',
            }
          : process.env.LOCALQA_T17_PI_DEEPSEEK === '1'
            ? loadExistingPiDeepSeek()
            : {
                ...loadExistingPiMoan2(),
                adapter: 'anthropic_messages',
                label: 'pi-moan2',
              }
        : null;
      const model = await modelRepository.create(actor, {
        name: REAL
          ? `T17-${realProvider.label}`
          : 'simulated-provider-wire-not-real-G3',
        endpoint:
          realProvider?.endpoint ??
          'https://localqa-g3-provider-wire.invalid/v1',
        configuredModelId: realProvider?.model ?? 'wire-fixture-model',
        responseFormat: 'json_object',
        adapter: realProvider?.adapter ?? 'openai_compatible',
        dataBoundary: REAL ? 'external' : 'internal',
        apiKey: realProvider?.key ?? 'local-only-not-an-external-credential',
      });
      if (REAL) {
        const probeHttpStatuses = [];
        const observeProbeHttp = async (...args) => {
          const response = await globalThis.fetch(...args);
          probeHttpStatuses.push(response.status);
          return response;
        };
        const adapter =
          realProvider.adapter === 'anthropic_messages'
            ? createAnthropicAdapter(observeProbeHttp)
            : createOpenAIAdapter(observeProbeHttp);
        const gate = createGateway({
          profiles: [
            {
              id: model.id,
              version: model.version,
              name: model.name,
              endpoint: model.endpoint,
              configuredModelId: model.configuredModelId,
              kind: realProvider.adapter,
              dataBoundary: 'external',
              responseFormat: 'json_object',
              status: 'untested',
              encryptedApiKey: 'test-only-ephemeral-key-binding',
              approvedFallbackIds: [],
              capabilities: {
                structuredOutput: false,
                nativeTools: false,
                imageInput: false,
              },
            },
          ],
          decryptKey: () => realProvider.key,
          adapter,
        });
        const probe = await gate.capabilityProbe(model.id, 25000);
        if (probe.requestResult !== 'ok')
          console.log(
            'T26_PROVIDER_PREFLIGHT',
            JSON.stringify({
              requestResult: probe.requestResult,
              errorCode: probe.errorCode,
              providerCalls: probe.providerCalls,
              httpStatuses: probeHttpStatuses,
            }),
          );
        assert.equal(
          probe.requestResult,
          'ok',
          'real provider must demonstrate JSON capability before freezing',
        );
        assert.equal(probe.data.capabilities.structuredOutput, true);
      }
      const probed = await modelRepository.recordProbe(
        actor,
        model.id,
        model.version,
        {
          capabilities: {
            structuredOutput: true,
            nativeTools: false,
            imageInput: false,
          },
          status: REAL ? 'degraded' : 'ready',
        },
      );
      assert.ok(probed, 'simulated probe must freeze test-only model version');
      await modelRepository.grant(actor, project.id, model.id);
      let requests = 0,
        delayed = 0,
        proposedClicks = 0;
      let proposeUnauthorizedClick = false;
      const fakeTransport = async (url, init) => {
        assert.equal(
          url,
          'https://localqa-g3-provider-wire.invalid/v1/chat/completions',
        );
        const request = JSON.parse(init.body);
        assert.equal(request.model, 'wire-fixture-model');
        assert.equal(request.response_format?.type, 'json_object');
        assert.equal(
          request.tools,
          undefined,
          'json_object mode must not include native tools',
        );
        assert.ok(String(init.headers.authorization).startsWith('Bearer '));
        requests++;
        if (requests === 1) {
          delayed++;
          await delay(1300, undefined, { signal: init.signal });
        }
        const userText = request.messages
          .flatMap((m) => m.content)
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        const assertText = userText.includes('ownedEvidence');
        const observed = request.messages
          .flatMap((m) => m.content)
          .filter(
            (p) => p.type === 'text' && p.text.startsWith('{"observation":'),
          )
          .map((p) => {
            try {
              return JSON.parse(p.text)?.observation;
            } catch {
              return null;
            }
          })
          .find(Boolean);
        const approvedAiStep = INTERACTIVE_SIM
          ? request.messages
              .flatMap((m) => m.content)
              .filter((part) => part.type === 'text')
              .map((part) => {
                try {
                  const parsed = JSON.parse(part.text);
                  return parsed?.goal && parsed?.observation ? parsed : null;
                } catch {
                  return null;
                }
              })
              .find(Boolean)
          : null;
        let reply = { done: true, toolCalls: [] };
        if (approvedAiStep) {
          const current = approvedAiStep.observation;
          const prior = approvedAiStep.executedActions ?? [];
          const expectedButton = T26
            ? prior.length === 0
              ? T26.first
              : T26.second
            : MULTI
              ? prior.length === 0
                ? '预览订单'
                : '确认预览'
              : '查看校验结果';
          assert.equal(
            prior.length,
            MULTI ? (expectedButton === (T26?.first ?? '预览订单') ? 0 : 1) : 0,
          );
          if (MULTI && prior.length === 1) {
            assert.equal(prior[0].name, 'click');
            assert.equal(
              prior[0].target,
              'button:' + (T26?.first ?? '预览订单'),
            );
          }
          const control = current.nodes?.find(
            (node) =>
              node.role === 'button' &&
              node.visible &&
              node.enabled &&
              node.name === expectedButton,
          );
          if (
            !control &&
            prior.length === 1 &&
            ['iframe', 'shadow', 'reload', 'remount'].includes(
              process.env.LOCALQA_T36_DOM_VARIANT ??
                process.env.LOCALQA_T34_DOM_VARIANT,
            )
          ) {
            // The second control is genuinely async. A synthetic model may
            // return zero actions, never invent a locator. The approved
            // bounded Worker loop makes a fresh observation next round.
            reply = { done: false, toolCalls: [] };
          } else {
            assert.ok(
              control,
              'approved test fixture button must exist in current DOM',
            );
            reply = {
              done: false,
              toolCalls: [
                {
                  name: 'click',
                  args: {
                    target: {
                      pageId: current.pageId,
                      snapshotId: current.snapshotId,
                      nodeId: control.nodeId,
                      frameId: control.frameId,
                    },
                  },
                },
              ],
            };
          }
        } else if (assertText) {
          const evidence = userText.match(
            /"ownedEvidence"\s*:\s*\[\s*"([0-9a-f-]{36})"/,
          );
          reply = {
            criterionId: 'smoke.visible',
            result: 'passed',
            reason: '模拟供应商返回；正式结果由独立浏览器技术断言决定',
            evidenceRefs: evidence ? [evidence[1]] : [],
          };
        } else if (
          proposeUnauthorizedClick &&
          observed &&
          !userText.includes('DISPATCHED') &&
          proposedClicks === 0
        ) {
          const target = observed.nodes?.find(
            (node) =>
              node.role === 'button' &&
              node.visible &&
              node.enabled &&
              node.name === '查看详情',
          );
          if (target) {
            proposedClicks++;
            reply = {
              done: false,
              toolCalls: [
                {
                  name: 'click',
                  args: {
                    target: {
                      pageId: observed.pageId,
                      snapshotId: observed.snapshotId,
                      nodeId: target.nodeId,
                      frameId: target.frameId,
                    },
                  },
                },
              ],
            };
          }
        }
        return new Response(
          JSON.stringify({
            id: `wire-${requests}`,
            object: 'chat.completion',
            model: 'wire-fixture-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: JSON.stringify(reply) },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 30,
              completion_tokens: 12,
              total_tokens: 42,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };
      const modelOptions = createWorkerModelOptions({
        transport: REAL
          ? (...args) => {
              requests++;
              return globalThis.fetch(...args);
            }
          : fakeTransport,
        allowTestStub: false,
        load: (id, version) =>
          modelRepository.readVersion(actor, id, version, project.id),
      });
      const coordinator = new Coordinator({
        db,
        vault,
        serviceActor: actor,
        platformSlots: 2,
        projectSlots: 2,
        modelOptions,
      });
      browser = new BrowserManager();
      const bindings = Object.fromEntries(
        ['coordinator', 'explorer', 'executor', 'assertion', 'reproducer'].map(
          (role) => [role, { profileId: model.id, version: probed.version }],
        ),
      );
      const entry =
        origin +
        (T26
          ? '/business/' + T26.id
          : INTERACTIVE
            ? '/form'
            : FINDING
              ? '/checkout'
              : '/cn');
      const brief = FINDING
        ? '验收规范：结账结果页必须包含可见的 data-testid=checkout-success 成功标记；缺失该标记属于功能缺陷。'
        : undefined;
      const fixedCase = FINDING
        ? smokeCase({ id: randomUUID(), projectId: project.id }, entry, 0)
        : null;
      if (fixedCase) {
        fixedCase.title = '结账成功标记缺失';
        fixedCase.summary = '由运行输入固定的验收要求，而非模型自拟预期';
        fixedCase.criteria = [
          {
            id: 'checkout.success',
            kind: 'element_visible',
            description: '结账成功标记必须可见',
            sourceKind: 'user_spec',
            sourceRef: `brief:${hashPayload(brief)}`,
            locator: { by: 'test_id', value: 'checkout-success' },
          },
        ];
      }
      let interactiveCase = null;
      if (INTERACTIVE) {
        const versionId = randomUUID();
        const caseId = randomUUID();
        const runId = randomUUID();
        const document = {
          schemaVersion: 1,
          kind: 'localqa/test',
          id: T26
            ? 't26-' + T26.id
            : MULTI
              ? 't18-approved-preview'
              : 't17-approved-form',
          name: T26
            ? 'T26-' + T26.title
            : MULTI
              ? '人工批准的两阶段 AI 订单预览'
              : '人工批准的表单与 AI 按钮选择',
          criteria: [
            {
              id: 'form-result',
              kind: T26 ? 'text_equals' : 'element_visible',
              ...(T26 ? { expectedValue: T26.expected } : {}),
              description: T26
                ? '独立业务预期：必须严格等于批准时冻结的计算结果，存在元素本身不算通过'
                : '仅输入正确订单备注并按下结果按钮后出现状态匹配标记',
              sourceKind: 'user_spec',
              sourceRef: T26
                ? 'approved-t26-' + T26.id
                : MULTI
                  ? 'approved-t18-local-fixture'
                  : 'approved-t17-local-fixture',
              locator: { by: 'test_id', value: 'complete-marker' },
            },
          ],
          steps: [
            { kind: 'navigate', url: entry },
            {
              kind: 'type_text',
              locator: { by: 'test_id', value: T26?.field ?? 'order-note' },
              text: T26?.value ?? 'qa-1729',
            },
            {
              kind: 'ai_action',
              goal: T26
                ? '人工已审批的本地业务验收：' +
                  T26.title +
                  '。' +
                  T26.fieldLabel +
                  '已输入。本次 AI 第一次观察应点击“' +
                  T26.first +
                  '”，获取全新 DOM 快照后第二次观察应点击动态出现的“' +
                  T26.second +
                  '”。**必须完成以上两次不同按钮的点击，不得点击一次后返回 done=true。' +
                  '在已执行动作列表只有第一次点击时，新的页面 DOM 中会出现第二按钮：此时必须返回 done=false 且 toolCalls 只有一个 click。' +
                  '每轮只返回一个从当前真实 DOM 中选择的 click；' +
                  '不导航、不提交到外部业务系统，不自行判断业务结果。只有完成两次点击才允许结束，操作完毕由冻结的' +
                  '文本精确断言判定，目标为：' +
                  T26.expected
                : MULTI
                  ? '这是经过人工审批的本地测试。订单备注已输入。先点击“预览订单”，然后在下一轮新的 DOM 快照中点击才出现的“确认预览”。每轮只返回一个 click，不要提前结束，不要导航或其他动作。两个点击后由冻结断言检查结果。'
                  : '这是经过人工审批的本地测试。订单备注已经输入正确。请从当前观察中找到名字为“查看校验结果”的按钮，用 click 工具点击一次；点击成功后返回 done=true。不要导航、不要其他动作。',
              criteriaIds: ['form-result'],
              maxToolCalls: MULTI ? 2 : 1,
              ...(T26 ? { minToolCalls: 2 } : {}),
              ...(T26 && process.env.LOCALQA_T33_SEQUENCE === '1'
                ? { requiredToolSequence: ['click', 'click'] }
                : {}),
            },
          ],
        };
        const sha = hashPayload(document);
        await db.actor(actor, async (client) => {
          await client.query(
            `INSERT INTO saved_cases(id,project_id,slug,name,status,current_approved_version_id,version)
             VALUES($1,$2,$3,$4,'active',NULL,1)`,
            [caseId, project.id, document.id, document.name],
          );
          await client.query(
            `INSERT INTO saved_case_versions(
              id,case_id,project_id,version,document,sha256,review_status,created_by
             ) VALUES($1,$2,$3,1,$4,$5,'draft',$6)`,
            [versionId, caseId, project.id, document, sha, admin.id],
          );
          await client.query(
            `UPDATE saved_case_versions SET review_status='approved',
             reviewed_by=$2,reviewed_at=clock_timestamp() WHERE id=$1`,
            [versionId, admin.id],
          );
          await client.query(
            'UPDATE saved_cases SET current_approved_version_id=$2 WHERE id=$1',
            [caseId, versionId],
          );
        });
        const binding = parseContract('RegressionBinding', {
          sourceVersionId: versionId,
          sourceDocumentSha256: sha,
          snapshotDocumentSha256: sha,
          document,
          moduleSnapshots: [],
        });
        interactiveCase = parseContract('CaseDefinition', {
          id: randomUUID(),
          projectId: project.id,
          runId,
          version: 1,
          title: MULTI ? 'T18 冻结双阶段业务回归' : 'T17 冻结业务表单回归',
          summary: '人工批准的固定输入、有限 AI 动作及确定性结果断言',
          preconditions: ['仅本地只读提交模拟，禁止外部业务操作'],
          outline: document.steps.map((step) => step.kind),
          criteria: createRegressionPlan(binding, {
            projectId: project.id,
            allowedOrigins: [origin],
            env: {},
            maxExpandedSteps: DEFAULT_LIMITS.maxActionsPerCase,
          }).criteria,
          regression: binding,
        });
      }
      const run = await coordinator.start(
        actor,
        {
          projectId: project.id,
          targetUrl: entry,
          ...(brief ? { brief } : {}),
        },
        {
          allowedOrigins: [origin],
          actionPolicy: 'non_submitting',
          budget: DEFAULT_LIMITS,
          environmentVersion: null,
          authProfileVersion: null,
          knowledgeVersionIds: [],
          models: bindings,
        },
        randomUUID(),
        interactiveCase ? [interactiveCase] : fixedCase ? [fixedCase] : [],
      );
      const runtime = new RuntimeClient(
        coordinator,
        {
          projectId: project.id,
          workerId: `t14-worker-${randomUUID()}`,
        },
        new ArtifactStore(join(root, 'artifacts')),
        modelOptions,
      );
      if (T26 && REAL && process.env.LOCALQA_T31_OUTPUT_SHAPES === '1') {
        const modelCall = runtime.model.bind(runtime);
        runtime.model = async (...args) => {
          const record = await modelCall(...args);
          if (record.requestResult === 'malformed') {
            // The log is exclusively an allowlisted set of response-shape
            // enum values. Never persist/print raw or redacted model text.
            console.log(
              'T31_OUTPUT_SHAPE',
              JSON.stringify({
                requestResult: 'malformed',
                validationFailureKind: record.validationFailureKind ?? null,
                shapeTrace: record.outputShapeTrace ?? [],
                repairCount: record.repairCount,
                outputTokens: record.outputTokens,
                providerCalls: record.providerCalls,
              }),
            );
          }
          return record;
        };
      }
      const worker = new Worker({
        runtime,
        browser,
        scratch: join(root, 'scratch'),
        heartbeatMs: 200,
        leaseSeconds: 45,
        pollMs: 100,
      });
      let last = null;
      let sawSuspected = false;
      let interruptedReproducer = false;
      for (let i = 0; i < 35; i++) {
        await coordinator.tick(project.id);
        const queuedReproducer =
          T16 === 'interrupted' && !interruptedReproducer
            ? await db.actor(
                actor,
                async (client) =>
                  (
                    await client.query(
                      `SELECT id FROM jobs WHERE project_id=$1 AND run_id=$2
                   AND role='reproducer' AND status='queued' LIMIT 1`,
                      [project.id, run.id],
                    )
                  ).rows[0],
              )
            : null;
        if (queuedReproducer) {
          const lease = await runtime.claim(45);
          assert.equal(lease?.task.id, queuedReproducer.id);
          await runtime.stop(
            {
              taskId: lease.task.id,
              leaseToken: lease.leaseToken,
              fencingToken: lease.fencingToken,
              contextVersion: lease.contextVersion,
            },
            'worker_failure',
          );
          interruptedReproducer = true;
        } else {
          await worker.once();
        }
        if (FINDING) {
          const states = await db.actor(
            actor,
            async (client) =>
              (
                await client.query(
                  'SELECT status FROM findings WHERE project_id=$1 AND run_id=$2',
                  [project.id, run.id],
                )
              ).rows,
          );
          if (states.some((row) => row.status === 'suspected')) {
            sawSuspected = true;
            if (T16) fixtureRecovered = true;
          }
        }
        last = await db.actor(
          actor,
          async (client) =>
            (
              await client.query(
                'SELECT status,phase,completion FROM runs WHERE id=$1',
                [run.id],
              )
            ).rows[0],
        );
        if (['completed', 'failed', 'cancelled'].includes(last?.status)) break;
      }
      const observations = await db.actor(actor, async (client) => {
        const calls = (
          await client.query(
            'SELECT status,redacted_diagnostic FROM model_requests WHERE project_id=$1 AND run_id=$2',
            [project.id, run.id],
          )
        ).rows;
        const counts = (
          await client.query(
            `SELECT
           (SELECT count(*)::integer FROM action_intents WHERE project_id=$1 AND run_id=$2) AS action_count,
           (SELECT count(*)::integer FROM action_intents WHERE project_id=$1 AND run_id=$2 AND tool_call->>'name'='click' AND outcome='succeeded') AS clicked,
           (SELECT count(*)::integer FROM artifacts WHERE project_id=$1 AND run_id=$2) AS artifacts,
           (SELECT count(*)::integer FROM case_attempts WHERE project_id=$1 AND run_id=$2) AS attempts`,
            [project.id, run.id],
          )
        ).rows[0];
        const verdicts = (
          await client.query(
            `SELECT v.document->>'status' AS verdict_status
             FROM verdicts v
             JOIN case_attempts a ON a.project_id=v.project_id
               AND a.id=v.attempt_id
             WHERE a.project_id=$1 AND a.run_id=$2`,
            [project.id, run.id],
          )
        ).rows.map((r) => r.verdict_status);
        return { calls, counts, verdicts };
      });
      if (INTERACTIVE && observations.calls.length < 1) {
        const jobs = await db.actor(
          actor,
          async (client) =>
            (
              await client.query(
                `SELECT role,status,result->>'stage' AS stage,
                    result->'regressionReplay'->>'reasonCode' AS replay_reason
             FROM jobs WHERE project_id=$1 AND run_id=$2 ORDER BY id`,
                [project.id, run.id],
              )
            ).rows,
        );
        console.log(
          'T17 limited diagnostic',
          JSON.stringify({
            run: last,
            requests,
            providerCallStates: observations.calls.map((c) => ({
              status: c.status,
              errorCode: c.redacted_diagnostic?.errorCode,
            })),
            jobs,
            counts: observations.counts,
            verdicts: observations.verdicts,
          }),
        );
      }
      assert.ok(
        requests >= (MULTI ? 2 : INTERACTIVE ? 1 : REAL ? 1 : 2),
        'the model gateway must send provider requests',
      );
      if (!REAL) assert.equal(delayed, 1, 'the first response exceeds 1s');
      assert.ok(
        observations.calls.length >= (MULTI ? 2 : INTERACTIVE ? 1 : 2),
        'model_requests must persist model calls',
      );
      assert.ok(
        observations.calls.some((r) => r.status === 'settled'),
        'model reservation must be settled after provider reply',
      );
      assert.ok(
        observations.counts.action_count > 0,
        'browser actions must go through intents',
      );
      assert.equal(
        proposedClicks,
        0,
        'healthy read-only smoke does not request a click',
      );
      if (
        T26 &&
        REAL &&
        observations.counts.clicked !== (INTERACTIVE_BROKEN ? 4 : 2)
      ) {
        const diagnostic = await db.actor(actor, async (client) => ({
          actions: (
            await client.query(
              `SELECT tool_call->>'name' AS name,outcome
               FROM action_intents WHERE project_id=$1 AND run_id=$2`,
              [project.id, run.id],
            )
          ).rows,
          jobs: (
            await client.query(
              `SELECT role,status,result->>'stage' AS stage,
                result->'regressionReplay'->>'reasonCode' AS replay_reason,
                result->'regressionReplay'->>'status' AS replay
               FROM jobs WHERE project_id=$1 AND run_id=$2`,
              [project.id, run.id],
            )
          ).rows,
        }));
        console.log(
          'T26_ALTERNATE_MODEL_PROGRESS',
          JSON.stringify({
            model: realProvider.model,
            runStatus: last?.status,
            completion: last?.completion,
            attemptedClicks: observations.counts.clicked,
            verdicts: observations.verdicts,
            providerCalls: requests,
            modelCallStates: observations.calls.map((c) => ({
              status: c.status,
              errorCode: c.redacted_diagnostic?.errorCode ?? null,
            })),
            actions: diagnostic.actions,
            jobs: diagnostic.jobs,
          }),
        );
      }
      assert.equal(
        observations.counts.clicked,
        INTERACTIVE ? (INTERACTIVE_BROKEN ? 2 : 1) * (MULTI ? 2 : 1) : 0,
        INTERACTIVE
          ? 'approved AI action must click exactly one in-scope button'
          : 'read-only smoke cannot click a business control',
      );
      assert.ok(
        observations.counts.artifacts > 0,
        'a real Chromium screenshot must be persisted',
      );
      assert.ok(
        observations.counts.attempts > 0,
        'a real case attempt must be persisted',
      );
      if (!REAL) {
        assert.equal(last?.status, 'completed');
        assert.equal(last?.completion, 'complete');
      } else {
        assert.equal(
          last?.status,
          'completed',
          'real model must finish a browser-backed smoke run',
        );
        if (!['blocked', 'interrupted'].includes(T16))
          assert.equal(
            last?.completion,
            'complete',
            'unblocked case must complete with valid evidence',
          );
        assert.ok(
          observations.calls.every((c) => c.status === 'settled'),
          'all real model calls must settle the actual budget',
        );
        assert.ok(
          observations.verdicts.includes(
            FINDING || INTERACTIVE_BROKEN ? 'issue_found' : 'passed',
          ),
          'real browser oracle must yield the frozen criterion verdict',
        );
      }
      let interactionEvidence = null;
      let interactiveIndependent = null;
      if (INTERACTIVE) {
        interactionEvidence = await db.actor(actor, async (client) => {
          const actions = (
            await client.query(
              `SELECT i.tool_call->>'name' AS action,i.outcome,
                    s.document->'regressionSource' AS regression_source
             FROM action_intents i JOIN steps s
               ON s.project_id=i.project_id AND s.action_id=i.id
             WHERE i.project_id=$1 AND i.run_id=$2
             ORDER BY s.seq`,
              [project.id, run.id],
            )
          ).rows;
          const jobs = (
            await client.query(
              `SELECT role,status,result->'regressionReplay' AS replay
             FROM jobs WHERE project_id=$1 AND run_id=$2 AND role='executor'`,
              [project.id, run.id],
            )
          ).rows;
          return { actions, jobs };
        });
        assert.equal(run.executionMode, 'regression');
        assert.equal(interactionEvidence.jobs.length, 1);
        assert.equal(
          interactionEvidence.jobs[0].replay?.status,
          INTERACTIVE_BROKEN ? 'failed' : 'completed',
        );
        assert.equal(
          interactionEvidence.actions.filter(
            (a) => a.action === 'type_text' && a.outcome === 'succeeded',
          ).length,
          INTERACTIVE_BROKEN ? 2 : 1,
        );
        assert.equal(
          interactionEvidence.actions.filter(
            (a) => a.action === 'click' && a.outcome === 'succeeded',
          ).length,
          (INTERACTIVE_BROKEN ? 2 : 1) * (MULTI ? 2 : 1),
        );
        assert.ok(
          interactionEvidence.actions.every((a) => a.regression_source),
          'every interactive action must bind to frozen approved source',
        );
        assert.deepEqual(
          observations.verdicts.sort(),
          INTERACTIVE_BROKEN ? ['issue_found', 'issue_found'] : ['passed'],
        );
        if (INTERACTIVE_BROKEN) {
          const independent = await db.actor(actor, async (client) => {
            const findings = (
              await client.query(
                'SELECT status,document FROM findings WHERE project_id=$1 AND run_id=$2',
                [project.id, run.id],
              )
            ).rows;
            const contexts = (
              await client.query(
                'SELECT context_id FROM case_attempts WHERE project_id=$1 AND run_id=$2',
                [project.id, run.id],
              )
            ).rows;
            const verdictEvidence = (
              await client.query(
                `SELECT v.document->'criterionResults' AS results FROM verdicts v
                 JOIN case_attempts a ON a.project_id=v.project_id
                   AND a.id=v.attempt_id
                 WHERE a.project_id=$1 AND a.run_id=$2`,
                [project.id, run.id],
              )
            ).rows;
            return { findings, contexts, verdictEvidence };
          });
          assert.equal(independent.findings.length, 1);
          assert.equal(independent.findings[0].status, 'confirmed');
          assert.equal(
            new Set(independent.contexts.map((x) => x.context_id)).size,
            2,
          );
          assert.equal(independent.verdictEvidence.length, 2);
          const [first, second] = independent.verdictEvidence.map((row) =>
            (row.results ?? []).flatMap((criterion) =>
              Array.isArray(criterion.evidenceRefs)
                ? criterion.evidenceRefs
                : [],
            ),
          );
          assert.ok(first.length > 0 && second.length > 0);
          assert.equal(
            first.some((ref) => second.includes(ref)),
            false,
            'independent reproduction cannot reuse the first verdict evidence',
          );
          interactiveIndependent = {
            findingStatus: independent.findings[0].status,
            distinctContexts: 2,
            distinctEvidence: true,
          };
        }
      }
      let findingEvidence = null;
      if (FINDING) {
        findingEvidence = await db.actor(actor, async (client) => {
          const findings = (
            await client.query(
              'SELECT id,status,original_attempt_id,criteria_hash,document FROM findings WHERE project_id=$1 AND run_id=$2',
              [project.id, run.id],
            )
          ).rows;
          const reproductions = (
            await client.query(
              'SELECT finding_id,attempt_id,criteria_hash,fresh_context,outcome,document FROM reproductions WHERE project_id=$1 AND run_id=$2',
              [project.id, run.id],
            )
          ).rows;
          const attempts = (
            await client.query(
              'SELECT a.id,a.context_id,j.role FROM case_attempts a JOIN jobs j ON j.project_id=a.project_id AND j.id=a.task_id WHERE a.project_id=$1 AND a.run_id=$2 ORDER BY a.started_at,a.id',
              [project.id, run.id],
            )
          ).rows;
          const modelRoles = (
            await client.query(
              "SELECT DISTINCT redacted_diagnostic->>'role' AS role FROM model_requests WHERE project_id=$1 AND run_id=$2",
              [project.id, run.id],
            )
          ).rows.map((row) => row.role);
          return { findings, reproductions, attempts, modelRoles };
        });
        assert.equal(
          sawSuspected,
          true,
          'suspected must exist before the fresh reproducer completes',
        );
        assert.equal(findingEvidence.findings.length, 1);
        if (T16 === 'interrupted') {
          const original = findingEvidence.findings[0];
          assert.equal(interruptedReproducer, true);
          assert.equal(original.status, 'blocked');
          assert.equal(original.document.reproductionRef, null);
          assert.equal(
            findingEvidence.reproductions.length,
            0,
            'interruption cannot fabricate an independently verified reproduction',
          );
          assert.deepEqual(
            observations.verdicts.sort(),
            ['inconclusive', 'issue_found'],
            'interrupted recovery records uncertainty, not reproduced failure',
          );
          assert.equal(findingEvidence.attempts.length, 2);
          assert.equal(
            new Set(findingEvidence.attempts.map((a) => a.context_id)).size,
            2,
          );
          assert.ok(
            !findingEvidence.modelRoles.includes('reproducer'),
            'a stopped worker must not be counted as a model reproduction',
          );
        } else {
          if (T16 === 'blocked' && findingEvidence.reproductions.length !== 1) {
            const diagnosticJobs = await db.actor(
              actor,
              async (client) =>
                (
                  await client.query(
                    `SELECT role,status,result->>'stage' AS stage,
                  result->'regressionReplay'->>'reasonCode' AS replay_reason
                 FROM jobs WHERE project_id=$1 AND run_id=$2`,
                    [project.id, run.id],
                  )
                ).rows,
            );
            console.log(
              'T25_T16_BLOCKED_DIAGNOSTIC',
              JSON.stringify({
                run: last,
                jobs: diagnosticJobs,
                findingStatuses: findingEvidence.findings.map((f) => f.status),
                verdicts: observations.verdicts,
                attempts: findingEvidence.attempts.length,
                providerRequests: requests,
                settledCalls: observations.calls.filter(
                  (c) => c.status === 'settled',
                ).length,
              }),
            );
          }
          assert.equal(findingEvidence.reproductions.length, 1);
          const original = findingEvidence.findings[0];
          const repeated = findingEvidence.reproductions[0];
          assert.equal(
            original.status,
            T16 === 'unconfirmed'
              ? 'unconfirmed'
              : T16 === 'blocked'
                ? 'blocked'
                : 'confirmed',
          );
          assert.equal(original.document.expectedSource, 'user_spec');
          assert.equal(
            repeated.outcome,
            T16 === 'unconfirmed'
              ? 'not_reproduced'
              : T16 === 'blocked'
                ? 'blocked'
                : 'reproduced',
          );
          assert.equal(repeated.fresh_context, true);
          assert.equal(repeated.criteria_hash, original.criteria_hash);
          assert.equal(original.document.reproductionRef, repeated.document.id);
          assert.equal(findingEvidence.attempts.length, 2);
          assert.deepEqual(findingEvidence.attempts.map((a) => a.role).sort(), [
            'executor',
            'reproducer',
          ]);
          assert.equal(
            new Set(findingEvidence.attempts.map((a) => a.context_id)).size,
            2,
            'a fresh browser context is mandatory',
          );
          assert.ok(
            findingEvidence.attempts.some(
              (a) => a.id === original.original_attempt_id,
            ),
          );
          assert.ok(
            findingEvidence.attempts.some((a) => a.id === repeated.attempt_id),
          );
          assert.ok(original.document.evidenceRefs.length > 0);
          assert.ok(repeated.document.evidenceRefs.length > 0);
          assert.equal(
            original.document.evidenceRefs.some((id) =>
              repeated.document.evidenceRefs.includes(id),
            ),
            false,
            'independent reproduction must supply new evidence IDs',
          );
          assert.deepEqual(
            observations.verdicts.sort(),
            [
              'issue_found',
              T16 === 'unconfirmed'
                ? 'passed'
                : T16 === 'blocked'
                  ? 'blocked'
                  : 'issue_found',
            ].sort(),
          );
          if (T16 === 'blocked')
            assert.ok(
              !findingEvidence.modelRoles.includes('reproducer'),
              'an HTTP 503 error page must be handled by the fixed oracle without AI decisions',
            );
          else
            assert.ok(
              findingEvidence.modelRoles.includes('reproducer'),
              'real model must be invoked in an observable reproduction',
            );
        }
      }
      // Same production gateway and browser policy: a model-suggested click
      // on an unapproved smoke run is not an execution grant. Rejected
      // model output may fail the run, but must never mutate fixture state.
      proposeUnauthorizedClick = !REAL && !INTERACTIVE;
      let unsafeStatus = null;
      let unsafeClicks = null;
      let exploreDenials = null;
      if (!REAL && !INTERACTIVE) {
        const unsafeRun = await coordinator.start(
          actor,
          { projectId: project.id, targetUrl: origin + '/cn' },
          {
            allowedOrigins: [origin],
            actionPolicy: 'non_submitting',
            budget: DEFAULT_LIMITS,
            environmentVersion: null,
            authProfileVersion: null,
            knowledgeVersionIds: [],
            models: bindings,
          },
          randomUUID(),
        );
        for (let i = 0; i < 35; i++) {
          await coordinator.tick(project.id);
          await worker.once();
          unsafeStatus = await db.actor(
            actor,
            async (client) =>
              (
                await client.query('SELECT status FROM runs WHERE id=$1', [
                  unsafeRun.id,
                ])
              ).rows[0]?.status,
          );
          if (['completed', 'failed', 'cancelled'].includes(unsafeStatus))
            break;
        }
        assert.equal(
          proposedClicks,
          1,
          'mock model proposed a fresh DOM click',
        );
        assert.equal(
          unsafeStatus,
          'completed',
          'independent technical smoke can complete despite denied model action',
        );
        unsafeClicks = await db.actor(
          actor,
          async (client) =>
            (
              await client.query(
                `SELECT count(*)::integer AS count FROM action_intents
             WHERE project_id=$1 AND run_id=$2
               AND tool_call->>'name'='click'`,
                [project.id, unsafeRun.id],
              )
            ).rows[0]?.count,
        );
        assert.equal(
          unsafeClicks,
          0,
          'model output did not acquire a browser click grant',
        );
        exploreDenials = await db.actor(
          actor,
          async (client) =>
            (
              await client.query(
                `SELECT result->>'modelActionDenials' AS denials,
                    result->'warnings' AS warnings
             FROM jobs WHERE project_id=$1 AND run_id=$2
               AND role='explorer' LIMIT 1`,
                [project.id, unsafeRun.id],
              )
            ).rows[0],
        );
        assert.equal(Number(exploreDenials?.denials), 1);
        assert.ok(Array.isArray(exploreDenials?.warnings));
      }
      console.log(
        JSON.stringify({
          ...(T26
            ? {
                fixtureId: T26.id,
                provider: INTERACTIVE_SIM ? 'synthetic' : realProvider.label,
                configuredModelId: INTERACTIVE_SIM
                  ? 'wire-fixture-model'
                  : realProvider.model,
                oracleKind: 'text_equals',
                expectedResult: T26.expected,
              }
            : {}),
          gate: T26
            ? `T26 ${INTERACTIVE_SIM ? 'G2 synthetic' : 'G3 real ' + realProvider.label} ${T26.id}: ${INTERACTIVE_BROKEN ? 'seeded wrong value independently reproduced' : 'exact healthy business result'}`
            : INTERACTIVE
              ? INTERACTIVE_BROKEN
                ? `${MULTI ? 'T18' : 'T17'} ${INTERACTIVE_SIM ? 'G2 synthetic wire' : 'real AI'} detects form state mismatch and independently reproduces`
                : `${MULTI ? 'T18' : 'T17'} ${INTERACTIVE_SIM ? 'G2 synthetic wire' : 'real AI'} approved form input, ${MULTI ? 'two model-selected buttons' : 'model-selected button'}, browser oracle`
              : T16
                ? `T16 real model non-confirmation / ${T16}`
                : FINDING
                  ? 'T15 real model + sourced oracle + independent fresh-context reproduction'
                  : REAL
                    ? 'G3 real moan2 upstream; verdict from browser evidence'
                    : 'G2 simulated provider-wire; NOT G3',
          providerCalls: requests,
          delayedOver1s: delayed,
          recordedModelCalls: observations.calls.length,
          settledCalls: observations.calls.filter((r) => r.status === 'settled')
            .length,
          browserActions: observations.counts.action_count,
          ...(T26 &&
          process.env.LOCALQA_T32_ACTION_COUNTS === '1' &&
          interactionEvidence
            ? {
                actionCounts: Object.fromEntries(
                  [...new Set(interactionEvidence.actions.map((a) => a.action))]
                    .sort()
                    .map((name) => [
                      name,
                      interactionEvidence.actions.filter(
                        (a) => a.action === name && a.outcome === 'succeeded',
                      ).length,
                    ]),
                ),
              }
            : {}),
          ...(INTERACTIVE
            ? { authorizedClicks: observations.counts.clicked }
            : { unauthorizedClicks: observations.counts.clicked }),
          ...(interactionEvidence
            ? {
                typedAction: interactionEvidence.actions.some(
                  (a) => a.action === 'type_text' && a.outcome === 'succeeded',
                ),
                modelClickAction: interactionEvidence.actions.some(
                  (a) => a.action === 'click' && a.outcome === 'succeeded',
                ),
                allActionsBoundToApprovedVersion:
                  interactionEvidence.actions.every((a) =>
                    Boolean(a.regression_source),
                  ),
                regressionReplay: interactionEvidence.jobs[0].replay?.status,
                ...(interactiveIndependent ?? {}),
              }
            : {}),
          artifacts: observations.counts.artifacts,
          caseAttempts: observations.counts.attempts,
          caseVerdicts: observations.verdicts,
          reportedModelIds: [
            ...new Set(
              observations.calls
                .map((c) => c.redacted_diagnostic?.reportedModelId)
                .filter(Boolean),
            ),
          ],
          usageSources: [
            ...new Set(
              observations.calls
                .map((c) => c.redacted_diagnostic?.usageSource)
                .filter(Boolean),
            ),
          ],
          // Report provider usage by provenance. Null means missing, never
          // fabricated zero usage or an assumed USD billable amount.
          usageTotals: observations.calls.every(
            (c) =>
              c.redacted_diagnostic?.usageSource === 'reported' &&
              Number.isSafeInteger(c.redacted_diagnostic?.inputTokens) &&
              Number.isSafeInteger(c.redacted_diagnostic?.outputTokens),
          )
            ? {
                inputTokens: observations.calls.reduce(
                  (sum, c) => sum + c.redacted_diagnostic.inputTokens,
                  0,
                ),
                outputTokens: observations.calls.reduce(
                  (sum, c) => sum + c.redacted_diagnostic.outputTokens,
                  0,
                ),
                provenance: 'reported',
              }
            : null,
          runStatus: last.status,
          completion: last.completion,
          ...(findingEvidence
            ? {
                findingStatus: findingEvidence.findings[0].status,
                suspectedObserved: sawSuspected,
                reproductionOutcome:
                  findingEvidence.reproductions[0]?.outcome ??
                  'interrupted_without_verdict',
                distinctContexts: new Set(
                  findingEvidence.attempts.map((a) => a.context_id),
                ).size,
                distinctEvidence: true,
                modelRoles: findingEvidence.modelRoles,
                ...(T16
                  ? { fixtureChangedAfterSuspected: fixtureRecovered }
                  : {}),
              }
            : {}),
          ...(REAL || INTERACTIVE
            ? {}
            : {
                unauthorizedRunStatus: unsafeStatus,
                unauthorizedClickGrants: unsafeClicks,
                deniedModelActionCount: Number(exploreDenials.denials),
              }),
        }),
      );
    } finally {
      await browser?.close();
      await db?.close();
      if (fixture) await new Promise((resolve) => fixture.close(resolve));
      if (container) docker(['rm', '--force', '--volumes', container]);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
