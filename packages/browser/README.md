# LocalQA 浏览器执行层 (@localqa/browser)

LocalQA 核心浏览器执行适配层，基于 Playwright 1.63.0 构建，提供强隔离、高稳定、严格脱敏与受控策略检查的无头浏览器自动化运行环境。

---

## 1. 架构与模块设计

```
packages/browser/
├── src/
│   ├── types.ts          # 稳定原因码 (STABLE_REASON_CODES)、会话配置、策略与解析接口
│   ├── port.ts           # BrowserPort & BrowserSession 端口契约定义
│   ├── redaction.ts      # URL query、Header、Body、日志与 DOM 敏感数据脱敏工具
│   ├── policy.ts         # 范围校验 (Origin/Scheme) 与 P0 non_submitting 变动拦截器
│   ├── recorder.ts       # Console、Network、Screenshot、Trace 捕获与容量降级
│   ├── snapshot.ts       # Frame 感知 DOM 提取、过滤、脱敏与 BrowserSnapshot 校验
│   ├── resolver.ts       # 四级稳定性优先目标解析器 (test_id -> role+name -> label -> text)
│   ├── waiter.ts         # 基于状态的等待与恢复策略 (严禁 networkidle) 与死循环检测
│   ├── executor.ts       # 类型化工具执行器 (tools.schema.json 校验，拦截危险工具)
│   ├── session.ts        # BrowserSessionImpl 会话实现与 BrowserManager 管理器
│   └── index.ts          # 统一模块导出
├── test/
│   └── browser.test.mjs  # 真实 Chromium 交互自测试卷 (覆盖 FIX-01 ~ FIX-12)
└── package.json
```

---

## 2. BrowserPort 端口规范草案

> [!NOTE]
> **BrowserPort 签名草案（待集成负责人冻结）**
> 以下为执行层对外暴露的抽象端口契约，等待后续与调度/编排层负责人完成统一接口冻结。

```typescript
import type { Page, BrowserContext } from 'playwright';
import type { ToolCall, ToolResult, BrowserSnapshot, Artifact } from '@localqa/contracts';
import type { BrowserSessionOptions } from './types.js';

/**
 * 浏览器管理端口抽象 (BrowserPort)
 */
export interface BrowserPort {
  /**
   * 创建任务隔离的浏览器会话
   */
  createSession(options: BrowserSessionOptions): Promise<BrowserSession>;

  /**
   * 关闭浏览器实例并清理所有活跃会话
   */
  close(): Promise<void>;
}

/**
 * 单个任务隔离的浏览器会话抽象 (BrowserSession)
 */
export interface BrowserSession {
  readonly id: string;
  readonly taskId: string;

  /**
   * 执行类型化浏览器工具动作 (经过契约校验与策略拦截)
   */
  executeTool(
    toolCall: ToolCall,
    options?: { signal?: AbortSignal }
  ): Promise<ToolResult>;

  /**
   * 获取当前上下文或页面的结构化快照
   */
  getSnapshot(options?: { forceFresh?: boolean }): Promise<BrowserSnapshot>;

  /**
   * 捕获全屏截图 Artifact (包含 SHA-256 与脱敏标记)
   */
  captureScreenshot(options?: { fullPage?: boolean }): Promise<Artifact>;

  /**
   * 主动取消当前正在等待或执行的动作
   */
  cancel(reason?: string): Promise<void>;

  /**
   * 安全关闭会话与对应的 Playwright Context
   */
  close(): Promise<void>;

  /**
   * 获取底层 Playwright Page (仅供受信任适配器内部诊断使用)
   */
  getPage(): Page;

  /**
   * 获取底层 Playwright BrowserContext (仅供受信任适配器内部诊断使用)
   */
  getContext(): BrowserContext;
}
```

---

## 3. 核心设计原则与执行约束

### 3.1 强隔离会话生命周期
- 每一个 `BrowserSession` 对应一个全新且独立的 `BrowserContext`。
- 严禁会话间 Cookie、LocalStorage 或 SessionStorage 交叉污染。
- 认证状态（`approvedAuthState`）只允许来自显式传入并经核准的凭据注入，不自动继承任何宿主环境状态。

