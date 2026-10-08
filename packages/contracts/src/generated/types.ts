/* Generated from docs/contracts/*.json. DO NOT EDIT. Runtime schemas are authoritative for refinements. */

export type Contract =
  | ActionPermit
  | ActionReservation
  | ActionResult
  | ApiKey
  | ApiKeyCreate
  | ApiKeyCreated
  | ApiKeyPage
  | ApiKeyScope
  | Artifact
  | AuthProfile
  | AuthProfileCreate
  | AuthProfilePage
  | AuthProfilePatch
  | AuthResolve
  | Bounds
  | BrowserSnapshot
  | BudgetLimits
  | BudgetOverrides
  | BudgetUsed
  | CacheStats
  | CandidateCase
  | CaseAttempt
  | CaseAttemptPage
  | CaseDefinition
  | CaseRecord
  | CaseRecordPage
  | CredentialMaterial
  | Criterion
  | CriterionResult
  | Environment
  | EnvironmentCreate
  | EnvironmentPage
  | EnvironmentPatch
  | Error
  | Export
  | ExportInput
  | Finding
  | FindingPage
  | FormConfig
  | Health
  | HeartbeatInput
  | HeartbeatResult
  | InputRequest
  | InputResponse
  | JsonValue
  | Knowledge
  | KnowledgeCreate
  | KnowledgePage
  | KnowledgePatch
  | Lease
  | Locator
  | LoginInput
  | LoginResult
  | Member
  | MemberPage
  | MemberUpdate
  | MessageInput
  | ModelBinding
  | ModelCapabilities
  | ModelMessage
  | ModelPart
  | ModelProbeResult
  | ModelProfile
  | ModelProfileCreate
  | ModelProfilePage
  | ModelProfilePatch
  | ModelRequest
  | ModelResult
  | ModelUsage
  | NetworkEntries
  | NetworkEntry
  | NodeTarget
  | Project
  | ProjectCreate
  | ProjectPage
  | ProjectPatch
  | RegressionBinding
  | RegressionDocument
  | RegressionModuleCreate
  | RegressionModuleRecord
  | RegressionModuleRecordPage
  | RegressionModuleReviewCommit
  | RegressionModuleReviewPreview
  | RegressionModuleReviewPreviewInput
  | RegressionModuleVersion
  | RegressionRunCreate
  | RegressionStepSource
  | RepairProposal
  | RepairProposalCreate
  | RepairProposalPage
  | ReplayStep
  | Report
  | Reproduction
  | ReviewCommit
  | ReviewPreview
  | ReviewPreviewInput
  | RoleModels
  | Run
  | RunConfig
  | RunCreate
  | RunEvent
  | RunEventPage
  | RunMessage
  | RunMessagePage
  | RunPage
  | SavedCase
  | SavedCaseArchiveInput
  | SavedCaseCreate
  | SavedCaseDuplicateInput
  | SavedCasePage
  | SavedCaseRestoreInput
  | SavedCaseVersion
  | SavedCaseVersionCreate
  | SavedCaseVersionPage
  | SavedCaseYamlExport
  | SavedCaseYamlImport
  | Schedule
  | ScheduleCreate
  | SchedulePage
  | SchedulePatch
  | SnapshotNode
  | Step
  | StepPage
  | Summary
  | Task
  | TaskComplete
  | TaskPage
  | ToolCall
  | ToolResult
  | TriageCommit
  | TriageInput
  | TriagePreview
  | User
  | UserCreate
  | UserPage
  | UserPatch
  | Verdict
  | WorkerClaim;
export type ToolCall =
  | {
      name: "observe";
      args: {
        pageId?: string;
      };
    }
  | {
      name: "navigate";
      args: {
        url: string;
      };
    }
  | {
      name: "click";
      args: {
        target: NodeTarget;
      };
    }
  | {
      name: "type_text";
      args: {
        target: NodeTarget;
        text: string;
      };
    }
  | {
      name: "select_option";
      args: {
        target: NodeTarget;
        value: string;
      };
    }
  | {
      name: "press";
      args: {
        target: NodeTarget;
        key: "Enter" | "Escape" | "Tab" | "ArrowUp" | "ArrowDown";
      };
    }
  | {
      name: "scroll";
      args: {
        pageId: string;
        direction: "up" | "down";
        pixels: number;
      };
    }
  | {
      name: "wait_for";
      args: {
        pageId: string;
        condition: "dom_ready" | "navigation" | "element_visible";
        target?: NodeTarget;
        timeoutMs: number;
      };
    }
  | {
      name: "assert_criterion";
      args: {
        criterionId: string;
      };
    }
  | {
      name: "inspect_network";
      args: {
        pageId: string;
        urlContains?: string;
        limit: number;
      };
    }
  | {
      name: "capture";
      args: {
        pageId: string;
        reason: string;
      };
    }
  | {
      name: "submit_case";
      args: {
        candidate: CandidateCase;
      };
    }
  | {
      name: "report_suspect";
      args: {
        caseId: string;
        criterionId: string;
        actual: string;
        /**
         * @minItems 1
         * @maxItems 30
         */
        evidenceRefs: [string, ...string[]];
        /**
         * @minItems 1
         * @maxItems 30
         */
        reproSteps: [string, ...string[]];
      };
    }
  | {
      name: "finish_case";
      args: {
        summary: string;
        /**
         * @minItems 0
         * @maxItems 30
         */
        gaps: string[];
      };
    }
  | {
      name: "complete_reproduction";
      args: {
        outcome: "reproduced" | "not_reproduced" | "blocked";
        summary: string;
        /**
         * @minItems 0
         * @maxItems 30
         */
        evidenceRefs: string[];
      };
    }
  | {
      name: "request_input";
      args: {
        kind: "auth_profile" | "clarification" | "scope_extension";
        prompt: string;
      };
    };
