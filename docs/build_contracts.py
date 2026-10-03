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
    "concurrency": integer(1, 16, default=2), "maxTotalTokens": integer(1000, 5000000, default=300000),
}
D["BudgetLimits"] = obj(limits)
D["BudgetOverrides"] = obj(copy.deepcopy(limits), [])
D["BudgetUsed"] = obj({k: integer() for k in ["activeSeconds", "actions", "modelCalls", "reproductions", "totalTokens"]})
D["Environment"] = obj({"id": UUID, "projectId": UUID, "name": text(120), "baseUrl": URI, "allowedOrigins": arr(URI, 30, 1), "excludedPaths": arr(text(300), 100), "tlsPolicy": enum("strict", "allow_self_signed"), "defaultAuthProfileId": nullable(UUID), "version": VER})
D["EnvironmentCreate"] = obj({k: v for k, v in D["Environment"]["properties"].items() if k not in ["id", "projectId", "version"]}, ["name", "baseUrl", "allowedOrigins", "tlsPolicy"])
D["EnvironmentPatch"] = obj({"expectedVersion": VER, **copy.deepcopy(D["EnvironmentCreate"]["properties"])}, ["expectedVersion"])
D["Locator"] = obj({"by": enum("role", "label", "test_id", "text", "css"), "value": text(500, minLength=1), "name": text(500)}, ["by", "value"])
D["Criterion"] = obj({"id": text(64, pattern="^[a-zA-Z0-9_.-]+$"), "kind": enum("element_visible", "text_equals", "url_matches", "http_status", "semantic", "visual"), "description": text(2000, minLength=1), "sourceKind": enum("generic_smoke", "user_spec", "project_knowledge", "saved_case", "inferred"), "sourceRef": text(500, minLength=1), "locator": ref("Locator"), "expectedValue": ref("JsonValue")}, ["id", "kind", "description", "sourceKind", "sourceRef"])
D["CandidateCase"] = obj({"title": text(200, minLength=1), "summary": text(), "preconditions": arr(text(1000), 20), "outline": arr(text(1500), 30, 1), "criteria": arr(ref("Criterion"), 20, 1)})
D["CaseDefinition"] = obj({"id": UUID, "runId": UUID, "projectId": UUID, "version": VER, **copy.deepcopy(D["CandidateCase"]["properties"])})
D["AuthProfile"] = obj({"id": UUID, "projectId": UUID, "environmentId": nullable(UUID), "name": text(120), "mode": enum("none", "form", "storage_state"), "allowedOrigins": arr(URI, 30, 1), "sharingPolicy": enum("exclusive_run", "shared_state"), "hasSecret": BOOL, "version": VER})
D["FormConfig"] = obj({"loginUrl": URI, "usernameTarget": ref("Locator"), "passwordTarget": ref("Locator"), "submitTarget": ref("Locator"), "successCriterion": ref("Criterion"), "otpTarget": ref("Locator")}, ["loginUrl", "usernameTarget", "passwordTarget", "submitTarget", "successCriterion"])
D["AuthProfileCreate"] = obj({"environmentId": nullable(UUID), "name": text(120, minLength=1), "mode": enum("none", "form", "storage_state"), "allowedOrigins": arr(URI, 30, 1), "sharingPolicy": {**enum("exclusive_run", "shared_state"), "default": "exclusive_run"}, "formConfig": ref("FormConfig"), "secretInput": {"type": "object", "writeOnly": True, "additionalProperties": text(1000000)}}, ["name", "mode", "allowedOrigins"])
D["AuthProfilePatch"] = obj({"expectedVersion": VER, "name": text(120), "sharingPolicy": enum("exclusive_run", "shared_state"), "formConfig": ref("FormConfig"), "secretInput": copy.deepcopy(D["AuthProfileCreate"]["properties"]["secretInput"]), "revoke": BOOL}, ["expectedVersion"])
D["Knowledge"] = obj({"id": UUID, "projectId": UUID, "title": text(200), "kind": enum("terminology", "rule", "flow", "restriction"), "text": text(20000), "approved": BOOL, "version": VER})
D["KnowledgeCreate"] = obj({"title": text(200, minLength=1), "kind": enum("terminology", "rule", "flow", "restriction"), "text": text(20000, minLength=1)})
D["KnowledgePatch"] = obj({"expectedVersion": VER, "title": text(200), "text": text(20000), "approved": BOOL}, ["expectedVersion"])
D["ModelCapabilities"] = obj({"structuredOutput": BOOL, "nativeTools": BOOL, "imageInput": BOOL})
D["ModelProfile"] = obj({"id": UUID, "name": text(120), "endpoint": URI, "configuredModelId": text(200, minLength=1), "adapter": enum("openai_compatible"), "dataBoundary": enum("internal", "external"), "capabilities": ref("ModelCapabilities"), "status": enum("untested", "ready", "degraded", "disabled"), "version": VER})
D["ModelProfileCreate"] = obj({"name": text(120, minLength=1), "endpoint": URI, "configuredModelId": text(200, minLength=1), "adapter": enum("openai_compatible"), "dataBoundary": enum("internal", "external"), "apiKey": text(1000, writeOnly=True)}, ["name", "endpoint", "configuredModelId", "adapter", "dataBoundary"])
D["ModelProbeResult"] = obj({"profileId": UUID, "capabilities": ref("ModelCapabilities"), "status": enum("ready", "degraded", "disabled"), "notes": arr(text(1000), 20)})
D["RunCreate"] = obj({"projectId": UUID, "targetUrl": URI, "brief": text(4000), "environmentId": UUID, "authProfileId": UUID, "mode": enum("smoke"), "budget": ref("BudgetOverrides")}, ["projectId", "targetUrl"])
D["RunConfig"] = obj({"allowedOrigins": arr(URI, 30, 1), "actionPolicy": enum("non_submitting", "approved_workflows"), "budget": ref("BudgetLimits"), "environmentVersion": nullable(VER), "authProfileVersion": nullable(VER), "modelProfileIds": arr(UUID, 10, 1), "knowledgeVersionIds": arr(UUID, 100)})
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
D["InputRequest"] = obj({"id": UUID, "runId": UUID, "kind": enum("auth_profile", "one_time_code", "clarification", "scope_extension", "write_action"), "status": enum("pending", "resolved", "rejected", "expired"), "prompt": text(2000), "expiresAt": DATE, "version": VER})
D["InputResponse"] = obj({"expectedVersion": VER, "decision": enum("provide", "approve", "reject"), "authProfileId": UUID, "text": text(4000), "oneTimeCode": text(32, minLength=4, writeOnly=True), "allowedOrigins": arr(URI, 30)}, ["expectedVersion", "decision"])
D["MessageInput"] = obj({"text": text(4000, minLength=1), "expectedContextVersion": VER})
D["RunMessage"] = obj({"id": UUID, "runId": UUID, "actorId": UUID, "contextVersion": VER, "redactedText": text(4000), "createdAt": DATE})
D["TriageInput"] = obj({"expectedVersion": VER, "disposition": enum("accepted", "duplicate", "works_as_intended", "cannot_reproduce", "closed"), "reason": text(2000, minLength=1)})
D["TriagePreview"] = obj({"findingId": UUID, "expectedVersion": VER, "disposition": D["TriageInput"]["properties"]["disposition"], "reason": text(2000), "confirmationToken": text(1000), "expiresAt": DATE})
D["TriageCommit"] = obj({**copy.deepcopy(D["TriageInput"]["properties"]), "confirmationToken": text(1000, minLength=1)})
D["ExportInput"] = obj({"format": enum("json", "markdown", "zip"), "includeArtifacts": BOOL, "requireTerminal": BOOL}, ["format"])
D["Export"] = obj({"id": UUID, "runId": UUID, "status": enum("queued", "running", "ready", "failed"), "format": enum("json", "markdown", "zip"), "artifactId": nullable(UUID), "snapshotAt": DATE, "error": nullable(text(1000))})
EVENTS = ["run.updated", "phase.changed", "task.updated", "case.created", "case.result", "finding.updated", "step.recorded", "budget.updated", "input.requested", "input.resolved", "artifact.updated", "report.ready", "run.finished"]
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
D["ModelRequest"] = obj({"taskId": UUID, "profileId": UUID, "contextVersion": VER, "purpose": enum("plan", "decide", "assert", "summarize"), "messages": arr(ref("ModelMessage"), 100, 1), "maxOutputTokens": integer(1, 2000), "outputSchema": {"type": "object"}})
D["ModelResult"] = obj({"data": ref("JsonValue"), "configuredModelId": text(200), "reportedModelId": nullable(text(200)), "usage": ref("ModelUsage")})
D["AuthResolve"] = obj({"taskId": UUID, "authProfileId": UUID, "authProfileVersion": VER})
D["CredentialMaterial"] = obj({"mode": enum("none", "form", "storage_state"), "material": {"type": "object", "additionalProperties": ref("JsonValue"), "x-sensitive": True}, "expiresAt": DATE})
D["Health"] = obj({"status": enum("ok", "not_ready"), "version": text(40)})
D["User"]["properties"].update({"disabled": BOOL, "version": VER})
D["User"]["required"].extend(["disabled", "version"])
D["UserCreate"] = obj({"email": {"type": "string", "format": "email"}, "displayName": text(120), "password": text(128, minLength=12, writeOnly=True), "globalRole": enum("admin", "member")}, ["email", "displayName", "password"])
D["UserPatch"] = obj({"expectedVersion": VER, "displayName": text(120), "disabled": BOOL, "password": text(128, minLength=12, writeOnly=True), "globalRole": enum("admin", "member")}, ["expectedVersion"])
D["Project"]["properties"]["defaultModelProfileId"] = nullable(UUID)
D["Project"]["required"].append("defaultModelProfileId")
D["ProjectPatch"] = obj({"expectedVersion": VER, "name": text(120), "status": enum("active", "archived"), "defaultModelProfileId": nullable(UUID)}, ["expectedVersion"])
D["ModelProfilePatch"] = obj({"expectedVersion": VER, "name": text(120), "endpoint": URI, "configuredModelId": text(200), "apiKey": text(1000, writeOnly=True), "status": enum("disabled", "untested")}, ["expectedVersion"])
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
    {"if": {"properties": {"mode": {"const": "storage_state"}}, "required": ["mode"]}, "then": {"required": ["secretInput"], "properties": {"secretInput": {"required": ["storageState"]}}}},
]
D["AuthProfile"]["properties"].update({"status": enum("active", "revoked"), "formConfig": nullable(ref("FormConfig"))})
D["AuthProfile"]["required"].extend(["status", "formConfig"])
event_payloads = {
    "run.updated": ref("Run"), "phase.changed": obj({"phase": enum(*PHASE), "contextVersion": VER}),
    "task.updated": ref("Task"), "case.created": ref("CaseDefinition"), "case.result": ref("CaseRecord"),
    "finding.updated": ref("Finding"), "step.recorded": ref("Step"),
    "budget.updated": obj({"used": ref("BudgetUsed"), "limits": ref("BudgetLimits")}),
    "input.requested": ref("InputRequest"), "input.resolved": ref("InputRequest"),
    "artifact.updated": ref("Artifact"), "report.ready": obj({"schemaVersion": {"const": 1}, "reportVersion": VER, "generatedAt": DATE}),
    "run.finished": ref("Run"),
}
D["RunEvent"]["allOf"] = [{"if": {"properties": {"type": {"const": name}}, "required": ["type"]}, "then": {"properties": {"payload": schema}}} for name, schema in event_payloads.items()]
for name in ["User", "Project", "Environment", "AuthProfile", "Knowledge", "ModelProfile", "Run", "CaseRecord", "CaseAttempt", "Step", "RunEvent", "Task", "Finding", "Member", "RunMessage"]:
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
replay_steps = [obj({"kind": {"const": "navigate"}, "url": text(8192, minLength=1)}), obj({"kind": {"const": "click"}, "locator": ref("Locator")}), obj({"kind": {"const": "type_text"}, "locator": ref("Locator"), "text": text(2000)}), obj({"kind": {"const": "assert"}, "criterionId": text(64)}), obj({"kind": {"const": "ai_action"}, "goal": text(2000), "criteriaIds": arr(text(64), 20, 1)}), obj({"kind": {"const": "module"}, "ref": text(120, pattern="^[a-zA-Z0-9_./-]+@[1-9][0-9]*$"), "arguments": {"type": "object", "additionalProperties": ref("JsonValue")}}, ["kind", "ref"])]
D["ReplayStep"] = {"oneOf": replay_steps}
D["RegressionDocument"] = obj({"schemaVersion": {"const": 1}, "kind": {"const": "localqa/test"}, "id": text(120, pattern="^[a-zA-Z0-9_.-]+$"), "name": text(200, minLength=1), "variables": {"type": "object", "additionalProperties": {"type": ["string", "number", "boolean"]}}, "criteria": arr(ref("Criterion"), 20, 1), "steps": arr(ref("ReplayStep"), 100, 1), "fixtureRefs": arr(obj({"id": UUID, "version": VER}), 10)}, ["schemaVersion", "kind", "id", "name", "criteria", "steps"])

