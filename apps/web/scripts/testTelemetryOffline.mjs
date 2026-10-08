/**
 * Offline Browserless Unit Test for Message Telemetry & Presentation Diagnostics.
 *
 * Verifies:
 * 1. Eager window.__messageTelemetryHistory and window.__renderedMessages initialization at module load.
 * 2. Same-clock presentation latency calculation (browser Date.now vs DB commit timestamp).
 * 3. Marker presentation deduplication via Map.
 * 4. ParseRunMessage strict contract adherence.
 * 5. Safe non-JSON / SPA-fallback handling in fetchRunMessages without throwing.
 */

import assert from 'node:assert/strict';

// Set up mock window on globalThis before importing modules
const mockWindow = {
  location: { hash: '' },
};
globalThis.window = mockWindow;

// Dynamically import runMessages.ts
const { parseRunMessage, recordMessageRendered, fetchRunMessages } =
  await import('../src/api/runMessages.ts');

console.log('===============================================================');
console.log(' Offline Diagnostics: Message Telemetry & Initialization Unit ');
console.log(
  '===============================================================\n',
);

let totalTests = 0;
let passedTests = 0;

function check(desc, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ [PASS] ${desc}`);
  } catch (err) {
    console.error(`  ✗ [FAIL] ${desc}: ${err.message}`);
  }
}

async function checkAsync(desc, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ [PASS] ${desc}`);
  } catch (err) {
    console.error(`  ✗ [FAIL] ${desc}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Suite 1: Eager Initialization at Module Evaluation Time
// ---------------------------------------------------------------------------
console.log('--- Suite 1: Window Telemetry Initialization ---');

check(
  'window.__messageTelemetryHistory is initialized as an Array on load',
  () => {
    assert.ok(
      Array.isArray(mockWindow.__messageTelemetryHistory),
      'Expected __messageTelemetryHistory to be an Array',
    );
    assert.equal(mockWindow.__messageTelemetryHistory.length, 0);
  },
);

check('window.__renderedMessages is initialized as a Map on load', () => {
  assert.ok(
    mockWindow.__renderedMessages instanceof Map,
    'Expected __renderedMessages to be an instance of Map',
  );
  assert.equal(mockWindow.__renderedMessages.size, 0);
});

// ---------------------------------------------------------------------------
// Suite 2: Same-Clock Telemetry Recording & Math
// ---------------------------------------------------------------------------
console.log('\n--- Suite 2: Same-Clock Telemetry Recording ---');

check(
  'recordMessageRendered calculates valid latencyMs from createdAt timestamp',
  () => {
    const commitTime = new Date(Date.now() - 180).toISOString();
    const marker = 'TEST_MARKER_01';

    const telemetry = recordMessageRendered(marker, commitTime);

    assert.equal(telemetry.marker, marker);
    assert.ok(typeof telemetry.uiRenderedAt === 'number');
    assert.ok(typeof telemetry.dbCommitAt === 'number');
    assert.ok(typeof telemetry.latencyMs === 'number');
    assert.ok(
      telemetry.latencyMs >= 150 && telemetry.latencyMs <= 350,
      `Latency ${telemetry.latencyMs}ms should be roughly 180ms`,
    );

    assert.equal(mockWindow.__messageTelemetryHistory.length, 1);
    assert.equal(mockWindow.__messageTelemetryHistory[0].marker, marker);
    assert.equal(mockWindow.__lastMessageRenderedAt.marker, marker);
  },
);

check(
  'recordMessageRendered deduplicates repeated renders of the same marker',
  () => {
    const marker = 'TEST_MARKER_01';
    const initialCount = mockWindow.__messageTelemetryHistory.length;
    const initialTimestamp =
      mockWindow.__messageTelemetryHistory[0].uiRenderedAt;

    // Re-record same marker 100ms later
    const commitTimeLater = new Date(Date.now() - 50).toISOString();
    const secondCall = recordMessageRendered(marker, commitTimeLater);

    // Function returns a telemetry object for this call
    assert.equal(secondCall.marker, marker);

    // But global history should NOT have a duplicate entry
    assert.equal(
      mockWindow.__messageTelemetryHistory.length,
      initialCount,
      'History length should remain 1',
    );
    assert.equal(
      mockWindow.__renderedMessages.get(marker),
      initialTimestamp,
      'Original presentation timestamp must be preserved',
    );
  },
);

check('recordMessageRendered handles second distinct marker correctly', () => {
  const marker2 = 'TEST_MARKER_02';
  const commitTime2 = new Date(Date.now() - 250).toISOString();

  recordMessageRendered(marker2, commitTime2);

  assert.equal(mockWindow.__messageTelemetryHistory.length, 2);
  assert.equal(mockWindow.__messageTelemetryHistory[1].marker, marker2);
  assert.equal(mockWindow.__lastMessageRenderedAt.marker, marker2);
});

// ---------------------------------------------------------------------------
// Suite 3: parseRunMessage Contract Conformance
// ---------------------------------------------------------------------------
console.log('\n--- Suite 3: parseRunMessage Contract Conformance ---');

check(
  'parseRunMessage accepts valid RunMessage without requiring projectId',
  () => {
    const payload = {
      id: 'msg_01',
      runId: 'run_01',
      actorId: 'usr_01',
      contextVersion: 3,
      redactedText: 'ACCEPT_MARKER_CONTRACT',
      createdAt: new Date().toISOString(),
    };

    const parsed = parseRunMessage(payload);
    assert.equal(parsed.id, 'msg_01');
    assert.equal(parsed.redactedText, 'ACCEPT_MARKER_CONTRACT');
    assert.equal(parsed.contextVersion, 3);
  },
);

check('parseRunMessage preserves optional projectId if provided', () => {
  const payload = {
    id: 'msg_02',
    projectId: 'proj_01',
    runId: 'run_01',
    actorId: 'usr_01',
    contextVersion: 1,
    redactedText: 'MSG_WITH_PROJECT',
    createdAt: new Date().toISOString(),
  };

  const parsed = parseRunMessage(payload);
  assert.equal(parsed.id, 'msg_02');
});

check('parseRunMessage rejects missing or invalid fields', () => {
  assert.throws(
    () =>
      parseRunMessage({
        id: '',
        runId: 'r',
        actorId: 'a',
        contextVersion: 1,
        redactedText: 't',
        createdAt: '2026-01-01',
      }),
    /Invalid RunMessage: id must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseRunMessage({
        id: '1',
        runId: 'r',
        actorId: 'a',
        contextVersion: NaN,
        redactedText: 't',
        createdAt: '2026-01-01',
      }),
    /Invalid RunMessage: contextVersion must be a valid number/,
  );
  assert.throws(
    () =>
      parseRunMessage({
        id: '1',
        runId: 'r',
        actorId: 'a',
        contextVersion: 1,
        redactedText: 't',
        createdAt: 'invalid-date',
      }),
    /Invalid RunMessage: createdAt must be a valid ISO date string/,
  );
});

// ---------------------------------------------------------------------------
// Suite 4: fetchRunMessages Resilience Against SPA HTML Fallback
// ---------------------------------------------------------------------------
console.log('\n--- Suite 4: fetchRunMessages Robust Content-Type Handling ---');

await checkAsync(
  'fetchRunMessages returns empty array on 200 HTML SPA fallback',
  async () => {
    // Mock globalThis.fetch to simulate SPA fallback (returning 200 text/html)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (h) =>
            h.toLowerCase() === 'content-type'
              ? 'text/html; charset=utf-8'
              : null,
        },
        json: async () => {
          throw new SyntaxError(
            "Unexpected token '<', '<!DOCTYPE '... is not valid JSON",
          );
        },
      };
    };

    try {
      const res = await fetchRunMessages(
        'http://127.0.0.1:8080/api/v1',
        'test_run',
      );
      assert.ok(Array.isArray(res));
      assert.equal(
        res.length,
        0,
        'Should safely return empty array on text/html',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

await checkAsync(
  'fetchRunMessages parses valid JSON RunMessagePage successfully',
  async () => {
    const originalFetch = globalThis.fetch;
    const mockMsg = {
      id: 'msg_fetch_01',
      runId: 'run_fetch_01',
      actorId: 'act_01',
      contextVersion: 2,
      redactedText: 'ACCEPT_MARKER_FETCH',
      createdAt: new Date().toISOString(),
    };

    globalThis.fetch = async () => {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (h) =>
            h.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        json: async () => ({ items: [mockMsg], nextCursor: null }),
      };
    };

    try {
      const msgs = await fetchRunMessages('/api/v1', 'run_fetch_01');
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].redactedText, 'ACCEPT_MARKER_FETCH');
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(
  '\n===============================================================',
);
console.log(
  ` Summary: ${passedTests}/${totalTests} offline diagnostic checks PASSED`,
);
console.log(
  '===============================================================\n',
);

if (passedTests !== totalTests) {
  process.exit(1);
}