export type Criterion = {
  id: string;
  kind: "element_visible" | "text_equals" | "url_matches" | "http_status" | "semantic" | "visual";
  description: string;
  sourceKind: "generic_smoke" | "user_spec" | "project_knowledge" | "saved_case" | "inferred";
  sourceRef: string;
  locator?: Locator;
  expectedValue?: JsonValue;
};
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [k: string]: JsonValue | undefined;
    };
export type ApiKeyScope = "runs:create" | "runs:read" | "reports:read" | "runs:cancel";
export type AuthProfileCreate = {
  environmentId?: string | null;
  name: string;
  mode: "none" | "form" | "storage_state";
  /**
   * @minItems 1
   * @maxItems 30
   */
  allowedOrigins: [string, ...string[]];
  sharingPolicy?: "exclusive_run" | "shared_state";
  formConfig?: FormConfig;
  secretInput?: {
    [k: string]: string | undefined;
  };
};
/**
 * @minItems 0
 * @maxItems 100
 */
export type NetworkEntries = NetworkEntry[];
export type ReplayStep =
  | {
      kind: "navigate";
      url: string;
    }
  | {
      kind: "click";
      locator: Locator;
    }
  | {
      kind: "type_text";
      locator: Locator;
      text: string;
    }
  | {
      kind: "assert";
      criterionId: string;
    }
  | {
      kind: "ai_action";
      goal: string;
      /**
       * @minItems 1
       * @maxItems 20
       */
      criteriaIds: [string, ...string[]];
    }
  | {
      kind: "module";
      ref: string;
      arguments?: {
        [k: string]: JsonValue | undefined;
      };
    };
export type Finding = {
  id: string;
  runId: string;
  /**
   * @minItems 0
   * @maxItems 30
   */
  caseIds: string[];
  kind: "functional" | "static";
  status: "suspected" | "confirmed" | "unconfirmed" | "blocked";
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  expected: string;
  actual: string;
  expectedSource: "generic_smoke" | "user_spec" | "project_knowledge" | "saved_case" | "inferred";
  /**
   * @minItems 0
   * @maxItems 30
   */
  reproSteps: string[];
  /**
   * @minItems 0
   * @maxItems 30
   */
  evidenceRefs: string[];
  reproductionRef: string | null;
  triageDisposition: "open" | "accepted" | "duplicate" | "works_as_intended" | "cannot_reproduce" | "closed";
  version: number;
};
export type ModelPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      artifactId: string;
    };
export type RunEvent = {
  schemaVersion: 1;
  id: string;
  runId: string;
  seq: number;
  type:
    | "run.updated"
    | "phase.changed"
    | "task.updated"
    | "case.created"
    | "case.result"
    | "finding.updated"
    | "step.recorded"
    | "budget.updated"
    | "input.requested"
    | "input.resolved"
    | "artifact.updated"
    | "report.ready"
    | "run.finished";
  at: string;
  payload: {
    [k: string]: JsonValue | undefined;
  };
};

