# T10-AUTH-2 只读代理审查

日期 2026-10-06。本文件是 AUTH-2 最终只读报告，供独立核对。P0Passed false，G3Passed false。未改产品、依赖或旧证据。未付费、未调真实 provider、未开浏览器、未跑 worker-entry。未调用会扫描全部 migrations 的 PG 测试（010 由 pi 在写）。ego 未使用。

上一份 `T10-AUTH-2-readonly-audit.md` 保留，不覆盖。不要再把 Root 第一阶段 **35** 写成当前全部绿灯。用户最新口径：none 未使用 secret 已修成 `material{}` 且 `vault.decrypt` 0 次；**backend 41/41 + storage 32/32**。本轮没有复跑这两套。

## 结论

none 匿名策略与 proof 绑定按 Root 最新 41/32 视为已验收。AUTH-2 仍缺的是同一组**未实现执行桥**，不是新的一类越权：

1. form / storage_state 执行适配器（含 Worker 未调用 resolve、未注入 `approvedAuthState`，以及 origins `goto`+空 catch）。
2. exclusive_run 的 run 级锁（契约有枚举、创建有默认值，运行时不读）。
3. 保护凭据引用 / 认证动作来源（回归只有 DSL `type_text`，grant 把原文写入 `action_intents.tool_call`）。

本轮**没有**独立于这三项的新反例。先前 PG 证据只用来说明这三项，本轮因 010 未完成而没有重跑。

共享新模块契约已构建：**domain 135 defs、公开操作 77**（另有 Internal 8）。其中模块相关 defs 是 `RegressionModule*` 审查类型，**没有** `AuthStepSource`、`fill_credential`、锁表 DTO。模块契约不关闭 AUTH-2。

## 本轮范围

只读当前源码与已生成契约。不执行 `migrate()`，不跑会遍历 `packages/storage/migrations/` 的测试，不启动 API dist 对未完成 010 的 PG。磁盘上已有 `010_regression_module_reviews.sql`（模块审查列/触发器），migrations 001–010 均无认证独占表。

## 用户口径与源码核对（事实）

| 项 | 口径 | 本轮源码 |
| --- | --- | --- |
| none 未使用 secret | Root：`material{}`，decrypt 0 | `leases.resolveAuth`：`mode !== 'none' && secret_id` 才 decrypt，否则 `material={}` |
| 绿灯 | backend 41/41，storage 32/32 | 未复跑 |
| 35 | 不再当作最终全部 | 仅历史阶段 |

相关 SHA-256（本轮读取）：

- `packages/orchestrator/src/core.ts` `5db533fed506f0f0f39043b3cf6bf490ebca3b8b9ada51200151f96a61b5b88e`
- `packages/orchestrator/src/runtime.ts` `3e7d2c2d9af7dde65643c079db6b82972b596bac778573b1a59c428f39184d83`
- `packages/storage/src/leases.ts` `21f6b4f2afb9e608ef3875599d83806988086419b026991d45331bb9bb630b94`
- `packages/storage/src/repositories.ts` `a515879e7b2b49396ff67bc9f41bb5340a04b2d0c53cc81df85c9ee5747ad714`
- `apps/api/src/routes/internal.ts` `3950bed4e7c0195170ad994129ab878827b73cab94a6ec3929ea64d9d42aa4b8`
- `apps/api/src/runAuth.ts` `9667d6ff670dc3b81e7dcef32e4f6dd2b55382bcd7b03ca6db9d8a0252c994c0`
- `apps/api/src/routes/runs.ts` `7b638300b9b5b70683e13ea43d369e7634d22b17af41d43ca8f68c7af298b846`
- `apps/worker/src/index.ts` `72b724d3729f56d1187529085691e3d33efe1df7aec966ddf0d1a1c5fae2bcf3`
- `packages/browser/src/session.ts` `1a5e67b4588f3f41927abb056aaf94466e14af62a7021444ea0dc4c132d23162`
- `packages/contracts/src/generated/manifest.json` `f478aad20694110a2f0e8da7ae931860c76d428a77f479a74119e458350c3cc6`（135 个定义名）

core / runtime / internal / runAuth 与此前 Root AUTH 阶段记录一致。

## 各阶段（当前实现）

### authProfile

冻结元数据。无绑定且 `effectiveConfig.authProfileVersion===null` 返回 null。否则未撤销、文档可解析、id/project/version 一致、active、环境匹配；run origins 必须是剖面 origins 子集。不能从这里取 secret。

### requireAnonymousOrInput

`mode !== 'none'` 才 `waitForInput(kind=auth_profile)` 并返回 false。`none` 或 `profile===null` 返回 true。none 不需要材料。

### /internal/v1/auth/resolve

内部入口。id/version 必须等于冻结值。Worker-Id / Fencing-Token / Context-Version 来自调用方 header。随后 `currentLease`。none 走上面的空 material。

### Worker

`createSession` 不传 `approvedAuthState`，源码中无 `auth/resolve` 调用。

### Run.phase `auth`

契约有 `auth` 阶段。smoke 在 preflight 成功后 `change(...,'auth')` 紧接着 `change(...,'explore')` 并入队 explorer，没有认证 job。这是执行桥未接的表现，不是新的越权路径。

