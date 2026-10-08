# 只读审查：originCriteria、unknown outcome、AJV uuid/uri

审查时间：2026-10-05。审查者本轮没有改任何项目源码，没有 git reset/commit，没有启动 Postgres、浏览器、worker-entry、外部模型或新监控器。没有把 Root 独立跑过的 Worker 15/15、D4+B4 34/34、33 图片、32 存储、70 前端、39 Node 24 记成这次审查的结果。G3Passed 与 P0Passed 仍为 false。ego 未使用。未启动容器。

结论：未发现 originCriteria 或 unknown outcome 能把准则判成通过，也未发现 AI 工具能绕过 grant。裸 Ajv 会忽略 `uuid`/`uri` 并打印警告，但同一次 `generateDecision` 在返回 `ok` 之前已经用契约校验拦住非法 ToolCall。这不是 P0/G3 通过。

## 源码边界

审查的是当时工作区文件。SHA-256 与 mtime：

| 文件 | SHA-256 | mtime |
|---|---|---|
| apps/worker/src/index.ts | 72b724d3729f56d1187529085691e3d33efe1df7aec966ddf0d1a1c5fae2bcf3 | 2026-10-05 19:58:43 |
| apps/worker/src/regression-ai.ts | 7e5e037899b625428ec0834cb5842be8851f3613d22bbf033f832a52b48f3be4 | 2026-10-05 19:26:30 |
| apps/worker/src/regression-replay.ts | 7c00a289a80c8e79794aba8a6c6ef66d04ed773229166a719c8c775ef026f1a7 | 2026-10-05 19:01:28 |
| packages/orchestrator/src/core.ts | 914cff3973875971c1a6a9d199eddf0a85f363f81e7069dedc6f314a17057b57 | 2026-10-05 20:05:01 |
| packages/orchestrator/src/runtime.ts | 949fcea95ea0aa06a4d5b4168ebcd600c9fac9b0693e80fd2a5eaf719e989faf | 2026-10-05 19:56:26 |
| packages/orchestrator/src/regression-plan.ts | cea17b3b0b491eb4b8728b25355fe47b97ed28f8df7b67d66edfb86e49cc9110 | 2026-10-05 19:42:26 |
| packages/orchestrator/src/regression-compiler.ts | 9133df1fcaeb7e2c708fee9c33201c06e13ca68ac8755ce09679d7f3201b2f77 | 2026-10-05 19:42:54 |
| packages/orchestrator/src/model.ts | fddba4f59e0cf514669d5701133c140cfcdbfe5ec363de54dcdcae678baf5aaa | 2026-10-05 15:21:22 |
| packages/domain/src/index.ts | a6b275e7a86cfad37f30777349aefbf7764bbb5e723cd53060b9a956401d2d38 | 2026-10-02 19:52:33 |
| packages/model-gateway/src/gateway.ts | bd390c5a3808c06ee8154f2819902e461e751fe45278f3b474fd8ca42e826a7f | 2026-10-05 15:32:16 |
| packages/agents/src/loop.ts | fc4a06db9ec3efef04d44dfe839e850f0402c0312d8b5a025c83243340a258c1 | 2026-10-04 13:35:27 |
| packages/agents/src/dispatcher.ts | a8bdbc71e45291361f58babd391e51f97cf160bdf4b6377952c398c2205f355b | 2026-10-02 20:56:22 |
| packages/contracts/src/index.ts | 00999dcfb567841e77e7928294c0fb4bab441f3166c888a7aed8fb98cc73db4c | 2026-10-02 16:21:50 |
| apps/worker/dist/index.js | 388da3f110e06505f130df28455e9d7895de53a98c96f1db5b122a925fcbadff | 2026-10-05 20:05:03 |
| packages/orchestrator/dist/core.js | 68fbdc064c7439b52c34a68d5634e8d2f9b00d4fb58f2316bfdf44bd4eb43ac6 | 2026-10-05 20:05:02 |
| packages/orchestrator/dist/regression-plan.js | 5c2147e09f5bfa577a7ed97b7e7405f3ab954002664418d0beeb58f3a5799e8e | 2026-10-05 20:05:02 |
| packages/orchestrator/dist/runtime.js | 34c1713183f78cb3134f88e64308fc4a9a7f979b9c656e7a83119a1836aa8536 | 2026-10-05 20:05:02 |
| packages/model-gateway/dist/gateway.js | b0b94cf88fc153395285c91c449ca32fcb8cc4f0e50bb3f736f29157c82209c2 | 2026-10-05 19:01:08 |
| packages/agents/dist/loop.js | a9760c659c5235ed56b316f4ba1007fdb451dd10da40c30dcf42b0bec96cb608 | 2026-10-05 19:01:09 |

