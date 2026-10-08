# T10-AUTH-4B private execution 补案（只读，未冻结）

日期 2026-10-07。P0Passed false。浏览器暂停。产品模型 0 次调用。本文只补 AUTH-3 修订 3 没有落到可执行接口的缺口。完整认证设计仍未冻结。AUTH-4A 只验收 `validateApprovedAuthState`。不改产品、不跑 browser / worker-entry / provider / 迁移。本节修订不实施；4C 若以后做，也只能先写 FakeBrowser 双份端口，浏览器暂停期间不许改真实 `session.ts`、不许启 Playwright。

## 1. 现状接口（事实）

| 调用 | 现在 |
| --- | --- |
| `BrowserSession.executeTool(toolCall: ToolCall)` | 唯一执行入口。`ToolCall` 没有 `navigate_auth` / `submit_auth` / `fill_credential` / `import_storage_state`。 |
| `executor` `type_text` | 要求 `args.text`，写入页面。 |
| `BrowserPort.createSession` | cookies 走 `addCookies`。`origins[]` 对每个 origin `newPage` + `goto` + `localStorage.setItem`，失败 `.catch(() => {})`。无 grant。 |
| `createSession` + `enableTrace` | `context.tracing.start({ screenshots: true, snapshots: true })`。Worker 现传 `enableTrace: false`，但端口仍可打开。 |
| `snapshot.ts` | 只把 `type=password`、hidden、`autocomplete=current-password/new-password`、`data-sensitive` 的 text 换成 `[redacted]`。username / OTP 普通输入框不在此列。 |
| `Coordinator.grantAction` | 只收 `ToolCall`。除 `navigate` 红 URL 外，整个 call 写入 `action_intents.tool_call`。`ActionGrant` 不能当 `grant()` 的 source。 |
| `recordAction` / `finish` | 同一 fencing 才结算；相同 `result_hash` 幂等；hash 不同 `IDEMPOTENCY_CONFLICT`。 |

把认证名送进 `executeTool` 不是合法 `ToolCall`。把密码送进 `type_text` 会落库。

## 2. 私有四动作

不新增 `ToolCall`，不改 `tools.schema`。模型仍不能填 password / OTP。`type_text` 规则不变：只有模型或回归 DSL 的可见文本走 `grant(ToolCall)`，原文仍进 intent。认证适配器禁止构造认证名或带 secret 的 `ToolCall`。

Server 批准的 permit **没有 secret**：

```ts
interface AuthPermit {
  grantId: string;
  taskId: string;
  runId: string;
  fencingToken: number;
  contextVersion: number;
  workerId: string;
  sessionId: string;
  deadline: string; // <= 当前 leaseUntil
  action: 'navigate_auth' | 'fill_credential' | 'submit_auth' | 'import_storage_state';
  slot: 'login_url' | 'username' | 'password' | 'otp' | 'submit' | 'storage_state';
  target?: NodeTarget;
  url?: string; // 仅 navigate_auth，等于冻结 loginUrl
}
```

执行参数（secret 只在 effect，且只在本进程）：

```ts
type AuthEffect =
  | { kind: 'navigate' }
  | { kind: 'fill'; secret: string }
  | { kind: 'submit' }
  | { kind: 'prepare_state'; state: ApprovedAuthState };

interface BrowserSession {
  executeAuth(
    permit: AuthPermit,
    effect: AuthEffect,
    signal: AbortSignal,
  ): Promise<{ snapshot: BrowserSnapshot | null }>;
}
```

`executeTool` 保持只收 `ToolCall`。`executeAuth` 不调用它。内部复用现有原语，映射是：

| Auth action | effect.kind | 复用的现有原语 | 禁止 |
| --- | --- | --- | --- |
| `navigate_auth` | `navigate` | `executor` 里 `navigate` 的 `page.goto` | 不发 `ToolCall.name='navigate'` 或 `'navigate_auth'` |
| `fill_credential` | `fill` | `type_text` 的定位与填写 | 不发 `ToolCall`；`secret` 不进 args |
| `submit_auth` | `submit` | `click` 的定位与点击 | 不发 `ToolCall.name='click'` 或 `'submit_auth'` |
| `import_storage_state` | `prepare_state` | `addCookies` + init script（§4） | 不 `goto`，不发 `ToolCall` |

`observe` 仍是普通 `ToolCall`，只给 locator。`grantAuth` 返回 `AuthPermit` + 内存中的 `AuthGrant`（仍无 secret）。`recordAuth(proof, permit, status, snapshot)` 写 AuthAction，不写 ToolCall。

`RuntimeClient.material(proof)` 提供 username/password。`consumeOtp(proof)` 只在本尝试的那一张票上返回一次 `code`。storage JSON 只进 `prepare_state`。

## 3. permit、同进程一次、崩溃

Proof = `taskId + leaseToken + fencingToken + contextVersion + workerId`。heartbeat 只延长 `lease_until`，不换 fencing。不宣称跨进程 exactly-once：浏览器副作用和数据库不在同一个事务里，另一个进程看不到本进程的执行锁。

`executeAuth` 在任何页面副作用之前检查：

1. `permit` 与当前 proof 的 task/run/fencing/context/worker 一致，且 `permit.sessionId === session.id`、`session.taskId === permit.taskId`。否则不执行。
2. `now < deadline` 且 `signal` 未 abort。否则不执行。
3. 本进程 `Map<grantId, 'running' | 'done'>`：已是 `running` 或 `done` 则拒绝（`VALIDATION_ERROR`），不第二次填写/点击/导航。
4. effect 与 permit 一致：`fill` 只允许 `fill_credential`；`submit` 只允许 `submit_auth`；`navigate` 的 URL 用 permit.url，不从 effect 另带 URL；`prepare_state` 只允许 `import_storage_state`。

