/* Generated from docs/contracts/openapi.json by scripts/generateClient.mjs. DO NOT EDIT DIRECTLY. */

import type {
  User,
  UserCreate,
  UserPatch,
  UserPage,
  Project,
  ProjectCreate,
  ProjectPatch,
  ProjectDeleteConfirm,
  ProjectDeletionPreview,
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
  ModelDeleteConfirm,
  RunDeleteConfirm,
  ConfigDeleteConfirm,
  ModelProfilePage,
  ModelProbeResult,
  Run,
  RunCreate,
  RunPage,
  RunConfig,
  BudgetOverrides,
  MessageInput,
  InputRequest,
  InputRequestPage,
  FollowUpInput,
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
  SavedCaseYamlExport,
  SavedCaseYamlImport,
  SavedCaseArchiveInput,
  SavedCaseRestoreInput,
  SavedCaseDuplicateInput,
  RegressionModuleCreate,
  RegressionModuleRecord,
  RegressionModuleRecordPage,
  RegressionModuleReviewCommit,
  RegressionModuleReviewPreview,
  RegressionModuleReviewPreviewInput,
  RegressionModuleVersion,
} from '@localqa/contracts';

import type {
  SavedCase,
  SavedCaseCreate,
  SavedCasePage,
  SavedCaseVersion,
  SavedCaseVersionCreate,
  SavedCaseVersionPage,
  ReviewPreview,
  ReviewPreviewInput,
  ReviewCommit,
  RegressionRunCreate,
  RegressionDocument,
  Criterion,
  ReplayStep,
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
  RepairCandidateEvidence,
  RepairCandidateEvidencePage,
  RepairProposalPage,
  RepairSuggestionRecord,
} from '../../../../packages/contracts/src/generated/types.ts';

export type {
  User,
  UserCreate,
  UserPatch,
  UserPage,
  Project,
  ProjectCreate,
  ProjectPatch,
  ProjectDeleteConfirm,
  ProjectDeletionPreview,
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
  ModelDeleteConfirm,
  RunDeleteConfirm,
  ConfigDeleteConfirm,
  ModelProfilePage,
  ModelProbeResult,
  Run,
  RunCreate,
  RunPage,
  RunConfig,
  BudgetOverrides,
  MessageInput,
  InputRequest,
  InputRequestPage,
  FollowUpInput,
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
  LoginInput,
  LoginResult,
  RunMessage,
  RunMessagePage,
  SavedCaseYamlExport,
  SavedCaseYamlImport,
  SavedCaseArchiveInput,
  SavedCaseRestoreInput,
  SavedCaseDuplicateInput,
  RegressionModuleCreate,
  RegressionModuleRecord,
  RegressionModuleRecordPage,
  RegressionModuleReviewCommit,
  RegressionModuleReviewPreview,
  RegressionModuleReviewPreviewInput,
  RegressionModuleVersion,
  SavedCase,
  SavedCaseCreate,
  SavedCasePage,
  SavedCaseVersion,
  SavedCaseVersionCreate,
  SavedCaseVersionPage,
  ReviewPreview,
  ReviewPreviewInput,
  ReviewCommit,
  RegressionRunCreate,
  RegressionDocument,
  Criterion,
  ReplayStep,
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
  RepairCandidateEvidence,
  RepairCandidateEvidencePage,
  RepairProposalPage,
  RepairSuggestionRecord,
};

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
  | 'deleteProject'
  | 'getProjectDeletionPreview'
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
  | 'deleteEnvironment'
  | 'updateAuthProfile'
  | 'deleteAuthProfile'
  | 'updateKnowledge'
  | 'listModels'
  | 'createModel'
  | 'getModel'
  | 'updateModel'
  | 'deleteModel'
  | 'probeModel'
  | 'listProjectModels'
  | 'grantProjectModel'
  | 'createRun'
  | 'listRuns'
  | 'getRun'
  | 'deleteRun'
  | 'cancelRun'
  | 'sendRunMessage'
  | 'listRunMessages'
  | 'listRunInputs'
  | 'continueRun'
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
  | 'listSavedCases'
  | 'createSavedCase'
  | 'archiveSavedCase'
  | 'restoreSavedCase'
  | 'duplicateSavedCase'
  | 'importSavedCaseYaml'
  | 'exportSavedCaseYaml'
  | 'createRegressionModule'
  | 'listRegressionModules'
  | 'listRegressionModuleVersions'
  | 'previewRegressionModuleReview'
  | 'reviewRegressionModuleVersion'
  | 'listSavedCaseVersions'
  | 'createSavedCaseVersion'
  | 'previewSavedCaseReview'
  | 'commitSavedCaseReview'
  | 'createRegressionRun'
  | 'listSchedules'
  | 'createSchedule'
  | 'updateSchedule'
  | 'runScheduleNow'
  | 'listScheduleOccurrences'
  | 'listApiKeys'
  | 'createApiKey'
  | 'revokeApiKey'
  | 'getCacheStats'
  | 'listRepairProposals'
  | 'createRepairProposal'
  | 'reviewRepairProposal'
  | 'createRepairCandidateDraft'
  | 'getRepairCandidateDraft'
  | 'startRepairCandidateVerification'
  | 'listRepairCandidateVerifications'
  | 'listRepairCandidateEvidence'
  | 'getRepairCandidateScreenshot'
  | 'healthLive'
  | 'healthReady';

