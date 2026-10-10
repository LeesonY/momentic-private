# scripts

## 通用入口

| 文件 | 用途 |
| --- | --- |
| `test-unit.mjs` | `pnpm test` / `pnpm ci` 运行的纯 Node 测试清单：不需要 PostgreSQL、Docker、Chromium 或模型；文件头列出了被排除的测试及原因 |
| `acceptance.mjs` + `acceptance-tasks.json` | 阶段验收任务运行器：`pnpm acceptance --list` 查看，`pnpm acceptance <任务名>` 运行 |

## 阶段验收脚本（T14–T38）

这些脚本是各阶段验收的复现材料，对应 `docs/validation-results/` 中同编号的报告，按原路径保留以便与证据对照。任务名与旧的根 `package.json` 命令一致：历史报告里的 `pnpm test:t27-actions` 现在写作 `pnpm acceptance test:t27-actions`。

运行前先读脚本头部注释和对应报告：大多数脚本要启动隔离的 PostgreSQL 18 容器和 Chromium，标注为真实模型（G3）的脚本会调用外部供应商并产生费用。

| 类别 | 脚本 |
| --- | --- |
| 真实模型 G3（需已授权的供应商 Key） | `t14-real-moan2`、`t15-real-finding`、`t16-real-nonconfirm`、`t17-real-interactive`、`t18-real-interactive`、`t19-real-auth-deepseek`、`t25-g3-pilot`、`t25-g3-breadth`、`t26-real-flow`、`t26-g3-diverse-matrix` |
| 确定性 G2 协议对照（合成模型，不计入模型质量） | `t17-wire-interactive`、`t18-wire-interactive`、`t26-wire-flow`、`t26-g2-matrix`、`t33-wire-dialog`、`t34-wire-dom`、`t36-wire-lifecycle` |
| 认证负例与 OTP 流程 | `t20-auth-negative`、`t21-auth-negative`、`t22-auth-otp`、`t23-cancel-otp`、`t23-long-otp`、`t23-web-otp`、`t24-auth-negative`（子进程夹具 `t24-auth-worker-child`） |
| 只读审计与报告（读取既有账本） | `t25-g3-report`、`t26-g3-coverage`、`t32-independent-audit`、`t35-g3-audit`、`t35-g3-report`、`t36-audit-lib`、`t36-independent-audit`、`t37-independent-audit`、`t38-independent-audit` |
| 模型请求上限 | `t32-model-request-bounds` |

`*.test.mjs` 是对应审计库或上限逻辑的测试，通过 `pnpm acceptance test:t32-bounds`、`test:t35-audit`、`test:t36-audit`、`test:t37-audit`、`test:t38-audit` 运行。
