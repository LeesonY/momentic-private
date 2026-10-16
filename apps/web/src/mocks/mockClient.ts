import type {
  ApiClient,
  PaginationQuery,
  ListRunsQuery,
  ListEventHistoryQuery,
  CreateRunInput,
} from '../api/types.ts';
import type {
  User,
  UserCreate,
  UserPatch,
  UserPage,
  Project,
  ProjectCreate,
  ProjectPatch,
  ProjectDeleteConfirm,
  ProjectPage,
  Environment,
  EnvironmentCreate,
  EnvironmentPatch,
  EnvironmentPage,
  AuthProfile,
  AuthProfileCreate,
  AuthProfilePatch,
  AuthProfilePage,
  ConfigDeleteConfirm,
  Knowledge,
  KnowledgeCreate,
  KnowledgePatch,
  KnowledgePage,
  ModelProfile,
  ModelProfileCreate,
  ModelProfilePatch,
  ModelDeleteConfirm,
  ModelProfilePage,
  ModelProbeResult,
  Run,
  RunDeleteConfirm,
  RunCreate,
  RunPage,
  RunMessagePage,
  TaskPage,
  CaseRecord,
  CaseRecordPage,
  CaseAttemptPage,
  Finding,
  FindingPage,
  Step,
  StepPage,
  RunEventPage,
  Artifact,
  Report,
  MemberUpdate,
  MemberPage,
  Member,
  TriageInput,
  TriagePreview,
  TriageCommit,
  InputRequest,
  InputRequestPage,
  FollowUpInput,
  InputResponse,
  Export,
  ExportInput,
  Health,
  LoginInput,
  LoginResult,
  MessageInput,
  SavedCaseYamlImport,
  SavedCaseYamlExport,
} from '@localqa/contracts';
import { parseContract, validateContract } from '@localqa/contracts';
import type {
  SavedCase,
  SavedCaseCreate,
  SavedCasePage,
  SavedCaseVersion,
  SavedCaseArchiveInput,
  SavedCaseRestoreInput,
  SavedCaseDuplicateInput,
  SavedCaseListQuery,
  SavedCaseVersionCreate,
  SavedCaseVersionPage,
  ReviewPreview,
  ReviewPreviewInput,
  ReviewCommit,
  RegressionRunCreate,
  RegressionDocument,
  Schedule,
  ScheduleCreate,
  SchedulePage,
  SchedulePatch,
  ScheduleOccurrencePage,
  ApiKey,
  ApiKeyCreate,
  ApiKeyCreated,
  ApiKeyPage,
  CacheStats,
  RepairProposal,
  RepairProposalCreate,
  RepairProposalReviewInput,
  RepairCandidateVerification,
  RepairCandidateVerificationPage,
  RepairCandidateEvidencePage,
  RepairProposalPage,
  RegressionModuleCreate,
  RegressionModuleRecord,
  RegressionModuleRecordPage,
  RegressionModuleReviewCommit,
  RegressionModuleReviewPreview,
  RegressionModuleReviewPreviewInput,
} from '../api/types.ts';
import {
  mockCurrentUser,
  mockProject,
  MOCK_PROJECT_ID,
  LEGACY_MOCK_PROJECT_ID,
  mockMembers,
  mockEnvironments,
  mockAuthProfiles,
  mockModelProfiles,
  mockKnowledge,
  mockRuns,
  mockCases,
  mockFindings,
  mockSteps,
  mockTasks,
  mockArtifacts,
  mockReport,
  mockTriagePreview,
  mockInputRequest,
  mockClarificationRequest,
  defaultRunConfig,
  mockSavedCases,
  mockSavedCaseVersions,
  mockSchedules,
  mockApiKeys,
  mockRegressionDocument1,
  mockRegressionModules,
} from './data.ts';

function generateMockUuid(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === '0' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const MOCK_USER_UUID_MAP: Record<string, string> = {
  usr_mock_admin_001: '00000000-0000-4000-a000-000000000001',
  usr_mock_operator_002: '00000000-0000-4000-a000-000000000002',
  usr_mock_viewer_003: '00000000-0000-4000-a000-000000000003',
};

function resolveMockUserUuid(userId?: string | null): string | null {
  if (!userId) return null;
  if (MOCK_USER_UUID_MAP[userId]) return MOCK_USER_UUID_MAP[userId];
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      userId,
    )
  ) {
    return userId;
  }
  return '00000000-0000-4000-a000-000000000001';
}

function encodeCursor(name: string, version: number): string {
  return btoa(encodeURIComponent(`${name}:${version}`));
}

