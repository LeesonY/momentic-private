# T17 · DeepSeek 真实模型业务交互 G3 验收

日期：2026-10-09。Runner 项目：`E:\\AI\\momentic`。

## 已确认

- 服务商：DeepSeek 官方 API，OpenAI Chat Completions 协议，
  `https://api.deepseek.com`。
- 模型：`deepseek-flash`。官方已有模型重命名，不能再以旧
  `deepseek-chat` 作为稳定生产模型别名。
- 凭据路径：Pi 已授权的本机 `.pi/agent/auth.json` 中
  DeepSeek 项，只读加载；测试脚本不硬编码真实密钥。用户本轮提供
  的 DeepSeek 密钥单独验证了基本接口可用，但不宣称其与 Pi
  本机凭据是同一条记录。
- 执行环境：随机端口本机静态/脚本式业务 fixture，一次性
  PostgreSQL 18 容器、Worker 和 Chromium。无外部表单提交。

## 两条真实模型专项（两条均通过）

| 结果 | 正常状态 | 错误状态及复现 |
| --- | --- | --- |
| API 实际请求 / 预算结算 | 1 / 1 | 2 / 2 |
| Chromium 已审计动作 | 7 | 14 |
| 成功授权点击次数 | 1 | 2 |
| Artifact | 1 | 2 |
| CaseAttempt | 1 | 2 |
| Verdict | passed | issue_found + issue_found |
| Finding | 不产生错误 Finding | confirmed |
| Run | completed / complete | completed / complete |
| reportedModelId | deepseek-flash | deepseek-flash |

执行动作：首先通过已批准 `type_text` 输入固定值
`qa-1729`；模型读取真实 DOM 快照，选择
`查看校验结果` 按钮；服务端按冻结来源、授权、预算和
快照归属校验后允许 `click`，真实 Chromium 更新页面状态；
技术断言通过/失败由页面中固定 Test ID 的 DOM 观测及证据决定。

故障测试复现阶段再次使用新的 Chromium Context 和独立 Artifact。
两次判定都是 `issue_found`，Finding 确认为 `confirmed`。
模型参与真实决策，但故障 Oracle 来自事前已批准的业务规则。

## 复现方式

```bash
pnpm test:t17-real     # 实际 DeepSeek，正常 + 故障
pnpm test:t17-wire     # G2 模拟协议，不计入 G3
pnpm test:t17-moan2    # 原 Pi moan2 协议通道
```

这些命令都不提交/推送/部署，并清理其独立的临时容器及数据。
本阶段尚未评估真实企业系统提交写入、广泛探索自主性、
负载压测和长期服务可用性。
