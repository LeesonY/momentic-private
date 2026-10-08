import http from 'node:http';
import {
  normalizeApiUrl,
  checkRealBackendHealth,
  createProxyServer,
} from './httpProxyHelper.mjs';

console.log('====================================================');
console.log(' LocalQA: HTTP Helper & Reverse Proxy Realism Test ');
console.log('====================================================\n');

// Track server sockets for reliable teardown
function trackSockets(srv) {
  const sockets = new Set();
  srv.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  return async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise((resolve) => srv.close(resolve));
  };
}

// 1. Create a controlled mock backend server on ephemeral port
let receivedHeaders = null;
let receivedUrl = null;
let receivedMethod = null;
let receivedBody = '';
let clientAbortedDetected = false;
const boundTokens = new Map();

const mockBackend = http.createServer((req, res) => {
  receivedHeaders = { ...req.headers };
  receivedUrl = req.url;
  receivedMethod = req.method;
  receivedBody = '';

  req.on('data', (chunk) => {
    receivedBody += chunk;
  });

  req.on('close', () => {
    if (!res.writableEnded) {
      clientAbortedDetected = true;
    }
  });

  if (req.url === '/api/v1/health/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }),
    );
    return;
  }

  if (req.url.startsWith('/api/v1/projects')) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'session=test-token-123; HttpOnly; Path=/; SameSite=Lax',
    });
    res.end(
      JSON.stringify({
        items: [{ id: 'proj-1', name: 'Project 1' }],
        total: 1,
      }),
    );
    return;
  }

  if (req.url === '/api/v1/regression-runs' && req.method === 'POST') {
    req.on('end', () => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'run_test_001', status: 'pending' }));
    });
    return;
  }

  // SSE streaming endpoint: sends first chunk, waits, then ends
  if (req.url === '/api/v1/runs/r1/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: run.started\ndata: {"seq":1}\n\n');

    // Wait 300ms before sending final chunk and ending
    setTimeout(() => {
      if (!res.writableEnded) {
        res.write('event: run.completed\ndata: {"seq":2}\n\n');
        res.end();
      }
    }, 300);
    return;
  }

  // Review Preview endpoint (T10-B2: binds expectedVersion, decision, reason)
  if (
    req.url?.match(
      /\/api\/v1\/saved-case-versions\/([^/]+)\/review-preview$/,
    ) &&
    req.method === 'POST'
  ) {
    req.on('end', () => {
      try {
        const body = JSON.parse(receivedBody);
        if (
          typeof body.expectedVersion !== 'number' ||
          !['approve', 'reject'].includes(body.decision) ||
          !body.reason ||
          !body.reason.trim()
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'INVALID_INPUT',
              message: 'Invalid review preview input',
            }),
          );
          return;
        }
        const token = `tok_bound_${Date.now()}`;
        boundTokens.set(token, {
          versionId: req.url.split('/')[4],
          expectedVersion: body.expectedVersion,
          decision: body.decision,
          reason: body.reason.trim(),
          used: false,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            versionId: req.url.split('/')[4],
            expectedVersion: body.expectedVersion,
            decision: body.decision,
            reason: body.reason.trim(),
            confirmationToken: token,
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            diff: '@@ -1,3 +1,3 @@\n- draft\n+ approved\n',
            risks: [],
          }),
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'BAD_REQUEST', message: err.message }));
      }
    });
    return;
  }

  // Review Commit endpoint (T10-B2: verifies token binding & single-use per OpenAPI /saved-case-versions/{id}/review)
  if (
    req.url?.match(/\/api\/v1\/saved-case-versions\/([^/]+)\/review$/) &&
    req.method === 'POST'
  ) {
    req.on('end', () => {
      try {
        const body = JSON.parse(receivedBody);
        const record = boundTokens.get(body.confirmationToken);
        if (!record) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'INVALID_TOKEN',
              message: 'Token not found or expired',
            }),
          );
          return;
        }
        if (record.used) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'TOKEN_ALREADY_USED',
              message: 'Review token already consumed',
            }),
          );
          return;
        }
        if (
          record.expectedVersion !== body.expectedVersion ||
          record.decision !== body.decision ||
          record.reason !== body.reason
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'BINDING_MISMATCH',
              message:
                'Review confirmation parameters do not match preview binding',
            }),
          );
          return;
        }
        record.used = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: record.versionId,
            version: record.expectedVersion,
            reviewStatus:
              record.decision === 'approve' ? 'approved' : 'rejected',
            reviewComment: record.reason,
          }),
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'BAD_REQUEST', message: err.message }));
      }
    });
    return;
  }

  // Slow hanging endpoint to test client disconnect aborting upstream
  if (req.url === '/api/v1/slow-hang') {
    // Intentionally keep open without responding
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not found' }));
});

const closeBackend = trackSockets(mockBackend);
await new Promise((resolve) => mockBackend.listen(0, '127.0.0.1', resolve));
const backendPort = mockBackend.address().port;
const backendOrigin = `http://127.0.0.1:${backendPort}`;

