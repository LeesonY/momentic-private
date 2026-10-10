# LocalQA 部署骨架与演练指南 (T09-A)

> T09-B 增加 Worker 租约领取/心跳/执行/提交的部署入口，浏览器容量 (`browser-ready`) 与任务循环 (`task-ready`) 分别观测；就绪需要两者。**当前仅支持显式 `LOCALQA_ALLOW_TEST_STUB=1` 隔离验证模式，真实模型 provider 未接通，不得在生产启用。Worker 暂时直接持有 DB/KEK 并使用进程内 Coordinator；内部 HTTP 身份边界未替换该路径，须在生产上线前隔离改造。**TLS 网关和完整 P0 端到端仍未验证。

本指南针对 LocalQA 内网多用户生产环境（Linux 6.8+ / aarch64 & x86_64, Docker 27+, Docker Compose 2.30+）。

---

## 1. 服务拓扑与架构

LocalQA 采用基于 Docker Compose 的多容器隔离架构，划分为前端网关网络（`frontend`）与内网核心网络（`backend`，`internal: true`，禁止外部直接访问）：

```
[浏览器客户端]
      │ (HTTPS 443)
      ▼
┌────────────────────────────────────────────────────────┐
│  gateway (nginx 1.27)                                  │
│  - TLS 终止 / 静态资产代理 / 反向代理                      │
│  - SSE 禁用缓冲 (proxy_buffering off)                   │
└────────┬───────────────────────────────────┬───────────┘
         │                                   │
         ▼                                   ▼
┌──────────────────┐               ┌──────────────────┐
│  web (SPA)       │               │  api (node:http) │
│  - React 19 UI   │               │  - REST / SSE    │
└──────────────────┘               └─────────┬────────┘
                                             │
      ┌──────────────────────────────────────┼──────────────────────────────────────┐
      │ (内部隔离网络 backend: internal=true) │                                      │
      ▼                                      ▼                                      ▼
┌──────────────────┐               ┌──────────────────┐               ┌──────────────────┐
│  orchestrator    │               │  worker          │               │  postgres (18)   │
│  - 状态推进       │               │  - 真实 Chromium  │               │  - Forced RLS    │
│  - 租约与并发管理  │               │  - 非 root 沙箱   │               │  - 显式 Migrations│
│  - 恢复收敛       │               │  - 可丢弃 scratch │               │  - 持久数据卷     │
└──────────────────┘               └──────────────────┘               └──────────────────┘
```

---

## 2. 上线输入清单（Upstream Inputs Checklist）

所有敏感项与物理凭证严禁硬编码进仓库或构建进 Docker 镜像，通过 `./deploy/secrets/` 目录挂载进容器只读路径 `/run/secrets/`。API、Worker、Orchestrator、迁移、初始化及维护脚本现已支持 `DATABASE_URL_FILE`；与开发用的 `DATABASE_URL` **只能二选一**。PostgreSQL 初始口令仍由独立受保护的文件提供。此项接线不代表完整生产部署已经验收通过。

| 输入项                  | 挂载 / 配置路径                                           | 格式与权限约束                                  | 职责说明                                                                                |
| :---------------------- | :-------------------------------------------------------- | :---------------------------------------------- | :-------------------------------------------------------------------------------------- |
| **公司 CA 与 TLS 证书** | `deploy/certs/tls.crt`<br>`deploy/certs/tls.key`          | PEM 编码，私钥权限 `0600`                       | Gateway 入口 HTTPS 证书（生产必须提供有效域名证书，禁止纯 HTTP）                        |
| **内网 DNS / 代理**     | `deploy/.env` (`PUBLIC_ORIGIN`, `HTTP_PROXY`, `NO_PROXY`) | URI 字符串                                      | 获准内网被测系统域名与可选出网 HTTP 代理                                                |
| **数据库初始密码**      | `deploy/secrets/postgres_password`                        | 单行纯文本，权限 `0600`                         | PostgreSQL 超级用户与业务用户的初始强随机密码                                           |
| **应用数据库连接串**    | `deploy/secrets/database_url`                             | 单行完整 PostgreSQL URL，非符号链接；属主为应用运行 UID，权限 `0400` 或 `0600` | 通过 `DATABASE_URL_FILE=/run/secrets/database_url` 加载，不暴露到环境变量 |
| **主加密密钥 (KEK)**    | `deploy/secrets/kek.json`                                 | JSON，权限 `0400` 或 `0600`，所有者匹配运行 UID | SecretVault AES-256-GCM 主密钥环：`{"activeVersion":1,"keys":{"1":"<base64-32bytes>"}}` |
| **Worker 内部身份**     | `deploy/secrets/worker_identity.json`                     | JSON，权限 `0400` 或 `0600`                     | Worker 进程向内部协调器/租约端口认证的私有令牌                                          |
| **初始管理员密码**      | `deploy/secrets/admin_initial_password`                   | 单行纯文本（≥12字符）                           | 仅在系统初次初始化执行 `bootstrap-admin.mjs` 时消费一次，完成后入口关闭                 |

