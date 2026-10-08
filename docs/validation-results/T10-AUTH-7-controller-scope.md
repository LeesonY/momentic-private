# AUTH-7A：真实材料与加密捕获服务

Root 2026-10-07。前置独立结果：AUTH-6 账本18/18、实际客户端/API17/17、受影响 Runtime/Worker/账本55/55。只接受这些本地机制；Ego 暂停、P0=false。按既有授权继续，不能因前置通过转为停工。

pi 独占新增 `packages/orchestrator/src/auth-state-service.ts`、migration013、Core/Runtime 私有 facade、必要 `SecretVault` 指纹方法与定向 PG 测试；允许添加纯 approved-state validator 的显式依赖及其锁文件最小变化，禁止复制一份弱校验器。Claude 继续 worker/auth-runtime.ts、flow及私有端口，双方不抢文件。Root 负责集成/独立复验。agy额度耗尽，其剩余Node协议工作已由用户交给pi。

本批真实方法统一传当前 private scope/proof/sessionId：

1. `authMaterial`：active initializer、smoke/Task.summary=auth、当前完整冻结profile/context/epoch/lease、live profile。仅私有内存返回 CredentialMaterial，规范键 form=username/password、storage_state=storageState，TTL不超过当前lease/session。none不解密；材料不进日志、Step、公开DTO或模型。
2. `recordAuthCriterion`：必须绑定同session/epoch登记过的不可变snapshot正文，CriterionResult属于冻结formConfig.successCriterion，或明确冻结的storage criterion；不接受调用方换验收条件。只允许passed且所有auth intent已结算后，成为捕获成功门。unsupported/unknown/not_evaluated不能授权capture。
3. `issueCaptureGrant`：服务端随机grantId+高熵ticket，只存ticket hash；完整AUTH-5 active binding、kind=capture_auth_state、deadline、成功门引用。不得自行构造JSON就获准；grant不进入普通日志。
4. `beginAuthCapture`：在private port export之前CAS issued→started，当前proof/session/epoch/success gate和deadline均复验；双begin/并发/旧epoch拒绝，不重导出。对应worker services.authorizeExport。
5. `captureAuthState`：只接受已started的同grant/ticket和当前active initializer；复用AUTH-4A validator校验原始state、origin和容量。使用受保护的完整canonical state keyed HMAC比较幂等，不能用脱敏结构或无密钥hash判断cookie内容相同。同请求/ticket同内容返回原stateRef，换value冲突，换proof/epoch拒绝。HMAC由Vault内部密钥经明确domain-separated KDF派生，原密钥/派生密钥/HMAC不暴露，旧keyVersion可验证；加有意义的crypto负例。

状态加密封装必须含完整project/run/context/profile/version/authEpoch及历史capturing session/task/worker/fencing元组，解密时与权威列逐项核对。沿SecretVault现有AAD project/secretId/purpose/keyVersion，不谎称AAD已包含新字段；额外绑定在受保护加密封装内。

采用强制RLS的受保护PG state/capture表（仅service admin；不放普通actor/worker可读表），一个事务写ciphertext/state、消耗capture grant、scope initializing→granted/currentStateId、exclusive初始化锁→granted/run+epoch。任一失败全回滚，无可导入状态、不放行explore。明文、票、HMAC不写scratch/事件/报告。网络/browser effect不在PG事务等待，最后可能阻塞的锁之后复验租约时钟。

本批不实现finishAuth/import/OTP/handoff、不改Worker.once或放开tick。已有granted状态遇到初始化恢复也不能被当作无state失败删除；实现前先保留并标明待交接，不能让新fencing伪造旧finish。下一批才实现同capturing proof的finish与系统恢复、独立importer和撤销。

必测真实PG：active/proof/profile/epoch错误拒绝且0解密/0写入；criterion/snapshot换包、pending intent/未成功门拒绝；capture并发单执行与丢失回执重试；cookie结构同但value变冲突；encrypt/DB INSERT失败整事务回滚无granted；普通actor/worker不能读票/密文/HMAC；锁等待过期、context改变/撤销、private token不在Step/SSE；旧18/55及none行为回归。仅自建PG/合成状态，精确资源清理回查，旧失败材料保留，无browser/provider/部署/commit/reset或新monitor。