export interface ActionPermit {
  actionId: string;
  permitted: boolean;
  reasonCode: string | null;
}
export interface ActionReservation {
  taskId: string;
  fencingToken: number;
  contextVersion: number;
  toolCall: ToolCall;
  regressionSource?: RegressionStepSource;
}
export interface NodeTarget {
  snapshotId: string;
  pageId: string;
  frameId?: string;
  nodeId: string;
}
export interface CandidateCase {
  title: string;
  summary: string;
  /**
   * @minItems 0
   * @maxItems 20
   */
  preconditions: string[];
  /**
   * @minItems 1
   * @maxItems 30
   */
  outline: [string, ...string[]];
  /**
   * @minItems 1
   * @maxItems 20
   */
  criteria: [Criterion, ...Criterion[]];
}
export interface Locator {
  by: "role" | "label" | "test_id" | "text" | "css";
  value: string;
  name?: string;
}
export interface RegressionStepSource {
  documentId: string;
  stepIndex: number;
  /**
   * @minItems 0
   * @maxItems 8
   */
  modulePath: {
    ref: string;
    sha256: string;
    invocationStepIndex: number;
  }[];
}
export interface ActionResult {
  outcome: "succeeded" | "failed" | "unknown" | "cancelled";
  summary: string;
  /**
   * @minItems 0
   * @maxItems 30
   */
  evidenceRefs: string[];
  resultHash: string;
}
export interface ApiKey {
  id: string;
  projectId: string;
  name: string;
  /**
   * @minItems 1
   * @maxItems 20
   */
  scope: [ApiKeyScope, ...ApiKeyScope[]];
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}
export interface ApiKeyCreate {
  name: string;
  /**
   * @minItems 1
   * @maxItems 20
   */
  scope: [ApiKeyScope, ...ApiKeyScope[]];
  expiresAt?: string | null;
}
export interface ApiKeyCreated {
  key: ApiKey;
  token: string;
}
export interface ApiKeyPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: ApiKey[];
  nextCursor: string | null;
}
export interface Artifact {
  id: string;
  projectId: string;
  runId: string;
  kind: "screenshot" | "trace" | "rrweb" | "network" | "console" | "export" | "other";
  status: "available" | "degraded" | "missing" | "failed";
  bytes: number | null;
  sha256: string | null;
  contentUrl: string | null;
  redaction: "applied" | "not_needed" | "failed";
  error: string | null;
  createdAt: string;
  taskId: string | null;
  stepId: string | null;
  caseId: string | null;
  snapshotId: string | null;
}
export interface AuthProfile {
  id: string;
  projectId: string;
  environmentId: string | null;
  name: string;
  mode: "none" | "form" | "storage_state";
  /**
   * @minItems 1
   * @maxItems 30
   */
  allowedOrigins: [string, ...string[]];
  sharingPolicy: "exclusive_run" | "shared_state";
  hasSecret: boolean;
  version: number;
  status: "active" | "revoked";
  formConfig: FormConfig | null;
}
export interface FormConfig {
  loginUrl: string;
  usernameTarget: Locator;
  passwordTarget: Locator;
  submitTarget: Locator;
  successCriterion: Criterion;
  otpTarget?: Locator;
}
export interface AuthProfilePage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: AuthProfile[];
  nextCursor: string | null;
}
export interface AuthProfilePatch {
  expectedVersion: number;
  name?: string;
  sharingPolicy?: "exclusive_run" | "shared_state";
  formConfig?: FormConfig;
  secretInput?: {
    [k: string]: string | undefined;
  };
  revoke?: boolean;
}
export interface AuthResolve {
  taskId: string;
  authProfileId: string;
  authProfileVersion: number;
}
export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface BrowserSnapshot {
  snapshotId: string;
  pageId: string;
  /**
   * @minItems 0
   * @maxItems 100
   */
  frameIds: string[];
  displayUrl: string;
  title: string;
  responseStatus: number | null;
  capturedAt: string;
  stateVersion: number;
  viewport: {
    width: number;
    height: number;
  };
  /**
   * @minItems 0
   * @maxItems 1000
   */
  nodes: SnapshotNode[];
  screenshotRef: string | null;
  networkSummary: NetworkEntries;
  /**
   * @minItems 0
   * @maxItems 50
   */
  consoleSummary: string[];
  truncated: boolean;
  redacted: boolean;
}
export interface SnapshotNode {
  nodeId: string;
  frameId: string;
  role: string;
  name: string;
  text: string;
  visible: boolean;
  enabled: boolean;
  bounds: Bounds;
}
export interface NetworkEntry {
  url: string;
  method: string;
  status: number | null;
  resourceType: string;
  summary: string;
}
export interface BudgetLimits {
  maxCases: number;
  maxPages: number;
  maxDepth: number;
  maxActiveSeconds: number;
  maxActionsPerCase: number;
  maxActions: number;
  maxModelCalls: number;
  maxReproductions: number;
  concurrency: number;
  maxTotalTokens: number;
}
export interface BudgetOverrides {
  maxCases?: number;
  maxPages?: number;
  maxDepth?: number;
  maxActiveSeconds?: number;
  maxActionsPerCase?: number;
  maxActions?: number;
  maxModelCalls?: number;
  maxReproductions?: number;
  concurrency?: number;
  maxTotalTokens?: number;
}
export interface BudgetUsed {
  activeSeconds: number;
  actions: number;
  modelCalls: number;
  reproductions: number;
  totalTokens: number;
}
export interface CacheStats {
  runId: string;
  hits: number;
  misses: number;
  invalidated: number;
  resolution: string;
  savedModelCalls: number;
  savedMs: number;
}
export interface CaseAttempt {
  id: string;
  caseId: string;
  taskId: string;
  attemptNumber: number;
  status: "queued" | "running" | "completed" | "interrupted" | "cancelled";
  verdict: Verdict | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface Verdict {
  id: string;
  caseId: string;
  attemptId: string;
  status: "passed" | "issue_found" | "blocked" | "inconclusive";
  reasonCode: string;
  summary: string;
  /**
   * @minItems 0
   * @maxItems 20
   */
  criterionResults: CriterionResult[];
  /**
   * @minItems 0
   * @maxItems 30
   */
  gaps: string[];
  createdAt: string;
}
export interface CriterionResult {
  criterionId: string;
  result: "passed" | "failed" | "not_evaluated" | "unknown";
  reason: string;
  /**
   * @minItems 0
   * @maxItems 30
   */
  evidenceRefs: string[];
}
export interface CaseAttemptPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: CaseAttempt[];
  nextCursor: string | null;
}
export interface CaseDefinition {
  id: string;
  runId: string;
  projectId: string;
  version: number;
  title: string;
  summary: string;
  /**
   * @minItems 0
   * @maxItems 20
   */
  preconditions: string[];
  /**
   * @minItems 1
   * @maxItems 30
   */
  outline: [string, ...string[]];
  /**
   * @minItems 1
   * @maxItems 20
   */
  criteria: [Criterion, ...Criterion[]];
  regression?: RegressionBinding;
}
export interface RegressionBinding {
  sourceVersionId: string;
  sourceDocumentSha256: string;
  document: RegressionDocument;
  /**
   * @minItems 0
   * @maxItems 100
   */
  moduleSnapshots: RegressionModuleVersion[];
  snapshotDocumentSha256?: string;
}
export interface RegressionDocument {
  schemaVersion: 1;
  kind: "localqa/test";
  id: string;
  name: string;
  variables?: {
    [k: string]: string | number | boolean | undefined;
  };
  /**
   * @minItems 1
   * @maxItems 20
   */
  criteria: [Criterion, ...Criterion[]];
  /**
   * @minItems 1
   * @maxItems 100
   */
  steps: [ReplayStep, ...ReplayStep[]];
  /**
   * @minItems 0
   * @maxItems 10
   */
  fixtureRefs?: {
    id: string;
    version: number;
  }[];
}
export interface RegressionModuleVersion {
  projectId: string;
  name: string;
  version: number;
  sha256: string;
  document: RegressionDocument;
  reviewStatus: "draft" | "approved" | "rejected";
}
export interface CaseRecord {
  definition: CaseDefinition;
  outcome: "passed" | "issue_found" | "blocked" | "inconclusive" | "not_run";
  verdict: Verdict | null;
}
export interface CaseRecordPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: CaseRecord[];
  nextCursor: string | null;
}
export interface CredentialMaterial {
  mode: "none" | "form" | "storage_state";
  material: {
    [k: string]: JsonValue | undefined;
  };
  expiresAt: string;
}
export interface Environment {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  /**
   * @minItems 1
   * @maxItems 30
   */
  allowedOrigins: [string, ...string[]];
  /**
   * @minItems 0
   * @maxItems 100
   */
  excludedPaths: string[];
  tlsPolicy: "strict" | "allow_self_signed";
  defaultAuthProfileId: string | null;
  version: number;
}
export interface EnvironmentCreate {
  name: string;
  baseUrl: string;
  /**
   * @minItems 1
   * @maxItems 30
   */
  allowedOrigins: [string, ...string[]];
  /**
   * @minItems 0
   * @maxItems 100
   */
  excludedPaths?: string[];
  tlsPolicy: "strict" | "allow_self_signed";
  defaultAuthProfileId?: string | null;
}
export interface EnvironmentPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: Environment[];
  nextCursor: string | null;
}
export interface EnvironmentPatch {
  expectedVersion: number;
  name?: string;
  baseUrl?: string;
  /**
   * @minItems 1
   * @maxItems 30
   */
  allowedOrigins?: [string, ...string[]];
  /**
   * @minItems 0
   * @maxItems 100
   */
  excludedPaths?: string[];
  tlsPolicy?: "strict" | "allow_self_signed";
  defaultAuthProfileId?: string | null;
}
export interface Error {
  code: string;
  message: string;
  requestId: string;
  details?: JsonValue;
}
export interface Export {
  id: string;
  runId: string;
  status: "queued" | "running" | "ready" | "failed";
  format: "json" | "markdown" | "zip";
  artifactId: string | null;
  snapshotAt: string;
  error: string | null;
}
export interface ExportInput {
  format: "json" | "markdown" | "zip";
  includeArtifacts?: boolean;
  requireTerminal?: boolean;
}
export interface FindingPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: Finding[];
  nextCursor: string | null;
}
export interface Health {
  status: "ok" | "not_ready";
  version: string;
}
export interface HeartbeatInput {
  fencingToken: number;
  contextVersion: number;
}
export interface HeartbeatResult {
  leaseUntil: string;
  cancelRequested: boolean;
  contextVersion: number;
}
export interface InputRequest {
  id: string;
  runId: string;
  kind: "auth_profile" | "one_time_code" | "clarification" | "scope_extension" | "write_action";
  status: "pending" | "resolved" | "rejected" | "expired";
  prompt: string;
  expiresAt: string;
  version: number;
}
export interface InputResponse {
  expectedVersion: number;
  decision: "provide" | "approve" | "reject";
  authProfileId?: string;
  text?: string;
  oneTimeCode?: string;
  /**
   * @minItems 0
   * @maxItems 30
   */
  allowedOrigins?: string[];
}
export interface Knowledge {
  id: string;
  projectId: string;
  title: string;
  kind: "terminology" | "rule" | "flow" | "restriction";
  text: string;
  approved: boolean;
  version: number;
}
export interface KnowledgeCreate {
  title: string;
  kind: "terminology" | "rule" | "flow" | "restriction";
  text: string;
}
export interface KnowledgePage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: Knowledge[];
  nextCursor: string | null;
}
export interface KnowledgePatch {
  expectedVersion: number;
  title?: string;
  text?: string;
  approved?: boolean;
}
export interface Lease {
  task: Task;
  fencingToken: number;
  leaseToken: string;
  leaseUntil: string;
  contextVersion: number;
}
export interface Task {
  id: string;
  runId: string;
  role: "coordinator" | "explorer" | "executor" | "reproducer" | "finalizer";
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted";
  caseId: string | null;
  attempt: number;
  summary: string;
  elapsedSeconds: number;
}
export interface LoginInput {
  email: string;
  password: string;
}
export interface LoginResult {
  user: User;
  expiresAt: string;
}
export interface User {
  id: string;
  email: string;
  displayName: string;
  globalRole: "admin" | "member";
  disabled: boolean;
  version: number;
}
export interface Member {
  userId: string;
  role: "owner" | "operator" | "viewer";
}
export interface MemberPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: Member[];
  nextCursor: string | null;
}
export interface MemberUpdate {
  expectedVersion: number;
  /**
   * @minItems 1
   * @maxItems 100
   */
  members: [Member, ...Member[]];
}
export interface MessageInput {
  text: string;
  expectedContextVersion: number;
}
export interface ModelBinding {
  profileId: string;
  version: number;
}
export interface ModelCapabilities {
  structuredOutput: boolean;
  nativeTools: boolean;
  imageInput: boolean;
}
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * @minItems 1
   * @maxItems 20
   */
  content: [ModelPart, ...ModelPart[]];
}
export interface ModelProbeResult {
  profileId: string;
  capabilities: ModelCapabilities;
  status: "ready" | "degraded" | "disabled";
  /**
   * @minItems 0
   * @maxItems 20
   */
  notes: string[];
}
export interface ModelProfile {
  id: string;
  name: string;
  endpoint: string;
  configuredModelId: string;
  adapter: "openai_compatible";
  dataBoundary: "internal" | "external";
  capabilities: ModelCapabilities;
  status: "untested" | "ready" | "degraded" | "disabled";
  version: number;
  responseFormat?: "json_schema" | "json_object" | "native_tools";
}
export interface ModelProfileCreate {
  name: string;
  endpoint: string;
  configuredModelId: string;
  adapter: "openai_compatible";
  dataBoundary: "internal" | "external";
  apiKey?: string;
  responseFormat?: "json_schema" | "json_object" | "native_tools";
}
export interface ModelProfilePage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: ModelProfile[];
  nextCursor: string | null;
}
export interface ModelProfilePatch {
  expectedVersion: number;
  name?: string;
  endpoint?: string;
  configuredModelId?: string;
  apiKey?: string;
  status?: "disabled" | "untested";
  responseFormat?: "json_schema" | "json_object" | "native_tools";
}
export interface ModelRequest {
  taskId: string;
  profileId: string;
  contextVersion: number;
  purpose: "plan" | "decide" | "assert" | "summarize";
  /**
   * @minItems 1
   * @maxItems 100
   */
  messages: [ModelMessage, ...ModelMessage[]];
  maxOutputTokens: number;
  outputSchema: {
    [k: string]: unknown | undefined;
  };
  criterionId?: string;
}
export interface ModelResult {
  data: JsonValue;
  configuredModelId: string;
  reportedModelId: string | null;
  usage: ModelUsage;
}
export interface ModelUsage {
  profileId: string;
  configuredModelId: string;
  reportedModelId: string | null;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: "reported" | "estimated" | "mixed" | "unknown";
}
export interface Project {
  id: string;
  name: string;
  status: "active" | "archived";
  version: number;
  createdAt: string;
  defaultModelProfileId: string | null;
}
export interface ProjectCreate {
  name: string;
}
export interface ProjectPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: Project[];
  nextCursor: string | null;
}
export interface ProjectPatch {
  expectedVersion: number;
  name?: string;
  status?: "active" | "archived";
  defaultModelProfileId?: string | null;
}
export interface RegressionModuleCreate {
  name: string;
  document: RegressionDocument;
  expectedVersion?: number;
}
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
export interface RegressionModuleRecordPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: RegressionModuleRecord[];
  nextCursor: string | null;
}
export interface RegressionModuleReviewCommit {
  expectedVersion: number;
  decision: "approve" | "reject";
  reason: string;
  confirmationToken: string;
}
export interface RegressionModuleReviewPreview {
  projectId: string;
  moduleName: string;
  version: number;
  documentSha256: string;
  expectedVersion: number;
  decision: "approve" | "reject";
  reason: string;
  diff: string;
  /**
   * @minItems 0
   * @maxItems 20
   */
  risks: string[];
  confirmationToken: string;
  expiresAt: string;
}
export interface RegressionModuleReviewPreviewInput {
  expectedVersion: number;
  decision: "approve" | "reject";
  reason: string;
}
export interface RegressionRunCreate {
  projectId: string;
  /**
   * @minItems 1
   * @maxItems 100
   */
  caseVersionIds: [string, ...string[]];
  environmentId?: string;
  authProfileId?: string;
  budget?: BudgetOverrides;
}
export interface RepairProposal {
  id: string;
  caseId: string;
  findingId: string;
  proposedVersion: number;
  diff: string;
  verificationRunId: string | null;
  status: "draft" | "approved" | "rejected";
  createdAt: string;
}
export interface RepairProposalCreate {
  findingId: string;
  diff: string;
}
export interface RepairProposalPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: RepairProposal[];
  nextCursor: string | null;
}
export interface Report {
  schemaVersion: 1;
  example: boolean;
  generatedAt: string;
  run: Run;
  summary: Summary;
  /**
   * @minItems 0
   * @maxItems 1000
   */
  cases: CaseRecord[];
  /**
   * @minItems 0
   * @maxItems 1000
   */
  findings: Finding[];
  /**
   * @minItems 0
   * @maxItems 1000
   */
  reproductions: Reproduction[];
  /**
   * @minItems 0
   * @maxItems 5000
   */
  artifacts: Artifact[];
  /**
   * @minItems 0
   * @maxItems 100
   */
  modelUsage: ModelUsage[];
  /**
   * @minItems 0
   * @maxItems 1000
   */
  coverageGaps: string[];
  cleanupStatus: "not_required" | "pending" | "running" | "succeeded" | "failed" | "manual_required";
  /**
   * @minItems 0
   * @maxItems 1000
   */
  warnings: string[];
}
export interface Run {
  id: string;
  projectId: string;
  creatorId: string;
  targetUrl: string;
  status: "draft" | "queued" | "running" | "awaiting_input" | "cancelling" | "completed" | "cancelled" | "failed";
  phase: "preflight" | "auth" | "explore" | "plan" | "execute" | "reproduce" | "finalize";
  completion: "complete" | "partial" | "none";
  terminationReason:
    | (
        | "normal"
        | "budget_limit"
        | "input_timeout"
        | "user_cancel"
        | "worker_failure"
        | "model_failure"
        | "setup_failure"
      )
    | null;
  contextVersion: number;
  effectiveConfig: RunConfig;
  budgetUsed: BudgetUsed;
  createdAt: string;
  updatedAt: string;
  version: number;
  executionMode?: "smoke" | "regression";
}
export interface RunConfig {
  /**
   * @minItems 1
   * @maxItems 30
   */
  allowedOrigins: [string, ...string[]];
  actionPolicy: "non_submitting" | "approved_workflows";
  budget: BudgetLimits;
  environmentVersion: number | null;
  authProfileVersion: number | null;
  /**
   * @minItems 0
   * @maxItems 100
   */
  knowledgeVersionIds: string[];
  models: RoleModels;
}
export interface RoleModels {
  coordinator: ModelBinding;
  explorer: ModelBinding;
  executor: ModelBinding;
  assertion: ModelBinding;
  reproducer: ModelBinding;
}
export interface Summary {
  planned: number;
  passed: number;
  issueFound: number;
  blocked: number;
  inconclusive: number;
  notRun: number;
  attempted: number;
  evaluated: number;
  passRate: number | null;
  attemptRate: number | null;
}
export interface Reproduction {
  id: string;
  findingId: string;
  taskId: string;
  outcome: "reproduced" | "not_reproduced" | "blocked";
  freshContext: true;
  summary: string;
  /**
   * @minItems 0
   * @maxItems 30
   */
  evidenceRefs: string[];
  createdAt: string;
}
export interface ReviewCommit {
  expectedVersion: number;
  decision: "approve" | "reject";
  reason: string;
  confirmationToken: string;
}
export interface ReviewPreview {
  versionId: string;
  expectedVersion: number;
  decision: "approve" | "reject";
  reason: string;
  diff: string;
  /**
   * @minItems 0
   * @maxItems 20
   */
  risks: string[];
  confirmationToken: string;
  expiresAt: string;
}
export interface ReviewPreviewInput {
  expectedVersion: number;
  decision: "approve" | "reject";
  reason: string;
}
export interface RunCreate {
  projectId: string;
  targetUrl: string;
  brief?: string;
  environmentId?: string;
  authProfileId?: string;
  mode?: "smoke";
  budget?: BudgetOverrides;
}
export interface RunEventPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: RunEvent[];
  nextCursor: string | null;
}
export interface RunMessage {
  id: string;
  runId: string;
  actorId: string;
  contextVersion: number;
  redactedText: string;
  createdAt: string;
}
export interface RunMessagePage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: RunMessage[];
  nextCursor: string | null;
}
export interface RunPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: Run[];
  nextCursor: string | null;
}
export interface SavedCase {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  status: "active" | "archived";
  currentApprovedVersionId: string | null;
  version: number;
  createdAt: string;
}
export interface SavedCaseArchiveInput {
  expectedVersion: number;
}
export interface SavedCaseCreate {
  slug: string;
  name: string;
  document?: RegressionDocument;
  sourceRunCaseId?: string;
}
export interface SavedCaseDuplicateInput {
  targetProjectId?: string;
  newSlug: string;
  newName: string;
  sourceVersionId: string;
}
export interface SavedCasePage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: SavedCase[];
  nextCursor: string | null;
}
export interface SavedCaseRestoreInput {
  expectedVersion: number;
}
export interface SavedCaseVersion {
  id: string;
  caseId: string;
  version: number;
  document: RegressionDocument;
  sha256: string;
  reviewStatus: "draft" | "approved" | "rejected";
  createdBy: string;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}