def convert_refs(value):
    if isinstance(value, dict): return {k: convert_refs(v) for k, v in value.items()}
    if isinstance(value, list): return [convert_refs(v) for v in value]
    if isinstance(value, str) and value.startswith("#/$defs/"): return value.replace("#/$defs/", "#/components/schemas/", 1)
    return value

paths = {}
def operation(path, method, label, result=None, body=None, status=200, public=False, internal=False, queries=(), idem=False, media="application/json"):
    parameters = [{"name": token[1:-1], "in": "path", "required": True, "schema": UUID} for token in path.split("/") if token.startswith("{")]
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
operation(P+"/projects/{projectId}/members", "get", "listMembers", "MemberPage")
operation(P+"/projects/{projectId}/members", "put", "replaceMembers", "Project", "MemberUpdate")
for suffix, name, create in [("environments", "Environment", "EnvironmentCreate"), ("auth-profiles", "AuthProfile", "AuthProfileCreate"), ("knowledge", "Knowledge", "KnowledgeCreate")]:
    operation(P+"/projects/{projectId}/"+suffix, "get", "list"+name, name+"Page")
    operation(P+"/projects/{projectId}/"+suffix, "post", "create"+name, name, create, 201)
operation(P+"/environments/{environmentId}", "get", "getEnvironment", "Environment")
operation(P+"/environments/{environmentId}", "patch", "updateEnvironment", "Environment", "EnvironmentPatch")
operation(P+"/auth-profiles/{authProfileId}", "patch", "updateAuthProfile", "AuthProfile", "AuthProfilePatch")
operation(P+"/knowledge/{knowledgeId}", "patch", "updateKnowledge", "Knowledge", "KnowledgePatch")
operation(P+"/model-profiles", "get", "listModels", "ModelProfilePage")
operation(P+"/model-profiles", "post", "createModel", "ModelProfile", "ModelProfileCreate", 201)
operation(P+"/model-profiles/{modelProfileId}", "get", "getModel", "ModelProfile")
operation(P+"/model-profiles/{modelProfileId}", "patch", "updateModel", "ModelProfile", "ModelProfilePatch")
operation(P+"/model-profiles/{modelProfileId}/probe", "post", "probeModel", "ModelProbeResult")
operation(P+"/runs", "post", "createRun", "Run", "RunCreate", 202, idem=True)
operation(P+"/runs", "get", "listRuns", "RunPage", queries=[("projectId", True, UUID), ("cursor", False, text(2000)), ("limit", False, integer(1, 100)), ("status", False, enum(*RUN_STATUS)), ("environmentId", False, UUID)])
operation(P+"/runs/{runId}", "get", "getRun", "Run")
operation(P+"/runs/{runId}/cancel", "post", "cancelRun", "Run", status=202)
operation(P+"/runs/{runId}/messages", "post", "sendRunMessage", "Run", "MessageInput", 202)
operation(P+"/runs/{runId}/messages", "get", "listRunMessages", "RunMessagePage", queries=[("cursor", False, text(2000)), ("limit", False, integer(1, 100))])
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
