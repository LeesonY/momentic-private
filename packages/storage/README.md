# @localqa/storage — T02

显式 PostgreSQL 18 migration、账号/session、强制项目作用域 repository、角色能力矩阵、SecretVault 和任务租约原语。所有公共 DTO 使用 `@localqa/contracts` 的生成类型及 Ajv；数据库私有行不是另一套同名协议。

## 安装与验证

本包内新增 `pg@8.23.1`、`@types/pg@8.23.1`，contracts 依赖为 `workspace:*`。T02 不能写根 lockfile，因此本次实际执行：

```sh
npx --yes pnpm@10.34.0 install --lockfile=false --ignore-scripts
npx --yes pnpm@10.34.0 --filter @localqa/storage typecheck
npx --yes pnpm@10.34.0 --filter @localqa/storage lint
npx --yes pnpm@10.34.0 --filter @localqa/storage format:check
npx --yes pnpm@10.34.0 --filter @localqa/storage test
```

**集成负责人必须随后统一运行根 `pnpm install` 更新 lockfile，并把本包检查接入根 CI；当前根 `run ci` 仍只验证 T01。** 不要将根 CI 的绿灯解读为 storage 验收。

`test` 不使用内存数据库：启动唯一命名的 `postgres:18-alpine` 容器，仅绑定 loopback 随机端口；生成项目内 0600 的短期 DB 密码和 KEK 文件；执行全部 migration 两次以验证幂等；运行真实 PG 测试；finally 删除容器及其匿名卷、临时凭据文件。输出原始结果到 `docs/validation-results/T02-storage.json`，过程日志仅在本包 `.evidence/`。任何失败都退出非零，不自动宣称通过。依赖 T01 contracts 已 build、本机 Docker 可用且镜像已存在。

## Migration 规则

1. `001_core.sql`：账号、项目、配置/秘密版本、Run/budget/job/attempt/verdict/action/evidence/input/audit 和辅助表；外键、复合归属、唯一键、索引。
2. `002_invariants.sql`：不可变历史、版本递增、终态保护、event seq 原子递增/事务通知、fencing verdict 检查、独立复现、确认证据与 GC 阻挡。
3. `003_access.sql`：server-only NOLOGIN/NOBYPASSRLS 角色、强制 RLS、项目 membership/admin 策略、至少一个 owner、账号禁用/重置撤销 session。
4. `004_hardening.sql`：受保护账号更新函数、配置 head→version 延迟 FK、模型授权、同 run/task reservation/evidence 归属、不可变引用、预览内容绑定、防敏感 JSON key、verdict invalidation 账本。

`migrate()` 用 advisory lock 串行执行，每个文件单独事务，记录 SHA-256；已执行文件 hash 改变会拒绝，不自动同步或改写 schema。生产迁移账号需 DDL/建角色权限，且必须是独立的受控 superuser/BYPASSRLS migration principal（RLS membership 辅助函数由其持有，以避免策略递归）。测试安装 owner 为 PG 容器初始化用户；各 repository 事务都主动降为 non-bypass server role，触发 RLS。

## 10 条硬规则落点

| 数据/API §2       | 本包落点                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 项目及父归属    | 所有项目子表 `project_id` + 复合 FK；forced RLS；查询绑定项目。全局 users/model registry 是明确例外，模型 descriptor 用 project grant 授权       |
| 2 不可变计划/快照 | version 表只增不改；执行计划冻结；Run context 独立历史，修改有效配置须递增 contextVersion；head 与版本延迟 FK                                    |
| 3 幂等键          | job unique_key、model request_id、action ID、verdict attempt、schedule occurrence、HTTP idempotency 主键；任务结果校验 canonical SHA-256         |
| 4 事件顺序/事务   | 锁 Run 分配 seq、唯一 `(run_id,seq)`、严格前值+1；结果/初始任务与 event 同事务；pg_notify 仅提交后送达                                           |
| 5 终态不能回退    | Run/Job/attempt 触发器阻止终态再写；新尝试独立 UUID/attempt_number；过期有动作不重放                                                             |
| 6 乐观锁          | repository `WHERE version=expectedVersion` 更新，零行返回 `VERSION_CONFLICT`；DB version guard；预览/triage 内容、actor、期限和一次性绑定        |
| 7 功能确认        | same criteria hash、不同 attempt/context、reproducer 角色、有效 reproduced verdict、同 run/task 的证据引用；inferred 不支持 functional confirmed |
| 8 历史 verdict    | immutable verdict；旧 fencing 被拒；invalidation 用追加账本；security-invoker final_valid_verdicts 视图选最终有效尝试                            |
| 9 保留/引用       | 删除前检查活跃 Run、retain_until、held、export 与引用；FK/immutable evidence links 防止删引用后伪造历史                                          |
| 10 秘密隔离       | 私有 bytea 密文表；DTO 不含原始认证/API key；Run query 整体加密并从 display URL 移除；session 只存 hash，日志事件拒绝敏感 key                    |

