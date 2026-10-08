# T10 用例生命周期管理设计方案 (T10-CASE-LIFECYCLE-PLAN)

本方案针对 P1/T10 保存用例（`SavedCase`）的全生命周期管理进行只读架构设计。依据 `docs/05-agent-handoff.md` (FR-035–036)、`docs/06-web-regression-and-scheduling.md` §1、存储层 007 迁移（`saved_cases` 与 `saved_case_versions`）及当前已实现的 `savedCases.ts` 路由，系统规划用例的**归档（Archive）**、**恢复（Restore）**、**复制（Duplicate / Copy）**、并发乐观锁、权限控制、不可变历史与报告保护机制。

---

## 1. 核心生命周期状态与不可变原则

### 1.1 状态模型

在 `packages/storage/migrations/007_p1_saved_cases.sql` 中，`saved_cases` 表已具备核心字段：

```sql
CREATE TABLE saved_cases (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  slug text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  current_approved_version_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug),
  UNIQUE (project_id, id)
);
```

- **生命周期状态**：`status IN ('active', 'archived')`；
- **并发控制版本**：`version integer`（实体乐观锁，每次实体修改或审批通过原子自增）；
- **当前批准基线**：`current_approved_version_id uuid`（外键受制于 `guard_saved_case_baseline()` 触发器，必须指向同项目且 `review_status = 'approved'` 的版本）。

### 1.2 历史不可变保护原则 (Audit & Report Retention)

1. **用例与运行解耦**：
   - 依据 `docs/06-web-regression-and-scheduling.md` §1：“报告中的一次执行与长期用例是不同实体。用例归档不删除其历史报告，恢复/复制产生明确版本。”
   - 归档操作**仅改变 `saved_cases.status`**，绝不级联删除或更新该用例历史生成的任何 `runs`、`run_cases`、`case_attempts`、`verdicts`、`findings` 或 `artifacts`。
2. **版本不可变性（Version Immutability）**：
   - `saved_case_versions` 中的每一行（`document`、`sha256`、`review_status`、`created_by`、`reviewed_by` 等）受 `guard_saved_case_version()` 触发器绝对保护，归档或恢复操作绝不篡改历史版本的正文或哈希。
3. **已冻结运行不受影响 (Frozen Run Immunity)**：
   - 当回归运行入队时，`run_case_regression_bindings` 已经冻结了 `source_version_id`、`source_sha256` 及完整 `RegressionBinding` 快照；
   - 用例随后被归档，该运行仍严格按照已持久化的原绑定快照在 Worker 中正常领取、调度、判定并出具报告；
   - 历史报告（`GET /runs/{runId}/report`）完整呈现执行时的快照来源。

---

## 2. 详细操作语义与并发/基线流转

### 2.1 归档 (Archive)

- **触发入口**：`POST /api/v1/saved-cases/{caseId}/archive`
- **并发控制**：请求必须提供 `expectedVersion`（对应 `saved_cases.version`）。
  - **Head 版本递增认知**：当用例版本 v1 经人审批准后，现有的 review 提交逻辑已执行 `UPDATE saved_cases SET current_approved_version_id = $1, version = version + 1 WHERE id = $2`，使 `saved_cases.version` 变为 2。因此归档请求的 `expectedVersion` 必须严格基于实际读取到的当前最新 Head `saved_cases.version`（例如已批准 v1 后应为 2，而非静态假定为 1）。
  - 若 `current_version <> expectedVersion`，抛出 409 `VERSION_CONFLICT`；
  - 若当前已处于 `'archived'` 状态，抛出 409 `VERSION_CONFLICT`（状态防重入）。
- **数据流转**：
  ```sql
  UPDATE saved_cases
  SET status = 'archived', version = version + 1
  WHERE id = $1 AND project_id = $2 AND version = $3;
  ```
