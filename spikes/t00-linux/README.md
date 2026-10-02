# LocalQA T00: Linux 容器兼容验证 Spike

本项目验证 LocalQA 在 Linux 容器（`mcr.microsoft.com/playwright:v1.63.0-noble`）环境下的运行兼容性与安全性边界。

## 运行环境
- **宿主机**: macOS (Apple Silicon arm64)
- **Linux 运行时**: Colima Linux 虚拟机 (aarch64, 内核 6.8.0-117-generic, 2 vCPU, 2 GiB 内存)
- **容器引擎**: Docker Engine 29.5.2 (containerd-snapshotter, cgroup v2)
- **基线镜像**: `mcr.microsoft.com/playwright:v1.63.0-noble` (Digest: `sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`)

## 核心发现：Chromium 容器沙箱运行前提与安全权衡 (Key Finding)

在 Ubuntu 24.04 (Noble) 容器环境下，非 root (`pwuser`) 运行启用沙箱的 Chromium 时，必须具备创建 user namespace 的权限。验收实测对比了 A/B/C 三种配置：

### 1. 实测矩阵对比 (A / B / C)
- **配置 A：默认容器配置（`--user pwuser`，无额外权限）**
  - **结果**: 失败（`exitCode: null, signal: SIGTRAP`）
  - **报错**: `[FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md.`
  - **结论**: 默认配置下 Chromium 因沙箱初始化失败直接崩溃。
- **配置 B：仅放开 AppArmor（`--security-opt apparmor=unconfined`，不加系统能力）**
  - **结果**: 失败（`exitCode: null, signal: SIGTRAP`）
  - **报错**: 仍报相同 `FATAL ... No usable sandbox!`
  - **结论**: 仅放开容器端 AppArmor 无法突破内核层对无特权 user namespace 的全局限制。
- **配置 C：授予系统管理能力（`--cap-add=SYS_ADMIN`）**
  - **结果**: 成功（`Chromium 153.0.8010.12`）
  - **行为**: 成功拉起 Zygote 进程与沙箱子进程树，严格确认进程参数**无 `--no-sandbox`**，Docker 默认 Seccomp 白名单（`Seccomp: 2`）保持生效。

### 2. 根因剖析
- 宿主机/虚拟机 Linux 6.8 内核默认启用了 AppArmor 对非特权 user namespace 的限制：
  ```bash
  sysctl kernel.apparmor_restrict_unprivileged_userns
  # 输出: kernel.apparmor_restrict_unprivileged_userns = 1
  ```
- 该安全策略禁止非特权用户（UID 1001 `pwuser`）通过 `clone(CLONE_NEWUSER)` 创建无特权命名空间，导致 Chromium Layer 1 (Zygote userns sandbox) 无法初始化。

### 3. 对 Worker 部署与生产架构的影响
| 部署方案 | 实施方式 | 优势 | 代价 / 评估 |
| :--- | :--- | :--- | :--- |
| **方案 1: Worker 容器加 `--cap-add=SYS_ADMIN`** | 容器启动参数追加 `--cap-add=SYS_ADMIN` | 容器自包含，宿主机无需改动内核；Chromium 完整启用沙箱；Docker 默认 Seccomp 白名单依然生效 | 削弱了容器隔离边界；需配合非 root 用户 (`pwuser`) 及只读卷挂载降低风险 |
| **方案 2: 宿主机放开 userns / 配置专用 AppArmor 例外** | 宿主机 `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` 或加载专用 profile | Worker 容器维持最小权限（无需 `SYS_ADMIN`），容器隔离最强 | 依赖宿主机环境与运维支持，需要定制安全基线 |
| **方案 3: 降级为 `--no-sandbox`** | 浏览器启动参数加 `--no-sandbox` | 配置最省事 | **架构红线，明确禁止**。设计文档（`docs/02-technical-design.md:199`）严格禁止生产默认 `--no-sandbox`，存在严重逃逸与代码执行风险 |

## 验证项与测试脚本
1. **镜像元数据**: 记录 Image ID、RepoDigests、Architecture (`arm64`) 与虚拟大小。
2. **非 Root 用户运行**: 验证在 `--user pwuser` (UID 1001, GID 1001) 下正常运行。
3. **Seccomp 与系统安全**: 检查 `/proc/self/status` 的 `Seccomp: 2` (SECCOMP_MODE_FILTER)，验证 Docker 默认安全过滤。
4. **Chromium 沙箱验证**: 显式使用 `chromiumSandbox: true` 启动，并严格确认进程参数中**不存在 `--no-sandbox`**（前提：配置 `--cap-add=SYS_ADMIN` 解决 Ubuntu 24.04 userns 约束）。
5. **真实浏览器交互与产物落盘**:
   - 只读挂载 `packages/test-fixture` 至容器 `/work/packages/test-fixture:ro`；
   - 容器内 Node.js 启动测试站点 (`http://127.0.0.1:8080/`)；
   - Playwright 导航至首页，完成真实交互并截取全屏截图 (`screenshot-fixture.png`) 及 DOM 快照 (`dom-snapshot.html`)。
6. **/dev/shm 默认大小与受限行为**:
   - 检查默认大小（Docker 缺省 64MB）；
   - 在 `--shm-size=16m` 受限环境下实测标准启动与 `--disable-dev-shm-usage` 回退行为。
7. **中文字体与时区**:
   - `fc-list :lang=zh` 检查中文字体安装状态（实测官方 noble 镜像内置 7 种文泉驿正黑中文字体）；
   - 检查容器时区与本地化配置（默认 UTC）。
8. **cgroup 资源限制可见性**:
   - 传入 `--cpus=1.5 --memory=1g`，验证 `/sys/fs/cgroup/cpu.max` 与 `memory.max` 正确暴露限制。

## 执行方式
一键运行全量测试套件并生成验证报告：
```bash
./spikes/t00-linux/run-container-suite.sh
node ./spikes/t00-linux/generate-report.mjs
```

## 产出报告与证据
- 最终证据报告: `docs/validation-results/T00-linux-container.json`
- 浏览器截图: `spikes/t00-linux/evidence/screenshot-fixture.png`
- DOM 快照: `spikes/t00-linux/evidence/dom-snapshot.html`
- 原始日志: `spikes/t00-linux/evidence/*.log`
