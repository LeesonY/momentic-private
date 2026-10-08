# T10 模块管理与两阶段审批设计方案 (T10-MODULES-PLAN)

本方案针对 P1/T10 模块（`RegressionModule`）全生命周期进行只读架构设计。依据 `docs/05-agent-handoff.md` (FR-035–036)、`docs/06-web-regression-and-scheduling.md` §1–§2、存储层 007/008/009 迁移以及 `packages/orchestrator` 编译器规范，规划模块版本注册、两阶段人审、嵌套模板校验与隔离测试。

---

## 1. 现有架构审查与 010 增量迁移设计

### 1.1 009 现有实现与阻碍审计
在 `packages/storage/migrations/009_regression_bindings.sql` 中：
1. **复合主键**：`regression_module_versions` 使用 `PRIMARY KEY(project_id, name, version)` 复合键；当前没有 UUID 形式的主键，也没有 `created_by` / `created_at` / `reviewed_by` / `reviewed_at` 审计列。
2. **UPDATE/DELETE 完全封死**：
   - 表级触发器 `regression_module_immutable` 挂载了 `guard_regression_snapshot()`；
   - `guard_regression_snapshot()` 第一行即判定：
     ```sql
     IF TG_OP <> 'INSERT' THEN
       RAISE check_violation USING MESSAGE='regression snapshot immutable';
     END IF;
     ```
   - 导致该表**物理上拒绝任何 UPDATE**。即使插入了 `review_status = 'draft'`，也无法直接流转为 `'approved'`。
3. **RLS 与 Grants 限制**：
   - `module_register` 策略限制 `INSERT` 必须满足 `can_project(project_id, 'owner')`；
   - `localqa_app` 仅获授 `SELECT, INSERT`，未获授 `UPDATE`。
4. **现有绑定守卫与预览表外键**：
   - `008_saved_case_review_previews` 外键为 `version_id uuid REFERENCES saved_case_versions(project_id, id)`，无法挂载复合主键的模块版本；
   - `run_case_regression_bindings` 上的 `regression_binding_guard` 触发器要求 `moduleSnapshots` 数组必须匹配已存在且 `review_status = 'approved'` 的模块行。

### 1.2 为什么必须同时引入“专用预览表”与“独立触发器”
“专用预览表”与“独立触发器”**不是二选一，而是缺一不可的协同架构**：
- **专用预览表（复合外键与跨 Actor 隔离）**：由于模块无 UUID 且需要与 SavedCase 审查同样严密的安全属性（绑定 actor、decision、reason、body_hash、token_hash、300s TTL、单次消费标记 `consumed_at`），必须有对应复合键外键的独立预览持久化表；且预览记录查询与更新必须严格限定为生成该 Token 的特定 Owner（`actor_id = actor_id()`）。当 Owner B 查询或提交 Owner A 的 Token 时，查询结果直接为空，统一返回 409 `VERSION_CONFLICT`，杜绝不同 Owner 间横向越权探测或冒用，且不泄露他人 Token 的存在性（无 403 泄露）。本期无删除清理需求，该表无需授 `DELETE`。
- **独立审批触发器（状态机单向迁移与元数据保护）**：必须替换 009 在模块表上的全量禁止触发器，允许在且仅在受控审批事务中将 `review_status` 从 `'draft'` 单向变更为 `'approved'` 或 `'rejected'`，同时对 `document`、`sha256`、`version` 及创建元数据保持绝对物理不可变。

### 1.3 新增增量迁移：`010_regression_module_reviews.sql`
**设计原则**：严格新增迁移，不改动 001～009，不触碰 `run_case_regression_bindings` 及其 `regression_binding_guard` 触发器，不对既有历史行伪造作者（历史四审计字段保持 `NULL`）。