- **新回归入队同事务行锁防竞态 (Admission Race Prevention)**：
  - 为避免“`POST /regression-runs` 先读到 active，但在入队事务提交前用例被并发归档”的竞态漏洞，在 `POST /regression-runs` 入门事务中，必须对所选版本所属的用例 Head 进行显式加锁与状态验证：
    ```sql
    SELECT c.id, c.status
    FROM saved_cases c
    JOIN saved_case_versions v ON v.case_id = c.id AND v.project_id = c.project_id
    WHERE v.id = ANY($1::uuid[]) AND c.project_id = $2
    FOR SHARE;
    ```
  - **拦截规则**：若任何一个选中的版本所属用例处于 `status = 'archived'` 状态，立即拒绝入队，抛出 422 `VALIDATION_ERROR`（“Archived case cannot be scheduled for regression”）；
  - `FOR SHARE` 锁确保在入队创建快照完成前，并发的 `/archive` 更新操作会受阻塞等待；若归档事务先提交，入队事务立即可见 `archived` 并拒绝。

### 2.2 恢复 (Restore)

- **触发入口**：`POST /api/v1/saved-cases/{caseId}/restore`
- **拟定规范语义（显式版本定义）**：
  - “恢复的显式版本”**特指 `saved_cases` 实体版本号递增（`saved_cases.version = version + 1`）**，用于乐观并发控制与实体变更审计；
  - 恢复操作**绝不自动新增 `saved_case_versions` 文档版本行**（文档内容未变）；
  - **完整保留旧批准基线**：恢复操作严格保留归档前的 `current_approved_version_id`！若归档前已有已批准版本，恢复后该基线立即可用，允许直接被新的回归运行选取；若归档前无批准基线，恢复后维持 `null`。
- **并发控制**：请求提供 `expectedVersion`。
  - 若 `current_version <> expectedVersion`，抛出 409 `VERSION_CONFLICT`；
  - 若当前已处于 `'active'` 状态，抛出 409 `VERSION_CONFLICT`。
- **数据流转**：
  ```sql
  UPDATE saved_cases
  SET status = 'active', version = version + 1
  WHERE id = $1 AND project_id = $2 AND version = $3;
  ```

### 2.3 复制 (Duplicate / Copy)

支持同项目复制与跨项目复制两种场景：

#### 2.3.1 显式源版本与同一性约束（取消默认回退）

- **必须提供 `sourceVersionId`**：在复制请求体中，`sourceVersionId` 设为**必填项（UUID 格式）**。
- **取消隐式源漂移**：彻底取消任何“未提供则自动回退到 approved 或 latest”的隐式逻辑，杜绝因并发新增草稿或并发审查批准导致的默认源版本漂移。
- **UUID 语义一致性与归属强校验**：
  - URL 路径 `{caseId}` 与请求体 `sourceVersionId` 均通过 OpenAPI 规范化为 canonical lowercase UUID 比较；
  - 查询数据库核验：所请求的 `sourceVersionId` 必须严格属于该 `{caseId}` 且属于同一源项目：
    ```sql
    SELECT v.id, v.case_id, v.project_id, v.document, v.sha256
    FROM saved_case_versions v
    WHERE v.id = $1 AND v.case_id = $2 AND v.project_id = $3;
    ```
  - 若不匹配或不存在，返回 404 `NOT_FOUND`（无跨用例存在性泄露）。
- **审计记录**：在 `audit_log` 的 `redacted_summary` 中明确固化记录 `sourceCaseId`、`sourceVersionId` 以及源版本的原存储哈希 `sourceDocumentSha256`，不回写或修改任何历史记录。

#### 2.3.2 复制授权边界（404 先于 403 明确阶梯）

- **源项目（Source Project）**：调用者必须拥有至少 **`read` 权限**（`can_project(source_project_id, 'read')`，即 Viewer 及以上）；
  - 若对源项目无读权限，返回 404 `NOT_FOUND`（严格杜绝跨项目存在性泄露）。
- **目标项目（Target Project）**：
  - **先核验项目存在性（404）**：在调用者 RLS 下查询目标项目：若目标项目不存在或调用者非目标项目成员，直接返回 404 `NOT_FOUND`（杜绝探测未授权目标项目）；
  - **再核验操作角色（403）**：若调用者是目标项目成员，但仅有 `viewer` 角色，返回 403 `FORBIDDEN`；必须具备 `operator` 或 `owner` 权限方可执行创建。