nginx 仅 `/api/v1/runs/{runId}/events` SSE location 禁用 `proxy_buffering`（API 同时返回 `X-Accel-Buffering: no`；前者已足够，不依赖后者），其他 `/api/` 走普通代理，`/` 到 web:8080。应用侧 Node 出站 HTTPS 私有 CA 可放 `deploy/ca/company-ca.pem`（只读挂载 `/etc/localqa/ca`），在 `.env` 显式设置 `NODE_EXTRA_CA_CERTS=/etc/localqa/ca/company-ca.pem`。Chromium 独立证书信任链还需目标宿主/镜像验证，不可假设 Node CA 自动生效；入口 TLS 证书和私钥仅挂给 gateway 的 `/etc/nginx/certs`。

### T09-B1 镜像构建与就绪边界

```sh
# 必须以仓库根目录为 build context；镜像只来自 deploy/images/*.Dockerfile。
# BuildKit 不可用时 Docker legacy builder 亦可使用；可显式设置构建 registry mirror。
docker compose -f deploy/docker-compose.yml build api worker orchestrator web
# 就绪/存活：API GET /readyz、/healthz；Web GET /readyz、/healthz；
# Orchestrator DB/schema/Vault 与成功 tick 时间戳；Worker DB/schema、沙箱容量及任务循环时间戳。
```

镜像运行 UID/GID 默认为 1001:1001；运行镜像创建 `localqa` 系统账号（Playwright 基镜像的 `pwuser` 同 UID 时重命名），`HOME` 与 passwd 中的目录一致。自定义 LOCALQA_UID/GID 须用 Compose 同值重建镜像；容器根只读，API/Web/Orchestrator HOME 及 Worker HOME/scratch 与 `/tmp` 为 tmpfs。数据库/材料位于命名卷。首次挂载命名卷需确认 UID 1001 对材料卷可写。构建缓存先按 lockfile `pnpm fetch`，再安装 workspace 并构建依赖闭包；`deploy/images/*.Dockerfile.dockerignore` 供 BuildKit 使用，根目录 `.dockerignore` 供 legacy builder 使用，两者排除本地凭据/证据。`T09-images.json` 里的本地镜像 ID/digest 不等同于推送后注册表多架构 digest。默认 Playwright worker 镜像 `v1.63.0-noble`，运行时 Node 24；没有 `--no-sandbox`。Worker 就绪需**浏览器容量与已成功进入任务轮询循环**；仍不证明真实模型 provider 或生产安全边界。API 就绪不依赖模型配置，使管理员能够进入设置；启动仍需 DB 迁移、KEK 和 Worker 身份文件。项目 owner 可用现有 PATCH /projects/{id} 的 defaultModelProfileId 绑定全局已存在模型，后台同事务建立项目 grant；不增设对外 grant 路由。当前 BROWSER_SLOTS 同时限制平台与项目租约数；满槽新建运行返回 429 + Retry-After: 1，先前入队的运行保持排队。仅固定 stub 集成测试可在隔离环境显式启用 LOCALQA_ALLOW_TEST_STUB=1，生产严禁此开关。

---

## 3. Chromium 沙箱架构与操作系统级权衡 (T00 发现)

在 Ubuntu 24.04 (Noble) 与现代 Linux 6.8+ 内核中，系统 AppArmor 默认启用了对非特权用户命名空间的限制：

