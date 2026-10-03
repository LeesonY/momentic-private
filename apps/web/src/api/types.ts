/* Generated from docs/contracts/openapi.json by scripts/generateClient.mjs. DO NOT EDIT DIRECTLY. */

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
  RunConfig,
  BudgetOverrides,
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
  RunMessage,
  RunMessagePage,
  LoginInput,
  LoginResult,
} from '@localqa/contracts';

export type { RunMessage, RunMessagePage };

export type PublicOperationName =
  | 'login'
  | 'logout'
  | 'currentUser'
  | 'listUsers'
  | 'createUser'
  | 'updateUser'
  | 'listProjects'
  | 'createProject'
  | 'getProject'
  | 'updateProject'
  | 'listMembers'
  | 'replaceMembers'
  | 'listEnvironment'
  | 'createEnvironment'
  | 'listAuthProfile'
  | 'createAuthProfile'
  | 'listKnowledge'
  | 'createKnowledge'
  | 'getEnvironment'
  | 'updateEnvironment'
  | 'updateAuthProfile'
  | 'updateKnowledge'
  | 'listModels'
  | 'createModel'
  | 'getModel'
  | 'updateModel'
  | 'probeModel'
  | 'createRun'
  | 'listRuns'
  | 'getRun'
  | 'cancelRun'
  | 'sendRunMessage'
  | 'listRunMessages'
  | 'respondToInput'
  | 'streamEvents'
  | 'listRunCases'
  | 'listRunTasks'
  | 'listRunFindings'
  | 'getCase'
  | 'listCaseAttempts'
  | 'listTaskSteps'
  | 'getStep'
  | 'listEventHistory'
  | 'getFinding'
  | 'previewTriage'
  | 'commitTriage'
  | 'getReport'
  | 'createExport'
  | 'getExport'
  | 'downloadArtifact'
  | 'getArtifact'
  | 'healthLive'
  | 'healthReady';

export interface PaginationQuery {
  cursor?: string;
  limit?: number;
}

export interface ListRunsQuery extends PaginationQuery {
  projectId: string;
  status?: string;
  environmentId?: string;
}

export interface ListEventHistoryQuery {
  afterSeq?: number;
  limit?: number;
}

export interface CreateRunInput {
  projectId: string;
  targetUrl: string;
  description?: string;
  brief?: string;
  environmentId?: string;
  authProfileId?: string;
  modelProfileId?: string;
  budgetOverrides?: BudgetOverrides;
  budget?: BudgetOverrides;
  mode?: 'smoke';
  config?: Partial<RunConfig>;
}

export interface ApiClient {
  // Auth & Current User
  login(input: LoginInput): Promise<LoginResult>;
  logout(): Promise<void>;
  currentUser(): Promise<User>;

  // Users
  listUsers(query?: PaginationQuery): Promise<UserPage>;
  createUser(input: UserCreate): Promise<User>;
  updateUser(userId: string, input: UserPatch): Promise<User>;

  // Projects & Members
  listProjects(query?: PaginationQuery): Promise<ProjectPage>;
  createProject(input: ProjectCreate): Promise<Project>;
  getProject(projectId: string): Promise<Project>;
  updateProject(projectId: string, input: ProjectPatch): Promise<Project>;
  listMembers(projectId: string, query?: PaginationQuery): Promise<MemberPage>;
  replaceMembers(projectId: string, input: MemberUpdate): Promise<Project>;

  // Environments & Auth Profiles
  listEnvironment(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<EnvironmentPage>;
  listEnvironments(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<EnvironmentPage>;
  createEnvironment(
    projectId: string,
    input: EnvironmentCreate,
  ): Promise<Environment>;
  getEnvironment(environmentId: string): Promise<Environment>;
  updateEnvironment(
    environmentId: string,
    input: EnvironmentPatch,
  ): Promise<Environment>;
  listAuthProfile(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<AuthProfilePage>;
  listAuthProfiles(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<AuthProfilePage>;
  createAuthProfile(
    projectId: string,
    input: AuthProfileCreate,
  ): Promise<AuthProfile>;
  updateAuthProfile(
    authProfileId: string,
    input: AuthProfilePatch,
  ): Promise<AuthProfile>;

  // Knowledge & Models
  listKnowledge(
    projectId: string,
    query?: PaginationQuery,
  ): Promise<KnowledgePage>;
  createKnowledge(
    projectId: string,
    input: KnowledgeCreate,
  ): Promise<Knowledge>;
  updateKnowledge(
    knowledgeId: string,
    input: KnowledgePatch,
  ): Promise<Knowledge>;
  listModels(query?: PaginationQuery): Promise<ModelProfilePage>;
  createModel(input: ModelProfileCreate): Promise<ModelProfile>;
  getModel(modelProfileId: string): Promise<ModelProfile>;
  updateModel(
    modelProfileId: string,
    input: ModelProfilePatch,
  ): Promise<ModelProfile>;
  probeModel(modelProfileId: string): Promise<ModelProbeResult>;

  // Runs & Execution
  createRun(input: CreateRunInput | RunCreate): Promise<Run>;
  listRuns(projectIdOrQuery: string | ListRunsQuery): Promise<RunPage>;
  getRun(runId: string): Promise<Run>;
  cancelRun(runId: string): Promise<Run>;
  sendRunMessage(
    runId: string,
    messageOrInput: string | MessageInput,
    expectedContextVersion?: number,
  ): Promise<Run>;
  listRunMessages(
    runId: string,
    query?: PaginationQuery,
  ): Promise<RunMessagePage>;
  respondToInput(
    runId: string,
    inputId: string,
    response: InputResponse,
  ): Promise<InputRequest>;
  streamEvents(runId: string, lastEventId?: string): EventSource;

  // Work Breakdown, Cases, Tasks, Steps & Events
  listRunCases(runId: string, query?: PaginationQuery): Promise<CaseRecordPage>;
  getCase(caseId: string): Promise<CaseRecord>;
  listCaseAttempts(
    caseId: string,
    query?: PaginationQuery,
  ): Promise<CaseAttemptPage>;
  listRunTasks(runId: string, query?: PaginationQuery): Promise<TaskPage>;
  listTaskSteps(taskId: string, query?: PaginationQuery): Promise<StepPage>;
  getStep(stepId: string): Promise<Step>;
  listEventHistory(
    runId: string,
    query?: ListEventHistoryQuery,
  ): Promise<RunEventPage>;

  // Findings & Triage
  listRunFindings(runId: string, query?: PaginationQuery): Promise<FindingPage>;
  getFinding(findingId: string): Promise<Finding>;
  previewTriage(
    findingId: string,
    dispositionOrInput:
      | TriageInput
      | 'accepted'
      | 'duplicate'
      | 'works_as_intended'
      | 'cannot_reproduce'
      | 'closed',
    reason?: string,
    expectedVersion?: number,
  ): Promise<TriagePreview>;
  commitTriage(findingId: string, input: TriageCommit): Promise<Finding>;

  // Reports, Exports, Artifacts & Health
  getReport(runId: string): Promise<Report>;
  createExport(
    runId: string,
    formatOrInput: 'json' | 'markdown' | 'zip' | ExportInput,
  ): Promise<Export>;
  getExport(exportId: string): Promise<Export>;
  downloadArtifact(artifactId: string): Promise<Blob>;
  getArtifact(artifactId: string): Promise<Artifact>;
  healthLive(): Promise<Health>;
  healthReady(): Promise<Health>;
}
