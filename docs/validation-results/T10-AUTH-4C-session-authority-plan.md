# T10-AUTH-4C：执行会话权威边界补案（只读，待 Root 审核）

**未冻结、未实现，P0=false，Ego 暂停。** 本次只读源码/既有设计并新增本文；未运行测试、浏览器、worker-entry、模型、部署或迁移，不授权后续自行实现。本文细化 [AUTH-3 修订3](T10-AUTH-3-interface-plan.md) 与 [AUTH-4B 修订2](T10-AUTH-4B-private-execution-plan.md)，不扩 ToolCall、模型能力或 T11/T12。[4B Root 审查](T10-AUTH-4B-controller-design-review.json)仍明确设计未冻结；[4A 接受](T10-AUTH-4A-controller-acceptance.json)仅证明纯状态校验 helper。

## 1. 当前事实，不是已有认证执行能力

| 源码锚点 | 实际事实 / 缺口 |
| --- | --- |
| `packages/storage/src/leases.ts::claimTask/currentLease` | claim 同事务写 jobs、递增 fencing、随机 lease token 的 hash 与 task_leases；当前 proof 校验 worker、task、token、到期、run/context。没有 auth session 登记或 authEpoch。 |
| `packages/orchestrator/src/core.ts::claim/validateLease` | claim 用 advisory lock 741005 串行槽位记账；validateLease 锁 job/lease，再锁 run，检查当前 proof/run。claim 不等于认证锁获取，更不等于浏览器已创建。 |
| `Coordinator.work`（Runtime 的 `work`，即 getWork 语义） | 无 case 时每次随机 contextId；有 case 时持久 case_attempts.context_id 并可复用 running attempt。Work 没有认证 session/profile/epoch 权威引用，Stage 无 auth；stage 仍取 result.stage 优先于 Task.summary。 |
| `grantAction/recordAction/finish` | grant 只收 ToolCall，持久 intent+Step+预算；record 校验当前 lease/fencing、结果 hash 幂等。finish 要求无 pending intent，按 result.stage 核对，成功时释放 lease/槽位；终态同 hash 可直接幂等返回。没有 session/epoch 校验或 capture 提交门。 |
| `RuntimeClient` / Worker | Runtime 持有私有 Coordinator/WorkerScope；form/storage_state 仍 requireAnonymousOrInput 阻塞。Worker 把 work.contextId 当 options.sessionId，task 隔离、finally close、trace=false；没有私有 auth 端口、capture/import 执行桥。 |
| `apps/api/src/routes/internal.ts` | auth/resolve 强制 caller 的 worker/fencing/context headers 并核对冻结 profile。通用 extractScopeAndProof 却可从当前 DB 补缺失值；`actions/{actionId}/result` 调 extract 后直接更新 intent/Step，**没有调用 recordAction 完整验证/结算**。新认证路径不得复用这个 shortcut。 |
| `packages/browser/src/types.ts, port.ts, session.ts` | options.sessionId 可由调用方传入或 browser 随机生成；普通 Port 无 executeAuth/exportAuthState。approvedAuthState 目前可直接注入，localStorage 导入会隐式 goto 且吞导航异常；并无服务端 session 激活证明。 |
| `packages/storage/src/crypto.ts::SecretVault` | GCM AAD 已绑定 projectId/secretId/purpose/keyVersion；未绑定 run/session/epoch。现有密文能力不等于获准跨 task 的认证状态表已经存在。 |

因此：**字符串 UUID、相同 contextId、可构造 permit 对象或客户端 Map 都不构成服务端授权。** 服务端能保证授权链，不可能仅靠 HTTP body 证明浏览器确实登录成功、导出字节确实来自当前 DOM；物理 browser/worker 执行器仍是可信服务边界，不能把不可信模型/用户暴露为这个执行器。

## 2. 拟议权威生成点、身份与字段分配

### 2.1 分离 run epoch 与 task session

