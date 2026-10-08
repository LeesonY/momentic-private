# G3F-R 交付说明：schema format 与实例数据分开

日期：2026-10-05。本轮只改 `packages/model-gateway/src/gateway.ts` 的 schema 遍历，以及 `packages/model-gateway/test/g3f-output-format.test.mjs`。没有改锁、依赖、contracts、worker、core、runtime、web。没有改 Root 的复现脚本。没有 git commit/reset。没有 Postgres、浏览器、worker-entry、外网模型、第二监控器。Ego 未使用。G3Passed 与 P0Passed 仍为 false。等待 Root 独立验收 schema/data 区分和调用预算。

本文件是 Herdr recent-unwrapped 只剩末页后的回退副本。不覆盖初版 G3-F 证据，也不覆盖 Root 的预修复审查。

## 结论

`const`、`default`、`examples`、`enum` 里的实例 `{format:'business-label', kind:'invoice'}` 不再被当成 schema format。这四例返回 `requestResult=ok`、`errorCode=null`、`data` 等于该对象、发送 1 次。

嵌套在真正 schema 关键字上的未知 format 仍在发送前拒绝：`malformed` / `VALIDATION_ERROR`，`data=null`，发送 0 次。非法 UUID 仍走原来的一次修复：发送 2 次后仍是 `malformed` / `VALIDATION_ERROR`。`ajv-formats` 3.0.1 full 和 `toolCallsMatchContract` 都保留。draft 行为没有放宽，也没有扩到 draft 2020 专有关键字。

## 缺陷

G3-F 的 `unsupportedFormat` 遍历每一个对象。Root 的 `docs/validation-results/G3F-schema-data-independent-repro.mjs` 六例当时 2 通过 / 4 失败。失败的四例是合法 `const` / `default` / `examples` / `enum` 对象中的 `{format:'business-label', kind:'invoice'}`。这不是 schema format。遍历把它报成未知 format，编译前返回 `VALIDATION_ERROR`，provider 0。通过的两例是：嵌套 `properties.value.format='business-label'` 发送前拒绝，以及非法 UUID 修复一次后仍拒绝。

## 确切改动

只动这两个产品/测试文件，然后按测试需要重发 dist。

1. `packages/model-gateway/src/gateway.ts`
   - SHA-256 `ff3d6508aa106294c3b1261cf8dec36cf44f11ebbc16aa159ea3bf87d74aa982`。
   - `unsupportedFormat` 不再 `Object.values` 递归所有子对象。
   - 只在当前 schema 节点上读取字符串 `format`。不在 `ajv.formats` 里则返回该名字，编译前抛错，provider 0。
   - 继续进入的 schema 位置：
     - 列表：`allOf`、`anyOf`、`oneOf`
     - `items`：单个 schema，或 draft-07 tuple 数组里的每个 schema
     - 子 schema：`additionalProperties`、`additionalItems`、`contains`、`propertyNames`、`not`、`if`、`then`、`else`
     - schema 映射：`$defs`、`definitions`、`properties`、`patternProperties`
     - `dependencies` 里值为对象、且不是数组的项。字符串数组（属性名依赖）不进入。
   - 不进入：`const`、`default`、`examples`、`enum`，以及其他实例/注解字段。
   - 不进入 draft 2020 专有位置：`prefixItems`、`unevaluatedProperties`、`dependentSchemas` 等。Ajv 仍是 8.20.0 默认 draft-07，`strict: false`。这些关键字依然不解释。
   - `formatsPlugin.default(ajv, { mode: 'full' })` 未删。
   - `toolCallsMatchContract` → `validateContract('ToolCall')` 未删，仍在 `parseWithSchema` 成功之后。
   - 没有设置 `logger: false`。没有自写 UUID/URI 正则。没有改 package.json 或 pnpm-lock。

2. `packages/model-gateway/test/g3f-output-format.test.mjs`
   - SHA-256 `48cc8e7a8197067f3e9630a9e9bfc5009c8a98b66fdd3be7957ddd41140033da`。
   - 新增两项，原有六项保留。
   - 实例数据：`const`、`default`、`examples`、`enum` 的 `{format:'business-label', kind:'invoice'}` 均为 `ok`、1 次发送、`repairCount=0`。另有一条 schema 同时含合法 `format:uuid` 和 `const` 里的 `label.format='business-label'`，输出等于该 const，`ok`、1 次发送。
   - 嵌套未知 format `business-label` 零发送，覆盖 `properties`、`items`、tuple `items`、`additionalItems`、`contains`、`$defs`、`definitions`、`patternProperties`、`allOf`、`anyOf`、`oneOf`、`not`、`if`/`then`、`dependencies` 的 schema 对象。`dependencies` 里另有字符串数组 `['a']`，不误当 schema。

3. dist
   - 命令：`npx --yes pnpm@10.34.0 --filter @localqa/model-gateway exec tsc -p tsconfig.build.json --pretty false`，exit 0。
   - `packages/model-gateway/dist/gateway.js` SHA-256 `a1a800069c6a704e4e3a39c449cf7d8d78e3b66acfc212f2a55da5f7700bf437`。
   - 测试和 Root 脚本 import 的都是这份 dist。

