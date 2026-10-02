/**
 * LocalQA Controlled Test Fixture Site
 * Server implementation supporting FIX-01 through FIX-14
 */

const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const store = require("./store");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper to extract authenticated user from header or cookie
function getAuthUser(req) {
  let token = null;
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else if (req.cookies && req.cookies["session_token"]) {
    token = req.cookies["session_token"];
  }

  if (!token) return null;
  return store.verifyToken(token);
}

// ---------------------------------------------------------------------------
// Static Assets
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Operations & Admin Endpoints (Ops)
// ---------------------------------------------------------------------------

// POST /api/reset (also /api/ops/reset)
function handleReset(req, res) {
  const result = store.reset();
  res.status(200).json(result);
}
app.post("/api/reset", handleReset);
app.post("/api/ops/reset", handleReset);

// POST /api/seed (also /api/ops/seed)
function handleSeed(req, res) {
  const { runId, caseId, count } = req.body || {};
  const result = store.seed({
    runId: runId || "run_default",
    caseId: caseId || "case_01",
    count: count ? parseInt(count, 10) : 6
  });
  res.status(200).json(result);
}
app.post("/api/seed", handleSeed);
app.post("/api/ops/seed", handleSeed);

// GET /api/audit (also /api/ops/audit) - Read-only audit log
function handleAudit(req, res) {
  const filter = {
    action: req.query.action,
    method: req.query.method,
    path: req.query.path
  };
  const logs = store.getAuditLogs(filter);
  res.status(200).json(logs);
}
app.get("/api/audit", handleAudit);
app.get("/api/ops/audit", handleAudit);

// ---------------------------------------------------------------------------
// Authentication Endpoints (FIX-03 & Global)
// ---------------------------------------------------------------------------

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "BAD_REQUEST", message: "Username and password required" });
  }

  const account = store.authenticate(username, password);
  if (!account) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Invalid username or password" });
  }

  const token = account.token || `tok_session_${account.role}_${Date.now()}`;
  res.cookie("session_token", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/"
  });

  return res.status(200).json({
    success: true,
    token,
    role: account.role,
    name: account.name,
    email: account.email
  });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("session_token", { path: "/" });
  return res.status(200).json({ success: true, message: "Logged out successfully" });
});

app.get("/api/auth/me", (req, res) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "No active session" });
  }
  if (user.expired) {
    return res.status(401).json({ error: "SESSION_EXPIRED", message: "Session token has expired" });
  }
  return res.status(200).json({ success: true, user });
});

// ---------------------------------------------------------------------------
// FIX-01: Navigation, Tabs, Pagination
// ---------------------------------------------------------------------------
app.get("/api/fix-01/items", (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.max(1, parseInt(req.query.limit || "2", 10));
  const offset = (page - 1) * limit;
  const paginatedItems = store.items.slice(offset, offset + limit);

  return res.status(200).json({
    total: store.items.length,
    page,
    limit,
    totalPages: Math.ceil(store.items.length / limit),
    items: paginatedItems
  });
});

// ---------------------------------------------------------------------------
// FIX-02: Delayed Rendering, Spinner, Persistent Connection
// ---------------------------------------------------------------------------
app.get("/api/fix-02/data", (req, res) => {
  const delayMs = parseInt(req.query.delay || "1200", 10);
  setTimeout(() => {
    res.status(200).json({
      success: true,
      message: "Dynamic data loaded successfully after delay",
      loadedAt: new Date().toISOString(),
      payload: {
        status: "READY",
        records: [
          { id: "REC-201", label: "Async Task Alpha", status: "completed" },
          { id: "REC-202", label: "Async Task Beta", status: "verified" }
        ]
      }
    });
  }, Math.min(delayMs, 10000));
});