```sql
-- 010_regression_module_reviews.sql

-- 1. 向 regression_module_versions 增加 nullable 审计列
-- 核心一致性设计：先添加 nullable 无 DEFAULT 列，防止 Postgres 自动将历史行回填为当前时间；
-- 随后 ALTER SET DEFAULT 供未来插入使用。历史既有行的四个审计字段严格保持为 NULL，不伪造历史行 author。
ALTER TABLE regression_module_versions
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN created_at timestamptz,
  ADD COLUMN reviewed_by uuid REFERENCES users(id),
  ADD COLUMN reviewed_at timestamptz;

ALTER TABLE regression_module_versions
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- 2. 解耦 regression_module_versions 上的全量不可变触发器，引入专用的模块版本状态机与元数据守卫
DROP TRIGGER regression_module_immutable ON regression_module_versions;

CREATE FUNCTION guard_regression_module_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE check_violation USING MESSAGE = 'regression module version is immutable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- 新创建行状态必须为 draft（直接 INSERT approved 仅限无 localqa.actor_id 的 superuser 历史导入环境）
    IF current_setting('localqa.actor_id', true) IS NOT NULL AND NEW.review_status <> 'draft' THEN
      RAISE check_violation USING MESSAGE = 'new regression module version must be draft';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- 核心不可变列绝对保护：project_id, name, version, sha256, document 永远不可被篡改
    IF ROW(NEW.project_id, NEW.name, NEW.version, NEW.sha256, NEW.document)
       IS DISTINCT FROM ROW(OLD.project_id, OLD.name, OLD.version, OLD.sha256, OLD.document) THEN
      RAISE check_violation USING MESSAGE = 'regression module document and identity are immutable';
    END IF;

    -- 创建审计元数据绝对保护：created_by, created_at 永远不可修改
    IF ROW(NEW.created_by, NEW.created_at) IS DISTINCT FROM ROW(OLD.created_by, OLD.created_at) THEN
      RAISE check_violation USING MESSAGE = 'regression module creation metadata is immutable';
    END IF;

    -- 仅允许状态机单向迁移：draft -> approved / rejected，且必须是项目 owner 操作
    IF NEW.review_status IS DISTINCT FROM OLD.review_status THEN
      IF OLD.review_status <> 'draft' OR NEW.review_status NOT IN ('approved', 'rejected')
         OR NOT can_project(NEW.project_id, 'owner')
         OR NEW.reviewed_by IS DISTINCT FROM actor_id()
         OR NEW.reviewed_at IS NULL THEN
        RAISE check_violation USING MESSAGE = 'regression module review transition is invalid';
      END IF;
    ELSIF ROW(NEW.reviewed_by, NEW.reviewed_at) IS DISTINCT FROM ROW(OLD.reviewed_by, OLD.reviewed_at) THEN
      RAISE check_violation USING MESSAGE = 'regression module review metadata is immutable';
    ELSE
      RAISE check_violation USING MESSAGE = 'regression module review status is immutable';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER regression_module_version_guard
  BEFORE INSERT OR UPDATE OR DELETE ON regression_module_versions
  FOR EACH ROW EXECUTE FUNCTION guard_regression_module_version();

-- 3. 调整 regression_module_versions 的 RLS 与权限：
-- 放宽草稿插入至 operator，但强制约束 review_status = 'draft'、绑定 created_by = actor_id()、
-- 确保 created_at 非空且 reviewed_* 初始为 NULL，严防越权注入 approved 或伪造元数据
DROP POLICY module_register ON regression_module_versions;
CREATE POLICY module_register ON regression_module_versions
  FOR INSERT TO localqa_app
  WITH CHECK(
    can_project(project_id, 'operator')
    AND review_status = 'draft'
    AND created_by = actor_id()
    AND created_at IS NOT NULL
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
  );

CREATE POLICY module_review_update ON regression_module_versions
  FOR UPDATE TO localqa_app
  USING(can_project(project_id, 'owner'))
  WITH CHECK(can_project(project_id, 'owner'));

GRANT UPDATE ON regression_module_versions TO localqa_app;

-- 4. 创建复合键专用的模块审查预览表（无 DELETE 授权，本期无清理动作）
CREATE TABLE regression_module_review_previews (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  module_name text NOT NULL,
  version integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  expected_version integer NOT NULL,
  body_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  approved_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, module_name, version)
    REFERENCES regression_module_versions(project_id, name, version)
);

ALTER TABLE regression_module_review_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE regression_module_review_previews FORCE ROW LEVEL SECURITY;

-- 跨 Actor 严格隔离：SELECT 和 UPDATE 必须严格匹配 actor_id = actor_id()，防止 Token 泄露给其他 Owner
CREATE POLICY module_preview_read ON regression_module_review_previews
  FOR SELECT TO localqa_app
  USING(can_project(project_id, 'owner') AND actor_id = actor_id());

CREATE POLICY module_preview_insert ON regression_module_review_previews
  FOR INSERT TO localqa_app
  WITH CHECK(can_project(project_id, 'owner') AND actor_id = actor_id());

CREATE POLICY module_preview_update ON regression_module_review_previews
  FOR UPDATE TO localqa_app
  USING(can_project(project_id, 'owner') AND actor_id = actor_id())
  WITH CHECK(can_project(project_id, 'owner') AND actor_id = actor_id());

-- 仅授权 SELECT, INSERT, UPDATE，不授权 DELETE
GRANT SELECT, INSERT, UPDATE ON regression_module_review_previews TO localqa_app;

CREATE FUNCTION guard_module_review_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE check_violation USING MESSAGE = 'module review preview cannot be deleted';
  END IF;

  -- 仅允许 consumed_at 从 NULL 变为非 NULL 一次，其余所有字段及 TTL 绝对不可篡改
  IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
     OR (OLD.consumed_at IS NULL AND NEW.consumed_at IS NULL) THEN
    RAISE check_violation USING MESSAGE = 'module review preview is immutable except single consumption';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER module_review_preview_immutable
  BEFORE UPDATE OR DELETE ON regression_module_review_previews
  FOR EACH ROW EXECUTE FUNCTION guard_module_review_preview();
```

