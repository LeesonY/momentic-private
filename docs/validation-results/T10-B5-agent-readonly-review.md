# B5 只读审查（完整原文）

审查范围到 2026-10-05 19:28 观察到的 worker dist 为止。其后的保存、批准、回归冒烟，以及 `originCriteria` / `saved_case` 重绑，不在本次审查内。

## 源码边界

Git HEAD 是 `f1dad77d09077536a269896d8247ba18dd0dcc0d`。当时审到的 B5 逻辑在未提交工作区里，不在这个 commit 里。

审查当次读到并核对过、且现在 mtime 仍早于后续改动的文件：

| 文件 | 当时/现在 mtime | SHA-256 |
| --- | --- | --- |
| `apps/worker/src/regression-ai.ts` | 2026-10-05 19:26:30 | `7e5e037899b625428ec0834cb5842be8851f3613d22bbf033f832a52b48f3be4` |
| `apps/worker/src/regression-replay.ts` | 2026-10-05 19:01:28 | `7c00a289a80c8e79794aba8a6c6ef66d04ed773229166a719c8c775ef026f1a7` |
| `packages/orchestrator/src/core.ts` | 2026-10-05 16:37:27 | `769af7ae784fbf86a8baa9e17510ada485e50281078edf421846a4a3725a8fb1` |
| `packages/domain/src/index.ts` | 2026-10-02 19:52:33 | `a6b275e7a86cfad37f30777349aefbf7764bbb5e723cd53060b9a956401d2d38` |
| `packages/model-gateway/src/gateway.ts` | 2026-10-05 15:32:16 | `bd390c5a3808c06ee8154f2819902e461e751fe45278f3b474fd8ca42e826a7f` |
| `packages/browser/src/policy.ts` | 2026-10-02 20:45:33 | `421ecdb4c4b691501a4e784398d2e501de36c4ae271a338f8fff33fd863294c6` |
| `packages/browser/src/executor.ts` | 2026-10-02 20:45:33 | `5064d18298ec85c18b399f6500aca53f37b63a3f61960cb28660c56ec39d6338` |
| `packages/browser/src/regression-locator.ts` | 2026-10-05 15:05:35 | `511539cb004bf0fffcf7d106d3315a8c82f1160d796bf18d714605f00c202dce` |
| `apps/worker/test/regression-replay.test.mjs` | 2026-10-05 13:33:30 | `fc7f473bd9e9ded0d61494a31ef97bbe94e23c4426897392a68db776fa334d49` |

审查当次看到的 `apps/worker/dist/index.js` 与 `apps/worker/dist/regression-ai.js` 的 mtime 是 2026-10-05 19:28。当时 dist 含 4 轮循环、`AI_STEP_LIMIT`，以及 `assertion.errorCode === null`。没有记录那份 dist 的内容哈希。

以下文件在审查之后又写入，当前字节没有审过，当前哈希也不代表审查对象：

- `apps/worker/src/index.ts`，mtime 2026-10-05 19:42:54
- `packages/orchestrator/src/regression-compiler.ts`，mtime 2026-10-05 19:42:54
- `apps/worker/dist/index.js` 与 `apps/worker/dist/regression-ai.js`，mtime 2026-10-05 19:42:56
- `apps/worker/test/t10-b5-fakebrowser.test.mjs`，mtime 2026-10-05 19:38:46。审查时读过其中的 FakeBrowser、AI、视觉和预算用例，但不能把这个较新的 mtime 当成已审字节。

`originCriteria` 现在出现在 `apps/worker/src/index.ts`、`packages/orchestrator/src/regression-compiler.ts`、`packages/orchestrator/src/regression-plan.ts`。审查读源码时没有这个符号，没有审它的语义，也没有看保存、批准、回归冒烟，更没有看正在复跑的 14 项。

## 结论

在上述边界内，没有看到能把未通过的断言写成通过、或让 AI 工具绕过 `grant` 再执行的明确缺口。

