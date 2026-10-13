# LocalQA：Momentic 风格的私有化 Web 测试平台

LocalQA 是参考 Momentic 产品工作流的自研私有化 Web 测试平台，包含 React 工作台、API、任务协调器、浏览器 Worker、模型网关、PostgreSQL 存储及报告导出。产品目标是：输入 URL，即可自动探索有限范围、生成冒烟用例、执行检查、独立复现问题并导出证据报告。

当前仓库保存截至 2026-10-08 的开发代码与验收证据，**不作为生产发布版本：P0 尚未放行，P1/T10 尚未全量验收。** T00–T09 已交付；T09-B 最终结果为 12 通过 / 1 失败 / 1 未验证。T10 的用例库、版本审查、自有 YAML/DSL、模块与回归流程已在各自报告限定范围内验证；认证执行仍有主流程接线及独立复验待完成。真实浏览器/会话、最新供应商模型语义与视觉验证不能由 Mock、FakeBrowser 或局部通过替代。

当前结论见 [P0 验收矩阵](docs/validation-results/P0-acceptance-matrix.md)、[T10 当前验收矩阵](docs/validation-results/T10-current-acceptance-matrix.md)及[最新控制器记录](docs/validation-results/T10-controller-latest.json)。历史失败与修复证据均保留，报告中的测试数量可能重叠，不累加为覆盖率。

已确认的用户决策：**直接建设多人使用的内网 Linux 平台；平台、浏览器和报告在内网，允许调用外部模型 API。** 外部模型输入可能包含脱敏页面内容和截图，这与全程断网部署有不同的数据边界。

## 开发阅读顺序

1. [交付与决策索引](docs/00-overview.md)
2. [需求规格说明书](docs/01-requirements.md)
3. [技术设计](docs/02-technical-design.md)
4. [数据模型与接口说明](docs/03-data-and-api.md)
5. [验收与测试方案](docs/04-validation.md)
6. [开发 agent 交接与任务分解](docs/05-agent-handoff.md)
7. [P1 Web 回归、定时与修复细化](docs/06-web-regression-and-scheduling.md)
8. [执行诊断、保守修复候选与长流程边界](docs/07-runtime-diagnostics-and-repair.md)

机读契约位于 `docs/contracts/`，可用于契约校验的虚构样例位于 `docs/examples/`。开发前应阅读契约及文档优先级。这里的样例和性能指标分别是示例、验收目标，不是已实现结果。

本次 [G0 校验记录](docs/validation-results/G0-contract-validation.json) 已通过 OpenAPI 3.1 标准校验、JSON Schema、样例和关键语义检查。产品的 Linux/浏览器/模型验收由 M0 和后续工作包实际执行。

## 本地开发

使用 Node.js 24–26 和锁定的 pnpm 10.34.0，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm ci        # 契约与生成客户端同步、lint、格式、build、typecheck、纯 Node 单元测试
pnpm --filter @localqa/web dev
```

`pnpm test` 先 build 再运行 `scripts/test-unit.mjs` 列出的纯 Node 测试（不需要数据库、浏览器或模型）。前端提供 Mock 开发模式；连接真实 API 的全栈开发环境见 [Docker 开发环境](deploy/README.dev.md)（macOS/Linux 首次执行 `deploy/dev-init.sh`）。生产部署输入与隔离演练步骤见 [部署指南](deploy/README.md)，包内 README 提供各组件说明。`pnpm test:integration` 包含真实浏览器/数据库测试，应在具备相应资源且已授权的环境执行。

阶段验收脚本（T14–T38，多数需要真实 PostgreSQL、Chromium 或模型供应商）不再放在根 `package.json`，用 `pnpm acceptance --list` 查看、`pnpm acceptance <任务名>` 运行；任务名与历史报告中的 `pnpm test:tNN-*` 一致，见 [scripts/README.md](scripts/README.md)。

只提交源码、锁文件、配置模板与必要验收材料。实际 `.env`、密钥、证书、依赖目录、构建输出和原始运行日志均应保留在仓库之外；`.env.example` 中的值仅为模板。

## 调研依据

- [账号页面与发布包的技术拆解](Momentic-产品与技术拆解.md)
- [早期可行性分析](Momentic-私有化可行性分析.md)
- [原始官方来源索引](调研来源.md)
- `evidence/2026-10-02-space64/`：技术指纹和脱敏执行数据。
- `evidence/2026-10-02-space65/`：本次需求补查和实现参考来源。

Momentic 的观测实现和 LocalQA 的自研选择是两类信息。本项目定义自己的 API、用例协议与任务实现，不依赖 Momentic 的云控制面或账号。
