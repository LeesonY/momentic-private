# T10-AUTH-2 只读审计与执行桥方案

日期 2026-10-06。P0Passed false，G3Passed false。未改产品、依赖或旧证据。未提交。未跑已绿 35/51/70。未启动真实浏览器、worker-entry、外部模型。ego 未使用。

Root 第一阶段独立 35/35（API 8、Runtime/proof 10、Worker.once/FakeBrowser 17）按用户陈述仍然有效。本轮核对产品 SHA 与那次记录：`core.ts` `5db533fe…`、`runtime.ts` `3e7d2c2d…`、`internal.ts` `3950bed4…`、`runAuth.ts` `9667d6ff…`、`t10-auth-binding.test.mjs` `44b054bf…`、`t10-b5-fakebrowser.test.mjs` `0ed93816…` 一致。`t10-auth-runtime.test.mjs` 当前为 `a73c3655…`，与 Root 记录 `f1c0e649…` 不同；本轮不重跑那 10 项。

旧缺口审计 `T10-AUTH-gap-audit.md` 保留。本文件只覆盖 AUTH-2：撤销/作用域、none 是否需要材料、明文落入持久化面、form 无合法回归来源、storage origins 隐式 goto、exclusive_run。

## 结论

none 冻结执行和 proof 绑定已经由 Root 35/35 覆盖。form/storage_state 执行桥、凭据引用和 run 级独占锁仍未接上。本轮用唯一 PG + FakeBrowser 复现了两件可观测事实，不是从源码推断单独报 bug：

1. `sharingPolicy=exclusive_run` 的 none 剖面可以连续 `start` 两个 smoke run，库中没有认证独占表。
2. 回归 `type_text` 的原文进入 `action_intents.tool_call`。FakeBrowser 把同一原文写进 `page_snapshots` 的 `node.text`。`steps` 文档和 `GET /steps` 没有该字段。`GET event-history` 与 `GET report` 含哨兵；未按 event.type 拆开，不能单独断言是 SSE 把密码当 Step 发出。

Worker.once 创建浏览器会话时不传 `approvedAuthState`，也不调用 `/internal/v1/auth/resolve`。

## 各阶段事实

### Coordinator.authProfile

`packages/orchestrator/src/core.ts`。按当前 lease 读 run 冻结的 `auth_profile_id/version`，LEFT JOIN 剖面与版本文档。无绑定且 `effectiveConfig.authProfileVersion===null` 时返回 null。否则要求未撤销、文档可解析为 AuthProfile、id/project/version 一致、status active、环境匹配；run 的 allowedOrigins 必须是剖面 allowedOrigins 的子集，否则 `TARGET_NOT_ALLOWED`。注释写明这里只给冻结元数据，不能选剖面、不能取 secret。

撤销：`revoked !== false` 即 `AUTH_FAILED`。head 改名或改 sharingPolicy 不影响已冻结 version。Root 已测。

### RuntimeClient.requireAnonymousOrInput

读 `authProfile(proof)`。`profile && mode !== 'none'` 时 `waitForInput(auth_profile)` 并返回 false，run 进入 awaiting_input。`mode==='none'` 或 `profile===null` 都返回 true，不建 input_requests。

none 不需要 CredentialMaterial。`leases.resolveAuth` 对 `mode==='none'` 跳过 `vault.decrypt`，返回 `material:{}`。Worker 当前也不调用 resolve。无绑定 smoke 与显式 none 都会继续匿名执行；这与「mode none 是明确批准的匿名策略」一致，不是新的越权路径。

form/storage_state 在执行桥接上之前会停在 awaiting_input。Root 已测 unconnected storage-state。回归绑定 form/storage_state 仍是 `runAuth.ts` 的 422。

### POST /internal/v1/auth/resolve

`checkInternal` + `rejectUserCookieForInternal`。`AuthResolve` 的 id/version 必须等于 `authProfile` 冻结值，否则 NOT_FOUND。`X-Worker-Id`、`X-Fencing-Token`、`X-Context-Version` 来自调用方，禁止用数据库当前值续权。`extractScopeAndProof` 仍用 admin 查 job 行，但 auth/resolve 把 header 交给后续 `currentLease`（worker、fencing、token_hash、lease_until、running、context）。错误响应体在 Root 测试里不含合成 secret。本轮不重跑。

### LeaseRepository.resolveAuth

JOIN 当前 run 冻结的 profile version，要求 `NOT p.revoked`。secret 再要求 `NOT s.revoked`。材料 `expiresAt` 用 lease_until。none 即使历史挂过 secret 也不解密。

没有 sharingPolicy 分支，没有 run 级锁。

### Browser approvedAuthState

`BrowserSessionOptions.approvedAuthState` 已存在。注入逻辑：cookies 走 `addCookies`；origins 对每个 origin `newPage` + `goto(origin)` + `localStorage.setItem` + `page.close`，`goto` 失败 `.catch(() => {})`。该段不读 `allowedOrigins`。PolicyInterceptor 在注入之后才挂到正式 page，临时 page 的 goto 不经 grant/record。

Worker `createSession` 只传 session/task/project/run/allowedOrigins/mode/artifactsDir 等，没有 approvedAuthState。本轮 FakeBrowser 观察到 `hasApprovedAuthState=false`。

创建时 `validateAuth` 会检查 storage_state 的 origin 与 cookie domain 是否落在 allowedOrigins。没有单独的容量上限，只有 secretInput 字段的 1e6 字符契约。运行时注入不再复查 origin。

## 明文面

`grantAction` 只对 `navigate` 做 `displayUrl`。`type_text` 的完整 ToolCall（含 `args.text`）写入 `action_intents.tool_call`。Step 的 summary/targetDescription 不含文本。`validateBrowserTool` 在 smoke 里只允许 observe/navigate/capture，所以 smoke 打不了 type_text；回归 executor/reproducer 的 click/type_text 绕过它，但必须有合法 `RegressionStepSource`，且文本与 DSL 步骤一致。