#### 2.3.3 目标项目边界验证与依赖 SHA 一致性防御（核心安全规则）

- **子模块依赖与 SHA 一致性强校验（防静默指向不同模块）**：
  - 当复制的用例包含 `step.kind === 'module'`（以及递归子模块依赖 DAG）：
    1. **目标存在与批准检查**：目标项目中必须已经存在对应的子模块 `name@version` 且处于 `review_status = 'approved'`（若缺失直接返回 422 `VALIDATION_ERROR`）；
    2. **递归 SHA 一致性核验**：
       - 查询源项目对应子模块的 `sourceModule.sha256`；
       - 查询目标项目同名子模块的 `targetModule.sha256`；
       - **若 `sourceModule.sha256 <> targetModule.sha256`，直接拒绝并返回 422 `VALIDATION_ERROR`**（“Referenced module SHA mismatch between source and target projects”）；
       - **设计宗旨**：杜绝因目标项目存在同名但实现不同的模块而导致用例被“静默重绑”至不同行为；系统绝不自动向目标项目隐式复制或覆盖模块；若需使用，调用者必须先在目标项目显式导入并完成人审。
  - **Fixture 规则**：若文档包含非空 `fixtureRefs: [...]`，严格按照当前 fail-closed 规范直接拒绝（返回 422），不扩展 T12 数据模板范围。
  - **命名与 Slug 冲突**：目标 `newSlug` 必须匹配 `^[a-zA-Z0-9_.-]+$`（1..120）。若目标项目中该 slug 已存在，返回 409 `IDEMPOTENCY_CONFLICT`（唯一键冲突）。
- **显式创建新实体与 Draft Version 1**：
  - 创建全新的 `saved_cases` 实体：新 `id = randomUUID()`，`status: 'active'`, `version: 1`, `current_approved_version_id: null`；
  - 创建新用例的 **Version 1**：正文 `doc.id` 更新为 `newSlug`，计算规范化 JSON 哈希 `sha256 = hashPayload(newDoc)`；
  - **状态严格固定为 `draft`（草稿）**：`review_status = 'draft'`, `reviewed_by = null`, `reviewed_at = null`；
  - **原因**：哪怕源版本在原项目中已被批准，复制出的新用例也**绝不自动继承批准状态**，必须在目标项目中由 Owner 执行两阶段人审（`review-preview` $\to$ `review`）确认后方可作为新基线并投入回归。

---

## 3. RBAC 权限与存在性隔离矩阵

| 用户角色       | 归档 (Archive)  | 恢复 (Restore)  | 同项目复制      | 跨项目复制 (源 $\to$ 目标)   | 查询列表/详情   |
| -------------- | --------------- | --------------- | --------------- | ---------------------------- | --------------- |
| **Viewer**     | 403 `FORBIDDEN` | 403 `FORBIDDEN` | 403 `FORBIDDEN` | 源读(允许) $\to$ 目标写(403) | 200 `OK`        |
| **Operator**   | 200 `OK`        | 200 `OK`        | 201 `CREATED`   | 源读(允许) $\to$ 目标写(201) | 200 `OK`        |
| **Owner**      | 200 `OK`        | 200 `OK`        | 201 `CREATED`   | 源读(允许) $\to$ 目标写(201) | 200 `OK`        |
| **非项目成员** | 404 `NOT_FOUND` | 404 `NOT_FOUND` | 404 `NOT_FOUND` | 源(404) 或 目标(404)         | 404 `NOT_FOUND` |

_注：列表查询（`GET /projects/{projectId}/saved-cases`）默认仅返回 `status = 'active'` 的用例；支持通过 Query 参数 `status=all` 或 `status=archived` 查询已归档用例。_

---

## 4. 精确 API 接口与 DTO 定义

### 4.1 DTO 契约设计