拟议服务端 `run_auth_scopes` 每 run 一行：冻结 profile ID/version、contextVersion、单调 authEpoch、status=initializing/granted/revoked、currentStateId。shared/exclusive 都有此权威行；none/无绑定不建认证行、不解密。epoch 由 Coordinator 产生，Worker 不能指定下一值。新认证 attempt 或撤销必须失效旧 epoch；不得仅凭新 claim 在旧 initializing epoch 上续跑副作用。

**本补案建议 epoch 从初始化即取正整数**（如首次1），capture 不换 epoch，仅 initializing→granted；撤销/显式新 attempt 才递增。AUTH-3 的 initializing lock epoch=0→capture=1 相应改为始终跟随 scope.authEpoch，避免 session/permit 在 capture 时悄悄换身份；此差异须 Root 冻结，不能视作原方案已实现。

接线前提仍沿 AUTH-3：非 none 的 smoke 停在 auth，新增 executor job 的 `Task.summary='auth'`，Work.stage/finishAuth 必须核对服务器 Task.summary，而非信任 jobs.result.stage；none 保留空跳。现有 Stage/tick 尚未具备这条路径，回归非 none 仍维持422，不借此放开。

claim 仍只颁发 lease。在 **第一次 `work/getWork(proof)` 的同一事务**：验证当前 lease/run/冻结 profile，服务器随机生成并持久化 sessionId，关联 `(project,run,task,worker,fencing,contextVersion,profileId,profileVersion,authEpoch)`、`contextId`、用途 initializer/importer 与有效期。唯一活跃登记键 `(task_id,fencing_token)`；重复 getWork 返回同一登记，不能每次生成新 session。queued/start/preflight 不抢 exclusive 登录锁。

登记后 `activateSession` 消费服务端生成的高熵 activation ticket（只存 hash），状态 allocated→active；可信私有 BrowserPort 创建无凭据 context，随后绑定激活回执，激活前不能 auth effect/export/import。创建或激活失败关闭 context；丢失激活回执时查询登记状态，不重新激活/新建另一个 browser 使用旧 sessionId。已 active 且进程丢失必须显式 abandon 或到期回收，不能靠 getWork 重建。**服务器不能探测浏览器进程真的只建了一份**；一次性激活与可信端口的实例映射共同约束，不提供硬件 attestation。

现 Work.contextId 是 case attempt 逻辑关联，不自动升级为 session 权威。认证新增独立 authSessionId，registry 同时保存原 contextId；认证 browser options 使用服务器 authSessionId。现 Worker 的 contextId=session.id 假设及 attempt/report 关联须在冻结时显式对齐，不能悄悄重用旧 attempt 的 browser 身份。

| 接收方 | 拟议字段 / 权限 |
| --- | --- |
| Work（内部） | 原字段 + `authSession: {sessionId, contextId, purpose, profileId, profileVersion, authEpoch, originFingerprint, status, expiresAt}`；profile 信息均由冻结 run 派生。激活 ticket 走独立私有响应，不进入 Task/jobs.result/public DTO/model payload。 |
| AuthPermit（私有） | grantId、server-issued binding 全元组、deadline、动作/slot、允许 target/url、reservation 引用；**不含凭据或 leaseToken**。单纯反序列化对象不能调用端口：还需当前 session 激活绑定和服务端执行门。 |
| PrivateBrowserPort | 内存中不可任意构造的 active session binding、实例映射、Runtime 私有 gate closure、AbortSignal；仅 permit 的绑定元数据及局部 secret/state effect。原始 leaseToken 保留 Runtime 私有域，不给模型、通用 options 或日志。 |
| 普通 browser options / ToolCall / Step | options 只指向已授权 session，由可信 factory 传递；不公开 ticket。ToolCall 不增认证动作。Step.authSource 沿 AUTH-3 服务器派生且与 regressionSource 互斥；Step 来源不是授权凭证。 |

## 3. 短签名与一次性执行门（全部拟议）

