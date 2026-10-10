# T14 模型链路联调进展（非 G3）

## 验收分级

- **G3Passed: false**；尚未获得授权使用的真实供应商模型配置，也未对外部模型进行调用。
- **G2 provider-wire integration**：使用独立 PostgreSQL18、真实 Worker/Coordinator、
  Chromium 和由测试进程拦截的 OpenAI-compatible HTTP 模拟响应。测试供应商并非模型。
- 入口：`node --test apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs`
  （需 Node 24、pnpm 工作区构建和 Docker Desktop；仅启动自建临时 PostgreSQL
  容器，不连接业务数据库）。

## 本次修复

1. `packages/orchestrator/src/model.ts` 的 `BoundModel.call` 超时由 **1 秒**
   更正为**30 秒**，保持租约取消和有限成本控制。此前正常的长响应会被误报为超时。
2. `packages/model-gateway/src/gateway.ts` 的 `json_object` 决策提示曾重复发送
   完整约 21 KB 的 ToolCall 定义，令 Worker 在 4000 输入 Token 限额前置拒绝，
   根本没有向提供方发请求。现在发送简明的决策结构和当前角色工具参数；
   **完整本地 AJV/ToolCall 校验、工具权限和动作授权没有移除**。
3. Worker 探索阶段即使保持技术冒烟成功，也单独记录
   `modelActionDenials` 及对应警告，防止把被拒的模型动作混同为已执行动作。

## 有效范围

- 模拟协议第一条响应故意延迟约 1.3 秒，以验证 `BoundModel.call` 实际
  经过 1 秒超时边界，仍能结算 `model_requests`。
- PostgreSQL 持久化的模型调用、预算结算、Chromium 导航、截图 Artifact、
  CaseAttempt 和真实 Run 终态须一致。
- 第二个 Run 尝试让模型提出新快照所指向的中文按钮 click，
  普通 `smoke` 并无点击授权；检查**没有实际点击/授权意图**，
  同时在 explorer job 记录明确的拒绝数。独立技术冒烟仍可通过，
  但这不意味着模型建议的点击成功。
- 测试中的模型结果由 `fakeTransport` 返回，不能作为模型推理质量、
  未知页面可靠性、G3 失败复现精度或模型费用的证据。

## 仍缺的 G3 门槛

- 在受控项目里**通过受保护的 ModelProfile / SecretVault** 安装并探测
  一份获准真实模型（若供应商只支持 `json_object`，需配置此响应模式）。
- 用真实模型在同一个被授权的 fixture 运行，保存冻结模型版本、
  执行时延、供应商 reported token、预算流水、动作授权、截图证据和失败分类。
- 对明确有据可查的错误进行全新 Context 独立复现；确认的 Finding 必须
  具备相同 oracle 的复现引用。不得用这次本地模拟响应替代真实模型成绩。
- G3 未通过前，不得将 `P0Passed` 或 `G3Passed` 更新为 `true`。
