# P1 Web 回归、定时与修复细化

这是主要 Web 功能的后续实现规格，不表示 P0 已实现。P1 仍使用同一浏览器工具、权限、预算、事件、证据和报告，不能另建一套绕过策略的执行器。

## 1. 用例库和版本

从 RunCase 保存为 SavedCase，或导入自有 YAML。SavedCase 为逻辑身份；SavedCaseVersion 为不可变 document/hash、作者、审核状态和时间。每次编辑新建 draft，不覆盖历史；审批后可用于回归/定时/CI。源冒烟的 inferred 预期必须由人核对，不能仅点击保存便自动升级为可信业务规则。

每次回归明确选择 approved version ID；执行时复制到新的 RunCase，保留来源版本。报告中的一次执行与长期用例是不同实体。用例归档不删除其历史报告，恢复/复制产生明确版本。

新建版本及注册模块的文档 SHA-256 使用统一规范化 JSON：递归排序对象键并保留数组顺序，与存储层 `hashPayload` 一致，避免 JSONB 或传输往返的字段顺序改变影响 hash。历史记录不原地重写或重新计算。

执行绑定使用统一 `RegressionBinding`：保存源 approved version ID、原存储文档 SHA、完整 `RegressionDocument` 与已冻结模块快照。`CaseDefinition.regression`、`Run.executionMode` 和步骤的 `RegressionStepSource` 为兼容 P0 的可选增量；无模式字段按 smoke 解释。回归绑定只由服务器核对受审来源后创建，不接受客户端任意授信。运行中的绑定不可修改，原文档及变量、模块参数和 fixtureRefs 不降为文本 outline。契约准备本身不代表持久化、调度、模块注册或真实回放已经完成。

历史版本的原存储 SHA 保留在 `sourceDocumentSha256`。新运行可另记 `snapshotDocumentSha256`，以规范化 JSON 计算并校验实际快照；旧版本不因历史序列化方式不同而被回写。服务器仍须在同一事务核对源已批准、项目、原存储 SHA 与完整正文，快照 SHA 不能替代来源证明。

## 2. 自有 DSL

机读格式见 `contracts/regression.schema.json`；例子见 `examples/regression.case.yaml`。字段为 kind、schemaVersion、id、name、variables、criteria、steps，以及可选 fixtureRefs。`id` 是项目内 slug，版本号由用例库维护，不是 YAML 中可任意提升的权限。

步骤类型：navigate、click、type_text、assert、ai_action、module。固定动作通过 locator 执行；assert 引用已经冻结的 criterion ID；ai_action 只在获准目标和预算内规划，完成后仍验证指定 criteria。

变量仅允许 `{{env.NAME}}`、`{{vars.NAME}}`，不存在时在执行前报错；不支持 JS 表达式、shell 或读取服务器 env。字符串插值完成后重新验证 URL/定位/类型。密钥不能作为普通变量拼到 prompt、URL 或日志，认证使用 AuthProfile/CredentialBroker。

module 引用 `name@version`，由已注册受审模块解析；引用及步骤来源最多 131 字符，容纳 120 字符模块名、`@` 与 PostgreSQL integer 版本。最大嵌套深度 8，递归环拒绝，所有子步骤共享预算。不提供任意代码插件。fixtureRefs 指向 owner 批准的数据准备/清理模板，未知模板或版本报错。

YAML parser 禁止自定义可执行 tag，限制 alias/深度/大小，拒绝未知字段和危险对象键。导入验证后形成 draft，不能直接执行未经审查的业务写入。格式升级有显式转换与版本记录，不宣称直接兼容 Momentic YAML。

## 3. P1 API 增量（实现时并入 OpenAPI）

