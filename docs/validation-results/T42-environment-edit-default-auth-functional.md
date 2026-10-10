# T42 产品功能交付：环境编辑和默认认证配置

日期：2026-10-10。项目：`E:\\AI\\momentic`。
本阶段只交付可用产品功能与必要的回归，不执行压力/Soak 或付费模型样本。

## 交付内容

1. “环境与认证管理”页新增环境编辑操作，可修改环境名称、Base URL
   （保留 path/query）、获准 Origins、排除路径和 TLS 策略。
   创建/编辑复用同一套前端 Origin/TLS 校验；自签名 HTTPS
   仍需每次明确确认，不会静默放松 TLS。
2. 管理员/项目负责人可为环境选择关联的、状态为 active 的认证档案，
   或显式清空默认认证；普通成员保持只读。页面不展示认证密钥。
3. 保存使用 `PATCH /api/v1/environments/{environmentId}`
   和 `expectedVersion`，服务器成功后才更新列表及版本；
   失败保留编辑内容供纠正，不伪报成功。
4. Repository 在 PostgreSQL 事务内验证默认认证与当前环境属于
   同一项目、同一环境、active 状态，且认证 Origins 不超出环境范围。
   未知/跨项目/其他环境的档案拒绝绑定。新环境创建时不能引用
   尚不可能关联该环境的旧认证档案。
5. 冒烟首页自动预选环境的合法默认认证，并明确提示当前使用默认认证；
   用户可以选择匿名访问覆盖默认。切换环境时按新环境独立重算，
   禁止沿用旧环境的认证选择；失效/撤销档案不再显示为可用。

## 已执行验证

- `pnpm --filter @localqa/web typecheck`：通过。
- `pnpm --filter @localqa/storage build`：通过。
- `pnpm --filter @localqa/web test:functional-start`：
  真实 React/Vite + Chromium 流程通过；覆盖
  项目创建 → 模型授权 → 环境创建 → 无密钥认证创建 →
  拒绝未批准 Origin 的编辑 → 环境编辑/设置默认认证 →
  返回首页自动选中默认认证 → 改用匿名 → 再次选择认证 →
  提交 URL 冒烟并进入工作台。检查实际 `PATCH` 的
  `expectedVersion`、认证 ID、版本递增。该 Web 测试 API
  响应由隔离 fixture 提供，并非生产环境或真实模型调用。
- `pnpm --filter @localqa/api test`：真实 PostgreSQL 18
  集成测试 **15/15 通过**；新增测试覆盖 viewer 无权编辑、
  未知认证拒绝、同项目不同环境拒绝、有效默认认证绑定、
  版本冲突拒绝。使用隔离 Docker 临时数据库。
- 修改代码的 Prettier 格式化通过。

## 仍然缺失/未验证

- 环境归档生命周期（现有 Environment 契约没有归档状态/API）；
  没有假装已经实现“删除/归档”。
- 默认认证被撤销后的主动联动清空、分页超过 100 项、
  环境改动对既有运行冻结快照的 UI 解释，以及全量环境更新后的
  并发操作说明仍需完善。
- 真实登录站点的 form/storage_state 凭据使用闭环、成员管理 UI、
  完整报告/导出页面、正式 G3/P0 发布门槛仍未完成。

保留全部既有未提交代码与历史验证记录；未提交、推送、
reset、clean、stash 或生产部署。