---

## 2. DTO 契约分离与历史快照兼容保护

### 2.1 契约保护原则
现有 `RegressionModuleVersion` 定义为：
```ts
export interface RegressionModuleVersion {
  projectId: string;
  name: string;
  version: number;
  sha256: string;
  document: RegressionDocument;
  reviewStatus: "draft" | "approved" | "rejected";
}
```
**严格对齐准则**：
- `RegressionModuleVersion` 是 `RegressionBinding.moduleSnapshots` 数组的核心元素，已被 009 触发器 `guard_regression_snapshot()` 的 JSONB 字段严格校验。
- **绝不修改 `RegressionModuleVersion` 已有 6 字段结构**，使其继续纯粹作为**不可变快照契约**。
- 为满足管理、查询、列表展示需求，新增专用的管理 DTO **`RegressionModuleRecord`**，扩展 4 个 nullable 审计字段，忠实呈现历史行（历史行的 4 个字段为 `null`，新行固化实际信息，不伪造历史行 author）。

### 2.2 专用 DTO 契约设计

```ts
// 1. 模块注册输入（支持乐观版本控制）
export interface RegressionModuleCreate {
  name: string;            // 匹配 ^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$, 1..120
  document: RegressionDocument;
  expectedVersion?: number; // 0 或省略代表初始创建版本 1；>0 代表在此期望版本上自增
}

// 2. 模块管理记录 DTO（包含 6 快照字段 + 4 审计字段）
export interface RegressionModuleRecord {
  projectId: string;
  name: string;
  version: number;
  sha256: string;
  document: RegressionDocument;
  reviewStatus: "draft" | "approved" | "rejected";
  createdBy: string | null;
  createdAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

// 3. 模块管理记录分页响应
export interface RegressionModuleRecordPage {
  items: RegressionModuleRecord[];
  nextCursor: string | null;
}

// 4. 复合键专用模块审查预览输入
export interface RegressionModuleReviewPreviewInput {
  expectedVersion: number;
  decision: "approve" | "reject";
  reason: string;
}

// 5. 复合键专用模块审查预览响应（替代含 UUID versionId 的 ReviewPreview）
export interface RegressionModuleReviewPreview {
  projectId: string;
  moduleName: string;
  version: number;
  expectedVersion: number;
  decision: "approve" | "reject";
  reason: string;
  diff: string;
  risks: string[];
  confirmationToken: string;
  expiresAt: string;
}

// 6. 复合键专用模块审查确认输入
export interface RegressionModuleReviewCommit {
  expectedVersion: number;
  decision: "approve" | "reject";
  reason: string;
  confirmationToken: string;
}
```

