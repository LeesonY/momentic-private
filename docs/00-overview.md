# 交付与决策索引

版本：1.0，日期：2026-10-02，状态：可进入开发、尚未实现。内部项目名 LocalQA；对齐 Momentic 的主要 Web 测试体验。

## 1. 已确认范围

| 决策 | 确认内容 |
| --- | --- |
| 产品核心 | 给出 URL，系统自行规划并执行有限范围的冒烟测试，输出证据、问题和覆盖缺口 |
| 部署 | 多人使用的内网 Linux 平台；Mac 可作为开发与访问客户端 |
| 模型 | 可调用外部模型 API；内部模型接口保留，但完全断网不是首期验收前提 |
| 交付 | 本次为需求、技术、契约和开发交接，不启动开发代理或创建新的 Momentic 测试 |
| 输入要求 | 不强制用户先写测试代码、YAML 或详细步骤；认证与业务预期可按需要补充 |

## 2. 交付物与权威顺序

1. 本文件的已确认用户决策。
2. `01-requirements.md` 的范围、行为和验收要求。
3. `contracts/` 的字段、枚举、请求响应、工具和报告协议。
4. `03-data-and-api.md` 的关联、事务与统计语义。
5. `02-technical-design.md` 的实现选择。
6. `04-validation.md` 与 `05-agent-handoff.md` 的测试和分工。

发现矛盾时必须修正文档和契约再集成，不能让各个模块自行解释。字段变化由契约负责人统一修改，更新例子及校验结果。API 与工具协议使用显式版本；P1 不得破坏已上线的 P0 协议。

契约源码为 `build_contracts.py`，使用标准库生成 `contracts/*.json` 和 `examples/*.json`。修改字段时先改生成器再生成、验证，不能仅手工改一个生成文件。这里的 Python 仅用于文档契约维护，不是运行平台的技术栈。

## 3. 分阶段范围

| 阶段 | 可交付能力 | 结束条件 |
| --- | --- | --- |
| M0 技术验证 | 真浏览器、模型适配、内部网址连通、结构化工具、证据采集、独立复现、容器沙箱验证 | 通过受控 fixture 的真实浏览器验证，形成兼容性记录 |
| P0 URL 冒烟平台 | 账号/项目权限、环境和认证、模型配置、URL 发起、探索和规划、执行、预算、停止、问题复现、报告与历史 | 完整经过 UI→API→任务→浏览器→模型→报告闭环，通过 P0 验收 |
| P1 主要 Web 功能完善 | 用例库/版本/YAML、回归重跑、定时任务、CLI/CI、定位缓存、知识和修复建议、操作审批与测试数据模板 | 主要 Web 工作流可长期使用，完成 P1 验收 |
| P2 扩展 | 移动端、仓库 diff、外部 MCP、SSO、远程交互浏览器、大规模集群、外部 Bug 系统集成 | 按独立需求及技术验证立项 |

P0 包含基本项目知识文本，不包含向量检索和自主学习。P0 默认非提交式冒烟，不自动进行业务写入；P1 才实现经过授权、带数据准备和清理的业务流程测试。P1/P2 的页面不能以假数据假装已经实现。

## 4. 架构决策记录

| ADR | 本项目决定 | 原因与约束 |
| --- | --- | --- |
| ADR-001 | Linux Docker Compose 作为 P0 生产部署基线 | 满足多人内网使用；集群不是首期必要条件 |
| ADR-002 | TypeScript/Node 24 LTS，React 稳定版 UI，独立 API 和 Worker | 浏览器、工具和模型生态统一；长任务不放在前端请求生命周期中 |
| ADR-003 | PostgreSQL 18 保存业务数据、任务租约和事件 | 多用户事务、权限与恢复使用同一权威状态；P0 队列不依赖外部 SaaS |
| ADR-004 | 任务表、条件更新、fencing token、心跳；LISTEN/NOTIFY 仅唤醒 | 队列通知可丢，数据库事实不可丢；不承诺浏览器动作 exactly-once |
| ADR-005 | Playwright/CDP 为执行基础；AI 通过受控工具调用 | DOM/无障碍树优先，截图补充；模型不执行任意代码 |
| ADR-006 | 自有 ModelPort；外部 API 由后端代理和管理员配置 | 可适配不同提供方；API key 不下发前端或浏览器进程 |
| ADR-007 | P0 文件证据存储，ArtifactStore 接口预留 S3-compatible | 单 Linux 主机可部署；扩容时替换存储而非报告协议 |
| ADR-008 | HTTP API + 可恢复 SSE；事件写库后发布 | 断线重连可恢复；不把 UI 内存状态当运行事实 |
| ADR-009 | 用例、执行结论、问题、复现、人工审查分别记录 | 防止重复执行覆盖历史，也避免把“已检查”解释为“通过” |
| ADR-010 | 自动冒烟用一般技术契约；业务规则必须来自用户/知识/固定用例 | URL 无法自动证明任意业务正确；推测只能形成待审查观察 |
| ADR-011 | 默认有限范围、非提交动作；未知副作用停止或跳过 | 页面内容不构成动作授权；不对任意网站承诺绝对无副作用 |
| ADR-012 | 具体实现版本在 M0 锁定；不采用观测到的 React Canary 作为生产要求 | 复制能力而非实验依赖；浏览器包与容器镜像版本必须匹配 |

## 5. 证据、推断和选型

已确认的 Momentic 技术：Astro 官网；Next.js/React 应用；官方 Web CLI 使用 Playwright/CDP、Express/Socket.IO、AI SDK/Zod；Mo 页面接入 Trigger.dev；有 rrweb 回放与多角色任务。三类已有任务记录标注 `gpt-6-luna`，不能据此固定本项目模型。

未确认的 Momentic 内部实现：数据库、完整 Worker 语言与隔离方式、对象存储供应商、全部模型路由。本项目的 PostgreSQL、数据库任务队列、权限和存储设计是自研选择，不是假称复原了它的服务端。

新核查来源：[Mo brief](https://momentic.ai/docs/mo/brief)、[会话与认证](https://momentic.ai/docs/mo/sessions)、[报告](https://momentic.ai/docs/mo/reports)、[Playwright 容器](https://playwright.dev/docs/docker)、[Node 版本周期](https://nodejs.org/en/about/previous-releases)、[PostgreSQL 支持周期](https://www.postgresql.org/support/versioning/)、[PostgreSQL SELECT](https://www.postgresql.org/docs/18/sql-select.html)、[AI SDK 工具](https://ai-sdk.dev/docs/foundations/tools)。

## 6. 实现前必须完成的验证

- 选定模型对工具调用、JSON 输出、图像输入和中文页面的兼容性；不只测接口连通。
- Playwright 包和镜像版本、非 root Chromium 沙箱、字体、内网 DNS、代理和证书。
- PostgreSQL 租约抢占、工作进程中断、事件断线恢复和浏览器动作结果不明的处理。
- 认证资料不进入模型、日志和导出包；页面脱敏不能误改测试判定。
- rrweb 与 Playwright trace 的容量及页面兼容性。

以上是开发 M0 的工作，不是本文已验证的产品结果。硬件容量、模型稳定性、业务准确率和 Linux 容器运行尚未实测。