### 3.2 结构化 DOM 快照 (BrowserSnapshot)
- 提取交互元素（按钮、链接、输入框、标题、表格、折叠栏等），基于 ARIA role、accessible name、bounds 构建。
- **强制脱敏**：
  - 自动剔除 `type="password"` 输入框明文值，替换为 `[redacted]`；
  - 自动过滤 `type="hidden"` 隐藏字段；
  - URL Query 参数自动扫描敏感 Key（`token`、`auth`、`key`、`secret`、`sig` 等）并替换为 `[redacted]`；
  - 每个输出快照均必须通过 `@localqa/contracts` 的 `validateContract('BrowserSnapshot', snapshot)` 严格校验。

### 3.3 稳定性优先的目标解析 (Target Resolution)
定位策略遵循确定性优先级：
1. **Priority 1: Test ID 契约** (`data-testid`, `data-test`)
2. **Priority 2: Role + Accessible Name** (标准 ARIA 语义)
3. **Priority 3: Label** (表单 label 关联)
4. **Priority 4: Unique Text Structure** (唯一样式文本匹配)

**防歧义与安全性拒止**：
- 若候选元素在当前页面匹配数量 `count > 1`（如 FIX-05 中 9 处相同 "Inspect" 按钮且未指定 testid），执行器立即拒止动作并返回 `TARGET_AMBIGUOUS` 及匹配数量，坚决不进行非确定性盲点。
- 隐藏或不可见元素（`display: none`, `visibility: hidden`）立即拒止并返回 `TARGET_HIDDEN`。
- 快照过期或版本脱节返回 `SNAPSHOT_STALE`。

### 3.4 P0 `non_submitting` 策略与安全防护
- 会话默认或显式配置为 `non_submitting` 模式时，策略拦截器（`PolicyInterceptor`）会在动作执行点拦截一切具有变动风险的意图：
  - 拦截外域跳转请求与非标准协议（`javascript:`, `file:`, `data:`）；
  - 拦截危险变动路径（如 `/api/records/delete`, `/api/messages/send`, `/api/danger-get`, `/api/autosave`）；
  - 拦截带有变动语义的按钮与表单提交动作。
- 在 `packages/test-fixture` 的 FIX-07 验证中，审计接口 `GET /api/audit` 返回的事件计数严格保持为 `count: 0`。

### 3.5 等待机制与死循环防护
- **严禁依赖 networkidle**：由于长连接（如 SSE、WebSocket、持续轮询）会使 `networkidle` 永久挂起，本模块所有等待一律采用基于 DOM 状态的 `waitForState`（`dom_ready`, `element_visible`, `navigation`）。
- **死循环检测**：通过页面快照的 DOM 结构与文本指纹追踪，若连续 3 次执行完全相同的动作且页面指纹无任何变化，自动终止并返回 `REPEATED_ACTION_LIMIT`。
- **重试上限**：非破坏性恢复最多尝试 2 次，超限返回 `MAX_RECOVERIES_EXCEEDED`。

---

## 4. 稳定原因码对照表 (Stable Reason Codes)

根据架构契约，`ToolResult.reasonCode` 由两部分构成：
1. **6 个执行层专用原因码**：承载编排层（Orchestrator）与 Agent 自愈决策所需的细分现场语义；
2. **收敛至 `docs/03 §7` 标准词表的原因码**：用于通用策略、权限、验证与生命周期状态。

### 4.1 保留的 6 个执行层专用原因码及其处置语义

