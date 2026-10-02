import type { ApiClient } from './types.ts';
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

export class HttpApiClient implements ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = '/api/v1') {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
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

    return res.json() as Promise<T>;
  }

  public async login(input: {
    email?: string;
    username?: string;
    password?: string;
  }): Promise<{ token: string; user: User }> {
    return this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public async logout(): Promise<void> {
    await this.request('/auth/logout', { method: 'POST' });
  }

  public async currentUser(): Promise<User> {
    return this.request('/auth/me');
  }

  public async listUsers(): Promise<{ items: User[] }> {
    return this.request('/users');
  }

  public async listProjects(): Promise<{ items: Project[] }> {
    return this.request('/projects');
  }

  public async getProject(projectId: string): Promise<Project> {
    return this.request(`/projects/${projectId}`);
  }

  public async createProject(input: { name: string }): Promise<Project> {
    return this.request('/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public async updateProject(
    projectId: string,
    input: Partial<Project>,
  ): Promise<Project> {
    return this.request(`/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  public async listMembers(projectId: string): Promise<{ items: Member[] }> {
    return this.request(`/projects/${projectId}/members`);
  }

  public async listEnvironments(
    projectId: string,
  ): Promise<{ items: Environment[] }> {
    return this.request(`/projects/${projectId}/environments`);
  }

  public async createEnvironment(
    projectId: string,
    input: Partial<Environment>,
  ): Promise<Environment> {
    return this.request(`/projects/${projectId}/environments`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public async listAuthProfiles(
    projectId: string,
  ): Promise<{ items: AuthProfile[] }> {
    return this.request(`/projects/${projectId}/auth-profiles`);
  }

  public async createAuthProfile(
    projectId: string,
    input: Partial<AuthProfile>,
  ): Promise<AuthProfile> {
    return this.request(`/projects/${projectId}/auth-profiles`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public async listKnowledge(
    projectId: string,
  ): Promise<{ items: Knowledge[] }> {
    return this.request(`/projects/${projectId}/knowledge`);
  }

  public async createKnowledge(
    projectId: string,
    input: {
      title: string;
      text: string;
      kind: 'terminology' | 'rule' | 'flow' | 'restriction';
    },
  ): Promise<Knowledge> {
    return this.request(`/projects/${projectId}/knowledge`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public async listModels(): Promise<{ items: ModelProfile[] }> {
    return this.request('/model-profiles');
  }

  public async probeModel(
    modelId: string,
  ): Promise<{ healthy: boolean; latencyMs: number }> {
    return this.request(`/model-profiles/${modelId}/probe`, { method: 'POST' });
  }

  public async listRuns(projectId: string): Promise<{ items: Run[] }> {
    return this.request(`/runs?projectId=${encodeURIComponent(projectId)}`);
  }

  public async getRun(runId: string): Promise<Run> {
    return this.request(`/runs/${runId}`);
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
    return this.request('/runs', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public async cancelRun(runId: string): Promise<{ success: boolean }> {
    return this.request(`/runs/${runId}/cancel`, { method: 'POST' });
  }

  public async sendRunMessage(runId: string, message: string): Promise<void> {
    await this.request(`/runs/${runId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  public async respondToInput(
    runId: string,
    inputId: string,
    response: InputResponse,
  ): Promise<void> {
    await this.request(`/runs/${runId}/inputs/${inputId}/respond`, {
      method: 'POST',
      body: JSON.stringify(response),
    });
  }

  public async listRunCases(runId: string): Promise<{ items: CaseRecord[] }> {
    return this.request(`/runs/${runId}/cases`);
  }

  public async getCase(caseId: string): Promise<CaseRecord> {
    return this.request(`/cases/${caseId}`);
  }

  public async listCaseAttempts(
    caseId: string,
  ): Promise<{ items: CaseAttempt[] }> {
    return this.request(`/cases/${caseId}/attempts`);
  }

  public async listRunTasks(runId: string): Promise<{ items: Task[] }> {
    return this.request(`/runs/${runId}/tasks`);
  }

  public async listTaskSteps(taskId: string): Promise<{ items: Step[] }> {
    return this.request(`/tasks/${taskId}/steps`);
  }

  public async getStep(stepId: string): Promise<Step> {
    return this.request(`/steps/${stepId}`);
  }

  public async listRunFindings(runId: string): Promise<{ items: Finding[] }> {
    return this.request(`/runs/${runId}/findings`);
  }

  public async getFinding(findingId: string): Promise<Finding> {
    return this.request(`/findings/${findingId}`);
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
    return this.request(`/findings/${findingId}/triage-preview`, {
      method: 'POST',
      body: JSON.stringify({ disposition, reason }),
    });
  }

  public async commitTriage(
    findingId: string,
    input: TriageCommit,
  ): Promise<Finding> {
    return this.request(`/findings/${findingId}/triage`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public async getReport(runId: string): Promise<Report> {
    return this.request(`/runs/${runId}/report`);
  }

  public async createExport(
    runId: string,
    format: 'json' | 'markdown' | 'zip',
  ): Promise<Export> {
    return this.request(`/runs/${runId}/exports`, {
      method: 'POST',
      body: JSON.stringify({ format }),
    });
  }

  public async getArtifact(artifactId: string): Promise<Artifact> {
    return this.request(`/artifacts/${artifactId}`);
  }

  public async healthReady(): Promise<{
    status: string;
    checks: Record<string, boolean>;
  }> {
    return this.request('/health/ready');
  }
}
