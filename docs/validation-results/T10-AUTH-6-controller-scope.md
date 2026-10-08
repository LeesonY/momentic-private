# AUTH-6：私有动作账本与固定认证适配器

Root 2026-10-07，沿用户已授权的续办与 Claude 替换 grok 指令继续。AUTH-5 的会话基础当前 Root PG 11/11、私有端口 16/16 通过；前端输入两个 Root 反例由 agy 修复中。完整认证执行尚未接受，P0=false，Ego/真实浏览器暂停，不调用产品模型、部署或生产迁移。

## 归属

- pi / wF:p2：AUTH-5 会话文件只作必要复用；新增 `packages/orchestrator/src/auth-actions.ts`、`packages/storage/migrations/012_auth_execution_actions.sql`，Core/Runtime/index 的私有转发，定向 PG 测试。不得改 browser/web/Worker、共享生成契约和 Root 反例。
- Claude / wF:p4：新增 `apps/worker/src/auth-flow.ts` 和纯 Node/FakeBrowser 测试；只对 AUTH-5 新的 private-auth.ts/test 作格式修整及必要兼容修复。不得改 Worker.once 主路径、pi 的服务端文件、web 或真实 session.ts。
- agy：继续其已派发的输入 UI 修复。
- Root：接口集成、独立验证、后续 state/OTP/capture/handoff 接线。没有完成 capture/finish 的可信服务路径前，保持当前非 none 运行受阻；不能用假 stateRef 放行产品。

## pi：私有账本基础

内部请求 `AuthActionRequest = {requestId, sessionId, action, slot, target?}`。动作/slot 沿 AUTH-5 四动作；URL 由冻结 profile.loginUrl 派生，不接受调用方覆盖 URL，不接收 secret/state/OTP/code/text。目标用现 NodeTarget，填表/提交须验该 session 已登记的 snapshot provenance；新 `recordAuthObservation` 将同 session 的脱敏 BrowserSnapshot 登记到现 page_snapshots/controls，并绑定 auth session/epoch。snapshot/NodeTarget 不由相同 run/context 字符串自动证明归属。

方法均经 Runtime 私有 scope/proof 和 Coordinator 同事务调用：`recordAuthObservation`、`grantAuth`、`beginAuthExecution`、`recordAuth`。所有操作要求 smoke、服务器 Task.summary=auth、active session、当前 scope/profile/context/epoch，最后一个可能阻塞的锁之后再验证租约/会话时钟。沿已定锁序；材料解析/解密、浏览器 effect 不在 PG 事务中。

`grantAuth` 持久化服务器派生的 permit，含完整 AUTH-5 binding、grantId/deadline/action/slot/target/服务器 URL，无凭据。requestId 在同 session/action/body 下幂等，同 ID 换 body 冲突，重复不重复预留。预算预留用现 run budget 账本，每个认证动作 actions:1。新增私有 metadata 明确标识认证 intent；普通 grantAction/recordAction/HTTP result 通道必须拒绝消费此认证 intent。Step 可使用现字符串 toolName 和常量 summary/targetDescription，不扩 ToolCall，不在本批添加未生成的 Step 属性。

`beginAuthExecution` 在任何副作用前 CAS issued→started，返回私有 receipt；同 grant 第二次 begin 拒绝，跨 worker/fence/session/epoch 拒绝；不能把状态查询当作第二次副作用授权。`recordAuth` 要求此 receipt 与完整绑定，按脱敏结果 hash 幂等，同 ID 换结果冲突；一次事务结算 actions:1、更新 intent/Step 及脱敏 snapshot。failed/unknown/cancelled 真正收费，不改写 succeeded，不存自由错误正文。未 started 的 record 拒绝。

exclusive_run 在首次 begin 时获取 run/profile 初始化锁，绑定 initializer session+proof/epoch；另一 run 返回 RATE_LIMITED，不匿名继续。shared_state 无 exclusive 行，其他 gate 相同。争同 profile 不等待另一 run 的锁再取得本 run：使用同键的 try-advisory/唯一约束做受控冲突。初始化失败、取消、过期时 private intents 收 unknown/正确结算并释放初始化锁；保持回归 non-none 422。普通 finish 不得绕过 pending auth intent 或在无 committed auth state 时结束 auth stage 成功。capture/granted 升格与并发 importer 放到下一批实现，不能用 initializing 锁冒充 granted 状态。

新增表/列强制 RLS，私有 receipt/hash 只有服务 admin 可读取；普通项目 actor/worker 不直接读私有内容。共享 Step/预算已有可见元数据保持脱敏；新状态转换与绑定约束可复跑验证。测试至少覆盖伪造/复用/并发 begin、错误 proof/session/epoch、过期锁等待、snapshot 串用、request/body/hash 冲突、预算一次收费、exclusive 第二 run、shared 不持锁、取消/恢复与普通动作通道拒绝绕过。全量迁移只在自建 PG，失败证据和资源清理回查保留。

