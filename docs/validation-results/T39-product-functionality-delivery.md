# T39 产品功能交付：首次项目创建与 URL 冒烟模型选择

日期：2026-10-10。Windows 项目：`E:\\AI\\momentic`。
方向明确调整为 **完成真实产品功能**，没有进行新的压力/Soak Test。
既有 T17–T38 脏工作区与审计账本全部保留，未提交、推送或部署。

## 已实现的实际业务功能

### FR-003：从空账号项目页创建项目

- 顶部导航提供 **“+ 创建项目”**，仅平台管理员显示；后端
  `POST /api/v1/projects` 的权限校验仍然是最终权威。
- 输入名称、表单约束、提交中禁止重复操作、失败显示原始可用错误。
- 只有服务器真正返回 `Project` 后，才将新项目加入选择器并进入首页，
  不伪造项目 ID 或创建成功消息。
- 无项目时显示独立引导页：管理员可创建项目；普通成员联系管理员授权。
- 切换项目返回首页，避免在旧项目的运行详情中复用新项目上下文；
  退出登录清理客户端当前项目与列表。

### FR-007、FR-011：显式模型选择真正生效

此前首页显示模型选择，但 `HttpApiClient.createRun` 并未将
`modelProfileId` 发到 API；服务器只能选择项目默认或任意授权模型。
T39 已完成端到端协议：

- 修改 `docs/build_contracts.py` 的 `RunCreate` 可选字段，并重新生成
  JSON Schema、OpenAPI、TS 契约、前端 API 适配器；**未手工改生成文件**。
- 运行首页可选“项目默认或授权模型”，也可手动指定本次模型；
  选择随创建运行的正式请求发送，并携带原有 `Idempotency-Key`。
- 服务端先检查项目成员权限，再核实指定的 `modelProfileId`
  必须存在于该项目的 `model_profile_grants`。**全局可见不等于已授权**；
  未授权请求直接 `MODEL_NOT_CONFIGURED`，不会默默改用默认模型。
- 查询模型最新冻结版本，并拒绝 disabled/revoked；未显式指定时
  首选项目默认，否则按授权 ID 稳定选取。五个模型角色绑定实际 ID 与版本。
- 有模型但未经项目授权时，启动仍可被后端拒绝；未来可以新增
  “本项目已授权模型”的只读 API，使 UI 直接筛除不可用选项。

### 修复冒烟首页的不真实/不安全配置

- 初始目标 URL 改为空；无项目时禁止提交，不再使用 `proj_default`
  伪项目 ID。
- 前端配置读取失败时显示阻塞而不是只记 console 警告。
- 真实 API 无模型时明确阻塞并引导配置，**不再声称自动运行 T04 Stub**；
  独立的离线 Mock 演示模式仍按原有显式开关运行。
- 普通 URL smoke 固定 `non_submitting`：不再提供貌似可用的
  `approved_workflows` 下拉选项（服务端原本也没有采用该伪配置）。
- 项目切换时清空旧环境/认证/模型选项，忽略切换后才返回的旧项目
  请求结果；外部模型数据提示依照实际所选/可用模型显示。

## 已完成的功能验证

1. `pnpm --filter @localqa/web test:functional-start` — **通过**。
   真正启动本地 React/Vite + Playwright Chromium，在局域本机拦截
   API fixture 响应，验证“无项目 → 创建项目 → 进入项目 → 选择模型
   → 填写实际 path/query URL → 发起 run → 进入工作台”，并断言
   发出的 JSON 包含真实 projectId、modelProfileId、targetUrl，
   具有幂等请求头且没有不生效的 actionPolicy override。
2. `pnpm --filter @localqa/api test:functional-model` —
   **5/5 通过**。覆盖显式授权、未授权拒绝、冻结版本、
   默认/授权回退、禁用模型与不存在的项目。
3. `pnpm contracts:check` **通过**；`@localqa/contracts`、
   `@localqa/api`、`@localqa/web` TypeScript/Vite 产物构建通过。

以上 Playwright 前端测试使用**隔离 API fixture**，不代表
连接了生产数据库或模型云端，也不是全产品验收。

## 未完成的功能及验收缺口

- `pnpm --filter @localqa/api test` 全量 T06 API/PostgreSQL 集成
  **未通过**：迁移正常，但 Windows 临时 KEK 文件在
  `SecretVault.fromProtectedFile` 的严格保护校验处返回
  `SERVICE_UNAVAILABLE`，所有 14 项测试被前置阻塞。
  这是测试运行环境/密钥文件 POSIX 权限假设问题；**未削弱
  生产密钥保护以绕过**，也不将这些用例计为功能通过。
- **完整 P0 UI→真实 API→PG→Worker→真实模型→报告**端到端
  交付仍需独立验收，包括没有模型授权、部分报告和项目归档场景。
- 项目权限与模型项目授权的完整 Web 配置流程尚未确认；
  全局模型下拉框仍可能显示其他项目未授权的模型，后端会拒绝。
- 用例库、修复建议、报表/ZIP、计划任务、成员权限、环境/认证、
  项目知识和 CLI 页面/API 已有代码入口，但尚未在本次功能盘点中
  逐项验证用户操作闭环，**不能笼统宣称所有功能完成**。
- 正式 G3 与 P0 签核仍是 **未放行**。本阶段不延伸进行 Soak
  或大量重复压力样本，而转向未完成产品业务功能。

## 下一开发顺序

优先完善首次配置向导（项目授权模型、环境与认证）、项目归档与
权限交互、执行报告/导出的真实 Web 用户旅程，再逐页封闭 P0
业务流程。每项完成后只做该功能必要的验收，暂不安排压力测试。