dist 里已核对到的对应字符串：worker dist 有 `record(proof, grant, 'unknown', null)` 和 `originCriteria`；orchestrator dist `regression-plan.js` 有 `originCriteria`；`core.js` 有 `source === 'unknown'`、`Action outcome unknown after interruption`、`Worker interrupted; action will not be replayed`；`runtime.js` 的 `record` 把 status 原样转给 `recordAction`；`gateway.js` 有 `new Ajv({ allErrors: true, strict: false })` 和 `toolCallsMatchContract`。没有做整文件 source/dist diff。这轮没有重新 emit tsc。

这次审查不覆盖更早那份 B5 审查的边界说明。那份在 `/tmp/herdr-fallback-01a0fb93-b5-readonly.md`，Root 另存于 `docs/validation-results/T10-B5-agent-readonly-review.md`。本文件不改那两份。

## originCriteria

事实，来自 `packages/orchestrator/src/regression-plan.ts` 与 `regression-compiler.ts`：

- `compileRegression` 返回的步骤只有 `step`、`criteria`、`source`。`originCriteria` 只出现在类型上，编译器不赋值。
- `scoped()` 对副本做 `parseContract('Criterion')`，写入 `sourceKind: 'saved_case'` 和 `sourceRef: binding.sourceVersionId`，id 为 `` `r-${hashPayload({ path, originalId }).slice(0, 62)}` ``。
- `originCriteria` 是平行数组：`{ ...original, id: frozen[index].id }`。原 `sourceKind`、`expectedValue`、`locator`、`kind` 留在这条数组上。冻结 `plan.criteria` 仍是 saved_case。
- `apps/api/src/routes/savedCases.ts` 把 `plan.criteria` 放进 `CaseDefinition.criteria`。准入时 `core.ts` 要求 `hashPayload(plan.criteria) === hashPayload(c.criteria)`，并核对 approved saved case 的 sha。
- `work()` 在 `hashPayload(snapshot.binding) === hashPayload(definition.regression)` 之后调用 `createRegressionPlan`。计划不来自模型消息。`grantAction` 也会按库中 binding 重算计划，用 source 哈希核对步骤；授权不读取 `originCriteria`。

Worker `evaluateCriterion`（`apps/worker/src/index.ts`）按 `hashPayload(entry.source) === hashPayload(source)` 找步骤，再按 `item.id === criterion.id` 找 origin。找不到则退回传入的冻结准则。

只有两个形状进入 `evaluateTechnical`：

1. `origin.sourceKind === 'generic_smoke'`，且冻结准则 `kind === 'http_status'`，且 `expectedValue` 是恰好两个键的对象 `{min:200, max:399}`。
2. `origin.sourceKind === 'generic_smoke'`，且冻结准则 `kind === 'element_visible'`，locator 为 `{by:'css', value:'body'}`，且 `expectedValue === undefined`。

其余路径：

- semantic / visual：仍要求 `errorCode === null`、`assessment.criterionId` 等于冻结准则、有 `criterionResult`、`acceptedEvidenceRefs` 非空且都属于 `knownEvidenceIds` 和本次 capture。
- 数值 `http_status`：用冻结 `criterion.expectedValue` 与 `current.responseStatus` 精确相等。
- `url_matches`：`displayUrl` 与冻结字符串精确相等。
- 有 owned node 时，`element_visible` / `text_equals` 用该节点，不用 origin 的宽松口。
- 对不上时默认 `result: 'unknown'`。

`packages/domain/src/index.ts` 的 `evaluateTechnical`：`http_status` + `generic_smoke` 不读存储的 min/max，硬编码 `httpStatus !== null && >= 200 && <= 399` 才是 `passed`，否则 `not_evaluated`，原因是 Infrastructure/entry HTTP response blocks evaluation。证据长度为 0 时，`passed`/`failed` 降为 `unknown`。Worker 传入的证据是本次 capture id，长度大于 0。