// Server-Sent Events stream for persistent background connection
app.get("/api/fix-02/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  res.write(`data: ${JSON.stringify({ type: "connected", time: new Date().toISOString() })}\n\n`);

  const intervalId = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: "heartbeat", ping: Date.now() })}\n\n`);
  }, 2000);

  req.on("close", () => {
    clearInterval(intervalId);
    res.end();
  });
});

// ---------------------------------------------------------------------------
// FIX-03: Protected Endpoint for Session Reuse
// ---------------------------------------------------------------------------
app.get("/api/fix-03/protected", (req, res) => {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Authentication required" });
  }
  if (user.expired) {
    return res.status(401).json({ error: "SESSION_EXPIRED", message: "Your session has expired" });
  }
  return res.status(200).json({
    success: true,
    message: `Access granted for ${user.email} (${user.role})`,
    timestamp: new Date().toISOString()
  });
});

// ---------------------------------------------------------------------------
// FIX-04: Role Differences (Admin vs Viewer)
// ---------------------------------------------------------------------------
app.post("/api/fix-04/admin-action", (req, res) => {
  const user = getAuthUser(req);
  if (!user || user.expired) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Authentication required" });
  }
  if (user.role !== "admin") {
    return res.status(403).json({
      error: "FORBIDDEN",
      message: "Viewer role is not authorized to perform admin actions"
    });
  }

  store.settings.maintenanceMode = !store.settings.maintenanceMode;
  return res.status(200).json({
    success: true,
    message: "Admin action performed: Maintenance mode toggled",
    maintenanceMode: store.settings.maintenanceMode
  });
});

// ---------------------------------------------------------------------------
// FIX-05: Inspect Item (DOM Ambiguity Test)
// ---------------------------------------------------------------------------
app.post("/api/fix-05/inspect", (req, res) => {
  const { targetId } = req.body || {};
  return res.status(200).json({
    success: true,
    targetId: targetId || "unknown",
    inspectedAt: new Date().toISOString()
  });
});

// ---------------------------------------------------------------------------
// FIX-07: Mutations, Dangerous GET, Autosave, Delete, Send, Redirect
// ---------------------------------------------------------------------------

// Safe POST: search/query without state mutation (does NOT record in dangerous audit)
app.post("/api/fix-07/safe-query", (req, res) => {
  const { query } = req.body || {};
  return res.status(200).json({
    success: true,
    type: "SAFE_QUERY_NO_MUTATION",
    results: store.items.filter(item => !query || item.name.includes(query))
  });
});

// Dangerous GET: State mutation via GET (Anti-pattern that mutates data)
app.get("/api/fix-07/dangerous-get-delete", (req, res) => {
  const { id } = req.query;
  store.recordAudit("dangerous_get_mutation", "GET", req.originalUrl, { targetId: id }, req.ip);
  return res.status(200).json({
    warning: "State mutated via dangerous GET link",
    mutatedId: id,
    auditLogged: true
  });
});

// Autosave endpoint (Mutates draft)
app.post("/api/fix-07/autosave", (req, res) => {
  const { draftContent } = req.body || {};
  store.autosaveDraft = draftContent || "";
  store.recordAudit("autosave_mutation", "POST", req.originalUrl, { draftLength: (draftContent || "").length }, req.ip);
  return res.status(200).json({
    success: true,
    message: "Draft autosaved to server",
    auditLogged: true
  });
});

// Delete endpoint
app.post("/api/fix-07/delete", (req, res) => {
  const { recordId } = req.body || {};
  store.deletedRecords.push(recordId || "default_id");
  store.recordAudit("delete_record", "POST", req.originalUrl, { recordId }, req.ip);
  return res.status(200).json({
    success: true,
    message: `Record ${recordId} deleted`,
    auditLogged: true
  });
});

// Send message endpoint
app.post("/api/fix-07/send-message", (req, res) => {
  const { recipient, message } = req.body || {};
  store.sentMessages.push({ recipient, message, sentAt: new Date().toISOString() });
  store.recordAudit("send_message", "POST", req.originalUrl, { recipient, messageLength: (message || "").length }, req.ip);
  return res.status(200).json({
    success: true,
    message: "Message dispatched (simulated)",
    auditLogged: true
  });
});

// External redirect endpoint
app.get("/api/fix-07/external-redirect", (req, res) => {
  const target = req.query.target || "https://unauthorized-external-domain.example/target";
  store.recordAudit("external_redirect", "GET", req.originalUrl, { target }, req.ip);
  return res.redirect(302, target);
});

// ---------------------------------------------------------------------------
// FIX-09: Broken Link, 500, Blank Page
// ---------------------------------------------------------------------------
app.get("/fix-09/broken-404", (req, res) => {
  res.status(404).send("404 Not Found - Broken Link Target");
});

app.get("/fix-09/error-500", (req, res) => {
  res.status(500).send("500 Internal Server Error - Simulated Unhandled Server Fault");
});

app.get("/api/fix-09/500", (req, res) => {
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: "Fixed 500 fault simulation" });
});

app.get("/fix-09/blank", (req, res) => {
  res.set("Content-Type", "text/html");
  res.status(200).send("<!DOCTYPE html><html><head><title>Blank</title></head><body></body></html>");
});

// ---------------------------------------------------------------------------
// FIX-10: Business Rules & Calculation Errors
// ---------------------------------------------------------------------------
app.get("/api/fix-10/order-calculation", (req, res) => {
  // Scenario A has an explicit rule: Total = (UnitPrice * Quantity) - Discount
  // 100 * 3 - 10 = 290. Displayed is 999.00 -> Intentional calculation fault.
  return res.status(200).json({
    orderId: "ORD-BR-101",
    scenarioA: {
      hasRule: true,
      ruleCode: "BR-101",
      ruleDescription: "Total MUST equal (UnitPrice * Quantity) - Discount",
      unitPrice: 100.0,
      quantity: 3,
      discount: 10.0,
      expectedTotal: 290.0,
      displayedTotal: 999.0,
      isBug: true
    },
    scenarioB: {
      hasRule: false,
      ruleDescription: "Tier promotional bonus points allocation (No published business rule)",
      tier: "Silver",
      bonusRate: 0.035,
      cashRebate: 12.5,
      isBug: false // Cannot infer bug without explicit rule
    }
  });
});

// ---------------------------------------------------------------------------
// FIX-11: Flaky vs Stable Faults
// ---------------------------------------------------------------------------
app.post("/api/fix-11/flaky", (req, res) => {
  store.flakyAttempts += 1;
  if (store.flakyAttempts === 1) {
    return res.status(500).json({
      error: "TRANSIENT_NETWORK_TIMEOUT",
      message: "Attempt 1 failed with transient upstream connection blip",
      attempt: store.flakyAttempts
    });
  }
  return res.status(200).json({
    success: true,
    message: "Attempt succeeded on retry/reproduction",
    attempt: store.flakyAttempts
  });
});

app.post("/api/fix-11/reset-flaky", (req, res) => {
  store.flakyAttempts = 0;
  res.status(200).json({ success: true, flakyAttempts: 0 });
});

app.post("/api/fix-11/stable", (req, res) => {
  return res.status(500).json({
    error: "PERMANENT_LOGIC_ERROR",
    message: "Persistent unhandled exception in core calculation pipeline"
  });
});

// ---------------------------------------------------------------------------
// FIX-12: Sentinels for Redaction Testing
// ---------------------------------------------------------------------------
app.get("/api/fix-12/network-sentinel", (req, res) => {
  const token = req.query.token || req.headers["x-sentinel-token"] || "SENTINEL_TOKEN_SECRET_XYZ8899";
  res.status(200).json({
    status: "ok",
    sentinelDetected: token,
    apiKey: "SENTINEL_API_KEY_LIVE_QA_TEST_7777",
    timestamp: new Date().toISOString()
  });
});

// ---------------------------------------------------------------------------
// FIX-13: Malicious Input Validation
// ---------------------------------------------------------------------------
app.post("/api/fix-13/validate-input", (req, res) => {
  const { pathInput, entityId, payload } = req.body || {};

  // Check 1: Path traversal
  if (pathInput && (pathInput.includes("../") || pathInput.includes("..\\") || pathInput.startsWith("/etc/"))) {
    return res.status(400).json({
      error: "REJECTED_PATH_TRAVERSAL",
      message: "Path traversal attempt detected and blocked"
    });
  }

  // Check 2: Fake/malformed ID
  if (entityId && !/^LQA_[a-zA-Z0-9_]+$/.test(entityId)) {
    return res.status(400).json({
      error: "REJECTED_INVALID_ID",
      message: "Entity ID does not conform to valid LQA schema"
    });
  }

  // Check 3: Escaped payload output (prevent arbitrary execution)
  const sanitized = String(payload || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  return res.status(200).json({
    success: true,
    message: "Input accepted and safely sanitized",
    sanitizedPayload: sanitized
  });
});

// ---------------------------------------------------------------------------
// FIX-14: Large DOM & Oversized Downloads
// ---------------------------------------------------------------------------
app.get("/fix-14-large/huge-dom", (req, res) => {
  const count = Math.min(10000, Math.max(100, parseInt(req.query.count || "3000", 10)));
  res.set("Content-Type", "text/html; charset=utf-8");

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>FIX-14: Huge DOM Page (${count} Elements)</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <h1>Huge DOM Test Page (${count} Elements)</h1>
    <a href="/fix-14-large.html">Back to FIX-14 Hub</a>
  </header>
  <main id="huge-dom-container" data-testid="huge-dom-container">
    <p>This page renders a massive DOM tree to test snapshot token limits, memory, and degraded recorder handling.</p>
    <div class="card-grid">`;

  for (let i = 1; i <= count; i++) {
    html += `
      <div class="node-card" id="node-${i}" data-node-index="${i}">
        <span class="node-id">#${i}</span>
        <span class="node-title">Deep DOM Element ${i}</span>
        <span class="node-badge" data-testid="badge-${i}">Active</span>
      </div>`;
  }

  html += `
    </div>
  </main>
</body>
</html>`;

  res.send(html);
});