| 接口 | 请求与响应要点 |
| --- | --- |
| GET/POST /projects/{projectId}/saved-cases | 分页列表；创建输入 document 或 sourceRunCaseId（二选一），响应 SavedCase+draft version |
| GET /saved-cases/{caseId}/versions | 不可变版本、document/hash、reviewStatus、作者和时间 |
| POST /saved-cases/{caseId}/versions | expectedVersion+document；创建 draft，不覆盖 approved |
| POST /saved-case-versions/{versionId}/review-preview、/review | 显示 criteria/动作/风险差异；通过同样的人确认绑定机制批准或拒绝 |
| POST /regression-runs | projectId、caseVersionIds、environmentId、authProfileId?、budget?；返回同一 Run DTO，跳过自主探索 |
| POST /projects/{projectId}/regression-modules | operator/owner 注册不可变 JSON 模板 draft；name、document、expectedVersion?；返回 RegressionModuleRecord |
| GET /projects/{projectId}/regression-modules | 分页列出全部版本；按 name ASC、version DESC 排序 |
| GET /projects/{projectId}/regression-modules/{moduleName}/versions | 按 version DESC 分页查询；模块名称中的斜杠须 URI 组件编码 |
| POST /projects/{projectId}/regression-modules/{moduleName}/versions/{version}/review-preview | owner 生成专用复合键预览，包含 documentSha256、决定、理由、差异、风险、300 秒确认 Token |
| POST /projects/{projectId}/regression-modules/{moduleName}/versions/{version}/review | owner 原子消费同 actor/目标/版本/正文/决定/理由的 Token；只允许 draft→approved/rejected |
| GET/POST /projects/{projectId}/schedules | name、cron、timezone、runTemplate、overlapPolicy、missedPolicy、enabled |
| PATCH /schedules/{scheduleId} | expectedVersion+变更；更新不改变已创建运行快照 |
| POST /schedules/{scheduleId}/run-now | 使用同模板和权限，生成独立 run；仍受重叠/额度政策 |
| POST /projects/{projectId}/api-keys；POST /api-keys/{keyId}/revoke | owner/operator 获得不超过自身权限的 scope；明文 token 只在创建时返回一次 |
| GET /runs/{runId}/cache-stats | hit/miss/invalidated、解析方式、节省的模型调用与实际耗时 |
| GET/POST /saved-cases/{caseId}/repair-proposals | 原失败、建议 diff、验证记录和 proposed version；不自动发布新预期 |

SavedCaseVersion：id、caseId、version、document、sha256、reviewStatus(draft/approved/rejected)、createdBy、createdAt、reviewedBy?。这些接口目前是明确增量规格，不属于当前已生成的 P0 HTTP 契约；T10/T11/T12 owner 开发前补入生成器并校验，不能让不同 agent 各自确定字段。

用例审查预览请求使用 `ReviewPreviewInput`：`expectedVersion` 指 SavedCaseVersion 的版本号，另有 `decision`（approve/reject）与非空 `reason`。响应镜像这三项，并绑定演员、目标版本及文档 hash、300 秒有效期和一次消费。确认提交须使用同一内容；改变决定、理由、目标或版本后须重新预览。文档/hash 与历史审批元数据不可覆盖，当前基线只能指向同项目、同用例的已批准版本。

模块管理契约使用 `RegressionModuleRecord`（原六个快照字段加 nullable 作者、创建时间、审查人与审查时间）；执行绑定继续使用原 `RegressionModuleVersion`，历史缺失的审计元数据不回填为当前演员或时间。新建同名版本须提供当前最高版本 `expectedVersion`，省略或 0 仅用于首次创建；并发请求须串行核对，冲突返回 409。模块名不允许空段、`.` 或 `..` 整段，版本上界为 PostgreSQL integer 的 2147483647。分页沿用 Base64URL offset 游标，排序确定，但并发新增可能使页面位移。

模块注册只做模板语法、断言引用和受审子模块拓扑校验，不求值未绑定的 `vars`/`env`；非空 fixtureRefs 保持拒绝。注册模板自身占未来调用栈的一层，总模块深度最多 8，展开普通步骤最多 100。入队仍用实际环境、参数、origin 和 `budget.maxActionsPerCase`（默认 12，上界 30）完整编译，不因模板注册成功而获得运行授权。上述模块 API/UI 正在实现，契约生成与校验通过不代表运行验收通过。

## 4. 定时语义

T11 定时调度已接入 API 和 API 进程每 30 秒的调度轮询。提供
`GET/POST /api/v1/projects/{projectId}/schedules`、
`PATCH /api/v1/schedules/{scheduleId}`、
`POST /api/v1/schedules/{scheduleId}/run-now` 与
`GET /api/v1/schedules/{scheduleId}/occurrences`。
目前 Cron 支持**五段数字 POSIX 表达式**（分钟、小时、月内日、月份、星期；
支持 `*`、范围、步长和列表），通过 IANA timezone 使用本地墙上时钟匹配。
持久化去重键避免多副本重复调度与 DST 重复小时的双重执行。
运行日志保留 UTC 计划时刻、本地计划时刻、计划版本、状态和创建的 Run ID。
模板为普通冒烟 RunCreate 或明确选择已审查 caseVersionIds 的
RegressionRunCreate；不支持未审批的回归版本。每次 occurrence 冻结模板，
后续计划编辑不更改既有 occurrence。真实 PostgreSQL 专项联调已覆盖创建、
版本修改、触发、去重、重叠阻断与历史查询，但不等同真实模型 G3 验收。

