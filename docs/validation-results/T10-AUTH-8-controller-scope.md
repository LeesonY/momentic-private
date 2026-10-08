# AUTH-8：结束服务与生产技术判定适配

Root 2026-10-08，按既有续办授权推进。pi 在修 AUTH-7 时额度耗尽（wF:p2 idle2549），Root 接手其服务端代码并保留原实现/失败证据；agy/grok 已无额度，既有替换关系不变。Ego 暂停，P0=false，只有监控器14113。

AUTH-7 修复已在真实 PG 的29项检查及91项既有账本/Worker/Auth回归通过；该29项中的实际 RuntimeClient→auth-services→auth-flow→private-port→PG使用合成浏览器primitive和真实持久化/Artifact，缺finish仍明确blocked。不是浏览器或完整认证验收。

Root独占服务端AuthStateService/Core/Runtime及自己的PG测试；Claude独占auth-adapters、flow/private-port和纯Node测试。两人不抢文件。

本阶段新增私有 `finishAuth(proof, sessionId, authStateId): Promise<void>`，由服务端派生结果 `{stage:'auth',granted:true,authStateId}`：必须同capturing task/worker/fencing/context/profile/version/epoch/contextId/session，active initializer、当前granted scope/state、consumed capture grant、冻结且仍当前的success gate、合法密文封装/HMAC、exclusive granted run锁。普通finish继续拒绝auth。一个事务结束session/job、释放该task lease/并发槽和写不含私密数据的完成事件；不撤销已granted state或run锁。等锁过期和任一步写入失败回滚。相同已完成proof/stateRef重试零副作用；换stateRef冲突，换proof/context拒绝。新增method保持私有，不扩模型ToolCall或公开成功接口。

Claude补生产技术判定/locator adapters，复用真实evaluateTechnical，缺owned evidence不得pass，unsupported/unknown如实拒绝；locator必须匹配当前snapshot。补初次navigation对预填充凭据的脱敏：取材料后，在任何effect前向私有port登记已知敏感值，none零调用；不将材料放普通对象/日志/模型。仅pure Node和明确FakeSession，禁止真实浏览器、worker-entry或绕过暂停。

本阶段不把Worker.once/tick放行、不声明OTP、import、capture后crash handoff已完成。接续工作是受保护importer授权/CAS、同run并发上下文导入、撤销和系统handoff，以及OTP实际输入/单消费，再与Worker主路径一起验收。storage_state缺配置成功条件仍fail-closed；该缺口必须明确解决或保留阻塞，不能自选条件冒充已登录。无需再等普通可逆实现的授权。
