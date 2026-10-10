# T18 · DeepSeek 两轮真实 DOM 决策与独立缺陷复现

日期：2026-10-09。执行位置：Windows Runner `E:\\AI\\momentic`。

## 交付内容

- 新增 `pnpm test:t18-wire`（G2 模拟供应商响应）与
  `pnpm test:t18-real`（G3 真实 DeepSeek）。
- 基于原 T17 冻结人审回归，扩展为一个 **maxToolCalls=2** 的
  `ai_action`。在预先批准的固定订单备注输入后，AI 第一次根据
  DOM 点击“预览订单”，第二次必须重新观察 DOM 才能点击动态出现的
  “确认预览”。最终是否满足预期由固定 `data-testid=complete-marker`
  的独立技术断言判定，不采用模型自评为 Oracle。
- 真实浏览器使用 localhost 静态测试站、独立 PostgreSQL 18、
  Worker 与 Chromium。所有点击经既有 ActionIntent、冻结审批来源、
  范围及预算校验；测试没有连接外部业务网站或提交真实订单。
- 默认只读加载 Windows Runner 既有 Pi DeepSeek 凭据。没有向代码、
  文档、环境模板或日志写入任何 API Key。Moresec 备选服务未测试。

## 实际验收结果

| 运行模式 | 测试场景 | 请求/结算 | Chromium 动作 | 授权点击 | Artifact / Attempt | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| G2 模拟协议 | 正常 | 2/2 | 9 | 2 | 1 / 1 | passed |
| G2 模拟协议 | 故障+复现 | 4/4 | 18 | 4 | 2 / 2 | issue_found × 2 |
| G3 真实 DeepSeek | 正常 | 2/2 | 9 | 2 | 1 / 1 | passed |
| G3 真实 DeepSeek | 故障+复现 | 4/4 | 18 | 4 | 2 / 2 | issue_found × 2 |

G3 模型返回 `reportedModelId=deepseek-flash`，
`usageSource=reported`；两场景 `Run=completed / complete`。
故障版本的第一个 CaseAttempt 与 Reproducer 使用不同
Chromium Context，具有独立证据；数据库 Finding 断言为
`confirmed`。两场景所有动作均绑定受审批的 RegressionStepSource。
上述数据来自两条实际 G3 执行日志，不与 G2 计数累加。

## 复现

```sh
pnpm test:t18-wire    # G2：两条隔离 PostgreSQL18/Chromium 场景
pnpm test:t18-real    # G3：Pi 已授权 DeepSeek，两条真实模型场景
```

两种测试均使用独立临时容器与浏览器资源，完成后清理。
本轮没有 commit、push、部署或修改用户现有 Pi 配置。

## 验收边界

- 本阶段新增的是 T18 **真实业务交互能力验证场景**，生产运行器
  已存在的受审 `ai_action` 多轮执行实现未被替换。
- 两个动态按钮在本地 fixture 内，并不代表已授权生产系统
  的订单、付款、发送或其他真实写入。
- 只验证 2 次模型决策及一个明确冻结的业务 Oracle，
  尚未满足 `docs/04-validation.md` 定义的多样本质量基线。
  不宣称全平台 G3/P0/G5 放行、模型长期 SLA 或任意网页探索准确率。
