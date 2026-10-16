import type {
  User,
  Project,
  Environment,
  AuthProfile,
  Knowledge,
  ModelProfile,
  Run,
  Task,
  CaseRecord,
  Finding,
  Step,
  Artifact,
  Report,
  Member,
  TriagePreview,
  InputRequest,
} from '@localqa/contracts';
import type {
  SavedCase,
  SavedCaseVersion,
  Schedule,
  ApiKey,
  RegressionDocument,
  RegressionModuleRecord,
} from '../api/types.ts';

/**
 * [MOCK 数据 / MOCK DATA]
 * 用于前端独立开发与自测验证的受控样本数据。
 * 所有数据均打上明确的 mock 标识。
 */
export const IS_MOCK_ENV = true;
export const MOCK_BADGE_TEXT = '【Mock 数据演示】';

export const mockCurrentUser: User = {
  id: 'usr_mock_admin_001',
  email: 'admin@localqa.fixture',
  displayName: '系统管理员 (Mock)',
  globalRole: 'admin',
  disabled: false,
  version: 1,
};

export const MOCK_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
export const LEGACY_MOCK_PROJECT_ID = 'proj_mock_ecommerce_01';

export const mockProject: Project = {
  id: MOCK_PROJECT_ID,
  name: '核心电商业务系统 (Mock)',
  status: 'active',
  defaultModelProfileId: 'model_mock_gpt4o',
  createdAt: '2026-10-01T08:00:00.000Z',
  version: 1,
};

export const mockMembers: Member[] = [
  {
    userId: 'usr_mock_admin_001',
    role: 'owner',
  },
  {
    userId: 'usr_mock_operator_002',
    role: 'operator',
  },
  {
    userId: 'usr_mock_viewer_003',
    role: 'viewer',
  },
];

export const mockEnvironments: Environment[] = [
  {
    id: 'env_mock_staging_01',
    projectId: 'proj_mock_ecommerce_01',
    name: 'Staging 受控靶场环境',
    baseUrl: 'http://localhost:8080',
    allowedOrigins: ['http://localhost:8080', 'http://127.0.0.1:8080'],
    excludedPaths: ['/api/records/delete', '/api/messages/send'],
    tlsPolicy: 'strict',
    defaultAuthProfileId: 'auth_mock_admin_01',
    version: 1,
  },
];

export const mockAuthProfiles: AuthProfile[] = [
  {
    id: 'auth_mock_admin_01',
    projectId: 'proj_mock_ecommerce_01',
    environmentId: 'env_mock_staging_01',
    name: 'Admin 管理员凭据',
    mode: 'storage_state',
    allowedOrigins: ['http://localhost:8080'],
    sharingPolicy: 'exclusive_run',
    hasSecret: true,
    status: 'active',
    formConfig: null,
    version: 1,
  },
  {
    id: 'auth_mock_viewer_02',
    projectId: 'proj_mock_ecommerce_01',
    environmentId: 'env_mock_staging_01',
    name: 'Viewer 只读凭据',
    mode: 'form',
    allowedOrigins: ['http://localhost:8080'],
    sharingPolicy: 'shared_state',
    hasSecret: true,
    status: 'active',
    formConfig: {
      loginUrl: 'http://localhost:8080/fix-03-auth.html',
      usernameTarget: { by: 'css', value: 'input[name="username"]' },
      passwordTarget: { by: 'css', value: 'input[name="password"]' },
      submitTarget: { by: 'css', value: 'button[type="submit"]' },
      successCriterion: {
        id: 'crit_auth_success',
        kind: 'element_visible',
        description: '成功标识呈现',
        sourceKind: 'generic_smoke',
        sourceRef: 'auth_config',
        locator: { by: 'test_id', value: 'auth-success-badge' },
      },
    },
    version: 1,
  },
];

export const mockModelProfiles: ModelProfile[] = [
  {
    id: 'model_mock_gpt4o',
    name: 'GPT-4o (云端生产模型)',
    endpoint: 'https://api.openai.com/v1',
    configuredModelId: 'gpt-4o-2024-08-06',
    adapter: 'openai_compatible',
    dataBoundary: 'external',
    capabilities: {
      structuredOutput: true,
      nativeTools: true,
      imageInput: true,
    },
    status: 'ready',
    version: 1,
  },
  {
    id: 'model_mock_qwen_local',
    name: 'Qwen-2.5-72B (内网离线集群)',
    endpoint: 'http://ai-cluster.internal/v1',
    configuredModelId: 'qwen-2.5-72b-instruct',
    adapter: 'openai_compatible',
    dataBoundary: 'internal',
    capabilities: {
      structuredOutput: true,
      nativeTools: true,
      imageInput: false,
    },
    status: 'ready',
    version: 1,
  },
];

export const mockKnowledge: Knowledge[] = [
  {
    id: 'kno_mock_br_101',
    projectId: 'proj_mock_ecommerce_01',
    kind: 'rule',
    title: 'BR-101: 订单满减优惠结算规则',
    text: '实收金额必须严格等于：单价 * 数量 - 折扣。若计算结果为负数，实收金额最低下限为 0.00 元。若页面呈现实收金额高于应付或未扣除折扣，严格判定为 issue_found。',
    approved: true,
    version: 1,
  },
  {
    id: 'kno_mock_forbid_delete',
    projectId: 'proj_mock_ecommerce_01',
    kind: 'restriction',
    title: '禁止生产删除动作',
    text: '在非测试专用沙箱页面中，严禁点击具有 delete/remove/destroy 语义的危险红色操作按钮。',
    approved: true,
    version: 1,
  },
];