4. 证据（新建）
   - `docs/validation-results/G3F-R-schema-data.json`
   - SHA-256 `bfda14b07bf2e03115f2a2a97cee5286b409f340ec42f4f741958d19fe1a52c8`。
   - 未改 `docs/validation-results/G3F-output-format.json`。
   - 未改 `docs/validation-results/G3F-schema-data-independent-repro.mjs`。
   - 工作区里没有改到名为 `G3F-schema-data-pre-fix-independent-review.json` 的文件。

## 执行过的测试

本地套件：

```text
node --test --test-concurrency=1 packages/model-gateway/test/g3f-output-format.test.mjs packages/model-gateway/test/g3d4-assert-complete.test.mjs packages/model-gateway/test/g3e-image-assert.test.mjs
```

18/18，fail 0，duration_ms 435.901209。g3f 8、g3d4 4、g3e 6。Host Node。没有启动 `node:24-bookworm-slim`。没有跑 `scripts/verify.mjs`（会重写 `T04-model.json`）。

g3f 仍保留的原行为：

- uuid / uri 的 `not-valid`：`malformed`，`providerCalls` 2，`repairCount` 1，用量两次合计 `inputTokens` 8、`outputTokens` 4、`requests` 2、`usageSource=reported`。合法 uuid 与 `https://example.com/a`：`ok`，1 次。
- date-time 正例 `2026-10-05T00:00:00Z` 为 `ok`。负例 `not-valid` 为 `malformed`、2 次。uri-reference 正例 `/docs/readme` 为 `ok`。负例 `http://exa mple.com/a` 为 `malformed`、2 次。
- 一次修复成功：第一次 `not-valid`，第二次合法 uuid。`repaired`，`providerCalls` 2，`repairCount` 1，没有第三次。
- `format:'not-a-format'` 和 `required` 不是数组的非法 schema：发送 0，`repairCount` 0。
- `json_schema` 请求体仍是 `response_format.type=json_schema` 且 `json_schema.strict=true`，并带 tools。`native_tools` 仍有 tools、没有 `response_format`。两种模式非法 uuid 都是 2 次后 `malformed`，合法 uuid 都是 1 次 `ok`。
- `outputSchema` 仅为 `{type:'object'}` 时，非法 ToolCall UUID 仍由 `toolCallsMatchContract` 拒绝：`malformed` / `VALIDATION_ERROR`，`providerCalls` 1，`repairCount` 0。放进 `DECISION_SCHEMA` 时 format 先失败，修复一次后仍 `malformed`，发送 2 次。合法 uuid click 对 `DECISION_SCHEMA` 为 `ok`、1 次。

Root 脚本，未改内容，对修复后的 dist 重跑：

```text
node docs/validation-results/G3F-schema-data-independent-repro.mjs
```

exit 0。stdout：

```json
{
  "results": [
    {
      "case": "const object field format is data",
      "requestResult": "ok",
      "errorCode": null,
      "sends": 1,
      "passed": true
    },
    {
      "case": "default object field format is data",
      "requestResult": "ok",
      "errorCode": null,
      "sends": 1,
      "passed": true
    },
    {
      "case": "examples object field format is data",
      "requestResult": "ok",
      "errorCode": null,
      "sends": 1,
      "passed": true
    },
    {
      "case": "enum object field format is data",
      "requestResult": "ok",
      "errorCode": null,
      "sends": 1,
      "passed": true
    },
    {
      "case": "unknown nested schema format rejects before send",
      "requestResult": "malformed",
      "errorCode": "VALIDATION_ERROR",
      "sends": 0,
      "passed": true
    },
    {
      "case": "invalid UUID still rejects after one repair",
      "requestResult": "malformed",
      "errorCode": "VALIDATION_ERROR",
      "sends": 2,
      "passed": true
    }
  ],
  "scope": "Local injected transport; no PG/browser/external model",
  "P0Passed": false
}
```

调用预算：实例数据 1 次且不再误拒绝；未知 schema format 0 次；非法 UUID 仍是原修复预算 2 次，没有第三次。

## 限制与未验证

- 没有 BoundModel、租约、冻结 profile、账本或 Postgres。
- 没有浏览器、Playwright、worker-entry、付费或外网模型。Root 脚本和 g3f 都是注入的本地 `Response`。
- 没有在 `node:24-bookworm-slim` 里重跑，也没有跑 `verify.mjs`。
- `purpose==='probe'` 仍不编译 outputSchema。
- draft 2020 专有关键字仍不会仅因这次遍历变成发送前错误。Ajv draft-07 对它们的忽略方式与 G3-F 初版相同。
- 已注册 format 的非法值仍会先发送，再按原有一次修复重试。未知 format 名称在真正 schema 节点上才是发送前失败。
- 上述 18/18 和 Root 6/6 不是 G3 放行，也不是 P0 放行。

## 清理

Ego 未使用。未启动第二监控器。未启动容器，未删除他人容器或 volume。本轮结束时 `docker ps -a` 无输出行。没有新建 `/tmp` 测试脚本。本文件只是回退副本。
