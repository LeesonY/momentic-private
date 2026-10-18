/* Generated from docs/contracts/*.json. DO NOT EDIT. Runtime schemas are authoritative for refinements. */

export type Contract =
  | ActionPermit
  | ActionReservation
  | ActionResult
  | AgentLoginConfig
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
  | AuthVariable
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
  | ConfigDeleteConfirm
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
  | FollowUpInput
  | FormConfig
  | Health
  | HeartbeatInput
  | HeartbeatResult
  | InputRequest
  | InputRequestPage
  | InputResponse
  | JsonValue
  | Knowledge
  | KnowledgeCreate
  | KnowledgePage
  | KnowledgePatch
  | Lease
  | Locator
  | LocatorRepairSuggestion
  | LoginInput
  | LoginResult
  | Member
  | MemberPage
  | MemberUpdate
  | MessageInput
  | ModelBinding
  | ModelCapabilities
  | ModelDeleteConfirm
  | ModelGrantCreate
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
  | ProjectDeleteConfirm
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
  | RepairCandidateEvidence
  | RepairCandidateEvidencePage
  | RepairCandidateVerification
  | RepairCandidateVerificationPage
  | RepairProposal
  | RepairProposalCreate
  | RepairProposalPage
  | RepairProposalReviewInput
  | RepairSuggestionRecord
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
  | RunDeleteConfirm
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
  | ScheduleOccurrence
  | ScheduleOccurrencePage
  | SchedulePage
  | SchedulePatch
  | ScheduleRunTemplate
  | SessionCase
  | SessionConclusion
  | SessionCriterion
  | SessionDecision
  | SessionDuplicateFinding
  | SessionLocator
  | SessionReport
  | SessionRound
  | SnapshotNode
  | Step
  | StepPage
  | Summary
  | Task
  | TaskComplete
  | TaskIntent
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
export type FormConfig = {
  loginUrl: string;
  detectionMode?: "ai" | "manual";
  usernameTarget?: Locator;
  passwordTarget?: Locator;
  submitTarget?: Locator;
  successCriterion?: Criterion;
  otpTarget?: Locator;
};
export type AuthProfileCreate = {
  environmentId?: string | null;
  name: string;
  mode: "none" | "form" | "storage_state" | "agent";
  /**
   * @minItems 1
   * @maxItems 30
   */
  allowedOrigins: [string, ...string[]];
  sharingPolicy?: "exclusive_run" | "shared_state";
  formConfig?: FormConfig;
  agentConfig?: AgentLoginConfig;
  secretInput?: {
    [k: string]: string | undefined;
  };
  storageCriterion?: Criterion;
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
      maxToolCalls?: number;
      minToolCalls?: number;
      /**
       * @minItems 1
       * @maxItems 4
       */
      requiredToolSequence?: [
        "click" | "type_text" | "select_option" | "press" | "scroll" | "wait_for",
        ...("click" | "type_text" | "select_option" | "press" | "scroll" | "wait_for")[]
      ];
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
   * @maxItems 1000
   */
  evidenceRefs: string[];
  reproductionRef: string | null;
  triageDisposition: "open" | "accepted" | "duplicate" | "works_as_intended" | "cannot_reproduce" | "closed";
  version: number;
  duplicateOf?: string | null;
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
export type TaskIntent = "flow" | "explore" | "reproduce" | "plan" | "changes" | "spec";
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
    | "run.finished"
    | "session.updated"
    | "auth.profile_version_changed";
  at: string;
  payload: {
    [k: string]: JsonValue | undefined;
  };
};
export type ScheduleRunTemplate = RunCreate | RegressionRunCreate;

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
  requiresLogin?: boolean;
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
export interface AgentLoginConfig {
  loginUrl?: string;
  instructions: string;
  /**
   * @minItems 1
   * @maxItems 20
   */
  variables: [AuthVariable, ...AuthVariable[]];
}
export interface AuthVariable {
  name: string;
  sensitive: boolean;
  note?: string;
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
  mode: "none" | "form" | "storage_state" | "agent";
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
  agentConfig?: AgentLoginConfig | null;
  storageCriterion?: Criterion;
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
  /**
   * @minItems 1
   * @maxItems 30
   */
  allowedOrigins?: [string, ...string[]];
  name?: string;
  sharingPolicy?: "exclusive_run" | "shared_state";
  formConfig?: FormConfig;
  agentConfig?: AgentLoginConfig;
  secretInput?: {
    [k: string]: string | undefined;
  };
  revoke?: boolean;
  storageCriterion?: Criterion;
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
  settled?: boolean;
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
  inputType?: string;
  sensitive?: boolean;
  value?: string;
  relatedNodeId?: string;
  placeholder?: string;
  invalid?: boolean;
  enterButtonNodeId?: string;
  focused?: boolean;
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
  /**
   * @minItems 0
   * @maxItems 30
   */
  verified?: string[];
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
  requiresLogin?: boolean;
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
export interface ConfigDeleteConfirm {
  expectedVersion: number;
  confirmName: string;
}
export interface CredentialMaterial {
  mode: "none" | "form" | "storage_state" | "agent";
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
export interface FollowUpInput {
  expectedVersion: number;
  text: string;
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
  /**
   * @minItems 0
   * @maxItems 4
   */
  options?: string[];
}
export interface InputRequestPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: InputRequest[];
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
export interface LocatorRepairSuggestion {
  kind: "locator_name_variation" | "locator_semantic_candidate";
  source: RegressionStepSource;
  original: Locator;
  proposed: Locator;
  reasonCode: "LOCATOR_NOT_FOUND";
  snapshotId: string;
  pageId: string;
  observedOrigin: string;
  reviewRequired: true;
  verification: "not_run";
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
export interface ModelDeleteConfirm {
  expectedVersion: number;
  confirmName: string;
}
export interface ModelGrantCreate {
  modelProfileId: string;
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
  adapter: "openai_compatible" | "anthropic_messages";
  dataBoundary: "internal" | "external";
  capabilities: ModelCapabilities;
  status: "untested" | "ready" | "degraded" | "disabled";
  version: number;
  responseFormat?: "json_schema" | "json_object" | "native_tools";
  maxOutputTokens?: number;
  contextWindowTokens?: number;
}
export interface ModelProfileCreate {
  name: string;
  endpoint: string;
  configuredModelId: string;
  adapter: "openai_compatible" | "anthropic_messages";
  dataBoundary: "internal" | "external";
  apiKey?: string;
  responseFormat?: "json_schema" | "json_object" | "native_tools";
  maxOutputTokens?: number;
  contextWindowTokens?: number;
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
  adapter?: "openai_compatible" | "anthropic_messages";
  name?: string;
  endpoint?: string;
  configuredModelId?: string;
  apiKey?: string;
  status?: "disabled" | "untested";
  responseFormat?: "json_schema" | "json_object" | "native_tools";
  maxOutputTokens?: number;
  contextWindowTokens?: number | null;
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
  maxOutputTokens?: number;
  outputSchema: {
    [k: string]: unknown | undefined;
  };
  criterionId?: string;
  /**
   * @minItems 0
   * @maxItems 16
   */
  sensitiveValues?: string[];
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
export interface ProjectDeleteConfirm {
  expectedVersion: number;
  confirmName: string;
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
export interface RepairCandidateEvidence {
  id: string;
  verificationId: string;
  candidateVersionId: string;
  stepIndex: number;
  stepKind: "navigate" | "click" | "type_text" | "assert";
  criterionId: string | null;
  criterionPassed: boolean | null;
  snapshotId: string;
  snapshotSha256: string;
  displayUrl: string;
  screenshotSha256: string | null;
  screenshotBytes: number | null;
  retention: "available" | "purged";
  purgedAt: string | null;
  createdAt: string;
}
export interface RepairCandidateEvidencePage {
  /**
   * @minItems 0
   * @maxItems 30
   */
  items: RepairCandidateEvidence[];
}
export interface RepairCandidateVerification {
  id: string;
  projectId: string;
  proposalId: string;
  caseId: string;
  candidateVersionId: string;
  candidateSha256: string;
  status: "queued" | "running" | "completed";
  outcome: ("passed" | "failed" | "inconclusive") | null;
  reasonCode: string | null;
  observedSteps: number;
  verifiedCriteria: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface RepairCandidateVerificationPage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: RepairCandidateVerification[];
  nextCursor: string | null;
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
  reviewReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
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
  /**
   * @minItems 0
   * @maxItems 10
   */
  repairSuggestions?: RepairSuggestionRecord[];
}
export interface RepairSuggestionRecord {
  runId: string;
  taskId: string;
  sourceVersionId: string;
  suggestion: LocatorRepairSuggestion;
}
export interface RepairProposalReviewInput {
  decision: "approve" | "reject";
  reason: string;
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
  session?: SessionReport;
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
  title?: string | null;
  stats?: {
    cases: number;
    passed: number;
    issues: number;
    blocked: number;
    findings: number;
  } | null;
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
  taskIntent?: TaskIntent;
  /**
   * @minItems 0
   * @maxItems 30
   */
  writeScope?: string[];
  previousRunId?: string;
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
export interface SessionReport {
  objective: string;
  round: number;
  status: "planning" | "working" | "reviewing" | "finalizing" | "complete";
  plan: string;
  /**
   * @minItems 0
   * @maxItems 30
   */
  caseIds: string[];
  /**
   * @minItems 0
   * @maxItems 30
   */
  exploredUrls: string[];
  /**
   * @minItems 0
   * @maxItems 100
   */
  coverageGaps: string[];
  summary: string;
  /**
   * @minItems 0
   * @maxItems 64
   */
  history: SessionRound[];
  messageCursor?: string | null;
  /**
   * @minItems 0
   * @maxItems 200
   */
  reviewedTaskIds?: string[];
  planningStopped?: boolean;
  invalidPlanStreak?: number;
  lastPlanFailure?: {
    reasonCode: "MODEL_OUTPUT_TRUNCATED" | "VALIDATION_ERROR" | "TARGET_NOT_ALLOWED";
    /**
     * @minItems 0
     * @maxItems 6
     */
    schemaErrors: string[];
  } | null;
  title?: string | null;
}
export interface SessionRound {
  round: number;
  reason: string;
  /**
   * @minItems 0
   * @maxItems 30
   */
  caseIds: string[];
  /**
   * @minItems 0
   * @maxItems 30
   */
  exploreTargets: string[];
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
  modelProfileId?: string;
  mode?: "smoke";
  budget?: BudgetOverrides;
  taskIntent?: TaskIntent;
  /**
   * @minItems 0
   * @maxItems 30
   */
  writeScope?: string[];
  actionPolicy?: "non_submitting" | "approved_workflows";
}
export interface RunDeleteConfirm {
  expectedVersion: number;
  confirmRunId: string;
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
  runTemplate: ScheduleRunTemplate;
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
  runTemplate: ScheduleRunTemplate;
  overlapPolicy?: "skip" | "queue";
  missedPolicy?: "skip" | "catchup_one";
  enabled?: boolean;
}
export interface ScheduleOccurrence {
  id: string;
  scheduleId: string;
  projectId: string;
  scheduleVersion: number;
  scheduledAt: string;
  scheduledLocal: string;
  status: "pending" | "dispatching" | "started" | "skipped" | "failed";
  runId: string | null;
  createdAt: string;
}
export interface ScheduleOccurrencePage {
  /**
   * @minItems 0
   * @maxItems 100
   */
  items: ScheduleOccurrence[];
  nextCursor: string | null;
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
  runTemplate?: ScheduleRunTemplate;
  overlapPolicy?: "skip" | "queue";
  missedPolicy?: "skip" | "catchup_one";
  enabled?: boolean;
}
export interface SessionCase {
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
   * @maxItems 3
   */
  criteria: [SessionCriterion, ...SessionCriterion[]];
  entryUrl: string;
  requiresLogin?: boolean;
}
export interface SessionCriterion {
  id: string;
  kind: "element_visible" | "text_equals" | "url_matches" | "http_status" | "semantic" | "visual";
  description: string;
  sourceKind: "generic_smoke" | "user_spec" | "project_knowledge" | "saved_case" | "inferred";
  sourceRef: string;
  locator: SessionLocator | null;
  expectedValue: string | null;
  sourceQuote: string;
}
export interface SessionLocator {
  by: "role" | "label" | "test_id" | "text" | "css";
  value: string;
  name: string | null;
}
export interface SessionConclusion {
  overview: string;
  /**
   * @minItems 0
   * @maxItems 30
   */
  caseComments: {
    caseId: string;
    comment: string;
  }[];
  /**
   * @minItems 0
   * @maxItems 20
   */
  coverageGaps: string[];
}
export interface SessionDecision {
  action: "dispatch" | "finish" | "ask";
  rationale: string;
  /**
   * @minItems 0
   * @maxItems 2
   */
  exploreTargets: string[];
  /**
   * @minItems 0
   * @maxItems 4
   */
  cases: SessionCase[];
  /**
   * @minItems 0
   * @maxItems 20
   */
  coverageGaps: string[];
  question?: string;
  title?: string;
  /**
   * @minItems 0
   * @maxItems 4
   */
  options?: string[];
  /**
   * @minItems 0
   * @maxItems 30
   */
  duplicateFindings?: SessionDuplicateFinding[];
  /**
   * @minItems 0
   * @maxItems 30
   */
  retryCaseIds?: string[];
}
export interface SessionDuplicateFinding {
  findingId: string;
  sameAs: string;
  reason: string;
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
  reasonCode?: string | null;
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
  AgentLoginConfig: AgentLoginConfig;
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
  AuthVariable: AuthVariable;
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
  ConfigDeleteConfirm: ConfigDeleteConfirm;
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
  FollowUpInput: FollowUpInput;
  FormConfig: FormConfig;
  Health: Health;
  HeartbeatInput: HeartbeatInput;
  HeartbeatResult: HeartbeatResult;
  InputRequest: InputRequest;
  InputRequestPage: InputRequestPage;
  InputResponse: InputResponse;
  JsonValue: JsonValue;
  Knowledge: Knowledge;
  KnowledgeCreate: KnowledgeCreate;
  KnowledgePage: KnowledgePage;
  KnowledgePatch: KnowledgePatch;
  Lease: Lease;
  Locator: Locator;
  LocatorRepairSuggestion: LocatorRepairSuggestion;
  LoginInput: LoginInput;
  LoginResult: LoginResult;
  Member: Member;
  MemberPage: MemberPage;
  MemberUpdate: MemberUpdate;
  MessageInput: MessageInput;
  ModelBinding: ModelBinding;
  ModelCapabilities: ModelCapabilities;
  ModelDeleteConfirm: ModelDeleteConfirm;
  ModelGrantCreate: ModelGrantCreate;
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
  ProjectDeleteConfirm: ProjectDeleteConfirm;
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
  RepairCandidateEvidence: RepairCandidateEvidence;
  RepairCandidateEvidencePage: RepairCandidateEvidencePage;
  RepairCandidateVerification: RepairCandidateVerification;
  RepairCandidateVerificationPage: RepairCandidateVerificationPage;
  RepairProposal: RepairProposal;
  RepairProposalCreate: RepairProposalCreate;
  RepairProposalPage: RepairProposalPage;
  RepairProposalReviewInput: RepairProposalReviewInput;
  RepairSuggestionRecord: RepairSuggestionRecord;
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
  RunDeleteConfirm: RunDeleteConfirm;
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
  ScheduleOccurrence: ScheduleOccurrence;
  ScheduleOccurrencePage: ScheduleOccurrencePage;
  SchedulePage: SchedulePage;
  SchedulePatch: SchedulePatch;
  ScheduleRunTemplate: ScheduleRunTemplate;
  SessionCase: SessionCase;
  SessionConclusion: SessionConclusion;
  SessionCriterion: SessionCriterion;
  SessionDecision: SessionDecision;
  SessionDuplicateFinding: SessionDuplicateFinding;
  SessionLocator: SessionLocator;
  SessionReport: SessionReport;
  SessionRound: SessionRound;
  SnapshotNode: SnapshotNode;
  Step: Step;
  StepPage: StepPage;
  Summary: Summary;
  Task: Task;
  TaskComplete: TaskComplete;
  TaskIntent: TaskIntent;
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