replay（`regression-replay.ts`）在 `evaluated.result !== 'passed'` 时停止。`failed` 记 failed，其他记 inconclusive，reason `CRITERION_NOT_PASSED`。`verdictStatus`：全部 `passed` 且证据非空才是 `passed`；有 `not_evaluated` 或非空 block reason 时是 `blocked`。`finish` 把 replay reason 传给 `verdictStatus`（`WORKER_INTERRUPTED` 除外）。因此 5xx 或 null 的 HTTP 口不会让整案变成 `passed`。

`css body` 可见性口不读 `responseStatus`。有可见主 frame 文本、角色不是 password/hidden/canvas 时为 `passed`；空白页在 `generic_smoke` 上是 `unknown`。所以一份只有这条可见性准则、没有 HTTP 准则的批准用例，可以在 5xx 页面上因可见文本通过。这是现有领域 oracle，不是把 HTTP 区间放宽。Worker 的形状门要求 expected 恰好是 200–399，所以不能靠改 min/max 放宽 HTTP 口。其他 `generic_smoke` 形状不会进入 `evaluateTechnical`。

AI 循环仍把冻结 `item.criteria` 交给模型和后续 `evaluate()`。`done: true` 只结束循环。`regression-ai.ts` 在执行前走 `createPolicyDispatcher`。dispatcher 拒绝则抛错，replay 停止，该步准则不会被记成 passed。

静态判断：这条恢复口没有发现明确误通过，也没有发现模型能改写 origin 或跳过 grant。未跑用例确认 visible-only 在 5xx 上的产品是否接受。

## unknown outcome、fencing、预算

事实：

- `runtime.ts` 的 `record` 状态联合包含 `'succeeded' | 'failed' | 'cancelled' | 'unknown'`，原样调用 `recordAction`。dist `runtime.js` 同样转发，没有在 JS 里再滤枚举。
- Worker 在浏览器调用已成功返回之后，把中止、capture 解析/路径、`parseContract('BrowserSnapshot')` 放在同一个 try 里。catch 调用 `record(proof, grant, 'unknown', null)`，再把原错误抛出。`.catch(() => {})` 吞掉 unknown 记录自身的失败。调用前的失败记 `failed`；非 succeeded 状态记 `cancelled` 或 `failed`；执行前 abort 记 `cancelled`。成功返回之后的 abort 记 `unknown`。
- `recordAction`：lease 校验后，intent 的 `fencing_token` 必须等于 proof，否则 `LEASE_EXPIRED`。step 的 `regressionSource` 哈希必须等于 grant，否则 `VALIDATION_ERROR`。`outcome !== 'pending'` 时，只有相同 `result_hash` 才幂等返回，否则 `IDEMPOTENCY_CONFLICT`。`snapshot` 非空才 `parseContract`、做 origin 检查并插入；unknown 路径传 null，畸形快照不会入库。证据 id 必须全是本 project/run/task 的 artifact，空数组通过。然后 outcome=status，step status=status，summary `` `Browser ${status}` ``，`settleIn(..., {actions:1}, status==='unknown' ? 'unknown' : 'reported')`，再发 `step.recorded`。
- `settleIn`：fencing、lease、worker 对不上则 `LEASE_EXPIRED`。status 已是 `unknown` 时直接 return。`source==='unknown'` 时 `charged = r.reserved`（整笔预留，不是调用方另传的金额），reservation status=`unknown`。action 的 `reserve` 金额是 `{actions:1}`。同时把该 reservation 上仍为 reserved 的 `model_requests` 标成 unknown。已结算且 charged 哈希不同则 `IDEMPOTENCY_CONFLICT`。
- `interrupt`：本任务 `outcome='pending'` 的 intent 改为 `unknown`。然后更新「intent outcome 为 unknown 且 step status 为 running」的文档：status unknown、finishedAt 当前时间、summary `Action outcome unknown after interruption`，`parseContract('Step')` 后逐条 `step.recorded`。预算只 `SELECT ... status='reserved' FOR UPDATE`。concurrency 释放槽位；其余把 reserved 加进 used、从 reserved 减去，reservation `status='unknown'`、`charged=reserved`。已是 unknown 的 reservation 不在这轮里，不重复计费。随后把本任务仍为 reserved 的 model_requests 标 unknown。
- `tick` 另有一条：reservation 已是 unknown 而 model_requests 仍 reserved 时标 unknown；intent 已 unknown 且 step 仍 running 时把 step 写成 unknown，summary `Worker interrupted; action will not be replayed`，发 `step.recorded`。这条不经过 `parseContract`。
- `finish` 在把 job 标成 succeeded 之前查询本任务是否还有 `outcome='pending'` 的 intent，有则抛 `VALIDATION_ERROR`。因此 unknown 记录失败、intent 仍 pending 时，finish 不会成功收尾。
- Worker 外层 catch 在 replay 抛出或 finish 抛出时调用 `stop()`。`stopTask` 校验 lease 后调用 `interrupt`。replay 本身吞掉 execute 抛错并返回 stop 结果；畸形快照若 unknown 记录成功，intent 已不是 pending，finish 可以继续，但该步准则没有 passed 结果，缺失准则被填成 `not_evaluated`。
- replay 对 `!== 'passed'` 停止后续步骤。unknown 记录不插入可供后续 click 使用的成功快照。grant 的 latest success 只看 `outcome='succeeded'` 且非 capture。

