# G3-F 交付说明：输出 format 严格校验

日期：2026-10-05。本轮只改 model-gateway 及其 package/lock，外加一份新证据。没有改 worker、core、runtime、contracts 导出、web。没有 git commit/reset。没有 Postgres、浏览器、worker-entry、外网模型、第二监控器。Ego 未使用。G3Passed 与 P0Passed 仍为 false。等待 Root 独立验收。本文件不覆盖旧审查或旧证据。

## 结论

自定义 `outputSchema` 上的 `uuid`/`uri`/`date-time`/`uri-reference` 现在由 ajv-formats 3.0.1 full 实际校验。Root 复现的 `{value:'not-valid'}` 不再返回 `requestResult=ok`。结果是 `malformed` / `VALIDATION_ERROR`，`data` 为 `null`。`toolCallsMatchContract` 仍在，没有关 logger，没有自写 UUID/URI 正则。

不需要 contracts 新导出。缺口不在导出：contracts 已经用同一锁定版本做 ToolCall 校验；漏的是网关自己那只没有 formats 的 Ajv，它编译调用方传入的任意 `outputSchema`。model-gateway 直接依赖 `ajv-formats@3.0.1`。

## 确切改动

1. `packages/model-gateway/package.json`
   - dependencies 增加 `"ajv-formats": "3.0.1"`，与 `packages/contracts` 已锁定版本相同。
   - SHA-256 `ebeff712a79393882494470d5b857f14ec1a5d50f5a3104d07c481eeae6ecfbd`。

2. `pnpm-lock.yaml`
   - 只在 `packages/model-gateway` importer 增加：
     - specifier `3.0.1`
     - version `3.0.1(ajv@8.20.0)`
   - 解析块原来就有，没有升级其他包。安装命令：`npx --yes pnpm@10.34.0 install --offline --frozen-lockfile --filter @localqa/model-gateway...`。离线解析新依赖曾因 metadata 镜像失败，所以先把 lock 写成与 contracts 相同的已锁定边，再 frozen 安装。安装输出：Lockfile is up to date，Done in 215ms。`packages/model-gateway/node_modules/ajv-formats/package.json` 的 version 是 `3.0.1`。

3. `packages/model-gateway/src/gateway.ts`
   - SHA-256 `2acbb89318d1c62ff25960c3e637dab0572c2160fb91f08002878609dadc600a`。
   - `import formatsPlugin from 'ajv-formats'`。
   - 编译器仍是 `new Ajv({ allErrors: true, strict: false, validateFormats: true, coerceTypes: false, useDefaults: false, removeAdditional: false })`。
   - `formatsPlugin.default(ajv, { mode: 'full' })`。与 contracts 的调用方式相同。
   - 新增 `unsupportedFormat`：遍历 schema，凡 `format` 字符串不在 `ajv.formats` 已注册集合里，编译前抛错。
   - `input.purpose !== 'probe'` 时，先做这个检查，再 `ajv.compile(input.outputSchema)`。抛错走原有 `failure(...)`，`providerCalls` 默认 0，`repairCount` 0。
   - `toolCallsMatchContract` → `validateContract('ToolCall')` 的调用没有删，仍在 `parseWithSchema` 成功之后、`finish('ok'|'repaired')` 之前。
   - 没有设置 `logger: false`。
   - 发出的 dist：`packages/model-gateway/dist/gateway.js` SHA-256 `a87f24dfbc99d0b2ea3b6c1b06553fb97c1f64b4ad40cb2d16ad5b83dda281b4`。命令是 `npx --yes pnpm@10.34.0 --filter @localqa/model-gateway exec tsc -p tsconfig.build.json --pretty false`，exit 0。测试 import 的是这份 dist。

4. `packages/model-gateway/test/g3f-output-format.test.mjs`（新建）
   - SHA-256 `926cf6464e16edb3de6f51aeff98ccbad273b2d5901864724bc9c7aea63b6568`。
   - 使用 `createGateway` + `createOpenAIAdapter(注入 Response)`。endpoint `https://model.g3f.test/v1`。没有外网。

5. 证据（新建，不覆盖旧文件）
   - `docs/validation-results/G3F-output-format.json`
   - SHA-256 `4fa3d2367ac49e574ef648bfe40878a4525706e3aa3eb1269206150435439ac8`。

没有改：`apps/worker`、`packages/orchestrator/src/core.ts`、`packages/orchestrator/src/runtime.ts`、contracts 源码与导出、`scripts/verify.mjs`、T04/G3D/G3E/B5 证据、`docs/validation-results/T10-B5-agent-readonly-review.md`。

## Draft 边界

输出 schema 仍由 Ajv 8.20.0 默认 draft-07 编译，没有改成 Ajv2020。现有 outputSchema 以及 `DECISION_SCHEMA` 的 `$ref`、`$defs`、`oneOf`、`const`、`format` 都由这只编译器处理。draft 2020 专有关键字（`prefixItems`、`unevaluatedProperties`、`dependentRequired`）这里不解释。`strict` 仍是 false，未知关键字不会因此变成发送前错误。

format 名称若不在 ajv-formats 3.0.1 full 已注册集合中，编译前失败，provider 为 0。已注册的 format 由该库执行。规范 ToolCall 检查仍是 contracts 的 Ajv2020 + ajv-formats full。两只 Ajv 都在，互不替代。

`purpose==='probe'` 的路径仍不编译 outputSchema。本轮没有改探测。

## 执行过的测试

命令：

