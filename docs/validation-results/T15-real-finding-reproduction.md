# T15 · 真实模型 + 有来源的缺陷识别 + 全新 Context 独立复现

## 结论

**T15 专项验收 1/1 通过**。在获授权的 Windows Runner 上，
运行 `pnpm test:t15-real`；完整隔离 PostgreSQL18、Coordinator、
真实 Pi `moan2 / mofree-m1`、Worker 和 Chromium。

本测试的原始需求（运行输入 `brief`）明确要求：结账结果页出现可见的
`data-testid=checkout-success`。隔离故障页返回 HTTP 200，但只呈现
`data-testid=checkout-error`、订单创建失败文字，并未呈现成功标记。
服务端将来源为 `user_spec`、`sourceRef=brief:SHA256` 的标准在开始
运行前冻结为 CaseDefinition。**业务预期不是让 AI 凭空编造**。

## 实际测试结果

| 观察项 | 实际值 |
| --- | --- |
| 真实供应商请求 | 11 次 |
| `model_requests` 预算结算 | 11 / 11，来源 reported |
| 配置模型 ID | `mofree-m1` |
| 供应商响应模型 ID | `MiniMax-M3`（不等同于已鉴定的底层实现） |
| 真实 Chromium 动作 | 8 次，业务按钮点击 0 次 |
| `artifacts` | 4 条 |
| `case_attempts` | 2 条 |
| 两次持久化 `verdicts` | `issue_found`、`issue_found` |
| Finding 的阶段变化 | `suspected` → `confirmed` |
| Reproduction | `reproduced`，`fresh_context=true` |
| Context 独立性 | 2 个不同 `context_id` |
| 证据独立性 | 首次与复现的 `evidenceRefs` 不重叠 |
| 标准一致性 | reproduction 和 finding 的 `criteria_hash` 相同 |
| 模型参与阶段 | coordinator、explorer、planner、executor、assertion、reproducer |
| Run 结束 | `completed / complete` |

这些指标从**实际数据库行**与运行中真实 Browser Manager 获取。
测试在最后断言所有关键条件，而不是仅检查 Run 的最终状态。
测试的临时容器、临时库、Artifact 测试目录会自动清理；
本报告保留无密钥、无业务数据的验收指标，而不是冒称证据文件永久保留。

## 运行和安全

- `pnpm test:t15-real` 明确开启真模型验收，不会影响
  `pnpm test:t14-wire` 默认模拟线或 `pnpm test:t14-real` 真实正常冒烟。
- 仅从宿主 Pi 配置只读加载现有授权密钥，经隔离 Vault KEK
  加密写入一次性测试 PG，不修改 Pi 配置，不打印凭据。
- 目标是仅绑定 `127.0.0.1` 动态端口的本地 HTTP fixture，
  运行策略 `non_submitting`。不碰业务环境、不部署。

## 能力边界

此次**真正通过的是有固定业务 Oracle 的失败发现与复现机制**。
模型确实参与了全链路决策和断言，但失败依据来自
`user_spec` 和 Chromium 的技术证据；不能证明无规约情况下
AI 能准确推断产品需求，也不能外推到各类真实产品 Bug 的召回率。
复杂交互、未复现时降级、多种不同失败类别、资源中断、权限隔离和
真实生产长期可用性均未完成该专项验收。