export const defaultRunConfig = {
  allowedOrigins: ['http://localhost:8080'] as [string, ...string[]],
  actionPolicy: 'non_submitting' as const,
  budget: {
    maxCases: 8,
    maxPages: 6,
    maxDepth: 2,
    maxActiveSeconds: 600,
    maxActionsPerCase: 30,
    maxActions: 120,
    maxModelCalls: 100,
    maxReproductions: 3,
    concurrency: 1,
    maxTotalTokens: 300000,
  },
  environmentVersion: 1,
  authProfileVersion: 1,
  knowledgeVersionIds: ['kno_mock_br_101'],
  models: {
    coordinator: { profileId: 'model_mock_gpt4o', version: 1 },
    explorer: { profileId: 'model_mock_gpt4o', version: 1 },
    executor: { profileId: 'model_mock_gpt4o', version: 1 },
    assertion: { profileId: 'model_mock_gpt4o', version: 1 },
    reproducer: { profileId: 'model_mock_gpt4o', version: 1 },
  },
};

export const mockRuns: Run[] = [
  {
    id: 'run_mock_001_completed',
    projectId: 'proj_mock_ecommerce_01',
    creatorId: 'usr_mock_admin_001',
    targetUrl: 'http://localhost:8080/',
    executionMode: 'smoke',
    status: 'completed',
    phase: 'finalize',
    completion: 'complete',
    terminationReason: 'normal',
    contextVersion: 1,
    effectiveConfig: defaultRunConfig,
    budgetUsed: {
      activeSeconds: 145,
      actions: 28,
      modelCalls: 12,
      totalTokens: 48500,
      reproductions: 1,
    },
    createdAt: '2026-10-02T07:59:50.000Z',
    updatedAt: '2026-10-02T08:02:25.000Z',
    version: 12,
  },
  {
    id: 'run_mock_002_partial',
    projectId: 'proj_mock_ecommerce_01',
    creatorId: 'usr_mock_admin_001',
    targetUrl: 'http://localhost:8080/fix-14-large.html',
    executionMode: 'smoke',
    status: 'completed',
    phase: 'finalize',
    completion: 'partial',
    terminationReason: 'budget_limit',
    contextVersion: 1,
    effectiveConfig: defaultRunConfig,
    budgetUsed: {
      activeSeconds: 602,
      actions: 120,
      modelCalls: 100,
      totalTokens: 300000,
      reproductions: 2,
    },
    createdAt: '2026-10-02T08:09:50.000Z',
    updatedAt: '2026-10-02T08:20:02.000Z',
    version: 88,
  },
  {
    id: 'run_mock_003_awaiting',
    projectId: 'proj_mock_ecommerce_01',
    creatorId: 'usr_mock_operator_002',
    targetUrl: 'http://localhost:8080/fix-03-auth.html',
    executionMode: 'smoke',
    status: 'awaiting_input',
    phase: 'auth',
    completion: 'none',
    terminationReason: null,
    contextVersion: 1,
    effectiveConfig: defaultRunConfig,
    budgetUsed: {
      activeSeconds: 24,
      actions: 3,
      modelCalls: 2,
      totalTokens: 5200,
      reproductions: 0,
    },
    createdAt: '2026-10-02T08:29:50.000Z',
    updatedAt: '2026-10-02T08:30:14.000Z',
    version: 6,
  },
  {
    id: 'run_mock_004_regression',
    projectId: 'proj_mock_ecommerce_01',
    creatorId: 'usr_mock_admin_001',
    targetUrl: 'http://localhost:8080/regression.html',
    executionMode: 'regression',
    status: 'completed',
    phase: 'finalize',
    completion: 'complete',
    terminationReason: 'normal',
    contextVersion: 1,
    effectiveConfig: defaultRunConfig,
    budgetUsed: {
      activeSeconds: 42,
      actions: 8,
      modelCalls: 4,
      totalTokens: 12500,
      reproductions: 0,
    },
    createdAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:01:00.000Z',
    version: 18,
  },
  {
    id: 'run_mock_005_queued',
    projectId: 'proj_mock_ecommerce_01',
    creatorId: 'usr_mock_admin_001',
    targetUrl: 'http://localhost:8080/queued.html',
    executionMode: 'regression',
    status: 'queued',
    phase: 'preflight',
    completion: 'none',
    terminationReason: null,
    contextVersion: 1,
    effectiveConfig: defaultRunConfig,
    budgetUsed: {
      activeSeconds: 0,
      actions: 0,
      modelCalls: 0,
      totalTokens: 0,
      reproductions: 0,
    },
    createdAt: '2026-10-04T10:05:00.000Z',
    updatedAt: '2026-10-04T10:05:00.000Z',
    version: 1,
  },
  {
    id: 'run_mock_006_clarification',
    projectId: 'proj_mock_ecommerce_01',
    creatorId: 'usr_mock_admin_001',
    targetUrl: 'http://localhost:8080/fix-10-rules.html',
    executionMode: 'smoke',
    status: 'awaiting_input',
    phase: 'plan',
    completion: 'none',
    terminationReason: null,
    contextVersion: 1,
    effectiveConfig: defaultRunConfig,
    budgetUsed: {
      activeSeconds: 18,
      actions: 2,
      modelCalls: 3,
      totalTokens: 4100,
      reproductions: 0,
    },
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    version: 2,
  },
];

export const mockInputRequest: InputRequest = {
  id: 'inp_mock_req_01',
  runId: 'run_mock_003_awaiting',
  kind: 'auth_profile',
  prompt:
    '页面触发二次风控短信验证码校验，请选择获准的测试认证凭据以继续自动化探索。',
  expiresAt: '2026-10-02T08:35:00.000Z',
  status: 'pending',
  version: 1,
};

/** Mo-style clarification: the coordinator asks and waits, up to 24 hours.
 * Relative expiry keeps the hint meaningful whenever the mock is opened. */