### InputResponse（源码事实，本轮无 PG）

`POST /runs/{runId}/inputs/{inputId}/respond`：除 clarification+provide 走 `resolveClarification` 外，`auth_profile` 只把 InputRequest 标为 resolved/rejected 并写 `input.resolved`。`oneTimeCode` / `text` / `authProfileId` 被 parse 后丢弃，不写入 InputRequest，不改冻结剖面，不把 waiting job 重新入队。

与已知 form 缺口的区别：Root 已覆盖「未接线时等待、不匿名放行」。这里是等待之后的公开 respond **没有闭环**。它**没有**把验证码写进库，也**没有**用 respond 换绑剖面。不单列为新的明文落库反例。实现适配器时应换掉这条占位，而不是把 `approve` 做成无限授权（契约 README 已禁止）。

## 已知三项缺口（不是新类）

### form / storage_state 未实现

`runAuth.ts`：回归且 mode≠none → 422「Regression auth profile execution is not connected yet」。smoke form/storage_state：`requireAnonymousOrInput` 等待。`validateAuth` 创建时检查 storage origin/cookie domain；secretInput 字段上限 1e6，没有独立容量常量。运行时 `session.ts` 对 `approvedAuthState.origins` 做 `goto` + `.catch(() => {})`，该段不读 `allowedOrigins`。Worker 当前不传入该字段，所以这条注入**现在不会被 Worker.once 走到**。接桥时必须先改掉空 catch，否则会变成真实 fail-open。

### exclusive_run 未实现

`sharingPolicy` 默认 `exclusive_run`，只存在 AuthProfile 文档。leases / core / worker 不读。migrations 001–010 无锁表。先前独立 PG（`T10-AUTH-2-counterexamples-7fd173dd.json`）两次 `start` 都成功、lock 表 0。那是**本缺口的复现**，不是第四类问题。本轮不重跑。

### 认证动作来源 / 明文

`grantAction` 只对 navigate 做 `displayUrl`。`type_text` 全文进 `action_intents.tool_call`。Step 文档无该字段。smoke `validateBrowserTool` 不允许 type_text。回归必须有 `RegressionStepSource` 且文本等于 DSL。契约：`fill_secret` 不是模型工具。FormConfig 只有定位和成功条件。

先前 PG：哨兵出现在 `action_intents` 与 FakeBrowser `page_snapshots.node.text`；`GET /steps` 无；`event-history`/`report` 有哨兵（当时未按 event.type 拆开，推断含冻结 DSL）。这是「没有凭据引用、只能用 DSL type_text」的持久化面，不是独立于 form 缺口的新 bug。

## 与「真正新反例」的判定

若出现以下情况才算新反例：none 仍解密并返回 secret；错误 proof 仍 200 带回材料；respond 把 `oneTimeCode` 写入 DTO/SSE；Worker 在 form 等待失败后仍匿名 `createSession`。本轮源码与 Root 41/32 口径都**不支持**把这些写成已发生。

模块 `arguments` 仍是文档内 JsonValue：可能把秘密写进模块 type_text。那是 T10 模块/DSL 文本问题，AUTH-2 不扩成 T11/T12，也不在本轮当新认证 bug。

## 契约 135 / 77 对 AUTH-2 的含义

已生成、本轮只计不生成：domain `$defs` 135，OpenAPI 公开 77。模块 defs：`RegressionModuleVersion/Create/Record/RecordPage/ReviewPreviewInput/ReviewPreview/Commit` 等。认证相关仍是 `AuthProfile*`、`AuthResolve`、`CredentialMaterial`、`FormConfig`。没有锁、没有 `fill_credential`、没有 `AuthStepSource`。Root 若补执行桥，需要新增这些共享类型后再写 010 之后的存储，而不是复用模块审查 010。

## 最小实现（仍交 Root，本轮不改代码）

与上一份方案相同，收束为：

1. 保护引用：Worker 专用 fill/import，grant 只存 slot/target，材料只在进程内，none 继续不 decrypt。
2. `AuthStepSource` 绑冻结 FormConfig；落地前回归 form/storage_state 保持 422。
3. exclusive_run 锁表，held 唯一，终态/cancel/过期释放，并入现有 tick；shared_state 不加锁。
4. 注入：校验 origin/容量；禁止空 catch；失败受阻。
5. 换掉 auth_profile 的 status-only respond；OTP 一次消费，不进 message/SSE/export。

必测仍针对这三项，并保持 41/32 不回退。不要在 010 未完成时用全量 migrate 的套件去扫。

## 先前 PG 证据（不重跑）

`docs/validation-results/T10-AUTH-2-counterexamples-7fd173dd.json` sha256 `03734d4ded0d7783d4c0dc8fd3cdade5445ed20966d7fe60910f3b69ee68b413`。脚本 `T10-AUTH-2-counterexamples.mjs` 会 `migrate()` 全部 SQL，**010 完成前不要跑**。

## 未验证

真实 Playwright 注入、SSE 长连接、报告字段级拆分、otp 槽位、两 Worker 抢锁时序、010 本身、本轮 backend 41 与 storage 32 的逐项清单（只采用用户陈述）。

## 清理

本轮未创建容器、卷、网络。未删旧证据。未跑 git。ego 空间清理状态：未使用。
