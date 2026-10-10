# T14 真实模型 Gate 开发记录

**状态：G3Passed=false；P0Passed=false。** 本轮无真实提供方调用。

## 发现和修复

1. BoundModel.call 的模型响应超时从 1 秒调整为 30 秒；保留硬性超时和 Worker 租约取消约束。
2. BoundModel.call 的网关输入限制从 4,000 提高到 12,000 Token，解决 json_object 的完整结构化输出约束导致发送前 BUDGET_EXCEEDED 的问题。运行预算仍由冻结的 RunConfig、模型调用数和 Token 配额约束。
3. 策略分发器现在将执行层的 POLICY_DENIED / TARGET_NOT_ALLOWED 标记为拒绝，而非把它们作为 Worker 初始化故障；不吞掉其他异常，也不授予点击权限。Worker 的探索阶段增加 modelActionDenials 和警告。

## 实际验证命令

在 E:\AI\momentic 下执行：

    pnpm --filter @localqa/agents --filter @localqa/orchestrator --filter @localqa/worker build
    pnpm test:t14-wire

这个专项在独立 PostgreSQL 18 中运行真实 Worker、真实 Chromium、中文测试网页、受限动作授权、模型调用账本与预算核销、截图 Artifact、用例记录和终态。
OpenAI 兼容响应是**模拟供应商 HTTP 响应**，不是云模型；第一条响应刻意延迟 1.3 秒以防模型超时回归。
模拟模型提出的非授权点击被拒绝，数据库不写入对应动作授权；不把这次拒绝视为基础设施失败。
测试仅清理自己的容器、临时文件和虚拟 Key，不访问现有业务服务。

## 真实 G3 尚未满足

目前本机没有可用的 OPENAI_API_KEY / DEEPSEEK_API_KEY / LOCALQA_MODEL_API_KEY 和正式数据库连接环境变量，也没有运行中的 LocalQA 服务。此前的模拟结果不能作为 G3 Gate 证据。

后续通过 LocalQA 模型管理界面配置获准的 HTTPS 供应商、Model ID、加密存储的 Key、responseFormat 并验证能力；对项目分配冻结模型版本，在独立 fixture 运行真实 Worker。
需要从 model_requests 和预算记录核对真实供应商调用与用量、动作授权、截图与断言结果、失败独立复现、报告及模型版本。健康和故障质量样本规模按 docs/04-validation.md 执行。
真实模型返回格式无法解析、缺少证据、未复现或能力缺失均不得记录为通过。