export const mockClarificationRequest: InputRequest = {
  id: 'inp_mock_req_02',
  runId: 'run_mock_006_clarification',
  kind: 'clarification',
  prompt:
    '结算页的优惠券抵扣规则有歧义：满 300 减 10 是否可与会员 95 折叠加？回复后我继续写用例。',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  status: 'pending',
  version: 1,
  options: ['可以叠加', '只能二选一', '以 BR-101 文档为准'],
};

export const mockRegressionDocument1: RegressionDocument = {
  schemaVersion: 1,
  kind: 'localqa/test',
  id: 'checkout-coupon-calc',
  name: '优惠券叠加与最终结算价验证',
  variables: { couponCode: 'SAVE20', expectedDiscount: 20 },
  criteria: [
    {
      id: 'crit-cart-01',
      kind: 'element_visible',
      description: '结算明细容器必须可见',
      sourceKind: 'user_spec',
      sourceRef: 'specs/checkout.md#summary',
      locator: { by: 'css', value: '[data-testid="checkout-summary"]' },
    },
    {
      id: 'crit-cart-02',
      kind: 'text_equals',
      description: '优惠券减免行必须准确呈现 -20.00 元',
      sourceKind: 'user_spec',
      sourceRef: 'specs/checkout.md#discount',
      locator: { by: 'css', value: '[data-testid="discount-amount"]' },
      expectedValue: '-¥20.00',
    },
  ],
  steps: [
    { kind: 'navigate', url: 'http://localhost:8080/checkout.html' },
    {
      kind: 'type_text',
      locator: { by: 'css', value: '#coupon-input' },
      text: 'SAVE20',
    },
    { kind: 'click', locator: { by: 'css', value: '#apply-coupon-btn' } },
    { kind: 'assert', criterionId: 'crit-cart-01' },
    { kind: 'assert', criterionId: 'crit-cart-02' },
  ],
  fixtureRefs: [],
};