```ts
// 所有 Coordinator 调用还带服务端 WorkerScope；P 为当前 LeaseProof。
getWork(P): Promise<WorkWithAuthSession>; // 事务内分配/返回同一 registry 行
activateSession(P, sessionId, activationTicket): Promise<ActiveBinding>;
abandonSession(P, sessionId): Promise<void>; // 不重开原 session

grantAuth(P, sessionId, requestId, action: AuthAction): Promise<AuthPermit>;
beginAuthExecution(P, sessionId, grantId): Promise<ExecutionReceipt>;
recordAuth(P, sessionId, grantId, receipt, redactedOutcome): Promise<void>;
issueCaptureTicket(P, sessionId): Promise<CaptureTicket>;
captureAuthState(P, sessionId, ticket, requestId, exportedState): Promise<AuthStateRef>;
importAuthState(P, sessionId, authStateId, requestId): Promise<PrivateImport>;
finishAuth(P, sessionId, authStateId, result): Promise<void>;

// 只在可信执行器内可达；不注册为模型/DSL 工具。
privateBrowserPort.executeAuth(activeBinding, permit, effect, signal);
privateBrowserPort.exportAuthState(activeBinding, captureTicket, signal);
```

- `requestId` 幂等作用域包含全 binding 元组、操作与脱敏 body hash；同 ID 换 action/session/epoch 拒绝。AUTH 路径 headers 必填 caller worker/fencing/context/lease token，body 重复字段不符拒绝；DB 只能推导 project/run，**禁止拿 DB 当前 fencing/context 补 caller proof**。
- grant 同事务验证 active registry、scope epoch/status、冻结 profile/未撤销、当前 lease、来源与预算，再写 reservation、intent、Step、session 引用。普通 observe 的 auth snapshot provenance 也要关联当前 session；只用 taskId 的旧 snapshot 不够。
- 在任何副作用之前，私有端口通过 gate closure 调 begin：事务 CAS intent `execution_state=issued→started`，校验 binding、lease、epoch、deadline；一个 grant 跨进程最多一个 begin 被获准。可信端口再验实例、receipt 与 permit 完全相同，先把本地 grant 标为 running，再执行。响应丢失/started 后 crash **不重放**，只允许查询或走 unknown 回收。
- record 用权威 intent/Step 重建绑定，不信 caller 拼装 AuthGrant。当前 proof/session/epoch 相同、receipt 对应 started、相同 redacted result hash 幂等；不同 hash 拒绝。已结束后只能返回已存结果的 receipt 查询，不产生新副作用、不返回 secret。
- deadline 不超过发放时 jobs/task_leases 的较早 leaseUntil。heartbeat 不换 fencing/epoch，可维持 active session，但不自动延长旧 permit；旧 permit 到 deadline 后不能 begin。lease/scope revoke 立即阻止新 begin；执行途中靠 signal/close 尽快终止，无法把已发生的浏览器副作用回滚或宣称跨 PG/browser exactly-once。

## 4. capture/import 与持久化原子性

### 4.1 所有策略共同的 session 检查

每次 resolve material、begin/record、capture/import 均查当前 proof、active registry、run/context、冻结 profile、scope.authEpoch；shared_state **也查这些，不查 exclusive lock**。材料只进入私有内存，禁止普通变量、prompt、事件、报告和诊断输出。

capture 只允许 initializer auth job，在 supported successCriterion 已评估 passed、所有认证 intent 已结算后签发一次 capture ticket；ticket 绑定当前 session/proof/epoch、最后完成的 auth grant/成功检查引用及 deadline。端口只能从该 active 实例导出，返回内存 branded export；Runtime 不提供把任意旧对象当 export 的普通业务入口。服务端仍须校验 ticket+绑定、origin/容量/state schema，不能宣称 nonce 自动证明 body 新鲜或真实登录。

AUTH-3 的脱敏结构 fingerprint **不能用于判断 secret 内容相同**：同 cookie 名/domain 但不同 value 会碰撞。拟议 capture 的幂等比较使用服务器受保护的 **完整规范化 state 的 keyed HMAC**（另用安全密钥，不写普通日志/public报告）；同 request/ticket 同内容返回同 stateRef，不同内容 VERSION_CONFLICT。HMAC/keyVersion 仅受保护存储。state 密文封装内含全 run/profile/context/epoch/capturing session 元数据，解密后与权威列逐项核对；沿用 SecretVault AAD project/secret/purpose/keyVersion，不谎称当前 AAD 已包含这些新字段。