契约 README：API key、验证码、Cookie、原始认证状态不出现在正常 DTO/SSE/报告。`fill_secret` 不是模型工具。FormConfig 只有定位和成功条件，密码在 SecretVault。没有 `credentialRef` 动作。

因此：表单登录没有合法回归 source。若把密码写成 DSL `type_text`，grant 会把原文写入 action_intents；报告/用例文档也会带上 DSL 文本。

## 复现（唯一 PG + FakeBrowser）

脚本 `docs/validation-results/T10-AUTH-2-counterexamples.mjs`（当前 sha256 `daaf2d9dde250d050f9aed746ccf761b17e4ac06e6886025ef4227159cdac806`，含 inspect 文案修正，未重跑 PG）。证据 `docs/validation-results/T10-AUTH-2-counterexamples-7fd173dd.json`，sha256 `03734d4ded0d7783d4c0dc8fd3cdade5445ed20966d7fe60910f3b69ee68b413`。容器 `localqa-auth2-7fd173dd`，PG 映射 33079，未用 5432。postgres:18-alpine。零 Playwright、零 provider。

| 项 | 结果 |
| --- | --- |
| exclusive_run 两次 start | 两个 run 都成功，lock 表 0 |
| action_intents.tool_call | 含哨兵 |
| page_snapshots（FakeBrowser node.text） | 含哨兵 |
| steps 文档 / GET /steps | 不含 |
| GET event-history / GET report | 含哨兵；未拆 event.type |
| model_requests | 0 |
| Worker approvedAuthState | 未传 |
| session.ts goto/catch | 源码仍在，注入段不检查 allowedOrigins |

清理：`docker rm --force --volumes` 退出 0，卷已不存在，临时目录已删。脚本当时用 `/no such container/` 判断 inspect，Docker 实际返回 `no such object`，证据里 `containerAbsent` 为 false。回查 `docker inspect` 为 no such object，`docker ps -a` 无 auth2 容器。脚本判断已改为兼容 `no such object`，没有为此重跑 PG。

预存匿名卷 `79e6b625…` 未删。

## 最小可实现设计（Root 改共享代码）

不扩 T11/T12。不改本轮已验收 gateway。

### 1. 保护凭据引用

保持 `CredentialMaterial` 与 `resolveAuth`。不要给模型增加 `fill_secret` 工具。

新增仅 Worker/Runtime 可提交的认证动作，建议名 `fill_credential` / `import_storage_state`，args 只有 `target` 与 `slot`（username|password|otp）或空。`grantAction` 持久化时禁止出现 secret 原值、cookie value、storageState JSON。执行时由当前 lease 调 broker 取材料，用完不写库。

OTP 仍走现有 waitForInput + 一次消费；不进 message/SSE/export。

### 2. 认证动作来源

新增 `AuthStepSource`：`{ kind:'auth_profile', authProfileId, authProfileVersion, slot, formConfigHash }`。哈希对冻结 FormConfig。来源不是 RegressionStepSource，不能用 DSL type_text 登录，不能让模型自造 source。

回归在该 source 落地前继续对 form/storage_state 返回 422。smoke form 只允许这条 source。

### 3. 会话注入

none：不调用 resolveAuth，不传 approvedAuthState。

storage_state：resolveAuth 之后再校验 origin ⊆ 冻结 allowedOrigins ∩ run allowedOrigins，并加明确字节上限。只把合法 cookies/origins 交给 `approvedAuthState`。禁止空 catch。localStorage 若必须有文档，应走已授权 navigate（计入 grant/record，失败受阻），或 Playwright 的 context 初始化接口且失败即 AUTH_FAILED。

form：按 FormConfig 顺序 fill_credential + 已有 click/navigate，成功条件用冻结 criterion，失败受阻。

### 4. exclusive_run 锁与清理

新表，建议 `auth_profile_run_locks(project_id, auth_profile_id, run_id, status, fencing_token, held_at, lease_until, released_at)`，held 行对 `(project_id, auth_profile_id)` 唯一。

- exclusive_run：第一次真正登录/import 前获取锁。第二 run 不得并行登录同一剖面。
- shared_state：不加锁，仍冻结 version。
- 释放：run 终态、cancel、非 otp 的 waitForInput、lease 过期（并入现有 expire/tick，不改 scheduler）。
- 恢复：held 但 run 已终态或 lease 不在，tick 释放。otp 等待按设计最多 300s、不超过一半槽位。

### 5. 必需测试（Root）

1. exclusive_run 第二 run 在 held 时不能开始登录；shared_state 可以。
2. 终态/cancel/过期后锁释放，第三 run 能获取。
3. none 仍 0 decrypt、0 approvedAuthState、0 input_requests。
4. form/storage_state 不再 waitForInput 匿名放行；成功走 broker；失败受阻。
5. fill_credential 的 action_intents/steps/SSE/report/model 不含 sentinel；type_text 不能带 vault 原值。
6. storage origin 不在允许集、容量超限、goto/init 失败：0 发送、run 受阻。
7. 撤销、错误 worker/fencing/context：0 材料。保持现有 35 项不回退。
8. 回归 form/storage_state 在 AuthStepSource 完成前仍 422。

## 未验证

真实 Playwright 注入、真实登录页、SSE 长连接（只测了 event-history HTTP）、报告字段级拆分、SecretVault 生产挂载、并发两个 Worker 抢同一 exclusive 锁的时序、otp 300s 槽位、T11/T12。

## 清理

本轮容器/卷/临时目录已删除。docker ps 无 auth2。ego 未使用。未跑 git。