export interface SavedCaseVersionCreate {
  expectedVersion: number;
  document: RegressionDocument;
}
export interface SavedCaseVersionPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: SavedCaseVersion[];
  nextCursor: string | null;
}
export interface SavedCaseYamlExport {
  versionId: string;
  sourceDocumentSha256: string;
  yaml: string;
}
export interface SavedCaseYamlImport {
  slug: string;
  name: string;
  yaml: string;
}
export interface Schedule {
  id: string;
  projectId: string;
  name: string;
  cron: string;
  timezone: string;
  templateKind: "smoke" | "regression";
  runTemplate: RunCreate;
  overlapPolicy: "skip" | "queue";
  missedPolicy: "skip" | "catchup_one";
  enabled: boolean;
  version: number;
  createdAt: string;
}
export interface ScheduleCreate {
  name: string;
  cron: string;
  timezone?: string;
  templateKind: "smoke" | "regression";
  runTemplate: RunCreate;
  overlapPolicy?: "skip" | "queue";
  missedPolicy?: "skip" | "catchup_one";
  enabled?: boolean;
}
export interface SchedulePage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: Schedule[];
  nextCursor: string | null;
}
export interface SchedulePatch {
  expectedVersion: number;
  name?: string;
  cron?: string;
  timezone?: string;
  templateKind?: "smoke" | "regression";
  runTemplate?: RunCreate;
  overlapPolicy?: "skip" | "queue";
  missedPolicy?: "skip" | "catchup_one";
  enabled?: boolean;
}
export interface Step {
  id: string;
  runId: string;
  taskId: string;
  caseId: string | null;
  seq: number;
  toolName: string;
  status: "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "skipped";
  summary: string;
  targetDescription: string;
  /**
   * @minItems 0
   * @maxItems 30
   */
  evidenceRefs: string[];
  createdAt: string;
  finishedAt: string | null;
  regressionSource?: RegressionStepSource;
}
export interface StepPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: Step[];
  nextCursor: string | null;
}
export interface TaskComplete {
  fencingToken: number;
  status: "succeeded" | "failed" | "cancelled" | "interrupted";
  result: JsonValue;
  resultHash: string;
}
export interface TaskPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: Task[];
  nextCursor: string | null;
}
export interface ToolResult {
  requestId: string;
  actionId: string | null;
  status: "succeeded" | "failed" | "denied" | "blocked" | "cancelled";
  data: JsonValue;
  reasonCode: string | null;
  /**
   * @minItems 0
   * @maxItems 30
   */
  evidenceRefs: string[];
}
export interface TriageCommit {
  expectedVersion: number;
  disposition: "accepted" | "duplicate" | "works_as_intended" | "cannot_reproduce" | "closed";
  reason: string;
  confirmationToken: string;
}
export interface TriageInput {
  expectedVersion: number;
  disposition: "accepted" | "duplicate" | "works_as_intended" | "cannot_reproduce" | "closed";
  reason: string;
}
export interface TriagePreview {
  findingId: string;
  expectedVersion: number;
  disposition: "accepted" | "duplicate" | "works_as_intended" | "cannot_reproduce" | "closed";
  reason: string;
  confirmationToken: string;
  expiresAt: string;
}
export interface UserCreate {
  email: string;
  displayName: string;
  password: string;
  globalRole?: "admin" | "member";
}
export interface UserPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: User[];
  nextCursor: string | null;
}
export interface UserPatch {
  expectedVersion: number;
  displayName?: string;
  disabled?: boolean;
  password?: string;
  globalRole?: "admin" | "member";
}
export interface WorkerClaim {
  workerId: string;
  /**
   * @minItems 1
   * @maxItems 10
   */
  capabilities: ["chromium" | "images" | "recording", ...("chromium" | "images" | "recording")[]];
}

