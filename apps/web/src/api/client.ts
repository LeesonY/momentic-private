/* Generated from docs/contracts/openapi.json by scripts/generateClient.mjs. DO NOT EDIT DIRECTLY. */

import { parseContract, type ContractName } from '@localqa/contracts';
import type {
  User,
  UserCreate,
  UserPatch,
  UserPage,
  Project,
  ProjectCreate,
  ProjectPatch,
  ProjectPage,
  MemberUpdate,
  MemberPage,
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
  MessageInput,
  InputRequest,
  InputResponse,
  CaseRecord,
  CaseRecordPage,
  CaseAttemptPage,
  TaskPage,
  Step,
  StepPage,
  RunEventPage,
  Finding,
  FindingPage,
  TriageInput,
  TriagePreview,
  TriageCommit,
  Report,
  Export,
  ExportInput,
  Artifact,
  Health,
  RunMessagePage,
  LoginInput,
  LoginResult,
} from '@localqa/contracts';
import type {
  ApiClient,
  PaginationQuery,
  ListRunsQuery,
  ListEventHistoryQuery,
  CreateRunInput,
  SavedCase,
  SavedCaseCreate,
  SavedCasePage,
  SavedCaseVersion,
  SavedCaseVersionCreate,
  SavedCaseVersionPage,
  ReviewPreview,
  ReviewPreviewInput,
  ReviewCommit,
  SavedCaseYamlExport,
  SavedCaseYamlImport,
  SavedCaseArchiveInput,
  SavedCaseRestoreInput,
  SavedCaseDuplicateInput,
  SavedCaseListQuery,
  RegressionModuleCreate,
  RegressionModuleRecord,
  RegressionModuleRecordPage,
  RegressionModuleReviewCommit,
  RegressionModuleReviewPreview,
  RegressionModuleReviewPreviewInput,
  RegressionRunCreate,
  Schedule,
  ScheduleCreate,
  SchedulePage,
  SchedulePatch,
  ApiKey,
  ApiKeyCreate,
  ApiKeyCreated,
  ApiKeyPage,
  CacheStats,
  RepairProposal,
  RepairProposalCreate,
  RepairProposalPage,
} from './types.ts';

