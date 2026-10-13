import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router } from './router.js';
import { toApiErrorResponse, ApiError } from './errors.js';
import type { ApiContext, RequestContext } from './types.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerModelRoutes } from './routes/models.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSseRoutes } from './routes/sse.js';
import { registerExecutionRoutes } from './routes/execution.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerSavedCaseRoutes } from './routes/savedCases.js';
import { registerRegressionModuleRoutes } from './routes/regressionModules.js';
import { registerCaseLifecycleRoutes } from './routes/caseLifecycle.js';
import { registerApiKeyRoutes } from './routes/apiKeys.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerRepairProposalRoutes } from './routes/repairProposals.js';
import { registerCandidateVerificationRoutes } from './routes/candidateVerifications.js';
import { registerLocatorMaintenanceRoutes } from './routes/locatorMaintenance.js';
import { validateOriginAndCsrf } from './auth.js';

export function createRouter(): Router {
  const router = new Router();
  registerAuthRoutes(router);
  registerProjectRoutes(router);
  registerConfigRoutes(router);
  registerModelRoutes(router);
  registerRunRoutes(router);
  registerSseRoutes(router);
  registerExecutionRoutes(router);
  registerHealthRoutes(router);
  registerInternalRoutes(router);
  registerSavedCaseRoutes(router);
  registerRegressionModuleRoutes(router);
  registerCaseLifecycleRoutes(router);
  registerApiKeyRoutes(router);
  registerScheduleRoutes(router);
  registerRepairProposalRoutes(router);
  registerCandidateVerificationRoutes(router);
  registerLocatorMaintenanceRoutes(router);
  return router;
}

export function createRequestHandler(api: ApiContext, router = createRouter()) {
  return async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);

    // Only the explicitly configured frontend may make credentialed cross-origin
    // requests. Reflecting an arbitrary Origin here lets hostile sites read
    // cookie-authenticated GET responses (POST's CSRF gate is not sufficient).
    const origin = req.headers['origin'];
    let allowedOrigin: string | null = null;
    if (api.publicOrigin) {
      try {
        allowedOrigin = new URL(api.publicOrigin).origin;
      } catch {
        // A malformed deployment origin must fail closed.
      }
    }
    const corsAllowed =
      typeof origin === 'string' &&
      origin === allowedOrigin &&
      allowedOrigin !== null;
    if (origin) res.setHeader('Vary', 'Origin');
    if (corsAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, Last-Event-ID, X-Lease-Token, X-Worker-Id, X-Project-Id',
      );
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = origin && !corsAllowed ? 403 : 204;
      res.end();
      return;
    }

    let pathname: string;
    try {
      const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
      pathname = parsedUrl.pathname;
      const query: Record<string, string> = {};
      parsedUrl.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      const match = router.match(req.method ?? 'GET', pathname);
      if (!match) {
        throw new ApiError(
          'NOT_FOUND',
          `Cannot ${req.method} ${pathname}`,
          404,
        );
      }

      // Read request body
      const chunks: Buffer[] = [];
      let totalLength = 0;
      const maxBodyLength = 50 * 1024 * 1024; // 50MB

      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalLength += buf.length;
        if (totalLength > maxBodyLength) {
          throw new ApiError(
            'ARTIFACT_TOO_LARGE',
            'Request body exceeded limit',
            413,
          );
        }
        chunks.push(buf);
      }

      const rawBody = Buffer.concat(chunks);
      let body: unknown = undefined;

      const contentType = req.headers['content-type'] ?? '';
      if (rawBody.length > 0) {
        if (contentType.includes('application/json')) {
          try {
            body = JSON.parse(rawBody.toString('utf8'));
          } catch {
            throw new ApiError(
              'VALIDATION_ERROR',
              'Malformed JSON in request body',
              422,
            );
          }
        }
      }

      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      }

      const ctx: RequestContext = {
        req,
        res,
        api,
        method: req.method ?? 'GET',
        pathname,
        query,
        headers,
        params: match.params,
        body,
        rawBody,
        actor: null,
        user: null,
        requestId,
      };

      validateOriginAndCsrf(ctx);

      const result = await match.handler(ctx);

      if (!res.writableEnded && result !== undefined) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(result));
      }
    } catch (error) {
      if (!res.writableEnded) {
        const { status, body } = toApiErrorResponse(error, requestId);
        res.statusCode = status;
        if (status === 429) res.setHeader('Retry-After', '1');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
      }
    }
  };
}
