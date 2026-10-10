/**
 * LocalQA Test Fixture Automated Test Suite
 * Tests all endpoints and validates FIX-01 through FIX-14 contract behaviors.
 */

const http = require("http");
const app = require("./server");

const TEST_PORT = process.env.TEST_PORT || 8089;
let server;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path,
      method,
      headers: {
        ...headers
      }
    };

    let payload = null;
    if (body) {
      if (typeof body === "object") {
        payload = JSON.stringify(body);
        options.headers["Content-Type"] = "application/json";
      } else {
        payload = String(body);
      }
      options.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {
          // Non-JSON body: callers fall back to the raw string
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          json
        });
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log("=== Starting LocalQA Test Fixture Verification Suite ===");
  server = app.listen(TEST_PORT);
  let failed = 0;

  function assert(condition, message) {
    if (!condition) {
      console.error(`  FAIL: ${message}`);
      failed++;
    } else {
      console.log(`  PASS: ${message}`);
    }
  }

  try {
    // 1. Ops: Reset & Seed & Audit
    console.log("\n[Test 1] Ops APIs: /api/reset, /api/seed, /api/audit");
    const resetRes = await request("POST", "/api/reset");
    assert(resetRes.status === 200, "POST /api/reset returns 200");
    assert(resetRes.json.auditCount === 0, "Reset audit count is 0");

    const seedRes = await request("POST", "/api/seed", { runId: "test_run", caseId: "case_99", count: 4 });
    assert(seedRes.status === 200, "POST /api/seed returns 200");
    assert(seedRes.json.items[0].id === "LQA_test_run_case_99_item_1", "Seed item follows LQA_<runId>_<caseId> naming");

    const auditRes = await request("GET", "/api/audit");
    assert(auditRes.status === 200, "GET /api/audit returns 200");
    assert(auditRes.json.count === 0, "Audit log starts clean with count 0");

    // 2. FIX-01: Pagination & Content
    console.log("\n[Test 2] FIX-01: Navigation, Main Content & Pagination");
    const fix01Res = await request("GET", "/api/fix-01/items?page=1&limit=2");
    assert(fix01Res.status === 200, "GET /api/fix-01/items returns 200");
    assert(fix01Res.json.items.length === 2, "Pagination returns limit=2 items");
    assert(fix01Res.json.page === 1, "Page is 1");

    // 3. FIX-02: Delayed Rendering & Stream
    console.log("\n[Test 3] FIX-02: Delayed Data");
    const fix02Res = await request("GET", "/api/fix-02/data?delay=50");
    assert(fix02Res.status === 200, "GET /api/fix-02/data returns 200");
    assert(fix02Res.json.payload.status === "READY", "Delayed data payload is READY");

    // 4. FIX-03: Auth & State Reuse
    console.log("\n[Test 4] FIX-03: Auth & Session Reuse");
    const loginFail = await request("POST", "/api/auth/login", { username: "admin@localqa.fixture", password: "WrongPassword" });
    assert(loginFail.status === 401, "Failed login returns 401");

    const loginAdmin = await request("POST", "/api/auth/login", { username: "admin@localqa.fixture", password: "AdminPass123!" });
    assert(loginAdmin.status === 200, "Admin login succeeds with 200");
    const adminToken = loginAdmin.json.token;

    const meRes = await request("GET", "/api/auth/me", null, { "Authorization": `Bearer ${adminToken}` });
    assert(meRes.status === 200 && meRes.json.user.role === "admin", "Session reuse via Bearer token works");

    const expiredRes = await request("GET", "/api/auth/me", null, { "Authorization": "Bearer tok_expired_session" });
    assert(expiredRes.status === 401 && expiredRes.json.error === "SESSION_EXPIRED", "Expired session token rejected with 401 SESSION_EXPIRED");

    // 5. FIX-04: Roles (Viewer vs Admin)
    console.log("\n[Test 5] FIX-04: Role Permissions");
    const loginViewer = await request("POST", "/api/auth/login", { username: "viewer@localqa.fixture", password: "ViewerPass123!" });
    const viewerToken = loginViewer.json.token;

    const viewerAdminAction = await request("POST", "/api/fix-04/admin-action", null, { "Authorization": `Bearer ${viewerToken}` });
    assert(viewerAdminAction.status === 403, "Viewer role executing admin-action is rejected with 403 Forbidden");

    const adminAdminAction = await request("POST", "/api/fix-04/admin-action", null, { "Authorization": `Bearer ${adminToken}` });
    assert(adminAdminAction.status === 200, "Admin role executing admin-action succeeds with 200 OK");

    // 6. FIX-05: DOM Ambiguity
    console.log("\n[Test 6] FIX-05: DOM Inspection");
    const inspectRes = await request("POST", "/api/fix-05/inspect", { targetId: "LQA_BETA_002" });
    assert(inspectRes.status === 200 && inspectRes.json.targetId === "LQA_BETA_002", "Inspect endpoint correctly identifies specific target ID");

    // 7. FIX-06: Frames
    console.log("\n[Test 7] FIX-06: Frames & Popups");
    const frameRes = await request("GET", "/fix-06-same-origin-frame.html");
    assert(frameRes.status === 200 && frameRes.body.includes("same-origin-content"), "Same origin frame serves content");

    // 8. FIX-07: Mutations & Audit Proof
    console.log("\n[Test 8] FIX-07: Mutations & Audit Proof (Count = 0)");
    await request("POST", "/api/reset");
    
    // Safe POST should NOT trigger audit
    const safePostRes = await request("POST", "/api/fix-07/safe-query", { query: "Hardware" });
    assert(safePostRes.status === 200, "Safe POST succeeds");
    
    let auditCheck = await request("GET", "/api/audit");
    assert(auditCheck.json.count === 0, "Audit count remains 0 after Safe POST (proving non-submitting safety)");

    // Dangerous GET triggers audit
    const dangerousGetRes = await request("GET", "/api/fix-07/dangerous-get-delete?id=ORD_99");
    assert(dangerousGetRes.status === 200, "Dangerous GET executed");

    auditCheck = await request("GET", "/api/audit");
    assert(auditCheck.json.count === 1, "Audit count is 1 after dangerous GET execution");
    assert(auditCheck.json.events[0].action === "dangerous_get_mutation", "Audit recorded dangerous_get_mutation");

    // Reset restores audit to 0
    await request("POST", "/api/reset");
    auditCheck = await request("GET", "/api/audit");
    assert(auditCheck.json.count === 0, "Reset restores audit count to 0");

    // 9. FIX-09: Faults (404, 500, Blank)
    console.log("\n[Test 9] FIX-09: Faults (404, 500, Blank)");
    const f404 = await request("GET", "/fix-09/broken-404");
    assert(f404.status === 404, "Broken link returns 404");

    const f500 = await request("GET", "/fix-09/error-500");
    assert(f500.status === 500, "Server fault page returns 500");

    const f500Api = await request("GET", "/api/fix-09/500");
    assert(f500Api.status === 500 && f500Api.json.error === "INTERNAL_SERVER_ERROR", "500 API returns 500 JSON");

    const fBlank = await request("GET", "/fix-09/blank");
    assert(fBlank.status === 200 && fBlank.body.includes("<body></body>"), "Blank page returns empty body");

    // 10. FIX-10: Business Rules
    console.log("\n[Test 10] FIX-10: Business Rules Calculation");
    const rulesRes = await request("GET", "/api/fix-10/order-calculation");
    assert(rulesRes.json.scenarioA.isBug === true, "Scenario A is marked as an arithmetic bug against Rule BR-101");
    assert(rulesRes.json.scenarioB.hasRule === false, "Scenario B has no business rule");

    // 11. FIX-11: Flaky vs Stable Faults
    console.log("\n[Test 11] FIX-11: Flaky vs Stable Faults");
    await request("POST", "/api/fix-11/reset-flaky");
    const flaky1 = await request("POST", "/api/fix-11/flaky");
    assert(flaky1.status === 500, "Flaky attempt 1 returns 500");

    const flaky2 = await request("POST", "/api/fix-11/flaky");
    assert(flaky2.status === 200, "Flaky attempt 2 (reproduction) succeeds with 200 OK");

    const stableRes = await request("POST", "/api/fix-11/stable");
    assert(stableRes.status === 500, "Stable fault consistently returns 500");

    // 12. FIX-12: Sentinels
    console.log("\n[Test 12] FIX-12: Sentinels for Redaction");
    const sentinelRes = await request("GET", "/api/fix-12/network-sentinel?token=SENTINEL_TOKEN_SECRET_XYZ8899");
    assert(sentinelRes.json.sentinelDetected === "SENTINEL_TOKEN_SECRET_XYZ8899", "Sentinel value detected in network endpoint");

    // 13. FIX-13: Malicious Input
    console.log("\n[Test 13] FIX-13: Malicious Input Rejection");
    const traversalRes = await request("POST", "/api/fix-13/validate-input", { pathInput: "../../etc/passwd" });
    assert(traversalRes.status === 400 && traversalRes.json.error === "REJECTED_PATH_TRAVERSAL", "Path traversal rejected with 400");

    const fakeIdRes = await request("POST", "/api/fix-13/validate-input", { entityId: "invalid-id-xyz" });
    assert(fakeIdRes.status === 400 && fakeIdRes.json.error === "REJECTED_INVALID_ID", "Fake entity ID rejected with 400");

    const injectionRes = await request("POST", "/api/fix-13/validate-input", { payload: "<script>alert(1)</script>" });
    assert(injectionRes.status === 200 && injectionRes.json.sanitizedPayload.includes("&lt;script&gt;"), "XSS payload safely escaped, no arbitrary execution");

    // 14. FIX-14: Large Range Download
    console.log("\n[Test 14] FIX-14: Large Download & Range Support");
    const rangeRes = await request("GET", "/api/fix-14/download-large?sizeMb=1", null, { "Range": "bytes=0-99" });
    assert(rangeRes.status === 206, "Range request returns 206 Partial Content");
    assert(rangeRes.headers["content-range"].startsWith("bytes 0-99/"), "Content-Range header correct");

    console.log(`\n=== Verification Complete: ${failed === 0 ? "ALL TESTS PASSED" : `${failed} TESTS FAILED`} ===`);
  } catch (err) {
    console.error("Test execution failed:", err);
    failed++;
  } finally {
    server.close();
    process.exit(failed > 0 ? 1 : 0);
  }
}

if (require.main === module) {
  runTests();
}

module.exports = runTests;
