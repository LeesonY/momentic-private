# T19 · 认证后真实模型探索主链路

日期：2026-10-09。Windows Runner：`E:\\AI\\momentic`。

## 目标与实现

原认证 PG/Chromium 用例通过人工调用
`withApprovedBrowserAuth` 的回调模拟探索完成，因此只能证明
认证状态导入辅助函数。此次将该步骤替换为真正的第二次
`Worker.once()`：在独立 Chromium Context 中，由 Coordinator 冻结
当前认证状态 ID，Worker 完成导入、访问需要 Session Cookie 的
`/dashboard`、执行探索和任务结算。

同时修正认证导入失败/取消时
`apps/worker/src/auth-import-task.ts` 的清理原因：失败不再记作
`completed`，而分别记录 `failed`、`cancelled`。专门的浏览器
任务测试校验了这两种机器原因，不暴露密钥或异常消息。

## 实际运行

| 命令 | 真实组件 | 模型 | 结果 |
| --- | --- | --- | --- |
| `pnpm --filter @localqa/worker build` | TS 编译 | 无 | 通过 |
| `node --test apps/worker/test/auth-import-task.test.mjs` | Chromium/私有认证任务 | 模拟 Runtime | 5/5 |
| `pnpm test:auth-pg` | PostgreSQL18、Coordinator、Worker.once × 2、Chromium | 固定只读探索决策 | 1/1 |
| `pnpm test:t19-real-auth` | PostgreSQL18、Coordinator、Worker.once × 2、Chromium、外部 DeepSeek | 真实 `deepseek-flash` | 1/1，真实模型请求 3 次 |

两种集成运行均校验以下事实：

- 本地 `/session` 仅在表单提交正确凭据时创建 Cookie；
- Auth Worker 正常完成并保存被批准的 `current_state_id`；
- 后续 Explore Worker 使用新的任务浏览器上下文，将密封状态导入；
- 受保护页面的带凭据访问至少两次（登录上下文与探索上下文），
  未出现匿名仪表盘访问；
- Explorer `navigate` 动作成功，任务 `succeeded`；
- Importer Session `ended / task_finished`，对应授权记录 `ended`；
- Run 推进到 `plan`，非“仅申请授权”或者“仅复制 Cookie”的成功。

G3 测试额外校验：实际模型请求至少一次、所有模型请求账本均
`settled`，有 `reportedModelId=deepseek-flash`。观测为
**3 次**真实模型调用。正常 CI 不访问云模型；专用
`test:t19-real-auth` 显式启用 G3 运行。

## 数据和权限边界

- 账号、口令、Cookie 与临时模型 Key 均只用于本地 fixture。
  DeepSeek 凭据只读来自 Runner 已授权的 Pi 配置，写入独立临时
  PostgreSQL Vault；仓库、测试命令行和结果文档不保存明文。
- G3 上游仅收到授权的脱敏 DOM/Prompt，不接收认证用户名或口令。
  浏览器限制在随机 localhost origin，业务表单的提交仅为本地登录
  fixture，不是外部服务写入。
- Docker PostgreSQL 18、浏览器与临时数据在运行结束后清理。
  本次未部署、提交或推送项目。

## 仍未验收

此次验证 **一次表单认证 + 一次已认证的冒烟探索**，并不代表：

- MFA/OTP 人工输入、登录态过期、撤销与重试恢复已全场景验证；
- 第三方 IdP、多 Origin SSO 和真实用户业务系统已获授权试点；
- 多用户并发 Session 争用、长时间运行和故障注入达到 P0 SLA；
- 任意网页的真实模型自主探索精度达到质量基线。

**结论：T19 本地认证后真实 AI 探索 G3 专项通过；
整体 P0Passed 继续为 false。**