Schedule 存 project/actor、模板版本、cron、IANA timezone（默认 Asia/Taipei）、环境引用、用例版本、预算、overlapPolicy、missedPolicy、enabled 和 version。模板只允许 smoke 或 approved regression，不启动通用编程代理。

每次 occurrence 独立生成 run，实际 UTC 和计划本地时刻均记录。唯一键避免重复触发；DST 缺失时刻跳过，重复本地时刻只执行一次，T11 必须固定并测试 parser/tzdata 行为。

默认 overlapPolicy=skip，记录上一次尚未结束而跳过；可配置 queue，但每个 schedule 最多一个等待 occurrence。默认 missedPolicy=skip，可选 catchup_one，仅补一个获准时间窗口内的错过项，禁止服务恢复后补几千次。

SavedCaseVersion 固定；每次 occurrence 使用当时仍有效的环境/认证/模型配置并冻结其版本。被删除、撤销、未审查或权限丢失时 setup_failure，不默默换账号或匿名运行。修改 Schedule 只影响后续 occurrence。

## 5. CLI 与 CI

T11 已新增 CLI 基础实现 `apps/cli/localqa.mjs`，命令包括 smoke、run（获准的固定回归版本）、status、stop、report；详见 `apps/cli/README.md`。API Key 只在创建时返回明文，使用时从受保护文件或环境读取，不可传入常规命令行参数；支持项目/环境、等待与轮询、JSON 输出及报告 JSON 本地存档。**尚未实现** CLI 下载 Artifact 二进制、完整 Schedule 运行器和全部 CI 使用场景验收。

现有 CLI API Key 的 scope 为 runs:create、runs:read、reports:read、runs:cancel；按项目绑定，不授予平台管理、secret reveal、人审、SSE 或下载权限。仅保存 key hash，可撤销/过期，使用时重新检查发行人状态与项目权限。SSE 与下载的 Key 认证尚未开放，不得把有读取报告权限误当作拥有 Artifact 二进制读取权限。

退出码：0 表示选定用例全部通过且无阻塞/不确定/未执行和关键证据缺失；1 为已判定业务/技术条件失败；2 为设置、基础设施或覆盖不完整；130 为用户取消。运行 completed 本身不能退出 0。影响门禁的 policy 由项目 owner 配置并版本化，AI 分类不能直接覆盖。

## 6. 缓存和修复

T11 Web 已提供「定时回归」项目级页面，可创建、版本化编辑、
启停、立即运行、查询执行历史并跳转对应 Run 工作台。
已与真实 Schedule API 对接并通过 Web 生产构建；尚未完成真实浏览器
交互及长期多实例运行验收。

T12 修复建议草稿的读取与创建 API 已接入
`GET/POST /api/v1/saved-cases/{caseId}/repair-proposals`。
建议必须关联同项目、同获准回归用例来源的已确认且独立复现的缺陷；
建议只作为 `draft` 入库。Owner 可通过
`POST /api/v1/saved-cases/{caseId}/repair-proposals/{proposalId}/review`
人工认可或驳回建议，必须保留审核理由、演员与时间；
PostgreSQL 触发器强制建议正文不可变，不允许重审覆盖。
对应 Web 用例详情页面已增加草稿、建议历史与人工审核区。
此处的 `approved` **仅代表建议被认可**，不自动创建或批准新的
SavedCaseVersion，不代表候选修复在真实浏览器中经过了成功验证。
获准建议现可调用
`POST /api/v1/saved-cases/{caseId}/repair-proposals/{proposalId}/candidate-version`
提交一个**手动编写的完整有效 RegressionDocument**，生成关联
`repair_candidate_drafts` 的独立 `draft` SavedCaseVersion；
`GET` 同路径可以查询候选版本。须匹配最新的 case 乐观版本和建议的
预留版本号，且内容不可与当前获准基线相同；原文字 diff 永不被当作
可执行转换指令。候选的验证状态固定为 `pending`，不自动通过、
不自动提交新版本审批、不修改基线。Web 用例详情页支持编辑候选 JSON
及追踪其草稿版本。独立执行验证现已接入，仍不自动审批或替换基线。
`POST /api/v1/saved-cases/{caseId}/repair-proposals/{proposalId}/verifications`
创建待验证任务；同一路径 GET 查看验证历史。Web 可发起并查看验证状态。
Worker 通过独立无凭据 Chromium Context，以 `non_submitting` 权限执行
有限的确定性 navigate/click/type_text/assert，不允许 AI、模块或 fixture；
执行结果绑定候选版本 SHA256、新快照指纹、技术断言与状态。
018 迁移还阻止没有独立通过记录的候选版本得到人工批准；通过后仍须
依照既有两阶段版本审批，不会自动覆盖当前获准基线。

