# T20 · 认证过期、撤销与运行中动作拦截

日期：2026-10-09。环境：Windows Runner `E:\\AI\\momentic`；
隔离 PostgreSQL 18、Coordinator、Worker.once 和真实 Chromium。

## 本次修复

1. `apps/worker/src/index.ts`：当服务器冻结的认证状态已导入，
   目标导航明确返回 HTTP 401/403，Worker 现在标记认证不可用并以
   `setup_failure` 停止。不继续发模型决策，不匿名 fallback，也不
   把失败页面缺少 DOM 标记当成产品 Finding。普通冒烟和受审批回归
   两个执行入口均增加了 fail-closed 检查。已获人工审批且来源为
   `user_spec`、明确预期 `http_status=401/403` 的回归 Oracle
   仍可验证预期拒绝，避免误伤授权的权限边界测试；此特例本次未
   做专门的真实回归复验。
2. `packages/orchestrator/src/core.ts`：对绑定认证配置的普通业务
   Browser Action 授权，重新验证冻结版本、实时撤销状态及
   `run_auth_scopes` 现时授权。对认证配置行加共享锁，和正式撤销
   操作序列化；认证在 Worker 已导入后被撤销时，不得再生成新的
   Browser ActionIntent。认证模式为 `none` 的既有语义不变。
3. `apps/worker/test/auth-pg-chromium.integration.mjs`：复用 T19
   已通过的真实认证 Worker 测试环境，新增四个负向分支。
   `scripts/t20-auth-negative.mjs` 独立显式运行，无外部模型调用。

## 负向验收

执行 `pnpm test:t20-auth-negative`：

| 场景 | 实际注入 | 结果 |
| --- | --- | --- |
| `expired` | 初次表单登录成功并捕获认证状态，探索时业务站返回 401 | 通过 |
| `forbidden` | 同上，但探索返回 403 | 通过 |
| `revoked` | 登录态已捕获、正式版本化撤销先于探索导入 | 通过 |
| `revoked_mid` | 第一次受保护导航成功；在模型决策时正式撤销，模型再提出导航动作 | 通过 |

四个场景均验证：Explore Job 不为 `succeeded`、
`termination_reason=setup_failure`、没有 Finding、没有真实模型账本
调用、没有匿名导航回退。

- 401/403 只产生一次已记录的浏览器导航，不继续模型决策；
- `revoked` 在导入前拒绝，授权导入 Grant=0，导航=0；
- `revoked_mid` 已有首次有效的 Auth Import 和导航，但第二次动作
  的 Grant 被拒，因此导航总数仍为 1；模型角色决策为 **本地注入
  的固定方案**，非第三方模型调用。

真实登录凭据只用于随机 localhost fixture，数据库容器及运行目录
运行后清理；没有使用用户提供的外部 API Key。

## 正向与编译复核

- `pnpm --filter @localqa/orchestrator --filter @localqa/worker build`
  通过。
- `pnpm test:auth-pg` 正常认证、状态导入、Worker.once 浏览器探索
  与进入 plan 阶段通过；AI 探索决策为测试 stub，不计入 G3。

## 未验收与发布边界

本批不验证 HTTP 200 重定向登录页、SPA 静默失效、OTP 超时/恢复、
被测站交叉 Origin SSO、Worker SIGKILL 后租约恢复、身份撤销时
已经取得的 Browser Grant 的在途效应、以及真实模型多样本性能。
HTTP 401/403 的语义在不同业务站点可能不同；已审回归的显式
状态码 Oracle 仍保留，不能把一切 403 都定义为登录态失效。

**T20 指定负向场景通过；P0/G5 不放行。** 不自动 commit、push、部署。