### 4.2 capture 提交点

1. 先在私有内存校验/加密材料；**不得**先标 granted、先放行 explore 或把明文写 scratch。若预加密在事务外，提交事务内必须重新验证 proof/scope/session/ticket。
2. 一个 PG 事务写 secret/secret_versions（或等价受保护密文行）、run_auth_state 行、consume capture ticket、scope initializing→granted、exclusive lock initializing→granted/run+epoch、session capture 引用及幂等 HMAC/receipt。任一写入失败全回滚；无可导入 state、无 explore、不能发送成功 stateRef。数据库权威存储优先，不引入与对象存储的假原子双写。
3. encrypt/持久化明确失败：保持无 granted state；适配器关闭 session，受控失败事务 revoke 初始化 epoch、结束 session/票、释放初始化 exclusive 锁、认证 job 失败受阻（setup_failure/AUTH_FAILED，诊断只常量码）。若 PG 不可用，不能假称失败清理已提交：保持阻塞，lease 到期 recovery 在恢复可用后做同样清理；不允许匿名继续。
4. commit 成功但 HTTP 回执丢失：仍是 granted，可在仍有效同 session/proof 下按 ticket/request 查询原 stateRef；新 proof 不能再次 capture，也不能 record/finish 旧 job。状态身份不以 Worker 收到回执为准。

### 4.3 import 与 exclusive 并发

子 task 各自经 getWork 分配/activate **新 session**，自己的当前 proof；import 验 state.status=granted、currentStateId、epoch/profile/context/origin、完整密文绑定及容量。事务写独立 `(session_id,task_id,fencing_token,auth_epoch)` import grant；解密材料只在事务成功提交后返回私有内存，commit失败不得返回材料，expiresAt 不超过该 task 当前 lease。已结束 session/import 行禁止重新解密；重试不得把同 importGrant 在两个实例 prepare。

解密时封装的 capturing_session/proof 要匹配 state 行保存的**历史捕获来源**，不能要求等于当前 importer session；当前 importer 的独立授权由 registry/import grant 绑定。返回材料不得因此携带可重放的 initializer permit/ticket。

exclusive 额外要求 lock held/granted、run 与 epoch 一致；**不要求** initializer task/fencing 或任何唯一兄弟 holder 等于当前子 task。A/B 可以各有 active imports；A finish/expired 仅结束 A 行，不改 B、不释放 granted run lock。不同 run 的首次初始化仍互斥。shared 同样验证 session/epoch，只是没有 lock 行。

import 材料准备与页面导航分离：prepare_state 只 validate/addCookies/固定 init script，导航0次；下一次已授权 navigate 才执行 localStorage 注入。必须约束导航与重定向的每个实际 origin（冻结 profile ∩ run origins），不能仅验初始 URL；失败关闭 context、record failed、不吞异常，不把 partial import 记成功。trace 从创建即关闭；secret/state 不进脚本文本、原始截图、网络 body/query 或日志。

## 5. 明确状态转换与 crash 行为（拟议）