静态判断：unknown 记账和 interrupt 收 Step 没有打开准则通过口，也没有绕过 fencing。整笔 action 预留只计一次。未在 Postgres 里执行 malformed snapshot 或 interrupt。两条失败都发生时（unknown 记录失败且随后的 stop/interrupt 也失败）是否仍留下 running step，没有执行。`tick` 那条不校验 Step 契约，也没有执行。

## AJV：复现与边界

代码事实：

- `packages/model-gateway/src/gateway.ts` 第 35 行是模块级 `const ajv = new Ajv({ allErrors: true, strict: false })`。依赖 ajv 8.20.0，没有 ajv-formats。
- 非 probe 时 `validator = ajv.compile(input.outputSchema)`。Ajv 在 `strictSchema === false` 且 format 未注册时 `logger.warn`，原文是 `` unknown format "${schema}" ignored in schema at path "${errSchemaPath}" ``，然后不生成 format 检查。
- Worker `decide` 把 orchestrator 再导出的 `DECISION_SCHEMA` 作为 `outputSchema`。`BoundModel.call` 对非 assertion 角色调用 `gateway.generateDecision`。`DECISION_SCHEMA` 定义在 `packages/agents/src/loop.ts`：`toolCalls.items` 是 `#/$defs/ToolCall`，`$defs` 来自 `tools.schema.json`。
- `parseWithSchema` 只用这只裸 Ajv。通过之后、`finish('ok'|'repaired', ..., parsed.value)` 之前，`toolCallsMatchContract` 对每个 call 执行 `validateContract('ToolCall')`。失败则 `finish('malformed', 'VALIDATION_ERROR', null, null)`。
- `validateContract` 使用 `packages/contracts/src/index.ts` 的 Ajv2020，`formatsPlugin` mode full，`validateFormats: true`。dispatcher 的 `getRootValidator('tools')` 是同一只 Ajv 上的 `tools.schema.json`，另外还有角色和未知 evidence 检查。dispatcher 是执行前的第二层，不是 decide 成功结果的唯一契约。
- navigate 的 url 同时有 `format: uri` 和 `pattern: ^https?://`。pattern 没有结尾锚点。format 被忽略时，以前缀 `http://` 或 `https://` 开头的非法 URI 仍能过裸 schema。
- `date-time` 与 `uri-reference` 出现在 BrowserSnapshot / Artifact 等结果定义上。本轮编译警告里没有它们，因为决策 schema 实际编译到的是 ToolCall 可达格式。

本轮实际执行的是 dist `createGateway` + stub adapter 的 `generateDecision`，不是 `BoundModel`，也没有 Postgres、租约或浏览器。provider 是进程内假发送，返回预设 JSON，无外网。

临时脚本 1：`/tmp/localqa-ajv-repro-01a0fb93.mjs`（跑完已删）。全文如下。

