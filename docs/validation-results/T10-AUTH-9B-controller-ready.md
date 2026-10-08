# AUTH-9B worker importer 接线：待派发的具体任务

Root准备于2026-10-08。本文件是可审查的后续任务，**尚未通过Herdr派发**：当前受管权限阻断Herdr CLI、Docker和终端UI工具；不得把写文件当作agent已接受任务。原监控器14113继续只报状态。

前置是pi的AUTH9A接口和状态账本独立PG验收，现尚未满足。Root已独立验证进口reader实际加密/HMAC10项（合成查询行，不是PG），本地类型/lint通过；pi本轮实际日志显示PG20/20、Root设计脚本38/38及回归91/91，这些执行者是pi，不能改称Root独立执行。

后续worker拥有新增auth-import.ts/对应测试及必要private-port适配，backend仍归pi。保持Worker.once/tick真实入口未放行；先接私有Importer流程，明确Fake primitives，无真实浏览器/worker-entry/provider，P0=false。

当前实际RuntimeClient方法：

- allocateAuthImporterSession(proof, authStateId) → AuthSessionBinding；使用既有activation ticket/activate完成真实激活。
- grantAuthImport(proof, sessionId) → AuthImportGrant（全当前binding、grantId、authStateId、kind=import_auth_state、deadline）。
- prepareAuthImport(proof, sessionId, grantId) → {grant, state}；服务端issued→prepared才解密，准备回执丢失不重复读明文。
- beginAuthImport(proof, sessionId, grantId) → AuthImportReceipt；prepared→started仅一次，在真正prepare_state effect之前调用。
- recordAuthImport(proof, sessionId, grantId, receipt, {status}) → void；当前proof和同receipt结算一次。

接线必须完整复制冻结proof与active importer binding；每个server grant/prepare响应逐项核对project/run/task/worker/fencing/contextVersion/contextId/profile/version/epoch/purpose/status/stateId/deadline。不得从现行DB值补旧proof。grant.kind到private port的import_storage_state/storage_state仅作固定内部动作映射，权威tuple不能编造。gate.begin调用真实beginAuthImport并闭包持receipt；port只执行一次prepare_state，禁止goto/fill/submit/export、ordinary grant/record/finish与模型工具fallback。state/receipt/token不进Outcome/Step/日志/模型。失败/unknown如实record，record失败不能返回imported成功；丢失prepare/begin响应零effect，不重试解密/注入。none零RPC/port。

预算和公开Step由服务端现有私有ledger处理，worker不另算一次。结束一个task时只结束其import/session，其他task/run state/granted run锁保留；port生命周期与底层浏览器context生命周期分别说明。测试用真实adapter+private-port和明确Fake Runtime/primitive，严格证明grant→prepare→begin→effect→record顺序与每步失败0后续effect。PG后续由Root在权限恢复后独立复验。

只列出明确允许的纯Node文件，禁止browser包通配符或npm test，因为包含需要真实浏览器的T03集成。保留旧失败材料、自己创建资源精确清理回查；不改Root controller脚本、不commit/reset/stash或启动第二monitor。


Root续办结果：因native agents均idle且Herdr控制仍受管权限阻断，Root在工作区自行实现新增worker/auth-import.ts与其独立测试，不改旧Worker主入口。9个新case和37个既有纯Node回归（总46）通过，最终build/type/lint通过；见T10-AUTH9B-controller-acceptance.json。接口使用调用方已由真实服务分配激活的importer binding，allocation/activation与真实context创建并非此helper已完成的功能。原backend独立PG和全链接线仍待验证；不是已向Claude派发的任务，也不放行P0/Ego。
