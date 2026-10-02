import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserManager,
  resolveTarget,
  STABLE_REASON_CODES
} from '../dist/index.js';
import { validateContract } from '@localqa/contracts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_PORT = process.env.PORT || '8080';
const BASE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;

let fixtureProcess = null;
let manager = null;

async function isServerReady(url) {
  try {
    const res = await fetch(`${url}/api/audit`);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerReady(url)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

before(async () => {
  // 1. Ensure test-fixture is running
  const alreadyUp = await isServerReady(BASE_URL);
  if (!alreadyUp) {
    const fixtureDir = path.resolve(__dirname, '../../test-fixture');
    fixtureProcess = spawn('node', ['server.js'], {
      cwd: fixtureDir,
      env: { ...process.env, PORT: FIXTURE_PORT },
      stdio: 'pipe'
    });

    const ready = await waitForServer(BASE_URL, 15000);
    if (!ready) {
      if (fixtureProcess) fixtureProcess.kill('SIGTERM');
      throw new Error(`Test fixture failed to start on ${BASE_URL} within 15 seconds.`);
    }
  }

  // 2. Instantiate BrowserManager
  manager = new BrowserManager();
});

after(async () => {
  if (manager) {
    await manager.close().catch(() => {});
  }
  if (fixtureProcess) {
    fixtureProcess.kill('SIGTERM');
  }
});

describe('T03 Browser Execution Layer Verification', () => {

  describe('1. Task Isolation & Port Cleanliness', () => {
    it('isolates cookies and auth state between separate sessions', async () => {
      // Session A with approved cookie
      const sessionA = await manager.createSession({
        taskId: 'task-iso-a',
        approvedAuthState: {
          cookies: [{
            name: 'session_iso_token',
            value: 'token_val_isolated_123',
            domain: '127.0.0.1',
            path: '/'
          }]
        }
      });

      // Session B completely fresh
      const sessionB = await manager.createSession({
        taskId: 'task-iso-b'
      });

      try {
        const pageA = sessionA.getPage();
        await pageA.goto(`${BASE_URL}/`);
        const cookiesA = await sessionA.getContext().cookies();
        const hasCookieInA = cookiesA.some((c) => c.name === 'session_iso_token');
        assert.strictEqual(hasCookieInA, true, 'Session A must have its approved cookie');

        const pageB = sessionB.getPage();
        await pageB.goto(`${BASE_URL}/`);
        const cookiesB = await sessionB.getContext().cookies();
        const hasCookieInB = cookiesB.some((c) => c.name === 'session_iso_token');
        assert.strictEqual(hasCookieInB, false, 'Session B must NOT leak cookie from Session A');
      } finally {
        await sessionA.close();
        await sessionB.close();
      }
    });
  });

  describe('2. FIX-01: Homepage, Tab Switching, Details, Pagination', () => {
    it('interacts with tabs, details, and pagination while validating snapshots', async () => {
      await fetch(`${BASE_URL}/api/reset`, { method: 'POST' });
      await fetch(`${BASE_URL}/api/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run01', caseId: 'case01', count: 10 })
      });

      const session = await manager.createSession({ taskId: 'task-fix-01' });

      try {
        // Navigate
        const navRes = await session.executeTool({
          name: 'navigate',
          args: { url: `${BASE_URL}/` }
        });
        assert.strictEqual(navRes.status, 'succeeded');

        const snap1 = await session.getSnapshot();
        const val1 = validateContract('BrowserSnapshot', snap1);
        assert.strictEqual(val1.success, true, 'Snapshot must strictly validate against contract schema');

        // Check welcome heading is present
        const welcomeNode = snap1.nodes.find((n) => n.nodeId === 'testid_welcome-heading');
        assert.ok(welcomeNode, 'Should find welcome-heading testid node');
        assert.strictEqual(welcomeNode.visible, true);

        // Click Tab Details (data-testid="tab-btn-details")
        const tabDetailsTarget = {
          snapshotId: snap1.snapshotId,
          pageId: snap1.pageId,
          nodeId: 'testid_tab-btn-details'
        };
        const clickTabRes = await session.executeTool({
          name: 'click',
          args: { target: tabDetailsTarget }
        });
        assert.strictEqual(clickTabRes.status, 'succeeded', 'Tab click must succeed');

        const snap2 = await session.getSnapshot();
        const tabDetailsPanel = snap2.nodes.find((n) => n.nodeId === 'testid_tab-panel-details');
        assert.ok(tabDetailsPanel, 'Tab details panel must be present after tab click');

        // Click Details Accordion Toggle (data-testid="accordion-summary-1")
        const detailsTarget = {
          snapshotId: snap2.snapshotId,
          pageId: snap2.pageId,
          nodeId: 'testid_accordion-summary-1'
        };
        const toggleDetailsRes = await session.executeTool({
          name: 'click',
          args: { target: detailsTarget }
        });
        assert.strictEqual(toggleDetailsRes.status, 'succeeded', 'Accordion toggle must succeed');

        // Click Pagination Next (data-testid="btn-next-page")
        const snap3 = await session.getSnapshot();
        const nextTarget = {
          snapshotId: snap3.snapshotId,
          pageId: snap3.pageId,
          nodeId: 'testid_btn-next-page'
        };
        const nextRes = await session.executeTool({
          name: 'click',
          args: { target: nextTarget }
        });
        assert.strictEqual(nextRes.status, 'succeeded', 'Pagination next must succeed');

        // Give table a moment to load and verify seeded item
        await new Promise((r) => setTimeout(r, 300));
        const snap4 = await session.getSnapshot({ forceFresh: true });
        const tableItem = snap4.nodes.find((n) => n.text.includes('LQA_'));
        assert.ok(tableItem, 'Pagination should load unique LQA_ data items');
      } finally {
        await session.close();
      }
    });
  });

  describe('3. FIX-02: Delayed Rendering with Spinner (State-based wait, NO networkidle)', () => {
    it('waits for delayed element to appear despite active background SSE stream', async () => {
      const session = await manager.createSession({ taskId: 'task-fix-02' });

      try {
        // Navigate to delayed page with SSE background stream
        const navRes = await session.executeTool({
          name: 'navigate',
          args: { url: `${BASE_URL}/fix-02-delayed.html` }
        });
        assert.strictEqual(navRes.status, 'succeeded');

        const snap1 = await session.getSnapshot();
        // Spinner should initially be present
        const spinner = snap1.nodes.find((n) => n.nodeId === 'testid_loading-spinner');
        assert.ok(spinner, 'Spinner node should be present initially');

        const startWait = Date.now();
        // Use state-based wait_for with element_visible (without hanging on networkidle)
        const waitRes = await session.executeTool({
          name: 'wait_for',
          args: {
            pageId: snap1.pageId,
            condition: 'element_visible',
            target: {
              snapshotId: snap1.snapshotId,
              pageId: snap1.pageId,
              nodeId: 'testid_delayed-content-ready'
            },
            timeoutMs: 8000
          }
        });
        const duration = Date.now() - startWait;

        assert.strictEqual(waitRes.status, 'succeeded', 'wait_for must succeed');
        assert.ok(duration < 7000, `Wait should complete reasonably (~1.2s delayed), took ${duration}ms`);

        const snap2 = await session.getSnapshot();
        const readyNode = snap2.nodes.find((n) => n.nodeId === 'testid_delayed-content-ready');
        assert.ok(readyNode, 'Delayed content must be present in snapshot');
        assert.strictEqual(readyNode.visible, true);
      } finally {
        await session.close();
      }
    });
  });

  describe('4. FIX-05: Target Ambiguity, Hidden Elements, and TestID Priority', () => {
    it('rejects ambiguous targets and hidden buttons, succeeds with explicit testId', async () => {
      const session = await manager.createSession({ taskId: 'task-fix-05' });

      try {
        await session.executeTool({
          name: 'navigate',
          args: { url: `${BASE_URL}/fix-05-dom-ambiguity.html` }
        });

        const snap = await session.getSnapshot();

        // 1. Try to target by ambiguous text "Inspect" when 9 identical buttons exist
        // Create a synthetic target node lacking unique testid
        const ambiguousNode = {
          nodeId: 'ambiguous_inspect_node',
          frameId: 'main',
          role: 'button',
          name: 'Inspect',
          text: 'Inspect',
          visible: true,
          enabled: true,
          bounds: { left: 0, top: 0, width: 100, height: 30 }
        };
        const snapWithAmbig = {
          ...snap,
          nodes: [...snap.nodes, ambiguousNode]
        };

        const ambigResolution = await resolveTarget(
          session.getPage(),
          {
            snapshotId: snap.snapshotId,
            pageId: snap.pageId,
            nodeId: ambiguousNode.nodeId
          },
          snapWithAmbig
        );

        assert.strictEqual(ambigResolution.status, 'rejected', 'Ambiguous target must be rejected');
        assert.strictEqual(ambigResolution.reasonCode, STABLE_REASON_CODES.TARGET_AMBIGUOUS);
        assert.strictEqual(ambigResolution.matchCount, 9, 'Should detect exactly 9 ambiguous candidates on page');

        // 2. Try to target hidden danger button (data-testid="hidden-ghost-btn")
        const hiddenNode = {
          nodeId: 'testid_hidden-ghost-btn',
          frameId: 'main',
          role: 'button',
          name: 'Display None Button',
          text: 'Display None Button',
          visible: false,
          enabled: true,
          bounds: { left: 0, top: 0, width: 0, height: 0 }
        };
        const snapWithHidden = {
          ...snap,
          nodes: [...snap.nodes, hiddenNode]
        };

        const hiddenResolution = await resolveTarget(
          session.getPage(),
          {
            snapshotId: snap.snapshotId,
            pageId: snap.pageId,
            nodeId: hiddenNode.nodeId
          },
          snapWithHidden
        );

        assert.strictEqual(hiddenResolution.status, 'rejected', 'Hidden target must be rejected');
        assert.strictEqual(hiddenResolution.reasonCode, STABLE_REASON_CODES.TARGET_HIDDEN);

        // 3. Click specific unambiguous testid (data-testid="btn-inspect-alpha")
        const goodRes = await session.executeTool({
          name: 'click',
          args: {
            target: {
              snapshotId: snap.snapshotId,
              pageId: snap.pageId,
              nodeId: 'testid_btn-inspect-alpha'
            }
          }
        });
        assert.strictEqual(goodRes.status, 'succeeded', 'Explicit testid click must succeed');
      } finally {
        await session.close();
      }
    });
  });

  describe('5. FIX-06: Same-Origin Iframe & Popup Tab Navigation', () => {
    it('captures iframe contents and detects popup pages', async () => {
      const session = await manager.createSession({ taskId: 'task-fix-06' });

      try {
        await session.executeTool({
          name: 'navigate',
          args: { url: `${BASE_URL}/fix-06-frames.html` }
        });

        const snap = await session.getSnapshot();
        assert.ok(snap.frameIds.length > 1, 'Should track more than 1 frame ID');

        // Verify same-origin iframe content is visible in snapshot
        const iframeNode = snap.nodes.find((n) => n.nodeId.includes('same-origin') || n.text.includes('Same-Origin Frame Content'));
        assert.ok(iframeNode, 'Snapshot should contain nodes from same-origin iframe');

        // Click popup button (data-testid="btn-open-popup")
        const popupBtn = snap.nodes.find((n) => n.nodeId === 'testid_btn-open-popup');
        assert.ok(popupBtn, 'Should find open popup button');

        const popupRes = await session.executeTool({
          name: 'click',
          args: {
            target: {
              snapshotId: snap.snapshotId,
              pageId: snap.pageId,
              nodeId: popupBtn.nodeId
            }
          }
        });
        assert.strictEqual(popupRes.status, 'succeeded');

        // Give popup a moment to open
        await new Promise((r) => setTimeout(r, 500));
        const pages = session.getContext().pages();
        assert.ok(pages.length >= 2, 'Context should contain popup page tab');
      } finally {
        await session.close();
      }
    });
  });

  describe('6. FIX-07: P0 non_submitting Policy Check & Audit Proof', () => {
    it('blocks dangerous mutations in non_submitting mode with audit count == 0', async () => {
      // 1. Reset fixture
      const resetRes = await fetch(`${BASE_URL}/api/reset`, { method: 'POST' });
      assert.strictEqual(resetRes.status, 200);

      // Verify audit is clean
      const auditInit = await (await fetch(`${BASE_URL}/api/audit`)).json();
      assert.strictEqual(auditInit.count, 0);

      // 2. Create session with explicit non_submitting mode
      const session = await manager.createSession({
        taskId: 'task-fix-07',
        mode: 'non_submitting'
      });

      try {
        await session.executeTool({
          name: 'navigate',
          args: { url: `${BASE_URL}/fix-07-mutations.html` }
        });

        const snap = await session.getSnapshot();

        // Attempt dangerous delete button
        const delBtn = snap.nodes.find((n) => n.nodeId === 'testid_danger-delete-btn');
        if (delBtn) {
          const delRes = await session.executeTool({
            name: 'click',
            args: {
              target: {
                snapshotId: snap.snapshotId,
                pageId: snap.pageId,
                nodeId: delBtn.nodeId
              }
            }
          });
          assert.strictEqual(delRes.status, 'denied', 'Dangerous delete must be denied by policy');
          assert.ok(
            delRes.reasonCode === STABLE_REASON_CODES.MUTATION_FORBIDDEN ||
            delRes.reasonCode === STABLE_REASON_CODES.POLICY_DENIED
          );
        }

        // Attempt dangerous send button
        const sendBtn = snap.nodes.find((n) => n.nodeId === 'testid_danger-send-btn');
        if (sendBtn) {
          const sendRes = await session.executeTool({
            name: 'click',
            args: {
              target: {
                snapshotId: snap.snapshotId,
                pageId: snap.pageId,
                nodeId: sendBtn.nodeId
              }
            }
          });
          assert.strictEqual(sendRes.status, 'denied', 'Dangerous send message must be denied by policy');
        }

        // Safe query should be permitted
        const safeBtn = snap.nodes.find((n) => n.nodeId === 'testid_safe-query-btn');
        if (safeBtn) {
          const safeRes = await session.executeTool({
            name: 'click',
            args: {
              target: {
                snapshotId: snap.snapshotId,
                pageId: snap.pageId,
                nodeId: safeBtn.nodeId
              }
            }
          });
          assert.strictEqual(safeRes.status, 'succeeded', 'Safe query action must succeed');
        }

        // 3. Final Audit Verification: count MUST be 0!
        const auditFinal = await (await fetch(`${BASE_URL}/api/audit`)).json();
        assert.strictEqual(auditFinal.count, 0, 'Audit count MUST strictly remain 0 after non_submitting exploration');
      } finally {
        await session.close();
      }
    });
  });

  describe('7. FIX-12: Sensitive Data Redaction & Contracts Schema Validation', () => {
    it('redacts sensitive query tokens and passwords from snapshot and logs', async () => {
      const session = await manager.createSession({ taskId: 'task-fix-12' });

      try {
        const sensitiveUrl = `${BASE_URL}/fix-12-sentinels.html?token=super_secret_query_tok&auth=jwt_secret_999`;
        await session.executeTool({
          name: 'navigate',
          args: { url: sensitiveUrl }
        });

        const snap = await session.getSnapshot();

        // 1. Verify URL redaction
        assert.ok(!snap.displayUrl.includes('super_secret_query_tok'), 'Sensitive token must be redacted from displayUrl');
        assert.ok(!snap.displayUrl.includes('jwt_secret_999'), 'Sensitive auth parameter must be redacted from displayUrl');
        assert.ok(
          snap.displayUrl.includes('redacted') || snap.displayUrl.includes('%5Bredacted%5D'),
          'Redacted marker must appear in displayUrl'
        );

        // 2. Verify password field value is masked
        const pwdNode = snap.nodes.find((n) => n.nodeId === 'testid_sensitive-input-pass');
        assert.ok(pwdNode, 'Should find sensitive password input node');
        assert.strictEqual(pwdNode.text, '[redacted]', 'Password node text must be redacted');
        assert.ok(
          !JSON.stringify(pwdNode).includes('SENTINEL_PASSWORD_SUPER_SECRET_9999'),
          'Sentinel password must not appear anywhere in password input node'
        );

        // 3. Verify snapshot validates against contract
        const validation = validateContract('BrowserSnapshot', snap);
        assert.strictEqual(validation.success, true, 'Snapshot must adhere to @localqa/contracts schema');
      } finally {
        await session.close();
      }
    });
  });

  describe('8. Prohibited Tools, Repetition Failsafes & Cancellation', () => {
    it('rejects prohibited tools like evaluate or shell', async () => {
      const session = await manager.createSession({ taskId: 'task-prohibited' });

      try {
        const prohibitedRes = await session.executeTool({
          name: 'evaluate',
          args: { script: 'alert(1)' }
        });
        assert.strictEqual(prohibitedRes.status, 'denied');
        assert.strictEqual(prohibitedRes.reasonCode, STABLE_REASON_CODES.PROHIBITED_TOOL);
      } finally {
        await session.close();
      }
    });

    it('rejects invalid schema arguments with INVALID_TOOL_ARGUMENTS', async () => {
      const session = await manager.createSession({ taskId: 'task-invalid-args' });

      try {
        const invalidRes = await session.executeTool({
          name: 'navigate',
          args: { wrongField: 123 }
        });
        assert.strictEqual(invalidRes.status, 'failed');
        assert.strictEqual(invalidRes.reasonCode, STABLE_REASON_CODES.INVALID_TOOL_ARGUMENTS);
      } finally {
        await session.close();
      }
    });

    it('detects action repetition loop after repeated identical actions', async () => {
      const session = await manager.createSession({ taskId: 'task-loop' });

      try {
        await session.executeTool({
          name: 'navigate',
          args: { url: `${BASE_URL}/` }
        });

        let lastRes = null;
        for (let i = 0; i < 4; i++) {
          lastRes = await session.executeTool({
            name: 'navigate',
            args: { url: `${BASE_URL}/` }
          });
        }
        assert.strictEqual(lastRes.status, 'failed');
        assert.strictEqual(lastRes.reasonCode, STABLE_REASON_CODES.REPEATED_ACTION_LIMIT);
      } finally {
        await session.close();
      }
    });

    it('handles cancellation via AbortSignal', async () => {
      const session = await manager.createSession({ taskId: 'task-cancel' });

      try {
        const controller = new AbortController();
        controller.abort('User cancellation');

        const cancelledRes = await session.executeTool(
          {
            name: 'navigate',
            args: { url: `${BASE_URL}/` }
          },
          { signal: controller.signal }
        );

        assert.strictEqual(cancelledRes.status, 'cancelled');
        assert.strictEqual(cancelledRes.reasonCode, STABLE_REASON_CODES.ACTION_CANCELLED);
      } finally {
        await session.close();
      }
    });
  });

});
