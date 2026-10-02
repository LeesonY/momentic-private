#!/bin/bash
set -e

PORT=8080
BASE_URL="http://localhost:${PORT}"

echo "Starting server on port ${PORT}..."
node server.js &
SERVER_PID=$!

cleanup() {
  echo "Stopping server (PID ${SERVER_PID})..."
  kill ${SERVER_PID} 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server to be up
sleep 1.5

echo "================================================================="
echo "  LOCALQA CONTROLLED TEST FIXTURE - COMPREHENSIVE CURL VERIFICATION"
echo "================================================================="

echo ""
echo "--- [1] OPS: Reset Fixture State ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/reset"

echo ""
echo "--- [2] OPS: Seed Test Data with LQA_<runId>_<caseId> ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/seed" \
  -H "Content-Type: application/json" \
  -d '{"runId": "run_smoke_01", "caseId": "case_101", "count": 3}'

echo ""
echo "--- [3] OPS: Initial Read-only Audit Log (Expected count: 0) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/audit"

echo ""
echo "--- [4] FIX-01: Navigation & Paginated Items ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/fix-01/items?page=1&limit=2"

echo ""
echo "--- [5] FIX-02: Delayed Rendering Endpoint ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/fix-02/data?delay=50"

echo ""
echo "--- [6] FIX-03: Login as Admin ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username": "admin@localqa.fixture", "password": "AdminPass123!"}'

echo ""
echo "--- [7] FIX-03: State Reuse via Bearer Token ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/auth/me" \
  -H "Authorization: Bearer tok_admin_fixed_session"

echo ""
echo "--- [8] FIX-03: Expired Session Rejection ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/auth/me" \
  -H "Authorization: Bearer tok_expired_session"

echo ""
echo "--- [9] FIX-04: Role Permission - Viewer Forbidden (403) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-04/admin-action" \
  -H "Authorization: Bearer tok_viewer_fixed_session"

echo ""
echo "--- [10] FIX-04: Role Permission - Admin Allowed (200) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-04/admin-action" \
  -H "Authorization: Bearer tok_admin_fixed_session"

echo ""
echo "--- [11] FIX-05: DOM Ambiguity Inspection ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-05/inspect" \
  -H "Content-Type: application/json" \
  -d '{"targetId": "LQA_BETA_002"}'

echo ""
echo "--- [12] FIX-06: Same-Origin Frame HTML Verification ---"
curl -s "${BASE_URL}/fix-06-same-origin-frame.html" | grep "data-testid="

echo ""
echo "--- [13] FIX-07: Safe POST Query (Permitted, Audit count must stay 0) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-07/safe-query" \
  -H "Content-Type: application/json" \
  -d '{"query": "Hardware"}'

echo ""
echo "--- [14] FIX-07: Audit Proof (Verifying count = 0 after Safe POST) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/audit"

echo ""
echo "--- [15] FIX-07: Dangerous GET Trigger (Simulating unauthorized mutation) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/fix-07/dangerous-get-delete?id=LQA_order_danger_001"

echo ""
echo "--- [16] FIX-07: Autosave POST Trigger ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-07/autosave" \
  -H "Content-Type: application/json" \
  -d '{"draftContent": "Unauthorized autosaved text"}'

echo ""
echo "--- [17] FIX-07: Audit Proof (Verifying audit count reflects mutations) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/audit"

echo ""
echo "--- [18] FIX-07: Reset Restores Audit to 0 ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/reset"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/audit"

echo ""
echo "--- [19] FIX-08: Canvas Capability Verification ---"
curl -s "${BASE_URL}/fix-08-canvas.html" | grep "data-requires-vision"

echo ""
echo "--- [20] FIX-09: Faults - Broken Link (404) ---"
curl -s -o /dev/null -w "HTTP_STATUS: %{http_code}\n" "${BASE_URL}/fix-09/broken-404"

echo ""
echo "--- [21] FIX-09: Faults - Server Crash Page (500) ---"
curl -s -o /dev/null -w "HTTP_STATUS: %{http_code}\n" "${BASE_URL}/fix-09/error-500"

echo ""
echo "--- [22] FIX-09: Faults - Server API 500 ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/fix-09/500"

echo ""
echo "--- [23] FIX-09: Faults - Blank Page (200 with empty body) ---"
curl -s "${BASE_URL}/fix-09/blank"

echo ""
echo "--- [24] FIX-10: Business Rules Calculation Evaluation ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/fix-10/order-calculation"

echo ""
echo "--- [25] FIX-11: Flaky Fault Attempt 1 (Expected 500) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-11/flaky"

echo ""
echo "--- [26] FIX-11: Flaky Fault Attempt 2 / Reproduction (Expected 200 OK) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-11/flaky"

echo ""
echo "--- [27] FIX-11: Stable Fault (Expected Consistent 500) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-11/stable"

echo ""
echo "--- [28] FIX-12: Sentinels for Redaction Testing ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" "${BASE_URL}/api/fix-12/network-sentinel?token=SENTINEL_TOKEN_SECRET_XYZ8899"

echo ""
echo "--- [29] FIX-13: Path Traversal Rejection (Expected 400 REJECTED_PATH_TRAVERSAL) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-13/validate-input" \
  -H "Content-Type: application/json" \
  -d '{"pathInput": "../../etc/passwd"}'

echo ""
echo "--- [30] FIX-13: Fake Entity ID Rejection (Expected 400 REJECTED_INVALID_ID) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-13/validate-input" \
  -H "Content-Type: application/json" \
  -d '{"entityId": "fake-non-lqa-id-999"}'

echo ""
echo "--- [31] FIX-13: Injection Sanitization (Expected 200 with escaped output) ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\n" -X POST "${BASE_URL}/api/fix-13/validate-input" \
  -H "Content-Type: application/json" \
  -d '{"payload": "<script>alert(\"xss\")</script>"}'

echo ""
echo "--- [32] FIX-14: Large Download Header (30MB Content-Length) ---"
curl -s -I "${BASE_URL}/api/fix-14/download-large?sizeMb=30" | grep -i -E "(Content-Length|Content-Disposition|Accept-Ranges)"

echo ""
echo "--- [33] FIX-14: Range Request (Partial Content 206) ---"
curl -s -i -H "Range: bytes=0-99" "${BASE_URL}/api/fix-14/download-large?sizeMb=1" | head -n 12

echo ""
echo "================================================================="
echo "  CURL VERIFICATION SUITE FINISHED SUCCESSFULLY"
echo "================================================================="