## Claude：固定认证适配器（先 Fake Runtime，后 Root 接线）

生产函数接收已冻结 profile、active authority binding、私有 `AuthFlowRuntime` 与 `PrivateAuthPort`，以及可信 locator/criterion 适配函数。Runtime 方法接口按以下流程公开给可信 Worker，模型无入口：

- `material()` 返回本 proof/profile 的 CredentialMaterial，仅本地内存。
- `grantAuth(request)` 返回私有 AuthPermit；port 的 gate 由可信 Runtime 调 `beginAuthExecution`，而非适配器默认允许。
- `recordAuth(permit, outcome)` 上报经过端口脱敏的结果，常量状态/原因；不用 ToolCall。
- `recordAuthObservation(snapshot)` 登记本 session 脱敏观察，使下一目标 permit 具备 provenance。
- `pauseForOtp()` 的契约是一次、保持当前 lease/context 的私有 OTP 等待；本批正向用 Fake Runtime。不得调用会释放 lease 的 waitForInput。真正 OTP 密文票/消费门仍由后续服务端接线，本批不开放公开输入。
- `recordAuthCriterion(snapshot, result)`、`issueCaptureGrant()`、`captureAuthState(grant, state)`、`finishAuth(stateRef)` 为后续真实 Runtime 服务接口，当前必须明确 Fake。不能伪造 stateRef 或让产品主路径调用假的成功实现。

form 顺序固定：材料→navigate_auth（URL 只从 permit）→username fill→password fill→首次 submit→仅配置 otpTarget 且当前可解析时等一次 OTP/fill/第二次 submit→最终 successCriterion→通过才签发 capture grant→port.exportAuthState(grant)→capture→finish。任何失败关闭/结束会话，受控 blocked，reasonCode 常量，无 secret/page body/raw exception；失败后不循环请求第二票。不得在成功条件失败后再去 OTP。

storage_state：只通过私有 import_storage_state/prepare_state 校验注入（导航0）→受授权的导航到冻结目标→当前条件/观察→capture/finish。none 不取材料、不建私有 port。locator、criterion 必须使用当前 snapshot，支持范围明确；缺 resolver/未支持 criterion 受阻，不编造 passed。每次 action 在 record 成功后再前进，record/持久化失败不能完成认证。export/capture/finish 保持同一 active binding/proof，关闭后的材料不重用；完整实现不可宣称分布式 exactly-once。

Fake 测试必须调用实际生产函数，记录动作/顺序/gate/异常/关闭；验证没有普通 type_text/ToolCall、一次 OTP、失败不重试、prepare 导航0、无材料进入 outcome/error、record/capture/finish失败不返回成功、新任务不共用私有材料。产品 Worker.once 接线、真实 browser driver、capture 原子性、OTP/exclusive 撤销与 crash handoff 由 Root 后续集成及单独验收。

## AUTH-6B：Runtime 桥接续办（Claude）

Root 已确认既有 storage_state 材料的规范键为 `CredentialMaterial.material.storageState`（合法 JSON 字符串或经 approved-state 校验的对象）；不采用首版 Fake 中自行定义的 `state`。Root 已复跑修订固定流程的 9 项 Node/Fake 测试通过；实际 Worker 接线仍未完成。

Claude 接着独占新增 `apps/worker/src/auth-runtime.ts` 和对应 Node/PG 或 Fake 服务测试。实现可信适配器，接收已有 RuntimeClient、当前 proof/active binding，以及必须显式提供的私有 material/OTP/criterion/capture/finish 服务；这些未实现服务不得默认成功、假 stateRef 或 ordinary HTTP fallback。返回 AuthFlowRuntime 与 PrivateAuthPort gate：

- grantAuth/recordAuthObservation 转发当前 proof；每个 permit 再检查完整 binding，不能补造 metadata。
- gate.authorize 先调真实 `beginAuthExecution`，把 receipt 保存在私有闭包，按 session+grant+proof 关联，模型/Step/outcome 不接触 receipt。
- flow.recordAuth 只用对应 receipt 转真实 recordAuth；缺 receipt 拒绝，重复结果遵守服务幂等，不能拿另一个 grant/session 的 receipt 结算。保持常量原因与脱敏结果。
- export gate/OTP/capture/finish 等必须转调用明确提供的可信服务，当前服务未实现就保持受阻。tests 的 Fake 服务必须标注；至少使用当前实际 RuntimeClient facade 或等价严格签名验证既有四方法的兼容性。
- proof/binding 在构造时复制并固定，接口方法每次由服务端复验当前权限；不能因缓存 active 值放行已过期/撤销/重绑定。原始 leaseToken 只在私有闭包中，不进日志/可枚举业务返回对象。

本批不改 Worker.once、pi/Core/storage/公开契约或真实 session.ts；不启动浏览器、worker-entry 或 provider。adapter 可独立完成和复验后，Root 再安排 state/capture/OTP/handoff 的真实服务及主路径接线。