本轮只读源码和当时的 dist，并跑了无浏览器的 replay 端口测试 15/15。没有复跑 Root 当时所说的 FakeBrowser PG 13 项。没有改代码。

## 已核对

断言不看 `requestResult === 'ok'`，也不看原始 `data.result`。回归评估在当时的 `apps/worker/src/index.ts` 只在同时满足这些条件时采纳判定：`errorCode === null`、`assessment.criterionId` 等于当前冻结准则、`criterionResult` 有值、`acceptedEvidenceRefs` 非空且每一项都在本任务已知集合里并属于本次 capture。

Gateway（`packages/model-gateway/src/gateway.ts` 的 `assessCriterionOutput`，文件哈希见上表）对合法引用的处理是：`result: 'passed'` 时 `requestResult` 为 `passed`，`result: 'failed'` 时为 `issue_found`，这两种的 `errorCode` 仍是 null。空引用变成 `not_evaluated` 且 `acceptedEvidenceRefs` 为空，原因码 `NO_OBSERVATION_REF`。未知引用变成 `FAKE_EVIDENCE`，引用同样被清空，`criterionResult` 为 `not_evaluated`。`result` 不是 `passed|failed|not_evaluated|unknown` 时为 `MALFORMED_JUDGMENT`。视觉且 `imageInput` 为 false 时为 `MODEL_CAPABILITY_MISSING` / `blocked`，`errorCode` 取该原因码。视觉且 `imageTransmitted === false` 时为 `NO_OBSERVATION_REF`。因此原始 `passed` 盖不过空引用、未知引用或缺失的 assessment。

`verdictStatus`（`packages/domain/src/index.ts`）只有每条准则都是带非空证据的 `passed` 才返回 `passed`。存在带证据的 `failed` 时返回 `issue_found`。`not_evaluated` 或阻断原因走 `blocked`，其余为 `inconclusive`。证据 id 不在当时的 owned 集合里会抛 `INVALID_CRITERIA_OR_EVIDENCE`，不会当成通过。

AI 决策循环（`apps/worker/src/regression-ai.ts`）仍要求 `requestResult` 为 `ok` 或 `repaired`。这只用于 `generateDecision`。同一文件里的 gateway 在非 assert 成功路径返回 `ok` 或 `repaired`。断言走 `evaluateCriterion`。两套结果名没有混用。`done: true` 在执行该轮 `toolCalls` 之前返回，只结束循环，不把准则标成通过。准则要等 `aiAction` 正常返回后，由 replay 再调用 `evaluateCriterion`。

默认 AI 是 4 轮。每轮开头检查 `signal.aborted`，然后 `executeTool({ name: 'observe' })`，要求 `observation.redacted`，再 `decide`。`data` 必须只有 `done` 与 `toolCalls`，`done` 为布尔，`toolCalls` 为数组且长度不超过 4，否则 `VALIDATION_ERROR`。`done` 为 false 且工具为空则 `AI_NO_PROGRESS`。每个工具经 `createPolicyDispatcher`：ToolCall schema、`toolsForRole`、未知 `evidenceRefs` / `artifactId`。通过后才进入 replay 的 `executeTool`，再到 Worker 的 `grant`、浏览器、`record`。dispatcher 拒绝或浏览器未成功会抛错并停住该步。第 4 轮若仍未 `done`，该轮已经发出的工具会先记完，然后抛 `AI_STEP_LIMIT`。replay 把这个失败收成该步结果，准则保持未写入，收尾时变成 `not_evaluated`，后续 DSL 不再执行。

`apps/worker/src/regression-replay.ts` 里，`ai_action` 使用的 `execute` 与固定 DSL 是同一个 `invoke`：解析并冻结 ToolCall、拒绝并发、把回执记入该步、非 `succeeded` 即停。`aiAction` 返回后先把 `activeStep` 设为 false，再检查是否还有未完成调用，然后才 `evaluate()`。评估使用该步编译进来的准则对象，id 对不上即 `CRITERION_ID_MISMATCH`，`result !== 'passed'` 即停止后续步骤。失败、未知、未评估、端口异常和取消都会粘住。

