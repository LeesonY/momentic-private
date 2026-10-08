# G3 真实模型 Gate 审查（2026-10-05）

真实模型 Gate 仍未通过。P0Passed 与 G3Passed 保持 false。Root 的本地 70/70 和格式反例 9/9 仍是限定本地验收；本轮没有重跑，也不把它写成 Gate。

旧样本 `docs/validation-results/G3-model-minimal.json` 保留。sha256 `1ed2904b1beda6d68494cd5db37be8d2758aa69a9e5605d0be066e25baa14469`。9 次调用都没有进入 BoundModel、租约或 PG 预算。`postgresUsed` 为 false。

本轮没有真实提供方、付费或外网模型调用，没有浏览器，没有 worker-entry，没有改 gateway / API / worker / core。ego 未使用。未启监控器。

## 九次样本的实际路径

| 样本 | HTTP | 产品 gateway | BoundModel | 租约/预算 | 规范判定 |
| --- | --- | --- | --- | --- | --- |
| probe-live | 200 | 否，原始 fetch | 否 | 否 | 否 |
| capabilityProbe | 400 | 是，capabilityProbe | 否 | 否 | 否，没有正文 |
| decision-gateway | 400 | 是，generateDecision | 否 | 否 | 否，校验器未到达 |
| decision-json-object | 200 | 否，adapter.send | 否 | 否 | 事后 validateContract 接受 |
| native-tool | 200 | 否，adapter.send | 否 | 否 | 事后 validateContract 拒绝 |
| image-via-gateway | 400 | 是，当时的 generateDecision | 否 | 否 | 否 |
| image-direct-biased | 200 | 否 | 否 | 否 | 否 |
| vision-red-pixel | 200 | 否，adapter.send | 否 | 否 | 否 |
| timeout-1ms | 无 | 是，generateDecision | 否 | 否 | 否 |

`visual-assess-local` 不是这 9 次之一。它零次网络，只证明 `imageInput false` 时视觉准则被挡成 blocked。

## 分别支持什么

- probe-live：端点在 `json_object` 下返回了 `{"ok":true}`，响应 model 为 deepseek-flash，usage 36/5/41。
- capabilityProbe 与 decision-gateway：2026-10-04 的产品网关发出 `json_schema` 后，端点 HTTP 400，网关记 malformed/VALIDATION_ERROR，providerCalls 1，repairCount 0。错误发生在正文解析之前，没有格式修复，也没有写成能力缺失。
- decision-json-object：调用方手写的 `json_object` 请求让模型输出了契约接受的 click，nodeId 为 tab-btn-details。这是 adapter.send 之后的 `validateContract('ToolCall')`，不是 gateway 内部判定。
- native-tool：端点能返回 tool_calls click，nodeId 正确；snapshotId/pageId 为 fixture/home 时契约拒绝。
- image-via-gateway：只证明当时的 `artifact://` 被端点拒绝，并被记成 VALIDATION_ERROR。不描述当前源码。
- image-direct-biased：请求被接受。提示词指定了 `{"seen":false}`，不能当视觉证据。
- vision-red-pixel：端点接受 1x1 纯红 PNG data URL，并回答「红色」。不能把 imageInput 写成 true，也不能外推到页面或视觉准则。
- timeout-1ms：本地 abort 被记成 MODEL_TIMEOUT。没有供应商 usage。不证明供应商超时，也没有测 429。
- 五次 HTTP 200 的供应商 usage 合计 prompt 894、completion 143、total 1037。4xx 和超时的网关估算没有加进 1037。

## 全部不支持

租约、冻结剖面、预算预约与结算、SecretVault、API complete、Worker 消费 assessment、Dispatcher、Playwright、中文页面、10×10、当前 `json_object` 选择下的 generateDecision、当前 data URL 视觉门、G3-F 对真实正文的格式校验。

## 当前实现和样本的差别

事实：当前 `toOpenAIChatRequest` 已按 `responseFormat` 分支。默认仍是 `json_schema` strict true。`json_object` 不附 tools。`native_tools` 发 tools、不发 response_format。`dist/openai.js` 与源码一致。样本里「适配器固定 json_schema」只描述 2026-10-04 的 gateway 调用。

事实：当前图片走 `resolveArtifact` → `imageDataUrl` / `legalImageUrl`。不发送 `artifact://`。视觉准则要求该 URL 真的出现在出站 body，否则在 `providerCalls += 1` 之前失败。PNG 结构校验在 `readApprovedImage`，不在 gateway。

事实：`generateDecision` 的 `json_object` 会追加 `jsonObjectConstraint`。九次样本里成功的 JSON 决策没有走这条路径。

