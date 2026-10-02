/**
 * LocalQA Test Fixture State Store
 * In-memory data store for reset, seed, audit, accounts, and fault injections.
 */

class FixtureStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.auditLogs = [];
    this.items = [];
    this.flakyAttempts = 0;
    this.autosaveDraft = "";
    this.deletedRecords = [];
    this.sentMessages = [];
    this.settings = {
      theme: "light",
      maintenanceMode: false,
      notificationsEnabled: true
    };

    // Default seed on reset for immediate availability
    this.seed({
      runId: "run_default",
      caseId: "case_01",
      count: 6
    });

    return {
      success: true,
      message: "Fixture state reset successfully",
      auditCount: this.auditLogs.length,
      itemCount: this.items.length,
      timestamp: new Date().toISOString()
    };
  }

  seed({ runId = "run_default", caseId = "case_01", count = 6 }) {
    this.items = [];
    for (let i = 1; i <= count; i++) {
      this.items.push({
        id: `LQA_${runId}_${caseId}_item_${i}`,
        runId,
        caseId,
        name: `Fixture Test Item #${i}`,
        sku: `SKU-${1000 + i}`,
        category: i % 2 === 0 ? "Hardware" : "Software",
        price: (i * 29.99).toFixed(2),
        status: i % 3 === 0 ? "archived" : "active",
        createdAt: new Date(Date.now() - (count - i) * 60000).toISOString()
      });
    }
    return {
      success: true,
      seededCount: this.items.length,
      runId,
      caseId,
      items: this.items
    };
  }

  recordAudit(action, method, path, details = {}, ip = "127.0.0.1") {
    const entry = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      action,
      method,
      path,
      details,
      ip,
      timestamp: new Date().toISOString()
    };
    this.auditLogs.push(entry);
    return entry;
  }

  getAuditLogs(filter = {}) {
    let result = [...this.auditLogs];
    if (filter.action) {
      result = result.filter(e => e.action === filter.action);
    }
    if (filter.method) {
      result = result.filter(e => e.method.toUpperCase() === filter.method.toUpperCase());
    }
    if (filter.path) {
      result = result.filter(e => e.path.includes(filter.path));
    }
    return {
      count: result.length,
      events: result
    };
  }

  // Pre-configured role accounts
  getAccounts() {
    return {
      "admin@localqa.fixture": {
        email: "admin@localqa.fixture",
        password: "AdminPass123!",
        role: "admin",
        name: "Fixture Administrator",
        token: "tok_admin_fixed_session"
      },
      "viewer@localqa.fixture": {
        email: "viewer@localqa.fixture",
        password: "ViewerPass123!",
        role: "viewer",
        name: "Fixture Viewer",
        token: "tok_viewer_fixed_session"
      },
      "expired@localqa.fixture": {
        email: "expired@localqa.fixture",
        password: "ExpiredPass123!",
        role: "viewer",
        name: "Expired Session User",
        token: "tok_expired_session",
        isExpired: true
      }
    };
  }

  authenticate(username, password) {
    const accounts = this.getAccounts();
    const account = accounts[username];
    if (!account || account.password !== password) {
      return null;
    }
    return account;
  }

  verifyToken(token) {
    if (!token) return null;
    if (token === "tok_expired_session") {
      return { expired: true, error: "SESSION_EXPIRED" };
    }
    if (token === "tok_admin_fixed_session") {
      return {
        email: "admin@localqa.fixture",
        role: "admin",
        name: "Fixture Administrator"
      };
    }
    if (token === "tok_viewer_fixed_session") {
      return {
        email: "viewer@localqa.fixture",
        role: "viewer",
        name: "Fixture Viewer"
      };
    }
    if (token.startsWith("tok_session_admin_")) {
      return {
        email: "admin@localqa.fixture",
        role: "admin",
        name: "Fixture Administrator"
      };
    }
    if (token.startsWith("tok_session_viewer_")) {
      return {
        email: "viewer@localqa.fixture",
        role: "viewer",
        name: "Fixture Viewer"
      };
    }
    return null;
  }
}

const store = new FixtureStore();

module.exports = store;
