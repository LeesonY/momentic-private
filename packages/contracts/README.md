# @localqa/contracts (T01)

协议权威来源：`docs/build_contracts.py` → `docs/contracts/*.json`。本包不修改文档，不手写平行 DTO，不实现应用或浏览器。

## 命令

目标 Node **24 LTS**；开发实测 Node 26.3.0。未安装全局 pnpm，使用固定版本：

```sh
npx --yes pnpm@10.34.0 install --frozen-lockfile --ignore-scripts
npx --yes pnpm@10.34.0 contracts:generate
npx --yes pnpm@10.34.0 contracts:check
npx --yes pnpm@10.34.0 run ci
```

`pnpm ci` 在该版本是未实现的内置命令，必须写 **`pnpm run ci`**。根脚本检查 contracts、lint、format、typecheck 和 test；build 随 test 执行。T01 根脚本只覆盖本包，不代表未来所有模块已测试。workspace 暂时显式排除 `packages/test-fixture`，避免安装/检查跨 agent 边界；验收集成负责人统一移除此排除并更新 lockfile。

- `contracts:generate`：JSON Schema → TS 类型、原样 schema 快照、源文件 SHA-256。
- `contracts:check`：在项目内 scratch 执行未改动的 Python 生成器副本，逐字比较 6 个契约和 5 个样例；校验 Draft 2020-12、OpenAPI 3.1、所有定义及 API 嵌入 schema；检查 TS/快照生成漂移。scratch 自动清理，不重写 `docs/`。
- GitHub Actions 使用 Node 24 / Python 3.12 和冻结 lockfile；配置已交付，远程执行尚未验证。
- 依赖精确版本见两级 `package.json` 与 `pnpm-lock.yaml`。pnpm store/cache/state 在 `.cache/pnpm/`；npm/npx 使用默认工具缓存（开发机 `/Users/dcp/.npm`）。首次安装产生的 pnpm 元数据工具缓存 `/Users/dcp/Library/Caches/pnpm` 按工具缓存例外保留；更新检查状态文件已从 `/Users/dcp/.local/state/pnpm/pnpm-state.json` 移到项目内，后续关闭更新检查。其余 T01 日志在 `.localqa-t01/logs`，验收记录在 `docs/validation-results/T01-*.json`。

## 消费

其他 workspace 包依赖 `"@localqa/contracts": "workspace:*"`，先执行根 `build`：

```ts
import {
  parseContract,
  validateContract,
  getValidator,
  getApiValidator,
  getToolResultValidator,
  toolMetadata,
  ERROR_HTTP_STATUS,
  CONFIG_KEYS,
  type RunCreate,
} from '@localqa/contracts';

const run: RunCreate = parseContract('RunCreate', untrustedJson);
const result = validateContract('ToolCall', modelOutput);
const requestValidator = getApiValidator('createRun', { kind: 'request' });
```

- `getValidator(name)` 是带类型收窄的 Ajv validator；`parseContract` 成功返回原对象，失败抛 `ContractValidationError`；错误只含 schema 路径/诊断，不含输入正文。
- `getRootValidator('report' | 'events' | 'tools' | 'regression')` 直接消费相应独立契约。
- `getApiValidator` 从 OpenAPI 提取 request/response/parameters，支持 status 和 mediaType。Internal 默认不可取，Worker 必须显式传 `{ internal: true }`；这不是实际 HTTP 权限机制。参数入口须先按 HTTP 层解析数值，再验证；本包不隐式 coercion，不额外规定 OpenAPI 未定义的未知 query 行为。binary 是传输注解，非文件安全校验。
- `toolMetadata` 保留 `x-roles` 和 `x-result-schema`；`getToolResultValidator` 验证 `ToolResult.data` 的形状。角色授权、数据归属及 lease 检查由 Dispatcher/domain 完成。
- `ERROR_HTTP_STATUS` 对齐数据/API 第 7 节；`null` 表示运行原因而非 HTTP 状态，不能随意映射为 500。`Error.code` 和 `Verdict.reasonCode` 仍按源 schema 保持 string，没有擅自收窄为 enum。
- `CONFIG_KEYS` 冻结部署配置键、用途、必需性和有文档依据的默认值。事件保留天数无文档默认，由 T09 明确配置；文件访问、环境变量解析、关系约束及生产校验留给服务/部署。

## 边界

运行时是源 JSON Schema 本身，执行格式、范围、长度、枚举、additionalProperties、oneOf、if/then 等规则，不设置默认值、不删除未知字段、不修改输入。TS 类型是这些规则的静态投影，不能表达数字范围、regex、格式或全部 if/then 条件，**必须在边界运行 validator**。禁止手改 `src/generated`。

形状校验不证明权限、当前租约、URL 目标安全、敏感数据脱敏、同 run 证据真实性、event id=seq、独立复现或报告统计。类型生成/工程测试通过不等于 M0/P0/Gate 通过。跨模块 port 的最终签名需 T05 与模块负责人协调，T01 不凭空增加协议字段。