```javascript
import { pathToFileURL } from 'node:url';

const root = '/Users/dcp/Documents/公司/momentic';
const href = (path) => pathToFileURL(`${root}/${path}`).href;
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.map((item) => String(item)).join(' '));
};

const { createGateway } = await import(href('packages/model-gateway/dist/index.js'));
const agents = await import(href('packages/agents/dist/index.js'));
const orchestrator = await import(href('packages/orchestrator/dist/model.js'));
const { validateContract, getRootValidator } = await import(
  href('packages/contracts/dist/index.js')
);

const schema = agents.DECISION_SCHEMA;
const uuid = '11111111-1111-4111-8111-111111111111';
const samples = {
  'click-non-uuid': {
    done: false,
    toolCalls: [
      {
        name: 'click',
        args: {
          target: { snapshotId: 'not-a-uuid', pageId: 'also-not', nodeId: 'n1' },
        },
      },
    ],
  },
  'click-uuid': {
    done: false,
    toolCalls: [
      {
        name: 'click',
        args: { target: { snapshotId: uuid, pageId: uuid, nodeId: 'n1' } },
      },
    ],
  },
  'navigate-space': {
    done: false,
    toolCalls: [{ name: 'navigate', args: { url: 'http://exa mple.com/a' } }],
  },
  'navigate-javascript': {
    done: false,
    toolCalls: [{ name: 'navigate', args: { url: 'javascript:alert(1)' } }],
  },
  'navigate-https': {
    done: false,
    toolCalls: [{ name: 'navigate', args: { url: 'https://example.com/a' } }],
  },
  'observe-non-uuid': {
    done: false,
    toolCalls: [{ name: 'observe', args: { pageId: 'not-a-uuid' } }],
  },
  'done-empty': { done: true, toolCalls: [] },
};

let raw = '';
let sends = 0;
const gateway = createGateway({
  profiles: [
    {
      id: uuid,
      version: 1,
      name: 'local-repro',
      endpoint: 'http://stub.local/v1',
      configuredModelId: 'local-repro',
      kind: 'stub',
      dataBoundary: 'internal',
      capabilities: {
        structuredOutput: true,
        nativeTools: false,
        imageInput: false,
      },
      responseFormat: 'json_schema',
      encryptedApiKey: 'not-a-credential',
      approvedFallbackIds: [],
    },
  ],
  decryptKey: () => 'local-repro-key',
  adapter: {
    kind: 'stub',
    version: 'local-repro',
    build: () => ({ endpoint: 'http://stub.local/v1', body: {} }),
    send: async () => {
      sends += 1;
      return {
        raw,
        httpStatus: 200,
        reportedModelId: 'local-repro',
        usage: { inputTokens: 1, outputTokens: 1 },
        errorCode: null,
      };
    },
  },
});

const tools = getRootValidator('tools');
const results = [];
for (const [name, value] of Object.entries(samples)) {
  const before = warnings.length;
  const beforeSends = sends;
  raw = JSON.stringify(value);
  const record = await gateway.generateDecision({
    taskId: '22222222-2222-4222-8222-222222222222',
    profileId: uuid,
    contextVersion: 1,
    role: 'executor',
    promptVersion: 'repro',
    purpose: 'decide',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'repro' }] }],
    approvedImageIds: [],
    toolSchemas: [],
    outputSchema: schema,
    timeoutMs: 1000,
    maxOutputTokens: 400,
    maxInputTokens: 4000,
    knownEvidenceIds: [],
  });
  const contract = value.toolCalls.map((call) => validateContract('ToolCall', call).success);
  const dispatcher = value.toolCalls.map((call) => Boolean(tools(call)));
  results.push({
    name,
    requestResult: record.requestResult,
    errorCode: record.errorCode,
    dataIsNull: record.data === null,
    providerSends: sends - beforeSends,
    newWarnings: warnings.length - before,
    contract,
    dispatcher,
  });
}

const formats = new Map();
for (const line of warnings) {
  const match = line.match(/unknown format "([^"]+)"/);
  const format = match?.[1] ?? 'other';
  formats.set(format, (formats.get(format) ?? 0) + 1);
}
console.log(
  JSON.stringify(
    {
      schemaSame:
        JSON.stringify(schema) === JSON.stringify(orchestrator.DECISION_SCHEMA),
      warningTotal: warnings.length,
      warningFormats: Object.fromEntries(formats),
      firstWarning: warnings[0] ?? null,
      results,
    },
    null,
    2,
  ),
);
console.warn = originalWarn;
```