export class HttpApiClient implements ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = '/api/v1') {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    contractName?: ContractName,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = new Headers(options.headers);
    if (
      !headers.has('Content-Type') &&
      options.body &&
      typeof options.body === 'string'
    ) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });

    if (!res.ok) {
      const errorJson = (await res.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
      };
      const message =
        errorJson.message || `HTTP ${res.status} ${res.statusText}`;
      const err = new Error(message) as Error & {
        status: number;
        code?: string;
      };
      err.status = res.status;
      err.code = errorJson.code;
      throw err;
    }

    if (res.status === 204) {
      return undefined as unknown as T;
    }

    const data = await res.json();
    if (contractName) {
      return parseContract(contractName, data) as unknown as T;
    }
    return data as T;
  }

  private buildQuery(
    params?: Record<string, string | number | boolean | undefined | null>,
  ): string {
    if (!params) return '';
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        sp.set(k, String(v));
      }
    }
    const qs = sp.toString();
    return qs ? `?${qs}` : '';
  }

  private isSameIdentifier(a: string, b: string): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(a) && uuidRegex.test(b)) {
      return a.toLowerCase() === b.toLowerCase();
    }
    const legacyA =
      a === 'legacy-project-mock-001' ||
      (uuidRegex.test(a) &&
        a.toLowerCase() === '00000000-0000-4000-8000-000000000001');
    const legacyB =
      b === 'legacy-project-mock-001' ||
      (uuidRegex.test(b) &&
        b.toLowerCase() === '00000000-0000-4000-8000-000000000001');
    return legacyA && legacyB;
  }

  // 1. login
  public async login(input: LoginInput): Promise<LoginResult> {
    return this.request<LoginResult>(
      '/auth/login',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'LoginResult',
    );
  }

  // 2. logout
  public async logout(): Promise<void> {
    await this.request<void>('/auth/logout', { method: 'POST' });
  }

  // 3. currentUser
  public async currentUser(): Promise<User> {
    return this.request<User>('/auth/me', { method: 'GET' }, 'User');
  }

  // 4. listUsers
  public async listUsers(query?: PaginationQuery): Promise<UserPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<UserPage>(`/users${qs}`, { method: 'GET' }, 'UserPage');
  }

  // 5. createUser
  public async createUser(input: UserCreate): Promise<User> {
    return this.request<User>(
      '/users',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'User',
    );
  }

  // 6. updateUser
  public async updateUser(userId: string, input: UserPatch): Promise<User> {
    return this.request<User>(
      `/users/${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
      'User',
    );
  }

  // 7. listProjects
  public async listProjects(query?: PaginationQuery): Promise<ProjectPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<ProjectPage>(
      `/projects${qs}`,
      { method: 'GET' },
      'ProjectPage',
    );
  }

  // 8. createProject
  public async createProject(input: ProjectCreate): Promise<Project> {
    return this.request<Project>(
      '/projects',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'Project',
    );
  }

  // 9. getProject
  public async getProject(projectId: string): Promise<Project> {
    return this.request<Project>(
      `/projects/${encodeURIComponent(projectId)}`,
      { method: 'GET' },
      'Project',
    );
  }

  // 10. updateProject
  public async updateProject(
    projectId: string,
    input: ProjectPatch,
  ): Promise<Project> {
    return this.request<Project>(
      `/projects/${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
      'Project',
    );
  }

  // 11. listMembers
  public async listMembers(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<MemberPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<MemberPage>(
      `/projects/${encodeURIComponent(projectId)}/members${qs}`,
      { method: 'GET' },
      'MemberPage',
    );
  }

  // 12. replaceMembers
  public async replaceMembers(
    projectId: string,
    input: MemberUpdate,
  ): Promise<Project> {
    return this.request<Project>(
      `/projects/${encodeURIComponent(projectId)}/members`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
      'Project',
    );
  }

  // 13. listEnvironment
  public async listEnvironment(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<EnvironmentPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<EnvironmentPage>(
      `/projects/${encodeURIComponent(projectId)}/environments${qs}`,
      { method: 'GET' },
      'EnvironmentPage',
    );
  }

  public async listEnvironments(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<EnvironmentPage> {
    return this.listEnvironment(projectId, query);
  }

  // 14. createEnvironment
  public async createEnvironment(
    projectId: string,
    input: EnvironmentCreate,
  ): Promise<Environment> {
    return this.request<Environment>(
      `/projects/${encodeURIComponent(projectId)}/environments`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'Environment',
    );
  }

  // 15. getEnvironment
  public async getEnvironment(environmentId: string): Promise<Environment> {
    return this.request<Environment>(
      `/environments/${encodeURIComponent(environmentId)}`,
      { method: 'GET' },
      'Environment',
    );
  }

  // 16. updateEnvironment
  public async updateEnvironment(
    environmentId: string,
    input: EnvironmentPatch,
  ): Promise<Environment> {
    return this.request<Environment>(
      `/environments/${encodeURIComponent(environmentId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
      'Environment',
    );
  }

  // 17. listAuthProfile
  public async listAuthProfile(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<AuthProfilePage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<AuthProfilePage>(
      `/projects/${encodeURIComponent(projectId)}/auth-profiles${qs}`,
      { method: 'GET' },
      'AuthProfilePage',
    );
  }

  public async listAuthProfiles(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<AuthProfilePage> {
    return this.listAuthProfile(projectId, query);
  }

  // 18. createAuthProfile
  public async createAuthProfile(
    projectId: string,
    input: AuthProfileCreate,
  ): Promise<AuthProfile> {
    return this.request<AuthProfile>(
      `/projects/${encodeURIComponent(projectId)}/auth-profiles`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'AuthProfile',
    );
  }

  // 19. updateAuthProfile
  public async updateAuthProfile(
    authProfileId: string,
    input: AuthProfilePatch,
  ): Promise<AuthProfile> {
    return this.request<AuthProfile>(
      `/auth-profiles/${encodeURIComponent(authProfileId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
      'AuthProfile',
    );
  }

  // 20. listKnowledge
  public async listKnowledge(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<KnowledgePage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<KnowledgePage>(
      `/projects/${encodeURIComponent(projectId)}/knowledge${qs}`,
      { method: 'GET' },
      'KnowledgePage',
    );
  }

  // 21. createKnowledge
  public async createKnowledge(
    projectId: string,
    input: KnowledgeCreate,
  ): Promise<Knowledge> {
    return this.request<Knowledge>(
      `/projects/${encodeURIComponent(projectId)}/knowledge`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'Knowledge',
    );
  }

  // 22. updateKnowledge
  public async updateKnowledge(
    knowledgeId: string,
    input: KnowledgePatch,
  ): Promise<Knowledge> {
    return this.request<Knowledge>(
      `/knowledge/${encodeURIComponent(knowledgeId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
      'Knowledge',
    );
  }

  // 23. listModels
  public async listModels(query?: PaginationQuery): Promise<ModelProfilePage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<ModelProfilePage>(
      `/model-profiles${qs}`,
      { method: 'GET' },
      'ModelProfilePage',
    );
  }

  // 24. createModel
  public async createModel(input: ModelProfileCreate): Promise<ModelProfile> {
    return this.request<ModelProfile>(
      '/model-profiles',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'ModelProfile',
    );
  }

  // 25. getModel
  public async getModel(modelProfileId: string): Promise<ModelProfile> {
    return this.request<ModelProfile>(
      `/model-profiles/${encodeURIComponent(modelProfileId)}`,
      { method: 'GET' },
      'ModelProfile',
    );
  }

  // 26. updateModel
  public async updateModel(
    modelProfileId: string,
    input: ModelProfilePatch,
  ): Promise<ModelProfile> {
    return this.request<ModelProfile>(
      `/model-profiles/${encodeURIComponent(modelProfileId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
      'ModelProfile',
    );
  }

  // 27. probeModel
  public async probeModel(modelProfileId: string): Promise<ModelProbeResult> {
    return this.request<ModelProbeResult>(
      `/model-profiles/${encodeURIComponent(modelProfileId)}/probe`,
      { method: 'POST' },
      'ModelProbeResult',
    );
  }

  // 28. createRun
  public async createRun(input: CreateRunInput | RunCreate): Promise<Run> {
    const payload: RunCreate = {
      projectId: input.projectId,
      targetUrl: input.targetUrl,
      mode: input.mode || 'smoke',
    };
    const brief =
      ('brief' in input ? input.brief : undefined) ??
      ('description' in input ? input.description : undefined);
    if (brief && brief.trim()) {
      payload.brief = brief.trim();
    }
    if (input.environmentId) payload.environmentId = input.environmentId;
    if (input.authProfileId) payload.authProfileId = input.authProfileId;
    const budget =
      ('budget' in input ? input.budget : undefined) ??
      ('budgetOverrides' in input ? input.budgetOverrides : undefined);
    if (budget && Object.keys(budget).length > 0) {
      payload.budget = budget;
    }

    const idempotencyKey =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `idemp_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return this.request<Run>(
      '/runs',
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      },
      'Run',
    );
  }

  // 29. listRuns
  public async listRuns(
    projectIdOrQuery: string | ListRunsQuery,
  ): Promise<RunPage> {
    const query =
      typeof projectIdOrQuery === 'string'
        ? { projectId: projectIdOrQuery }
        : projectIdOrQuery;
    const qs = this.buildQuery(
      query as unknown as Record<string, string | number>,
    );
    return this.request<RunPage>(`/runs${qs}`, { method: 'GET' }, 'RunPage');
  }

  // 30. getRun
  public async getRun(runId: string): Promise<Run> {
    return this.request<Run>(
      `/runs/${encodeURIComponent(runId)}`,
      { method: 'GET' },
      'Run',
    );
  }

  // 31. cancelRun
  public async cancelRun(runId: string): Promise<Run> {
    return this.request<Run>(
      `/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
      'Run',
    );
  }

  // 32. sendRunMessage
  public async sendRunMessage(
    runId: string,
    messageOrInput: string | MessageInput,
    expectedContextVersion = 1,
  ): Promise<Run> {
    const payload: MessageInput =
      typeof messageOrInput === 'string'
        ? { text: messageOrInput, expectedContextVersion }
        : messageOrInput;

    return this.request<Run>(
      `/runs/${encodeURIComponent(runId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      'Run',
    );
  }

  // listRunMessages
  public async listRunMessages(
    runId: string,
    query?: PaginationQuery,
  ): Promise<RunMessagePage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<RunMessagePage>(
      `/runs/${encodeURIComponent(runId)}/messages${qs}`,
      { method: 'GET' },
      'RunMessagePage',
    );
  }

  // 33. respondToInput
  public async respondToInput(
    runId: string,
    inputId: string,
    response: InputResponse,
  ): Promise<InputRequest> {
    return this.request<InputRequest>(
      `/runs/${encodeURIComponent(runId)}/inputs/${encodeURIComponent(inputId)}/respond`,
      {
        method: 'POST',
        body: JSON.stringify(response),
      },
      'InputRequest',
    );
  }

  // 34. streamEvents
  public streamEvents(runId: string, _lastEventId?: string): EventSource {
    const url = `${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`;
    return new EventSource(url, { withCredentials: true });
  }

  // 35. listRunCases
  public async listRunCases(
    runId: string,
    query?: PaginationQuery,
  ): Promise<CaseRecordPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<CaseRecordPage>(
      `/runs/${encodeURIComponent(runId)}/cases${qs}`,
      { method: 'GET' },
      'CaseRecordPage',
    );
  }

  // 36. listRunTasks
  public async listRunTasks(
    runId: string,
    query?: PaginationQuery,
  ): Promise<TaskPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<TaskPage>(
      `/runs/${encodeURIComponent(runId)}/tasks${qs}`,
      { method: 'GET' },
      'TaskPage',
    );
  }

  // 37. listRunFindings
  public async listRunFindings(
    runId: string,
    query?: PaginationQuery,
  ): Promise<FindingPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<FindingPage>(
      `/runs/${encodeURIComponent(runId)}/findings${qs}`,
      { method: 'GET' },
      'FindingPage',
    );
  }

  // 38. getCase
  public async getCase(caseId: string): Promise<CaseRecord> {
    return this.request<CaseRecord>(
      `/cases/${encodeURIComponent(caseId)}`,
      { method: 'GET' },
      'CaseRecord',
    );
  }

  // 39. listCaseAttempts
  public async listCaseAttempts(
    caseId: string,
    query?: PaginationQuery,
  ): Promise<CaseAttemptPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<CaseAttemptPage>(
      `/cases/${encodeURIComponent(caseId)}/attempts${qs}`,
      { method: 'GET' },
      'CaseAttemptPage',
    );
  }

  // 40. listTaskSteps
  public async listTaskSteps(
    taskId: string,
    query?: PaginationQuery,
  ): Promise<StepPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<StepPage>(
      `/tasks/${encodeURIComponent(taskId)}/steps${qs}`,
      { method: 'GET' },
      'StepPage',
    );
  }

  // 41. getStep
  public async getStep(stepId: string): Promise<Step> {
    return this.request<Step>(
      `/steps/${encodeURIComponent(stepId)}`,
      { method: 'GET' },
      'Step',
    );
  }

  // 42. listEventHistory
  public async listEventHistory(
    runId: string,
    query?: ListEventHistoryQuery,
  ): Promise<RunEventPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<RunEventPage>(
      `/runs/${encodeURIComponent(runId)}/event-history${qs}`,
      { method: 'GET' },
      'RunEventPage',
    );
  }

  // 43. getFinding
  public async getFinding(findingId: string): Promise<Finding> {
    return this.request<Finding>(
      `/findings/${encodeURIComponent(findingId)}`,
      { method: 'GET' },
      'Finding',
    );
  }

  // 44. previewTriage
  public async previewTriage(
    findingId: string,
    dispositionOrInput:
      | TriageInput
      | 'accepted'
      | 'duplicate'
      | 'works_as_intended'
      | 'cannot_reproduce'
      | 'closed',
    reason = '',
    expectedVersion = 1,
  ): Promise<TriagePreview> {
    const payload: TriageInput =
      typeof dispositionOrInput === 'object'
        ? dispositionOrInput
        : {
            disposition: dispositionOrInput,
            reason,
            expectedVersion,
          };

    return this.request<TriagePreview>(
      `/findings/${encodeURIComponent(findingId)}/triage-preview`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      'TriagePreview',
    );
  }

  // 45. commitTriage
  public async commitTriage(
    findingId: string,
    input: TriageCommit,
  ): Promise<Finding> {
    return this.request<Finding>(
      `/findings/${encodeURIComponent(findingId)}/triage`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'Finding',
    );
  }

  // 46. getReport
  public async getReport(runId: string): Promise<Report> {
    return this.request<Report>(
      `/runs/${encodeURIComponent(runId)}/report`,
      { method: 'GET' },
      'Report',
    );
  }

  // 47. createExport
  public async createExport(
    runId: string,
    formatOrInput: 'json' | 'markdown' | 'zip' | ExportInput,
  ): Promise<Export> {
    const payload: ExportInput =
      typeof formatOrInput === 'string'
        ? { format: formatOrInput }
        : formatOrInput;

    return this.request<Export>(
      `/runs/${encodeURIComponent(runId)}/exports`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      'Export',
    );
  }

  // 48. getExport
  public async getExport(exportId: string): Promise<Export> {
    return this.request<Export>(
      `/exports/${encodeURIComponent(exportId)}`,
      { method: 'GET' },
      'Export',
    );
  }

  // 49. downloadArtifact
  public async downloadArtifact(artifactId: string): Promise<Blob> {
    const url = `${this.baseUrl}/artifacts/${encodeURIComponent(artifactId)}/content`;
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
    });
    if (!res.ok) {
      const errorJson = (await res.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
      };
      const err = new Error(
        errorJson.message || `HTTP ${res.status} ${res.statusText}`,
      ) as Error & { status: number; code?: string };
      err.status = res.status;
      err.code = errorJson.code;
      throw err;
    }
    return res.blob();
  }

  // 50. getArtifact
  public async getArtifact(artifactId: string): Promise<Artifact> {
    return this.request<Artifact>(
      `/artifacts/${encodeURIComponent(artifactId)}`,
      { method: 'GET' },
      'Artifact',
    );
  }

  // 51. healthLive
  public async healthLive(): Promise<Health> {
    return this.request<Health>('/health/live', { method: 'GET' }, 'Health');
  }

  // 52. healthReady
  public async healthReady(): Promise<Health> {
    return this.request<Health>('/health/ready', { method: 'GET' }, 'Health');
  }

  // 53. listSavedCases
  public async listSavedCases(
    projectId: string,
    query?: SavedCaseListQuery,
  ): Promise<SavedCasePage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    const res = await this.request<SavedCasePage>(
      `/projects/${encodeURIComponent(projectId)}/saved-cases${qs}`,
      { method: 'GET' },
      'SavedCasePage',
    );
    for (const item of res.items) {
      if (!this.isSameIdentifier(item.projectId, projectId)) {
        throw new Error(
          `Item project mismatch: expected ${projectId}, got ${item.projectId}`,
        );
      }
      if (
        query?.status &&
        query.status !== 'all' &&
        item.status !== query.status
      ) {
        throw new Error(
          `Item status mismatch: expected ${query.status}, got ${item.status}`,
        );
      }
    }
    return res;
  }

  // 54. createSavedCase
  public async createSavedCase(
    projectId: string,
    input: SavedCaseCreate,
  ): Promise<SavedCase> {
    return this.request<SavedCase>(
      `/projects/${encodeURIComponent(projectId)}/saved-cases`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'SavedCase',
    );
  }

  // 55. listSavedCaseVersions
  public async listSavedCaseVersions(
    caseId: string,
    query?: PaginationQuery,
  ): Promise<SavedCaseVersionPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<SavedCaseVersionPage>(
      `/saved-cases/${encodeURIComponent(caseId)}/versions${qs}`,
      { method: 'GET' },
      'SavedCaseVersionPage',
    );
  }

  // 56. createSavedCaseVersion
  public async createSavedCaseVersion(
    caseId: string,
    input: SavedCaseVersionCreate,
  ): Promise<SavedCaseVersion> {
    return this.request<SavedCaseVersion>(
      `/saved-cases/${encodeURIComponent(caseId)}/versions`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'SavedCaseVersion',
    );
  }

  // 57. previewSavedCaseReview
  public async previewSavedCaseReview(
    versionId: string,
    input: ReviewPreviewInput,
  ): Promise<ReviewPreview> {
    return this.request<ReviewPreview>(
      `/saved-case-versions/${encodeURIComponent(versionId)}/review-preview`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'ReviewPreview',
    );
  }

  // 58. commitSavedCaseReview
  public async commitSavedCaseReview(
    versionId: string,
    input: ReviewCommit,
  ): Promise<SavedCaseVersion> {
    return this.request<SavedCaseVersion>(
      `/saved-case-versions/${encodeURIComponent(versionId)}/review`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'SavedCaseVersion',
    );
  }

  // 58b. importSavedCaseYaml
  public async importSavedCaseYaml(
    projectId: string,
    input: SavedCaseYamlImport,
  ): Promise<SavedCase> {
    return this.request<SavedCase>(
      `/projects/${encodeURIComponent(projectId)}/saved-cases/import`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'SavedCase',
    );
  }

  // 58c. exportSavedCaseYaml
  public async exportSavedCaseYaml(
    versionId: string,
  ): Promise<SavedCaseYamlExport> {
    const res = await this.request<SavedCaseYamlExport>(
      `/saved-case-versions/${encodeURIComponent(versionId)}/yaml`,
      { method: 'GET' },
      'SavedCaseYamlExport',
    );
    if (!this.isSameIdentifier(res.versionId, versionId)) {
      throw new Error(
        `Exported version mismatch: expected ${versionId}, got ${res.versionId}`,
      );
    }
    return res;
  }

  // archiveSavedCase
  public async archiveSavedCase(
    caseId: string,
    input: SavedCaseArchiveInput,
  ): Promise<SavedCase> {
    if (
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      input.expectedVersion > 2147483647
    ) {
      throw new Error(
        `expectedVersion must be an integer between 1 and 2147483647, got ${input.expectedVersion}`,
      );
    }
    const res = await this.request<SavedCase>(
      `/saved-cases/${encodeURIComponent(caseId)}/archive`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'SavedCase',
    );
    if (!this.isSameIdentifier(res.id, caseId)) {
      throw new Error(
        `Archived case ID mismatch: expected ${caseId}, got ${res.id}`,
      );
    }
    if (res.status !== 'archived') {
      throw new Error(
        `Archived case status mismatch: expected archived, got ${res.status}`,
      );
    }
    if (res.version !== input.expectedVersion + 1) {
      throw new Error(
        `Archived case version must be exactly expectedVersion + 1, got ${res.version} (expected ${input.expectedVersion + 1})`,
      );
    }
    return res;
  }

  // restoreSavedCase
  public async restoreSavedCase(
    caseId: string,
    input: SavedCaseRestoreInput,
  ): Promise<SavedCase> {
    if (
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      input.expectedVersion > 2147483647
    ) {
      throw new Error(
        `expectedVersion must be an integer between 1 and 2147483647, got ${input.expectedVersion}`,
      );
    }
    const res = await this.request<SavedCase>(
      `/saved-cases/${encodeURIComponent(caseId)}/restore`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'SavedCase',
    );
    if (!this.isSameIdentifier(res.id, caseId)) {
      throw new Error(
        `Restored case ID mismatch: expected ${caseId}, got ${res.id}`,
      );
    }
    if (res.status !== 'active') {
      throw new Error(
        `Restored case status mismatch: expected active, got ${res.status}`,
      );
    }
    if (res.version !== input.expectedVersion + 1) {
      throw new Error(
        `Restored case version must be exactly expectedVersion + 1, got ${res.version} (expected ${input.expectedVersion + 1})`,
      );
    }
    return res;
  }

  // duplicateSavedCase
  public async duplicateSavedCase(
    caseId: string,
    input: SavedCaseDuplicateInput,
  ): Promise<SavedCase> {
    if (!input.newSlug || !/^[a-zA-Z0-9_.-]+$/.test(input.newSlug)) {
      throw new Error(
        `newSlug must match pattern ^[a-zA-Z0-9_.-]+$, got ${input.newSlug}`,
      );
    }
    if (!input.newName || input.newName.trim().length === 0) {
      throw new Error('newName must not be empty');
    }
    if (!input.sourceVersionId) {
      throw new Error('sourceVersionId is required');
    }
    const res = await this.request<SavedCase>(
      `/saved-cases/${encodeURIComponent(caseId)}/duplicate`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'SavedCase',
    );
    if (this.isSameIdentifier(res.id, caseId)) {
      throw new Error(
        `Duplicated case ID must be distinct from source case ID ${caseId}`,
      );
    }
    if (
      input.targetProjectId &&
      !this.isSameIdentifier(res.projectId, input.targetProjectId)
    ) {
      throw new Error(
        `Duplicated case project ID mismatch: expected ${input.targetProjectId}, got ${res.projectId}`,
      );
    }
    if (res.slug !== input.newSlug) {
      throw new Error(
        `Duplicated case slug mismatch: expected ${input.newSlug}, got ${res.slug}`,
      );
    }
    if (res.name !== input.newName) {
      throw new Error(
        `Duplicated case name mismatch: expected ${input.newName}, got ${res.name}`,
      );
    }
    if (res.status !== 'active') {
      throw new Error(
        `Duplicated case initial status must be active, got ${res.status}`,
      );
    }
    if (res.version !== 1) {
      throw new Error(
        `Duplicated case initial version must be 1, got ${res.version}`,
      );
    }
    if (res.currentApprovedVersionId !== null) {
      throw new Error(
        'Duplicated case must start in draft status without approved version',
      );
    }
    return res;
  }

  // 59. createRegressionRun
  public async createRegressionRun(input: RegressionRunCreate): Promise<Run> {
    const idempotencyKey =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `idemp_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return this.request<Run>(
      '/regression-runs',
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(input),
      },
      'Run',
    );
  }

  // 60. listSchedules
  public async listSchedules(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<SchedulePage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<SchedulePage>(
      `/projects/${encodeURIComponent(projectId)}/schedules${qs}`,
      { method: 'GET' },
      'SchedulePage',
    );
  }

  // 61. createSchedule
  public async createSchedule(
    projectId: string,
    input: ScheduleCreate,
  ): Promise<Schedule> {
    return this.request<Schedule>(
      `/projects/${encodeURIComponent(projectId)}/schedules`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'Schedule',
    );
  }

  // 62. updateSchedule
  public async updateSchedule(
    scheduleId: string,
    input: SchedulePatch,
  ): Promise<Schedule> {
    return this.request<Schedule>(
      `/schedules/${encodeURIComponent(scheduleId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
      'Schedule',
    );
  }

  // 63. runScheduleNow
  public async runScheduleNow(scheduleId: string): Promise<Run> {
    return this.request<Run>(
      `/schedules/${encodeURIComponent(scheduleId)}/run-now`,
      { method: 'POST' },
      'Run',
    );
  }

  // 64. listApiKeys
  public async listApiKeys(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<ApiKeyPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<ApiKeyPage>(
      `/projects/${encodeURIComponent(projectId)}/api-keys${qs}`,
      { method: 'GET' },
      'ApiKeyPage',
    );
  }

  // 65. createApiKey
  public async createApiKey(
    projectId: string,
    input: ApiKeyCreate,
  ): Promise<ApiKeyCreated> {
    return this.request<ApiKeyCreated>(
      `/projects/${encodeURIComponent(projectId)}/api-keys`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'ApiKeyCreated',
    );
  }

  // 66. revokeApiKey
  public async revokeApiKey(keyId: string): Promise<ApiKey> {
    return this.request<ApiKey>(
      `/api-keys/${encodeURIComponent(keyId)}/revoke`,
      { method: 'POST' },
      'ApiKey',
    );
  }

  // 67. getCacheStats
  public async getCacheStats(runId: string): Promise<CacheStats> {
    return this.request<CacheStats>(
      `/runs/${encodeURIComponent(runId)}/cache-stats`,
      { method: 'GET' },
      'CacheStats',
    );
  }

  // 68. listRepairProposals
  public async listRepairProposals(
    caseId: string,
    query?: PaginationQuery,
  ): Promise<RepairProposalPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<RepairProposalPage>(
      `/saved-cases/${encodeURIComponent(caseId)}/repair-proposals${qs}`,
      { method: 'GET' },
      'RepairProposalPage',
    );
  }

  // 69. createRepairProposal
  public async createRepairProposal(
    caseId: string,
    input: RepairProposalCreate,
  ): Promise<RepairProposal> {
    return this.request<RepairProposal>(
      `/saved-cases/${encodeURIComponent(caseId)}/repair-proposals`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'RepairProposal',
    );
  }

  // 70. createRegressionModule
  public async createRegressionModule(
    projectId: string,
    input: RegressionModuleCreate,
  ): Promise<RegressionModuleRecord> {
    const res = await this.request<RegressionModuleRecord>(
      `/projects/${encodeURIComponent(projectId)}/regression-modules`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'RegressionModuleRecord',
    );
    if (
      !this.isSameIdentifier(res.projectId, projectId) ||
      res.name !== input.name
    ) {
      throw new Error(
        `Created module mismatch: expected ${projectId}/${input.name}, got ${res.projectId}/${res.name}`,
      );
    }
    return res;
  }

  // 71. listRegressionModules
  public async listRegressionModules(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<RegressionModuleRecordPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<RegressionModuleRecordPage>(
      `/projects/${encodeURIComponent(projectId)}/regression-modules${qs}`,
      { method: 'GET' },
      'RegressionModuleRecordPage',
    );
  }

  // 72. listRegressionModuleVersions
  public async listRegressionModuleVersions(
    projectId: string,
    moduleName: string,
    query?: PaginationQuery,
  ): Promise<RegressionModuleRecordPage> {
    const qs = this.buildQuery(query as Record<string, string | number>);
    return this.request<RegressionModuleRecordPage>(
      `/projects/${encodeURIComponent(projectId)}/regression-modules/${encodeURIComponent(moduleName)}/versions${qs}`,
      { method: 'GET' },
      'RegressionModuleRecordPage',
    );
  }

  // 73. previewRegressionModuleReview
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
    const res = await this.request<RegressionModuleReviewPreview>(
      `/projects/${encodeURIComponent(projectId)}/regression-modules/${encodeURIComponent(moduleName)}/versions/${encodeURIComponent(String(version))}/review-preview`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'RegressionModuleReviewPreview',
    );
    if (
      !this.isSameIdentifier(res.projectId, projectId) ||
      res.moduleName !== moduleName ||
      res.version !== version
    ) {
      throw new Error(
        `Preview response target mismatch: expected ${projectId}/${moduleName}@v${version}, got ${res.projectId}/${res.moduleName}@v${res.version}`,
      );
    }
    if (res.decision !== input.decision || res.reason !== input.reason) {
      throw new Error(
        `Preview response review criteria mismatch: expected decision=${input.decision}, reason=${input.reason}, got decision=${res.decision}, reason=${res.reason}`,
      );
    }
    return res;
  }

  // 74. reviewRegressionModuleVersion
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
    const res = await this.request<RegressionModuleRecord>(
      `/projects/${encodeURIComponent(projectId)}/regression-modules/${encodeURIComponent(moduleName)}/versions/${encodeURIComponent(String(version))}/review`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      'RegressionModuleRecord',
    );
    if (
      !this.isSameIdentifier(res.projectId, projectId) ||
      res.name !== moduleName ||
      res.version !== version
    ) {
      throw new Error(
        `Reviewed module mismatch: expected ${projectId}/${moduleName}@v${version}, got ${res.projectId}/${res.name}@v${res.version}`,
      );
    }
    const expectedStatus =
      input.decision === 'approve' ? 'approved' : 'rejected';
    if (res.reviewStatus !== expectedStatus) {
      throw new Error(
        `Reviewed module status mismatch: expected ${expectedStatus}, got ${res.reviewStatus}`,
      );
    }
    return res;
  }
}