export const mockCases: CaseRecord[] = [
  {
    definition: {
      id: 'case_mock_01',
      runId: 'run_mock_001_completed',
      projectId: 'proj_mock_ecommerce_01',
      version: 1,
      title: 'FIX-01: 首页语义结构、Tab 切换与折叠组件冒烟',
      summary:
        '验证页面主要导航存在，切换 Tab 页面局部更新，折叠展开正文，分页能够加载数据。',
      preconditions: ['靶场已就绪', '未登录公开访客权限'],
      outline: [
        '验证主导航与 main 区域',
        '切换 Tab 验证无整页刷新',
        '展开 details 折叠项',
        '验证分页标识',
      ],
      criteria: [
        {
          id: 'crit_fix_01_nav',
          kind: 'element_visible',
          description: '主导航包含合法链接且 main role 容器存在',
          sourceKind: 'generic_smoke',
          sourceRef: 'smoke_standard',
        },
        {
          id: 'crit_fix_01_tab',
          kind: 'element_visible',
          description: '点击 Tab 按钮内容更新无整页刷新',
          sourceKind: 'generic_smoke',
          sourceRef: 'smoke_standard',
        },
      ],
    },
    outcome: 'passed',
    verdict: {
      id: 'verdict_mock_01',
      caseId: 'case_mock_01',
      attemptId: 'att_mock_01',
      status: 'passed',
      reasonCode: 'ALL_CRITERIA_SATISFIED',
      summary:
        '主导航与 Tab 切换交互全部符合契约，分页加载唯一 LQA_ 种子数据。',
      criterionResults: [
        {
          criterionId: 'crit_fix_01_nav',
          result: 'passed',
          reason: 'main 容器与导航可见',
          evidenceRefs: [],
        },
        {
          criterionId: 'crit_fix_01_tab',
          result: 'passed',
          reason: 'tabpanel 局部渲染成功',
          evidenceRefs: [],
        },
      ],
      gaps: [],
      createdAt: '2026-10-02T08:00:30.000Z',
    },
  },
  {
    definition: {
      id: 'case_mock_02',
      runId: 'run_mock_001_completed',
      projectId: 'proj_mock_ecommerce_01',
      version: 1,
      title: 'FIX-02: 延迟渲染与长连接并发等待测试',
      summary:
        '页面存在活跃 SSE 数据流，通过状态等待而非 networkidle 判定加载就绪。',
      preconditions: ['SSE 数据连接处于开放态'],
      outline: [
        '打开延迟加载页',
        '捕获 loading spinner',
        '等待 delayed content 就绪',
      ],
      criteria: [
        {
          id: 'crit_fix_02_spinner',
          kind: 'element_visible',
          description: 'Spinner 消失后延迟内容可见',
          sourceKind: 'generic_smoke',
          sourceRef: 'smoke_standard',
        },
      ],
    },
    outcome: 'passed',
    verdict: {
      id: 'verdict_mock_02',
      caseId: 'case_mock_02',
      attemptId: 'att_mock_02',
      status: 'passed',
      reasonCode: 'ALL_CRITERIA_SATISFIED',
      summary: 'DOM 状态等待在 1.4s 内成功捕获内容，未挂死在 SSE 流上。',
      criterionResults: [
        {
          criterionId: 'crit_fix_02_spinner',
          result: 'passed',
          reason: '延迟内容呈现且 spinner 销毁',
          evidenceRefs: [],
        },
      ],
      gaps: [],
      createdAt: '2026-10-02T08:00:50.000Z',
    },
  },
  {
    definition: {
      id: 'case_mock_05',
      runId: 'run_mock_001_completed',
      projectId: 'proj_mock_ecommerce_01',
      version: 1,
      title: 'FIX-05: 重复文案与隐藏元素防盲点机制',
      summary:
        '9 处相同 Inspect 按钮拒绝非确定性点击；隐藏 Ghost 按钮拒绝点击。',
      preconditions: ['页面包含 9 个同名元素与 2 个隐藏元素'],
      outline: ['查询重复文案元素', '验证歧义拒绝', '基于 test-id 唯一定位'],
      criteria: [
        {
          id: 'crit_fix_05_ambiguity',
          kind: 'semantic',
          description: '多候选目标返回 TARGET_AMBIGUOUS 拒绝盲点',
          sourceKind: 'generic_smoke',
          sourceRef: 'smoke_standard',
        },
      ],
    },
    outcome: 'passed',
    verdict: {
      id: 'verdict_mock_05',
      caseId: 'case_mock_05',
      attemptId: 'att_mock_05',
      status: 'passed',
      reasonCode: 'ALL_CRITERIA_SATISFIED',
      summary:
        '解析器准确拒止歧义候选（matchCount: 9），基于 testid 精确命中目标。',
      criterionResults: [
        {
          criterionId: 'crit_fix_05_ambiguity',
          result: 'passed',
          reason: '歧义解析器动作准确拦截',
          evidenceRefs: [],
        },
      ],
      gaps: [],
      createdAt: '2026-10-02T08:01:10.000Z',
    },
  },
  {
    definition: {
      id: 'case_mock_10',
      runId: 'run_mock_001_completed',
      projectId: 'proj_mock_ecommerce_01',
      version: 1,
      title: 'FIX-10: 订单金额优惠计算与业务规则 BR-101 校验',
      summary: '输入单价 100，数量 3，优惠 10 元，预期应收 290.00 元。',
      preconditions: ['BR-101 业务知识规则已加载'],
      outline: [
        '输入购买数量 3',
        '选择优惠券 10 元',
        '点击计算按钮',
        '断言应收总额',
      ],
      criteria: [
        {
          id: 'crit_fix_10_calculation',
          kind: 'text_equals',
          description: '实收金额必须严格等于 290.00 元',
          sourceKind: 'project_knowledge',
          sourceRef: 'kno_mock_br_101',
        },
      ],
    },
    outcome: 'issue_found',
    verdict: {
      id: 'verdict_mock_10',
      caseId: 'case_mock_10',
      attemptId: 'att_mock_10',
      status: 'issue_found',
      reasonCode: 'CRITERION_FAILED',
      summary:
        '页面实际计算呈现 999.00 元，与显式规则 BR-101 (290.00 元) 严重背离。',
      criterionResults: [
        {
          criterionId: 'crit_fix_10_calculation',
          result: 'failed',
          reason: '期望 290.00 元，实际为 999.00 元',
          evidenceRefs: [],
        },
      ],
      gaps: [],
      createdAt: '2026-10-02T08:01:30.000Z',
    },
  },
  {
    definition: {
      id: 'case_mock_04_regression',
      runId: 'run_mock_004_regression',
      projectId: 'proj_mock_ecommerce_01',
      version: 1,
      title: 'REG-01: 核心电商结账与优惠券抵扣回放 (来源信息完整)',
      summary: '从用例库基线版本 v1 派生回放，校验优惠券计算与订单结算。',
      preconditions: ['靶场已就绪', '已登录测试账号'],
      outline: ['进入购物车', '应用优惠券', '结算提交'],
      criteria: [
        {
          id: 'crit_reg_01_coupon',
          kind: 'element_visible',
          description: '优惠券折抵金额与总价计算一致',
          sourceKind: 'saved_case',
          sourceRef: 'scv_mock_v1',
        },
      ],
      regression: {
        sourceVersionId: 'a0000000-0000-0000-0000-000000000001',
        sourceDocumentSha256:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        snapshotDocumentSha256:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        document: mockRegressionDocument1,
        moduleSnapshots: [
          {
            projectId: 'b0000000-0000-0000-0000-000000000001',
            name: 'auth_helper',
            version: 1,
            sha256:
              'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
            document: mockRegressionDocument1,
            reviewStatus: 'approved',
          },
        ],
      },
    },
    outcome: 'passed',
    verdict: {
      id: 'verdict_mock_04',
      caseId: 'case_mock_04_regression',
      attemptId: 'att_mock_04',
      status: 'passed',
      reasonCode: 'REGRESSION_CRITERIA_SATISFIED',
      summary: '自动化回归基线执行通过，所有回放步骤与准则一致。',
      criterionResults: [
        {
          criterionId: 'crit_reg_01_coupon',
          result: 'passed',
          reason: '优惠券折抵有效且总计吻合',
          evidenceRefs: [],
        },
      ],
      gaps: [],
      createdAt: '2026-10-04T10:00:50.000Z',
    },
  },
  {
    definition: {
      id: 'case_mock_05_queued_not_run',
      runId: 'run_mock_005_queued',
      projectId: 'proj_mock_ecommerce_01',
      version: 1,
      title: 'REG-02: 排队中待执行回归用例 (未执行 / not_run)',
      summary: '处于排队队列中的回归用例，尚未由 Worker 执行回放。',
      preconditions: ['靶场已就绪'],
      outline: ['等待回放步骤'],
      criteria: [
        {
          id: 'crit_reg_02_pending',
          kind: 'element_visible',
          description: '等待判定',
          sourceKind: 'saved_case',
          sourceRef: 'scv_mock_v1',
        },
      ],
      regression: {
        sourceVersionId: 'scv_mock_v1',
        sourceDocumentSha256:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        document: mockRegressionDocument1,
        moduleSnapshots: [],
      },
    },
    outcome: 'not_run',
    verdict: null,
  },
  {
    definition: {
      id: 'case_mock_06_unverified',
      runId: 'run_mock_004_regression',
      projectId: 'proj_mock_ecommerce_01',
      version: 1,
      title: 'REG-03: 来源缺失未验证回归用例 (缺失 regression 绑定)',
      summary: '演示在回归模式下，若用例未携带有效来源绑定时的「未验证」状态。',
      preconditions: [],
      outline: ['未验证测试'],
      criteria: [
        {
          id: 'crit_reg_03_unverified',
          kind: 'element_visible',
          description: '未验证准则',
          sourceKind: 'generic_smoke',
          sourceRef: '',
        },
      ],
    },
    outcome: 'inconclusive',
    verdict: {
      id: 'verdict_mock_06',
      caseId: 'case_mock_06_unverified',
      attemptId: 'att_mock_06',
      status: 'inconclusive',
      reasonCode: 'MISSING_SOURCE_PROVENANCE',
      summary: '因来源绑定缺失，无法确认基线，判定为不确定/无结论。',
      criterionResults: [
        {
          criterionId: 'crit_reg_03_unverified',
          result: 'unknown',
          reason: '缺少有效来源基线',
          evidenceRefs: [],
        },
      ],
      gaps: ['缺少来源版本绑定'],
      createdAt: '2026-10-04T10:00:55.000Z',
    },
  },
  {
    definition: {
      id: 'case_mock_20_retried',
      runId: 'run_mock_001_completed',
      projectId: 'proj_mock_ecommerce_01',
      version: 1,
      title: 'FIX-11: 结算流程（登录态）第二次执行后通过',
      summary: '首次执行因会话过期受阻，主 AI 重跑后完成验证。',
      preconditions: ['已登录测试账号'],
      outline: ['进入结算页', '提交订单', '断言支付跳转'],
      criteria: [
        {
          id: 'crit_fix_11_checkout',
          kind: 'element_visible',
          description: '提交后跳转到支付页',
          sourceKind: 'generic_smoke',
          sourceRef: 'smoke_standard',
        },
      ],
    },
    // The verdict is the latest attempt's; attempt 1 was blocked and the
    // re-run passed, so the case shows as passed.
    outcome: 'passed',
    verdict: {
      id: 'verdict_mock_20_2',
      caseId: 'case_mock_20_retried',
      attemptId: 'att_mock_20_2',
      status: 'passed',
      reasonCode: 'ALL_CRITERIA_SATISFIED',
      summary: '第二次执行登录态正常，结算提交后跳转支付页。',
      criterionResults: [
        {
          criterionId: 'crit_fix_11_checkout',
          result: 'passed',
          reason: '跳转支付页',
          evidenceRefs: [],
        },
      ],
      gaps: [],
      createdAt: '2026-10-02T08:03:40.000Z',
    },
  },
];