---

## 3. 并发控制与版本号乐观锁方案

在多人员、多流水线并发注册同名模块时，杜绝静默覆盖或竞态空窗：

1. **事务级 Advisory Lock**：
   在创建版本事务开始时，获取基于项目与模块名称哈希的排他锁：
   ```sql
   SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0));
   ```
   参数：`projectId` 与 `moduleName`。
2. **版本号解析与乐观核验**：
   查询当前数据库中该模块已存在的最大版本号：
   ```sql
   SELECT COALESCE(max(version), 0) AS current_version
   FROM regression_module_versions
   WHERE project_id = $1 AND name = $2;
   ```
   - 若客户端提供了 `expectedVersion`：
     - 当 `current_version <> input.expectedVersion` 时，直接抛出 `StorageError('VERSION_CONFLICT')`（HTTP 409），阻断旧基础上的并发覆写。
   - 若客户端未提供 `expectedVersion`（初次创建）：
     - 当 `current_version > 0` 时，要求显式提供 `expectedVersion`，抛出 `StorageError('VERSION_CONFLICT')`（HTTP 409）。
3. **版本自增与插入保护**：
   - 新版本号确定为 `current_version + 1`；
   - 插入 `regression_module_versions`，设置 `created_by = actor_id()`, `created_at = clock_timestamp()`, `review_status = 'draft'`；
   - 依赖 Postgres 复合主键 `PRIMARY KEY(project_id, name, version)` 作为最终屏障。

---

## 4. 模板注册静态校验 vs 执行期编译解耦

模块本质是**参数化测试模板**，其在注册期的验证与用例在执行期的编译必须完全解耦：

### 4.1 核心矛盾与变量表达式规则
- 表达式**严格仅允许现有的 `{{vars.NAME}}` 与 `{{env.NAME}}`**，**绝不新增任何 `params` DSL 关键字**。
- 模块模板内部的形参引用统一使用 `{{vars.NAME}}`。在执行时，调用方 `step.arguments` 会与模板本身的 `doc.variables` 在 `expand` 作用域合并入 `vars`（见 `regression-compiler.ts` 的 `expand` 实现），天然满足模板形参求值需求。
- 如果注册期调用 `compileRegression`，编译器会在缺少调用方具体实参和特定 `BASE_URL` 的情况下尝试求值，导致合法模板因 `MISSING_VARIABLE` 或 `INVALID_EXPRESSION` 被**错误拦截**。

### 4.2 现有校验现状与专用模板静态校验器设计
现有 `validateRegressionDocument` 仅循环遍历直层 step 属性的 `typeof value === 'string'`，**无法检查所有变量语法、危险键、嵌套 arguments、未声明 criteria 引用或子模块正文 SHA 一致性**。

因此，模块注册入口必须设计专用的模板静态分析守卫 **`validateModuleTemplateStatic(doc, projectModules)`**，严格执行以下静态安全检查（纯语法与拓扑分析，不执行变量插值与求值）：

1. **递归 Plain JSON 与安全基线检查**：
   - 递归核验对象原型必须为 `Object.prototype` 或 `null`，禁止非普通对象；
   - 递归核验对象键，严格拦截危险原型键：`__proto__`, `constructor`, `prototype`；
   - 递归核验所有数值必须为有效有限数（`Number.isFinite(v)`），拦截 `NaN`、`Infinity`。
2. **变量与参数静态规范**：
   - `doc.variables` 的键名以及 `step.arguments` 的形参键名必须严格为全大写字母下划线：`/^[A-Z][A-Z0-9_]*$/`；
   - `variables` 与 `arguments` 的值必须为标量（`string | number | boolean`），禁止嵌套复杂对象；
   - **全文档模板字符串语法校验**：在步骤的所有字符串字段、Locator 的 `value` / `name`、断言的 `description` / `expectedValue`、调用参数的字符串值中，只要包含 `{{...}}`，必须严格匹配语法正则 `^\{\{(env|vars)\.[A-Z][A-Z0-9_]*\}\}$`，严防藏匿的畸形表达式，但**不对其求值**。
