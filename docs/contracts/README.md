# 契约使用说明

本目录是 LocalQA 自有 v1 协议，不能当作 Momentic API 文档。

| 文件 | 用途 |
| --- | --- |
| domain.schema.json | 共享实体、输入输出、预算和字段定义，JSON Schema 2020-12 |
| openapi.json | P0 公共及 Worker 内部 HTTP 接口，OpenAPI 3.1；Internal tag 不向前端生成 client |
| tools.schema.json | 模型可提出的工具名与参数；x-roles 是必须由运行时执行的许可标记 |
| report.schema.json | 完整报告、问题、复现、材料引用与统计 |
| events.schema.json | SSE event envelope 与各 type 的 payload |
| regression.schema.json | P1 自有回归 DSL；不表示 P0 已实现回归执行 |

源码为上级目录 `build_contracts.py`。生成文件可被客户端/服务端代码生成工具读取，P1 接口增加时统一修改源码和文档。运行时自己的 Zod/TypeScript 定义必须与这些 JSON 契约等价；禁止另建同名但字段不同的对象。

JSON Schema 可以验证形状，不能单独验证权限、跨记录归属、当前租约、动作副作用、前提等价、证据真实性和聚合统计。它们必须在 domain/policy/repository 实现，验收方案有对应测试。

特别约束：

- `additionalProperties:false` 对输入适用，未知字段报 VALIDATION_ERROR，不默默忽略。
- InputResponse 还须按所回应 InputRequest.kind 做业务验证；approve 不能变为无限授权。
- Form auth 必须有成功条件；secretInput 是 write-only，storageState 以 JSON 字符串输入并进一步验证 origin/容量。
- Criterion.expectedValue 的实际类型随 kind 验证；url_matches 只接受受限模式，不执行用户提供的表达式。
- Artifact 有 task/step/case/snapshot 归属。判定只能引用本次有效观察，不能用另一项目或原失败的材料冒充独立复现。
- 队列动作和工具输出必须通过策略。ActionReservation 的工具 Schema 不构成权限；fill_secret、triage、shell、eval 均不是模型工具。
- 工具的 x-result-schema 指定 ToolResult.data 的内容类型，Dispatcher 必须验证；x-roles 同样不是 JSON Schema 自动执行的权限逻辑。report_suspect 的 caseId 必须是当前任务获准的本次用例。
- Event.id 必须等于十进制 seq；payload 必须与 event.type 匹配。
- functional confirmed 必须关联真正的独立 reproduced 结果；inferred 不能独立支持业务 Bug 确认。
- passed 不允许任何必需 criterion 为 unknown/failed/not_evaluated；not_run 没有虚构 verdict。
- API key、验证码、Cookie、原始认证状态及敏感 query 不出现在正常 DTO、SSE 或报告。

`../examples/` 全部为虚构样例，`report.sample.json` 明确标记 example=true，材料 URL/hash/大小仅展示字段，不对应真实文件。