export const mockFindings: Finding[] = [
  {
    id: 'find_mock_01_calc_error',
    runId: 'run_mock_001_completed',
    caseIds: ['case_mock_10'],
    kind: 'functional',
    status: 'confirmed',
    title: '订单金额结算计算严重错误（应收 290 元实际显示 999 元）',
    severity: 'critical',
    expected: '依据业务规则 BR-101：实收金额 = 100 * 3 - 10 = 290.00 元。',
    actual:
      '页面计算结果展示为 999.00 元，优惠券扣减未能生效，结算金额异常放大。',
    expectedSource: 'project_knowledge',
    reproSteps: [
      '1. 导航访问受控靶场页面 /fix-10-rules.html',
      '2. 在商品购买数量栏输入 3，选择满 300 减 10 优惠券',
      '3. 点击 [计算结算金额] 按钮',
      '4. 检查实收总额显示区域',
    ],
    evidenceRefs: ['art_mock_screenshot_error'],
    reproductionRef: 'repro_mock_attempt_02',
    triageDisposition: 'open',
    version: 1,
  },
  {
    id: 'find_mock_02_dead_link',
    runId: 'run_mock_001_completed',
    caseIds: ['case_mock_01'],
    kind: 'static',
    status: 'suspected',
    title: '页脚帮助文档存在 404 断链',
    severity: 'medium',
    expected: '点击帮助中心链接应当返回 200 HTTP 响应并呈现文档正文。',
    actual: '点击后跳转 /fix-09/broken-404 返回 HTTP 404 Not Found。',
    expectedSource: 'generic_smoke',
    reproSteps: ['1. 导航至首页底部', '2. 点击 [帮助与开发者文档] 链接'],
    evidenceRefs: ['art_mock_screenshot_error'],
    reproductionRef: null,
    triageDisposition: 'open',
    version: 1,
  },
  {
    id: 'find_mock_03_calc_duplicate',
    runId: 'run_mock_001_completed',
    caseIds: ['case_mock_02'],
    kind: 'functional',
    status: 'confirmed',
    title: '结算页金额计算重复上报（应收 290 元实际 999 元）',
    severity: 'high',
    expected: '依据业务规则 BR-101：实收金额 = 100 * 3 - 10 = 290.00 元。',
    actual: '另一个用例再次发现同样的结算金额异常（999.00 元）。',
    expectedSource: 'project_knowledge',
    reproSteps: [
      '1. 打开结算页',
      '2. 数量 3 + 满 300 减 10 优惠券',
      '3. 观察实收总额',
    ],
    evidenceRefs: ['art_mock_screenshot_error'],
    reproductionRef: null,
    triageDisposition: 'duplicate',
    duplicateOf: 'find_mock_01_calc_error',
    version: 2,
  } as Finding & { duplicateOf?: string | null },
];

