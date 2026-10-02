import type { ApiClient } from '../api/types.ts';
import type {
  User,
  Project,
  Environment,
  AuthProfile,
  Knowledge,
  ModelProfile,
  Run,
  RunConfig,
  BudgetOverrides,
  Task,
  CaseRecord,
  CaseAttempt,
  Finding,
  Step,
  Artifact,
  Report,
  Member,
  TriagePreview,
  TriageCommit,
  InputResponse,
  Export,
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
} from './data.ts';

export class MockApiClient implements ApiClient {
  private runs: Run[] = [...mockRuns];
  private findings: Finding[] = [...mockFindings];
  private knowledge: Knowledge[] = [...mockKnowledge];
  private environments: Environment[] = [...mockEnvironments];
  private authProfiles: AuthProfile[] = [...mockAuthProfiles];

  public async login(_input: {
    email?: string;
    username?: string;
    password?: string;
  }): Promise<{ token: string; user: User }> {
    return { token: 'mock_session_token_123', user: mockCurrentUser };
  }

  public async logout(): Promise<void> {
    // No-op for mock
  }

  public async currentUser(): Promise<User> {
    return mockCurrentUser;
  }

  public async listUsers(): Promise<{ items: User[] }> {
    return { items: [mockCurrentUser] };
  }

  public async listProjects(): Promise<{ items: Project[] }> {
    return { items: [mockProject] };
  }

  public async getProject(projectId: string): Promise<Project> {
    if (projectId !== mockProject.id) {
      const err = new Error('项目不存在 (404)') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return mockProject;
  }

  public async createProject(input: { name: string }): Promise<Project> {
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
    projectId: string,
    input: Partial<Project>,
  ): Promise<Project> {
    return { ...mockProject, ...input };
  }

  public async listMembers(_projectId: string): Promise<{ items: Member[] }> {
    return { items: mockMembers };
  }

  public async listEnvironments(
    _projectId: string,
  ): Promise<{ items: Environment[] }> {
    return { items: this.environments };
  }

  public async createEnvironment(
    projectId: string,
    input: Partial<Environment>,
  ): Promise<Environment> {
    const newEnv: Environment = {
      id: `env_mock_${Date.now()}`,
      projectId,
      name: input.name || '新建环境',
      baseUrl: input.baseUrl || 'http://localhost:8080',
      allowedOrigins: (input.allowedOrigins || ['http://localhost:8080']) as [
        string,
        ...string[],
      ],
      excludedPaths: input.excludedPaths || [],
      tlsPolicy: input.tlsPolicy || 'strict',
      defaultAuthProfileId: null,
      version: 1,
    };
    this.environments.push(newEnv);
    return newEnv;
  }

  public async listAuthProfiles(
    _projectId: string,
  ): Promise<{ items: AuthProfile[] }> {
    return { items: this.authProfiles };
  }

  public async createAuthProfile(
    projectId: string,
    input: Partial<AuthProfile>,
  ): Promise<AuthProfile> {
    const newProfile: AuthProfile = {
      id: `auth_mock_${Date.now()}`,
      projectId,
      environmentId: input.environmentId || null,
      name: input.name || '新建认证凭据',
      mode: input.mode || 'form',
      allowedOrigins: (input.allowedOrigins || ['http://localhost:8080']) as [
        string,
        ...string[],
      ],
      sharingPolicy: 'exclusive_run',
      hasSecret: true,
      status: 'active',
      formConfig: input.formConfig || null,
      version: 1,
    };
    this.authProfiles.push(newProfile);
    return newProfile;
  }

  public async listKnowledge(
    _projectId: string,
  ): Promise<{ items: Knowledge[] }> {
    return { items: this.knowledge };
  }

  public async createKnowledge(
    projectId: string,
    input: {
      title: string;
      text: string;
      kind: 'terminology' | 'rule' | 'flow' | 'restriction';
    },
  ): Promise<Knowledge> {
    const newK: Knowledge = {
      id: `kno_mock_${Date.now()}`,
      projectId,
      kind: input.kind,
      title: input.title,
      text: input.text,
      approved: true,
      version: 1,
    };
    this.knowledge.push(newK);
    return newK;
  }

  public async listModels(): Promise<{ items: ModelProfile[] }> {
    return { items: mockModelProfiles };
  }

  public async probeModel(
    _modelId: string,
  ): Promise<{ healthy: boolean; latencyMs: number }> {
    return { healthy: true, latencyMs: 245 };
  }

  public async listRuns(_projectId: string): Promise<{ items: Run[] }> {
    return { items: this.runs };
  }

  public async getRun(runId: string): Promise<Run> {
    const found = this.runs.find((r) => r.id === runId);
    if (!found) {
      const err = new Error(`运行记录 ${runId} 未找到`) as Error & {
        status: number;
      };
      err.status = 404;
      throw err;
    }
    return found;
  }

  public async createRun(input: {
    projectId: string;
    targetUrl: string;
    description?: string;
    environmentId?: string;
    authProfileId?: string;
    modelProfileId?: string;
    budgetOverrides?: BudgetOverrides;
    config?: Partial<RunConfig>;
  }): Promise<Run> {
    const defaultRunConfig = {
      allowedOrigins: ['http://localhost:8080'] as [string, ...string[]],
      actionPolicy: 'non_submitting' as const,
      budget: {
        maxCases: input.budgetOverrides?.maxCases || 8,
        maxPages: input.budgetOverrides?.maxPages || 6,
        maxDepth: input.budgetOverrides?.maxDepth || 2,
        maxActiveSeconds: input.budgetOverrides?.maxActiveSeconds || 600,
        maxActionsPerCase: input.budgetOverrides?.maxActionsPerCase || 30,
        maxActions: input.budgetOverrides?.maxActions || 120,
        maxModelCalls: input.budgetOverrides?.maxModelCalls || 100,
        maxReproductions: input.budgetOverrides?.maxReproductions || 3,
        concurrency: input.budgetOverrides?.concurrency || 1,
        maxTotalTokens: input.budgetOverrides?.maxTotalTokens || 300000,
      },
      environmentVersion: 1,
      authProfileVersion: 1,
      knowledgeVersionIds: ['kno_mock_br_101'],
      models: {
        coordinator: {
          profileId: input.modelProfileId || 'model_mock_gpt4o',
          version: 1,
        },
        explorer: {
          profileId: input.modelProfileId || 'model_mock_gpt4o',
          version: 1,
        },
        executor: {
          profileId: input.modelProfileId || 'model_mock_gpt4o',
          version: 1,
        },
        assertion: {
          profileId: input.modelProfileId || 'model_mock_gpt4o',
          version: 1,
        },
        reproducer: {
          profileId: input.modelProfileId || 'model_mock_gpt4o',
          version: 1,
        },
      },
      ...input.config,
    };

    const newRun: Run = {
      id: `run_mock_${Date.now()}`,
      projectId: input.projectId,
      creatorId: mockCurrentUser.id,
      targetUrl: input.targetUrl,
      status: 'running',
      phase: 'explore',
      completion: 'none',
      terminationReason: null,
      contextVersion: 1,
      effectiveConfig: defaultRunConfig,
      budgetUsed: {
        activeSeconds: 5,
        actions: 1,
        modelCalls: 1,
        totalTokens: 1200,
        reproductions: 0,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    this.runs.unshift(newRun);
    return newRun;
  }

  public async cancelRun(runId: string): Promise<{ success: boolean }> {
    const run = this.runs.find((r) => r.id === runId);
    if (run) {
      run.status = 'cancelled';
      run.terminationReason = 'user_cancel';
      run.updatedAt = new Date().toISOString();
    }
    return { success: true };
  }

  public async sendRunMessage(runId: string, _message: string): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (run) {
      run.contextVersion++;
    }
  }

  public async respondToInput(
    runId: string,
    _inputId: string,
    _response: InputResponse,
  ): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (run) {
      run.status = 'running';
      run.phase = 'explore';
    }
  }

  public async listRunCases(runId: string): Promise<{ items: CaseRecord[] }> {
    return {
      items: mockCases.filter(
        (c) => c.definition.runId === runId || runId.startsWith('run_mock'),
      ),
    };
  }

  public async getCase(caseId: string): Promise<CaseRecord> {
    const found = mockCases.find((c) => c.definition.id === caseId);
    if (!found) throw new Error(`用例 ${caseId} 未找到`);
    return found;
  }

  public async listCaseAttempts(
    caseId: string,
  ): Promise<{ items: CaseAttempt[] }> {
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
    };
  }