export interface ContractTypes {
  ActionPermit: ActionPermit;
  ActionReservation: ActionReservation;
  ActionResult: ActionResult;
  ApiKey: ApiKey;
  ApiKeyCreate: ApiKeyCreate;
  ApiKeyCreated: ApiKeyCreated;
  ApiKeyPage: ApiKeyPage;
  ApiKeyScope: ApiKeyScope;
  Artifact: Artifact;
  AuthProfile: AuthProfile;
  AuthProfileCreate: AuthProfileCreate;
  AuthProfilePage: AuthProfilePage;
  AuthProfilePatch: AuthProfilePatch;
  AuthResolve: AuthResolve;
  Bounds: Bounds;
  BrowserSnapshot: BrowserSnapshot;
  BudgetLimits: BudgetLimits;
  BudgetOverrides: BudgetOverrides;
  BudgetUsed: BudgetUsed;
  CacheStats: CacheStats;
  CandidateCase: CandidateCase;
  CaseAttempt: CaseAttempt;
  CaseAttemptPage: CaseAttemptPage;
  CaseDefinition: CaseDefinition;
  CaseRecord: CaseRecord;
  CaseRecordPage: CaseRecordPage;
  CredentialMaterial: CredentialMaterial;
  Criterion: Criterion;
  CriterionResult: CriterionResult;
  Environment: Environment;
  EnvironmentCreate: EnvironmentCreate;
  EnvironmentPage: EnvironmentPage;
  EnvironmentPatch: EnvironmentPatch;
  Error: Error;
  Export: Export;
  ExportInput: ExportInput;
  Finding: Finding;
  FindingPage: FindingPage;
  FormConfig: FormConfig;
  Health: Health;
  HeartbeatInput: HeartbeatInput;
  HeartbeatResult: HeartbeatResult;
  InputRequest: InputRequest;
  InputResponse: InputResponse;
  JsonValue: JsonValue;
  Knowledge: Knowledge;
  KnowledgeCreate: KnowledgeCreate;
  KnowledgePage: KnowledgePage;
  KnowledgePatch: KnowledgePatch;
  Lease: Lease;
  Locator: Locator;
  LoginInput: LoginInput;
  LoginResult: LoginResult;
  Member: Member;
  MemberPage: MemberPage;
  MemberUpdate: MemberUpdate;
  MessageInput: MessageInput;
  ModelBinding: ModelBinding;
  ModelCapabilities: ModelCapabilities;
  ModelMessage: ModelMessage;
  ModelPart: ModelPart;
  ModelProbeResult: ModelProbeResult;
  ModelProfile: ModelProfile;
  ModelProfileCreate: ModelProfileCreate;
  ModelProfilePage: ModelProfilePage;
  ModelProfilePatch: ModelProfilePatch;
  ModelRequest: ModelRequest;
  ModelResult: ModelResult;
  ModelUsage: ModelUsage;
  NetworkEntries: NetworkEntries;
  NetworkEntry: NetworkEntry;
  NodeTarget: NodeTarget;
  Project: Project;
  ProjectCreate: ProjectCreate;
  ProjectPage: ProjectPage;
  ProjectPatch: ProjectPatch;
  RegressionBinding: RegressionBinding;
  RegressionDocument: RegressionDocument;
  RegressionModuleCreate: RegressionModuleCreate;
  RegressionModuleRecord: RegressionModuleRecord;
  RegressionModuleRecordPage: RegressionModuleRecordPage;
  RegressionModuleReviewCommit: RegressionModuleReviewCommit;
  RegressionModuleReviewPreview: RegressionModuleReviewPreview;
  RegressionModuleReviewPreviewInput: RegressionModuleReviewPreviewInput;
  RegressionModuleVersion: RegressionModuleVersion;
  RegressionRunCreate: RegressionRunCreate;
  RegressionStepSource: RegressionStepSource;
  RepairProposal: RepairProposal;
  RepairProposalCreate: RepairProposalCreate;
  RepairProposalPage: RepairProposalPage;
  ReplayStep: ReplayStep;
  Report: Report;
  Reproduction: Reproduction;
  ReviewCommit: ReviewCommit;
  ReviewPreview: ReviewPreview;
  ReviewPreviewInput: ReviewPreviewInput;
  RoleModels: RoleModels;
  Run: Run;
  RunConfig: RunConfig;
  RunCreate: RunCreate;
  RunEvent: RunEvent;
  RunEventPage: RunEventPage;
  RunMessage: RunMessage;
  RunMessagePage: RunMessagePage;
  RunPage: RunPage;
  SavedCase: SavedCase;
  SavedCaseArchiveInput: SavedCaseArchiveInput;
  SavedCaseCreate: SavedCaseCreate;
  SavedCaseDuplicateInput: SavedCaseDuplicateInput;
  SavedCasePage: SavedCasePage;
  SavedCaseRestoreInput: SavedCaseRestoreInput;
  SavedCaseVersion: SavedCaseVersion;
  SavedCaseVersionCreate: SavedCaseVersionCreate;
  SavedCaseVersionPage: SavedCaseVersionPage;
  SavedCaseYamlExport: SavedCaseYamlExport;
  SavedCaseYamlImport: SavedCaseYamlImport;
  Schedule: Schedule;
  ScheduleCreate: ScheduleCreate;
  SchedulePage: SchedulePage;
  SchedulePatch: SchedulePatch;
  SnapshotNode: SnapshotNode;
  Step: Step;
  StepPage: StepPage;
  Summary: Summary;
  Task: Task;
  TaskComplete: TaskComplete;
  TaskPage: TaskPage;
  ToolCall: ToolCall;
  ToolResult: ToolResult;
  TriageCommit: TriageCommit;
  TriageInput: TriageInput;
  TriagePreview: TriagePreview;
  User: User;
  UserCreate: UserCreate;
  UserPage: UserPage;
  UserPatch: UserPatch;
  Verdict: Verdict;
  WorkerClaim: WorkerClaim;
}