// Streaming large download endpoint (supporting HTTP Range requests)
app.get("/api/fix-14/download-large", (req, res) => {
  // Default 30MB, which exceeds the standard 25 MiB artifact limit
  const sizeMb = Math.min(100, Math.max(1, parseInt(req.query.sizeMb || "30", 10)));
  const totalBytes = sizeMb * 1024 * 1024;
  const chunkPattern = Buffer.from("LOCALQA_FIXTURE_LARGE_FILE_STREAM_DATA_CHUNK_TEST_0123456789\n");

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalBytes - 1;
    const chunksize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${totalBytes}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="large-file-${sizeMb}mb.bin"`
    });

    let sent = 0;
    while (sent < chunksize) {
      const toSend = Math.min(chunkPattern.length, chunksize - sent);
      res.write(chunkPattern.subarray(0, toSend));
      sent += toSend;
    }
    return res.end();
  }

  res.writeHead(200, {
    "Content-Length": totalBytes,
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `attachment; filename="large-file-${sizeMb}mb.bin"`
  });

  let bytesWritten = 0;
  function writeChunk() {
    let ok = true;
    while (bytesWritten < totalBytes && ok) {
      const remaining = totalBytes - bytesWritten;
      const toWrite = Math.min(remaining, chunkPattern.length);
      bytesWritten += toWrite;
      if (bytesWritten >= totalBytes) {
        res.end(chunkPattern.subarray(0, toWrite));
        return;
      } else {
        ok = res.write(chunkPattern.subarray(0, toWrite));
      }
    }
    if (bytesWritten < totalBytes) {
      res.once("drain", writeChunk);
    }
  }

  writeChunk();
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`[LocalQA Fixture] Server listening on http://localhost:${PORT}`);
    console.log(`[LocalQA Fixture] Ops endpoints: /api/reset, /api/seed, /api/audit`);
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}

module.exports = app;
