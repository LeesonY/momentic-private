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
  Export
} from '@localqa/contracts';

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
  | 'respondToInput'
  | 'listRunCases'
  | 'getCase'
  | 'listCaseAttempts'
  | 'listRunTasks'
  | 'listTaskSteps'
  | 'getStep'
  | 'listRunFindings'
  | 'getFinding'
  | 'previewTriage'
  | 'commitTriage'
  | 'getReport'
  | 'createExport'
  | 'getExport'
  | 'getArtifact'
  | 'healthLive'
  | 'healthReady';

export interface ApiClient {
  // Auth & User
  login(input: { email?: string; username?: string; password?: string }): Promise<{ token: string; user: User }>;
  logout(): Promise<void>;
  currentUser(): Promise<User>;
  listUsers(): Promise<{ items: User[] }>;

  // Projects & Members
  listProjects(): Promise<{ items: Project[] }>;
  getProject(projectId: string): Promise<Project>;
  createProject(input: { name: string }): Promise<Project>;
  updateProject(projectId: string, input: Partial<Project>): Promise<Project>;
  listMembers(projectId: string): Promise<{ items: Member[] }>;

  // Environments & Auth Profiles
  listEnvironments(projectId: string): Promise<{ items: Environment[] }>;
  createEnvironment(projectId: string, input: Partial<Environment>): Promise<Environment>;
  listAuthProfiles(projectId: string): Promise<{ items: AuthProfile[] }>;
  createAuthProfile(projectId: string, input: Partial<AuthProfile>): Promise<AuthProfile>;

  // Knowledge & Models
  listKnowledge(projectId: string): Promise<{ items: Knowledge[] }>;
  createKnowledge(projectId: string, input: { title: string; text: string; kind: 'terminology' | 'rule' | 'flow' | 'restriction' }): Promise<Knowledge>;
  listModels(): Promise<{ items: ModelProfile[] }>;
  probeModel(modelId: string): Promise<{ healthy: boolean; latencyMs: number }>;

  // Runs
  listRuns(projectId: string): Promise<{ items: Run[] }>;
  getRun(runId: string): Promise<Run>;
  createRun(input: {
    projectId: string;
    targetUrl: string;
    description?: string;
    environmentId?: string;
    authProfileId?: string;
    modelProfileId?: string;
    budgetOverrides?: BudgetOverrides;
    config?: Partial<RunConfig>;
  }): Promise<Run>;
  cancelRun(runId: string): Promise<{ success: boolean }>;
  sendRunMessage(runId: string, message: string): Promise<void>;
  respondToInput(runId: string, inputId: string, response: InputResponse): Promise<void>;

  // Work Breakdown & Artifacts
  listRunCases(runId: string): Promise<{ items: CaseRecord[] }>;
  getCase(caseId: string): Promise<CaseRecord>;
  listCaseAttempts(caseId: string): Promise<{ items: CaseAttempt[] }>;
  listRunTasks(runId: string): Promise<{ items: Task[] }>;
  listTaskSteps(taskId: string): Promise<{ items: Step[] }>;
  getStep(stepId: string): Promise<Step>;
  listRunFindings(runId: string): Promise<{ items: Finding[] }>;
  getFinding(findingId: string): Promise<Finding>;
  previewTriage(
    findingId: string,
    disposition: 'accepted' | 'duplicate' | 'works_as_intended' | 'cannot_reproduce' | 'closed',
    reason: string
  ): Promise<TriagePreview>;
  commitTriage(findingId: string, input: TriageCommit): Promise<Finding>;

  // Reports & Exports
  getReport(runId: string): Promise<Report>;
  createExport(runId: string, format: 'json' | 'markdown' | 'zip'): Promise<Export>;
  getArtifact(artifactId: string): Promise<Artifact>;
  healthReady(): Promise<{ status: string; checks: Record<string, boolean> }>;
}
