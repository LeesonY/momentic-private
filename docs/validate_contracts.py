"""Validate documentation contracts, fictional examples and semantic invariants."""
from pathlib import Path
from collections import Counter
import copy
import json
import re
from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError
import yaml
from openapi_spec_validator import validate_spec

ROOT = Path(__file__).resolve().parent
def read(name): return json.loads((ROOT/name).read_text(encoding="utf-8"))
def require(condition, message):
    if not condition: raise AssertionError(message)
def check_refs(value, root):
    if isinstance(value, dict):
        if "$ref" in value:
            pointer = value["$ref"]
            require(pointer.startswith("#/"), "External refs are not supported by this contract pack")
            node = root
            for token in pointer[2:].split("/"):
                token = token.replace("~1", "/").replace("~0", "~")
                require(token in node, f"Missing ref {pointer}")
                node = node[token]
        for child in value.values(): check_refs(child, root)
    elif isinstance(value, list):
        for child in value: check_refs(child, root)
schemas = {}
for file in sorted((ROOT/"contracts").glob("*.schema.json")):
    schema = json.loads(file.read_text())
    Draft202012Validator.check_schema(schema)
    check_refs(schema, schema)
    schemas[file.name] = schema
roles = {"coordinator", "explorer", "executor", "reproducer", "finalizer"}
for tool in schemas["tools.schema.json"]["$defs"]["ToolCall"]["oneOf"]:
    require(set(tool["x-roles"])<=roles, "Unknown tool role")
    require("$ref" in tool["x-result-schema"], "Missing output contract")
api = read("contracts/openapi.json")
require(api["openapi"] == "3.1.0", "OpenAPI version mismatch")
validate_spec(api)
check_refs(api, api)
for schema in api["components"]["schemas"].values(): Draft202012Validator.check_schema(schema)
operations = []
for path, item in api["paths"].items():
    for method, operation in item.items():
        operations.append(operation["operationId"])
        expected = set(re.findall(r"\{([^}]+)\}", path))
        actual = {p["name"] for p in operation["parameters"] if p["in"] == "path" and p["required"]}
        require(expected == actual, f"Path parameters mismatch: {method} {path}")
        if path.startswith("/internal/"): require(operation["security"] == [{"workerIdentity": []}], "Internal auth mismatch")
require(len(operations) == len(set(operations)), "Duplicate operationId")
domain = schemas["domain.schema.json"]
def validate_domain(name, value):
    Draft202012Validator({**domain, "$ref": f"#/$defs/{name}"}, format_checker=FormatChecker()).validate(value)
def validate_sample(file, schema_file):
    value = read("examples/"+file)
    Draft202012Validator(schemas[schema_file], format_checker=FormatChecker()).validate(value)
    return value