export interface PaginationQuery {
  cursor?: string;
  limit?: number;
}

export interface SavedCaseListQuery extends PaginationQuery {
  status?: 'active' | 'archived' | 'all';
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
  taskIntent?: RunConfig['taskIntent'];
  actionPolicy?: RunConfig['actionPolicy'];
  writeScope?: string[];
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
  getProjectDeletionPreview(projectId: string): Promise<ProjectDeletionPreview>;
  deleteProject(projectId: string, input: ProjectDeleteConfirm): Promise<void>;
  listMembers(projectId: string, query?: PaginationQuery): Promise<MemberPage>;
  replaceMembers(projectId: string, input: MemberUpdate): Promise<Project>;

  // Environments & Auth Profiles
  listEnvironment(projectId: string, query?: PaginationQuery): Promise<EnvironmentPage>;
  listEnvironments(projectId: string, query?: PaginationQuery): Promise<EnvironmentPage>;
  createEnvironment(projectId: string, input: EnvironmentCreate): Promise<Environment>;
  getEnvironment(environmentId: string): Promise<Environment>;
  updateEnvironment(environmentId: string, input: EnvironmentPatch): Promise<Environment>;
  deleteEnvironment(environmentId: string, input: ConfigDeleteConfirm): Promise<void>;
  listAuthProfile(projectId: string, query?: PaginationQuery): Promise<AuthProfilePage>;
  listAuthProfiles(projectId: string, query?: PaginationQuery): Promise<AuthProfilePage>;
  createAuthProfile(projectId: string, input: AuthProfileCreate): Promise<AuthProfile>;
  updateAuthProfile(authProfileId: string, input: AuthProfilePatch): Promise<AuthProfile>;
  deleteAuthProfile(authProfileId: string, input: ConfigDeleteConfirm): Promise<void>;

  // Knowledge & Models
  listKnowledge(projectId: string, query?: PaginationQuery): Promise<KnowledgePage>;
  createKnowledge(projectId: string, input: KnowledgeCreate): Promise<Knowledge>;
  updateKnowledge(knowledgeId: string, input: KnowledgePatch): Promise<Knowledge>;
  listModels(query?: PaginationQuery): Promise<ModelProfilePage>;
  listProjectModels(projectId: string, query?: PaginationQuery): Promise<ModelProfilePage>;
  grantProjectModel(projectId: string, input: { modelProfileId: string }): Promise<ModelProfile>;
  createModel(input: ModelProfileCreate): Promise<ModelProfile>;
  getModel(modelProfileId: string): Promise<ModelProfile>;
  updateModel(modelProfileId: string, input: ModelProfilePatch): Promise<ModelProfile>;
  deleteModel(modelProfileId: string, input: ModelDeleteConfirm): Promise<void>;
  probeModel(modelProfileId: string): Promise<ModelProbeResult>;

  // Runs & Execution
  createRun(input: CreateRunInput | RunCreate): Promise<Run>;
  listRuns(projectIdOrQuery: string | ListRunsQuery): Promise<RunPage>;
  getRun(runId: string): Promise<Run>;
  cancelRun(runId: string): Promise<Run>;
  deleteRun(runId: string, input: RunDeleteConfirm): Promise<void>;
  sendRunMessage(
    runId: string,
    messageOrInput: string | MessageInput,
    expectedContextVersion?: number,
  ): Promise<Run>;
  listRunMessages(
    runId: string,
    query?: PaginationQuery,
  ): Promise<RunMessagePage>;
  listRunInputs(runId: string): Promise<InputRequestPage>;
  continueRun(runId: string, input: FollowUpInput): Promise<Run>;
  respondToInput(
    runId: string,
    inputId: string,
    response: InputResponse,
  ): Promise<InputRequest>;
  streamEvents(runId: string, lastEventId?: string): EventSource;

