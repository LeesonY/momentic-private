# LocalQA：Momentic 风格的私有化 Web 测试平台

当前交付是开发规格与契约，尚无可运行应用。产品目标是：输入 URL，即可自动探索有限范围、生成冒烟用例、执行检查、独立复现问题并导出证据报告。

已确认的用户决策：**直接建设多人使用的内网 Linux 平台；平台、浏览器和报告在内网，允许调用外部模型 API。** 外部模型输入可能包含脱敏页面内容和截图，这与全程断网部署有不同的数据边界。

## 开发阅读顺序

1. [交付与决策索引](docs/00-overview.md)
2. [需求规格说明书](docs/01-requirements.md)
3. [技术设计](docs/02-technical-design.md)
4. [数据模型与接口说明](docs/03-data-and-api.md)
5. [验收与测试方案](docs/04-validation.md)
6. [开发 agent 交接与任务分解](docs/05-agent-handoff.md)
7. [P1 Web 回归、定时与修复细化](docs/06-web-regression-and-scheduling.md)

机读契约位于 `docs/contracts/`，可用于契约校验的虚构样例位于 `docs/examples/`。开发前应阅读契约及文档优先级；初始化项目时验证并锁定依赖版本。这里的样例和性能指标分别是示例、验收目标，不是已实现结果。

本次 [G0 校验记录](docs/validation-results/G0-contract-validation.json) 已通过 OpenAPI 3.1 标准校验、JSON Schema、样例和关键语义检查。产品的 Linux/浏览器/模型验收由 M0 和后续工作包实际执行。

## 调研依据

- [账号页面与发布包的技术拆解](Momentic-产品与技术拆解.md)
- [早期可行性分析](Momentic-私有化可行性分析.md)
- [原始官方来源索引](调研来源.md)
- `evidence/2026-10-02-space64/`：技术指纹和脱敏执行数据。
- `evidence/2026-10-02-space65/`：本次需求补查和实现参考来源。

Momentic 的观测实现和 LocalQA 的自研选择是两类信息。本项目定义自己的 API、用例协议与任务实现，不依赖 Momentic 的云控制面或账号。
