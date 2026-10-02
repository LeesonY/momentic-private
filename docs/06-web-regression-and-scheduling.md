# P1 Web 回归、定时与修复细化

这是主要 Web 功能的后续实现规格，不表示 P0 已实现。P1 仍使用同一浏览器工具、权限、预算、事件、证据和报告，不能另建一套绕过策略的执行器。

## 1. 用例库和版本

从 RunCase 保存为 SavedCase，或导入自有 YAML。SavedCase 为逻辑身份；SavedCaseVersion 为不可变 document/hash、作者、审核状态和时间。每次编辑新建 draft，不覆盖历史；审批后可用于回归/定时/CI。源冒烟的 inferred 预期必须由人核对，不能仅点击保存便自动升级为可信业务规则。

每次回归明确选择 approved version ID；执行时复制到新的 RunCase，保留来源版本。报告中的一次执行与长期用例是不同实体。用例归档不删除其历史报告，恢复/复制产生明确版本。

## 2. 自有 DSL

机读格式见 `contracts/regression.schema.json`；例子见 `examples/regression.case.yaml`。字段为 kind、schemaVersion、id、name、variables、criteria、steps，以及可选 fixtureRefs。`id` 是项目内 slug，版本号由用例库维护，不是 YAML 中可任意提升的权限。

步骤类型：navigate、click、type_text、assert、ai_action、module。固定动作通过 locator 执行；assert 引用已经冻结的 criterion ID；ai_action 只在获准目标和预算内规划，完成后仍验证指定 criteria。

变量仅允许 `{{env.NAME}}`、`{{vars.NAME}}`，不存在时在执行前报错；不支持 JS 表达式、shell 或读取服务器 env。字符串插值完成后重新验证 URL/定位/类型。密钥不能作为普通变量拼到 prompt、URL 或日志，认证使用 AuthProfile/CredentialBroker。

module 引用 `name@version`，由已注册受审模块解析；最大嵌套深度 8，递归环拒绝，所有子步骤共享预算。不提供任意代码插件。fixtureRefs 指向 owner 批准的数据准备/清理模板，未知模板或版本报错。

YAML parser 禁止自定义可执行 tag，限制 alias/深度/大小，拒绝未知字段和危险对象键。导入验证后形成 draft，不能直接执行未经审查的业务写入。格式升级有显式转换与版本记录，不宣称直接兼容 Momentic YAML。

## 3. P1 API 增量（实现时并入 OpenAPI）

| 接口 | 请求与响应要点 |
| --- | --- |
| GET/POST /projects/{projectId}/saved-cases | 分页列表；创建输入 document 或 sourceRunCaseId（二选一），响应 SavedCase+draft version |
| GET /saved-cases/{caseId}/versions | 不可变版本、document/hash、reviewStatus、作者和时间 |
| POST /saved-cases/{caseId}/versions | expectedVersion+document；创建 draft，不覆盖 approved |
| POST /saved-case-versions/{versionId}/review-preview、/review | 显示 criteria/动作/风险差异；通过同样的人确认绑定机制批准或拒绝 |
| POST /regression-runs | projectId、caseVersionIds、environmentId、authProfileId?、budget?；返回同一 Run DTO，跳过自主探索 |
| GET/POST /projects/{projectId}/schedules | name、cron、timezone、runTemplate、overlapPolicy、missedPolicy、enabled |
| PATCH /schedules/{scheduleId} | expectedVersion+变更；更新不改变已创建运行快照 |
| POST /schedules/{scheduleId}/run-now | 使用同模板和权限，生成独立 run；仍受重叠/额度政策 |
| POST /projects/{projectId}/api-keys；POST /api-keys/{keyId}/revoke | owner/operator 获得不超过自身权限的 scope；明文 token 只在创建时返回一次 |
| GET /runs/{runId}/cache-stats | hit/miss/invalidated、解析方式、节省的模型调用与实际耗时 |
| GET/POST /saved-cases/{caseId}/repair-proposals | 原失败、建议 diff、验证记录和 proposed version；不自动发布新预期 |

