# T44 产品功能交付：运行报告、真实文件导出与证据查看

日期：2026-10-10。项目工作区：`E:\AI\momentic`。
本阶段继续完成功能闭环，没有压力测试、付费模型调用、生产部署或 Git 提交。

## 实际交付

1. 工作台“报告”页基于真实 Report 数据展示更多判定指标，包括
   未执行、不确定、尝试率、覆盖缺口、运行警告、清理状态、
   缺陷和证据总数；报告内提供缺陷与用例详情入口。
   未取得报告时不提示“通过”，允许刷新运行与报告快照。
2. 新增 `ReportExportPanel`，通过既有
   `POST /runs/{runId}/exports` 创建 JSON、Markdown 或 ZIP 导出，
   校验 `runId/format/status`，再用
   `GET /artifacts/{artifactId}/content` 下载二进制文件。
   只有状态为 ready 且有 artifactId 的导出才触发下载；
   queued/running 提供状态刷新（`GET /exports/{exportId}`），
   下载失败有可重试入口，不把“创建导出记录”误报为文件已保存。
   ZIP 显式请求包括关联证据；最终文件名限制在安全字符集。
3. 缺陷详情不再只获取第一条证据。新
   `FindingEvidencePanel` 显示完整 evidenceRefs，每条独立核对
   元数据及项目/运行归属。缺失、失败、脱敏失败的证据
   不作为有效截图展示，也不允许下载。
   可用证据使用受认证保护的 `downloadArtifact` API 下载；
   PNG 截图可按需预览，校验 MIME 类型并清理 blob URL。
4. 复用已有生成 API 客户端及后端导出契约，没有新增无必要的
   导出后端协议。新增 Web npm 命令：
   `pnpm --filter @localqa/web test:functional-report`。

## 已完成验证

- `pnpm --filter @localqa/web build`：TypeScript + Vite 生产构建通过。
- `pnpm --filter @localqa/web test:functional-report`：
  真正启动 Vite/React/HttpApiClient 和 Chromium，
  读取浏览器下载文件的磁盘字节，验证 JSON 中 run ID、
  Markdown 内容及 ZIP 文件头。
  覆盖异步 queued → ready 状态查询，
  进入缺陷详情，展示多证据，
  缺失证据不可下载，PNG 文件下载字节匹配，
  并确认 PNG 浏览器实际解码成功。
  这些 Chromium HTTP 响应为本地隔离 fixture，不代表生产站点。
- `pnpm --filter @localqa/api test`：
  PostgreSQL 18 + API 真正集成测试 **16/16 通过**；
  报告/导出原有测试验证 JSON、ZIP，新增 Markdown 的
  `202` 导出记录、ready 状态、真实响应 MIME 和内容字节。
  ZIP 测试实际解包，并验证清单中材料 SHA-256。
- 新增/修改前端 TSX/JS 代码 ESLint 检查通过。

## 尚未完成

- 导出状态当前为手动刷新，不是自动轮询；
  历史导出列表、批量证据下载和下载断点续传 UI 尚未实现。
- 前端 Chromium 测试使用受控响应，不是与同一次 PostgreSQL
  实例相连的完整真实 Worker 浏览器运行。
- 真实 form/storage_state 登录站点集成、更多维度报告分析、
  环境归档/恢复、审计日志查询与正式发布 G3/P0 仍待后续交付。

保留历史未提交修改和已有验证账本；没有 commit、push、
reset、clean、stash 或生产部署。