```text
node --test --test-concurrency=1 packages/model-gateway/test/g3f-output-format.test.mjs packages/model-gateway/test/g3d4-assert-complete.test.mjs packages/model-gateway/test/g3e-image-assert.test.mjs
```

结果：16/16，fail 0，duration_ms 446.338917。其中 g3f 6、g3d4 4、g3e 6。Host Node 执行。没有启动 `node:24-bookworm-slim`。

没有跑 `packages/model-gateway/scripts/verify.mjs`。该脚本会重写 `docs/validation-results/T04-model.json`。

g3f 六项与实测行为：

1. uuid 与 uri。`outputSchema` 为 `{type:object, additionalProperties:false, required:[value], properties.value.format}`。输出 `{value:'not-valid'}`：两次都是 `requestResult=malformed`，`errorCode=VALIDATION_ERROR`，`data=null`，`providerCalls=2`，`repairCount=1`，`requests=2`，`inputTokens=8`，`outputTokens=4`，`usageSource=reported`。请求体 `response_format.type=json_schema` 且 `json_schema.strict=true`。正例 uuid `11111111-1111-4111-8111-111111111111` 与 uri `https://example.com/a`：`ok`，`errorCode=null`，`data` 为原对象，`providerCalls=1`，`repairCount=0`，`requests=1`。这两项期间 `console.warn` 没有 `unknown format`。

2. date-time 正例 `2026-10-05T00:00:00Z` 为 `ok`、1 次发送。负例 `not-valid` 为 `malformed`、2 次发送。uri-reference 正例 `/docs/readme` 为 `ok`、1 次。负例 `http://exa mple.com/a` 为 `malformed`、2 次。

3. 一次修复成功：第一次 `not-valid`，第二次合法 uuid。`requestResult=repaired`，`errorCode=null`，`data={value:uuid}`，`repairCount=1`，`providerCalls=2`，`requests=2`，`inputTokens=8`，`outputTokens=4`，`usageSource=reported`。每次注入 usage 是 prompt_tokens 4、completion_tokens 2。没有第三次发送，没有新的修复预算。

4. `format:'not-a-format'`，以及 `required` 不是数组的非法 schema：fetch 0 次，`providerCalls=0`，`repairCount=0`，`requests=0`，`malformed` / `VALIDATION_ERROR`，`data=null`。

5. `json_schema` 与 `native_tools`。同一 uuid schema，toolSchemas 为 observe。非法值两种模式都是 `malformed` 且 2 次发送。合法值都是 `ok` 且 1 次。`json_schema` 请求体有 `response_format.type=json_schema`、`strict true`，并且有 tools。`native_tools` 请求体有 tools，没有 `response_format`。

6. 规范 ToolCall：
   - `outputSchema` 仅为 `{type:'object'}`，没有 format。click 的 snapshotId/pageId 为 `not-valid`。`toolCallsMatchContract` 拒绝。`malformed` / `VALIDATION_ERROR`，`data=null`，`providerCalls=1`，`repairCount=0`。
   - 同一非法 click 放入 `DECISION_SCHEMA`：format 先失败，修复一次后仍非法。`malformed` / `VALIDATION_ERROR`，`providerCalls=2`，`repairCount=1`。
   - 合法 uuid click 对 `DECISION_SCHEMA`：`ok`，`providerCalls=1`。

与 Root 修复前观察的差别：以前 format 被忽略，非法 ToolCall UUID 在 schema 通过后由 `toolCallsMatchContract` 拒绝，所以是 1 次发送。现在 `DECISION_SCHEMA` 自带 format uuid，schema 失败会走原来的一次修复，仍非法则为 2 次发送。结果码仍是 `malformed` / `VALIDATION_ERROR`，没有变成 `ok`。不含 format 的 `{type:object}` 路径保持 1 次发送。

g3d4 与 g3e 的 10 项在同一命令里通过，覆盖空证据、未知证据、拥有证据、无图片能力、未批准图片、规范化判定、非 stub 探测、合法 PNG data URL、只提 artifact id 的视觉文本、只留 artifact id 的视觉请求。

## 限制与未验证

- 没有 BoundModel、租约、冻结 profile、账本或 Postgres。
- 没有浏览器、Playwright、worker-entry、付费或外网模型。注入的是本地 `Response`。
- 没有跑 `verify.mjs` 全套，也没有在 `node:24-bookworm-slim` 里重跑这 16 项。
- probe 仍不编译 outputSchema。
- draft 2020 专有关键字仍不会仅因本轮在发送前失败。
- 未知 format 名称是发送前失败；已注册 format 的非法值会先发送，再按原预算修复一次。
- 本轮验收数字只包括上述 16/16。不是 G3 放行，不是 P0 放行。

## 清理

Ego 未使用。未启动第二监控器。未启动容器，未删除他人容器或 volume。本轮结束时 `docker ps -a` 无输出行。volume 仍是 `79e6b62585a476cb1d73128a4304fe0556d3526fda92d40302434fde82407472`。镜像仍包括 `localqa-web:latest`、`localqa-api:latest`、`localqa-worker:latest`、`localqa-orchestrator:latest`、`node:24-bookworm-slim`、`postgres:16-alpine`、`postgres:18-alpine`、`mcr.microsoft.com/playwright:v1.63.0-noble`、`hello-world:latest`、`nginx:1.27-alpine`。没有临时测试脚本留在 `/tmp`。本文件是 Herdr recent-unwrapped 读不回全文后的回退副本。