function decodeCursor(
  cursor: string,
): { name: string; version: number } | null {
  try {
    const raw = decodeURIComponent(atob(cursor));
    const idx = raw.lastIndexOf(':');
    if (idx === -1) return null;
    const name = raw.slice(0, idx);
    const version = Number(raw.slice(idx + 1));
    if (isNaN(version) || version <= 0) return null;
    return { name, version };
  } catch {
    return null;
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSameId(a?: string | null, b?: string | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (UUID_REGEX.test(a) && UUID_REGEX.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

function encodeSavedCaseCursor(id: string): string {
  return btoa(encodeURIComponent(`saved_case:${id}`));
}

function decodeSavedCaseCursor(cursor: string): string | null {
  try {
    const raw = decodeURIComponent(atob(cursor));
    if (raw.startsWith('saved_case:')) {
      return raw.slice('saved_case:'.length);
    }
    return raw;
  } catch {
    return cursor;
  }
}

function matchesProjectId(candidate: string, queryId: string): boolean {
  if (!candidate || !queryId) return false;
  if (candidate === queryId) return true;
  if (UUID_REGEX.test(candidate) && UUID_REGEX.test(queryId)) {
    return candidate.toLowerCase() === queryId.toLowerCase();
  }
  const isCandidateMock =
    candidate === LEGACY_MOCK_PROJECT_ID ||
    (UUID_REGEX.test(candidate) &&
      candidate.toLowerCase() === MOCK_PROJECT_ID.toLowerCase());
  const isQueryMock =
    queryId === LEGACY_MOCK_PROJECT_ID ||
    (UUID_REGEX.test(queryId) &&
      queryId.toLowerCase() === MOCK_PROJECT_ID.toLowerCase());
  return isCandidateMock && isQueryMock;
}

function canonicalJson(item: unknown): unknown {
  if (Array.isArray(item)) return item.map(canonicalJson);
  if (item !== null && typeof item === 'object') {
    return Object.fromEntries(
      Object.entries(item)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return item;
}

async function computeCanonicalDocSha256(doc: unknown): Promise<string> {
  const serialized = JSON.stringify(canonicalJson(doc));
  if (
    typeof globalThis.crypto === 'undefined' ||
    !globalThis.crypto?.subtle ||
    typeof globalThis.crypto.subtle.digest !== 'function'
  ) {
    throw new Error(
      'WebCrypto API (crypto.subtle.digest) is required for canonical SHA-256 computation',
    );
  }
  const buf = new TextEncoder().encode(serialized);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export class MockApiClient implements ApiClient {
  private models = [...mockModelProfiles];
  private runs: Run[] = [...mockRuns];
  private projects: Project[] = [{ ...mockProject }];
  private projectMembers: Member[] = mockMembers.map((member) => ({
    ...member,
  }));
  private cases: CaseRecord[] = [...mockCases];
  private findings: Finding[] = [...mockFindings];
  private knowledge: Knowledge[] = [...mockKnowledge];
  private savedCases: SavedCase[] = mockSavedCases.map((c) => ({ ...c }));
  private savedCaseVersions: Record<string, SavedCaseVersion[]> =
    Object.fromEntries(
      Object.entries(mockSavedCaseVersions).map(([k, v]) => [
        k,
        v.map((ver) => ({
          ...ver,
          document: JSON.parse(JSON.stringify(ver.document)),
        })),
      ]),
    );
  private schedules: Schedule[] = [...mockSchedules];
  private apiKeys: ApiKey[] = [...mockApiKeys];
  private repairProposals: Record<string, RepairProposal[]> = {};
  private repairCandidates: Record<string, SavedCaseVersion> = {};
  private candidateVerifications: Record<
    string,
    RepairCandidateVerification[]
  > = {};
  private activeReviewPreviews: Record<string, ReviewPreview> = {};
  private environments: Environment[] = [...mockEnvironments];
  private authProfiles: AuthProfile[] = [...mockAuthProfiles];
  private regressionModules: RegressionModuleRecord[] =
    mockRegressionModules.map((m) => ({ ...m }));
  private activeModuleReviewPreviews: Record<
    string,
    RegressionModuleReviewPreview
  > = {};
  // Pending questions the coordinator is waiting on, keyed by run.
  private pendingInputs: InputRequest[] = [mockClarificationRequest];
  private inputResponseLog: {
    runId: string;
    inputId: string;
    decision: string;
    text?: string;
  }[] = [];

  public async login(_input: LoginInput): Promise<LoginResult> {
    return {
      user: mockCurrentUser,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
  }

  public async logout(): Promise<void> {
    // No-op for mock
  }

  public async currentUser(): Promise<User> {
    return mockCurrentUser;
  }

  public async listUsers(_query?: PaginationQuery): Promise<UserPage> {
    return { items: [mockCurrentUser], nextCursor: null };
  }

  public async createUser(input: UserCreate): Promise<User> {
    return {
      id: `usr_mock_${Date.now()}`,
      email: input.email,
      displayName: input.displayName,
      globalRole: input.globalRole || 'member',
      disabled: false,
      version: 1,
    };
  }

  public async updateUser(_userId: string, input: UserPatch): Promise<User> {
    return { ...mockCurrentUser, ...input };
  }

  public async listProjects(_query?: PaginationQuery): Promise<ProjectPage> {
    return { items: [...this.projects], nextCursor: null };
  }

  public async getProject(projectId: string): Promise<Project> {
    const p = this.projects.find((x) => matchesProjectId(x.id, projectId));
    if (!p) {
      const err = new Error('项目不存在 (404)') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return p;
  }

  public async createProject(input: ProjectCreate): Promise<Project> {
    const newProj: Project = {
      id: generateMockUuid(),
      name: input.name,
      status: 'active',
      defaultModelProfileId: 'model_mock_gpt4o',
      createdAt: new Date().toISOString(),
      version: 1,
    };
    this.projects.unshift(newProj);
    return newProj;
  }

  public async updateProject(
    projectId: string,
    input: ProjectPatch,
  ): Promise<Project> {
    const index = this.projects.findIndex((p) =>
      matchesProjectId(p.id, projectId),
    );
    if (index < 0) throw new Error('项目不存在');
    const project = this.projects[index]!;
    if (project.version !== input.expectedVersion)
      throw new Error('VERSION_CONFLICT');
    const { expectedVersion: _expectedVersion, ...patch } = input;
    const updated = { ...project, ...patch, version: project.version + 1 };
    this.projects[index] = updated;
    return updated;
  }

  public async deleteEmptyProject(
    projectId: string,
    input: ProjectDeleteConfirm,
  ): Promise<void> {
    const index = this.projects.findIndex((p) =>
      matchesProjectId(p.id, projectId),
    );
    if (index < 0) throw new Error('项目不存在');
    const project = this.projects[index]!;
    if (project.version !== input.expectedVersion)
      throw new Error('VERSION_CONFLICT');
    if (project.name !== input.confirmName) throw new Error('项目名称不匹配');
    this.projects.splice(index, 1);
  }

  public async listMembers(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<MemberPage> {
    return {
      items: this.projectMembers.map((member) => ({ ...member })),
      nextCursor: null,
    };
  }

  public async replaceMembers(
    projectId: string,
    input: MemberUpdate,
  ): Promise<Project> {
    const updated = await this.updateProject(projectId, {
      expectedVersion: input.expectedVersion,
    });
    this.projectMembers = input.members.map((member) => ({ ...member }));
    return updated;
  }

  public async listEnvironment(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<EnvironmentPage> {
    return { items: [...this.environments], nextCursor: null };
  }

  public async listEnvironments(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<EnvironmentPage> {
    return { items: [...this.environments], nextCursor: null };
  }

  public async createEnvironment(
    projectId: string,
    input: EnvironmentCreate,
  ): Promise<Environment> {
    const newEnv: Environment = {
      id: `env_mock_${Date.now()}`,
      projectId,
      name: input.name,
      baseUrl: input.baseUrl,
      allowedOrigins: input.allowedOrigins,
      excludedPaths: input.excludedPaths || [],
      tlsPolicy: input.tlsPolicy,
      defaultAuthProfileId: input.defaultAuthProfileId || null,
      version: 1,
    };
    this.environments.push(newEnv);
    return newEnv;
  }

  public async getEnvironment(environmentId: string): Promise<Environment> {
    const found = this.environments.find((e) => e.id === environmentId);
    if (!found) throw new Error('环境未找到');
    return found;
  }
  public async deleteEnvironment(
    environmentId: string,
    input: ConfigDeleteConfirm,
  ): Promise<void> {
    const current = await this.getEnvironment(environmentId);
    if (
      current.version !== input.expectedVersion ||
      current.name !== input.confirmName
    )
      throw new Error('配置版本或名称不匹配，请刷新后重试');
    if (this.authProfiles.some((a) => a.environmentId === environmentId))
      throw new Error('环境下仍有认证配置，请先删除这些认证配置');
    this.environments = this.environments.filter((e) => e.id !== environmentId);
  }
  public async deleteAuthProfile(
    authProfileId: string,
    input: ConfigDeleteConfirm,
  ): Promise<void> {
    const current = this.authProfiles.find((a) => a.id === authProfileId);
    if (!current) throw new Error('认证配置未找到');
    if (
      current.version !== input.expectedVersion ||
      current.name !== input.confirmName
    )
      throw new Error('配置版本或名称不匹配，请刷新后重试');
    this.authProfiles = this.authProfiles.filter((a) => a.id !== authProfileId);
    this.environments = this.environments.map((e) =>
      e.defaultAuthProfileId === authProfileId
        ? { ...e, defaultAuthProfileId: null, version: e.version + 1 }
        : e,
    );
  }

  public async updateEnvironment(
    environmentId: string,
    input: EnvironmentPatch,
  ): Promise<Environment> {
    const found = this.environments.find((e) => e.id === environmentId);
    if (!found) throw new Error('环境未找到');
    return { ...found, ...input };
  }

  public async listAuthProfile(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<AuthProfilePage> {
    return { items: [...this.authProfiles], nextCursor: null };
  }

  public async listAuthProfiles(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<AuthProfilePage> {
    return { items: [...this.authProfiles], nextCursor: null };
  }

  public async createAuthProfile(
    projectId: string,
    input: AuthProfileCreate,
  ): Promise<AuthProfile> {
    const newProf: AuthProfile = {
      id: `auth_mock_${Date.now()}`,
      projectId,
      environmentId: input.environmentId || null,
      name: input.name,
      mode: input.mode,
      allowedOrigins: input.allowedOrigins,
      sharingPolicy: input.sharingPolicy || 'exclusive_run',
      hasSecret: input.secretInput !== undefined,
      version: 1,
      status: 'active',
      formConfig: input.formConfig || null,
      ...(input.agentConfig ? { agentConfig: input.agentConfig } : {}),
      ...(input.storageCriterion ? { storageCriterion: input.storageCriterion } : {}),
    };
    this.authProfiles.push(newProf);
    return newProf;
  }

  public async updateAuthProfile(
    authProfileId: string,
    input: AuthProfilePatch,
  ): Promise<AuthProfile> {
    const found = this.authProfiles.find((a) => a.id === authProfileId);
    if (!found) throw new Error('认证凭据配置未找到');
    const { expectedVersion, secretInput, revoke, ...patch } = parseContract(
      'AuthProfilePatch',
      input,
    );
    if (found.version !== expectedVersion)
      throw Object.assign(new Error('VERSION_CONFLICT'), {
        code: 'VERSION_CONFLICT',
        status: 409,
      });
    if (secretInput !== undefined && found.status !== 'active')
      throw new Error('认证配置已撤销');
    // Only public configuration survives the request. Never spread secretInput
    // into a profile or keep a separate mock credential store.
    const updated: AuthProfile = {
      ...found,
      ...patch,
      version: found.version + 1,
      status: revoke ? 'revoked' : found.status,
      hasSecret: secretInput !== undefined || found.hasSecret,
    };
    this.authProfiles = this.authProfiles.map((profile) =>
      profile.id === authProfileId ? updated : profile,
    );
    return updated;
  }

  public async listKnowledge(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<KnowledgePage> {
    return { items: this.knowledge, nextCursor: null };
  }

  public async createKnowledge(
    projectId: string,
    input: KnowledgeCreate,
  ): Promise<Knowledge> {
    const newK: Knowledge = {
      id: `kn_mock_${Date.now()}`,
      projectId,
      title: input.title,
      text: input.text,
      kind: input.kind,
      approved: false,
      version: 1,
    };
    this.knowledge.push(newK);
    return newK;
  }

  public async updateKnowledge(
    knowledgeId: string,
    input: KnowledgePatch,
  ): Promise<Knowledge> {
    const found = this.knowledge.find((k) => k.id === knowledgeId);
    if (!found) throw new Error('知识条目未找到');
    return { ...found, ...input };
  }

  public async listModels(_query?: PaginationQuery): Promise<ModelProfilePage> {
    return { items: this.models, nextCursor: null };
  }

  public async listProjectModels(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<ModelProfilePage> {
    return { items: this.models, nextCursor: null };
  }

  public async grantProjectModel(
    _projectId: string,
    input: { modelProfileId: string },
  ): Promise<ModelProfile> {
    const model = this.models.find((m) => m.id === input.modelProfileId);
    if (!model) throw new Error('MODEL_NOT_CONFIGURED');
    return model;
  }

  public async createModel(input: ModelProfileCreate): Promise<ModelProfile> {
    return {
      id: `model_mock_${Date.now()}`,
      name: input.name,
      endpoint: input.endpoint,
      configuredModelId: input.configuredModelId,
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.maxOutputTokens }),
      ...(input.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: input.contextWindowTokens }),
      adapter: input.adapter || 'openai_compatible',
      dataBoundary: input.dataBoundary || 'internal',
      capabilities: {
        structuredOutput: true,
        nativeTools: true,
        imageInput: false,
      },
      version: 1,
      status: 'ready',
    };
  }

  public async getModel(modelProfileId: string): Promise<ModelProfile> {
    const found = this.models.find((m) => m.id === modelProfileId);
    if (!found) throw new Error('模型配置未找到');
    return found;
  }

  public async updateModel(
    modelProfileId: string,
    input: ModelProfilePatch,
  ): Promise<ModelProfile> {
    const found = this.models.find((m) => m.id === modelProfileId);
    if (!found) throw new Error('模型配置未找到');
    if (found.version !== input.expectedVersion)
      throw new Error('模型配置已更新，请刷新后重试');
    const { expectedVersion, apiKey, contextWindowTokens, ...patch } = input;
    const connectionChanged =
      apiKey !== undefined ||
      (patch.configuredModelId !== undefined &&
        patch.configuredModelId !== found.configuredModelId) ||
      (patch.endpoint !== undefined && patch.endpoint !== found.endpoint) ||
      (patch.responseFormat !== undefined &&
        patch.responseFormat !== (found.responseFormat ?? 'json_schema'));
    const updated: ModelProfile = {
      ...found,
      ...patch,
      ...(typeof contextWindowTokens === 'number'
        ? { contextWindowTokens }
        : {}),
      ...(connectionChanged
        ? {
            capabilities: {
              structuredOutput: false,
              nativeTools: false,
              imageInput: false,
            },
            status:
              patch.status ??
              (found.status === 'disabled' ? 'disabled' : 'untested'),
          }
        : {}),
      version: expectedVersion + 1,
    };
    if (contextWindowTokens === null) delete updated.contextWindowTokens;
    this.models = this.models.map((m) => (m.id === updated.id ? updated : m));
    return updated;
  }

  public async deleteModel(
    modelProfileId: string,
    input: ModelDeleteConfirm,
  ): Promise<void> {
    const current = await this.getModel(modelProfileId);
    if (current.version !== input.expectedVersion)
      throw new Error('模型配置已更新，请刷新后重试');
    if (current.name !== input.confirmName)
      throw new Error('输入的模型名称不匹配');
    this.models = this.models.filter((model) => model.id !== modelProfileId);
  }

  public async probeModel(modelProfileId: string): Promise<ModelProbeResult> {
    return {
      profileId: modelProfileId,
      capabilities: {
        structuredOutput: true,
        nativeTools: true,
        imageInput: false,
      },
      status: 'ready',
      notes: ['Mock capability probe OK (latency: 12ms)'],
    };
  }

  public async listRuns(
    _projectIdOrQuery: string | ListRunsQuery,
  ): Promise<RunPage> {
    return { items: this.runs, nextCursor: null };
  }

  public async getRun(runId: string): Promise<Run> {
    const found = this.runs.find((r) => r.id === runId);
    if (!found) throw new Error(`未找到运行记录: ${runId}`);
    return found;
  }

  public async createRun(input: CreateRunInput | RunCreate): Promise<Run> {
    const newRun: Run = {
      id: `run_mock_${Date.now()}`,
      projectId: input.projectId,
      creatorId: mockCurrentUser.id,
      targetUrl: input.targetUrl,
      status: 'running',
      phase: 'execute',
      completion: 'none',
      terminationReason: null,
      contextVersion: 1,
      effectiveConfig: defaultRunConfig,
      budgetUsed: {
        activeSeconds: 0,
        actions: 0,
        modelCalls: 0,
        reproductions: 0,
        totalTokens: 0,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    this.runs.unshift(newRun);
    return newRun;
  }

  public async cancelRun(runId: string): Promise<Run> {
    const idx = this.runs.findIndex((r) => r.id === runId);
    if (idx !== -1) {
      this.runs[idx] = {
        ...this.runs[idx],
        status: 'cancelled',
        terminationReason: 'user_cancel',
        updatedAt: new Date().toISOString(),
      };
      return this.runs[idx];
    }
    return { ...this.runs[0], status: 'cancelled' };
  }
  public async deleteRun(
    runId: string,
    input: RunDeleteConfirm,
  ): Promise<void> {
    const run = this.runs.find((item) => item.id === runId);
    if (!run) throw new Error('运行记录未找到');
    if (run.id !== input.confirmRunId || run.version !== input.expectedVersion)
      throw new Error('运行记录已更新，请刷新后重试');
    if (!['completed', 'cancelled', 'failed'].includes(run.status))
      throw new Error('运行尚未结束，请先停止运行后再删除');
    this.runs = this.runs.filter((item) => item.id !== runId);
  }

  public async sendRunMessage(
    runId: string,
    _messageOrInput: string | MessageInput,
    _expectedContextVersion?: number,
  ): Promise<Run> {
    const run = this.runs.find((r) => r.id === runId);
    return run || this.runs[0];
  }

  public async listRunMessages(
    _runId: string,
    _query?: PaginationQuery,
  ): Promise<RunMessagePage> {
    return { items: [], nextCursor: null };
  }

  public async listRunInputs(runId: string): Promise<InputRequestPage> {
    return {
      items: this.pendingInputs
        .filter((input) => input.runId === runId)
        .map((input) => ({ ...input })),
    };
  }
  public async continueRun(runId: string, input: FollowUpInput): Promise<Run> {
    const parent = this.runs.find((run) => run.id === runId);
    if (!parent) throw new Error('运行记录未找到');
    return this.createRun({
      projectId: parent.projectId,
      targetUrl: parent.targetUrl,
      description: input.text,
    });
  }
  public async respondToInput(
    runId: string,
    inputId: string,
    response: InputResponse,
  ): Promise<InputRequest> {
    const idx = this.pendingInputs.findIndex(
      (input) => input.id === inputId && input.runId === runId,
    );
    if (idx !== -1) {
      const input = this.pendingInputs[idx];
      if (response.expectedVersion !== input.version)
        throw new Error('提问已更新，请刷新后重试');
      this.pendingInputs.splice(idx, 1);
      this.inputResponseLog.push({
        runId,
        inputId,
        decision: response.decision,
        text: response.text,
      });
      return {
        ...input,
        status: response.decision === 'reject' ? 'rejected' : 'resolved',
        version: input.version + 1,
      };
    }
    return {
      ...mockInputRequest,
      status: response.decision === 'reject' ? 'rejected' : 'resolved',
      version: response.expectedVersion + 1,
    };
  }

  public streamEvents(_runId: string, _lastEventId?: string): EventSource {
    return new EventSource('about:blank');
  }

  public async listRunCases(
    runId: string,
    _query?: PaginationQuery,
  ): Promise<CaseRecordPage> {
    const matched = this.cases.filter((c) => c.definition.runId === runId);
    return {
      items: matched.length > 0 ? matched : this.cases,
      nextCursor: null,
    };
  }

  public async getCase(caseId: string): Promise<CaseRecord> {
    const found = this.cases.find((c) => c.definition.id === caseId);
    if (!found) throw new Error(`用例 ${caseId} 未找到`);
    return found;
  }

  public async listCaseAttempts(
    caseId: string,
    _query?: PaginationQuery,
  ): Promise<CaseAttemptPage> {
    // A retried case has one attempt per executor task; the verdict lives on
    // the latest one.
    if (caseId === 'case_mock_20_retried') {
      return {
        items: [
          {
            id: 'att_mock_20_1',
            caseId,
            taskId: 'task_mock_exec_20_1',
            attemptNumber: 1,
            status: 'completed',
            verdict: null,
            startedAt: '2026-10-02T08:02:55.000Z',
            finishedAt: '2026-10-02T08:03:26.000Z',
          },
          {
            id: 'att_mock_20_2',
            caseId,
            taskId: 'task_mock_exec_20_2',
            attemptNumber: 2,
            status: 'completed',
            verdict:
              this.cases.find((c) => c.definition.id === caseId)?.verdict ??
              null,
            startedAt: '2026-10-02T08:03:30.000Z',
            finishedAt: '2026-10-02T08:03:57.000Z',
          },
        ],
        nextCursor: null,
      };
    }
    return {
      items: [
        {
          id: `att_${caseId}_1`,
          caseId,
          taskId: 'task_mock_exec_01',
          attemptNumber: 1,
          status: 'completed',
          verdict:
            this.cases.find((c) => c.definition.id === caseId)?.verdict || null,
          startedAt: '2026-10-02T08:01:30.000Z',
          finishedAt: '2026-10-02T08:01:36.000Z',
        },
      ],
      nextCursor: null,
    };
  }

  public async listRunTasks(
    runId: string,
    _query?: PaginationQuery,
  ): Promise<TaskPage> {
    const matched = mockTasks.filter((task) => task.runId === runId);
    return {
      items: matched.length > 0 ? matched : mockTasks,
      nextCursor: null,
    };
  }

  public async listTaskSteps(
    taskIdOrCaseId: string,
    _query?: PaginationQuery,
  ): Promise<StepPage> {
    const matched = mockSteps.filter(
      (s) => s.caseId === taskIdOrCaseId || s.taskId === taskIdOrCaseId,
    );
    return {
      items: matched.length > 0 ? matched : mockSteps,
      nextCursor: null,
    };
  }

  public async getStep(stepId: string): Promise<Step> {
    const found = mockSteps.find((s) => s.id === stepId);
    if (!found) throw new Error(`步骤 ${stepId} 未找到`);
    return found;
  }

  public async listEventHistory(
    _runId: string,
    _query?: ListEventHistoryQuery,
  ): Promise<RunEventPage> {
    return { items: [], nextCursor: null };
  }

  public async listRunFindings(
    _runId: string,
    _query?: PaginationQuery,
  ): Promise<FindingPage> {
    return { items: this.findings, nextCursor: null };
  }

  public async getFinding(findingId: string): Promise<Finding> {
    const found = this.findings.find((f) => f.id === findingId);
    if (!found) throw new Error(`缺陷 ${findingId} 未找到`);
    return found;
  }

  public async previewTriage(
    _findingId: string,
    _dispositionOrInput:
      | TriageInput
      | 'accepted'
      | 'duplicate'
      | 'works_as_intended'
      | 'cannot_reproduce'
      | 'closed',
    _reason?: string,
    _expectedVersion?: number,
  ): Promise<TriagePreview> {
    return mockTriagePreview;
  }

  public async commitTriage(
    findingId: string,
    input: TriageCommit,
  ): Promise<Finding> {
    const nextStatus: Finding['status'] =
      input.disposition === 'accepted'
        ? 'confirmed'
        : input.disposition === 'duplicate'
          ? 'blocked'
          : 'unconfirmed';

    const idx = this.findings.findIndex((f) => f.id === findingId);
    if (idx !== -1) {
      this.findings[idx] = {
        ...this.findings[idx],
        status: nextStatus,
        version: this.findings[idx].version + 1,
      };
      return this.findings[idx];
    }
    return {
      ...this.findings[0],
      status: nextStatus,
    };
  }

  public async getReport(_runId: string): Promise<Report> {
    return mockReport;
  }

  public async createExport(
    _runId: string,
    formatOrInput: 'json' | 'markdown' | 'zip' | ExportInput,
  ): Promise<Export> {
    const format =
      typeof formatOrInput === 'string' ? formatOrInput : formatOrInput.format;
    return {
      id: `export_mock_${Date.now()}`,
      runId: 'run_mock_001_completed',
      format,
      artifactId: 'art_mock_export_zip',
      snapshotAt: new Date().toISOString(),
      status: 'ready',
      error: null,
    };
  }

  public async getExport(exportId: string): Promise<Export> {
    return {
      id: exportId,
      runId: 'run_mock_001_completed',
      format: 'json',
      artifactId: 'art_mock_export_zip',
      snapshotAt: new Date().toISOString(),
      status: 'ready',
      error: null,
    };
  }

  public async downloadArtifact(_artifactId: string): Promise<Blob> {
    return new Blob(['mock artifact content'], { type: 'text/plain' });
  }

  public async getArtifact(artifactId: string): Promise<Artifact> {
    const found = mockArtifacts[artifactId];
    if (!found) {
      return {
        id: artifactId,
        projectId: mockProject.id,
        runId: 'run_mock_001_completed',
        kind: 'screenshot',
        status: 'missing',
        bytes: null,
        sha256: null,
        contentUrl: null,
        redaction: 'not_needed',
        error: '证据材料已按过期策略清理或未成功采集',
        createdAt: new Date().toISOString(),
        taskId: null,
        stepId: null,
        caseId: null,
        snapshotId: null,
      };
    }
    return found;
  }

  public async healthLive(): Promise<Health> {
    return {
      status: 'ok',
      version: '1.0.0',
    };
  }

  public async healthReady(): Promise<Health> {
    return {
      status: 'ok',
      version: '1.0.0',
    };
  }

  // 53. listSavedCases
  public async listSavedCases(
    projectId: string,
    query?: SavedCaseListQuery,
  ): Promise<SavedCasePage> {
    const targetProject =
      this.projects.find((p) => matchesProjectId(p.id, projectId)) ||
      (matchesProjectId(MOCK_PROJECT_ID, projectId) ? this.projects[0] : null);
    if (!targetProject) {
      throw new Error(`项目不存在: ${projectId}`);
    }
    const statusFilter = query?.status || 'active';
    const allFiltered = this.savedCases.filter((c) => {
      if (!matchesProjectId(c.projectId, targetProject.id)) return false;
      if (statusFilter === 'all') return true;
      return c.status === statusFilter;
    });

    let startIndex = 0;
    if (query?.cursor) {
      const decodedId = decodeSavedCaseCursor(query.cursor);
      const foundIndex = allFiltered.findIndex(
        (c) => isSameId(c.id, decodedId || '') || c.id === query.cursor,
      );
      if (foundIndex !== -1) {
        startIndex = foundIndex + 1;
      } else {
        const num = Number(query.cursor);
        if (Number.isInteger(num) && num >= 0) {
          startIndex = num;
        }
      }
    }

    const limit =
      typeof query?.limit === 'number' && query.limit > 0
        ? Math.min(Math.max(query.limit, 1), 100)
        : allFiltered.length;

    const items = allFiltered.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < allFiltered.length;
    const nextCursor =
      hasMore && items.length > 0
        ? encodeSavedCaseCursor(items[items.length - 1].id)
        : null;

    return { items, nextCursor };
  }

  // 54. createSavedCase
  public async createSavedCase(
    projectId: string,
    input: SavedCaseCreate,
  ): Promise<SavedCase> {
    const targetProject =
      this.projects.find((p) => matchesProjectId(p.id, projectId)) ||
      (matchesProjectId(MOCK_PROJECT_ID, projectId) ? this.projects[0] : null);
    const effectiveProjectId = targetProject ? targetProject.id : projectId;
    const caseId = generateMockUuid();
    const versionId = generateMockUuid();
    const newCase: SavedCase = {
      id: caseId,
      projectId: effectiveProjectId,
      slug: input.slug,
      name: input.name,
      status: 'active',
      currentApprovedVersionId: null,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    const initialVersion: SavedCaseVersion = {
      id: versionId,
      caseId,
      version: 1,
      document: input.document || {
        schemaVersion: 1,
        kind: 'localqa/test',
        id: input.slug,
        name: input.name,
        variables: {},
        criteria: [
          {
            id: 'crit-01',
            kind: 'element_visible',
            description: '主页面容器渲染完成',
            sourceKind: 'saved_case',
            sourceRef: input.slug,
            locator: { by: 'css', value: '#app' },
          },
        ],
        steps: [
          { kind: 'navigate', url: 'http://localhost:8080/' },
          { kind: 'assert', criterionId: 'crit-01' },
        ],
        fixtureRefs: [],
      },
      sha256: 'a'.repeat(64),
      reviewStatus: 'draft',
      createdBy: mockCurrentUser.id,
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
    };
    this.savedCases.unshift(newCase);
    this.savedCaseVersions[caseId] = [initialVersion];
    return newCase;
  }

  // 55. listSavedCaseVersions
  public async listSavedCaseVersions(
    caseId: string,
    _query?: PaginationQuery,
  ): Promise<SavedCaseVersionPage> {
    let items: SavedCaseVersion[] = [];
    for (const [k, v] of Object.entries(this.savedCaseVersions)) {
      if (isSameId(k, caseId)) {
        items = v;
        break;
      }
    }
    return { items, nextCursor: null };
  }

  // 56. createSavedCaseVersion
  public async createSavedCaseVersion(
    caseId: string,
    input: SavedCaseVersionCreate,
  ): Promise<SavedCaseVersion> {
    const list = this.savedCaseVersions[caseId] || [];
    const nextVerNum =
      list.length > 0 ? Math.max(...list.map((v) => v.version)) + 1 : 1;
    const versionId = `ver_mock_${Date.now()}_v${nextVerNum}`;
    const newVersion: SavedCaseVersion = {
      id: versionId,
      caseId,
      version: nextVerNum,
      document: input.document,
      sha256: Array.from({ length: 64 }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join(''),
      reviewStatus: 'draft',
      createdBy: mockCurrentUser.id,
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
    };
    list.unshift(newVersion);
    this.savedCaseVersions[caseId] = list;

    // Update parent case version counter (optimistic concurrency version increments on version creation)
    const c = this.savedCases.find((x) => x.id === caseId);
    if (c) c.version = (c.version || 1) + 1;

    return newVersion;
  }

  // 57. previewSavedCaseReview
  public async previewSavedCaseReview(
    versionId: string,
    input: ReviewPreviewInput,
  ): Promise<ReviewPreview> {
    if (!input || !input.reason || !input.reason.trim()) {
      throw new Error('审查理由不可为空');
    }
    let targetVer: SavedCaseVersion | null = null;
    let approvedVer: SavedCaseVersion | null = null;
    for (const versions of Object.values(this.savedCaseVersions)) {
      const found = versions.find((v) => v.id === versionId);
      if (found) {
        targetVer = found;
        approvedVer =
          versions.find((v) => v.reviewStatus === 'approved') || null;
        break;
      }
    }

    if (!targetVer) {
      throw new Error(`用例版本未找到: ${versionId}`);
    }

    if (input.expectedVersion !== targetVer.version) {
      throw new Error(
        `预期版本号不匹配: 请求 ${input.expectedVersion}, 实际 ${targetVer.version}`,
      );
    }

    const prevJson = approvedVer
      ? JSON.stringify(approvedVer.document, null, 2)
      : '(无历史批准版本)';
    const nextJson = targetVer
      ? JSON.stringify(targetVer.document, null, 2)
      : '{}';

    const diff =
      `--- v${approvedVer?.version ?? 0} (approved)\n+++ v${targetVer?.version ?? 1} (draft)\n@@ -1,5 +1,6 @@\n` +
      `- 准则数量: ${approvedVer?.document.criteria.length ?? 0}\n` +
      `+ 准则数量: ${targetVer?.document.criteria.length ?? 0}\n` +
      `- 步骤数量: ${approvedVer?.document.steps.length ?? 0}\n` +
      `+ 步骤数量: ${targetVer?.document.steps.length ?? 0}\n` +
      `\n--- 变更前 (Approved 基线) ---\n` +
      prevJson.slice(0, 400) +
      `\n\n--- 变更后 (Draft 新草稿) ---\n` +
      nextJson.slice(0, 400);

    const risks: string[] = [];
    if (!approvedVer) {
      risks.push(
        '新建用例首版本审查：首次纳入回归基线，请仔细核验准则覆盖度。',
      );
    }
    if ((targetVer?.document.steps.length ?? 0) > 10) {
      risks.push('步骤序列较长：执行耗时与网络波动敏感度可能增加。');
    }
    if (targetVer?.document.steps.some((s) => s.kind === 'ai_action')) {
      risks.push(
        '包含 AI 探索型动作：执行路径具有非确定性，建议增加显式断言准则约束。',
      );
    }

    const preview: ReviewPreview = {
      versionId,
      expectedVersion: targetVer.version,
      decision: input.decision,
      reason: input.reason,
      diff,
      risks,
      confirmationToken: `tok_case_review_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
    this.activeReviewPreviews[versionId] = preview;
    return preview;
  }

  // 58. commitSavedCaseReview
  public async commitSavedCaseReview(
    versionId: string,
    input: ReviewCommit,
  ): Promise<SavedCaseVersion> {
    const preview = this.activeReviewPreviews[versionId];
    if (!preview || preview.confirmationToken !== input.confirmationToken) {
      throw new Error('审查确认安全令牌无效或已失效，请重新生成审查预览');
    }
    if (new Date(preview.expiresAt).getTime() < Date.now()) {
      throw new Error('审查确认安全令牌已过期，请重新生成审查预览');
    }

    // Verify token binding
    if (
      preview.expectedVersion !== input.expectedVersion ||
      preview.decision !== input.decision ||
      preview.reason !== input.reason
    ) {
      throw new Error('提交的决议参数与预览不匹配，请重新生成审查预览');
    }

    let targetVer: SavedCaseVersion | null = null;
    let targetCase: SavedCase | null = null;
    for (const [caseId, versions] of Object.entries(this.savedCaseVersions)) {
      const found = versions.find((v) => v.id === versionId);
      if (found) {
        targetVer = found;
        targetCase = this.savedCases.find((c) => c.id === caseId) || null;
        break;
      }
    }

    if (!targetVer) {
      throw new Error(`用例版本未找到: ${versionId}`);
    }

    targetVer.reviewStatus =
      input.decision === 'approve' ? 'approved' : 'rejected';
    targetVer.reviewedBy = mockCurrentUser.id;
    targetVer.reviewedAt = new Date().toISOString();

    if (input.decision === 'approve' && targetCase) {
      targetCase.currentApprovedVersionId = targetVer.id;
      targetCase.version = (targetCase.version || 1) + 1;
    }

    delete this.activeReviewPreviews[versionId];
    return targetVer;
  }

  // 59. createRegressionRun
  public async createRegressionRun(input: RegressionRunCreate): Promise<Run> {
    const runId = `run_regression_${Date.now()}`;
    const newRun: Run = {
      id: runId,
      projectId: input.projectId,
      creatorId: mockCurrentUser.id,
      targetUrl: 'http://localhost:8080/regression',
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    this.runs.unshift(newRun);

    // Populate mock regression cases for this run
    for (const vId of input.caseVersionIds) {
      this.cases.push({
        definition: {
          id: `case_reg_${Date.now()}_${vId.slice(0, 6)}`,
          runId,
          projectId: input.projectId,
          version: 1,
          title: `Regression Case from version ${vId.slice(0, 8)}`,
          summary: `Offline Mock: Generated regression case for version ${vId}`,
          preconditions: ['Mock environment ready'],
          outline: ['Execute replay steps'],
          criteria: [
            {
              id: `crit_reg_${vId.slice(0, 6)}`,
              kind: 'element_visible',
              description: 'Mock criteria for regression verification',
              sourceKind: 'saved_case',
              sourceRef: vId,
            },
          ],
          regression: {
            sourceVersionId: vId,
            sourceDocumentSha256:
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            snapshotDocumentSha256:
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            document: mockRegressionDocument1,
            moduleSnapshots: [],
          },
        },
        outcome: 'not_run',
        verdict: null,
      });
    }

    return newRun;
  }

  // 60. listSchedules
  public async listSchedules(
    projectId: string,
    _query?: PaginationQuery,
  ): Promise<SchedulePage> {
    const items = this.schedules.filter((s) =>
      matchesProjectId(s.projectId, projectId),
    );
    return { items, nextCursor: null };
  }

  // 61. createSchedule
  public async createSchedule(
    projectId: string,
    input: ScheduleCreate,
  ): Promise<Schedule> {
    const targetProject =
      this.projects.find((p) => matchesProjectId(p.id, projectId)) ||
      (matchesProjectId(MOCK_PROJECT_ID, projectId) ? this.projects[0] : null);
    const effectiveProjectId = targetProject ? targetProject.id : projectId;
    const s: Schedule = {
      id: `sched_mock_${Date.now()}`,
      projectId: effectiveProjectId,
      name: input.name,
      cron: input.cron,
      timezone: input.timezone || 'Asia/Shanghai',
      templateKind: input.templateKind,
      runTemplate: input.runTemplate,
      overlapPolicy: input.overlapPolicy || 'skip',
      missedPolicy: input.missedPolicy || 'skip',
      enabled: input.enabled !== undefined ? input.enabled : true,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    this.schedules.unshift(s);
    return s;
  }

  // 62. updateSchedule
  public async updateSchedule(
    scheduleId: string,
    input: SchedulePatch,
  ): Promise<Schedule> {
    const s = this.schedules.find((x) => x.id === scheduleId);
    if (!s) throw new Error(`定时调度不存在: ${scheduleId}`);
    if (input.name !== undefined) s.name = input.name;
    if (input.cron !== undefined) s.cron = input.cron;
    if (input.timezone !== undefined) s.timezone = input.timezone;
    if (input.templateKind !== undefined) s.templateKind = input.templateKind;
    if (input.runTemplate !== undefined) s.runTemplate = input.runTemplate;
    if (input.overlapPolicy !== undefined)
      s.overlapPolicy = input.overlapPolicy;
    if (input.missedPolicy !== undefined) s.missedPolicy = input.missedPolicy;
    if (input.enabled !== undefined) s.enabled = input.enabled;
    s.version++;
    return s;
  }

  // 63. runScheduleNow
  public async runScheduleNow(scheduleId: string): Promise<Run> {
    const s = this.schedules.find((x) => x.id === scheduleId);
    if (!s) throw new Error(`定时调度不存在: ${scheduleId}`);
    return s.templateKind === 'regression'
      ? this.createRegressionRun(s.runTemplate as RegressionRunCreate)
      : this.createRun(s.runTemplate as RunCreate);
  }

  public async listScheduleOccurrences(
    _scheduleId: string,
    _query?: PaginationQuery,
  ): Promise<ScheduleOccurrencePage> {
    return { items: [], nextCursor: null };
  }

  // 64. listApiKeys
  public async listApiKeys(
    projectId: string,
    _query?: PaginationQuery,
  ): Promise<ApiKeyPage> {
    const items = this.apiKeys.filter((k) =>
      matchesProjectId(k.projectId, projectId),
    );
    return { items, nextCursor: null };
  }

  // 65. createApiKey
  public async createApiKey(
    projectId: string,
    input: ApiKeyCreate,
  ): Promise<ApiKeyCreated> {
    const targetProject =
      this.projects.find((p) => matchesProjectId(p.id, projectId)) ||
      (matchesProjectId(MOCK_PROJECT_ID, projectId) ? this.projects[0] : null);
    const effectiveProjectId = targetProject ? targetProject.id : projectId;
    const key: ApiKey = {
      id: `key_mock_${Date.now()}`,
      projectId: effectiveProjectId,
      name: input.name,
      scope: input.scope,
      createdBy: mockCurrentUser.id,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      revokedAt: null,
    };
    this.apiKeys.unshift(key);
    return {
      key,
      token: `lqa_mock_sec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    };
  }

  // 66. revokeApiKey
  public async revokeApiKey(keyId: string): Promise<ApiKey> {
    const k = this.apiKeys.find((x) => x.id === keyId);
    if (!k) throw new Error(`API Key 不存在: ${keyId}`);
    k.revokedAt = new Date().toISOString();
    return k;
  }

  // 67. getCacheStats
  public async getCacheStats(runId: string): Promise<CacheStats> {
    return {
      runId,
      hits: 42,
      misses: 8,
      invalidated: 2,
      resolution: 'exact_match',
      savedModelCalls: 34,
      savedMs: 4200,
    };
  }

  // 68. listRepairProposals
  public async listRepairProposals(
    caseId: string,
    _query?: PaginationQuery,
  ): Promise<RepairProposalPage> {
    const items = this.repairProposals[caseId] || [];
    return { items, nextCursor: null };
  }

  // 69. createRepairProposal
  public async createRepairProposal(
    caseId: string,
    input: RepairProposalCreate,
  ): Promise<RepairProposal> {
    const list = this.repairProposals[caseId] || [];
    const p: RepairProposal = {
      id: `prop_mock_${Date.now()}`,
      caseId,
      findingId: input.findingId,
      proposedVersion: 2,
      diff: input.diff,
      verificationRunId: null,
      status: 'draft',
      createdAt: new Date().toISOString(),
      reviewReason: null,
      reviewedBy: null,
      reviewedAt: null,
    };
    list.unshift(p);
    this.repairProposals[caseId] = list;
    return p;
  }

  public async reviewRepairProposal(
    caseId: string,
    proposalId: string,
    input: RepairProposalReviewInput,
  ): Promise<RepairProposal> {
    const proposal = (this.repairProposals[caseId] ?? []).find(
      (item) => item.id === proposalId,
    );
    if (!proposal || proposal.status !== 'draft')
      throw new Error('Version conflict');
    if (input.reason.trim().length < 10) throw new Error('Reason too short');
    proposal.status = input.decision === 'approve' ? 'approved' : 'rejected';
    proposal.reviewReason = input.reason.trim();
    proposal.reviewedBy = mockCurrentUser.id;
    proposal.reviewedAt = new Date().toISOString();
    return proposal;
  }

  public async createRepairCandidateDraft(
    caseId: string,
    proposalId: string,
    input: SavedCaseVersionCreate,
  ): Promise<SavedCaseVersion> {
    const proposal = (this.repairProposals[caseId] ?? []).find(
      (item) => item.id === proposalId,
    );
    if (!proposal || proposal.status !== 'approved')
      throw new Error('Repair proposal is not approved');
    if (this.repairCandidates[proposalId])
      throw new Error('Repair candidate already created');
    const draft = await this.createSavedCaseVersion(caseId, input);
    this.repairCandidates[proposalId] = draft;
    return draft;
  }

  public async getRepairCandidateDraft(
    _caseId: string,
    proposalId: string,
  ): Promise<SavedCaseVersion> {
    const candidate = this.repairCandidates[proposalId];
    if (!candidate) throw new Error('Repair candidate not created');
    return candidate;
  }

  public async startRepairCandidateVerification(
    caseId: string,
    proposalId: string,
  ): Promise<RepairCandidateVerification> {
    const candidate = this.repairCandidates[proposalId];
    if (
      !candidate ||
      candidate.caseId !== caseId ||
      candidate.reviewStatus !== 'draft'
    )
      throw new Error('Verified candidate draft required');
    const prior = this.candidateVerifications[proposalId] ?? [];
    if (prior.some((v) => v.status === 'queued' || v.status === 'running'))
      throw new Error('Verification already pending');
    const result: RepairCandidateVerification = {
      id: `verify_mock_${Date.now()}`,
      projectId: MOCK_PROJECT_ID,
      proposalId,
      caseId,
      candidateVersionId: candidate.id,
      candidateSha256: candidate.sha256,
      status: 'queued',
      outcome: null,
      reasonCode: null,
      observedSteps: 0,
      verifiedCriteria: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.candidateVerifications[proposalId] = [result, ...prior];
    return result;
  }

  public async listRepairCandidateVerifications(
    _caseId: string,
    proposalId: string,
    _query?: PaginationQuery,
  ): Promise<RepairCandidateVerificationPage> {
    return {
      items: this.candidateVerifications[proposalId] ?? [],
      nextCursor: null,
    };
  }

  public async listRepairCandidateEvidence(
    _caseId: string,
    _proposalId: string,
    _verificationId: string,
  ): Promise<RepairCandidateEvidencePage> {
    // Mock verifications never execute Chromium; no fabricated evidence.
    return { items: [] };
  }

  // 70. importSavedCaseYaml
  public async importSavedCaseYaml(
    projectId: string,
    input: SavedCaseYamlImport,
  ): Promise<SavedCase> {
    if (!input.slug || !input.slug.trim()) {
      throw new Error('Invalid SavedCaseYamlImport: slug cannot be empty');
    }
    if (!input.name || !input.name.trim()) {
      throw new Error('Invalid SavedCaseYamlImport: name cannot be empty');
    }
    if (typeof input.yaml !== 'string' || input.yaml.length === 0) {
      throw new Error('Invalid SavedCaseYamlImport: yaml cannot be empty');
    }
    if (input.yaml.length > 262144) {
      throw new Error(
        'Invalid SavedCaseYamlImport: yaml length exceeds maximum 262144 characters',
      );
    }

    // Resolve project and canonical identity (reject unknown projects without creating new ones)
    const targetProject =
      this.projects.find((p) => matchesProjectId(p.id, projectId)) ||
      (matchesProjectId(MOCK_PROJECT_ID, projectId) ? this.projects[0] : null);
    if (!targetProject) {
      throw new Error(`项目不存在: ${projectId}`);
    }

    const effectiveProjectId = targetProject.id;

    const caseId = generateMockUuid();
    const versionId = generateMockUuid();

    // Synthetic draft test document: canonical schema-compliant DTO, unapproved and non-executable
    const syntheticDoc: RegressionDocument = {
      schemaVersion: 1,
      kind: 'localqa/test',
      id: input.slug.trim(),
      name: input.name.trim(),
      variables: {},
      criteria: [
        {
          id: 'crit-01',
          kind: 'element_visible',
          description: '主页面容器渲染完成 (synthetic)',
          sourceKind: 'saved_case',
          sourceRef: input.slug.trim(),
          locator: { by: 'css', value: '#app, body' },
        },
      ],
      steps: [
        { kind: 'navigate', url: 'http://localhost:8080/' },
        { kind: 'assert', criterionId: 'crit-01' },
      ],
      fixtureRefs: [],
    };

    // Canonical document SHA computed directly from the synthetic document (authoritative canonical JSON SHA-256)
    const sourceSha = await computeCanonicalDocSha256(syntheticDoc);

    const initialDraftVersion: SavedCaseVersion = {
      id: versionId,
      caseId,
      version: 1,
      document: syntheticDoc,
      sha256: sourceSha,
      reviewStatus: 'draft',
      createdBy: generateMockUuid(),
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
    };

    const newCase: SavedCase = {
      id: caseId,
      projectId: effectiveProjectId,
      slug: input.slug.trim(),
      name: input.name.trim(),
      status: 'active',
      currentApprovedVersionId: null, // Draft only, unapproved
      version: 1,
      createdAt: new Date().toISOString(),
    };

    this.savedCases.unshift(newCase);
    this.savedCaseVersions[caseId] = [initialDraftVersion];
    return newCase;
  }

  // 71. exportSavedCaseYaml
  public async exportSavedCaseYaml(
    versionId: string,
  ): Promise<SavedCaseYamlExport> {
    const versions = Object.values(this.savedCaseVersions).flat();
    const targetVer = versions.find((v) => v.id === versionId);
    if (!targetVer) {
      throw new Error(`SavedCaseVersion not found: ${versionId}`);
    }

    return {
      versionId: targetVer.id,
      sourceDocumentSha256: targetVer.sha256,
      yaml: `# Synthetic exported YAML for version ${targetVer.version}\nschemaVersion: 1\nkind: localqa/test\nid: "${targetVer.document.id}"\nname: "${targetVer.document.name}"\nsteps:\n  - kind: navigate\n    url: "http://localhost:8080/"\n`,
    };
  }

  // archiveSavedCase
  public async archiveSavedCase(
    caseId: string,
    input: SavedCaseArchiveInput,
  ): Promise<SavedCase> {
    const validation = validateContract('SavedCaseArchiveInput', input);
    if (!validation.success) {
      throw new Error(
        `SavedCaseArchiveInput 契约验证失败: ${validation.errors?.map((e) => e.message).join('; ')}`,
      );
    }
    const found = this.savedCases.find((c) => isSameId(c.id, caseId));
    if (!found) {
      const err = new Error(`用例不存在: ${caseId}`) as Error & {
        status: number;
        statusCode: number;
      };
      err.status = 404;
      err.statusCode = 404;
      throw err;
    }
    if (found.status === 'archived') {
      const err = new Error(
        `用例已处于归档状态 (VERSION_CONFLICT 409): ${caseId}`,
      ) as Error & { status: number; statusCode: number };
      err.status = 409;
      err.statusCode = 409;
      throw err;
    }
    if (found.version !== input.expectedVersion) {
      const err = new Error(
        `用例版本冲突 (VERSION_CONFLICT): 期望版本 ${input.expectedVersion}, 当前版本 ${found.version}`,
      ) as Error & { status: number; statusCode: number };
      err.status = 409;
      err.statusCode = 409;
      throw err;
    }
    if (found.version >= 2147483647) {
      const err = new Error(
        `用例版本已达到 PG integer 上限 (2147483647)，无法继续递增新版本 (422 Unprocessable Entity)`,
      ) as Error & { status: number; statusCode: number };
      err.status = 422;
      err.statusCode = 422;
      throw err;
    }
    found.status = 'archived';
    found.version = found.version + 1;
    return { ...found };
  }

  // restoreSavedCase
  public async restoreSavedCase(
    caseId: string,
    input: SavedCaseRestoreInput,
  ): Promise<SavedCase> {
    const validation = validateContract('SavedCaseRestoreInput', input);
    if (!validation.success) {
      throw new Error(
        `SavedCaseRestoreInput 契约验证失败: ${validation.errors?.map((e) => e.message).join('; ')}`,
      );
    }
    const found = this.savedCases.find((c) => isSameId(c.id, caseId));
    if (!found) {
      const err = new Error(`用例不存在: ${caseId}`) as Error & {
        status: number;
        statusCode: number;
      };
      err.status = 404;
      err.statusCode = 404;
      throw err;
    }
    if (found.status === 'active') {
      const err = new Error(
        `用例已处于活跃状态 (VERSION_CONFLICT 409): ${caseId}`,
      ) as Error & { status: number; statusCode: number };
      err.status = 409;
      err.statusCode = 409;
      throw err;
    }
    if (found.version !== input.expectedVersion) {
      const err = new Error(
        `用例版本冲突 (VERSION_CONFLICT): 期望版本 ${input.expectedVersion}, 当前版本 ${found.version}`,
      ) as Error & { status: number; statusCode: number };
      err.status = 409;
      err.statusCode = 409;
      throw err;
    }
    if (found.version >= 2147483647) {
      const err = new Error(
        `用例版本已达到 PG integer 上限 (2147483647)，无法继续递增新版本 (422 Unprocessable Entity)`,
      ) as Error & { status: number; statusCode: number };
      err.status = 422;
      err.statusCode = 422;
      throw err;
    }
    found.status = 'active';
    found.version = found.version + 1;
    return { ...found };
  }

  // duplicateSavedCase
  public async duplicateSavedCase(
    caseId: string,
    input: SavedCaseDuplicateInput,
  ): Promise<SavedCase> {
    const validation = validateContract('SavedCaseDuplicateInput', input);
    if (!validation.success) {
      throw new Error(
        `SavedCaseDuplicateInput 契约验证失败: ${validation.errors?.map((e) => e.message).join('; ')}`,
      );
    }
    const sourceCase = this.savedCases.find((c) => isSameId(c.id, caseId));
    if (!sourceCase) {
      const err = new Error(`源用例不存在: ${caseId}`) as Error & {
        status: number;
        statusCode: number;
      };
      err.status = 404;
      err.statusCode = 404;
      throw err;
    }
    let versions: SavedCaseVersion[] = [];
    for (const [k, v] of Object.entries(this.savedCaseVersions)) {
      if (isSameId(k, caseId)) {
        versions = v;
        break;
      }
    }
    const sourceVer = versions.find((v) =>
      isSameId(v.id, input.sourceVersionId),
    );
    if (!sourceVer) {
      const err = new Error(
        `源用例版本不存在: ${input.sourceVersionId}`,
      ) as Error & { status: number; statusCode: number };
      err.status = 404;
      err.statusCode = 404;
      throw err;
    }

    if (
      sourceVer.document.fixtureRefs &&
      sourceVer.document.fixtureRefs.length > 0
    ) {
      const err = new Error(
        '用例包含外部 fixtureRefs，暂不支持复制 (422 Unprocessable Entity)',
      ) as Error & { status: number; statusCode: number };
      err.status = 422;
      err.statusCode = 422;
      throw err;
    }

    const targetProjectId = input.targetProjectId || sourceCase.projectId;
    const targetProject =
      this.projects.find((p) => matchesProjectId(p.id, targetProjectId)) ||
      (matchesProjectId(MOCK_PROJECT_ID, targetProjectId)
        ? this.projects[0]
        : null);
    if (!targetProject) {
      const err = new Error(`目标项目不存在: ${targetProjectId}`) as Error & {
        status: number;
        statusCode: number;
      };
      err.status = 404;
      err.statusCode = 404;
      throw err;
    }
    const effectiveProjectId = targetProject.id;

    // Check slug collision in target project
    const slugExists = this.savedCases.some(
      (c) =>
        matchesProjectId(c.projectId, effectiveProjectId) &&
        c.slug === input.newSlug,
    );
    if (slugExists) {
      const err = new Error(
        `目标项目中已存在标识为 "${input.newSlug}" 的测试用例 (409 Conflict)`,
      ) as Error & { status: number; statusCode: number };
      err.status = 409;
      err.statusCode = 409;
      throw err;
    }

    const newCaseId = generateMockUuid();
    const newVersionId = generateMockUuid();

    // Synthetic cloned document: explicit synthetic recording, preserves source steps & criteria
    const clonedDoc: RegressionDocument = {
      ...JSON.parse(JSON.stringify(sourceVer.document)),
      id: input.newSlug,
      name: input.newName,
    };

    const authenticSha = await computeCanonicalDocSha256(clonedDoc);

    const initialDraftVersion: SavedCaseVersion = {
      id: newVersionId,
      caseId: newCaseId,
      version: 1,
      document: clonedDoc,
      sha256: authenticSha,
      reviewStatus: 'draft', // Duplicated case is ALWAYS draft! Requires target owner review
      createdBy: resolveMockUserUuid(mockCurrentUser.id)!,
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
    };

    const newCase: SavedCase = {
      id: newCaseId,
      projectId: effectiveProjectId,
      slug: input.newSlug,
      name: input.newName,
      status: 'active',
      currentApprovedVersionId: null, // Draft only, unapproved
      version: 1,
      createdAt: new Date().toISOString(),
    };

    this.savedCases.unshift(newCase);
    this.savedCaseVersions[newCaseId] = [initialDraftVersion];
    return newCase;
  }

  // 72. createRegressionModule
  public async createRegressionModule(
    projectId: string,
    input: RegressionModuleCreate,
  ): Promise<RegressionModuleRecord> {
    const MODULE_NAME_REGEX =
      /^(?!\.{1,2}(?:\/|$))(?!.*?\/\.{1,2}(?:\/|$))[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;
    if (
      !input.name ||
      input.name.length < 1 ||
      input.name.length > 120 ||
      !MODULE_NAME_REGEX.test(input.name)
    ) {
      throw new Error(`Invalid module name: ${input.name}`);
    }

    const targetProject =
      this.projects.find((p) => matchesProjectId(p.id, projectId)) ||
      (matchesProjectId(MOCK_PROJECT_ID, projectId) ? this.projects[0] : null);
    if (!targetProject) {
      throw new Error(`项目不存在: ${projectId}`);
    }
    const effectiveProjectId = targetProject.id;

    if (!input.document || typeof input.document !== 'object') {
      throw new Error('Invalid module document: document must be an object');
    }

    const sha256 = await computeCanonicalDocSha256(input.document);

    const existing = this.regressionModules.filter(
      (m) =>
        matchesProjectId(m.projectId, effectiveProjectId) &&
        m.name === input.name,
    );
    const maxVer = existing.reduce((max, m) => Math.max(max, m.version), 0);

    if (existing.length > 0) {
      if (
        input.expectedVersion === undefined ||
        input.expectedVersion === null
      ) {
        throw new Error(
          `现有模块创建新版本必须显式提供 expectedVersion (当前最新版本为 ${maxVer})`,
        );
      }
      if (input.expectedVersion !== maxVer) {
        throw new Error(
          `版本冲突: expectedVersion ${input.expectedVersion} 与当前最新版本 ${maxVer} 不一致`,
        );
      }
    } else if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== null &&
      input.expectedVersion !== 0
    ) {
      throw new Error(
        `新模块首次创建 expectedVersion 必须为 0 或缺省，收到 ${input.expectedVersion}`,
      );
    }

    if (maxVer >= 2147483647) {
      throw new Error(
        `模块版本已达到数据库上限 (2147483647)，无法继续递增新版本`,
      );
    }

    const version = maxVer + 1;
    const authorUuid = resolveMockUserUuid(mockCurrentUser.id);

    const record: RegressionModuleRecord = {
      projectId: effectiveProjectId,
      name: input.name,
      version,
      sha256,
      document: input.document,
      reviewStatus: 'draft',
      createdBy: authorUuid,
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
    };

    const validatedRecord = parseContract(
      'RegressionModuleRecord',
      record,
    ) as RegressionModuleRecord;
    this.regressionModules.unshift(validatedRecord);
    return validatedRecord;
  }

  // 73. listRegressionModules
  public async listRegressionModules(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<RegressionModuleRecordPage> {
    const targetProject =
      this.projects.find((p) => matchesProjectId(p.id, projectId)) ||
      (matchesProjectId(MOCK_PROJECT_ID, projectId) ? this.projects[0] : null);
    if (!targetProject) {
      throw new Error(`项目不存在: ${projectId}`);
    }

    const allMatching = this.regressionModules.filter((m) =>
      matchesProjectId(m.projectId, targetProject.id),
    );

    // OpenAPI & specification requirement: all versions sorted by name ASC, version DESC
    const sorted = [...allMatching].sort((a, b) => {
      if (a.name < b.name) return -1;
      if (a.name > b.name) return 1;
      return b.version - a.version;
    });

    let startIndex = 0;
    if (query?.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (decoded) {
        const foundIndex = sorted.findIndex(
          (m) => m.name === decoded.name && m.version === decoded.version,
        );
        if (foundIndex !== -1) {
          startIndex = foundIndex + 1;
        } else {
          const num = Number(query.cursor);
          if (Number.isInteger(num) && num >= 0) startIndex = num;
        }
      } else {
        const num = Number(query.cursor);
        if (Number.isInteger(num) && num >= 0) startIndex = num;
      }
    }

    const limit =
      typeof query?.limit === 'number' && query.limit > 0
        ? query.limit
        : typeof (query as Record<string, unknown>)?.pageSize === 'number' &&
            Number((query as Record<string, unknown>).pageSize) > 0
          ? Number((query as Record<string, unknown>).pageSize)
          : sorted.length;

    const items = sorted.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < sorted.length;
    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor(
            items[items.length - 1].name,
            items[items.length - 1].version,
          )
        : null;

    const page: RegressionModuleRecordPage = { items, nextCursor };
    return parseContract(
      'RegressionModuleRecordPage',
      page,
    ) as RegressionModuleRecordPage;
  }

  // 74. listRegressionModuleVersions
  public async listRegressionModuleVersions(
    projectId: string,
    moduleName: string,
    query?: PaginationQuery,
  ): Promise<RegressionModuleRecordPage> {
    const targetProject =
      this.projects.find((p) => matchesProjectId(p.id, projectId)) ||
      (matchesProjectId(MOCK_PROJECT_ID, projectId) ? this.projects[0] : null);
    if (!targetProject) {
      throw new Error(`项目不存在: ${projectId}`);
    }

    const allMatching = this.regressionModules
      .filter(
        (m) =>
          matchesProjectId(m.projectId, targetProject.id) &&
          m.name === moduleName,
      )
      .sort((a, b) => b.version - a.version);

    let startIndex = 0;
    if (query?.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (decoded) {
        const foundIndex = allMatching.findIndex(
          (m) => m.name === decoded.name && m.version === decoded.version,
        );
        if (foundIndex !== -1) {
          startIndex = foundIndex + 1;
        } else {
          const num = Number(query.cursor);
          if (Number.isInteger(num) && num >= 0) startIndex = num;
        }
      } else {
        const num = Number(query.cursor);
        if (Number.isInteger(num) && num >= 0) startIndex = num;
      }
    }

    const limit =
      typeof query?.limit === 'number' && query.limit > 0
        ? query.limit
        : typeof (query as Record<string, unknown>)?.pageSize === 'number' &&
            Number((query as Record<string, unknown>).pageSize) > 0
          ? Number((query as Record<string, unknown>).pageSize)
          : allMatching.length;

    const items = allMatching.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < allMatching.length;
    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor(
            items[items.length - 1].name,
            items[items.length - 1].version,
          )
        : null;

    const page: RegressionModuleRecordPage = { items, nextCursor };
    return parseContract(
      'RegressionModuleRecordPage',
      page,
    ) as RegressionModuleRecordPage;
  }

  // 75. previewRegressionModuleReview
  public async previewRegressionModuleReview(
    projectId: string,
    moduleName: string,
    version: number,
    input: RegressionModuleReviewPreviewInput,
  ): Promise<RegressionModuleReviewPreview> {
    if (!Number.isInteger(version) || version < 1 || version > 2147483647) {
      throw new Error(
        `Invalid module version: must be a positive integer between 1 and 2147483647, got ${version}`,
      );
    }

    const target = this.regressionModules.find(
      (m) =>
        matchesProjectId(m.projectId, projectId) &&
        m.name === moduleName &&
        m.version === version,
    );
    if (!target) {
      throw new Error(`模块版本不存在: ${moduleName}@v${version}`);
    }

    if (input.expectedVersion !== target.version) {
      throw new Error(
        `版本冲突: expectedVersion ${input.expectedVersion} 与目标版本 ${target.version} 不匹配`,
      );
    }

    if (target.reviewStatus !== 'draft') {
      throw new Error(
        `只有 draft 状态的模块版本才允许审批，当前状态: ${target.reviewStatus}`,
      );
    }

    const confirmationToken =
      generateMockUuid().replace(/-/g, '') +
      generateMockUuid().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 300000).toISOString();

    const preview: RegressionModuleReviewPreview = {
      projectId: target.projectId,
      moduleName: target.name,
      version: target.version,
      documentSha256: target.sha256,
      expectedVersion: input.expectedVersion,
      decision: input.decision,
      reason: input.reason,
      diff: `=== 模块 ${target.name}@v${target.version} 审查预览 (${input.decision.toUpperCase()}) ===\n+ 断言准则数: ${target.document.criteria.length}\n+ 执行步骤数: ${target.document.steps.length}\n+ 变更说明: ${input.reason}`,
      risks: [
        input.decision === 'approve'
          ? '批准后该模块版本将成为受控执行基线，所有引用该版本的回归用例均受约束'
          : '驳回后该版本将被置为 rejected 状态，后续流程不可引用此版本执行',
      ],
      confirmationToken,
      expiresAt,
    };

    this.activeModuleReviewPreviews[confirmationToken] = preview;
    return preview;
  }

  // 76. reviewRegressionModuleVersion
  public async reviewRegressionModuleVersion(
    projectId: string,
    moduleName: string,
    version: number,
    input: RegressionModuleReviewCommit,
  ): Promise<RegressionModuleRecord> {
    if (!Number.isInteger(version) || version < 1 || version > 2147483647) {
      throw new Error(
        `Invalid module version: must be a positive integer between 1 and 2147483647, got ${version}`,
      );
    }

    const target = this.regressionModules.find(
      (m) =>
        matchesProjectId(m.projectId, projectId) &&
        m.name === moduleName &&
        m.version === version,
    );
    if (!target) {
      throw new Error(`模块版本不存在: ${moduleName}@v${version}`);
    }

    const preview = this.activeModuleReviewPreviews[input.confirmationToken];
    if (!preview) {
      throw new Error('无效或不存在的审批确认 Token');
    }

    if (Date.now() >= new Date(preview.expiresAt).getTime()) {
      delete this.activeModuleReviewPreviews[input.confirmationToken];
      throw new Error('审批确认 Token 已过期，请重新生成预览');
    }

    if (
      !matchesProjectId(preview.projectId, target.projectId) ||
      preview.moduleName !== target.name ||
      preview.version !== target.version
    ) {
      throw new Error('Token 与待审批目标模块不匹配');
    }

    if (preview.decision !== input.decision) {
      throw new Error('审批决议与生成预览时的决议不匹配');
    }

    if (input.expectedVersion !== target.version) {
      throw new Error('期望版本与目标版本不一致');
    }

    delete this.activeModuleReviewPreviews[input.confirmationToken];

    target.reviewStatus =
      input.decision === 'approve' ? 'approved' : 'rejected';
    target.reviewedBy = resolveMockUserUuid(mockCurrentUser.id);
    target.reviewedAt = new Date().toISOString();

    return parseContract(
      'RegressionModuleRecord',
      target,
    ) as RegressionModuleRecord;
  }
}