```ts
// 1. 归档输入 DTO
export interface SavedCaseArchiveInput {
  expectedVersion: number; // 必须符合 1..2147483647
}

// 2. 恢复输入 DTO
export interface SavedCaseRestoreInput {
  expectedVersion: number; // 必须符合 1..2147483647
}

// 3. 复制输入 DTO
export interface SavedCaseDuplicateInput {
  targetProjectId?: string; // 可选 UUID，省略表示同项目内复制
  newSlug: string; // 目标 slug，1..120，正则 ^[a-zA-Z0-9_.-]+$
  newName: string; // 目标名称，1..200
  sourceVersionId: string; // 必填 UUID，显式指定源版本，消除并发源漂移
}
```

### 4.2 三个核心端点规范

| 序号  | 接口方法与路径                                | 角色要求                           | 请求 Body                 | 成功响应        | 异常与错误码                                                                                                                                                                                |
| ----- | --------------------------------------------- | ---------------------------------- | ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | `POST /api/v1/saved-cases/{caseId}/archive`   | `operator`/`owner`                 | `SavedCaseArchiveInput`   | `200 SavedCase` | 403 `FORBIDDEN` (viewer)<br>404 `NOT_FOUND` (异项目/不存在)<br>409 `VERSION_CONFLICT` (版本不匹配或已归档)<br>422 `VALIDATION_ERROR` (参数非法)                                             |
| **2** | `POST /api/v1/saved-cases/{caseId}/restore`   | `operator`/`owner`                 | `SavedCaseRestoreInput`   | `200 SavedCase` | 403 `FORBIDDEN` (viewer)<br>404 `NOT_FOUND` (异项目/不存在)<br>409 `VERSION_CONFLICT` (版本不匹配或已活跃)<br>422 `VALIDATION_ERROR` (参数非法)                                             |
| **3** | `POST /api/v1/saved-cases/{caseId}/duplicate` | 源: `viewer`+<br>目标: `operator`+ | `SavedCaseDuplicateInput` | `201 SavedCase` | 403 `FORBIDDEN` (目标权限不足)<br>404 `NOT_FOUND` (源版本不匹配/目标未授权)<br>409 `IDEMPOTENCY_CONFLICT` (目标 slug 已存在)<br>422 `VALIDATION_ERROR` (依赖模块SHA不符/非空fixture/格式错) |

---

## 5. 隔离 PG/API 测试矩阵规划 (待派发实现时执行)

测试套件规划：`apps/api/test/t10-case-lifecycle.test.mjs`。启动唯一隔离 PostgreSQL 容器（`postgres:18-alpine`）与 API Server，模型传输严格拦截（0 calls），测试后全量清理回查。

### 5.1 归档、并发竞争与历史保留测试 (Archive & Report Retention)

1. **实际 Head 版本归档验证**：
   - 创建用例（初始 `saved_cases.version = 1`）；
   - 人审批准 Version 1，读取实际返回的最新 Head（此时 `saved_cases.version` 已自增为 2）；
   - 携带实际 Head `expectedVersion: 2` 调用 `POST /archive`，验证成功返回 200，`status = 'archived'`, `version = 3`；
   - 携带陈旧版本（如 `expectedVersion: 1`）再次请求 $\to$ 验证严格抛出 409 `VERSION_CONFLICT`；
   - 对已处于归档状态的用例再次调用归档 $\to$ 验证抛出 409 `VERSION_CONFLICT`。
2. **不可变版本与历史报告保留**：
   - 归档后调用 `GET /saved-cases/{caseId}/versions` $\to$ 200，历史文档、哈希、审批记录 100% 完整；
   - 归档前生成的运行，其 `GET /runs/{runId}/report` 报告正常导出，不因用例归档受损。
3. **入队事务行锁与新回归阻断 (Admission Race Defense)**：
   - 尝试将已归档用例的 approved 版本提交至 `POST /regression-runs` $\to$ 严格拦截，返回 422 `VALIDATION_ERROR`；
   - 在并发场景下模拟入队事务与归档事务交错，验证 `FOR SHARE` 锁确保两个操作严格串行化，不存在“读到 active 随后归档却入队成功”的漏网情况。
4. **已冻结运行不受干扰**：
   - 用例批准 $\to$ 发起回归运行（生成 frozen binding） $\to$ 归档用例 $\to$ 验证 Worker 仍能正常执行该运行并出具完整判定。

