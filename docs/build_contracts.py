"""Generate LocalQA v1 documentation contracts and fictional examples (stdlib only)."""
from pathlib import Path
import copy
import json

ROOT = Path(__file__).resolve().parent
D = {}
def ref(name): return {"$ref": f"#/$defs/{name}"}
def text(maximum=4000, **extra): return {"type": "string", "maxLength": maximum, **extra}
def enum(*values): return {"type": "string", "enum": list(values)}
def integer(low=0, high=None, **extra):
    return {"type": "integer", "minimum": low, **({"maximum": high} if high is not None else {}), **extra}
def arr(items, maximum=1000, minimum=0): return {"type": "array", "items": items, "maxItems": maximum, "minItems": minimum}
def obj(properties, required=None, **extra):
    return {"type": "object", "properties": properties, "required": list(properties) if required is None else required, "additionalProperties": False, **extra}
def nullable(schema): return {"anyOf": [schema, {"type": "null"}]}
UUID = {"type": "string", "format": "uuid"}
DATE = {"type": "string", "format": "date-time"}
URI = {"type": "string", "format": "uri", "maxLength": 8192, "pattern": "^https?://"}
BOOL = {"type": "boolean"}
VER = integer(1)
D["JsonValue"] = {"anyOf": [{"type": t} for t in ["string", "number", "boolean", "null"]] + [{"type": "array", "items": ref("JsonValue")}, {"type": "object", "additionalProperties": ref("JsonValue")} ]}
D["Error"] = obj({"code": text(80, minLength=1), "message": text(), "requestId": UUID, "details": ref("JsonValue")}, ["code", "message", "requestId"])
D["User"] = obj({"id": UUID, "email": {"type": "string", "format": "email"}, "displayName": text(120), "globalRole": enum("admin", "member")})
D["LoginInput"] = obj({"email": {"type": "string", "format": "email"}, "password": text(128, minLength=8, writeOnly=True)})
D["LoginResult"] = obj({"user": ref("User"), "expiresAt": DATE})
D["Project"] = obj({"id": UUID, "name": text(120, minLength=1), "status": enum("active", "archived"), "version": VER, "createdAt": DATE})
D["ProjectCreate"] = obj({"name": text(120, minLength=1)})
D["Member"] = obj({"userId": UUID, "role": enum("owner", "operator", "viewer")})
D["MemberUpdate"] = obj({"expectedVersion": VER, "members": arr(ref("Member"), 100, 1)})
limits = {
    "maxCases": integer(1, 30, default=8), "maxPages": integer(1, 30, default=6),
    "maxDepth": integer(0, 5, default=2), "maxActiveSeconds": integer(60, 3600, default=600),
    "maxActionsPerCase": integer(1, 30, default=12), "maxActions": integer(10, 1000, default=120),
    "maxModelCalls": integer(1, 500, default=100), "maxReproductions": integer(0, 10, default=3),
    "concurrency": integer(1, 25, default=2), "maxTotalTokens": integer(1000, 5000000, default=300000),
}
D["BudgetLimits"] = obj(limits)
D["BudgetOverrides"] = obj(copy.deepcopy(limits), [])
D["BudgetUsed"] = obj({k: integer() for k in ["activeSeconds", "actions", "modelCalls", "reproductions", "totalTokens"]})
D["Environment"] = obj({"id": UUID, "projectId": UUID, "name": text(120), "baseUrl": URI, "allowedOrigins": arr(URI, 30, 1), "excludedPaths": arr(text(300), 100), "tlsPolicy": enum("strict", "allow_self_signed"), "defaultAuthProfileId": nullable(UUID), "version": VER})
D["EnvironmentCreate"] = obj({k: v for k, v in D["Environment"]["properties"].items() if k not in ["id", "projectId", "version"]}, ["name", "baseUrl", "allowedOrigins", "tlsPolicy"])
D["EnvironmentPatch"] = obj({"expectedVersion": VER, **copy.deepcopy(D["EnvironmentCreate"]["properties"])}, ["expectedVersion"])
D["ConfigDeleteConfirm"] = obj({"expectedVersion": VER, "confirmName": text(120, minLength=1)})
D["Locator"] = obj({"by": enum("role", "label", "test_id", "text", "css"), "value": text(500, minLength=1), "name": text(500)}, ["by", "value"])
D["Criterion"] = obj({"id": text(64, pattern="^[a-zA-Z0-9_.-]+$"), "kind": enum("element_visible", "text_equals", "url_matches", "http_status", "semantic", "visual"), "description": text(2000, minLength=1), "sourceKind": enum("generic_smoke", "user_spec", "project_knowledge", "saved_case", "inferred"), "sourceRef": text(500, minLength=1), "locator": ref("Locator"), "expectedValue": ref("JsonValue")}, ["id", "kind", "description", "sourceKind", "sourceRef"])
D["CandidateCase"] = obj({"title": text(200, minLength=1), "summary": text(), "preconditions": arr(text(1000), 20), "outline": arr(text(1500), 30, 1), "criteria": arr(ref("Criterion"), 20, 1)})
D["CaseDefinition"] = obj({"id": UUID, "runId": UUID, "projectId": UUID, "version": VER, **copy.deepcopy(D["CandidateCase"]["properties"])})
AUTH_MODES = ("none", "form", "storage_state", "agent")
D["AuthProfile"] = obj({"id": UUID, "projectId": UUID, "environmentId": nullable(UUID), "name": text(120), "mode": enum(*AUTH_MODES), "allowedOrigins": arr(URI, 30, 1), "sharingPolicy": enum("exclusive_run", "shared_state"), "hasSecret": BOOL, "version": VER})
D["FormConfig"] = obj({"loginUrl": URI, "detectionMode": enum("ai", "manual"), "usernameTarget": ref("Locator"), "passwordTarget": ref("Locator"), "submitTarget": ref("Locator"), "successCriterion": ref("Criterion"), "otpTarget": ref("Locator")}, ["loginUrl"])
D["FormConfig"]["allOf"] = [{"if": {"properties": {"detectionMode": {"const": "ai"}}, "required": ["detectionMode"]}, "then": {}, "else": {"required": ["usernameTarget", "passwordTarget", "submitTarget", "successCriterion"]}}]
# Agent (Mo-style) sign-in: values live only in the write-only secretInput keyed
# by variable name; the model sees names, notes and instructions, never values.
D["AuthVariable"] = obj({"name": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{0,63}$"}, "sensitive": BOOL, "note": text(200)}, ["name", "sensitive"])
D["AgentLoginConfig"] = obj({"loginUrl": URI, "instructions": text(4000, minLength=1), "variables": arr(ref("AuthVariable"), 20, 1)}, ["instructions", "variables"])
D["AuthProfileCreate"] = obj({"environmentId": nullable(UUID), "name": text(120, minLength=1), "mode": enum(*AUTH_MODES), "allowedOrigins": arr(URI, 30, 1), "sharingPolicy": {**enum("exclusive_run", "shared_state"), "default": "exclusive_run"}, "formConfig": ref("FormConfig"), "agentConfig": ref("AgentLoginConfig"), "secretInput": {"type": "object", "writeOnly": True, "additionalProperties": text(1000000)}}, ["name", "mode", "allowedOrigins"])
D["AuthProfilePatch"] = obj({"expectedVersion": VER, "name": text(120), "sharingPolicy": enum("exclusive_run", "shared_state"), "formConfig": ref("FormConfig"), "agentConfig": ref("AgentLoginConfig"), "secretInput": copy.deepcopy(D["AuthProfileCreate"]["properties"]["secretInput"]), "revoke": BOOL}, ["expectedVersion"])
D["Knowledge"] = obj({"id": UUID, "projectId": UUID, "title": text(200), "kind": enum("terminology", "rule", "flow", "restriction"), "text": text(20000), "approved": BOOL, "version": VER})
D["KnowledgeCreate"] = obj({"title": text(200, minLength=1), "kind": enum("terminology", "rule", "flow", "restriction"), "text": text(20000, minLength=1)})
D["KnowledgePatch"] = obj({"expectedVersion": VER, "title": text(200), "text": text(20000), "approved": BOOL}, ["expectedVersion"])
D["ModelCapabilities"] = obj({"structuredOutput": BOOL, "nativeTools": BOOL, "imageInput": BOOL})
D["ModelProfile"] = obj({"id": UUID, "name": text(120), "endpoint": URI, "configuredModelId": text(200, minLength=1), "adapter": enum("openai_compatible", "anthropic_messages"), "dataBoundary": enum("internal", "external"), "capabilities": ref("ModelCapabilities"), "status": enum("untested", "ready", "degraded", "disabled"), "version": VER})
D["ModelProfileCreate"] = obj({"name": text(120, minLength=1), "endpoint": URI, "configuredModelId": text(200, minLength=1), "adapter": enum("openai_compatible", "anthropic_messages"), "dataBoundary": enum("internal", "external"), "apiKey": text(1000, writeOnly=True)}, ["name", "endpoint", "configuredModelId", "adapter", "dataBoundary"])
# Per-model output cap for every call (decisions, assertions, probes). Models
# that reason before answering need room; unset means the gateway default.
MODEL_OUTPUT_TOKENS = integer(256, 32000)
MODEL_CONTEXT_TOKENS = integer(1024, 2000000)
for model_schema in ["ModelProfile", "ModelProfileCreate"]:
    D[model_schema]["properties"]["responseFormat"] = enum("json_schema", "json_object", "native_tools")
    D[model_schema]["properties"]["maxOutputTokens"] = copy.deepcopy(MODEL_OUTPUT_TOKENS)
    D[model_schema]["properties"]["contextWindowTokens"] = copy.deepcopy(MODEL_CONTEXT_TOKENS)
D["ModelProbeResult"] = obj({"profileId": UUID, "capabilities": ref("ModelCapabilities"), "status": enum("ready", "degraded", "disabled"), "notes": arr(text(1000), 20)})
D["ModelGrantCreate"] = obj({"modelProfileId": UUID}, ["modelProfileId"])
D["RunCreate"] = obj({"projectId": UUID, "targetUrl": URI, "brief": text(4000), "environmentId": UUID, "authProfileId": UUID, "modelProfileId": UUID, "mode": enum("smoke"), "budget": ref("BudgetOverrides")}, ["projectId", "targetUrl"])
D["RunDeleteConfirm"] = obj({"expectedVersion": VER, "confirmRunId": UUID})
D["TaskIntent"] = enum("flow", "explore", "reproduce", "plan", "changes", "spec")
D["FollowUpInput"] = obj({"expectedVersion": VER, "text": text(4000, minLength=1)})
D["RunConfig"] = obj({"allowedOrigins": arr(URI, 30, 1), "actionPolicy": enum("non_submitting", "approved_workflows"), "budget": ref("BudgetLimits"), "environmentVersion": nullable(VER), "authProfileVersion": nullable(VER), "modelProfileIds": arr(UUID, 10, 1), "knowledgeVersionIds": arr(UUID, 100)})
for name in ["RunCreate", "RunConfig"]:
    D[name]["properties"]["taskIntent"] = ref("TaskIntent")
    D[name]["properties"]["writeScope"] = arr(URI, 30)
D["RunCreate"]["properties"]["actionPolicy"] = enum("non_submitting", "approved_workflows")
D["RunConfig"]["properties"]["previousRunId"] = UUID
RUN_STATUS = ["draft", "queued", "running", "awaiting_input", "cancelling", "completed", "cancelled", "failed"]
PHASE = ["preflight", "auth", "explore", "plan", "execute", "reproduce", "finalize"]
REASONS = ["normal", "budget_limit", "input_timeout", "user_cancel", "worker_failure", "model_failure", "setup_failure"]
D["Run"] = obj({"id": UUID, "projectId": UUID, "creatorId": UUID, "targetUrl": URI, "status": enum(*RUN_STATUS), "phase": enum(*PHASE), "completion": enum("complete", "partial", "none"), "terminationReason": nullable(enum(*REASONS)), "contextVersion": VER, "effectiveConfig": ref("RunConfig"), "budgetUsed": ref("BudgetUsed"), "createdAt": DATE, "updatedAt": DATE, "version": VER})
D["CriterionResult"] = obj({"criterionId": text(64), "result": enum("passed", "failed", "not_evaluated", "unknown"), "reason": text(2000), "evidenceRefs": arr(UUID, 30)})
D["Verdict"] = obj({"id": UUID, "caseId": UUID, "attemptId": UUID, "status": enum("passed", "issue_found", "blocked", "inconclusive"), "reasonCode": text(80), "summary": text(), "criterionResults": arr(ref("CriterionResult"), 20), "gaps": arr(text(2000), 30), "createdAt": DATE})
D["CaseRecord"] = obj({"definition": ref("CaseDefinition"), "outcome": enum("passed", "issue_found", "blocked", "inconclusive", "not_run"), "verdict": nullable(ref("Verdict"))})
D["Task"] = obj({"id": UUID, "runId": UUID, "role": enum("coordinator", "explorer", "executor", "reproducer", "finalizer"), "status": enum("queued", "running", "waiting", "succeeded", "failed", "cancelled", "interrupted"), "caseId": nullable(UUID), "attempt": VER, "summary": text(), "elapsedSeconds": integer()})
D["Artifact"] = obj({"id": UUID, "projectId": UUID, "runId": UUID, "kind": enum("screenshot", "trace", "rrweb", "network", "console", "export", "other"), "status": enum("available", "degraded", "missing", "failed"), "bytes": nullable(integer()), "sha256": nullable(text(64, pattern="^[0-9a-f]{64}$")), "contentUrl": nullable({"type": "string", "format": "uri-reference"}), "redaction": enum("applied", "not_needed", "failed"), "error": nullable(text(1000)), "createdAt": DATE})
D["Finding"] = obj({"id": UUID, "runId": UUID, "caseIds": arr(UUID, 30), "kind": enum("functional", "static"), "status": enum("suspected", "confirmed", "unconfirmed", "blocked"), "title": text(200), "severity": enum("critical", "high", "medium", "low", "info"), "expected": text(), "actual": text(), "expectedSource": enum("generic_smoke", "user_spec", "project_knowledge", "saved_case", "inferred"), "reproSteps": arr(text(1500), 30), "evidenceRefs": arr(UUID, 30), "reproductionRef": nullable(UUID), "triageDisposition": enum("open", "accepted", "duplicate", "works_as_intended", "cannot_reproduce", "closed"), "version": VER})
D["Finding"]["allOf"] = [{"if": {"properties": {"kind": {"const": "functional"}, "status": {"const": "confirmed"}}, "required": ["kind", "status"]}, "then": {"properties": {"reproductionRef": UUID, "expectedSource": {"not": {"const": "inferred"}}, "evidenceRefs": arr(UUID, 30, 1)}}}]
D["Reproduction"] = obj({"id": UUID, "findingId": UUID, "taskId": UUID, "outcome": enum("reproduced", "not_reproduced", "blocked"), "freshContext": {"const": True}, "summary": text(), "evidenceRefs": arr(UUID, 30), "createdAt": DATE})
D["Summary"] = obj({**{k: integer() for k in ["planned", "passed", "issueFound", "blocked", "inconclusive", "notRun", "attempted", "evaluated"]}, "passRate": nullable({"type": "number", "minimum": 0, "maximum": 1}), "attemptRate": nullable({"type": "number", "minimum": 0, "maximum": 1})})
D["ModelUsage"] = obj({"profileId": UUID, "configuredModelId": text(200), "reportedModelId": nullable(text(200)), "requests": integer(), "inputTokens": nullable(integer()), "outputTokens": nullable(integer()), "usageSource": enum("reported", "estimated", "mixed", "unknown")})
D["Report"] = obj({"schemaVersion": {"const": 1}, "example": BOOL, "generatedAt": DATE, "run": ref("Run"), "summary": ref("Summary"), "cases": arr(ref("CaseRecord"), 1000), "findings": arr(ref("Finding"), 1000), "reproductions": arr(ref("Reproduction"), 1000), "artifacts": arr(ref("Artifact"), 5000), "modelUsage": arr(ref("ModelUsage"), 100), "coverageGaps": arr(text(2000), 1000), "cleanupStatus": enum("not_required", "pending", "running", "succeeded", "failed", "manual_required"), "warnings": arr(text(2000), 1000)})
D["SessionLocator"] = obj({"by": D["Locator"]["properties"]["by"], "value": text(500, minLength=1), "name": nullable(text(500))})
D["SessionCriterion"] = obj({**copy.deepcopy(D["Criterion"]["properties"]), "locator": nullable(ref("SessionLocator")), "expectedValue": nullable(text(2000)), "sourceQuote": text(1000)})
D["SessionCase"] = obj({**copy.deepcopy(D["CandidateCase"]["properties"]), "entryUrl": URI, "criteria": arr(ref("SessionCriterion"), 3, 1)})
D["SessionDecision"] = obj({"action": enum("dispatch", "finish", "ask"), "rationale": text(2000, minLength=1), "exploreTargets": arr(URI, 2), "cases": arr(ref("SessionCase"), 4), "coverageGaps": arr(text(1000), 20)})
D["SessionDecision"]["properties"]["question"] = text(2000, minLength=1)
D["SessionDecision"]["properties"]["title"] = text(60)
D["SessionDecision"]["properties"]["options"] = arr(text(120, minLength=1), 4)
D["SessionConclusion"] = obj({"overview": text(4000, minLength=1), "caseComments": arr(obj({"caseId": UUID, "comment": text(1000)}), 30), "coverageGaps": arr(text(1000), 20)})
D["SessionRound"] = obj({"round": integer(1, 64), "reason": text(2000), "caseIds": arr(UUID, 30), "exploreTargets": arr(URI, 30)})
D["SessionReport"] = obj({"objective": text(4000), "round": integer(0, 64), "status": enum("planning", "working", "reviewing", "finalizing", "complete"), "plan": text(2000), "caseIds": arr(UUID, 30), "exploredUrls": arr(URI, 30), "coverageGaps": arr(text(2000), 100), "summary": text(4000), "history": arr(ref("SessionRound"), 64)})
D["SessionReport"]["properties"]["messageCursor"] = nullable(UUID)
D["SessionReport"]["properties"]["reviewedTaskIds"] = arr(UUID, 200)
D["SessionReport"]["properties"]["planningStopped"] = BOOL
D["SessionReport"]["properties"]["title"] = nullable(text(60))
D["Report"]["properties"]["session"] = ref("SessionReport")
D["InputRequest"] = obj({"id": UUID, "runId": UUID, "kind": enum("auth_profile", "one_time_code", "clarification", "scope_extension", "write_action"), "status": enum("pending", "resolved", "rejected", "expired"), "prompt": text(2000), "expiresAt": DATE, "version": VER})
D["InputRequest"]["properties"]["options"] = arr(text(120, minLength=1), 4)
D["InputRequestPage"] = obj({"items": arr(ref("InputRequest"), 100)})
D["InputResponse"] = obj({"expectedVersion": VER, "decision": enum("provide", "approve", "reject"), "authProfileId": UUID, "text": text(4000), "oneTimeCode": text(32, minLength=4, writeOnly=True), "allowedOrigins": arr(URI, 30)}, ["expectedVersion", "decision"])
D["MessageInput"] = obj({"text": text(4000, minLength=1), "expectedContextVersion": VER})
D["RunMessage"] = obj({"id": UUID, "runId": UUID, "actorId": UUID, "contextVersion": VER, "redactedText": text(4000), "createdAt": DATE})
D["TriageInput"] = obj({"expectedVersion": VER, "disposition": enum("accepted", "duplicate", "works_as_intended", "cannot_reproduce", "closed"), "reason": text(2000, minLength=1)})
D["TriagePreview"] = obj({"findingId": UUID, "expectedVersion": VER, "disposition": D["TriageInput"]["properties"]["disposition"], "reason": text(2000), "confirmationToken": text(1000), "expiresAt": DATE})
D["TriageCommit"] = obj({**copy.deepcopy(D["TriageInput"]["properties"]), "confirmationToken": text(1000, minLength=1)})
D["ExportInput"] = obj({"format": enum("json", "markdown", "zip"), "includeArtifacts": BOOL, "requireTerminal": BOOL}, ["format"])
D["Export"] = obj({"id": UUID, "runId": UUID, "status": enum("queued", "running", "ready", "failed"), "format": enum("json", "markdown", "zip"), "artifactId": nullable(UUID), "snapshotAt": DATE, "error": nullable(text(1000))})
EVENTS = ["run.updated", "phase.changed", "task.updated", "case.created", "case.result", "finding.updated", "step.recorded", "budget.updated", "input.requested", "input.resolved", "artifact.updated", "report.ready", "run.finished"]
EVENTS.append("session.updated")
D["RunEvent"] = obj({"schemaVersion": {"const": 1}, "id": text(30, pattern="^[1-9][0-9]*$"), "runId": UUID, "seq": VER, "type": enum(*EVENTS), "at": DATE, "payload": {"type": "object", "additionalProperties": ref("JsonValue")}})
D["NodeTarget"] = obj({"snapshotId": UUID, "pageId": UUID, "frameId": text(120), "nodeId": text(120)}, ["snapshotId", "pageId", "nodeId"])
D["WorkerClaim"] = obj({"workerId": text(120, minLength=1), "capabilities": arr(enum("chromium", "images", "recording"), 10, 1)})
D["Lease"] = obj({"task": ref("Task"), "fencingToken": VER, "leaseToken": text(2000), "leaseUntil": DATE, "contextVersion": VER})
D["HeartbeatInput"] = obj({"fencingToken": VER, "contextVersion": VER})
D["HeartbeatResult"] = obj({"leaseUntil": DATE, "cancelRequested": BOOL, "contextVersion": VER})
D["TaskComplete"] = obj({"fencingToken": VER, "status": enum("succeeded", "failed", "cancelled", "interrupted"), "result": ref("JsonValue"), "resultHash": text(64, pattern="^[0-9a-f]{64}$")})
D["ActionReservation"] = obj({"taskId": UUID, "fencingToken": VER, "contextVersion": VER, "toolCall": {"type": "object", "properties": {"name": text(80), "args": {"type": "object"}}, "required": ["name", "args"], "additionalProperties": False}})
D["ActionPermit"] = obj({"actionId": UUID, "permitted": BOOL, "reasonCode": nullable(text(80))})
D["ActionResult"] = obj({"outcome": enum("succeeded", "failed", "unknown", "cancelled"), "summary": text(2000), "evidenceRefs": arr(UUID, 30), "resultHash": text(64, pattern="^[0-9a-f]{64}$")})
D["ModelPart"] = {"oneOf": [obj({"type": {"const": "text"}, "text": text(60000)}), obj({"type": {"const": "image"}, "artifactId": UUID})]}
D["ModelMessage"] = obj({"role": enum("system", "user", "assistant", "tool"), "content": arr(ref("ModelPart"), 20, 1)})
# maxOutputTokens is an optional caller ceiling; the bound model's own cap applies.
D["ModelRequest"] = obj({"taskId": UUID, "profileId": UUID, "contextVersion": VER, "purpose": enum("plan", "decide", "assert", "summarize"), "messages": arr(ref("ModelMessage"), 100, 1), "maxOutputTokens": integer(1, 32000), "outputSchema": {"type": "object"}}, ["taskId", "profileId", "contextVersion", "purpose", "messages", "outputSchema"])
D["ModelRequest"]["properties"]["criterionId"] = copy.deepcopy(D["Criterion"]["properties"]["id"])
D["ModelResult"] = obj({"data": ref("JsonValue"), "configuredModelId": text(200), "reportedModelId": nullable(text(200)), "usage": ref("ModelUsage")})
D["AuthResolve"] = obj({"taskId": UUID, "authProfileId": UUID, "authProfileVersion": VER})
D["CredentialMaterial"] = obj({"mode": enum(*AUTH_MODES), "material": {"type": "object", "additionalProperties": ref("JsonValue"), "x-sensitive": True}, "expiresAt": DATE})
D["Health"] = obj({"status": enum("ok", "not_ready"), "version": text(40)})
D["User"]["properties"].update({"disabled": BOOL, "version": VER})
D["User"]["required"].extend(["disabled", "version"])
D["UserCreate"] = obj({"email": {"type": "string", "format": "email"}, "displayName": text(120), "password": text(128, minLength=12, writeOnly=True), "globalRole": enum("admin", "member")}, ["email", "displayName", "password"])
D["UserPatch"] = obj({"expectedVersion": VER, "displayName": text(120), "disabled": BOOL, "password": text(128, minLength=12, writeOnly=True), "globalRole": enum("admin", "member")}, ["expectedVersion"])
D["Project"]["properties"]["defaultModelProfileId"] = nullable(UUID)
D["Project"]["required"].append("defaultModelProfileId")
D["ProjectPatch"] = obj({"expectedVersion": VER, "name": text(120), "status": enum("active", "archived"), "defaultModelProfileId": nullable(UUID)}, ["expectedVersion"])
D["ProjectDeleteConfirm"] = obj({"expectedVersion": VER, "confirmName": text(120, minLength=1)})
D["ModelDeleteConfirm"] = obj({"expectedVersion": VER, "confirmName": text(120, minLength=1)})
D["ModelProfilePatch"] = obj({"expectedVersion": VER, "name": text(120), "endpoint": URI, "configuredModelId": text(200), "apiKey": text(1000, writeOnly=True), "status": enum("disabled", "untested")}, ["expectedVersion"])
D["ModelProfilePatch"]["properties"]["responseFormat"] = enum("json_schema", "json_object", "native_tools")
D["ModelProfilePatch"]["properties"]["maxOutputTokens"] = copy.deepcopy(MODEL_OUTPUT_TOKENS)
D["ModelProfilePatch"]["properties"]["contextWindowTokens"] = nullable(copy.deepcopy(MODEL_CONTEXT_TOKENS))
D["ModelBinding"] = obj({"profileId": UUID, "version": VER})
D["RoleModels"] = obj({role: ref("ModelBinding") for role in ["coordinator", "explorer", "executor", "assertion", "reproducer"]})
D["RunConfig"]["properties"].pop("modelProfileIds")
D["RunConfig"]["required"].remove("modelProfileIds")
D["RunConfig"]["properties"]["models"] = ref("RoleModels")
D["RunConfig"]["required"].append("models")
for key in ["taskId", "stepId", "caseId", "snapshotId"]:
    D["Artifact"]["properties"][key] = nullable(UUID)
    D["Artifact"]["required"].append(key)
D["Step"] = obj({"id": UUID, "runId": UUID, "taskId": UUID, "caseId": nullable(UUID), "seq": VER, "toolName": text(80), "status": enum("running", "succeeded", "failed", "unknown", "cancelled", "skipped"), "summary": text(2000), "targetDescription": text(1000), "evidenceRefs": arr(UUID, 30), "createdAt": DATE, "finishedAt": nullable(DATE)})
D["CaseAttempt"] = obj({"id": UUID, "caseId": UUID, "taskId": UUID, "attemptNumber": VER, "status": enum("queued", "running", "completed", "interrupted", "cancelled"), "verdict": nullable(ref("Verdict")), "startedAt": nullable(DATE), "finishedAt": nullable(DATE)})
D["Bounds"] = obj({"left": {"type": "number"}, "top": {"type": "number"}, "width": {"type": "number", "minimum": 0}, "height": {"type": "number", "minimum": 0}})
D["SnapshotNode"] = obj({"nodeId": text(120, minLength=1), "frameId": text(120), "role": text(120), "name": text(1000), "text": text(2000), "visible": BOOL, "enabled": BOOL, "bounds": ref("Bounds")})
D["SnapshotNode"]["properties"]["inputType"] = text(40)
D["SnapshotNode"]["properties"]["sensitive"] = BOOL
D["NetworkEntry"] = obj({"url": text(8192), "method": text(20), "status": nullable(integer(100, 599)), "resourceType": text(40), "summary": text(1000)})
D["NetworkEntries"] = arr(ref("NetworkEntry"), 100)
D["BrowserSnapshot"] = obj({"snapshotId": UUID, "pageId": UUID, "frameIds": arr(text(120), 100), "displayUrl": text(8192), "title": text(500), "responseStatus": nullable(integer(100, 599)), "capturedAt": DATE, "stateVersion": VER, "viewport": obj({"width": integer(100, 10000), "height": integer(100, 10000)}), "nodes": arr(ref("SnapshotNode"), 1000), "screenshotRef": nullable(UUID), "networkSummary": ref("NetworkEntries"), "consoleSummary": arr(text(1000), 50), "truncated": BOOL, "redacted": BOOL})
D["ToolResult"] = obj({"requestId": UUID, "actionId": nullable(UUID), "status": enum("succeeded", "failed", "denied", "blocked", "cancelled"), "data": ref("JsonValue"), "reasonCode": nullable(text(80)), "evidenceRefs": arr(UUID, 30)})
D["Criterion"]["allOf"] = [
    {"if": {"properties": {"kind": {"enum": ["element_visible", "text_equals"]}}, "required": ["kind"]}, "then": {"required": ["locator"]}},
    {"if": {"properties": {"kind": {"enum": ["text_equals", "url_matches", "http_status"]}}, "required": ["kind"]}, "then": {"required": ["expectedValue"]}},
]
D["AuthProfileCreate"]["allOf"] = [
    {"if": {"properties": {"mode": {"const": "form"}}, "required": ["mode"]}, "then": {"required": ["formConfig", "secretInput"], "properties": {"secretInput": {"required": ["username", "password"]}}}},
    {"if": {"properties": {"mode": {"const": "storage_state"}}, "required": ["mode"]}, "then": {"required": ["secretInput", "storageCriterion"], "properties": {"secretInput": {"required": ["storageState"]}}}},
    {"if": {"properties": {"mode": {"const": "agent"}}, "required": ["mode"]}, "then": {"required": ["agentConfig", "secretInput"]}},
]
# agentConfig is optional on the stored DTO so earlier profile versions stay valid.
D["AuthProfile"]["properties"].update({"status": enum("active", "revoked"), "formConfig": nullable(ref("FormConfig")), "agentConfig": nullable(ref("AgentLoginConfig"))})
D["AuthProfile"]["required"].extend(["status", "formConfig"])
for auth_name in ("AuthProfile", "AuthProfileCreate", "AuthProfilePatch"):
    D[auth_name]["properties"]["storageCriterion"] = ref("Criterion")
event_payloads = {
    "session.updated": ref("SessionReport"),
    "run.updated": ref("Run"), "phase.changed": obj({"phase": enum(*PHASE), "contextVersion": VER}),
    "task.updated": ref("Task"), "case.created": ref("CaseDefinition"), "case.result": ref("CaseRecord"),
    "finding.updated": ref("Finding"), "step.recorded": ref("Step"),
    "budget.updated": obj({"used": ref("BudgetUsed"), "limits": ref("BudgetLimits")}),
    "input.requested": ref("InputRequest"), "input.resolved": ref("InputRequest"),
    "artifact.updated": ref("Artifact"), "report.ready": obj({"schemaVersion": {"const": 1}, "reportVersion": VER, "generatedAt": DATE}),
    "run.finished": ref("Run"),
}
D["RunEvent"]["allOf"] = [{"if": {"properties": {"type": {"const": name}}, "required": ["type"]}, "then": {"properties": {"payload": schema}}} for name, schema in event_payloads.items()]
for name in ["User", "Project", "Environment", "AuthProfile", "Knowledge", "ModelProfile", "Run", "CaseRecord", "CaseAttempt", "Step", "RunEvent", "Task", "Finding", "Member", "RunMessage", "SavedCase", "SavedCaseVersion", "Schedule", "ApiKey", "RepairProposal"]:
    D[name + "Page"] = obj({"items": arr(ref(name), 100), "nextCursor": nullable(text(2000))})

tools = {}
def tool(name, args, roles): tools[name] = obj({"name": {"const": name}, "args": args}, **{"x-roles": roles})
browser_roles = ["explorer", "executor", "reproducer"]
tool("observe", obj({"pageId": UUID}, []), browser_roles)
tool("navigate", obj({"url": URI}), browser_roles)
tool("click", obj({"target": ref("NodeTarget")}), browser_roles)
tool("type_text", obj({"target": ref("NodeTarget"), "text": text(2000)}), browser_roles)
tool("select_option", obj({"target": ref("NodeTarget"), "value": text(500)}), browser_roles)
tool("press", obj({"target": ref("NodeTarget"), "key": enum("Enter", "Escape", "Tab", "ArrowUp", "ArrowDown")}), browser_roles)
tool("scroll", obj({"pageId": UUID, "direction": enum("up", "down"), "pixels": integer(1, 2000)}), browser_roles)
tool("wait_for", obj({"pageId": UUID, "condition": enum("dom_ready", "navigation", "element_visible"), "target": ref("NodeTarget"), "timeoutMs": integer(100, 15000)}, ["pageId", "condition", "timeoutMs"]), browser_roles)
tool("assert_criterion", obj({"criterionId": text(64)}), ["executor", "reproducer"])
tool("inspect_network", obj({"pageId": UUID, "urlContains": text(300), "limit": integer(1, 100)}, ["pageId", "limit"]), browser_roles)
tool("capture", obj({"pageId": UUID, "reason": text(1000)}), browser_roles)
tool("submit_case", obj({"candidate": ref("CandidateCase")}), ["explorer", "coordinator"])
tool("report_suspect", obj({"caseId": UUID, "criterionId": text(64), "actual": text(2000), "evidenceRefs": arr(UUID, 30, 1), "reproSteps": arr(text(1500), 30, 1)}), ["executor", "explorer"])
tool("finish_case", obj({"summary": text(2000), "gaps": arr(text(1000), 30)}), ["executor"])
tool("complete_reproduction", obj({"outcome": enum("reproduced", "not_reproduced", "blocked"), "summary": text(2000), "evidenceRefs": arr(UUID, 30)}), ["reproducer"])
tool("request_input", obj({"kind": enum("auth_profile", "clarification", "scope_extension"), "prompt": text(2000)}), ["coordinator", *browser_roles])
tool_results = {**{n: "BrowserSnapshot" for n in ["observe", "navigate", "click", "type_text", "select_option", "press", "scroll", "wait_for"]}, "assert_criterion": "CriterionResult", "inspect_network": "NetworkEntries", "capture": "Artifact", "submit_case": "CaseDefinition", "report_suspect": "Finding", "finish_case": "Verdict", "complete_reproduction": "Reproduction", "request_input": "InputRequest"}
for name, result in tool_results.items(): tools[name]["x-result-schema"] = ref(result)
D["ToolCall"] = {"oneOf": list(tools.values())}
D["ActionReservation"]["properties"]["toolCall"] = ref("ToolCall")
replay_steps = [obj({"kind": {"const": "navigate"}, "url": text(8192, minLength=1)}), obj({"kind": {"const": "click"}, "locator": ref("Locator")}), obj({"kind": {"const": "type_text"}, "locator": ref("Locator"), "text": text(2000)}), obj({"kind": {"const": "assert"}, "criterionId": text(64)}), obj({"kind": {"const": "ai_action"}, "goal": text(2000), "criteriaIds": arr(text(64), 20, 1), "maxToolCalls": integer(1,4), "minToolCalls": integer(1,4), "requiredToolSequence": arr(enum("click", "type_text", "select_option", "press", "scroll", "wait_for"), 4, 1)}, ["kind", "goal", "criteriaIds"]), obj({"kind": {"const": "module"}, "ref": text(131, pattern="^[a-zA-Z0-9_./-]+@[1-9][0-9]*$"), "arguments": {"type": "object", "additionalProperties": ref("JsonValue")}}, ["kind", "ref"])]
D["ReplayStep"] = {"oneOf": replay_steps}
D["RegressionDocument"] = obj({"schemaVersion": {"const": 1}, "kind": {"const": "localqa/test"}, "id": text(120, pattern="^[a-zA-Z0-9_.-]+$"), "name": text(200, minLength=1), "variables": {"type": "object", "additionalProperties": {"type": ["string", "number", "boolean"]}}, "criteria": arr(ref("Criterion"), 20, 1), "steps": arr(ref("ReplayStep"), 100, 1), "fixtureRefs": arr(obj({"id": UUID, "version": VER}), 10)}, ["schemaVersion", "kind", "id", "name", "criteria", "steps"])
D["RegressionModuleVersion"] = obj({"projectId": UUID, "name": text(120, pattern="^[a-zA-Z0-9_./-]+$"), "version": VER, "sha256": text(64, pattern="^[0-9a-f]{64}$"), "document": ref("RegressionDocument"), "reviewStatus": enum("draft", "approved", "rejected")})
MODULE_NAME = text(120, minLength=1, pattern="^(?!\\.{1,2}(?:/|$))(?!.*?/\\.{1,2}(?:/|$))[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_.-]+)*$")
MODULE_VERSION = integer(1, 2147483647)
# Management metadata is separate from the historical six-field run snapshot DTO.
D["RegressionModuleCreate"] = obj({"name": MODULE_NAME, "document": ref("RegressionDocument"), "expectedVersion": integer(0, 2147483647)}, ["name", "document"])
D["RegressionModuleRecord"] = obj({**copy.deepcopy(D["RegressionModuleVersion"]["properties"]), "createdBy": nullable(UUID), "createdAt": nullable(DATE), "reviewedBy": nullable(UUID), "reviewedAt": nullable(DATE)})
D["RegressionModuleRecord"]["properties"]["version"] = MODULE_VERSION
D["RegressionModuleRecordPage"] = obj({"items": arr(ref("RegressionModuleRecord"), 100), "nextCursor": nullable(text(2000))})
D["RegressionModuleReviewPreviewInput"] = obj({"expectedVersion": MODULE_VERSION, "decision": enum("approve", "reject"), "reason": text(2000, minLength=1)})
D["RegressionModuleReviewPreview"] = obj({"projectId": UUID, "moduleName": MODULE_NAME, "version": MODULE_VERSION, "documentSha256": text(64, pattern="^[0-9a-f]{64}$"), **copy.deepcopy(D["RegressionModuleReviewPreviewInput"]["properties"]), "diff": text(20000), "risks": arr(text(1000), 20), "confirmationToken": text(1000, minLength=1), "expiresAt": DATE})
D["RegressionModuleReviewCommit"] = obj({**copy.deepcopy(D["RegressionModuleReviewPreviewInput"]["properties"]), "confirmationToken": text(1000, minLength=1)})
D["RegressionBinding"] = obj({"sourceVersionId": UUID, "sourceDocumentSha256": text(64, pattern="^[0-9a-f]{64}$"), "document": ref("RegressionDocument"), "moduleSnapshots": arr(ref("RegressionModuleVersion"), 100)})
D["RegressionBinding"]["properties"]["snapshotDocumentSha256"] = text(64, pattern="^[0-9a-f]{64}$")
D["RegressionStepSource"] = obj({"documentId": copy.deepcopy(D["RegressionDocument"]["properties"]["id"]), "stepIndex": integer(0, 99), "modulePath": arr(obj({"ref": text(131, pattern="^[a-zA-Z0-9_./-]+@[1-9][0-9]*$"), "sha256": text(64, pattern="^[0-9a-f]{64}$"), "invocationStepIndex": integer(0, 99)}), 8)})
D["CaseDefinition"]["properties"]["regression"] = ref("RegressionBinding")
D["Run"]["properties"]["executionMode"] = enum("smoke", "regression")
D["Run"]["properties"]["title"] = nullable(text(60))
D["Run"]["properties"]["stats"] = nullable(obj({"cases": integer(0,100000), "passed": integer(0,100000), "issues": integer(0,100000), "blocked": integer(0,100000), "findings": integer(0,100000)}, ["cases","passed","issues","blocked","findings"]))
D["Step"]["properties"]["regressionSource"] = ref("RegressionStepSource")
D["ActionReservation"]["properties"]["regressionSource"] = ref("RegressionStepSource")

# P1: saved cases, versions, schedules, api-keys, cache stats, repair proposals.
# Source: docs/06-web-regression-and-scheduling.md §3.
D["SavedCase"] = obj({"id": UUID, "projectId": UUID, "slug": text(120, pattern="^[a-zA-Z0-9_.-]+$"), "name": text(200, minLength=1), "status": enum("active", "archived"), "currentApprovedVersionId": nullable(UUID), "version": VER, "createdAt": DATE})
D["SavedCaseCreate"] = obj({"slug": text(120, pattern="^[a-zA-Z0-9_.-]+$"), "name": text(200, minLength=1), "document": ref("RegressionDocument"), "sourceRunCaseId": UUID}, ["slug", "name"])
D["SavedCaseArchiveInput"] = obj({"expectedVersion": integer(1, 2147483647)})
D["SavedCaseRestoreInput"] = obj({"expectedVersion": integer(1, 2147483647)})
D["SavedCaseDuplicateInput"] = obj({"targetProjectId": UUID, "newSlug": copy.deepcopy(D["SavedCaseCreate"]["properties"]["slug"]), "newName": text(200, minLength=1), "sourceVersionId": UUID}, ["newSlug", "newName", "sourceVersionId"])
D["SavedCaseYamlImport"] = obj({"slug": copy.deepcopy(D["SavedCaseCreate"]["properties"]["slug"]), "name": text(200, minLength=1), "yaml": text(262144, minLength=1)})
D["SavedCaseYamlExport"] = obj({"versionId": UUID, "sourceDocumentSha256": text(64, pattern="^[0-9a-f]{64}$"), "yaml": text(262144, minLength=1)})
D["SavedCaseVersion"] = obj({"id": UUID, "caseId": UUID, "version": VER, "document": ref("RegressionDocument"), "sha256": text(64, pattern="^[0-9a-f]{64}$"), "reviewStatus": enum("draft", "approved", "rejected"), "createdBy": UUID, "createdAt": DATE, "reviewedBy": nullable(UUID), "reviewedAt": nullable(DATE)})
D["SavedCaseVersionCreate"] = obj({"expectedVersion": VER, "document": ref("RegressionDocument")})
D["ReviewPreviewInput"] = obj({"expectedVersion": VER, "decision": enum("approve", "reject"), "reason": text(2000, minLength=1)})
D["ReviewPreview"] = obj({"versionId": UUID, **copy.deepcopy(D["ReviewPreviewInput"]["properties"]), "diff": text(20000), "risks": arr(text(1000), 20), "confirmationToken": text(1000), "expiresAt": DATE})
D["ReviewCommit"] = obj({**copy.deepcopy(D["ReviewPreviewInput"]["properties"]), "confirmationToken": text(1000, minLength=1)})
D["Schedule"] = obj({"id": UUID, "projectId": UUID, "name": text(120, minLength=1), "cron": text(120), "timezone": text(80), "templateKind": enum("smoke", "regression"), "runTemplate": ref("RunCreate"), "overlapPolicy": enum("skip", "queue"), "missedPolicy": enum("skip", "catchup_one"), "enabled": BOOL, "version": VER, "createdAt": DATE})
D["ScheduleCreate"] = obj({"name": text(120, minLength=1), "cron": text(120, minLength=1), "timezone": text(80), "templateKind": enum("smoke", "regression"), "runTemplate": ref("RunCreate"), "overlapPolicy": {**enum("skip", "queue"), "default": "skip"}, "missedPolicy": {**enum("skip", "catchup_one"), "default": "skip"}, "enabled": {**BOOL, "default": True}}, ["name", "cron", "templateKind", "runTemplate"])
D["SchedulePatch"] = obj({"expectedVersion": VER, **copy.deepcopy(D["ScheduleCreate"]["properties"])}, ["expectedVersion"])
D["ApiKeyScope"] = enum("runs:create", "runs:read", "reports:read", "runs:cancel")
D["ApiKey"] = obj({"id": UUID, "projectId": UUID, "name": text(120, minLength=1), "scope": arr(ref("ApiKeyScope"), 20, 1), "createdBy": UUID, "createdAt": DATE, "expiresAt": nullable(DATE), "revokedAt": nullable(DATE)})
D["ApiKeyCreate"] = obj({"name": text(120, minLength=1), "scope": arr(ref("ApiKeyScope"), 20, 1), "expiresAt": nullable(DATE)}, ["name", "scope"])
D["ApiKeyCreated"] = obj({"key": ref("ApiKey"), "token": text(2000)})
D["CacheStats"] = obj({"runId": UUID, "hits": integer(), "misses": integer(), "invalidated": integer(), "resolution": text(200), "savedModelCalls": integer(), "savedMs": integer()})
D["RepairProposal"] = obj({"id": UUID, "caseId": UUID, "findingId": UUID, "proposedVersion": VER, "diff": text(20000), "verificationRunId": nullable(UUID), "status": enum("draft", "approved", "rejected"), "createdAt": DATE, "reviewReason": nullable(text(2000)), "reviewedBy": nullable(UUID), "reviewedAt": nullable(DATE)})
# Evidence-derived locator hints are never approved versions or executable
# targets. A separate review and candidate verification must precede adoption.
D["LocatorRepairSuggestion"] = obj({
    "kind": {"const": "locator_name_variation"},
    "source": ref("RegressionStepSource"), "original": ref("Locator"),
    "proposed": ref("Locator"), "reasonCode": {"const": "LOCATOR_NOT_FOUND"},
    "snapshotId": UUID, "pageId": UUID,
    "observedOrigin": URI,
    "reviewRequired": {"const": True}, "verification": {"const": "not_run"},
})
D["RepairSuggestionRecord"] = obj({
    "runId": UUID, "taskId": UUID, "sourceVersionId": UUID,
    "suggestion": ref("LocatorRepairSuggestion"),
})
D["RepairProposalPage"]["properties"]["repairSuggestions"] = arr(ref("RepairSuggestionRecord"), 10)
D["RepairProposalCreate"] = obj({"findingId": UUID, "diff": text(20000, minLength=1)})
D["RepairProposalReviewInput"] = obj({"decision": enum("approve","reject"), "reason": text(2000, minLength=10)}, ["decision","reason"])
D["RepairCandidateVerification"] = obj({
    "id": UUID, "projectId": UUID, "proposalId": UUID,
    "caseId": UUID, "candidateVersionId": UUID,
    "candidateSha256": text(64, minLength=64),
    "status": enum("queued", "running", "completed"),
    "outcome": nullable(enum("passed", "failed", "inconclusive")),
    "reasonCode": nullable(text(64)),
    "observedSteps": integer(0, 100),
    "verifiedCriteria": integer(0, 100),
    "createdAt": DATE, "startedAt": nullable(DATE),
    "finishedAt": nullable(DATE),
}, ["id", "projectId", "proposalId", "caseId", "candidateVersionId",
    "candidateSha256", "status", "outcome", "reasonCode", "observedSteps",
    "verifiedCriteria", "createdAt", "startedAt", "finishedAt"])
D["RepairCandidateVerificationPage"] = obj({
    "items": arr(ref("RepairCandidateVerification"), 100),
    "nextCursor": nullable(text(2000)),
})
D["RepairCandidateEvidence"] = obj({
    "id": UUID, "verificationId": UUID, "candidateVersionId": UUID,
    "stepIndex": integer(0, 30),
    "stepKind": enum("navigate","click","type_text","assert"),
    "criterionId": nullable(text(200)),
    "criterionPassed": nullable({"type":"boolean"}),
    "snapshotId": UUID, "snapshotSha256": text(64,minLength=64),
    "displayUrl": text(8192),
    "screenshotSha256": nullable(text(64,minLength=64)),
    "screenshotBytes": nullable(integer(1, 1048576)),
    "retention": enum("available","purged"),
    "purgedAt": nullable(DATE),
    "createdAt": DATE,
}, ["id","verificationId","candidateVersionId","stepIndex","stepKind",
    "criterionId","criterionPassed","snapshotId","snapshotSha256","displayUrl",
    "screenshotSha256","screenshotBytes","retention","purgedAt","createdAt"])
D["RepairCandidateEvidencePage"] = obj({
    "items": arr(ref("RepairCandidateEvidence"), 30),
})
D["RegressionRunCreate"] = obj({"projectId": UUID, "caseVersionIds": arr(UUID, 100, 1), "environmentId": UUID, "authProfileId": UUID, "budget": ref("BudgetOverrides")}, ["projectId", "caseVersionIds"])
D["ScheduleRunTemplate"] = {"oneOf": [ref("RunCreate"), ref("RegressionRunCreate")]}
for name in ("Schedule", "ScheduleCreate", "SchedulePatch"):
    D[name]["properties"]["runTemplate"] = ref("ScheduleRunTemplate")
D["ScheduleOccurrence"] = obj({"id": UUID, "scheduleId": UUID, "projectId": UUID, "scheduleVersion": VER, "scheduledAt": DATE, "scheduledLocal": text(100), "status": enum("pending","dispatching","started","skipped","failed"), "runId": nullable(UUID), "createdAt": DATE}, ["id","scheduleId","projectId","scheduleVersion","scheduledAt","scheduledLocal","status","runId","createdAt"])
D["ScheduleOccurrencePage"] = obj({"items": arr(ref("ScheduleOccurrence"), 100), "nextCursor": nullable(text(2000))})

def convert_refs(value):
    if isinstance(value, dict): return {k: convert_refs(v) for k, v in value.items()}
    if isinstance(value, list): return [convert_refs(v) for v in value]
    if isinstance(value, str) and value.startswith("#/$defs/"): return value.replace("#/$defs/", "#/components/schemas/", 1)
    return value

paths = {}
def operation(path, method, label, result=None, body=None, status=200, public=False, internal=False, queries=(), idem=False, media="application/json", path_schemas=None):
    parameters = [{"name": token[1:-1], "in": "path", "required": True, "schema": (path_schemas or {}).get(token[1:-1], UUID)} for token in path.split("/") if token.startswith("{")]
    for name, required, schema in queries: parameters.append({"name": name, "in": "query", "required": required, "schema": schema})
    if idem: parameters.append({"name": "Idempotency-Key", "in": "header", "required": True, "schema": text(128, minLength=1)})
    if internal and not path.endswith("/leases/claim"): parameters.append({"name": "X-Lease-Token", "in": "header", "required": True, "schema": text(2000, minLength=1)})
    response = {"description": label}
    if result: response["content"] = {media: {"schema": convert_refs(ref(result)) if result != "Binary" else {"type": "string", "format": "binary"}}}
    data = {"operationId": label, "tags": ["Internal" if internal else "P0"], "summary": label, "security": [] if public else [{"workerIdentity": []}] if internal else [{"cookieAuth": []}], "parameters": parameters, "responses": {str(status): response, "default": {"description": "Stable, redacted error", "content": {"application/json": {"schema": convert_refs(ref("Error"))}}}}}
    if body: data["requestBody"] = {"required": True, "content": {"application/json": {"schema": convert_refs(ref(body))}}}
    paths.setdefault(path, {})[method] = data

P = "/api/v1"
operation(P+"/auth/login", "post", "login", "LoginResult", "LoginInput", public=True)
operation(P+"/auth/logout", "post", "logout", status=204)
operation(P+"/auth/me", "get", "currentUser", "User")
operation(P+"/users", "get", "listUsers", "UserPage")
operation(P+"/users", "post", "createUser", "User", "UserCreate", 201)
operation(P+"/users/{userId}", "patch", "updateUser", "User", "UserPatch")
operation(P+"/projects", "get", "listProjects", "ProjectPage")
operation(P+"/projects", "post", "createProject", "Project", "ProjectCreate", 201)
operation(P+"/projects/{projectId}", "get", "getProject", "Project")
operation(P+"/projects/{projectId}", "patch", "updateProject", "Project", "ProjectPatch")
operation(P+"/projects/{projectId}", "delete", "deleteEmptyProject", body="ProjectDeleteConfirm", status=204)
operation(P+"/projects/{projectId}/members", "get", "listMembers", "MemberPage")
operation(P+"/projects/{projectId}/members", "put", "replaceMembers", "Project", "MemberUpdate")
for suffix, name, create in [("environments", "Environment", "EnvironmentCreate"), ("auth-profiles", "AuthProfile", "AuthProfileCreate"), ("knowledge", "Knowledge", "KnowledgeCreate")]:
    operation(P+"/projects/{projectId}/"+suffix, "get", "list"+name, name+"Page")
    operation(P+"/projects/{projectId}/"+suffix, "post", "create"+name, name, create, 201)
operation(P+"/environments/{environmentId}", "get", "getEnvironment", "Environment")
operation(P+"/environments/{environmentId}", "patch", "updateEnvironment", "Environment", "EnvironmentPatch")
operation(P+"/environments/{environmentId}", "delete", "deleteEnvironment", body="ConfigDeleteConfirm", status=204)
operation(P+"/auth-profiles/{authProfileId}", "patch", "updateAuthProfile", "AuthProfile", "AuthProfilePatch")
operation(P+"/auth-profiles/{authProfileId}", "delete", "deleteAuthProfile", body="ConfigDeleteConfirm", status=204)
operation(P+"/knowledge/{knowledgeId}", "patch", "updateKnowledge", "Knowledge", "KnowledgePatch")
operation(P+"/model-profiles", "get", "listModels", "ModelProfilePage")
operation(P+"/model-profiles", "post", "createModel", "ModelProfile", "ModelProfileCreate", 201)
operation(P+"/model-profiles/{modelProfileId}", "get", "getModel", "ModelProfile")
operation(P+"/model-profiles/{modelProfileId}", "patch", "updateModel", "ModelProfile", "ModelProfilePatch")
operation(P+"/model-profiles/{modelProfileId}", "delete", "deleteModel", body="ModelDeleteConfirm", status=204)
operation(P+"/model-profiles/{modelProfileId}/probe", "post", "probeModel", "ModelProbeResult")
operation(P+"/projects/{projectId}/model-profiles", "get", "listProjectModels", "ModelProfilePage", queries=[("cursor", False, text(2000)), ("limit", False, integer(1, 100))])
operation(P+"/projects/{projectId}/model-profiles", "post", "grantProjectModel", "ModelProfile", "ModelGrantCreate", 201)
operation(P+"/runs", "post", "createRun", "Run", "RunCreate", 202, idem=True)
operation(P+"/runs", "get", "listRuns", "RunPage", queries=[("projectId", True, UUID), ("cursor", False, text(2000)), ("limit", False, integer(1, 100)), ("status", False, enum(*RUN_STATUS)), ("environmentId", False, UUID)])
operation(P+"/runs/{runId}", "get", "getRun", "Run")
operation(P+"/runs/{runId}", "delete", "deleteRun", body="RunDeleteConfirm", status=204)
operation(P+"/runs/{runId}/cancel", "post", "cancelRun", "Run", status=202)
operation(P+"/runs/{runId}/messages", "post", "sendRunMessage", "Run", "MessageInput", 202)
operation(P+"/runs/{runId}/messages", "get", "listRunMessages", "RunMessagePage", queries=[("cursor", False, text(2000)), ("limit", False, integer(1, 100))])
operation(P+"/runs/{runId}/inputs", "get", "listRunInputs", "InputRequestPage")
operation(P+"/runs/{runId}/follow-up", "post", "continueRun", "Run", "FollowUpInput", 202, idem=True)
operation(P+"/runs/{runId}/inputs/{inputId}/respond", "post", "respondToInput", "InputRequest", "InputResponse")
operation(P+"/runs/{runId}/events", "get", "streamEvents", "RunEvent", media="text/event-stream")
paths[P+"/runs/{runId}/events"]["get"]["parameters"].append({"name": "Last-Event-ID", "in": "header", "required": False, "schema": text(30, pattern="^[0-9]+$")})
paths[P+"/runs/{runId}/events"]["get"]["description"] = "SSE framing uses id=seq, event=type and JSON data=RunEvent. Heartbeats are comments, not RunEvent values."
for suffix, name in [("cases", "CaseRecord"), ("tasks", "Task"), ("findings", "Finding")]:
    operation(P+"/runs/{runId}/"+suffix, "get", "listRun"+suffix.title(), name+"Page", queries=[("cursor", False, text(2000)), ("limit", False, integer(1, 100))])
operation(P+"/cases/{caseId}", "get", "getCase", "CaseRecord")
operation(P+"/cases/{caseId}/attempts", "get", "listCaseAttempts", "CaseAttemptPage", queries=[("cursor", False, text(2000)), ("limit", False, integer(1, 100))])
operation(P+"/tasks/{taskId}/steps", "get", "listTaskSteps", "StepPage", queries=[("cursor", False, text(2000)), ("limit", False, integer(1, 100))])
operation(P+"/steps/{stepId}", "get", "getStep", "Step")
operation(P+"/runs/{runId}/event-history", "get", "listEventHistory", "RunEventPage", queries=[("afterSeq", False, integer()), ("limit", False, integer(1, 100))])
operation(P+"/findings/{findingId}", "get", "getFinding", "Finding")
operation(P+"/findings/{findingId}/triage-preview", "post", "previewTriage", "TriagePreview", "TriageInput")
operation(P+"/findings/{findingId}/triage", "post", "commitTriage", "Finding", "TriageCommit")
operation(P+"/runs/{runId}/report", "get", "getReport", "Report")
operation(P+"/runs/{runId}/exports", "post", "createExport", "Export", "ExportInput", 202)
operation(P+"/exports/{exportId}", "get", "getExport", "Export")
operation(P+"/artifacts/{artifactId}/content", "get", "downloadArtifact", "Binary", media="application/octet-stream")
operation(P+"/artifacts/{artifactId}", "get", "getArtifact", "Artifact")
# P1 increment (docs/06 §3). Not part of the P0 HTTP contract; added here so
# T10/T11/T12 owners implement against one authoritative schema.
operation(P+"/projects/{projectId}/saved-cases", "get", "listSavedCases", "SavedCasePage", queries=[("cursor", False, text(2000)), ("limit", False, integer(1, 100)), ("status", False, enum("active", "archived", "all"))])
operation(P+"/projects/{projectId}/saved-cases", "post", "createSavedCase", "SavedCase", "SavedCaseCreate", 201)
operation(P+"/saved-cases/{caseId}/archive", "post", "archiveSavedCase", "SavedCase", "SavedCaseArchiveInput")
operation(P+"/saved-cases/{caseId}/restore", "post", "restoreSavedCase", "SavedCase", "SavedCaseRestoreInput")
operation(P+"/saved-cases/{caseId}/duplicate", "post", "duplicateSavedCase", "SavedCase", "SavedCaseDuplicateInput", 201)
operation(P+"/projects/{projectId}/saved-cases/import", "post", "importSavedCaseYaml", "SavedCase", "SavedCaseYamlImport", 201)
operation(P+"/saved-case-versions/{versionId}/yaml", "get", "exportSavedCaseYaml", "SavedCaseYamlExport")
module_root = P+"/projects/{projectId}/regression-modules"
module_path_schemas = {"moduleName": MODULE_NAME, "version": MODULE_VERSION}
module_pagination = [("cursor", False, text(2000)), ("limit", False, integer(1, 100))]
operation(module_root, "post", "createRegressionModule", "RegressionModuleRecord", "RegressionModuleCreate", 201)
operation(module_root, "get", "listRegressionModules", "RegressionModuleRecordPage", queries=module_pagination)
operation(module_root+"/{moduleName}/versions", "get", "listRegressionModuleVersions", "RegressionModuleRecordPage", queries=module_pagination, path_schemas=module_path_schemas)
operation(module_root+"/{moduleName}/versions/{version}/review-preview", "post", "previewRegressionModuleReview", "RegressionModuleReviewPreview", "RegressionModuleReviewPreviewInput", path_schemas=module_path_schemas)
operation(module_root+"/{moduleName}/versions/{version}/review", "post", "reviewRegressionModuleVersion", "RegressionModuleRecord", "RegressionModuleReviewCommit", path_schemas=module_path_schemas)
operation(P+"/saved-cases/{caseId}/versions", "get", "listSavedCaseVersions", "SavedCaseVersionPage")
operation(P+"/saved-cases/{caseId}/versions", "post", "createSavedCaseVersion", "SavedCaseVersion", "SavedCaseVersionCreate", 201)
operation(P+"/saved-case-versions/{versionId}/review-preview", "post", "previewSavedCaseReview", "ReviewPreview", "ReviewPreviewInput")
operation(P+"/saved-case-versions/{versionId}/review", "post", "commitSavedCaseReview", "SavedCaseVersion", "ReviewCommit")
operation(P+"/regression-runs", "post", "createRegressionRun", "Run", "RegressionRunCreate", 202)
operation(P+"/projects/{projectId}/schedules", "get", "listSchedules", "SchedulePage")
operation(P+"/projects/{projectId}/schedules", "post", "createSchedule", "Schedule", "ScheduleCreate", 201)
operation(P+"/schedules/{scheduleId}", "patch", "updateSchedule", "Schedule", "SchedulePatch")
operation(P+"/schedules/{scheduleId}/run-now", "post", "runScheduleNow", "Run", status=202)
operation(P+"/schedules/{scheduleId}/occurrences", "get", "listScheduleOccurrences", "ScheduleOccurrencePage", queries=[("cursor",False,text(2000)),("limit",False,integer(1,100))])
operation(P+"/projects/{projectId}/api-keys", "get", "listApiKeys", "ApiKeyPage")
operation(P+"/projects/{projectId}/api-keys", "post", "createApiKey", "ApiKeyCreated", "ApiKeyCreate", 201)
operation(P+"/api-keys/{keyId}/revoke", "post", "revokeApiKey", "ApiKey")
operation(P+"/runs/{runId}/cache-stats", "get", "getCacheStats", "CacheStats")
operation(P+"/saved-cases/{caseId}/repair-proposals", "get", "listRepairProposals", "RepairProposalPage")
operation(P+"/saved-cases/{caseId}/repair-proposals", "post", "createRepairProposal", "RepairProposal", "RepairProposalCreate", 201)
operation(P+"/saved-cases/{caseId}/repair-proposals/{proposalId}/review", "post", "reviewRepairProposal", "RepairProposal", "RepairProposalReviewInput")
operation(P+"/saved-cases/{caseId}/repair-proposals/{proposalId}/candidate-version", "post", "createRepairCandidateDraft", "SavedCaseVersion", "SavedCaseVersionCreate", 201)
operation(P+"/saved-cases/{caseId}/repair-proposals/{proposalId}/candidate-version", "get", "getRepairCandidateDraft", "SavedCaseVersion")
operation(P+"/saved-cases/{caseId}/repair-proposals/{proposalId}/verifications", "post", "startRepairCandidateVerification", "RepairCandidateVerification", status=202)
operation(P+"/saved-cases/{caseId}/repair-proposals/{proposalId}/verifications", "get", "listRepairCandidateVerifications", "RepairCandidateVerificationPage", queries=[("cursor",False,text(2000)),("limit",False,integer(1,100))])
operation(P+"/saved-cases/{caseId}/repair-proposals/{proposalId}/verifications/{verificationId}/evidence", "get", "listRepairCandidateEvidence", "RepairCandidateEvidencePage")
operation(P+"/saved-cases/{caseId}/repair-proposals/{proposalId}/verifications/{verificationId}/evidence/{evidenceId}/screenshot", "get", "getRepairCandidateScreenshot", "Binary", media="image/png")
for suffix in ["live", "ready"]: operation(P+"/health/"+suffix, "get", "health"+suffix.title(), "Health", public=True)
paths[P+"/health/ready"]["get"]["responses"]["503"] = {"description": "Core API dependencies not ready", "content": {"application/json": {"schema": convert_refs(ref("Health"))}}}
I = "/internal/v1"
for path, label, result, body in [
    ("/leases/claim", "claimTask", "Lease", "WorkerClaim"),
    ("/tasks/{taskId}/heartbeat", "heartbeatTask", "HeartbeatResult", "HeartbeatInput"),
    ("/tasks/{taskId}/complete", "completeTask", "Task", "TaskComplete"),
    ("/actions/reserve", "reserveAction", "ActionPermit", "ActionReservation"),
    ("/actions/{actionId}/result", "completeAction", "ActionPermit", "ActionResult"),
    ("/model/complete", "completeModelRequest", "ModelResult", "ModelRequest"),
    ("/auth/resolve", "resolveCredential", "CredentialMaterial", "AuthResolve"),
]: operation(I+path, "post", label, result, body, internal=True)
paths[I+"/auth/resolve"]["post"]["parameters"].extend([
    {"name": "X-Worker-Id", "in": "header", "required": True, "schema": text(200, minLength=1)},
    {"name": "X-Fencing-Token", "in": "header", "required": True, "schema": {"type": "string", "pattern": "^[1-9][0-9]*$"}},
    {"name": "X-Context-Version", "in": "header", "required": True, "schema": {"type": "string", "pattern": "^[1-9][0-9]*$"}},
])
paths[I+"/leases/claim"]["post"]["responses"]["204"] = {"description": "No eligible task; retry with bounded polling."}
operation(I+"/artifacts", "post", "uploadArtifact", "Artifact", status=201, internal=True)
paths[I+"/artifacts"]["post"]["requestBody"] = {"required": True, "content": {"multipart/form-data": {"schema": {"type": "object", "required": ["taskId", "kind", "redaction", "file"], "properties": {"taskId": UUID, "kind": D["Artifact"]["properties"]["kind"], "redaction": D["Artifact"]["properties"]["redaction"], "file": {"type": "string", "format": "binary"}}}}}}

def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
base = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": D}
write(ROOT/"contracts/domain.schema.json", base)
def minimal_defs(name):
    selected = {}
    def visit(value):
        if isinstance(value, dict):
            if "$ref" in value and value["$ref"].startswith("#/$defs/"):
                target = value["$ref"].split("/")[-1]
                if target not in selected:
                    selected[target] = D[target]
                    visit(D[target])
            for child in value.values(): visit(child)
        elif isinstance(value, list):
            for child in value: visit(child)
    visit(ref(name))
    return selected
for file, name in [("tools.schema.json", "ToolCall"), ("report.schema.json", "Report"), ("events.schema.json", "RunEvent"), ("regression.schema.json", "RegressionDocument")]:
    write(ROOT/"contracts"/file, {"$schema": base["$schema"], "$defs": minimal_defs(name), "$ref": f"#/$defs/{name}"})
write(ROOT/"contracts/openapi.json", {"openapi": "3.1.0", "info": {"title": "LocalQA v1", "version": "1.0.0", "description": "P0 implementation contract. Internal endpoints are not exposed through the public reverse proxy."}, "servers": [{"url": "https://localqa.example.test"}], "paths": paths, "components": {"schemas": convert_refs(D), "securitySchemes": {"cookieAuth": {"type": "apiKey", "in": "cookie", "name": "localqa_session"}, "workerIdentity": {"type": "http", "scheme": "bearer"}}}})

def uid(n): return f"00000000-0000-4000-8000-{n:012d}"
when = "2026-10-02T04:00:00Z"
defaults = {k: v["default"] for k, v in limits.items()}
create = {"projectId": uid(1), "targetUrl": "http://fixture.local.test:8080/"}
run = {"id": uid(2), "projectId": uid(1), "creatorId": uid(3), "targetUrl": create["targetUrl"], "status": "completed", "phase": "finalize", "completion": "partial", "terminationReason": "budget_limit", "contextVersion": 1, "effectiveConfig": {"allowedOrigins": ["http://fixture.local.test:8080"], "actionPolicy": "non_submitting", "budget": defaults, "environmentVersion": None, "authProfileVersion": None, "models": {role: {"profileId": uid(4), "version": 1} for role in ["coordinator", "explorer", "executor", "assertion", "reproducer"]}, "knowledgeVersionIds": []}, "budgetUsed": {"activeSeconds": 600, "actions": 37, "modelCalls": 12, "reproductions": 1, "totalTokens": 18000}, "createdAt": when, "updatedAt": when, "version": 5}
cases = []
for n, outcome in enumerate(["passed", "passed", "issue_found", "blocked", "not_run"], 10):
    definition = {"id": uid(n), "runId": uid(2), "projectId": uid(1), "version": 1, "title": f"虚构用例 {n-9}", "summary": "受控 fixture 示例，未实际执行", "preconditions": ["fixture 已启动"], "outline": ["打开对应获准页面并检查内容"], "criteria": [{"id": "content.visible", "kind": "element_visible", "description": "主要内容可见", "sourceKind": "generic_smoke", "sourceRef": "smoke:v1/content", "locator": {"by": "role", "value": "main"}}]}
    result = None if outcome == "not_run" else {"id": uid(n+20), "caseId": uid(n), "attemptId": uid(n+40), "status": outcome, "reasonCode": "NORMAL" if outcome == "passed" else "CRITERION_FAILED" if outcome == "issue_found" else "AUTH_REQUIRED", "summary": "虚构结果，仅展示协议", "criterionResults": [{"criterionId": "content.visible", "result": "passed" if outcome == "passed" else "failed" if outcome == "issue_found" else "not_evaluated", "reason": "示例观察", "evidenceRefs": [uid(80+n-10)] if outcome != "blocked" else []}], "gaps": ["需要认证资料"] if outcome == "blocked" else [], "createdAt": when}
    cases.append({"definition": definition, "outcome": outcome, "verdict": result})
artifacts = [{"id": uid(80+n), "projectId": uid(1), "runId": uid(2), "taskId": uid(92) if n==3 else uid(60+n), "stepId": uid(200+n), "caseId": uid(12) if n==3 else uid(10+n), "snapshotId": uid(300+n), "kind": "screenshot", "status": "available", "bytes": 1024, "sha256": str(n+1)*64, "contentUrl": f"/api/v1/artifacts/{uid(80+n)}/content", "redaction": "not_needed", "error": None, "createdAt": when} for n in range(4)]
finding = {"id": uid(90), "runId": uid(2), "caseIds": [uid(12)], "kind": "functional", "status": "confirmed", "title": "虚构 fixture 页面主要内容缺失", "severity": "medium", "expected": "获准页面显示主要内容", "actual": "主要内容节点未出现", "expectedSource": "generic_smoke", "reproSteps": ["打开 fixture 中的固定故障页面", "等待内容检查完成"], "evidenceRefs": [uid(82), uid(83)], "reproductionRef": uid(91), "triageDisposition": "open", "version": 1}
reproduction = {"id": uid(91), "findingId": uid(90), "taskId": uid(92), "outcome": "reproduced", "freshContext": True, "summary": "虚构独立复现", "evidenceRefs": [uid(83)], "createdAt": when}
report = {"schemaVersion": 1, "example": True, "generatedAt": when, "run": run, "summary": {"planned": 5, "passed": 2, "issueFound": 1, "blocked": 1, "inconclusive": 0, "notRun": 1, "attempted": 4, "evaluated": 3, "passRate": 2/3, "attemptRate": 4/5}, "cases": cases, "findings": [finding], "reproductions": [reproduction], "artifacts": artifacts, "modelUsage": [{"profileId": uid(4), "configuredModelId": "fixture-model", "reportedModelId": None, "requests": 12, "inputTokens": 14000, "outputTokens": 4000, "usageSource": "estimated"}], "coverageGaps": ["一条用例需要认证", "预算结束前未执行最后一条用例"], "cleanupStatus": "not_required", "warnings": ["所有内容均为虚构示例，不代表平台已实现或已运行"]}
write(ROOT/"examples/run-create.json", create)
write(ROOT/"examples/report.sample.json", report)
write(ROOT/"examples/tool-call.json", {"name": "click", "args": {"target": {"snapshotId": uid(100), "pageId": uid(101), "nodeId": "n7"}}})
initial_run = copy.deepcopy(run)
initial_run.update({"status": "queued", "phase": "preflight", "completion": "none", "terminationReason": None, "version": 1, "budgetUsed": {k: 0 for k in run["budgetUsed"]}})
write(ROOT/"examples/event.sample.json", {"schemaVersion": 1, "id": "1", "runId": uid(2), "seq": 1, "type": "run.updated", "at": when, "payload": initial_run})
regression = {"kind": "localqa/test", "schemaVersion": 1, "id": "dashboard-smoke", "name": "虚构示例：打开首页并检查主内容", "variables": {}, "criteria": [{"id": "main.visible", "kind": "element_visible", "description": "主要内容可见", "sourceKind": "saved_case", "sourceRef": "dashboard-smoke@1", "locator": {"by": "role", "value": "main"}}], "steps": [{"kind": "navigate", "url": "{{env.BASE_URL}}"}, {"kind": "assert", "criterionId": "main.visible"}]}
write(ROOT/"examples/regression.case.json", regression)
print("P1 regression example is fictional and not an implemented replay engine.")
print(f"Generated {len(D)} shared schemas, {len(paths)} API paths and five fictional JSON examples.")