3. **断言声明唯一性与步骤引用闭包**：
   - `criteria` 数组中每个 criterion 的 `id` 必须在当前文档内全局唯一，禁止重复 ID；
   - `assert.criterionId` 引用的 ID 必须已在当前文档的 `criteria` 声明；
   - `ai_action.criteriaIds` 数组必须非空，且其包含的每一个 ID 都必须已在当前文档的 `criteria` 声明；
   - 严禁声明 `fixtureRefs`（若存在或非空，直接 fail-closed 返回 422）。
4. **子模块引用与 SHA 一致性校验**：
   - 模块调用 `step.kind === 'module'` 的引用格式必须匹配 `^[a-zA-Z0-9_./-]+@[1-9][0-9]*$`；
   - 被引用的子模块必须在同项目中存在，且 `review_status === 'approved'`（禁止引用草稿或不存在的模块）；
   - **正文 SHA 一致性核验**：数据库存储的子模块 `sha256` 必须与其规范化正文 hash `hashPayload(moduleRow.document)` 完全一致，防止历史脏记录扩散。
5. **调用栈深度与拓扑安全上限**：
   - **调用栈深度计算**：以模块调用路径长度计（根用例发起层为 0）。允许嵌套调用 8 次（深度 1～8）；当尝试发起第 9 次嵌套引用（调用栈已有 8 个模块，即将进入第 9 层）时严格拦截，抛出 422 `MODULE_DEPTH`。
   - **有向无环图检测**：遍历依赖树，若出现递归环（A 包含 B，B 包含 A），抛出 422 `MODULE_CYCLE`；同级 Sibling 重复引用合法放行。
   - **显式安全规范：100 为注册拓扑展开安全上限的拟定值**（Registration Static Topology Expansion Safety Limit）。静态累加模板依赖树展开步骤总数，若超过 100，直接在注册期拒绝（422 `STATIC_STEP_LIMIT`），防止静态组合放大攻击。

### 4.3 执行期入队编译（动态预算重新求值）
当用例被提交到 `POST /regression-runs` 时：
- 由编排层 `compileRegression` 结合实际传入的 `BASE_URL`、用例 `variables`、模块调用级 `arguments`，完成字符串插值、URL 最终 origin 检查与完整的 criteria ID 别名映射；
- **执行期严格按照 `budget.maxActionsPerCase`（系统默认 12，用例预算上限 30）重新编译**。即使模板在注册期满足 $\le 100$ 的静态安全上限，若在特定用例中与其它步骤合并后超出了运行预算设定的步数动作上限，仍会在执行入队时被严格拦截。

---

## 5. URL 编码与精确非 UUID 路径边界规范

在契约生成器 `build_contracts.py` 中，现有 operation 默认将所有 path parameters 映射为 `type: "string", format: "uuid"`。模块端点必须显式配置 **path schema overrides**，其精确参数边界如下：

### 5.1 `{moduleName}` 路径参数边界 (Path Schema Override)
- **参数定位**：`in: "path"`, `name: "moduleName"`, `required: true`；
- **Schema 定义**：
  ```json
  {
    "type": "string",
    "minLength": 1,
    "maxLength": 120,
    "pattern": "^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$"
  }
  ```
- **编码与安全边界**：
  - 允许字符：大小写字母、数字、下划线、短横线、点、斜杠（层级路径）；
  - 格式约束：禁止以 `/` 开头或结尾，禁止连续双斜杠 `//`，禁止包含 `.` 或 `..` 相对路径穿透段；
  - **URI 编码边界**：当模块名包含 `/`（如 `auth/login`）时，客户端发出的 HTTP 路径必须进行标准 `%2F` 编码：
    `GET /api/v1/projects/{projectId}/regression-modules/auth%2Flogin/versions`
  - 服务端 Router 使用 `([^/]+)` 匹配单路径段，提取后调用 `decodeURIComponent` 还原真实模块名并校验正则。未编码斜杠会因路径段切分直接返回 404。

