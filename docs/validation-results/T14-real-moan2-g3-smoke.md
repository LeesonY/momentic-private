# T14 · Pi moan2 真实模型基础冒烟验收

## 授权供应商与协议

- 用户指定 Windows Runner 中 Pi 配置的 mo 开头服务商。
- 现有 Pi 配置中的 `moan2 / mofree-m1` 已真实连通；`moan / mofree-m2`
  与 `moan2 / mofree-m2` 曾出现 Cloudflare 上游连接失败，**不代表其永久不可用**。
- 模型供应商配置使用 **Anthropic Messages** 协议，不能交给 OpenAI
  Chat Completions 适配器。
- 本阶段新增 `anthropic_messages` 模型适配器（`packages/model-gateway/src/anthropic.ts`）、
  Contract Schema、Worker 冻结模型分发和 API 管理端探测；只允许
  `json_object` 结构化模式，保留完整服务端 AJV/工具校验。
- **配置模型 ID `mofree-m1`，真实供应商回报模型 ID `MiniMax-M3`**。
  必须同时记录二者，不能视为同一标识，也不能声称供应商实际部署的
  底层模型已经得到独立鉴定。

## 真实调用/数据隔离

本地独立 PostgreSQL18 + Coordinator + Worker + Chromium 链路可通过
`pnpm test:t14-real` 在获授权的 Windows Runner 上重复运行：

1. 只读加载用户现有 Pi `moan2` 密钥与模型地址；不会输出、复制到项目
   文件或修改 Pi 配置。
2. 用独立随机 Vault KEK 加密，写入自动删除的**临时 PG 容器**；项目业务库不参与。
3. 真正发送 Anthropic Messages 能力探测，成功后冻结版本与角色绑定。
4. 真实模型经预算预留、`model_requests` 记录、Worker、Chromium 访问
   临时本机中文测试页面，执行受限、只读的冒烟标准并保存截图证据。
5. 强制校验模型调用结算、证据 Artifact、CaseAttempt 和 Run 终态；
   即使模型给出结论，是否通过仍由已拥有的浏览器技术证据决定。
6. 不自动提交、推送、部署，测试结束删除临时容器与文件。

真实模型测试**不使用固定回复生成器**。模拟 OpenAI-compatible 线路保留为
单独的 `pnpm test:t14-wire`（G2）回归，不可混作真实模型 G3。

## 通过范围与未完成项

- 已真实执行 `moan2 / mofree-m1` 端到端只读冒烟，模型请求、预算流水、
  Chromium、Artifact 和 CaseAttempt 全链路成功。
- 最终 `pnpm test:t14-real` 的实际统计：**9 次真实模型请求 / 9 次预算结算，
  5 个 Chromium 动作、2 个证据 Artifact、1 条 CaseAttempt**；
  独立 `verdicts` 表中该用例的最终判定为 **passed**，Run 为
  **completed / complete**；reportedModelId=`MiniMax-M3`，
  用量来源=`reported`。测试过程没有点击业务按钮。
- 模型管理页新增仅管理员可用的建模表单：选择 Anthropic Messages 或
  OpenAI 兼容协议、配置模型 ID/HTTPS Endpoint 和 API Key。API Key
  只发送至原有 SecretVault 加密写入接口，不在模型 DTO 中返回；
  新建状态为 untested，必须独立执行 API 端能力探测（30 秒上限）。
- 该结果仅支持 **G3 基础技术冒烟链路**，尚不能代表整个平台 G3 综合验收。
- 后续需验证真实 AI 对带业务预期的失败页面作出有证据的错误判定、
  fresh-context 独立复现及 Finding 的状态转移；复杂页面、认证、
  图片输入与成本/延迟基准同样未在本轮覆盖。
- 真实供应商的模型路由、速率与上游可用性由供应商管理，不能假设始终稳定。