```sh
kernel.apparmor_restrict_unprivileged_userns = 1
```

在严格遵守安全红线（**严格禁止 `--no-sandbox`**）的前提下，必须在以下两套方案中作出取舍并在部署时明确声明：

### 方案 A：容器自包含方案（Docker Compose 默认配置）

- **配置方式**：在 `docker-compose.yml` 的 `worker` 服务中显式配置：
  ```yaml
  user: '1001:1001' # 非 root (pwuser)
  cap_add:
    - SYS_ADMIN # 允许 clone(CLONE_NEWUSER)
  shm_size: '256m' # 满足 Chromium 渲染共享内存
  ```
- **优点**：容器自包含，不需要对宿主机做全局内核参数变更，宿主机 AppArmor 维持默认安全状态。
- **风险缓解**：尽管使用非 root（UID 1001，须在目标镜像中确保该 UID 可写并可执行浏览器）及 Seccomp filter 2，`SYS_ADMIN` 仍是高风险权限；`localqa_data` 是读写挂载，不应描述为只读。正式部署需单独做宿主隔离审查。

### 方案 B：宿主机最小权限方案（生产推荐高密隔离）

- **配置方式**：在宿主机运维层面放开非特权 user namespace：
  ```sh
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  ```
  或者为 Worker 容器加载专用的允许 `userns` 的 AppArmor Profile。
- **优点**：Worker 容器**完全无需授予 `SYS_ADMIN`**，容器维持绝对的最小特权（Least Privilege）。
- **实施说明**：如果采用方案 B，可在 `deploy/docker-compose.yml` 中将 `cap_add: [SYS_ADMIN]` 注释掉。

> **架构红线**：禁止将 Chromium 降级为 `--no-sandbox`。若被测网站存在未授权脚本注入或漏洞，缺少第一层（Zygote/userns）和第二层（Seccomp/chroot）沙箱保护的 Chromium 将直接威胁容器与底层主机。

---

## 4. 初始化与启动流程

生产上线标准流水线按顺序执行：

```sh
# 1. 复制环境配置模板并填写非敏感项
cp deploy/.env.example deploy/.env

# 2. 准备受保护的秘密凭证目录；Linux 上应将 secrets 目录及应用所需文件
# 的属主设置为运行 UID/GID（默认 1001:1001），模式 0700/0400 或 0600。
mkdir -p deploy/secrets deploy/certs deploy/ca
chmod 700 deploy/secrets deploy/certs deploy/ca

# 生成随机数据库密码与主 KEK
openssl rand -hex 24 > deploy/secrets/postgres_password
chmod 600 deploy/secrets/postgres_password

# 安全生成应用侧的 PostgreSQL DSN，密码需要 URL 编码。下列步骤只适用于
# 默认用户 localqa、数据库 localqa 和容器 UID 1001；自定义配置时需同步修改。
python3 - <<'PY'
from pathlib import Path
from urllib.parse import quote
password = Path('deploy/secrets/postgres_password').read_text().strip()
Path('deploy/secrets/database_url').write_text(
    'postgresql://localqa:' + quote(password, safe='') + '@postgres:5432/localqa\n'
)
PY
chown 1001:1001 deploy/secrets/database_url
chmod 400 deploy/secrets/database_url

# 3. 为 .env 设置 0600，提供 TLS 证书、KEK 和 worker 身份文件，
#    并确认镜像已构建/提供入口与探针；不要把含口令的 .env 提交。
chmod 600 deploy/.env
# 验证 Docker Compose 语法与配置解析
docker compose -f deploy/docker-compose.yml config
# 构建四个应用镜像（不会把 .env、certs、secrets、证据目录放进 build context）
docker compose -f deploy/docker-compose.yml build api worker orchestrator web

# 4. 启动数据库容器
docker compose -f deploy/docker-compose.yml up -d postgres

# 5. 在能够访问 backend 网络、包含仓库构建输出与 Node 依赖的应用镜像中运行
# 显式 Migrations：按文件名顺序执行 packages/storage/migrations/ 下全部 SQL（当前 001_core … 024_empty_project_deletion），已执行的自动跳过
# DATABASE_URL 必须指向 postgres:5432；宿主机默认不能访问内部 DB。
docker compose -f deploy/docker-compose.yml run --rm --no-deps --entrypoint node api /app/deploy/scripts/migrate.mjs

# 6. 一次性初始化平台管理员账号 (受保护入口，完成后永久关闭)
# 以 UID/GID 1001 可读且其他用户不可读的受保护文件提供初始口令：
# deploy/secrets/admin_initial_password (0400，所有者 1001)
export ADMIN_INITIAL_EMAIL="admin@yourcompany.internal"
docker compose -f deploy/docker-compose.yml run --rm --no-deps -e ADMIN_INITIAL_EMAIL --entrypoint node api /app/deploy/scripts/bootstrap-admin.mjs
# 成功后撤销/销毁初始管理员口令文件；数据库状态拒绝重复初始化。

# 7. 仅在 TLS、服务身份隔离与真实模型接线审查完成后开放生产业务运行；
# 隔离预演必须显式设置 LOCALQA_ALLOW_TEST_STUB=1（仅固定测试 stub）。
docker compose -f deploy/docker-compose.yml up -d
```