export const mockSteps: Step[] = [
  {
    id: 'step_mock_01',
    runId: 'run_mock_001_completed',
    taskId: 'task_mock_exec_01',
    caseId: 'case_mock_10',
    seq: 1,
    toolName: 'navigate',
    status: 'succeeded',
    summary: '导航至订单核算页面',
    targetDescription: 'http://localhost:8080/fix-10-rules.html',
    evidenceRefs: [],
    createdAt: '2026-10-02T08:01:32.000Z',
    finishedAt: '2026-10-02T08:01:33.000Z',
  },
  {
    id: 'step_mock_02',
    runId: 'run_mock_001_completed',
    taskId: 'task_mock_exec_01',
    caseId: 'case_mock_10',
    seq: 2,
    toolName: 'click',
    status: 'succeeded',
    summary: '点击计算订单总额按钮',
    targetDescription: 'button[data-testid="calculate-order-btn"]',
    evidenceRefs: [],
    createdAt: '2026-10-02T08:01:34.000Z',
    finishedAt: '2026-10-02T08:01:34.200Z',
  },
  {
    id: 'step_mock_03',
    runId: 'run_mock_001_completed',
    taskId: 'task_mock_exec_01',
    caseId: 'case_mock_10',
    seq: 3,
    toolName: 'assert_criterion',
    status: 'failed',
    summary: '断言实收金额符合 BR-101 规则',
    targetDescription: 'crit_fix_10_calculation',
    evidenceRefs: ['art_mock_screenshot_error'],
    createdAt: '2026-10-02T08:01:35.000Z',
    finishedAt: '2026-10-02T08:01:35.100Z',
  },
  {
    id: 'step_mock_04_01',
    runId: 'run_mock_004_regression',
    taskId: 'task_mock_coord_01',
    caseId: 'case_mock_04_regression',
    seq: 1,
    toolName: 'navigate',
    status: 'succeeded',
    summary: '导航至订单结账页面 (步骤出处信息完整)',
    targetDescription: 'http://localhost:8080/checkout.html',
    evidenceRefs: [],
    createdAt: '2026-10-04T10:00:10.000Z',
    finishedAt: '2026-10-04T10:00:12.000Z',
    regressionSource: {
      documentId: 'checkout-coupon-calc',
      stepIndex: 0,
      modulePath: [
        {
          ref: 'auth_helper@1',
          sha256:
            'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
          invocationStepIndex: 1,
        },
      ],
    },
  },
  {
    id: 'step_mock_04_02',
    runId: 'run_mock_004_regression',
    taskId: 'task_mock_coord_01',
    caseId: 'case_mock_04_regression',
    seq: 2,
    toolName: 'click',
    status: 'succeeded',
    summary: '点击应用优惠券按钮 (未携带 regressionSource)',
    targetDescription: 'button#apply-coupon-btn',
    evidenceRefs: [],
    createdAt: '2026-10-04T10:00:15.000Z',
    finishedAt: '2026-10-04T10:00:16.000Z',
  },
];

export const mockTasks: Task[] = [
  {
    id: 'task_mock_coord_01',
    runId: 'run_mock_001_completed',
    role: 'coordinator',
    status: 'succeeded',
    caseId: null,
    attempt: 1,
    summary: '阶段推进与全流程协调完成',
    elapsedSeconds: 145,
  },
  {
    id: 'task_mock_explore_01',
    runId: 'run_mock_001_completed',
    role: 'explorer',
    status: 'succeeded',
    caseId: null,
    attempt: 1,
    summary: '建立有限页面图谱（6 个页面，42 个交互控件）',
    elapsedSeconds: 40,
  },
  {
    id: 'task_mock_exec_01',
    runId: 'run_mock_001_completed',
    role: 'executor',
    status: 'succeeded',
    caseId: 'case_mock_10',
    attempt: 1,
    summary: '执行 4 条用例，判定 3 条通过、1 条发现缺陷',
    elapsedSeconds: 49,
  },
  {
    id: 'task_mock_repro_01',
    runId: 'run_mock_001_completed',
    role: 'reproducer',
    status: 'succeeded',
    caseId: 'case_mock_10',
    attempt: 1,
    summary: '独立全新上下文复现 case_10 成功，确认缺陷',
    elapsedSeconds: 24,
  },
  {
    id: 'task_mock_exec_20_1',
    runId: 'run_mock_001_completed',
    role: 'executor',
    status: 'failed',
    caseId: 'case_mock_20_retried',
    attempt: 1,
    summary: '执行 FIX-11 结算流程，会话过期导致受阻',
    elapsedSeconds: 31,
  },
  {
    id: 'task_mock_exec_20_2',
    runId: 'run_mock_001_completed',
    role: 'executor',
    status: 'succeeded',
    caseId: 'case_mock_20_retried',
    attempt: 2,
    summary: '重跑 FIX-11 结算流程，验证通过',
    elapsedSeconds: 27,
  },
  {
    id: 'task_mock_final_01',
    runId: 'run_mock_001_completed',
    role: 'finalizer',
    status: 'succeeded',
    caseId: null,
    attempt: 1,
    summary: '聚合事实数据并生成正式验收报告',
    elapsedSeconds: 9,
  },
];

export const mockArtifacts: Record<string, Artifact> = {
  art_mock_screenshot_error: {
    id: 'art_mock_screenshot_error',
    projectId: 'proj_mock_ecommerce_01',
    runId: 'run_mock_001_completed',
    kind: 'screenshot',
    status: 'available',
    bytes: 148200,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    contentUrl:
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="%23f8fafc"/><rect x="40" y="40" width="720" height="370" rx="8" fill="white" stroke="%23cbd5e1"/><text x="60" y="80" font-family="sans-serif" font-size="18" font-weight="bold" fill="%230f172a">FIX-10: 订单金额核算界面</text><text x="60" y="130" font-family="sans-serif" font-size="14" fill="%2364748b">商品: 高性能测试主机 (数量: 3, 单价: 100.00 元)</text><text x="60" y="160" font-family="sans-serif" font-size="14" fill="%2364748b">优惠券: 满 300 减 10 元</text><rect x="60" y="200" width="300" height="60" rx="6" fill="%23fef2f2" stroke="%23fecaca"/><text x="75" y="235" font-family="sans-serif" font-size="15" font-weight="bold" fill="%23ef4444">页面显示实收: 999.00 元 (异常)</text><text x="60" y="320" font-family="sans-serif" font-size="13" fill="%23059669">预期应收金额: 290.00 元 (按 BR-101 规则)</text></svg>',
    redaction: 'applied',
    error: null,
    createdAt: '2026-10-02T08:01:35.000Z',
    taskId: 'task_mock_exec_01',
    stepId: 'step_mock_03',
    caseId: 'case_mock_10',
    snapshotId: 'snap_mock_10_err',
  },
};