  // Work Breakdown, Cases, Tasks, Steps & Events
  listRunCases(runId: string, query?: PaginationQuery): Promise<CaseRecordPage>;
  getCase(caseId: string): Promise<CaseRecord>;
  listCaseAttempts(caseId: string, query?: PaginationQuery): Promise<CaseAttemptPage>;
  listRunTasks(runId: string, query?: PaginationQuery): Promise<TaskPage>;
  listTaskSteps(taskId: string, query?: PaginationQuery): Promise<StepPage>;
  getStep(stepId: string): Promise<Step>;
  listEventHistory(runId: string, query?: ListEventHistoryQuery): Promise<RunEventPage>;

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

  // Saved Cases (Case Library & Versioning)
  listSavedCases(projectId: string, query?: SavedCaseListQuery): Promise<SavedCasePage>;
  createSavedCase(projectId: string, input: SavedCaseCreate): Promise<SavedCase>;
  listSavedCaseVersions(caseId: string, query?: PaginationQuery): Promise<SavedCaseVersionPage>;
  createSavedCaseVersion(caseId: string, input: SavedCaseVersionCreate): Promise<SavedCaseVersion>;
  previewSavedCaseReview(versionId: string, input: ReviewPreviewInput): Promise<ReviewPreview>;
  commitSavedCaseReview(versionId: string, input: ReviewCommit): Promise<SavedCaseVersion>;
  importSavedCaseYaml(projectId: string, input: SavedCaseYamlImport): Promise<SavedCase>;
  exportSavedCaseYaml(versionId: string): Promise<SavedCaseYamlExport>;
  archiveSavedCase(caseId: string, input: SavedCaseArchiveInput): Promise<SavedCase>;
  restoreSavedCase(caseId: string, input: SavedCaseRestoreInput): Promise<SavedCase>;
  duplicateSavedCase(caseId: string, input: SavedCaseDuplicateInput): Promise<SavedCase>;

  // Regression Runs
  createRegressionRun(input: RegressionRunCreate): Promise<Run>;

  // Schedules
  listSchedules(projectId: string, query?: PaginationQuery): Promise<SchedulePage>;
  createSchedule(projectId: string, input: ScheduleCreate): Promise<Schedule>;
  updateSchedule(scheduleId: string, input: SchedulePatch): Promise<Schedule>;
  runScheduleNow(scheduleId: string): Promise<Run>;
  listScheduleOccurrences(scheduleId: string, query?: PaginationQuery): Promise<ScheduleOccurrencePage>;

  // API Keys
  listApiKeys(projectId: string, query?: PaginationQuery): Promise<ApiKeyPage>;
  createApiKey(projectId: string, input: ApiKeyCreate): Promise<ApiKeyCreated>;
  revokeApiKey(keyId: string): Promise<ApiKey>;

  // Cache & Repair Proposals
  getCacheStats(runId: string): Promise<CacheStats>;
  listRepairProposals(caseId: string, query?: PaginationQuery): Promise<RepairProposalPage>;
  createRepairProposal(caseId: string, input: RepairProposalCreate): Promise<RepairProposal>;
  reviewRepairProposal(caseId: string, proposalId: string, input: RepairProposalReviewInput): Promise<RepairProposal>;
  createRepairCandidateDraft(caseId: string, proposalId: string, input: SavedCaseVersionCreate): Promise<SavedCaseVersion>;
  getRepairCandidateDraft(caseId: string, proposalId: string): Promise<SavedCaseVersion>;
  startRepairCandidateVerification(caseId: string, proposalId: string): Promise<RepairCandidateVerification>;
  listRepairCandidateVerifications(caseId: string, proposalId: string, query?: PaginationQuery): Promise<RepairCandidateVerificationPage>;
  listRepairCandidateEvidence(caseId: string, proposalId: string, verificationId: string): Promise<RepairCandidateEvidencePage>;

  // Regression Modules (Module Management & Two-Stage Review)
  createRegressionModule(projectId: string, input: RegressionModuleCreate): Promise<RegressionModuleRecord>;
  listRegressionModules(projectId: string, query?: PaginationQuery): Promise<RegressionModuleRecordPage>;
  listRegressionModuleVersions(projectId: string, moduleName: string, query?: PaginationQuery): Promise<RegressionModuleRecordPage>;
  previewRegressionModuleReview(projectId: string, moduleName: string, version: number, input: RegressionModuleReviewPreviewInput): Promise<RegressionModuleReviewPreview>;
  reviewRegressionModuleVersion(projectId: string, moduleName: string, version: number, input: RegressionModuleReviewCommit): Promise<RegressionModuleRecord>;
}
