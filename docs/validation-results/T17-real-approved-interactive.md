# T17 · 真实模型：受控表单、AI 按钮选择与状态缺陷复现

## 目标与授权边界

本阶段使用 Windows Runner 现有 Pi `moan2 / mofree-m1`，
供应商响应模型标识 `MiniMax-M3`。运行 `pnpm test:t17-real`
依次执行正常表单与故障表单两个真实模型场景。隔离 PostgreSQL18、
Coordinator、Worker、Chromium 与动态 localhost fixture；
不向任何第三方业务系统提交表单。

普通 Smoke Run 仍只允许导航、观察、截图；**没有开放任意 AI 写操作**。
T17 将 `navigate`、`type_text`、`ai_action` 与固定业务
`element_visible` 标准放入数据库中一次性创建的人审批准回归版本。
所有浏览器动作必须经过 Worker→Coordinator 的租约、预算、最近快照
和冻结回归来源验证，且要经过 BrowserPolicy 检查。
单个 `ai_action` 新增人工审批的 `maxToolCalls` 参数
（可选，1–4；默认保留 4），T17 明确固定为 **1**；
该上限由 Contract 校验后随受批准版本冻结，不依赖模型自然语言理解。

## 本次生产修复

1. `apps/worker/src/regression-ai.ts`：真实模型初次执行过程中重复点击
   同一按钮。修复后向下一轮模型提供 `executedActions` 审计摘要，
   并按可见节点的角色/名称阻断同一目标的重复点击。
2. `docs/build_contracts.py`、
   `apps/worker/src/regression-replay.ts`：
   扩展审批 DSL 的 `ai_action.maxToolCalls`，达到最大次数时结束
   模型动作阶段，进入**独立**的冻结技术断言。模型即使想额外点击也无法越权。
3. `apps/worker/src/index.ts`：已批准的 `test_id` 元素可见性断言，
   在完整、未截断且正常的 DOM 中明确缺失时，应为 `failed`，
   而不是无依据的 `unknown`。SPA 快照可能没有新的
   `responseStatus`，允许使用最近一次成功导航的状态作为健康依据；
   5xx、401、403 页面仍不能伪装成功能缺失证据。

## 真实模型 + 数据库 + Chromium 验证

**正常状态：**冻结输入 `qa-1729` 写入本地文本框，
真实模型依据当前快照点击一次“查看校验结果”，页面出现
`data-testid=complete-marker`。数据库确认点击和输入各执行一次、
所有 ActionIntent 绑定受批准 `RegressionStepSource`，
浏览器截图 Artifact 和 CaseAttempt 保存，技术 Verdict=`passed`。

**故障状态：**完全相同的受批准操作及输入，但测试页故意未更新
状态标记。首次技术 Verdict=`issue_found`，自动产生
`suspected` Finding；Reproducer 在不同 Chromium Context 重放，
再次得到 `issue_found`，Finding 变为 `confirmed`。
该场景的回归步骤结果 `regressionReplay.status=failed`
是**冻结断言真正失败**，并非模型或浏览器基础设施异常。

| 可核对指标 | 正常状态 | 故障状态 |
| --- | --- | --- |
| 真实模型调用及结算 | 2 / 2 | 2–3 / 2–3（不同成功运行） |
| 授权按钮点击 | 1 | 2（每个 Context 各 1） |
| 固定文本输入 | 1 | 2（每个 Context 各 1） |
| 浏览器动作 | 7–8 | 14 |
| 证据 Artifact | 1 | 2 |
| CaseAttempt | 1 | 2 |
| Verdict | passed | issue_found × 2 |
| Finding | 无 | confirmed |

上述结果在测试期间由数据库、审批来源绑定及真实浏览器动作核对。
测试结束会移除一次性数据库、浏览器目录和本地服务，
不将临时证据文件误称为长期归档。
最后一次组合 `pnpm test:t17-real` 两条均通过。
早前一次组合执行的第二条出现模型请求数不足，随后单独复核及最终组合
都通过；因此仍须将外部模型响应波动计入后续可靠性测试，
而不能依据一次成功宣称可用性达到生产 SLA。

## 仍未验证的范围

- 表单在本地只引起 DOM 状态变化，不产生外部业务 POST，
  因此不能代表支付、订单提交或其他有真实副作用的操作得到授权。
- 测试目标、输入与业务 Oracle 是受批准版本提前确定的；
  按钮定位由真实模型决定。不能据此宣称完全未知业务的自主规划、
  任意产品的 Bug 召回率或多用户并发写动作已验收。
- Pi 认证配置只读；没有 commit、push 或 deployment。