export const mockReport: Report = {
  schemaVersion: 1,
  example: false,
  generatedAt: '2026-10-02T08:02:25.000Z',
  run: mockRuns[0],
  summary: {
    planned: 5,
    passed: 4,
    issueFound: 1,
    blocked: 0,
    inconclusive: 0,
    notRun: 0,
    attempted: 5,
    evaluated: 5,
    passRate: 0.8,
    attemptRate: 1.0,
  },
  cases: mockCases,
  findings: mockFindings,
  reproductions: [
    {
      id: 'repro_mock_attempt_02',
      findingId: 'find_mock_01_calc_error',
      taskId: 'task_mock_repro_01',
      outcome: 'reproduced',
      freshContext: true,
      summary: '在独立干净无缓存会话中复现，计算值仍为 999.00 元',
      evidenceRefs: ['art_mock_screenshot_error'],
      createdAt: '2026-10-02T08:02:15.000Z',
    },
  ],
  artifacts: [mockArtifacts.art_mock_screenshot_error],
  modelUsage: [
    {
      profileId: 'model_mock_gpt4o',
      configuredModelId: 'gpt-4o-2024-08-06',
      reportedModelId: 'gpt-4o-2024-08-06',
      requests: 12,
      inputTokens: 32000,
      outputTokens: 16500,
      usageSource: 'reported',
    },
  ],
  coverageGaps: [],
  cleanupStatus: 'not_required',
  warnings: [],
};

export const mockTriagePreview: TriagePreview = {
  findingId: 'find_mock_01_calc_error',
  disposition: 'accepted',
  reason: '确认计算逻辑缺陷，交由后端结算组修复优惠券叠加判定',
  expectedVersion: 1,
  confirmationToken: 'tok_confirm_triage_abc123',
  expiresAt: new Date(Date.now() + 300000).toISOString(),
};

export const MOCK_SAVED_CASE_1_ID = '00000000-0000-4000-8000-000000000001';
export const MOCK_SAVED_CASE_1_VERSION_ID =
  '00000000-0000-4000-8000-000000000011';
export const MOCK_SAVED_CASE_2_ID = '00000000-0000-4000-8000-000000000002';
export const MOCK_SAVED_CASE_2_VERSION_ID =
  '00000000-0000-4000-8000-000000000012';
export const MOCK_SAVED_CASE_3_ARCHIVED_ID =
  '00000000-0000-4000-8000-000000000003';
export const MOCK_SAVED_CASE_3_VERSION_ID =
  '00000000-0000-4000-8000-000000000013';

const case1Versions: SavedCaseVersion[] = [
  {
    id: MOCK_SAVED_CASE_1_VERSION_ID,
    caseId: MOCK_SAVED_CASE_1_ID,
    version: 1,
    document: mockRegressionDocument1,
    sha256: '4a5e1e7f3b8c9d0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182',
    reviewStatus: 'approved',
    createdBy: '00000000-0000-4000-a000-000000000001',
    createdAt: '2026-10-02T10:00:00.000Z',
    reviewedBy: '00000000-0000-4000-a000-000000000001',
    reviewedAt: '2026-10-02T10:15:00.000Z',
  },
];

const case2Versions: SavedCaseVersion[] = [
  {
    id: MOCK_SAVED_CASE_2_VERSION_ID,
    caseId: MOCK_SAVED_CASE_2_ID,
    version: 1,
    document: {
      schemaVersion: 1,
      kind: 'localqa/test',
      id: 'user-profile-save',
      name: '用户资料修改与保存流程',
      variables: {},
      criteria: [
        {
          id: 'crit-prof-01',
          kind: 'text_equals',
          description: '资料更新后提示成功 Toast',
          sourceKind: 'user_spec',
          sourceRef: 'specs/profile.md#toast',
          locator: { by: 'css', value: '.toast-success' },
          expectedValue: '修改已保存',
        },
      ],
      steps: [
        { kind: 'navigate', url: 'http://localhost:8080/profile.html' },
        { kind: 'click', locator: { by: 'css', value: '#save-btn' } },
        { kind: 'assert', criterionId: 'crit-prof-01' },
      ],
      fixtureRefs: [],
    },
    sha256: '9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
    reviewStatus: 'draft',
    createdBy: '00000000-0000-4000-a000-000000000001',
    createdAt: '2026-10-03T14:20:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
  },
];

const case3Versions: SavedCaseVersion[] = [
  {
    id: MOCK_SAVED_CASE_3_VERSION_ID,
    caseId: MOCK_SAVED_CASE_3_ARCHIVED_ID,
    version: 1,
    document: mockRegressionDocument1,
    sha256: '4a5e1e7f3b8c9d0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182',
    reviewStatus: 'approved',
    createdBy: '00000000-0000-4000-a000-000000000001',
    createdAt: '2026-10-01T09:00:00.000Z',
    reviewedBy: '00000000-0000-4000-a000-000000000001',
    reviewedAt: '2026-10-01T09:30:00.000Z',
  },
];