| 事件 | Session / intent / job | Run auth scope/state/锁；允许后续 |
| --- | --- | --- |
| claim→首次 work | allocated，尚无副作用；proof 固定 | epoch 由服务器登记；无 exclusive 锁 |
| activate→首次 auth begin | active；issued→started | exclusive 初始化此时持锁；shared 无锁 |
| OTP 等待 | active，job running，heartbeat 保留；票绑 session+全 proof | 不调用会放 lease 的 waitForInput；最多一票/尝试，失败不循环 |
| begin 成功后 crash，尚未 capture | intent pending/started→unknown；session expired/abandoned；job interrupted | 初始化 epoch revoke、票失效、初始化锁释放；不重放；显式新 attempt 新 job/session/epoch |
| encrypt/capture 写入失败 | 不存在 committed capture；session close/failure | 无 granted state；阻塞到失败/回收事务提交，不 explore |
| capture commit 成功，finish 前 crash | initializer session 结束，pending 应为0；job 可能仍 running 后 interrupted | **granted state 已权威提交**，锁保持 run+epoch；recovery 不再登录 |
| 上行 recovery | 系统专用 handoff 事务确认 state 捕获的旧完整元组/成功门，标记 auth stage 已提交；记录 recovery 的系统审计，不伪造新 Worker 的 finish | 保留 granted state/epoch，按 unique_key 幂等 enqueue explore 一次。不能走旧 no-case interrupted 的空泛路径或无限等 auth job succeeded |
| 同 proof 正常 finishAuth | 校验 capturing session/proof/state、无 pending；job succeeded、session closed、lease/槽位释放 | scope/state 保持 granted，锁不释放；explore 同一幂等 handoff 门 |
| 子 task 正常结束/lease过期 | 只 ended 该 session/import；未知副作用正常收费 | 兄弟 task 与 granted state/锁不变；重试新 fencing 必须新 session/import grant |
| context改变/profile撤销/run取消或终态 | sessions revoke，票/未执行 permit 失效、已开始动作收 unknown，signal/close | scope epoch++/revoked、state revoke、exclusive 锁释放；旧内存状态必须丢弃 |

capture-commit 崩溃恢复是 AUTH-3 “按 granted 前进”的**具体服务端提交门**，不是容许新 fencing 伪造旧 finish。获准状态若随后 revoke，handoff 必须拒绝；即使 finish/result 已同 hash，终态幂等 receipt 也不重新激活 session或导入。

## 6. 最小持久化/契约及事务要求（均尚不存在，需 Root 冻结）

| 拟议位置 | 最小字段 / 约束 |
| --- | --- |
| `run_auth_scopes` | project/run 唯一、frozen profile ID/version、contextVersion、单调 authEpoch、status、currentStateId、handoffStatus/唯一入队关联；run 终态后不可重开。 |
| `auth_execution_sessions` | 服务端 id、project/run/task/worker/fencing/contextVersion/contextId/profile ID/version/epoch、purpose、status、expiresAt、activation_hash/consumedAt、created/ended/reason；每 task+fencing 一次分配，拒重新激活。关联实际 task_leases；不存明文 leaseToken。 |
| auth intents / snapshot provenance | action_intents 增 nullable auth_session_id、auth_epoch、requestId/bodyHash、execution_state、startedAt/receipt hash；page_snapshots 增 nullable auth_session_id，认证 observe/record 在同 proof 下绑定。普通 ToolCall 不变；认证 body 脱敏。 |
| `run_auth_states` / capture ticket | AUTH-3 的 protected state/secret 引用，加 capturing_session_id、authEpoch、ticket/request/HMAC 与 keyVersion、capture commit receipt；granted 唯一指向 scope.currentStateId。ticket 单消费，绑定全元组/成功门。 |
| `run_auth_state_imports` | session/task/fencing/epoch、stateId、requestId、status/endedAt、deadline；每 session 一次 prepare。不是一个 run 只有一个 holder_task。 |
| exclusive lock / OTP | AUTH-3 受保护表；初始化锁绑 session+认证 proof，granted 后只 run+epoch；OTP 票额外绑 sessionId/epoch，消费与 auth begin 同事务，crash 不退款、不重用。 |
| 内部契约/Port | Work.authSession、注册/激活/执行 receipt/capture/import DTO、AuthPermit 全绑定、私有 Port；AUTH-3 Step.authSource 服务器派生。现 Task/ToolCall/ReplayStep 不扩 secret 与模型动作能力。 |

权限：新密文/票/HMAC/ticket hash 仅受保护 Coordinator/lease 服务可访问，普通 actor/公开 API/SSE/report 无读取能力；最小公开回显仅 stateRef/受阻常量码，不返回 activation/receipt secret 或明文 state。

事务至少覆盖：①claim/lease/槽位；②getWork/session 分配；③activate CAS；④grant/预算/intent/Step/初始化锁；⑤begin CAS/OTP 单消费；⑥record/预算/脱敏 snapshot；⑦capture 原子提交；⑧import 当前 scope/session+授权登记；⑨finish/handoff/job/lease/槽位；⑩revoke/recovery/session/import/票/锁失效。网络/浏览器 effect 不放 PG 事务里等待。