SavedCaseVersion：id、caseId、version、document、sha256、reviewStatus(draft/approved/rejected)、createdBy、createdAt、reviewedBy?。这些接口目前是明确增量规格，不属于当前已生成的 P0 HTTP 契约；T10/T11/T12 owner 开发前补入生成器并校验，不能让不同 agent 各自确定字段。

## 4. 定时语义

Schedule 存 project/actor、模板版本、cron、IANA timezone（默认 Asia/Taipei）、环境引用、用例版本、预算、overlapPolicy、missedPolicy、enabled 和 version。模板只允许 smoke 或 approved regression，不启动通用编程代理。

每次 occurrence 独立生成 run，实际 UTC 和计划本地时刻均记录。唯一键避免重复触发；DST 缺失时刻跳过，重复本地时刻只执行一次，T11 必须固定并测试 parser/tzdata 行为。

默认 overlapPolicy=skip，记录上一次尚未结束而跳过；可配置 queue，但每个 schedule 最多一个等待 occurrence。默认 missedPolicy=skip，可选 catchup_one，仅补一个获准时间窗口内的错过项，禁止服务恢复后补几千次。

SavedCaseVersion 固定；每次 occurrence 使用当时仍有效的环境/认证/模型配置并冻结其版本。被删除、撤销、未审查或权限丢失时 setup_failure，不默默换账号或匿名运行。修改 Schedule 只影响后续 occurrence。

## 5. CLI 与 CI

计划 CLI：smoke、run、status、stop、report；实现后的命令/安装方式由 T11 交付，当前仓库不含可执行 CLI。key 从受保护配置/环境读取，不能作为常规命令行参数输出。支持 URL/项目/环境、固定用例版本、等待/轮询、JSON 输出和授权材料下载。

CLI scope 至少 runs:create、runs:read、reports:read、runs:cancel；按项目绑定，不授予平台管理、secret reveal 或人审权限。key hash 保存，可撤销/过期；SSE 与下载同样校验 scope。

退出码：0 表示选定用例全部通过且无阻塞/不确定/未执行和关键证据缺失；1 为已判定业务/技术条件失败；2 为设置、基础设施或覆盖不完整；130 为用户取消。运行 completed 本身不能退出 0。影响门禁的 policy 由项目 owner 配置并版本化，AI 分类不能直接覆盖。

## 6. 缓存和修复

缓存保存定位/获审执行路径、语义信号及相关上下文，不保存过去的 pass。包含项目、环境、origin、角色、用例/步骤版本、相关数据指纹、策略和解析版本；特定业务对象不可仅凭相同按钮文案混用。

每次命中验证唯一性、语义、可操作性及后置条件；失败记录 invalidated，再有限重定位。路径分支按当前条件判断；中途失败后的恢复路径不能直接保存成从初始状态可重放的完整路径。

修复建议包含 root cause 分类、原失败、最小变更和新执行证据，形成 draft version。定位/等待修复与改预期分开；减少断言、忽略金额/权限、改变业务路径须人审。历史失败和建议失败都保留。

## 7. 获准写入和数据治理

P1 approved_workflows 需 owner 批准的用例/工作流版本、数据边界及 hooks。该批准可作为后续运行的持续授权，范围不变时不反复询问；自主生成的未知写入没有同等权限。

准备/清理使用注册模板，记录请求、资源 ID、唯一标识、修改前基线及完成情况。默认创建自己的数据；清理只命中资源账本和标识，不凭模型推测记录属于本任务。发生未知动作或清理失败，保留 manual_required 和可审查材料，不在后台扩大删除范围。

P1 仍不自动向禅道/Slack/邮件提交 Bug 或消息；外部集成属 P2，需具体对象、内容、明确授权和审查机制。
