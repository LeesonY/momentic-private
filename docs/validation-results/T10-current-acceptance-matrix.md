# T10 当前验收矩阵

依据：[原需求 FR-035–036](../01-requirements.md#46-主要-web-功能完善)。本表是当前 Root 证据的范围汇总，不是全量功能覆盖或发布通过声明；不同报告的用例可能重叠，不累加为覆盖率。**P0=false，Ego 暂停；生命周期 API/UI 修复已在本地范围接受。** [AUTH-5 基础实现](T10-AUTH5-controller-acceptance.json)已限定本地验收，现继续 [AUTH-6](T10-AUTH-6-controller-scope.md)；按用户指令由 Claude 接替 grok，agy额度耗尽，用户已将剩余工作交给pi；pi与Claude已继续派发，单一监控器14113存活。

| 需求 / 功能 | Root 实际验证范围与报告 | 未验证 / 阻塞及当前结论 |
| --- | --- | --- |
| FR-035：冒烟保存、版本化步骤/预期、人审后重跑；独立协议 | [B5 集成检查](T10-B5-controller-integration.json)：实际 API→Worker/Runtime/PG，使用 FakeBrowser、注入模型响应及合成截图；保存→draft→approve→回归链、源文档保留。最新[生命周期 API 接受报告](T10-lifecycle-controller-api-acceptance.json)中既有 saved9/B4 7/module12/Worker17 共 45/45 回归通过。 | 本地持久化/模拟执行证据，不代表真实网站重跑、模型语义/视觉验收；采用自身 RegressionDocument 协议，不宣称 Momentic YAML 兼容。 |
| FR-035 扩展：archive/restore/显式 sourceVersion 复制/status 列表 | [生命周期 API 接受报告](T10-lifecycle-controller-api-acceptance.json)：PG18 独立复验 11/11、Root 12/12、source-viewer→target-operator 1/1；真实锁交错、双 archive 200/409、frozen binding 保留；递归依赖 SHA/正文、权限、整数边界、预算及零写入拒绝。另 pure depth 3/3、旧 static 11/11。 | **仅 API 本地接受**；失败反例与清理记录保留。UI/真实浏览器未随 API 接受。 |
| FR-035 扩展：生命周期 UI | [Root UI 接受报告](T10-lifecycle-controller-ui-acceptance.json)：离线24、实际列表回调7、实际复制提交回调2、client/Mock方法10、case/version分页各6；helper包检查5+3；module39、YAML28、flow70、fixture32回归通过。build/lint、80操作生成同步通过。 | **限定本地范围接受**：合成传输/数据、提取实际回调并注入闭包、静态SSR与辅助函数；没有 DOM/hydration或真实浏览器。旧失败报告保留，不能拿 agent done 代替验证。 |
| FR-036：YAML 导入/导出、未知字段/步骤拒绝 | [YAML/API/Auth 接受报告](T10-yaml-backend-auth-controller-acceptance.json)：YAML PG/API 5/5，真实解析及安全/往返边界；[YAML UI 接受报告](T10-yaml-ui-controller-acceptance.json)：离线 28、Root 实际 Mock/注入 HTTP 方法 12、静态 SSR 4，build/lint 通过。 | 后端及前端离线范围本地接受；Mock 合成 draft **不是 YAML 解析器**。无真实浏览器导入/导出、交互/hydration 验收。 |
| FR-036：模块注册、审查、组合及管理 UI | [模块 API 接受报告](T10-modules-controller-api-acceptance.json)：PG/API 12、storage32、static/compiler11、compiler/replay/locator27、contract9；[模块 UI 接受报告](T10-modules-controller-ui-acceptance.json)：scope/preview8、实际 mock 方法6、离线/SSR/注入 HTTP39，build/lint 通过。后续受影响 module12 见生命周期报告。 | 各自限定范围本地接受；模块 API 报告当时的 UI 未接受标记由后续 UI 报告限定补充，不代表真实浏览器端到端或实际模型执行。 |
| FR-036：固定步骤、AI 步骤、变量（无 eval） | [模块 API 接受报告](T10-modules-controller-api-acceptance.json)的 compiler/replay/locator 检查；[YAML/API/Auth 接受报告](T10-yaml-backend-auth-controller-acceptance.json)的 Worker/FakeBrowser17；编译细项见[B3A](T10-B3A-compiler-evidence.json)，假端口 replay 细项见[B3B](T10-B3B-replay-evidence.json)。覆盖受控展开、模板/变量、顺序、预算和 fail-closed。 | 纯编译、假端口或 FakeBrowser/注入响应只能证明对应机制，不能证明真实浏览器固定动作、AI 语义/视觉执行；非空 fixture 仍拒绝，数据模板注册不在 T10 范围。 |
| T10 认证前提：绑定/proof/none、AUTH-4A/4B | [YAML/API/Auth 接受报告](T10-yaml-backend-auth-controller-acceptance.json)：绑定 API8、Runtime auth11、Worker/FakeBrowser17，none 不返回闲置 secret、解密调用0。[AUTH-4A 接受报告](T10-AUTH-4A-controller-acceptance.json)：20 包测试+5 Root 导出检查，**仅纯 approved-state validator**。[AUTH-4B 设计审查](T10-AUTH-4B-controller-design-review.json)：revision2 已只读审查。 | [AUTH-5](T10-AUTH-5-controller-scope.md) 已定下并派发服务端会话基础、私有端口和输入安全边界；完整 state 持久化、exclusive、OTP 与 Worker 接线继续分批推进，尚未验收。4A helper 通过不构成 auth 执行接受。 |

| 既有内部 HTTP 动作结果边界 | [Root 修复接受报告](T10-internal-action-controller-acceptance.json)：18项PG/HTTP检查、55项Runtime/账本/Worker/Auth回归、14项API回归通过；原3项失败反例保留。 | **限定本地范围接受**：caller proof、证据归属、幂等、Step脱敏与预算原子结算已复验；不代表完整认证执行、真实浏览器或供应商模型验收。 |
| AUTH-5：会话与输入/私有端口基础 | [Root API 接受报告](T10-AUTH5-input-controller-acceptance.json)：输入 15/15、T06 API 14/14；[基础接受报告](T10-AUTH5-controller-acceptance.json)：真实 PG 会话 11/11、私有端口源码 16/16、15 个 private 包 case 与 20 个 approved-state case、UI实际回调 5/5/离线 21/21；自建资源清理已回查。旧失败反例保留。 | **限定本地范围接受**：通用输入不能虚假解决认证；会话租约/过期与私有执行/导出 gate 边界已复验。端口的 service gate 正向使用 Fake Runtime；真实动作/CAS/state/OTP/handoff 与 Worker 主路径尚未完整接线。真实浏览器/hydration 未验。 |
| T10：实际客户端与 API 联调 | [Root 接受报告](T10-real-api-node-controller-acceptance.json)：原 15/15；[补充输入修复接受报告](T10-clarification-controller-acceptance.json)：嵌套事务锁等待造成的 clarification provide503 已修复，16/16 实际客户端/API 检查和14/14 API回归通过。每次运行报告保留，容器/卷/端口/临时密钥已独立回查，资源账本保留。 | **仅客户端与 API 协议接受**：Cookie 转发为本任务合成账号传输；没有 Mock 业务回复，没有浏览器/DOM/hydration 或已准入 Run 的实际执行。agy额度耗尽，用户已将剩余 Node 脚本/并发输入验证交给 pi，见[交接记录](T10-agy-to-pi-handoff.json)。 |

## 明确剩余项

1. 生命周期 API/UI 本地修复已接受；真实浏览器/DOM hydration 与真实站点回归仍缺失，不把本地回调/Mock通过写成端到端完成。
2. AUTH-5 基础已限定本地接受；AUTH-6 正在实现私有动作账本与固定认证适配器，并继续真实 API 客户端 Node 联调。完整 form/storage_state、exclusive、OTP/state 持久化、crash handoff 与 Worker 主路径尚未完整接线，不能以基础通过宣称完整认证通过。
3. 真实浏览器/会话/hydration、最新代码的真实 supplier 模型语义/视觉验收仍缺失。[旧真实模型最小样本](G3-model-minimal.json)本身标记 G3/P0 未通过，不能移作最新 supplier 验收；FakeBrowser、Mock、静态 SSR、注入 transport 均不替代该证据。
4. 既有内部 HTTP 动作结果接口的3项真实失败已定向修复并复验；新增认证会话/凭据执行桥仍未实现。
5. **T10/FR-035–036 不宣称已全量完成或发布通过**；P0=false、Ego 暂停。T11/T12（调度/CI、fixture/data registry 等）不扩入本次整理范围；后续仅按 Root 派发推进。


## AUTH-7 首轮独立结论（已由下方修复结果更新）

Root复跑AUTH-6B纯Node/Fake桥接18/18通过；不含真实服务、浏览器或Worker.once接线。AUTH-7A原PG8/8通过，但[Root扩展PG23项](T10-AUTH7-STATE-ROOT-1369e344-aa12-4319-bf29-49caa3326d75.json)仅10通过/13失败，**捕获服务未验收**：完整绑定、等锁后票据过期、成功门失效、撤销/历史绑定、捕获票幂等、HMAC轮换及exclusive锁有真实反例。pi已接修复，Claude已接真实Runtime服务适配；OTP/finish/import/Worker主路径尚未完整实现。Ego暂停，P0=false；不以agent idle/done或局部通过替代验收。


## AUTH-8 修复后的范围

[Root PG37/37及独立清理回查](T10-AUTH8-controller-acceptance.json)限定接受私有材料、当前成功门、捕获CAS、加密/HMAC状态和专用finish服务。原13失败及后续反例保留；新增真实Runtime/flow/Artifact/PG链证明能够捕获，未连接finish时仍明确blocked。pi现额度耗尽，Root接手服务端；Claude继续真实finish适配与新snapshot显式握手，禁止改写snapshotId伪装旧观察。受影响账本/Worker/Auth回归91/91通过（范围重叠，不累加覆盖率）。OTP/import/handoff/Worker主路径、storage成功条件及真实浏览器仍待验收；Ego暂停，P0=false。


## AUTH-8C / AUTH-9 当前续办

[Root8C复核](T10-AUTH8C-controller-review.json)：新脱敏方法getter/别名冻结的原2失败已修，Root2/2及worker纯Node37/37通过；实际Runtime→PG捕获→专用finish单项通过。production adapters新快照PG探针的证据查询有Root fixture字段路径错误，已修正；受管权限拦Docker，修正后完整重跑未验证，不能写成通过。pi由用户换模型后已实际收到AUTH9A并编写014/importer服务，尚未独立验收；Claude idle2565，原监控14113仍报告状态。当前Herdr CLI也被受管权限拦截，终端UI被工具安全规则拒绝；本地Node/源码复核继续可用。Ego暂停、P0=false、完整认证/Worker主路径未验收。


AUTH8C补记：Root显式纯helper文件runner24/24、worker纯Node37/37及getter/别名2/2通过。Browser包通配符包含T03真实浏览器集成文件，不能把agent报的41/41算作纯Node。Root误用通配符后在fixture before hook失败，尚未构造BrowserManager；代码终止自己的fixture，独立PID/端口回查受管权限阻止。原失败日志保留，不计为产品缺陷或浏览器通过；后续必须只列出明确允许的纯文件。


## AUTH-9进度核查

[Root进度报告](T10-AUTH9-controller-progress.json)：进口reader实际加密/HMAC负例10/10、orchestrator/API typecheck和定向lint通过，输入查询行为合成，无PG/RLS/lease/effect验收。pi真实执行日志20项import PG、38项Root设计脚本、91项回归通过；执行者是pi，不能替代Root独立PG。下一批[worker importer任务](T10-AUTH-9B-controller-ready.md)已准备但因Herdr控制权限阻断尚未派发。任务整体未完成，Ego暂停、P0=false；监控器14113仍报告进度。


pi done2572复核：最终AUTH9A源码/20项PG/38项Root设计脚本/91项回归及16组资源回查证据已检查，执行者仍为pi。Root实际decoder crypto10再次通过；新发现的HTTP策略拒绝500已按既有HTTP词表映射FORBIDDEN403，实际mapper/请求处理函数3/3、API build/type/lint通过，见[API修复接受](T10-AUTH9-policy-error-controller-acceptance.json)。PG test对应断言已更新，修复后Root独立PG复跑受Docker权限阻断，完整importer和worker接线未放行。下一任务9B已准备但Herdr权限阻止派发；原监控14113不变，Ego暂停/P0=false。


[AUTH9B Root本地实现](T10-AUTH9B-controller-acceptance.json)：新增worker私有状态注入helper，9个新case及37个既有纯Node回归（总46）通过，build/type/lint通过。都是明确Fake service/primitive，server PG、context分配/激活、Worker.once/tick尚未独立接通验收；未因agent idle或本地pass宣称全认证完成。Herdr/Docker受管权限仍阻断，Root仅在可写工作区推进；Ego暂停/P0=false，监控14113唯一。