| 原因码 | 现场语义 | 编排层 / Agent 推荐自愈处置策略 |
| :--- | :--- | :--- |
| `TARGET_NOT_FOUND` | 目标节点在当前 DOM 或指定 Frame/Page 中未找到 | **重新观察或重定位**：可能因异步加载或滚动未到视口引起。建议 Agent 先执行 `wait_for` 或 `scroll`，再重新 `observe` 获取新 snapshot。 |
| `TARGET_AMBIGUOUS` | 目标描述存在多重候选匹配（count > 1），拒绝盲点 | **提高定位精度**：说明文本或泛化选择器存在歧义（如 9 个同名按钮）。建议 Agent 改用 `test_id`（`testid_*`）或结合父级容器限定 scope 定位。 |
| `TARGET_HIDDEN` | 目标节点存在于 DOM，但处于不可见/隐藏状态（`display:none`、`visibility:hidden`、尺寸为 0） | **前置交互或等待淡入**：说明元素当前未展示。建议 Agent 检查是否需先展开 `<details>` 折叠项、切换 Tab 标签页，或等待加载动画结束。 |
| `TARGET_DISABLED` | 目标节点带有 `disabled` 属性或 `aria-disabled="true"` | **满足表单/前置条件**：说明按钮或输入框处于不可交互态。Agent 应检查前置输入是否完整有效，不可盲目重复点击。 |
| `ACTION_TIMEOUT` | 单个浏览器动作或状态等待（如 `wait_for`、页面跳转）超时 | **诊断卡死或放宽等待**：可能因服务端长请求卡死或渲染延迟。Agent 可评估是否重试一次或标记该 step 发生超时。 |
| `REPEATED_ACTION_LIMIT` | 连续多次重复执行相同动作且页面指纹无变化（触发防死锁死循环机制） | **及时止损并阻断**：表明 Agent 陷入认知死循环或页面无响应。编排层应立即停止当前 Attempt，将用例判定为 `inconclusive` 或 `blocked`，防止 Token 消耗失控。 |

### 4.2 收敛至 docs/03 §7 词表的原因码对照

| 执行层原因码 | 收敛归属（docs/03 §7 对应项） | 原旧码收敛说明 |
| :--- | :--- | :--- |
| `POLICY_DENIED` | `POLICY_DENIED` | 收敛原 `PROHIBITED_TOOL`（禁用工具调用）与 `MUTATION_FORBIDDEN`（非提交模式破坏性写操作拦截） |
| `TARGET_NOT_ALLOWED` | `TARGET_NOT_ALLOWED` (422) | 目标 URL 属于外部域或非允许协议（`javascript:`, `file:` 等） |
| `VALIDATION_ERROR` | `VALIDATION_ERROR` (422) | 收敛原 `INVALID_TOOL_ARGUMENTS`（入参不符合 tools.schema.json） |
| `USER_CANCELLED` | `USER_CANCELLED` | 收敛原 `ACTION_CANCELLED`（AbortSignal 或用户主动中止） |
| `BROWSER_UNAVAILABLE` | `BROWSER_UNAVAILABLE` (503) | 收敛原 `BROWSER_ERROR`（Playwright 进程崩溃或底层协议失联） |
| `VERSION_CONFLICT` | `VERSION_CONFLICT` (409) | 收敛原 `SNAPSHOT_STALE` 与 `TARGET_SEMANTICS_CHANGED`（快照版本过期或页面突变） |

---

## 5. 测试与验证

### 5.1 本地 macOS 验证
```bash
# 构建源码
pnpm --filter @localqa/browser build

# 执行端到端浏览器自测试卷 (自动拉起 test-fixture 并跑通 11 项用例)
node --test packages/browser/test/browser.test.mjs
```

### 5.2 Linux 容器验证 (Playwright 1.63.0 Noble)
```bash
docker run --rm \
  --user pwuser \
  --cap-add=SYS_ADMIN \
  -v "$(pwd):/work" \
  -w /work \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e HOME=/home/pwuser \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  node --test packages/browser/test/browser.test.mjs
```

---

## 6. 当前限制与待集成说明
- **rrweb 视觉重放**：当前录制器中 rrweb 默认标记为降级（`status: "degraded"`），等待 T06 注入扩展接入。
- **全量探索验收**：当前通过了执行层与契约级的完备用例，完整端到端 AI 调度探索（Gate G2）需等待后续调度编排层（T04/T05）联调。