// 2. Initialize the real shared proxy server from httpProxyHelper
const proxyInstance = createProxyServer({
  backendOrigin,
  port: 0,
});
await proxyInstance.listen(0, '127.0.0.1');
const proxyPort = proxyInstance.address().port;
const proxyOrigin = `http://127.0.0.1:${proxyPort}`;

console.log(`[Setup] Mock backend listening on ${backendOrigin}`);
console.log(`[Setup] Reverse proxy listening on ${proxyOrigin}`);

let allPassed = true;
const record = (title, pass, details = '') => {
  console.log(
    `  ${pass ? '✓' : '✗'} ${title}${details ? ` (${details})` : ''}`,
  );
  if (!pass) allPassed = false;
};

try {
  // Test 1: URL Normalization & Protocol Validation (HTTPS support & explicit rejection)
  console.log('\n--- Test 1: URL Normalization & Protocol Validation ---');
  const httpUrl = normalizeApiUrl('http://127.0.0.1:5188');
  record(
    'Valid HTTP URL parsed with origin and port 5188',
    httpUrl.origin === 'http://127.0.0.1:5188' &&
      httpUrl.port === 5188 &&
      !httpUrl.isHttps,
  );

  const httpsUrl = normalizeApiUrl('https://api.localqa.internal:8443');
  record(
    'Valid HTTPS URL parsed with port 8443 and isHttps=true',
    httpsUrl.isHttps &&
      httpsUrl.port === 8443 &&
      httpsUrl.protocol === 'https:',
  );

  let rejectedFtp = false;
  try {
    normalizeApiUrl('ftp://unsupported.host');
  } catch (err) {
    rejectedFtp = err.message.includes('Unsupported protocol');
  }
  record('Unsupported protocol (ftp:) explicitly rejected', rejectedFtp);

  // Test 2: Health Check canonical endpoint (/api/v1/health/live)
  console.log('\n--- Test 2: Canonical Health Check ---');
  const isHealthy = await checkRealBackendHealth(backendOrigin);
  record(
    'checkRealBackendHealth hits /api/v1/health/live and succeeds',
    isHealthy && receivedUrl === '/api/v1/health/live',
  );

  // Test 3: GET with Headers, Cookie, and Origin/Host Alignment
  console.log(
    '\n--- Test 3: GET Request Headers, Cookies & Host Alignment ---',
  );
  const getRes = await fetch(`${proxyOrigin}/api/v1/projects?page=1`, {
    method: 'GET',
    headers: {
      Origin: proxyOrigin,
      Cookie: 'session=sess_client_token_abc',
    },
  });
  const getData = await getRes.json();
  const setCookie = getRes.headers.get('set-cookie');

  record(
    'GET returns 200 with proxied JSON body',
    getRes.status === 200 && getData.total === 1,
  );
  record(
    'Cookie header proxied to upstream backend',
    receivedHeaders['cookie'] === 'session=sess_client_token_abc',
  );
  record(
    'Host header aligned with client request host to avoid CSRF mismatch',
    receivedHeaders['host'] === `127.0.0.1:${proxyPort}`,
  );
  record(
    'Set-Cookie response header passed back to client',
    !!setCookie && setCookie.includes('test-token-123'),
  );

  // Test 4: POST with JSON body and Idempotency-Key
  console.log('\n--- Test 4: POST Request Body & Idempotency-Key ---');
  const postPayload = {
    projectId: 'proj-1',
    targetUrl: 'http://test.local',
    mode: 'regression',
  };
  const postRes = await fetch(`${proxyOrigin}/api/v1/regression-runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idemp_key_uuid_789',
      Origin: proxyOrigin,
    },
    body: JSON.stringify(postPayload),
  });
  const postData = await postRes.json();

  record(
    'POST returns 202 Accepted',
    postRes.status === 202 && postData.id === 'run_test_001',
  );
  record(
    'Idempotency-Key header proxied upstream',
    receivedHeaders['idempotency-key'] === 'idemp_key_uuid_789',
  );
  record(
    'Upstream backend receives exact JSON payload and POST method',
    receivedBody === JSON.stringify(postPayload) && receivedMethod === 'POST',
  );

  // Test 5: 502 Bad Gateway error handling (JSON error, NEVER HTML)
  console.log('\n--- Test 5: Error Handling (502 JSON, Never HTML) ---');
  // Create proxy pointing to dead port
  const deadProxy = createProxyServer({
    backendOrigin: 'http://127.0.0.1:59999', // No server running here
  });
  await deadProxy.listen(0, '127.0.0.1');
  const deadProxyPort = deadProxy.address().port;

  const errRes = await fetch(
    `http://127.0.0.1:${deadProxyPort}/api/v1/projects`,
  );
  const errContentType = errRes.headers.get('content-type') || '';
  const errData = await errRes.json().catch(() => null);

  record('Unreachable backend yields 502 BAD_GATEWAY', errRes.status === 502);
  record(
    'Error response is application/json (NO HTML)',
    errContentType.includes('application/json') &&
      !errContentType.includes('text/html'),
  );
  record(
    'Error response contains JSON code BAD_GATEWAY',
    errData?.code === 'BAD_GATEWAY',
  );

  await deadProxy.closeAll();

  // Test 6: Client Disconnect Aborts Upstream Request
  console.log('\n--- Test 6: Client Disconnect Aborts Upstream ---');
  const abortCtrl = new AbortController();
  const slowPromise = fetch(`${proxyOrigin}/api/v1/slow-hang`, {
    signal: abortCtrl.signal,
  }).catch(() => null);

  // Abort client request after 50ms
  setTimeout(() => abortCtrl.abort(), 50);
  await slowPromise;
  // Small delay for socket events to propagate
  await new Promise((r) => setTimeout(r, 100));

  record(
    'Client disconnect triggers upstream abort on slow request',
    clientAbortedDetected,
  );

  // Test 7: SSE Streaming unbuffered (first chunk received BEFORE backend completes)
  console.log(
    '\n--- Test 7: Unbuffered Server-Sent Events (SSE) Streaming ---',
  );
  const sseRes = await fetch(`${proxyOrigin}/api/v1/runs/r1/events`);
  record(
    'SSE response headers indicate text/event-stream',
    sseRes.status === 200 &&
      sseRes.headers.get('content-type') === 'text/event-stream',
  );

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();

  const streamStartTime = Date.now();
  // Read first chunk
  const firstRead = await reader.read();
  const firstChunkTime = Date.now();
  const firstText = decoder.decode(firstRead.value);

  // Assert first chunk arrived promptly (< 200ms) before the backend 300ms timeout completed!
  const firstChunkReceivedEarly = firstChunkTime - streamStartTime < 250;
  record(
    'First SSE frame received immediately before backend ends stream',
    firstChunkReceivedEarly && firstText.includes('event: run.started'),
    `elapsed ${firstChunkTime - streamStartTime}ms`,
  );

  // Read second chunk (after backend completes)
  const secondRead = await reader.read();
  const secondText = decoder.decode(secondRead.value);
  record(
    'Second SSE frame received upon backend stream completion',
    secondText.includes('event: run.completed'),
  );

  await reader.cancel().catch(() => {});

  // Test 8: T10-B2 Review Preview & Confirm Binding over HTTP (Network verification)
  console.log(
    '\n--- Test 8: Review Preview & Confirm Token Binding over HTTP ---',
  );
  // 8.1 Preview request sending expectedVersion, decision, reason
  const previewPayload = {
    expectedVersion: 2,
    decision: 'approve',
    reason: 'Verified criteria and replay trace',
  };
  const previewRes = await fetch(
    `${proxyOrigin}/api/v1/saved-case-versions/ver-123/review-preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(previewPayload),
    },
  );
  const previewData = await previewRes.json();
  const token = previewData?.confirmationToken;

  record(
    'Review preview receives 200 with mirrored expectedVersion, decision, reason',
    previewRes.status === 200 &&
      previewData.expectedVersion === 2 &&
      previewData.decision === 'approve' &&
      previewData.reason === 'Verified criteria and replay trace' &&
      typeof token === 'string' &&
      token.length > 0,
  );

  // 8.2 Tampered confirm attempt (mismatched expectedVersion) is rejected
  const tamperedRes = await fetch(
    `${proxyOrigin}/api/v1/saved-case-versions/ver-123/review`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1, // Tampered version (was 2)
        decision: 'approve',
        reason: 'Verified criteria and replay trace',
        confirmationToken: token,
      }),
    },
  );
  const tamperedData = await tamperedRes.json();
  record(
    'Review confirm with tampered expectedVersion rejected with BINDING_MISMATCH (400)',
    tamperedRes.status === 400 && tamperedData.code === 'BINDING_MISMATCH',
  );

  // 8.3 Legitimate confirm succeeds
  const legitRes = await fetch(
    `${proxyOrigin}/api/v1/saved-case-versions/ver-123/review`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 2,
        decision: 'approve',
        reason: 'Verified criteria and replay trace',
        confirmationToken: token,
      }),
    },
  );
  const legitData = await legitRes.json();
  record(
    'Review confirm with matching token and parameters succeeds with 200',
    legitRes.status === 200 && legitData.reviewStatus === 'approved',
  );

  // 8.4 Single-use protection: replay with same token rejected
  const replayRes = await fetch(
    `${proxyOrigin}/api/v1/saved-case-versions/ver-123/review`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 2,
        decision: 'approve',
        reason: 'Verified criteria and replay trace',
        confirmationToken: token,
      }),
    },
  );
  const replayData = await replayRes.json();
  record(
    'Review confirm token replay rejected with TOKEN_ALREADY_USED (409)',
    replayRes.status === 409 && replayData.code === 'TOKEN_ALREADY_USED',
  );
} catch (testErr) {
  console.error('\n[FATAL] Test execution error:', testErr);
  allPassed = false;
} finally {
  // Always clean up servers and sockets
  console.log('\n[Teardown] Closing servers and terminating open sockets...');
  await proxyInstance.closeAll();
  await closeBackend();
  console.log('[Teardown] All test servers and sockets cleanly closed.');
}

console.log(`\nOverall Test Result: ${allPassed ? 'ALL PASS ✓' : 'FAILED ✗'}`);
if (!allPassed) process.exit(1);
