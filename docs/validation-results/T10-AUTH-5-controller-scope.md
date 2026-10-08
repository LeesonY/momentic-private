# AUTH-5：恢复推进，第一批实现边界

2026-10-07，Root 根据用户“没完成为什么不继续”恢复既有 wF 三个 agent 的后续任务。此前由 Root 安排的源码冻结/待命被本文件中明确列出的文件范围取代；历史验收和失败证据保留。Ego/真实浏览器操作仍暂停；不调用产品模型、不部署、不提交 Git，不另启监控器。P0=false。

完整认证由服务端会话、私有执行、受保护状态、OTP 和 Worker 接线组成。先完成下面互不抢文件的基础实现并独立复验，随后由 Root 接线下一批；不能因本批通过宣称完整认证完成。

## 统一决定

- 采用 AUTH-4C 的正整数 authEpoch：首次初始化为 1，捕获成功不换 epoch；撤销/新的显式认证 attempt 才递增。sessionId 由服务端生成，与普通 contextId 分离。
- 冻结最小绑定形状：`{sessionId, projectId, runId, taskId, workerId, fencingToken, contextVersion, contextId, profileId, profileVersion, authEpoch, purpose, expiresAt}`。purpose 为 `initializer | importer`，时间为 ISO 字符串。任何客户端给出的这些值都不能替代服务端数据库检查。
- 新执行权限来自当前 lease proof、冻结 profile、run/context、scope epoch 和已激活 session；none/无绑定不登记、不解密、不取锁。每个 task+fencing 只分配一次会话，active/ended 会话不得重新激活或复用为另一个浏览器实例。
- Session 激活票只在私有响应中传递，数据库只存 hash；allocated 时单独签发/换发票，换发使旧票失效；激活 CAS 单消费。丢失激活回执先查询状态，不第二次激活。leaseToken、票和凭据均不进入 Work 公共 DTO、Task、模型、事件、报告或日志。
- 当前基础方法遵守 `job/lease → run → auth scope → auth session → profile FOR SHARE`，每次重新验证 profile 没被撤销；票提交前重新检查租约时钟。完整 revoke/cancel/handoff 锁序在下一批统一接线，本批不得宣称完成全局锁序。
- 四个认证动作只存在于私有执行端口：`navigate_auth/login_url`、`fill_credential/username|password|otp`、`submit_auth/submit`、`import_storage_state/storage_state`。不扩 ToolCall，不把凭据塞进 type_text。
- 私有端口的执行 gate 必须是可信 Runtime 提供的闭包；副作用前检查完整绑定、有效期/abort、action/effect/slot、不可重用 grant，并等待 gate。重叠或重复 grant 不执行第二次；gate/adapter 出错用常量码，不记录材料。
- `prepare_state` 校验 approved state，导航为零；导出只从同一 active 实例取得。普通模型端口不获得 executeAuth 或 exportAuthState。认证快照至少脱敏所有已填目标的 text/name，且本批不开 trace、不截图。
- 浏览器暂停期间可写纯 TypeScript、运行纯 Node/FakeBrowser/自建 PG/API；不得启动 Playwright、worker-entry 或真实 browser，也不得用它们绕过 Ego 暂停。

## 文件与交付归属

| agent | 本批范围 | 必须证据 |
| --- | --- | --- |
| pi / wF:p2 | 新 `packages/storage/migrations/011_auth_execution_sessions.sql`、新 `packages/orchestrator/src/auth-execution.ts`、`core.ts/runtime.ts/index.ts` 的最小私有 facade、新 `apps/api/test/t10-auth-session-authority.test.mjs` | 真实 PG：分配/激活/查询/结束；并发单会话与单消费；错误 token/worker/fence/context、profile revoke/none、过期/结束/跨 task 全部拒绝；普通 Worker/HTTP 回写不回归。只迁移自建 PG。 |
| grok / wF:p4 | 新 `packages/browser/src/private-auth.ts`、browser index 导出、对应纯 Node/FakeBrowser 测试 | 四动作不产生 ToolCall，双执行/并发/串改绑定/过期/abort/gate 拒绝均副作用0；材料不进 snapshot/error；prepare_state 导航0，关闭后不可导出。真实 session.ts 暂不改。 |
| agy / wF:p3 | `InputRequestBar.tsx`、`WorkbenchPage.tsx` 输入回复接线、`RunStore.tsx` 的 respondInput/请求身份引用及单独 Node/SSR 检查脚本 | 现无安全 OTP 服务端，因此 auth_profile/one_time_code 不经普通 text 或 approve 提交材料；显示受阻并允许拒绝。clarification 保留，切 request/run 清空旧输入且迟到回复不影响新请求；reject 不擅自把 run 改 running。真实 hydration 未验。 |
| Root / wF:p1 | 本文件、`apps/api/src/routes/runs.ts` 的输入回复安全边界、独立反例/验收、后续集成和统一矩阵 | 不把 agent 自述当验收；源码与实际方法复验，保留失败证据，清理并回查自建资源。 |