export const mockSavedCaseVersions: Record<string, SavedCaseVersion[]> = {
  [MOCK_SAVED_CASE_1_ID]: case1Versions,
  case_mock_001: case1Versions,
  [MOCK_SAVED_CASE_2_ID]: case2Versions,
  case_mock_002: case2Versions,
  [MOCK_SAVED_CASE_3_ARCHIVED_ID]: case3Versions,
};

export const mockSavedCases: SavedCase[] = [
  {
    id: MOCK_SAVED_CASE_1_ID,
    projectId: MOCK_PROJECT_ID,
    slug: 'checkout-coupon-calc',
    name: '优惠券叠加与最终结算价验证',
    status: 'active',
    currentApprovedVersionId: MOCK_SAVED_CASE_1_VERSION_ID,
    version: 1,
    createdAt: '2026-10-02T10:00:00.000Z',
  },
  {
    id: MOCK_SAVED_CASE_2_ID,
    projectId: MOCK_PROJECT_ID,
    slug: 'user-profile-save',
    name: '用户资料修改与保存流程 (Draft 草稿待审)',
    status: 'active',
    currentApprovedVersionId: null,
    version: 1,
    createdAt: '2026-10-03T14:20:00.000Z',
  },
  {
    id: MOCK_SAVED_CASE_3_ARCHIVED_ID,
    projectId: MOCK_PROJECT_ID,
    slug: 'legacy-cart-checkout',
    name: '历史购物车结算流程 (已归档)',
    status: 'archived',
    currentApprovedVersionId: MOCK_SAVED_CASE_3_VERSION_ID,
    version: 2,
    createdAt: '2026-10-01T09:00:00.000Z',
  },
];

export const mockSchedules: Schedule[] = [
  {
    id: 'sched_mock_001',
    projectId: MOCK_PROJECT_ID,
    name: '每日核心流自动化回归巡检',
    cron: '0 2 * * *',
    timezone: 'Asia/Shanghai',
    templateKind: 'regression',
    runTemplate: {
      projectId: MOCK_PROJECT_ID,
      targetUrl: 'http://localhost:8080/checkout',
      mode: 'smoke',
    },
    overlapPolicy: 'skip',
    missedPolicy: 'skip',
    enabled: true,
    version: 1,
    createdAt: '2026-10-01T12:00:00.000Z',
  },
];

export const mockApiKeys: ApiKey[] = [
  {
    id: 'key_mock_001',
    projectId: MOCK_PROJECT_ID,
    name: 'CI/CD Pipeline Key',
    scope: ['runs:create', 'runs:read'],
    createdBy: 'usr_mock_admin_001',
    createdAt: '2026-10-01T12:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
  },
];

export const mockRegressionDocumentAuthHelperV1: RegressionDocument = {
  schemaVersion: 1,
  kind: 'localqa/test',
  id: 'auth_helper',
  name: '基础登录与鉴权模块 (v1)',
  variables: {},
  criteria: [
    {
      id: 'crit-auth-01',
      kind: 'element_visible',
      description: '登录输入表单存在且可见',
      sourceKind: 'saved_case',
      sourceRef: 'auth_helper',
      locator: { by: 'css', value: '#login-form' },
    },
  ],
  steps: [
    { kind: 'navigate', url: 'http://localhost:8080/login.html' },
    { kind: 'assert', criterionId: 'crit-auth-01' },
  ],
  fixtureRefs: [],
};

export const mockRegressionDocumentAuthHelperV2: RegressionDocument = {
  schemaVersion: 1,
  kind: 'localqa/test',
  id: 'auth_helper',
  name: '基础登录与鉴权模块 (v2 带双因子)',
  variables: {},
  criteria: [
    {
      id: 'crit-auth-01',
      kind: 'element_visible',
      description: '登录输入表单存在且可见',
      sourceKind: 'saved_case',
      sourceRef: 'auth_helper',
      locator: { by: 'css', value: '#login-form' },
    },
    {
      id: 'crit-auth-02',
      kind: 'element_visible',
      description: '双因子验证码输入框可见',
      sourceKind: 'saved_case',
      sourceRef: 'auth_helper',
      locator: { by: 'css', value: '#mfa-input' },
    },
  ],
  steps: [
    { kind: 'navigate', url: 'http://localhost:8080/login.html' },
    { kind: 'assert', criterionId: 'crit-auth-01' },
    { kind: 'assert', criterionId: 'crit-auth-02' },
  ],
  fixtureRefs: [],
};

export const MOCK_ADMIN_USER_UUID = '00000000-0000-4000-a000-000000000001';
export const MOCK_OPERATOR_USER_UUID = '00000000-0000-4000-a000-000000000002';
export const MOCK_VIEWER_USER_UUID = '00000000-0000-4000-a000-000000000003';

export const mockRegressionModules: RegressionModuleRecord[] = [
  {
    projectId: MOCK_PROJECT_ID,
    name: 'auth_helper',
    version: 1,
    sha256: '4b8a502f5a792129807e60d736a6de9b72cfe4a853c0605a1b15ce2559065b32',
    document: mockRegressionDocumentAuthHelperV1,
    reviewStatus: 'approved',
    createdBy: MOCK_ADMIN_USER_UUID,
    createdAt: '2026-10-01T08:00:00.000Z',
    reviewedBy: MOCK_ADMIN_USER_UUID,
    reviewedAt: '2026-10-01T08:30:00.000Z',
  },
  {
    projectId: MOCK_PROJECT_ID,
    name: 'auth_helper',
    version: 2,
    sha256: '6c81fc975b3486aed0ee9bb7d2d129b8e86afde022ba8a31d97a28fa153c47d7',
    document: mockRegressionDocumentAuthHelperV2,
    reviewStatus: 'draft',
    createdBy: MOCK_OPERATOR_USER_UUID,
    createdAt: '2026-10-03T10:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
  },
];