**锁序不是“加几张表”即可成立。** 现 validateLease/claim/tick/recovery 锁 job/lease→run，而 cancel 先锁 run；新路径不能另按 session→run 反向取得锁。建议冻结统一顺序：涉及某 run 的操作先锁其相关 job/lease（按 task ID 稳定序，tick 已批量持 job 时沿用），再 run→run_auth_scope→session（ID序）→exclusive profile 锁（profile ID序）→state/ticket/import/intent→budget/Step。claim 保持平台 advisory 外层；revoke/cancel 必须按同一顺序取得相关 jobs 后提交失效（或冻结另一整套一致顺序）。跨 run 争同 profile 采用同 profile 锁键/唯一约束，冲突返回 RATE_LIMITED，不持一把 profile 锁再等待另一 run。需要改现 cancel/recovery 等事务接线才能声称原子；不在本文实施。提交前重新检查 lease clock、run/context、profile revoked/epoch，撤销 profile 的 writer 必须与该检查有同一 row-lock 序或 CAS 冲突域，不能留下“检查后撤销、提交仍 granted”的窗口。

## 7. 必须拒绝的具体反例（待后续授权验证，不是已通过测试）

| 反例 | 必须结果 |
| --- | --- |
| Worker 随机指定 sessionId，或重复 getWork 新建第二 context 后复用旧 active ID | 未登记/未激活不获准；active ID 不允许二次激活。不能以字符串相同认定服务端权威。 |
| A task 的 permit 放到 B task；同 run/profile 的兄弟 session 互借 | begin/Port 全元组拒绝，0次副作用；合法兄弟各自 import 不互锁。 |
| claim fencing N→N+1 后用旧 ticket/permit/OTP/已导出材料 | 旧 proof LEASE_EXPIRED，不能 capture/record/重新 consume；新 session 不能 finish旧 job。 |
| shared_state 无 exclusive 行，但 proof/session 已过期 | 仍拒绝；shared 不查锁≠不查授权。 |
| 同 grant 同进程第二次执行，或不同进程同时 begin；begin响应丢失后重发 | 本地实例与服务端 CAS 拒重放；started 结果未知则 recovery unknown，不“再点一次”。 |
| 同 capture ticket 的 cookie 结构相同、value 换成另一账号状态 | full-state HMAC 不同→VERSION_CONFLICT；脱敏 fingerprint 不得放行。 |
| capture 成功回执前崩溃/finish前崩溃，新 lease 试图重新登录 | 查询 committed state/系统 handoff，不重放；若 capture未commit，则旧会话 revoke、新显式 attempt。 |
| encrypt失败或密文INSERT失败但 job.finish(granted=true) | 拒绝 finish成功、无可导入state/无explore；清理未提交时仍阻塞。 |
| import 行为被兄弟task结束误删，或要求 importer==initializer | 禁止这种设计；只结束自身 session/import，run+epoch 锁保留。 |
| 缺 worker/fencing/context header，由服务器读当前 job 值补齐 | 新 auth 路径422/403；不续权。普通 actions/result 直接 UPDATE shortcut 不用于 recordAuth。 |
| 老 session observe snapshot/new session target，或尚未结算 auth intent 就 capture | provenance/成功门拒绝；scope相同不是snapshot属于当前session的证明。 |
| prepare_state 隐式 goto、redirect越origin、OTP失败后请求第二票 | 禁止副作用/失败受阻，不吞异常；OTP最多一票，本尝试失败终止。 |

## 8. 审核出口

Root 需确认：epoch初始化约定、session激活/进程失联处理、服务执行器身份认证方式、capture HMAC密钥与成功门、capture-commit recovery/handoff、统一锁序及最小内部 DTO/表列。服务端登记与 permit 防重放仍不等于浏览器结果可信证明；将来的 PG/FakeBrowser 接线和真实 browser/supplier验收必须分别授权、分别记录。**全文只读设计交付，完整认证仍未冻结；等待 Root 只读审核，不自行实现。**