T13 可信结果写入：019 迁移**撤销 localqa_app 对候选验证结果的 UPDATE
权限**；应用用户只能提交验证请求及读取验证记录。Worker 必须使用
`localqa_worker` 角色和 `worker_project` 隔离范围，领取任务时绑定
`worker_id`、有效租约和递增的 `fencing_token`，只有当前持有者可在
租约内记录成功/失败/不确定结果。非法状态跃迁、跨 Worker 写入、
身份/哈希篡改和过期令牌一律被数据库拒绝。过期执行仅允许由项目作用域的
Worker 标为 `VERIFIER_INTERRUPTED`，不自动重试可能产生副作用的动作。
原 018 版本已完成或执行中的历史记录会在迁移时降级为不确定，
保留 `legacy_result` 供审计；**历史通过不再可用于批准新基线**。
PostgreSQL18+Chromium 联调覆盖升级前旧记录失效、Owner 伪造、其他
Worker 越权、旧 fencing token、独立验证仍通过以及基线保持 draft。
已覆盖数据库后端断连后的真实 Worker 证据事务回滚和租约到期恢复；
仍未开展长期多 Worker 进程异常退出的稳定性压测。

T13 第二阶段 020 迁移为候选验证增加仅 Worker 可写、完成后不可更新/删除的
`repair_candidate_evidence`。每个已经完成的步骤记录按项目、候选版本、
验证任务、`fencing_token` 和步序隔离的脱敏 BrowserSnapshot、SHA256、
断言结果；每次断言另外保存 **AES-256-GCM 加密的 PNG 截图**，使用
项目 ID、证据 ID、用途作为关联认证数据，截图大小限制为 1 MiB。
所有证据与最终结论 **同一 PostgreSQL 事务提交**。没有对应的、内容匹配
的正向截图断言，就无法将验证标为 `passed`，更无法批准候选版本。
Web 仅对 Owner 提供“查看持久化步骤与截图”，截图由受权 API 解密后返回，
校验 SHA256 和 PNG 文件头，并禁止缓存；普通项目成员不能读取证据。
截图仅对输入框、可编辑区域及显式敏感标签执行遮罩，其余页面仍可能包含
业务敏感信息，因此截图密文也应纳入数据库备份与访问控制。
021 迁移已补齐证据保留期与安全清理；仍需生产级持续运行验收。
PostgreSQL18+Chromium 专项还模拟租约到期后 Worker 消失：新 Worker
只将原任务标为 `VERIFIER_INTERRUPTED / inconclusive`，增加 fencing token，
不重放浏览器动作。已使用真实登录会话访问 Owner 证据 API，确认
未登录被拒、PNG 解密后的 SHA256 完全一致、响应禁止缓存。

T13 最后阶段 021 迁移新增 **90 天证据保留期**：
项目受信 Worker 每小时最多清理 100 条已完成且超过 90 天的验证步骤证据，
并保留 `repair_candidate_evidence_receipts`（候选版本、验证任务、步骤、
快照及截图 SHA256、历史截图大小、清理时间）；截图密文及原始步骤快照被删除。
所有清理由数据库 `SECURITY DEFINER` 函数执行，硬性校验
`localqa_worker`、Worker ID、project scope、完成状态与最短保留期；
普通 Owner 不能直接删除或绕过清理条件。清理操作每次至多处理
100 条，执行发生故障时收据与删除同事务回滚。
审批硬约束仍依赖**未过期、真实保存的正向断言截图**；如果已通过的
候选草稿一直未提交审批，90 天后也需重新验证才能获得批准。
历史审计收据不会使旧验证重新获得授权。
GET 证据列表融合当前记录及已清理收据，Web 显示“已到期清理”；
过期图片访问返回不存在，已清理内容不能被 API 还原。
测试使用独立 PostgreSQL18 超级用户修改**仅测试库**的完成时间，
验证新鲜证据不清理、90 天后的加密截图删除、哈希保留、授权隔离、
重复清理幂等、旧候选批准拦截。
还通过 `pg_terminate_backend` 实际断开**候选独立 Chromium 验证结束后**
进行结果提交的数据库连接，确认事务未产生伪造通过；连接池恢复后，
租约到期记录只能改为 `inconclusive/VERIFIER_INTERRUPTED`，
不会重新执行可能有副作用的浏览器操作。
数据库连接等待被限制，断连映射稳定的 `SERVICE_UNAVAILABLE` 错误。
截图遮罩扩展至显式私密标签和常见密码、Token、邮箱、账号字段；
**此为启发式遮罩而非完全 PII 检测**，其余业务敏感图像仍需依赖页面
标签、授权读取与加密备份政策。

