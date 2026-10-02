# @localqa/web

LocalQA 前端工作台应用（基于 React 19 稳定版 + Vite + Radix UI 原语 + 原生 CSS Token 变量）。

## 核心设计与契约边界

1. **投影状态原则（API / SSE 事实投影）**：
   - 前端不将 UI 内存视为运行事实；运行进度、任务树、用例结果与缺陷列表全部由 REST 快照与 SSE 事件流（`RunEvent`）聚合投影驱动。
   - 支持页面刷新（通过 `location.hash` 同步保持路由状态及选中的 `runId`、`caseId`、`findingId`）。
2. **类型化 API 客户端与公开操作**：
   - 严格依据 `docs/contracts/openapi.json` 生成并排除带有 `Internal` 标签的操作（例如 Worker 内部 Claim/Heartbeat/Complete）。
   - 通过 `ApiClient` 契约抽象并提供 `HttpApiClient`（正式联调环境）与 `MockApiClient`（受控靶场隔离开发环境）。
   - 在应用顶栏提供一键切换开关，支持无后台快速自测与真实后端无缝平移。
3. **SSE 客户端健壮性**：
   - 具备 `seq` 序列号去重机制，防止乱序或重复投递。
   - 断线后自动触发指数退避重连，携带 `Last-Event-ID` 请求头接续事件。
   - 明确显示「正在重连」提示栏（`ReconnectBanner`）及重试按钮，坚决杜绝无限 loading 假死。
4. **人工审查与缺陷决议（Triage Preview）**：
   - 严格遵循两阶段确认（先调用 preview 获取带时效性与确认 Token 的决议变更核对单，用户二次点击确认后提交正式生效）。
5. **安全与隐私合规**：
   - 认证密钥（`AuthProfile`）采用 **Write-Only** 模式录入，API 与 UI 坚决不回显明文密码。
   - 配置外部商业模型（如 OpenAI）时，明确高亮显示数据出网风险提示（DOM 结构及截图传输说明）。
   - 实时执行日志自动过滤模型思维链（Hidden Reasoning），仅呈现实测动作与状态。

## 页面结构

- **登录 / 初始化 (`/login`)**：会话认证与初始角色授权。
- **项目首页 (`/home`)**：
  - 被测目标 URL 输入与说明；
  - 关联环境（Environment）、认证凭据（AuthProfile）、推理模型（ModelProfile）下拉选择；
  - 外部商业模型数据出网提示栏；
  - 可折叠高级预算覆盖（用例数、探索深度、操作步数、Token 预算等）。
- **运行工作台 (`/workbench`)**：
  - **左侧**：运行历史列表（按状态筛选，展示时间与资源消耗）；
  - **中间**：断线重连横幅、Partial 报告收尾警告、7 阶段生命周期进度条（Preflight → Auth → Explore → Plan → Execute → Reproduce → Finalize）、Awaiting Input 人工交互请求条、补充说明输入框、实时事件轨迹；
  - **右侧**：用例（Cases）、缺陷（Findings）、任务（Tasks）、报告（Report）多标签页，支持窄屏收起/折叠。
- **用例详情 (`/case-detail`)**：
  - 用例前置条件、标题与描述；
  - 验收准则清单（Acceptance Criteria）与单项判定结果；
  - 真实 Chromium 动作轨迹（Step Actions）与证据查看。
- **缺陷详情 (`/finding-detail`)**：
  - 预期行为 vs 实际呈现对比卡片；
  - 必要复现步骤清单；
  - 视觉截图证据与脱敏状态展示；
  - 人工审查决议（Triage）弹窗（两阶段确认流）。
- **环境与认证管理 (`/environments`)**：白名单 Origin、排除路径、TLS 策略与 Write-Only 凭据管理。
- **项目知识 (`/knowledge`)**：项目专属业务规则与禁止危险操作清单（含运行快照不变性声明）。
- **模型管理 (`/models`)**：内网/外部模型档案、JSON/Tool/Vision 探测与实时连通性探测（Probe）。
- **成员与运维 (`/members-ops`)**：项目 RBAC 成员权限、核心服务健康状态（DB、Schema、Browser Worker、Gateway）与审计日志。

## 开发与验证指令

```bash
# 1. 类型检查
npx --yes pnpm@10.34.0 --filter @localqa/web run typecheck

# 2. 生产构建打包
npx --yes pnpm@10.34.0 --filter @localqa/web run build

# 3. 启动开发调试服务器 (默认端口 5173)
npx --yes pnpm@10.34.0 --filter @localqa/web run dev

# 4. 真实浏览器截屏自测 (通过 Playwright 自动化捕获 4 大核心关键流程并留存截图证据)
node apps/web/scripts/captureScreenshots.mjs
```

## 留存截图证据

截图统一存放于 `apps/web/screenshots/`：

1. `01-launch-page.png`：启动页（目标 URL 输入、模型选择与外部数据提示、高级预算覆盖）
2. `02-workbench-partial-reconnecting.png`：运行工作台（含 Partial 报告横幅、断线重连状态提示、7 阶段进度与三栏工作区）
3. `03-case-detail.png`：用例详情（裁决总结、判定准则清单及真实动作轨迹）
4. `04-finding-triage-preview.png`：问题缺陷详情（含人工审查决议两阶段确认弹窗）