脚本 1 的实际 stdout：

```json
{
  "schemaSame": true,
  "warningTotal": 38,
  "warningFormats": {
    "uuid": 36,
    "uri": 2
  },
  "firstWarning": "unknown format \"uuid\" ignored in schema at path \"#/oneOf/0/properties/args/properties/pageId\"",
  "results": [
    {
      "name": "click-non-uuid",
      "requestResult": "malformed",
      "errorCode": "VALIDATION_ERROR",
      "dataIsNull": true,
      "providerSends": 1,
      "newWarnings": 38,
      "contract": [false],
      "dispatcher": [false]
    },
    {
      "name": "click-uuid",
      "requestResult": "ok",
      "errorCode": null,
      "dataIsNull": false,
      "providerSends": 1,
      "newWarnings": 0,
      "contract": [true],
      "dispatcher": [true]
    },
    {
      "name": "navigate-space",
      "requestResult": "malformed",
      "errorCode": "VALIDATION_ERROR",
      "dataIsNull": true,
      "providerSends": 1,
      "newWarnings": 0,
      "contract": [false],
      "dispatcher": [false]
    },
    {
      "name": "navigate-javascript",
      "requestResult": "malformed",
      "errorCode": "VALIDATION_ERROR",
      "dataIsNull": true,
      "providerSends": 2,
      "newWarnings": 0,
      "contract": [false],
      "dispatcher": [false]
    },
    {
      "name": "navigate-https",
      "requestResult": "ok",
      "errorCode": null,
      "dataIsNull": false,
      "providerSends": 1,
      "newWarnings": 0,
      "contract": [true],
      "dispatcher": [true]
    },
    {
      "name": "observe-non-uuid",
      "requestResult": "malformed",
      "errorCode": "VALIDATION_ERROR",
      "dataIsNull": true,
      "providerSends": 1,
      "newWarnings": 0,
      "contract": [false],
      "dispatcher": [false]
    },
    {
      "name": "done-empty",
      "requestResult": "ok",
      "errorCode": null,
      "dataIsNull": false,
      "providerSends": 1,
      "newWarnings": 0,
      "contract": [],
      "dispatcher": []
    }
  ]
}
```

同一进程里只有第一次 `generateDecision` 打印 38 行警告。后面 6 次 `newWarnings` 为 0。Ajv 缓存了这次 schema 编译。`schemaSame: true` 表示 agents dist 与 orchestrator dist 的 `DECISION_SCHEMA` JSON 相同。

`providerSends === 1` 且 `malformed` 表示裸 schema 已接受、契约随后拒绝，没有走修复重试。`javascript:` 的 `providerSends === 2` 是 pattern 让 `parseWithSchema` 失败后的一次修复重试，第二次仍失败。修复重试只再打 provider，不执行浏览器工具。

临时脚本 2：`/tmp/localqa-ajv-paths-01a0fb93.mjs`（跑完已删）。它只用同一只裸 Ajv 编译 dist `DECISION_SCHEMA`，不调用 gateway。全文：

```javascript
import { pathToFileURL } from 'node:url';

const root = '/Users/dcp/Documents/公司/momentic';
const warnings = [];
console.warn = (...args) => {
  warnings.push(args.map((item) => String(item)).join(' '));
};
const { Ajv } = await import(
  pathToFileURL(`${root}/packages/model-gateway/node_modules/ajv/dist/ajv.js`).href
);
const { DECISION_SCHEMA } = await import(
  pathToFileURL(`${root}/packages/agents/dist/index.js`).href
);
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(DECISION_SCHEMA);
const loose = validate({
  done: false,
  toolCalls: [
    {
      name: 'click',
      args: {
        target: { snapshotId: 'not-a-uuid', pageId: 'also-not', nodeId: 'n1' },
      },
    },
  ],
});
const spaced = validate({
  done: false,
  toolCalls: [{ name: 'navigate', args: { url: 'http://exa mple.com/a' } }],
});
const javascript = validate({
  done: false,
  toolCalls: [{ name: 'navigate', args: { url: 'javascript:alert(1)' } }],
});
const paths = [
  ...new Set(
    warnings.map((line) => {
      const format = line.match(/unknown format "([^"]+)"/)?.[1] ?? '?';
      const path = line.match(/path "([^"]+)"/)?.[1] ?? line;
      return `${format} ${path}`;
    }),
  ),
];
console.log(JSON.stringify({ looseClick: loose, spaced, javascript, paths }, null, 2));
```

