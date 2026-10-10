# T17 · 已审批业务交互与 AI 动作边界

## 功能和安全边界

LocalQA 普通 Smoke Run **不能**通过 AI 模型任意点击或输入。受控交互
必须进入已审批的 `RegressionDocument`：服务端校验保存版本的
`approved` 状态、SHA256 和冻结编译计划；`type_text` 步骤使用
人工审批的固定文字，后续 `ai_action` 在限定目标、最大动作数和
快照新鲜度下由模型选择要点击的真实 DOM 控件。每个动作先落
`action_intents`，检查 fencing/预算/来源，再经 Chromium 执行。
冻结的 DOM Criterion 和独立 Artifact 决定 Verdict。

## 本轮已经完成的隔离验收

命令：`pnpm test:t17-wire`（**G2 模拟模型协议**，不是 G3）。
执行环境为一次性 PostgreSQL18 容器、真实 Worker、真实 Chromium、
本地受控订单备注页面；模拟模型响应只用于真实模型上游不可用时的
协议边界验证。

| 场景 | 模型协议调用 | 表单输入 | 审批点击 | Artifact | 最终 Verdict |
|---|---:|---:|---:|---:|---|
| 正常状态更新 | 1 | 1 | 1 | 1 | passed |
| 更新后标记不一致 | 2 | 2 | 2 | 2 | issue_found / issue_found |

故障场景通过独立 Chromium Context 复现缺陷，首次和复现
证据各自持久化；所有动作必须有冻结 RegressionStepSource。
按钮为 `type=button`，表单禁止真正提交，不产生外部写请求。
正常与故障场景合计两条专项测试均通过。

## 真实 AI：G3 已通过（2026-10-09）

用户允许选择新的 DeepSeek 官方服务或者另一 HTTPS 服务商。
官方文档当前采用 `deepseek-flash` 模型；旧
`deepseek-chat` 别名已退役。用户新提供的 DeepSeek 凭据
在独立最小 JSON 请求中取得 HTTP 200；随后实际 T17 端到端测试
**使用远程 Pi 中既有的 DeepSeek 凭据**（不假设它与新提供的值一致），
避免把任一明文凭据带进源码/日志。

- `pnpm test:t17-real`：默认使用远程 Pi 中既有的
  DeepSeek 凭据和 `deepseek-flash`，依次跑正常和故障两场景。
- `pnpm test:t17-moan2`：保留原 `moan2 / mofree-m1`
  Anthropic Messages 兼容性验收。该服务本阶段连接不稳定，
  不以 DeepSeek 成绩替代其可用性判断。
- `pnpm test:t17-wire`：继续明确标注为 **G2 模拟协议**。

| 真实 DeepSeek 场景 | 真实请求/结算 | 浏览器动作 | 授权点击 | Artifact | Verdict |
| --- | --- | --- | --- | --- | --- |
| 正常业务状态 | 1/1 | 7 | 1 | 1 | passed |
| 业务状态错误 | 2/2 | 14 | 2 | 2 | issue_found × 2 |

故障测试断言最终 Finding 为 `confirmed`，首次与复现的
Chromium Context 不同、证据分离；全部交互均指向已审批、
被版本与 SHA256 冻结的 RegressionStepSource。
供应商返回模型 ID `deepseek-flash`，实际浏览器凭证为独立的
PostgreSQL18 和 Chromium 执行记录，非模型自称通过。

## 范围限制

本阶段验证本机模拟的无提交业务 UI 更新，尚未授权测试实际
服务端写入、真实订单创建或生产业务系统；不能据此宣称 AI
具有任意网页自主操作权限。真实模型的复杂业务表现和可靠性
仍未验收。