然后才跑 §2 的原语。返回后适配器立刻丢掉 `secret`。`recordAuth` 仍要求 fencing 等于 intent 行；相同 `result_hash` 幂等；不同 hash `IDEMPOTENCY_CONFLICT`。

崩溃：进程内 Map 消失。库里的 pending intent 由现 `recoverExpired` 收成 `unknown` 并扣 `actions:1`，job `interrupted`。不自动重放导航、填写、提交或导入。新 fencing 不能 record 旧 grant，也不能消费旧 OTP 票。

`finish` 仍拒绝本 task 仍有 pending intent。capture 与 finish 的 capturing task/fencing/worker/context 必须等于同一 proof。

## 4. 一次 OTP，失败即结束

对齐 AUTH-3：第一次 `submit_auth` 之后，仅当 `otpTarget` 当前可解析，才允许 **一张** 票、**一次** `fill` slot=otp、**一次** 第二次 `submit_auth`，然后才 `successCriterion`。

本认证 job 禁止：

- `applyCredential` / 第二次 submit / 成功条件失败后再 `pauseForOtp`
- 同一 job 里第二张票或第二次 otp fill
- 失败后在旧 job 自循环

失败：`recordAuth(..., 'failed')`，`AUTH_FAILED`，关 session；尚未 granted 则按 AUTH-3 释 run 锁并作废未消费票。已 `consumeOtp` 的票不退。

新票只存在于协调器显式新建的认证 attempt（新 job、新 proof）。那不是旧 job 的重试循环。`pauseForOtp` 仍不得调用现 `waitForInput`（会放 lease）。

## 5. 导入状态与脱敏生命周期

`prepareApprovedState` 只作为 `executeAuth(..., {kind:'prepare_state'})` 的内部步骤：`validateApprovedAuthState`，然后 `addCookies`。导航次数 = 0。localStorage 不在这里 `goto`。

init script 源码是固定函数，**不得**把 cookie/value/storage 拼进脚本文本。值只作为浏览器上下文参数，且仅在 §5 的 trace 已关闭之后注册。后续写入发生在下一次已 grant 的 `navigate` / `navigate_auth`（占 `actions:1`，origin 已冻结）。禁止空 catch。

现 snapshot 只认 password 控件，挡不住 username、OTP、普通文本框、截图和 trace。认证 job，以及任何调用 `prepare_state` / import 的 session，从 `createSession` 到 `close`：

| 通道 | 规定 |
| --- | --- |
| trace | `enableTrace` 必须 false。禁止 `tracing.start({ screenshots, snapshots })`。已开始则 stop 并丢弃文件，不上传。 |
| 截图 | 认证尝试期间不调用 `captureScreenshot`。若成功条件必须留证据，先遮住本次 fill 的全部 target（含 username/otp，不只 password），再编码；未遮罩的 PNG 不进 artifactsDir。 |
| snapshot | `recordAuth` 前按本次 permit.target 把对应节点的 `text`/`name` 置为 `•`。不看 `input.type`。 |
| 网络摘要 | 不记录 body、query。只留 method + origin。 |
| 日志 / 异常 | message 只有常量码，不拼接 secret、cookie、storage、页面文本、脚本源码。 |
| init script | 源码常量；值不出现在脚本字符串里。trace 关闭之后才注册。 |

session close 后不保留 trace zip 或未遮罩截图。

## 6. capture / import 约束

沿用 AUTH-3：初始化期独占 auth lease；granted 后主体是 `(run_id, auth_epoch)`。

| 操作 | 允许 | 拒绝 |
| --- | --- | --- |
| 认证 job 的 `executeAuth` | 当前 proof，且 permit 绑定该 session | proof/session/deadline 不符：不执行 |
| exclusive 的首次 `navigate_auth` 或 `prepare_state` | 锁 `initializing` 且 auth_lease 等于该 proof | 否则 `LEASE_EXPIRED` / `POLICY_DENIED` |
| shared 的 capture / prepare | 不查锁 | 仍查 proof、origin、容量、permit |
| capture / finish | 同一认证 proof | 旧 fencing `LEASE_EXPIRED`；同 proof 不同 fingerprint `VERSION_CONFLICT` |
| 子 task import + `prepare_state` | 该 task 自己的 proof。exclusive 还要 `phase=granted` 且 `auth_epoch===import_epoch` | 兄弟 task 结束只 `ended_at` 自己的 import 行 |

## 7. 后续阶段（未派发）

浏览器暂停：不许跑 Playwright，不许改真实 session 实现。模型 0 次。

| 阶段 | 可验证 | 不做 |
| --- | --- | --- |
| 4B | 本文 | 代码 |
| 4C | FakeBrowser 双份 `executeAuth`：四动作都不产生 `ToolCall`；prepare 导航次数=0；同 grantId 第二次调用不执行；secret 不在 snapshot 字符串里 | 不改 `session.ts`，不启浏览器，无 PG |
| 4D | PG：intent 无 secret；同 hash 幂等；换 fencing 不能 record；一 job 一票；失败不再 pause；pending 不 finish | 无浏览器、无 provider |
| 4E | 适配器只走 `executeAuth`；`type_text` 仍只记录调用方自己的 text；模型请求数=0 | 真实 provider、Playwright |

4C 不先于设计冻结。4E 依赖 4C 与 4D 都由 Root 另派。