### 5.2 `{version}` 路径参数边界 (Path Schema Override)
- **参数定位**：`in: "path"`, `name: "version"`, `required: true`；
- **Schema 定义**：
  ```json
  {
    "type": "integer",
    "minimum": 1,
    "maximum": 2147483647
  }
  ```
- **数值与正则双重边界**：
  - 必须完全匹配正整数字符正则 `^[1-9][0-9]*$`；
  - **PostgreSQL 32 位 signed integer 上界拦截**：严格限定 $1 \le \text{version} \le 2147483647$ ($2^{31} - 1$)；
  - 拒绝规则：拒绝 `0`、负数、浮点数、非数字字符，以及 $> 2147483647$ 的溢出数值（返回 422 `VALIDATION_ERROR`）。

### 5.3 `{projectId}` 路径参数
- 保持标准的 UUID 契约：`type: "string", format: "uuid"`。

---

## 6. 精确五个 API 接口与确定性分页设计

| 序号 | 接口方法与路径 | 角色要求 | 请求 Body | 成功响应 (状态码) | 异常与错误码 |
|---|---|---|---|---|---|
| **1** | `POST /api/v1/projects/{projectId}/regression-modules` | `operator`/`owner` | `RegressionModuleCreate` | `201 RegressionModuleRecord` | 403 `FORBIDDEN` (viewer)<br>404 `NOT_FOUND` (异项目)<br>409 `VERSION_CONFLICT` (版本冲突)<br>422 `VALIDATION_ERROR` (拓扑/深度/语法错) |
| **2** | `GET /api/v1/projects/{projectId}/regression-modules` | `viewer` 及以上 | Query: `limit`, `cursor` | `200 RegressionModuleRecordPage` | 404 `NOT_FOUND` (异项目)<br>422 `VALIDATION_ERROR` (分页参数错) |
| **3** | `GET /api/v1/projects/{projectId}/regression-modules/{moduleName}/versions` | `viewer` 及以上 | Query: `limit`, `cursor` | `200 RegressionModuleRecordPage` | 404 `NOT_FOUND` (模块不存在或异项目)<br>422 `VALIDATION_ERROR` (命名/游标格式错) |
| **4** | `POST /api/v1/projects/{projectId}/regression-modules/{moduleName}/versions/{version}/review-preview` | `owner` 专属 | `RegressionModuleReviewPreviewInput` | `200 RegressionModuleReviewPreview` | 403 `FORBIDDEN` (viewer/operator)<br>404 `NOT_FOUND`<br>409 `VERSION_CONFLICT` (非草稿状态)<br>422 `VALIDATION_ERROR` |
| **5** | `POST /api/v1/projects/{projectId}/regression-modules/{moduleName}/versions/{version}/review` | `owner` 专属 | `RegressionModuleReviewCommit` | `200 RegressionModuleRecord` | 403 `FORBIDDEN`<br>404 `NOT_FOUND`<br>409 `VERSION_CONFLICT` (Token过期/已消费/不匹配)<br>422 `VALIDATION_ERROR` |

### 6.1 游标分页选型与边界说明
为统一全站 API 风格，确定采用 **基于 Base64URL 编码的偏移量游标（Offset Cursor）**（严格遵循 `apps/api/src/router.ts` 的 `parsePagination` 实现）：
- **接口 2（项目模块列表）**：
  - 排序 SQL：`ORDER BY name ASC, version DESC`；
  - 游标实现：`cursor = base64url(offset)`。
- **接口 3（指定模块版本列表）**：
  - 排序 SQL：`ORDER BY version DESC`；
  - 游标实现：`cursor = base64url(offset)`。
- **并发位移边界显式声明**：
  - 该游标实现保证在单次请求内的稳定排序与合法提取；但在极端并发新增时，翻页可能存在自然位移（新版本插入导致旧数据后移），**不声称跨请求的快照隔离分页**。

---

## 7. 隔离 PG/API 测试矩阵规划 (待派发实现时执行)

测试文件规划：`apps/api/test/t10-modules.test.mjs`。独立创建 Docker PG 容器与 API Server，模型传输严格拦截（0 calls），执行完毕验证资源完全销毁。