权限与预算，依据当时的 `packages/orchestrator/src/core.ts` `grantAction`：回归里 `executor` / `reproducer` 的 `click` 和 `type_text` 不走 `validateBrowserTool`。该函数只允许 `explorer` / `executor` / `reproducer` 的 `observe` / `navigate` / `capture`，所以 click 必须走这条回归分支才能执行。`grant` 仍要求 `RegressionStepSource` 的哈希对上 `createRegressionPlan` 的某一步。非 `observe` / `capture` 且该步不是 `ai_action` 时，工具名、navigate URL、type_text 文本必须与该步一致。带 `target` 的调用还要求快照属于当前 project/run/task、节点存在，且与最近一次非 capture 的成功结果哈希一致。对不上是 `NOT_FOUND` 或 `VERSION_CONFLICT`，发生在 `reserve` 之前。`action_intents` 条数达到 `maxActionsPerCase` 时为 `BUDGET_EXCEEDED`。通过后才 `reserve` 一个 action 并写入 intent 与 status 为 `running` 的 step。`navigate` 不在 click 豁免里，仍经 `validateBrowserTool` 做 origin 与路径检查。

模型预算在 `BoundModel` 的 `budgetAdapter.send`：先 `reserve` `modelCalls` 和 token，再 `delegate.send`。预算不足抛 `BUDGET_EXCEEDED`，provider 不会发出。AI 每一轮是先 observe 再 decide，所以模型预算已经用尽时，provider 发送数是 0，但该轮开头的 observe 已经 grant 并执行。当时读到的 B5 测试把这个顺序写成浏览器事件只剩 `['observe']`、`model_requests` 为 0、且 transport 抛错也不应被调用。那是测试锁住的行为，不是误通过。这次审查没有复跑该 PG 用例。

冻结准则：当时读到的 `packages/orchestrator/src/regression-compiler.ts` 只把该步 `criteriaIds` 关联进 `criteria`，未知 id 直接失败。Worker 评估把这个准则对象交给 `runtime.model`，角色为 `assertion`、purpose 为 `assert`。`BoundModel.loadFrozen` 再从 `run_cases` 里 `frozen` 的文档按 id 取准则，取不到则 `NOT_FOUND`。Gateway 在按 token 裁剪消息之后追加 `frozenCriterion`，`assessCriterionOutput` 用的是 `input.criterion.id`，不是消息里另写的期望值。AI 的 decide 提示会带上编译进该步的准则，包括 `expectedValue`。当时的 B5 测试明确断言 `input.criteria[0].expectedValue === 'done'`。提示里的准则只作为观察数据。`done` 不写 verdict。

技术准则不经过这套 assessment。`http_status`、`url_matches`、`element_visible`、`text_equals` 用授予过的 observe 快照或唯一拥有的节点做比较。对不上或定位失败时保持 `unknown`，replay 不会把它当成通过。当时 B5 的 `ai` 夹具把准则种类写成 `text_equals`，所以那条 AI 通过走的是 DOM 精确比较，不是断言模型。`semantic` / `visual` 才走 assessment。视觉消息在 `kind === 'visual'` 时附加 `{ type: 'image', artifactId: captured.id }`。缺文本的 semantic，或 capture 被拒绝时，在调用模型之前返回，测试锁的是模型调用次数 0。