022 迁移对证据保留收据进一步执行隐私最小化：迁移时清空既有收据的
`display_url` 和用户自定义的 `criterion_id`，新增数据库 CHECK 约束
防止重新写入这些可能含有个人标识的字符串，
重定义清理函数仅保留不含 URL 的不可逆哈希和归属 ID。页面 URL
可能包含个人标识或机密业务编号，不能随 90 天过期证据继续存档。
Owner 查询已清理收据时不再得到历史页面地址。
T13 Worker 收到 SIGTERM/SIGINT 时还会对当前候选验证发送取消信号，
停止后不再领取新的候选任务。能够提交最终结果时标为
`WORKER_SHUTDOWN / inconclusive`；如果进程被强杀或数据库同时断连，
仍由持有 fencing token 的恢复扫描在租约到期后标为
`VERIFIER_INTERRUPTED / inconclusive`，不自动重放业务动作。

T12 已引入基于 PostgreSQL 的 **role + 精确 name** 回归定位提示缓存，
存储经哈希处理的静态定位指纹（不保存旧快照/NodeTarget/旧 pass）；
key 隔离项目、获批准用例版本及哈希、步骤来源、具体页面地址、环境、
认证和策略版本。Worker 每次命中仍记录新的浏览器快照，
验证当前主框架目标唯一、可见、可操作，并重新经过标准动作授权。
缓存命中路径额外调用 Playwright 进行当前页面元素身份、ARIA role/name、
唯一性和操作状态校验，而不是相信旧快照中的 NodeTarget。
不满足这些条件时会失效并用原用例定位器重试，绝不复用旧结论。
`GET /runs/{runId}/cache-stats` 读取实际累计计数，未测量的
`savedModelCalls`/`savedMs` 明确保持为 0。
缓存 TTL 为 7 天；当前只覆盖上述角色定位器，不能当作完整路径缓存。
真实 Chromium 测试已验证跨不同浏览器上下文、重复匹配、
隐藏元素、语义变化及快照陈旧的拒绝路径。
整条 PostgreSQL18+Worker+Chromium 回归已实测三次：首次 miss、第二次 hit，
第三次模拟重复同名按钮时 invalidated 并拒绝动作。测试中同时修复了
Worker 异步执行结束前关闭 BrowserSession 和 Windows 截图 file URI
格式错误这两处真实缺陷。模型调用量及执行时间的节约尚未量化。

缓存保存定位/获审执行路径、语义信号及相关上下文，不保存过去的 pass。包含项目、环境、origin、角色、用例/步骤版本、相关数据指纹、策略和解析版本；特定业务对象不可仅凭相同按钮文案混用。

每次命中验证唯一性、语义、可操作性及后置条件；失败记录 invalidated，再有限重定位。路径分支按当前条件判断；中途失败后的恢复路径不能直接保存成从初始状态可重放的完整路径。

修复建议包含 root cause 分类、原失败、最小变更和新执行证据，形成 draft version。定位/等待修复与改预期分开；减少断言、忽略金额/权限、改变业务路径须人审。历史失败和建议失败都保留。

## 7. 获准写入和数据治理

P1 approved_workflows 需 owner 批准的用例/工作流版本、数据边界及 hooks。该批准可作为后续运行的持续授权，范围不变时不反复询问；自主生成的未知写入没有同等权限。

准备/清理使用注册模板，记录请求、资源 ID、唯一标识、修改前基线及完成情况。默认创建自己的数据；清理只命中资源账本和标识，不凭模型推测记录属于本任务。发生未知动作或清理失败，保留 manual_required 和可审查材料，不在后台扩大删除范围。

P1 仍不自动向禅道/Slack/邮件提交 Bug 或消息；外部集成属 P2，需具体对象、内容、明确授权和审查机制。