## pi 最小服务方法

`allocateAuthSession(proof)`、`issueAuthActivationTicket(proof, sessionId)`、`activateAuthSession(proof, sessionId, ticket)`、`authSession(proof, sessionId)`、`endAuthSession(proof, sessionId)`，均经 Runtime 的私有 scope 转发、Coordinator 完整 validateLease。initializer 只允许服务器 Task.summary 为 auth 的 smoke task；importer 暂拒绝，直到下一批 state capture/import 接线并验收。不信任 job.result.stage，不新增公开 HTTP 路由。可加入 Stage.auth 类型，但不把未实现认证阶段放行到 explore。

Migration 强制 RLS，只有 `localqa_app` 的 `is_admin()` 服务身份能读写这两张受保护表；普通项目 owner/operator/viewer 及 localqa_worker 不可直接读 activation hash/会话登记。schema 约束跨 project/run/task/profile 的一致关联，正整数 epoch 与 fencing，严格 status 转换。票不含凭据。本批不得插入 granted state 或 exclusive 锁，不解密用户材料。

## 下一批依赖

Root 接受基础后继续派发 grant/begin/record（预算及执行 CAS）、受保护 capture/import 与 exclusive/run epoch，再接 OTP 与 Worker 固定认证流程。真实浏览器和最新供应商验证保留为明确缺口，暂停期间推进可独立完成的实现与测试。

## 用户替换 agent 后的私有端口续办

用户已将 grok 工作交给新开的 Claude，仍在 `wF:p4`。grok 额度耗尽；其全部修改保留。Root 已接管其未完成的异常/克隆/receiver 与测试夹具修复：现纯源码反例 8/8，包检查为 8 个 private-port case 与 20 个 approved-state case（Node runner 报 21 个 subtest）通过。此前失败报告保留。此结果仍不是 Runtime 执行接线接受。

Claude 独占 `packages/browser/src/private-auth.ts`、对应包测试与 index 的必要导出，接着补私有导出的授权门。冻结以下续办接口：

- 私有端口只接受已激活 binding：额外 `status: 'active'`。这只是防止误用 allocated/ended binding，不能代替服务端每次 gate 验证。
- `AuthExportGrant` 为现完整 binding 元组，加 `grantId`、`deadline`、`kind: 'capture_auth_state'` 与私有 `captureTicket`。ticket 不进普通日志/ToolCall/Step/模型；仅用于 Runtime 私有服务边界。
- `AuthExecutionGate.authorizeExport({ binding, grant }): Promise<void>` 必填；`exportAuthState(grant, signal?)` 先复制/冻结、检查元组/期限/abort、同步占用 grantId，再 await 此 gate，才允许从当前实例导出。导出后再次检查 active/期限/abort，再校验 state。相同 grant 不第二次导出；闭包拒绝时导出 0 次。不保留旧无参数导出或默认允许的 fallback。
- factory 的 adapter 必須保留各方法原始 receiver；材料/状态 getter、循环或非 plain 对象不能在克隆阶段被规范化成获准材料或泄漏异常。state 的原始形状仍经 AUTH-4A validator。
- 本批 gate 的正向证据使用明确标注的 Fake Runtime；真正服务端 capture ticket CAS、成功条件和密文提交仍依赖后续 Coordinator/Worker 接线，未完成前不启用真实认证执行。

必测：缺 gate/票、旧 epoch、非 active binding、跨 session、并发重复导出、gate 阻塞期间改 grant、拒绝/过期/abort/关闭均无材料返回；保留现有全部私有端口及 approved-state 回归。Root 调整并复跑独立脚本。无 browser/provider/生产迁移；不切账号或模型。