浏览器侧：Worker 创建 session 时 `mode` 为 `non_submitting`。真实 executor 对 navigate 调用 `checkNavigationUrl`，对动作调用 `checkAction`（危险变更、受限路径、删除/发送类按钮）。这是当时读到的 `packages/browser/src/policy.ts` 与 `executor.ts`。FakeBrowser 的 `executeTool` 不调用这套 policy。`resolveRegressionLocator` 用当前快照和页面句柄做唯一可见主框架匹配，不另开浏览器；对不上抛 `LOCATOR_NOT_OWNED_OR_AMBIGUOUS`。Worker 在 catch 里把定位失败当成不能通过。它本身不是一次 `grant` / `record`。`getSnapshot()` 只用于和刚授予的 observe 核对 snapshotId。

取消：replay 和 AI 循环以及 `execute` 在 grant 前、grant 后浏览器前都会看 `signal`。grant 后、浏览器前 abort 会 `record(..., 'cancelled')`。浏览器调用抛错会 `record(..., 'failed')`。浏览器已经返回成功之后才 abort，当时的 `execute` 在 `record` 之前抛 `CANCELLED`，这条路径本身不写 record。replay 因 abort 收成 cancelled 后，Worker 再抛 `CANCELLED`，外层 `stop` 走 `interrupt`：pending intent 改为 `unknown`，仍为 `reserved` 的预留按 unknown 计入 used。`interrupt` 不改写 step 文档。这次没有跑这条竞态。

本轮执行的纯测试是 `apps/worker/test/regression-replay.test.mjs`，导入的是当时的 `apps/worker/dist/regression-replay.js` 和 `@localqa/orchestrator` 的 `compileRegression`。15/15，duration_ms 173.632042。覆盖的端口行为包括：固定步骤顺序、模块来源、AI 与随后的冻结准则、缺 AI adapter、准则失败/未知/未评估停下、工具失败不泄漏异常文本、取消、共享假预算耗尽且吞掉的拒绝仍粘住、AI 后准则失败与错误 id、未 await 的工具、并发调用只有第一次进端口、评估期间收回逃逸回调、完成后的 AI 能力不能进入后步或取消后的执行、后一步固定 DSL 执行时逃逸工具进不了端口、非法目标和解析期间取消不进工具端口。这是注入端口，不连 Postgres，不开浏览器，也不是 Worker.once。

当时 dist 与源码的对应关系只核对了两处字符串：`regression-ai.js` 有 `for (let round = 0; round < 4; round++)` 和 `AI_STEP_LIMIT`；`index.js` 有 `assertion.errorCode === null`。没有做整文件 diff。

## 未验证

没有复跑 FakeBrowser PG 13 项，没有启动浏览器、worker-entry 或外部模型。真实 Playwright 的 `non_submitting` 拒绝、租约中途失效，以及“浏览器已成功返回之后 signal 才 abort”都没有跑。

另一个没有触发的错误路径：浏览器状态已是 succeeded，但 `data` 不是合法 `BrowserSnapshot` 或 `Artifact` 时，`parseContract` 在 `record` 的 try 之外抛出。replay 吞掉异常后仍会 `finish`，不会走 `interrupt`。这次预留可能继续停在 `reserved`，step 继续停在 `running`。这不是误通过。当时认为成功路径返回的是完整快照和 Artifact，这条路径不会走到。19:42 之后的 dist 没有再验证这一点。

`Worker` 构造选项里的 `regressionAiAction` 可以替换默认 4 轮实现。审查时全仓库只有 `apps/worker/src/index.ts` 引用它，默认是 `createRegressionAiAction`。没有执行 worker-entry，不知道进程入口是否传入别的实现。

ego 未使用。这次审查没有启动或删除容器。

## 明确不在本次审查内

Root 在这次审查之后增加的存储冒烟（保存、批准、回归测试）、`plan` 把 `sourceKind` 重绑为 `saved_case`、用 `originCriteria` 保留批准来源语义、不改冻结 `Case.criteria`、Worker 复用原领域 oracle、以及 5xx 不通过，都没有读、没有跑、没有下结论。正在复跑的 14 项也不是这次的 15 项 replay 测试，不能把 15/15 写成那 14 项的结果。
