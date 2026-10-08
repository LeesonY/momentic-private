# AUTH-9A：子任务 importer 授权与单次状态注入账本

Root 2026-10-08，用户已给 pi 换模型并明确继续。旧 pi AUTH-7 返工已由 Root 接手完成，不能从压缩前旧稿覆盖当前代码：最新限定验收是 AUTH-8 私有服务真实 PG37/37、既有账本/Worker/Auth91/91。报告 `T10-AUTH8-controller-acceptance.json`；Root37脚本及证据归Root。所有旧改动/失败材料保留。

pi独占新增 `auth-import-service.ts`、migration014、必要 `auth-execution.ts` importer分配扩展、Core/Runtime/index最小转发和其PG测试。允许必要抽取共享受保护state解密/完整封装核对helper，但不得退回Root修好的auth-state-service旧实现、弱化当前session/epoch/profile/fencing/成功门/密文/HMAC校验。Claude独占worker/auth-services/auth-adapters/auth-flow/private-auth及locator，当前正在接真实finish和fresh snapshot握手；不要改这些文件。Root负责独立真实PG/Runtime/flow验收和后续协调。

本阶段新增独立私有 `allocateAuthImporterSession(proof, authStateId)`，不改变旧initializer默认含义：只允许真正需要浏览器的服务器Task.summary=explore/execute/reproduce且current run scope/state已granted；不是由caller booleans续权。先校验当前lease/run/context/被冻结profile/version/epoch与未撤销profile，生成独立sessionId/contextId（同task+fencing最多一个，purpose=importer），复用真实activation ticket CAS。initializer和importer能力分开：importer不得authMaterial、填凭据、capture或finishAuth；不能把历史capturingSession当当前importer。

从保护表读取当前同run状态时，对ciphertext的project/run/context/profile/version/epoch及历史capturing session/task/worker/fencing/contextId/grant逐项与权威列核对，verify历史HMAC keyVersion/全canonical state、origins/容量与已消耗capture grant。历史initializer允许已正常结束或capture后恢复结束，不能要求仍active；当前importer必须active、current proof。exclusive仅要求held+granted的run/epoch锁，不要求importer等于initializer，不抢新的初始化锁；shared_state不查锁。none/未granted/撤销/错run/旧fencing/ctx/epoch都拒绝，0解密/0写入。

私有grant/prepare/begin/record接口由pi实现并写清精确类型给Root：grant绑定完整当前importer元组+当前stateId+deadline，保护表session唯一。准备阶段只有合法grant才CAS issued→prepared并在私有内存解密；begin prepared→started在真正prepare_state effect前CAS一次，附私有receipt；receipt与raw state不进公开DTO/Step/SSE/模型。丢失prepare回执不能再解密，丢失begin回执不能再注入；需新显式attempt/session，不允许自动重放。record只用同begin receipt结算一次，失败/unknown如实记账。导入动作仍走共用action预算/Step约束，reserve一次/charge一次，ordinary grant/record/HTTP result不能替代private import路径；若共享helper缺口，要报告具体代码并做必要最小提取，不能省预算。

结束当前子task只结束它的session/import行；兄弟task和run state/epoch/granted锁不变。允许最小generic finish/stop/recoverExpired接入该结束逻辑，但本阶段不改tick认证放行/Worker.once/真实BrowserSession驱动，不实现OTP或系统handoff。所有锁采用既有job/lease→run→scope→session→profile/lock→state/grant顺序，最后可能阻塞锁和写入后复验lease/session/grant时钟，失败事务全回滚。此处freeze不是给予浏览器操作权限。

真实PG必测：真实正常capture+finish后两个同run不同任务/worker/fencing独立import；exclusive/shared均可，兄弟互不结束；ciphertext/历史绑定/旧keyVersion篡改拒绝；wrong/new fence/expired/currentcontext/profile revoke/epoch-change无material；prepare/begin并发各单执行、丢失回执不重解密/重effect；动作预算/ordinary路径/私密数据边界；真实等锁过期/DB写入失败原子回滚；结束一子task保持兄弟授权与run锁；none全零。你的自身证据不能替代Root验收，保留独立复跑命令和精确owned资源清理回查。

Ego和真实浏览器/worker-entry/provider继续暂停，本阶段产品modelTransportCalls=0，P0=false。无commit/reset/stash/全仓stage、账号/模型擅自切换、新pane或第二monitor。完成给具体输出/源码/精确接口，Root继续验收派发。


补充执行边界（Root实际发现）：禁止`node --test packages/browser/test/*.test.mjs`及browser包`npm test`，其包括T03真实browser.test.mjs；只允许显式auth-state.test.mjs、private-auth.test.mjs、regression-locator.test.mjs和已明确Fake的worker测试。Root当前工具受管权限使Herdr CLI/Docker不可用，后续dispatch和Root PG独立复跑暂受阻；Pi原任务已实际收到并继续，监控器14113不重启。
