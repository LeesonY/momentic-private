# T16 · 真实模型误报控制、复现失败降级和中断安全

## 已完成的功能

- `packages/orchestrator/src/core.ts`：复现结论必须使用服务端持有的
  `case_attempts.context_id`、首次有效 `issue_found` Verdict、
  `finding_evidence` 和本次新证据进行独立性核验，而不是信任模型或
  Worker 声称的 `freshContext=true`。缺乏独立证据时不得
  `confirmed`；复现通过时改为 `unconfirmed`，受阻时为 `blocked`。
- `apps/worker/src/index.ts`：目标返回 HTTP 5xx、401 或 403
  时不再以缺失的普通 DOM 元素作为原功能缺陷再次发生的证据。
  对非 HTTP 状态断言标为 `not_evaluated`；**明确要求状态码的用例
  仍正常比较状态码**。
- Reproducer 被取消、租约中断或 Worker 停止，且不能生成完整有效
  Verdict 时，原 `suspected` Finding 被明确标为 `blocked`。
  不伪造复现对象或截图，保留原有失败证据和完整审计事件。

## PostgreSQL18 + Chromium + Pi 真实模型专项

命令：`pnpm test:t16-real`。
采用现有授权 Pi `moan2 / mofree-m1`；供应商响应模型 ID 为
`MiniMax-M3`。用户验收要求预先冻结为 `user_spec`，首轮故障页
缺少 `checkout-success` 标记。

| 场景 | 首次 Verdict | 独立复现 Verdict | 复现记录 | Finding | 结果 |
| --- | --- | --- | --- | --- | --- |
| 首次失败、恢复后通过 | issue_found | passed | not_reproduced | unconfirmed | 通过 |
| 首次失败、复现时 503 | issue_found | blocked | blocked | blocked | 通过 |
| 首次失败、Reproducer 中断 | issue_found | inconclusive | 无有效复现对象 | blocked | 通过 |

第一场景真实模型请求 10/10 结算，7 个浏览器动作、3 份证据。
第二场景 11/11 结算，8 个动作、2 份证据。
第三场景 8/8 结算，4 个动作、1 份证据，Run 完成度为
`partial`，明确表示工作中断。每个场景都检查 Finding 曾进入
`suspected`，并对最终数据库状态作强断言。

对第二场景，Run 的 `completion=complete` 只表示任务调度已走完，
**不表示原功能缺陷已确认或测试断言已通过**。Finding 的
`blocked` 和独立 Verdict 的 `blocked` 才是复现结果。

## 能力边界

- 测试使用受控的静态结账页面与提前确定的业务预期；证明真实模型
  参与下的判定、降级、独立复现链路，不证明无规范条件下自主发现率。
- T16 中断场景通过受控 Worker 停止流程模拟，非操作系统硬杀或
  生产级故障注入；多次随机网络抖动和真实第三方业务站点未覆盖。
- 每次启动隔离数据库容器、本地 HTTP fixture 和 Chromium 会话，
  清理测试数据，不修改 Pi 配置、业务数据库或其他业务容器。