### 7.1 完整生命周期测试 (Happy Path)
1. **草稿创建**：Operator 创建模块 `common/nav` v1，验证返回 201，状态为 `draft`，SHA 与 `hashPayload(doc)` 一致，返回记录中包含有效的 `createdBy` 与 `createdAt`，`reviewedBy` 为 null。
2. **预览生成**：Owner 请求 review-preview，验证返回 200，颁发 64 位 Token，包含有效文本差异。
3. **人审通过**：Owner 提交 review，验证返回 200，状态变为 `approved`；返回记录包含固化的 `reviewedBy` 与 `reviewedAt`。
4. **版本迭代**：Operator 提交同名模块 v2，指定 `expectedVersion: 1`，验证创建版本 2 草稿，v1 保持 approved 不变。
5. **用例实际引用**：已批准的 `common/nav@1` 被一个 SavedCase 成功引用，发起回归运行验证快照完整写入 `run_case_regression_bindings`。

### 7.2 未绑定变量模板正反闭环验证 (Unbound Template Lifecyle)
1. **未绑定模板成功注册与审批**：
   - 注册包含未绑定 `{{vars.DYNAMIC_TOKEN}}` 和 `{{env.BASE_URL}}` 的合法模块模板；
   - 验证模板静态分析不求值，顺利生成草稿并完成人审（201 / 200）。
2. **执行期缺变量拦截**：
   - 用例调用该模块但未在 `step.arguments` 提供 `DYNAMIC_TOKEN`；
   - 提交执行（`POST /regression-runs`）时，触发 `compileRegression` 求值拦截，返回 422 `MISSING_VARIABLE`。

### 7.3 隐匿非法表达式与语法负例 (Hidden Expression Negatives & Zero Persistence)
1. **Locator 藏匿非法表达式**：`locator.value: "{{invalid_var}}"` 或 `locator.value: "{{eval(x)}}"` $\to$ 422。
2. **Criterion 藏匿非法表达式**：`criterion.description: "Check {{bad}}"` 或 `criterion.id: "{{invalid}}"` $\to$ 422。
3. **调用参数藏匿非法表达式**：`step.arguments: { RETRIES: "{{bad_syntax}}", UNKNOWN: 1 }` $\to$ 422。
4. **Criterion ID 重复**：同文档内声明两个相同 ID 的 criterion $\to$ 422。
5. **Assert 引用未声明 Criterion**：`step.assert` 引用文档 `criteria` 中不存在的 ID $\to$ 422。
6. **AI Action 引用未声明 Criterion**：`step.ai_action.criteriaIds` 包含未声明 ID $\to$ 422。
7. **零落库验证**：针对以上全部 422 失败请求，查询数据库验证 `count(*) = 0`，确保**零落库**。

### 7.4 权限与存在性隔离测试 (Security & RBAC)
1. **Viewer 拒绝写操作**：Viewer 尝试调用接口 1 注册模块返回 403；尝试调用接口 4 预览或接口 5 审批均返回 403。
2. **Viewer 允许读操作**：Viewer 调用接口 2 和接口 3 查询模块与版本，返回 200。
3. **Operator 无法越权审批**：Operator 能够注册草稿，但调用接口 4 生成预览或接口 5 提交审批时返回 403。
4. **跨项目零泄漏**：非项目成员访问接口 1～5 均返回 404 `NOT_FOUND`，无项目或模块存在性泄漏。

### 7.5 两阶段人审与 Token 攻击防御 (Review Integrity)
1. **Token 单次消费（防重放）**：使用合法 Token 批准后，二次重试同一请求，返回 409 `VERSION_CONFLICT`。
2. **跨 Actor 探测与冒用隔离**：Owner A 生成的预览 Token，Owner B 查询不到该行；Owner B 提交该 Token 审批时，因预览行不存在统一返回 409 `VERSION_CONFLICT`，不泄露 Owner A 的 Token 存在性。
3. **内容篡改防御**：生成预览后，提交审核时修改 `expectedVersion`、`decision` 或 `reason`，返回 409 `VERSION_CONFLICT`。
4. **TTL 过期失效**：构造已过期 Token（或模拟等待），提交审核返回 409 `VERSION_CONFLICT`。
5. **草稿状态前置约束**：针对已经是 `approved` 或 `rejected` 的版本尝试生成预览，返回 409 `VERSION_CONFLICT`。