### 5.2 恢复与基线保留测试 (Restore & Baseline Retention)

1. **正常恢复与实体版本递增**：
   - 对已归档用例调用 `POST /restore`（带实际 Head `expectedVersion: 3`），返回 200，`status = 'active'`, `version = 4`；
   - 验证**未创建新的 `saved_case_versions` 版本行**（版本列表行数与归档前一致）。
2. **批准基线完整性**：
   - 验证恢复后的 `currentApprovedVersionId` 仍然严格等于归档前的 approved 版本 ID。
3. **重新入队执行成功**：
   - 恢复后将该版本再次提交至 `POST /regression-runs` $\to$ 成功入队，返回 202 `ACCEPTED`。
4. **非归档状态恢复拦截**：
   - 对已处于 active 的用例调用恢复 $\to$ 返回 409 `VERSION_CONFLICT`。

### 5.3 同项目与跨项目复制测试 (Duplicate & Boundary Validation)

1. **同项目复制显式源版本为 Draft v1**：
   - 显式指定 `sourceVersionId` 复制为新 slug，返回 201 `SavedCase`，`version: 1`, `status: 'active'`, `currentApprovedVersionId: null`；
   - 查询新用例版本列表：仅有 Version 1 且其 `review_status = 'draft'`，必须经人审后方可运行；
   - 审计日志回查：验证 `audit_log` 完整记录源 case ID、version ID 及原文档 SHA，历史源无改动。
2. **源版本归属严格校验**：
   - 若 `sourceVersionId` 属于 Case B，但在 Case A 的复制接口中传入 $\to$ 返回 404 `NOT_FOUND`（无跨用例泄漏）。
3. **跨项目复制依赖模块 SHA 不一致防御 (Module SHA Mismatch Defense)**：
   - 源项目具备 approved 模块 `auth/login@1`（SHA = X）；
   - 目标项目具备 approved 模块 `auth/login@1`（SHA = Y，且 X $\ne$ Y）；
   - 尝试跨项目复制该用例 $\to$ 严格拦截，返回 422 `VALIDATION_ERROR`（禁止静默重绑至不同行为实现）；
   - 验证目标项目**零落库**。
4. **跨项目复制依赖模块 SHA 一致放行**：
   - 源项目与目标项目具备相同 SHA 的 approved 模块 `auth/login@1` $\to$ 复制请求成功通过，生成 Draft v1。
5. **跨项目授权阶梯校验 (404 先于 403)**：
   - 用户为 Project B (Operator)，但非 Project A 成员：从 A 复制至 B $\to$ 返回 404 `NOT_FOUND`；
   - 用户为 Project A (Viewer) 和 Project B (Viewer)：从 A 复制至 B $\to$ 返回 403 `FORBIDDEN`（目标无写权限）；
   - 复制到不存在的 Project C $\to$ 返回 404 `NOT_FOUND`。
6. **非空 Fixture 拦截**：源用例若包含非空 `fixtureRefs` $\to$ 复制请求被拦截，返回 422。
7. **Slug 重名冲突防御**：复制时指定目标项目中已存在的 slug $\to$ 返回 409 `IDEMPOTENCY_CONFLICT`。

### 5.4 零落库与资源回查

- 针对所有失败请求（403, 404, 409, 422），数据库回查验证没有产生任何残留脏用例或版本数据；
- 测试完毕执行容器与端口销毁回查，确认 `modelTransportCalls = 0`，不启动真实浏览器。

---

## 6. 后续约束与当前声明

- **后续 T11 定时调度约束（非本期实现）**：
  - 将来 T11 调度执行器在触发定时运行前，必须与 `regression-runs` 共享同一前置检查，跳过或拒绝已归档用例，避免对已归档用例产生意外周期调度。
- **只读设计交付**：本文档为纯设计方案，写入 `docs/validation-results/T10-case-lifecycle-plan.md`；
- **零环境副作用**：未改动共享契约生成器、未修改产品源码、未修改迁移脚本、未修改旧测试；
- **状态维持**：Ego 继续暂停，P0 保持不放行。等待 Root 核准并冻结相关契约后派发实现。