这些是存储约束，不证明浏览器事实。测试中的 Artifact/reproduction 是明确的合成元数据；没有真实浏览器截图或产品 Bug 结论。自由文本/页面材料仍需 T03/T04 RedactionPolicy，数据库不能识别所有任意字符串秘密。

## Repository 与安全边界

- `Database.actor({userId}, callback)`：userId 必须来自已验证 session；事务安装 actor 并 SET LOCAL ROLE，失败 rollback，连接归还不会残留 scope。不要把 body/model 的 userId 当身份。
- `authorize(projectId, capability)`：无成员/不可见项目为 `NOT_FOUND`；已是成员但能力不足为 `FORBIDDEN`；admin 为明确全局覆盖。owner/operator/viewer 能力见 `CAPABILITIES`。
- `AccountsRepository`：一次性 bootstrap、管理员账号操作、scrypt (N=131072/r=8/p=1/随机 16-byte salt/64-byte key)、session 随机 32-byte token，数据库仅 SHA-256 hash。login 返回 token 是仅用于服务端设置 cookie 的私有结果，不能直接作为普通 DTO 返回；HTTP 限速、Secure/HttpOnly/SameSite/CSRF 留给 T06。
- `ProjectRepository`：metadata、归档、成员 CAS；原 owner 可原子转移所有权，审计在同一事务。
- `ConfigurationRepository`：环境/auth/知识 head 与 immutable versions；auth secretInput write-only，storage state 校验 JSON/origin/cookie domain；知识审批仅 owner/admin，正文变化默认撤销批准。
- `ModelRepository`：admin 管理；descriptor 按项目 grant；原 API key 保存在私有 platform_secrets，外部 endpoint 必须 HTTPS，无 userinfo/query。provider probe/credential gateway 留给 T04。
- `SecretRepository`：只返回 `SecretDescriptor` 名称/元数据。轮换产生新 secret version，旧 ciphertext 保留；普通读者不能 SELECT secret_versions。
- `RunRepository`：Run/job/初始事件事务、资源作用域读取、不可变 case、summary 的确定性投影。完整状态机、预算预约、幂等创建接口和 UI/API 列表政策留给 T05/T06。

低层 transaction callbacks 与导出 SQL helper 是 **trusted server-only**，不是让终端用户执行任意 SQL 的入口。生产 runtime login 必须是非 superuser/NOBYPASSRLS，只授予所需 server role 成员资格；不能把 migration credential 给应用。RLS 的安全函数固定 search_path；禁止开放数据库给浏览器/模型。

## Vault 与 Worker

KEK 文件格式：`{ "activeVersion": 1, "keys": { "1": "base64-of-32-random-bytes" } }`；必须属于当前服务 UID、无 group/other 权限、普通文件且不接受 symlink。生产由受保护挂载提供，不落业务库或镜像。AES-256-GCM 使用随机 12-byte nonce、16-byte tag，AAD 绑定项目/secret/purpose/keyVersion；加解密只在获准后端内存。`.dispose()` 清零 key Buffer，但 JS 明文字符串不能承诺可彻底抹除内存。

轮换文件同时保留旧 keys 并提升 activeVersion；SecretRepository 事务追加 ciphertext 版本。密钥备份、挂载权限与线上滚动轮换由 T09 实测，不将测试 KEK 提交仓库。

`LeaseRepository` 领取用行锁/SKIP LOCKED；默认 45s，续期检查 worker/project/token/fencing；动作/结果检查 Run 取消及 contextVersion。token 仅存 hash，lease response 可在内部服务传递。`resolveAuth` 仅允许当前有效 lease 对该 Run 冻结选择的 auth version 解密，撤销立即阻止旧快照解密。T06 必须先验证 Worker service identity，不能只信 WorkerScope 参数。

过期 actionless preparation 可重新排队且再次领取 fencing+1；有 action intent 的任务标 interrupted，pending outcome→unknown，预约保守核销而非归零。未知动作不自动重放。T05 仍需实现完整原子预算/公平配额、角色结果协议、run 级独占认证租约、上下文恢复和调度。

`hashPayload` 按递归排序 JSON keys 的 canonical JSON SHA-256 定义内部提交 hash；调用方应使用该函数，不相信自报 hash。协调器与 worker 更新事务应保持一致的 job→run 锁顺序，避免取消/批量 job 锁的反序死锁。

## 当前限制

本机实测 Node 26.3.0；Node 24、生产 runtime login/KEK mount、备份恢复及完整 API/UI 尚未验收。没有安装或运行 Playwright，没有模型调用，不宣称 P0 通过。所有未验证项、原始输出和清理回查以 `T02-storage.json` 为准。