  public async listRunTasks(_runId: string): Promise<{ items: Task[] }> {
    return { items: mockTasks };
  }

  public async listTaskSteps(_taskId: string): Promise<{ items: Step[] }> {
    return { items: mockSteps };
  }

  public async getStep(stepId: string): Promise<Step> {
    const found = mockSteps.find((s) => s.id === stepId);
    if (!found) throw new Error(`步骤 ${stepId} 未找到`);
    return found;
  }

  public async listRunFindings(runId: string): Promise<{ items: Finding[] }> {
    return {
      items: this.findings.filter(
        (f) => f.runId === runId || runId.startsWith('run_mock'),
      ),
    };
  }

  public async getFinding(findingId: string): Promise<Finding> {
    const found = this.findings.find((f) => f.id === findingId);
    if (!found) throw new Error(`缺陷 ${findingId} 未找到`);
    return found;
  }

  public async previewTriage(
    findingId: string,
    disposition:
      | 'accepted'
      | 'duplicate'
      | 'works_as_intended'
      | 'cannot_reproduce'
      | 'closed',
    reason: string,
  ): Promise<TriagePreview> {
    return {
      ...mockTriagePreview,
      findingId,
      disposition,
      reason,
    };
  }

  public async commitTriage(
    findingId: string,
    input: TriageCommit,
  ): Promise<Finding> {
    const finding = this.findings.find((f) => f.id === findingId);
    if (!finding) throw new Error(`缺陷 ${findingId} 未找到`);
    finding.triageDisposition = input.disposition;
    return finding;
  }

  public async getReport(runId: string): Promise<Report> {
    const run = this.runs.find((r) => r.id === runId) || mockRuns[0];
    const isPartial = run?.completion === 'partial';
    return {
      ...mockReport,
      run,
      summary: {
        ...mockReport.summary,
        passed: isPartial ? 1 : 3,
        blocked: isPartial ? 2 : 0,
        notRun: isPartial ? 1 : 0,
      },
    };
  }

  public async createExport(
    runId: string,
    format: 'json' | 'markdown' | 'zip',
  ): Promise<Export> {
    return {
      id: `exp_mock_${Date.now()}`,
      runId,
      format,
      artifactId: 'art_mock_export_zip',
      snapshotAt: new Date().toISOString(),
      status: 'ready',
      error: null,
    };
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

  public async healthReady(): Promise<{
    status: string;
    checks: Record<string, boolean>;
  }> {
    return {
      status: 'ready',
      checks: {
        database: true,
        schema: true,
        browserWorker: true,
        modelGateway: true,
      },
    };
  }
}