validate_domain("RunCreate", read("examples/run-create.json"))
regression = validate_sample("regression.case.json", "regression.schema.json")
yaml_example = yaml.safe_load((ROOT/"examples/regression.case.yaml").read_text())
require(yaml_example == regression, "YAML/JSON regression examples differ")
require(all(s["criterionId"] in {c["id"] for c in regression["criteria"]} for s in regression["steps"] if s["kind"]=="assert"), "Unknown regression criterion")
validate_sample("tool-call.json", "tools.schema.json")
event = validate_sample("event.sample.json", "events.schema.json")
require(event["id"] == str(event["seq"]), "SSE id differs from seq")
report = validate_sample("report.sample.json", "report.schema.json")
def check_report(report):
    run = report["run"]
    cases = report["cases"]
    ids = {c["definition"]["id"] for c in cases}
    artifacts = {a["id"]: a for a in report["artifacts"]}
    reproductions = {r["id"]: r for r in report["reproductions"]}
    require(len(ids) == len(cases), "Duplicate report case")
    counts = Counter(c["outcome"] for c in cases)
    summary = report["summary"]
    mapping = {"passed": "passed", "issue_found": "issueFound", "blocked": "blocked", "inconclusive": "inconclusive", "not_run": "notRun"}
    for outcome, field in mapping.items(): require(summary[field] == counts[outcome], "Summary count mismatch: "+field)
    require(summary["planned"] == len(cases), "Planned count mismatch")
    attempted = len(cases)-counts["not_run"]
    evaluated = counts["passed"]+counts["issue_found"]
    require(summary["attempted"] == attempted and summary["evaluated"] == evaluated, "Attempted/evaluated mismatch")
    for key, expected in [("passRate", counts["passed"]/evaluated if evaluated else None), ("attemptRate", attempted/len(cases) if cases else None)]:
        actual = summary[key]
        require(actual is None if expected is None else actual is not None and abs(actual-expected)<1e-9, "Rate mismatch: "+key)
    for artifact in artifacts.values(): require(artifact["runId"]==run["id"] and artifact["projectId"]==run["projectId"], "Foreign artifact")
    for case in cases:
        definition = case["definition"]
        require(definition["runId"]==run["id"] and definition["projectId"]==run["projectId"], "Foreign case")
        verdict = case["verdict"]
        if case["outcome"]=="not_run":
            require(verdict is None, "Not-run case has invented verdict")
            continue
        require(verdict and verdict["caseId"]==definition["id"] and verdict["status"]==case["outcome"], "Verdict mismatch")
        criteria = {c["id"]: c for c in definition["criteria"]}
        results = {r["criterionId"]: r for r in verdict["criterionResults"]}
        require(len(criteria)==len(definition["criteria"]), "Duplicate criterion")
        require(set(results)<=set(criteria), "Unknown criterion result")
        if case["outcome"]=="passed": require(set(results)==set(criteria) and all(r["result"]=="passed" and r["evidenceRefs"] for r in results.values()), "False pass")
        if case["outcome"]=="issue_found": require(any(r["result"]=="failed" for r in results.values()), "Issue without failure")
        for result in results.values():
            for evidence in result["evidenceRefs"]:
                require(evidence in artifacts and artifacts[evidence]["caseId"]==definition["id"], "Foreign/missing verdict evidence")
    for finding in report["findings"]:
        require(set(finding["caseIds"])<=ids, "Unknown finding case")
        require(set(finding["evidenceRefs"])<=set(artifacts), "Unknown finding evidence")
        if finding["kind"]=="functional" and finding["status"]=="confirmed":
            require(finding["expectedSource"]!="inferred", "Inferred business bug confirmed")
            reproduction = reproductions.get(finding["reproductionRef"])
            require(reproduction and reproduction["findingId"]==finding["id"] and reproduction["outcome"]=="reproduced" and reproduction["freshContext"], "Invalid reproduction")
            require(reproduction["evidenceRefs"] and set(reproduction["evidenceRefs"])<=set(artifacts), "Missing reproduction evidence")
            require(all(artifacts[e]["taskId"]==reproduction["taskId"] for e in reproduction["evidenceRefs"]), "Original evidence reused as reproduction")
    require(sum(m["requests"] for m in report["modelUsage"])==run["budgetUsed"]["modelCalls"], "Model call total mismatch")
check_report(report)
bad = copy.deepcopy(report)
bad["summary"]["passed"] += 1
try: check_report(bad)
except AssertionError: pass
else: raise AssertionError("Invalid statistics accepted")
bad = copy.deepcopy(report)
bad["reproductions"][0]["evidenceRefs"] = [bad["artifacts"][2]["id"]]
try: check_report(bad)
except AssertionError: pass
else: raise AssertionError("Reused evidence accepted as independent reproduction")
for value, name in [({"projectId": "not-a-uuid", "targetUrl": "https://example.test"}, "RunCreate"), ({"name": "eval", "args": {"script": "unsupported"}}, "ToolCall")]:
    try: validate_domain(name, value)
    except ValidationError: pass
    else: raise AssertionError("Invalid input accepted: "+name)
missing_links = []
for file in ROOT.parent.rglob("*.md"):
    for target in re.findall(r"\]\(([^)]+)\)", file.read_text()):
        if target.startswith(("http:", "https:", "#", "codex:")): continue
        target = target.split("#")[0]
        resolved = Path(target) if target.startswith("/") else file.parent/target
        if not resolved.exists(): missing_links.append((str(file), target))
require(not missing_links, f"Missing links: {missing_links}")
print(json.dumps({"status": "passed", "openapiVersion": "3.1.0", "openapiValidation": "standard validator", "schemas": len(schemas), "apiPaths": len(api["paths"]), "operations": len(operations), "sharedDefinitions": len(domain["$defs"]), "jsonExamples": 5, "yamlExamples": 1, "semanticChecks": ["report statistics", "case/verdict ownership", "evidence ownership", "independent reproduction", "model calls", "event sequence", "regression criteria", "YAML/JSON equivalence", "negative inputs", "local links"], "productExecution": False}, ensure_ascii=False, indent=2))
