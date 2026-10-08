# T10 只读缺口审计与 AUTH-1 边界

## 规格依据

- docs/05-agent-handoff.md T10：用例/版本/DSL/回归 API/UI，冒烟保存→审查→版本→重跑；YAML、模块、变量/升级；FR-035–036。
- docs/06-web-regression-and-scheduling.md §1–3：不可变受审版本、来源绑定、生命周期；自有 YAML/DSL、变量/模块；认证经 AuthProfile/CredentialBroker；regression-runs 支持可选 authProfileId。
- FR-009–010：none/form/storage_state 和认证失败受阻为 P0 依赖，不能以 T10 的匿名执行代替完整认证。

## 当前缺口和归属

| 项 | 当前事实 | 后续最小工作 |
| --- | --- | --- |
| 认证 API 入场绑定 | AUTH-1 修改 runs/savedCases，统一选显式 ID 或环境默认；验证同项目、active、环境匹配及 origins 覆盖；ID 与版本一起传 start | 独立 PG/API 验证待 Root 确认 API 构建时机；本轮静态检查通过不等于实跑 |
| none 执行 | 原 requireAnonymousOrInput 将所有非 null authVersion 判为需要适配器；Root 本轮报告已补 Coordinator/RuntimeClient.authProfile | Root 负责冻结元数据/none执行及独立反例复验；本轮不修改或验证 Runtime |
| form/storage_state 执行 | 底层 resolveAuth 及 BrowserSessionOptions.approvedAuthState 已有；完整执行桥未完成 | 回归保留明确 422；smoke 可创建合法绑定，但不得声称已经登录 |
| 受保护秘密动作 | 普通 type_text 的 ToolCall 会持久化；回归动作还要求合法 DSL source | Root 冻结凭据引用/认证动作授权接口；不能把密码写进普通 text，不能借用 DSL source 登录 |
| 状态注入 | BrowserSession 当前 localStorage 注入包含隐式 page.goto 并吞掉错误 | 消除隐式导航或纳入 grant/execute/record，失败明确受阻；严格结构/origin/容量校验 |
| run 级认证独占 | sharingPolicy 已存储，但未发现完整 run 级认证锁实现 | Root 复用既有 lease/budget，补认证独占、恢复和释放；不扩展 scheduler |
| YAML/升级 | parseRegressionPayload 实际仅接收 JSON 对象；注释不构成 YAML parser | 自有 YAML 受限导入/导出、alias/tag/深度/容量/危险键校验；版本转换及记录 |
| 用例生命周期 | 状态列和历史保护已存在；未发现完整归档/恢复/复制入口 | T10 API/UI 生命周期；不能删除旧报告；定义归档选源拒绝行为 |
| 模块注册/审查 | 已有 registry 表、受审 SHA 校验、冻结展开；既有测试 SQL seed | 补可用的受审模块注册流程；不能把 SQL seed 宣称成用户入口 |
| 变量 | compiler 支持调用方 env/vars；API 目前只注入 BASE_URL | 明确支持范围；不得读取服务器 process.env 或把认证秘密插进普通变量 |
| fixtureRefs | compiler 明确 UNRESOLVED_FIXTURE | 保持 fail-closed；数据模板 registry/setup/cleanup 属 T12，不在本轮创建 |
| 源冒烟步骤 | sourceRunCaseId 保存转换提取 Navigate outline 和 criteria | 明确不是完整动作轨迹复制；人审后才可执行 |

## 可复用的准确接口

- ConfigurationRepository.get(actor, 'AuthProfile', projectId, id)：当前 head 元数据，不适合替代运行时冻结历史版本查询。
- LeaseRepository.resolveAuth(scope, proof, authProfileId, authProfileVersion, vault)：Promise<CredentialMaterial>；检查 lease、run 状态/上下文、run 冻结绑定、撤销和 secret。
- POST /internal/v1/auth/resolve：AuthResolve 输入，返回 CredentialMaterial；内部 proof 保护归 Root。Root 已报告开始严格要求 Worker-Id/Fencing-Token/Context-Version headers 并绑定调用方原 proof；不复用服务器合成续权。原反例 T10-auth-runtime-f745c606.json（0/3）保留，修复后的 Runtime/HTTP 验证不计入本轮 API 测试。
- Coordinator.start(actor, input, config, idempotencyKey, trustedCases)：已有 auth ID/版本持久化。
- BrowserPort.createSession(BrowserSessionOptions)：已有 approvedAuthState；不会自动获得 broker 权限。
- Root 共享 Runtime 桥须从 run 冻结 ID/version 取 AuthProfile，不允许模型或 Worker 任意选 secret。

## AUTH-1 新测试设计（尚未 PG/API 执行）

apps/api/test/t10-auth-binding.test.mjs 共 8 个新增测试，双路由覆盖默认/显式 none、覆盖默认 form、历史 none 不受新 form head 影响、未知/跨项目/撤销（含默认）、环境不匹配/缺省、全部 origins 子集、smoke form/storage_state 与回归拒绝、幂等重试和配置变化冲突。

none→form 测试因 AuthProfilePatch 不支持 mode 变更，使用本次拥有的数据库插入新版本并移动 head，不修改历史行；只验证冻结边界，不宣称 API 提供 mode 修改功能。

后续另补 Root-owned Runtime 和 FakeBrowser 认证执行/取消/租约/秘密哨兵/认证锁测试，再由用户另行授权真实本地浏览器验收。本轮不重复旧绿灯测试，不启动浏览器、worker-entry 或真实模型。

## 验收结论

P0=false；完整 auth/T10 未完成。AUTH-1 是受限的 API 绑定修复，不是认证执行完成，也不扩大到 T11/T12。
