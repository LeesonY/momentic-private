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
  ProjectPage,
  Environment,
  EnvironmentCreate,
  EnvironmentPatch,
  EnvironmentPage,
  AuthProfile,
  AuthProfileCreate,
  AuthProfilePatch,
  AuthProfilePage,
  Knowledge,
  KnowledgeCreate,
  KnowledgePatch,
  KnowledgePage,
  ModelProfile,
  ModelProfileCreate,
  ModelProfilePatch,
  ModelProfilePage,
  ModelProbeResult,
  Run,
  RunCreate,
  RunPage,
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
  TriageInput,
  TriagePreview,
  TriageCommit,
  InputRequest,
  InputResponse,
  Export,
  ExportInput,
  Health,
  LoginInput,
  LoginResult,
  MessageInput,
} from '@localqa/contracts';
import {
  mockCurrentUser,
  mockProject,
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
  defaultRunConfig,
} from './data.ts';

export class MockApiClient implements ApiClient {
  private runs: Run[] = [...mockRuns];
  private findings: Finding[] = [...mockFindings];
  private knowledge: Knowledge[] = [...mockKnowledge];
  private environments: Environment[] = [...mockEnvironments];
  private authProfiles: AuthProfile[] = [...mockAuthProfiles];

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
    return { items: [mockProject], nextCursor: null };
  }

  public async getProject(projectId: string): Promise<Project> {
    if (projectId !== mockProject.id) {
      const err = new Error('项目不存在 (404)') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return mockProject;
  }

  public async createProject(input: ProjectCreate): Promise<Project> {
    const newProj: Project = {
      id: `proj_mock_${Date.now()}`,
      name: input.name,
      status: 'active',
      defaultModelProfileId: 'model_mock_gpt4o',
      createdAt: new Date().toISOString(),
      version: 1,
    };
    return newProj;
  }

  public async updateProject(
    _projectId: string,
    input: ProjectPatch,
  ): Promise<Project> {
    return { ...mockProject, ...input };
  }

  public async listMembers(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<MemberPage> {
    return { items: mockMembers, nextCursor: null };
  }

  public async replaceMembers(
    _projectId: string,
    _input: MemberUpdate,
  ): Promise<Project> {
    return mockProject;
  }

  public async listEnvironment(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<EnvironmentPage> {
    return { items: this.environments, nextCursor: null };
  }

  public async listEnvironments(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<EnvironmentPage> {
    return { items: this.environments, nextCursor: null };
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
    return { items: this.authProfiles, nextCursor: null };
  }

  public async listAuthProfiles(
    _projectId: string,
    _query?: PaginationQuery,
  ): Promise<AuthProfilePage> {
    return { items: this.authProfiles, nextCursor: null };
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
      hasSecret: false,
      version: 1,
      status: 'active',
      formConfig: input.formConfig || null,
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
    return { ...found, ...input };
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
    return { items: mockModelProfiles, nextCursor: null };
  }

  public async createModel(input: ModelProfileCreate): Promise<ModelProfile> {
    return {
      id: `model_mock_${Date.now()}`,
      name: input.name,
      endpoint: input.endpoint,
      configuredModelId: input.configuredModelId,
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
    const found = mockModelProfiles.find((m) => m.id === modelProfileId);
    if (!found) throw new Error('模型配置未找到');
    return found;
  }

  public async updateModel(
    modelProfileId: string,
    input: ModelProfilePatch,
  ): Promise<ModelProfile> {
    const found = mockModelProfiles.find((m) => m.id === modelProfileId);
    if (!found) throw new Error('模型配置未找到');
    return { ...found, ...input };
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

  public async sendRunMessage(
    runId: string,
    _messageOrInput: string | MessageInput,
    _expectedContextVersion?: number,
  ): Promise<Run> {
    const run = this.runs.find((r) => r.id === runId);
    return run || this.runs[0];
  }

  public async respondToInput(
    _runId: string,
    _inputId: string,
    _response: InputResponse,
  ): Promise<InputRequest> {
    return {
      id: 'input_mock_01',
      runId: this.runs[0]?.id || 'mock_run',
      kind: 'auth_profile',
      status: 'resolved',
      prompt: 'Mock input response resolved',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      version: 2,
    };
  }

  public streamEvents(_runId: string, _lastEventId?: string): EventSource {
    return new EventSource('about:blank');
  }

  public async listRunCases(
    _runId: string,
    _query?: PaginationQuery,
  ): Promise<CaseRecordPage> {
    return { items: mockCases, nextCursor: null };
  }

  public async getCase(caseId: string): Promise<CaseRecord> {
    const found = mockCases.find((c) => c.definition.id === caseId);
    if (!found) throw new Error(`用例 ${caseId} 未找到`);
    return found;
  }

  public async listCaseAttempts(
    caseId: string,
    _query?: PaginationQuery,
  ): Promise<CaseAttemptPage> {
    return {
      items: [
        {
          id: `att_${caseId}_1`,
          caseId,
          taskId: 'task_mock_exec_01',
          attemptNumber: 1,
          status: 'completed',
          verdict:
            mockCases.find((c) => c.definition.id === caseId)?.verdict || null,
          startedAt: '2026-10-02T08:01:30.000Z',
          finishedAt: '2026-10-02T08:01:36.000Z',
        },
      ],
      nextCursor: null,
    };
  }

  public async listRunTasks(
    _runId: string,
    _query?: PaginationQuery,
  ): Promise<TaskPage> {
    return { items: mockTasks, nextCursor: null };
  }

  public async listTaskSteps(
    _taskId: string,
    _query?: PaginationQuery,
  ): Promise<StepPage> {
    return { items: mockSteps, nextCursor: null };
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
}