推断：DeepSeek 仍会拒绝 `json_schema`。这是从旧样本推到当前端点，本轮没有新的真实调用证实。

## 最小追加验证

- 中文页：本轮只注入了中文指令文本。没有无浏览器的中文页面入口。最小真实验证需要一张已批准、画面含中文界面的截图，经 BoundModel.`readApprovedImage`。不在下面的 4 次预算里。
- JSON：注入已证明产品 `generateDecision` 会发 `json_object`、不附 tools、并用 schema 接受 `{"choice":"详情"}`。端点是否接受这条产品请求仍缺一次真实调用。
- 原生 ToolCall：注入已证明 gateway `native_tools`。合法 uuid 为 1 次 ok。带 format uuid 的非法值用掉现有一次修复，2 次后 malformed。`{type:object}` 的非法 ToolCall 是 1 次，由 `toolCallsMatchContract` 拒绝。注入 schema 不是 agents `DECISION_SCHEMA` 全文，也没有跑 `runToolLoop`。真实模型是否吐出 uuid 仍未知。
- 合法批准图片：注入证明调用方给出的 PNG 字节能变成 data URL，诊断会去掉 base64，视觉 assessment 可为 passed。这不调用 `readApprovedImage`，gateway 不解码 IHDR。产品缝在 `packages/orchestrator/src/model.ts` 的 BoundModel。不新增 gateway 方法，不改 API/worker/core。
- 脱敏 usage：注入的 reported usage 进入 CallRecord。stdout 没有假密钥和 PNG base64。未来证据只留状态、计数和已脱敏诊断。

未批准图片在发送前返回 `MODEL_NOT_CONFIGURED`，`authorization` 仍是 `failure()` 的默认 unset。`decryptKey` 当时已经被调用。这是现有行为，本轮不改。

## 未来真实调用的边界

这是方案，不是本轮授权。本脚本的 `--execute` 不会发送。

- 最多 4 次 HTTPS chat/completions，含产品已有的一次修复。
- 最多 2 个决策：一次 `generateDecision` + `json_object`，一次 `generateDecision` + `native_tools`。
- 每次 `maxOutputTokens` 64，输出 token 合计不超过 256。
- 图片 0 次，中文页面 0 次，浏览器否，Postgres 否，worker-entry 否，fallback 0，不执行工具。
- 遇到 401、403 或 429 即停。
- 剖面必须是 ready 或 degraded 的持久化格式。不得因模型自报打开 imageInput 或 nativeTools。不得再探一次 `json_schema`。
- 不估算金额。费用边界就是次数和输出 token 上限。
- 副作用限于只读补全：不写数据库，不改剖面。

即使这 4 次以后做了，仍不是 Gate。中文页面、批准图片的产品读取、BoundModel 预算和 10×10 都还没覆盖。

缺口：没有「不读取明文密钥、又带这些上限」的发送函数。`probe-live.mjs` 会在 `LOCALQA_MODEL_PROBE=allow` 时自动发送并打印 raw，本轮不改、不调用。BoundModel 能接租约和 `readApprovedImage`，但那要跨入 orchestrator/API 与密钥解密。

## 本轮入口与结果

- 入口：`docs/validation-results/G3-model-gate-preflight.mjs`
- sha256：`a711c26ee9730679d53dd47ce11b3dfd18ca4999713c083b694076fb8d3d8f77`
- 证据：`docs/validation-results/G3-model-gate-plan.json`
- sha256：`9008a9c65f4e8b0baeb4c91bd5243328ea034737bcf3d6a8921d7c281f799bcc`
- 默认与 `LOCALQA_MODEL_PROBE=allow`：退出码 0，`networkCallMade false`。脚本不读 `process.env`。
- `--execute`：退出码 2，拒绝，不发送。
- `--inject`：退出码 0。6 项本地注入通过，`globalFetchUsed false`。
- `--inject --execute`：退出码 2。
- 宿主 Node v26.3.0。不是 node:24 证明。

注入六项：json_object 1/0 ok，usage 5/3；合法原生工具 1/0 ok，usage 5/7；非法 uuid 2/1 malformed，usage 10/14；无 format 的契约拒绝 1/0 malformed；未批准图片 0 次发送；注入 PNG 字节 1 次，data URL，assessment passed，usage 11/4。最后一项不是视觉证据。

## 清理

未创建容器、卷、网络或镜像。`docker ps -a` 无输出。未跑 git。未删除旧样本。临时 stdout 已删。ego 未使用。

完整结构化证据见 `docs/validation-results/G3-model-gate-plan.json`。
