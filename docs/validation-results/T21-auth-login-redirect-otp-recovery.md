# T21 · 认证可靠性：200 登录页、OTP 和 Worker 租约恢复

日期：2026-10-09。项目：`E:\\AI\\momentic`。
范围：使用随机 localhost 业务站和每次独立的 PostgreSQL 18，
通过真实 Coordinator、Worker.once 和 Chromium 验证。

## 背景与本次改动

T20 已能在服务器返回 HTTP 401/403 时阻断失效认证，但许多应用
会先重定向至登录页，最终返回 HTTP 200；部分 SPA 直接在受保护
URL 渲染登录表单而不改变地址。之前可能将该页面当成正常探索
快照，后续再调用 AI。

本次 `apps/worker/src/index.ts` 在冻结的 Form Auth Profile
边界内增加两种识别：

1. **已知登录页地址**：任务尝试进入其他地址，却落在已审批
   `formConfig.loginUrl` 的相同 origin + pathname 时标记认证
   不可用（只需 200/重定向后的最终 URL）；显式导航登录地址
   不触发此断言。
2. **SPA 登录表单**：仅当冻结的 `usernameTarget` 和
   `passwordTarget` 均为互异的 `test_id`，且当前已脱敏、未截断
   的 Chromium 主 frame snapshot 同时存在两个可见的固定定位器时，
   标记认证不可用。**不根据模型输出、页面标题或自由文本猜测**。

两种情况均在真实受授权 browser Action 已记录后，停止进一步
模型决策，进入 `setup_failure`；不会生成业务 Finding 或匿名
回退。正常 T19 认证路径不受影响。

新增 `scripts/t21-auth-negative.mjs`，根项目通过
`pnpm test:t21-auth-negative` 显式执行以下四个场景：

| 场景 | 注入方式 | 真实观察 |
| --- | --- | --- |
| `login_redirect` | 登录状态捕获成功后失效；业务站 `/dashboard` 返回 302 → `/login`，最终登录页 200 | 通过；停止探索、无模型请求或 Finding |
| `login_spa` | 登录状态捕获成功后失效；`/dashboard` 仍返回 HTTP 200，但渲染配置中的两项登录字段 | 通过；停止探索、无模型请求或 Finding |
| `auth_lease_crash` | 认证作业取得 1s 真实租约并分配私有 session 后不再续租或工作，调用真实 Coordinator `tick` | 通过；作业 interrupted、session ended、初始化锁释放、stateId 为空、旧 lease 不能再次激活、无自动登录重放、Run failed/setup_failure |
| `otp_required` | 真实登录表单提交后返回 OTP 输入页；测试配置冻结了 OTP 定位器，运行环境无 OTP 人工输入服务 | 通过；拒绝继续、无凭据状态生成、无受保护页面访问、Run failed/setup_failure |

## 结果与证据边界

- `pnpm --filter @localqa/worker build`：通过。
- `pnpm test:t21-auth-negative`：**4/4 通过**，使用真实 PostgreSQL
  和 Chromium。OTP 场景只验证服务不可用时 fail-closed，
  **不表示已实现 OTP 暂停/恢复**。
- 不使用第三方模型 API。没有在仓库保存认证密码或 API Key。
- 每轮独立临时数据库及相关资源在测试 `finally` 清理。
- 与 T20 原有 401、403、静态/动态撤销测试互补。

## 仍待完成

- OTP 真正的用户交互、限时暂停/恢复、一次性验证码生命周期和
  中断恢复，不在 T21 支持范围；不得对外宣称 MFA 已支持。
- 复杂 SSO/IdP、非 `test_id` 登录控件的同 URL SPA、纯图像登录
  页仍可能无法可靠判断失效。
- 模拟租约过期不等同于 OS 层面的 `SIGKILL`、进程断电及异常
  存储回滚验证。
- 显式进入登录页的回归与预期拒绝 URL 语义仍需扩大用例矩阵。
- P0 仍不可放行；没有 commit、push 或部署。