---

## 5. 运维监控与日常巡检

### 5.1 健康与就绪检查

- **存活探针 (Liveness)**：
  ```sh
  node deploy/scripts/health-probe.mjs --live
  # 或 HTTP 请求
  curl -f http://127.0.0.1:80/healthz
  ```
- **就绪探针 (Readiness)**：
  ```sh
  node deploy/scripts/health-probe.mjs --ready
  # 验证数据库连接、当前仓库内全部 migration、Vault KEK 挂载与数据目录可写性
  ```

### 5.2 磁盘容量与清理状态

定期运行检查持久卷用量、250MiB 单运行配额与待清理过期材料：

```sh
node deploy/scripts/disk-status.mjs
```

### 5.3 稳态下线 (Graceful Drain Shutdown)

系统维护或升级前，**先由 Worker 运行时停止领取新任务**，再等待在途任务收敛。脚本只观察数据库，不发送停止领取信号；超时且仍有任务时返回码 2，禁止继续关闭或直接篡改活跃租约。部署入口收到 SIGTERM 后停止继续轮询，但该脚本尚未与 Worker 建立远程 drain 信号，生产稳态下线仍未验证：

```sh
node deploy/scripts/graceful-shutdown.mjs && docker compose -f deploy/docker-compose.yml stop
```

---

## 6. 备份与灾难恢复演练 (Disaster Recovery)

### 6.1 备份流程

演练备份包含：PostgreSQL 逻辑数据、持久材料 (Artifacts) 与 Manifest、以及 KEK 副本（**KEK 副本未独立加密**，应隔离存储）。无 `pg_dump` 时使用 Node 逻辑 SQL 提取，仅在小型样本验证；没有跨数据库/文件原子快照、WAL、二进制字段和全量恢复保证，生产必须使用受控的 PG18 `pg_dump`/PITR 并单独演练，不能将此脚本视为生产备份方案：

```sh
node deploy/scripts/backup.mjs ./backups/backup-$(date +%Y%m%d-%H%M%S)
```

### 6.2 恢复演练与租约失效保护

灾难恢复时，为了防止备份中未完成的任务在恢复后被当作活跃任务继续执行造成副作用泄漏，恢复脚本会在新卷上执行**租约与在途任务强制失效收敛**：

```sh
node deploy/scripts/restore-drill.mjs \
  ./backups/backup-20261002-120000 \
  "postgresql://localqa:password@new-postgres:5432/localqa" \
  "/var/localqa/new_data" \
  "/run/secrets/new_kek.json"
```

恢复脚本核心保证：

1. 自动校对备份 SQL、KEK 与材料的 SHA-256 完整性；
2. 恢复数据后执行 `UPDATE task_leases SET lease_until = clock_timestamp() - interval '1 second'`，清除全部过期/未决租约；
3. 将在途未完成的任务和用例尝试置为 `interrupted`，并记录 `recoveredAfterDisaster: true`；
4. 演练样本恢复后生成报告并校验材料内容；不代表所有历史材料 100% 可读。恢复目标必须是隔离新库与新目录，不能覆盖现网数据。命令行 URL 会暴露密码于进程列表，请只在隔离演练环境使用。