脚本 2 的实际 stdout：

```json
{
  "looseClick": true,
  "spaced": true,
  "javascript": false,
  "paths": [
    "uuid #/oneOf/0/properties/args/properties/pageId",
    "uri #/oneOf/1/properties/args/properties/url",
    "uuid #/$defs/NodeTarget/properties/snapshotId",
    "uuid #/$defs/NodeTarget/properties/pageId",
    "uuid #/oneOf/6/properties/args/properties/pageId",
    "uuid #/oneOf/7/properties/args/properties/pageId",
    "uuid #/oneOf/9/properties/args/properties/pageId",
    "uuid #/oneOf/10/properties/args/properties/pageId",
    "uuid #/oneOf/12/properties/args/properties/caseId",
    "uuid #/oneOf/12/properties/args/properties/evidenceRefs/items",
    "uuid #/oneOf/14/properties/args/properties/evidenceRefs/items"
  ]
}
```

按 `docs/contracts/tools.schema.json` 里 ToolCall `oneOf` 的顺序，这些下标对应 observe、navigate、scroll、wait_for、inspect_network、capture、report_suspect、complete_reproduction。38 行警告是这些路径被重复报告；去重后是上面 11 条。`uri` 只有 navigate url 这一条路径，计数为 2。

建议：保留 `toolCallsMatchContract`。警告来自另一只没有 formats 的 Ajv，不代表 decide 的成功结果跳过了产品契约。若要消警告，用契约那只 Ajv2020（已加载 ajv-formats）编译 `DECISION_SCHEMA`，或给网关这只 Ajv 装上相同 formats。只关 logger 会藏起「format 被忽略」。不要新装一套依赖来替换已经存在的 `validateContract('ToolCall')`，也不要把 dispatcher 拒绝当成产品契约本身。本轮没有改代码，也没有安装包。

## 已执行

- 读了上表源码中的 origin 门、`recordAction`、`settleIn`、`interrupt`、`tick` 相关段、`finish` 的 pending 检查、`evaluateTechnical`、replay 停止条件、gateway 编译与 `toolCallsMatchContract`、dispatcher、`DECISION_SCHEMA`。
- 对 dist 做了字符串核对和 SHA。
- 跑了上面两个本地脚本，并删除它们。结束后 `ls` 确认这两个路径不存在。
- 假 provider 的 `generateDecision` 七个样本结果如上。裸 Ajv 对非 uuid click 和带空格的 http URL 返回 true，对 `javascript:` 返回 false。

## 静态读过、没有执行

- 没有 Postgres，因此没有跑 malformed BrowserSnapshot、pending interrupt、fencing 冲突、重复 unknown 结算。
- 没有 BoundModel、租约、冻结 profile、真实或付费模型。`generateDecision` 是 `BoundModel.call` 对 decide 使用的网关函数，但本轮没有构造 `BoundModel`。
- 没有浏览器、FakeBrowser、worker-entry、Playwright。
- 没有重跑 Worker 15/15、replay 15/15、D4、B4、图片、存储、前端、Node 24。那些数字是 Root 的陈述，不是本轮测量。
- 没有整文件证明 source 与 dist 字节一致，只核对了上述字符串、SHA 和时间。
- 没有证明 domain `ToolCall` 与 tools schema `ToolCall` 全文相同。本轮样本上 `validateContract('ToolCall')` 与 `getRootValidator('tools')` 结果一致。
- visible-only 的 generic_smoke 在 5xx 页面上可通过，只来自源码，没有用例。
- `tick` 补写 Step 不经过 `parseContract`；interrupt 那条经过。没有用坏文档触发其中一条。
- unknown 记录失败且 stop 也失败时的残留悬挂，没有执行。`finish` 对仍 pending 的 intent 会拒绝成功收尾，这是源码事实。

## 清理

ego 未使用。未启动 Docker，未碰已有容器或 volume。两个 `/tmp/localqa-ajv-*.mjs` 已删除。本文件是 Herdr recent-unwrapped 读不回全文后的回退副本，不是测试产物。