### 7.6 嵌套模板校验与拓扑负例 (Topology & Template Negatives)
1. **引用未注册模块**：步骤包含 `unregistered@1`，返回 422。
2. **引用未批准草稿模块**：子模块已存在但处于 `draft` 状态，返回 422。
3. **引用跨项目模块**：尝试跨项目引用同名模块，返回 422。
4. **子模块正文 SHA 不符**：引用的子模块记录被篡改，`sha256` 与正文计算不符，返回 422。
5. **合法 8 层嵌套展开**：调用栈深度从 0 计，允许串联调用 8 次（深度 1～8），第 8 层子模块被成功引用并保存。
6. **超限第 9 层嵌套拒绝**：在已有 8 层调用栈时尝试发起第 9 次嵌套引用，静态分析拦截并返回 422 `MODULE_DEPTH`。
7. **循环引用拦截**：A $\to$ B $\to$ A 循环依赖在注册时被拓扑分析拦截，返回 422 `MODULE_CYCLE`。
8. **同级 Sibling 重复引用放行**：A 模块在步骤 1 和步骤 3 分别调用 C@1，放行通过。
9. **静态展开步数 100 上限拦截**：设计静态依赖展开达 101 步的模块模板，在注册期被拦截，返回 422 `STATIC_STEP_LIMIT`。
10. **执行期 12/30 步预算重新校验**：静态合法的 50 步模块在用例提交执行（`POST /regression-runs`）时，因超出运行时 `budget.maxActionsPerCase`（默认 12，预算上限 30）限制被拒绝（422）。
11. **非法 fixtureRefs 拦截**：模块模板内若包含 `fixtureRefs: [...]`，直接返回 422。

### 7.7 URL 编码与版本边界测试 (URL & Version Boundary)
1. **斜杠路径编码正例**：创建模块 `auth/login`，通过 `auth%2Flogin` 路径正常访问历史版本，返回 200。
2. **未编码斜杠路由隔离**：未编码直接发起 `/regression-modules/auth/login/versions`，返回 404。
3. **版本号数值上界**：请求版本 `2147483647`（Postgres signed int 上限）被正常处理；请求版本 `2147483648`（溢出）直接返回 422 `VALIDATION_ERROR`。
4. **非法版本字符**：版本传入 `0`、`-1`、`1.5`、`v1` 均返回 422 `VALIDATION_ERROR`。

### 7.8 并发竞争与乐观锁测试 (Concurrency)
1. **并发初次创建**：并发两个线程尝试创建同名模块 `auth/flow`（均无 `expectedVersion`），一个成功 201（v1），另一个命中版本冲突返回 409。
2. **并发版本递增**：两个线程均以 `expectedVersion: 1` 提交 v2，一个成功 201（产生 v2），另一个检测到并发版本变化返回 409 `VERSION_CONFLICT`。

### 7.9 数据库不可变守卫验证 (Trigger Protection)
1. **直接 SQL 篡改阻断**：以数据库超权角色尝试通过 SQL 执行 `UPDATE regression_module_versions SET document = '...'`，验证 010 触发器抛出 `check_violation USING MESSAGE='regression module document and identity are immutable'`。
2. **创建审计元数据篡改阻断**：尝试通过 SQL 修改 `created_by` 或 `created_at`，验证触发器抛出 `check_violation USING MESSAGE='regression module creation metadata is immutable'`。
3. **直接 SQL 删除阻断**：尝试执行 `DELETE FROM regression_module_versions`，验证触发器抛出 `check_violation USING MESSAGE='regression module version is immutable'`。

---

## 8. 当前执行边界与交付声明

- **只读设计交付**：本文档为纯设计规划，已定稿写入 `docs/validation-results/T10-module-management-plan.md`；
- **零环境副作用**：未修改任何共享契约生成器（`build_contracts.py`）、未修改迁移脚本、未改动 API 源码；未运行真实浏览器或外部模型；
- **状态维持**：Ego 继续暂停，P0 保持不放行。等待 Root 评估方案并在统一契约工具中生成类型并派发具体实现任务。
