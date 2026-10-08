import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

/**
 * Normalizes and validates API URL string.
 * Enforces http: or https: protocols and rejects invalid or unsupported URLs.
 */
export function normalizeApiUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('API URL must be a non-empty string');
  }
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  const isHttps = parsed.protocol === 'https:';
  const port = parsed.port ? parseInt(parsed.port, 10) : isHttps ? 443 : 80;

  return {
    rawUrl,
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port,
    isHttps,
    host: parsed.host,
  };
}

/**
 * Performs a health check against the real API backend.
 * Uses OpenAPI canonical health route: /api/v1/health/live
 */
export async function checkRealBackendHealth(backendOrigin, timeoutMs = 1500) {
  try {
    const res = await fetch(`${backendOrigin}/api/v1/health/live`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch (_err) {
    return false;
  }
}

/**
 * Creates an HTTP server with same-origin /api reverse proxy and static SPA serving.
 *
 * Capabilities:
 * - Transparent proxying of /api/* with Cookie, Idempotency-Key, CSRF headers preserved
 * - Host header alignment with client request host to eliminate Origin mismatch
 * - Support for http: and https: backends
 * - Native chunked unbuffered streaming for Server-Sent Events (SSE)
 * - Upstream request abort on client disconnect
 * - 502/503 JSON error responses (never leaks HTML error pages)
 * - Tracked sockets for clean shutdown
 */
export function createProxyServer({ backendOrigin, distDir = null, port = 0 }) {
  const backendInfo = normalizeApiUrl(backendOrigin);
  const clientModule = backendInfo.isHttps ? https : http;
  const activeSockets = new Set();

  const server = http.createServer((req, res) => {
    // 1. Reverse Proxy for /api/* routes
    if (req.url && req.url.startsWith('/api')) {
      const proxyHeaders = { ...req.headers };

      // Aligns Host with client request host (e.g. 127.0.0.1:5199) so backend CSRF/Origin check succeeds
      if (req.headers.host) {
        proxyHeaders['host'] = req.headers.host;
      }
      proxyHeaders['x-forwarded-host'] =
        req.headers.host || `127.0.0.1:${port}`;
      proxyHeaders['x-forwarded-proto'] = backendInfo.protocol.replace(':', '');

      const proxyReq = clientModule.request(
        {
          hostname: backendInfo.hostname,
          port: backendInfo.port,
          path: req.url,
          method: req.method,
          headers: proxyHeaders,
        },
        (proxyRes) => {
          // Forward status and headers (including set-cookie, content-type)
          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
          // Stream directly to client without buffering (SSE text/event-stream)
          proxyRes.pipe(res);
        },
      );

      // Handle upstream error: respond with JSON 502, never HTML
      proxyReq.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 'BAD_GATEWAY',
              message: `Reverse proxy failed to connect to backend at ${backendInfo.host}: ${err.message}`,
            }),
          );
        }
      });

      // Handle client disconnect: abort upstream request
      res.on('close', () => {
        if (!res.writableFinished && !proxyReq.destroyed) {
          proxyReq.destroy();
        }
      });
      req.on('aborted', () => {
        if (!proxyReq.destroyed) {
          proxyReq.destroy();
        }
      });

      // Pipe client request body into upstream proxy request
      req.pipe(proxyReq);
      return;
    }

    // 2. Serve static SPA assets if distDir is provided
    if (distDir && fs.existsSync(distDir)) {
      const urlPath = req.url ? req.url.split('?')[0] : '/';
      let filePath = path.join(
        distDir,
        urlPath === '/' ? 'index.html' : urlPath,
      );

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(distDir, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      } catch (_err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
      return;
    }

    // Default response when no distDir
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('LocalQA Web Preview Server');
  });

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => {
      activeSockets.delete(socket);
    });
  });

  const closeAll = async () => {
    for (const socket of activeSockets) {
      socket.destroy();
    }
    activeSockets.clear();
    await new Promise((resolve) => server.close(resolve));
  };

  return {
    server,
    backendInfo,
    closeAll,
    listen: (bindPort = port, host = '127.0.0.1') =>
      new Promise((resolve) => server.listen(bindPort, host, resolve)),
    address: () => server.address(),
  };
}
