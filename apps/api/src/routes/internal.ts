import { randomUUID, createHash } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
import type { Artifact } from '@localqa/contracts';
import {
  StorageError,
  type LeaseProof,
  type WorkerScope,
} from '@localqa/storage';
import { ApiError } from '../errors.js';
import { rejectUserCookieForInternal } from '../auth.js';
import type { Router } from '../router.js';
import type { RequestContext } from '../types.js';

export function registerInternalRoutes(router: Router): void {
  // Common check for all internal routes
  const checkInternal = (ctx: RequestContext) => {
    rejectUserCookieForInternal(ctx);
  };

  // Helper to extract WorkerScope and LeaseProof from headers and body
  const extractScopeAndProof = async (
    ctx: RequestContext,
    taskId: string,
    fencingToken?: number,
    contextVersion?: number,
  ): Promise<{ scope: WorkerScope; proof: LeaseProof }> => {
    const leaseToken = ctx.headers['x-lease-token'];
    if (!leaseToken) {
      throw new ApiError('FORBIDDEN', 'X-Lease-Token header is required', 403);
    }

    const job = await ctx.api.db.actor(ctx.api.adminActor, async (client) => {
      const row = (
        await client.query<{
          id: string;
          project_id: string;
          worker_id: string;
          fencing_token: string;
          context_version: number;
        }>(
          `SELECT j.id, j.project_id, j.worker_id, j.fencing_token, r.context_version
           FROM jobs j
           JOIN runs r ON r.id = j.run_id
           WHERE j.id = $1`,
          [taskId],
        )
      ).rows[0];
      return row;
    });

    if (!job) {
      throw new StorageError('NOT_FOUND');
    }

    const scope: WorkerScope = {
      workerId:
        job.worker_id ||
        (ctx.headers['x-worker-id'] as string) ||
        'worker-unknown',
      projectId: job.project_id,
    };

    const proof: LeaseProof = {
      taskId,
      leaseToken,
      fencingToken: fencingToken ?? Number(job.fencing_token),
      contextVersion: contextVersion ?? job.context_version,
    };

    return { scope, proof };
  };

  // POST /internal/v1/leases/claim
  router.post('/internal/v1/leases/claim', async (ctx: RequestContext) => {
    checkInternal(ctx);
    const claimInput = parseContract('WorkerClaim', ctx.body);

    // Project ID can be explicitly provided or queried from queued jobs
    let projectId =
      (ctx.headers['x-project-id'] as string) || ctx.query['projectId'];

    if (!projectId) {
      projectId = await ctx.api.db.actor(ctx.api.adminActor, async (client) => {
        const row = (
          await client.query<{ project_id: string }>(
            `SELECT DISTINCT j.project_id
             FROM jobs j
             JOIN runs r ON r.id = j.run_id
             WHERE j.status = 'queued' AND j.available_at <= clock_timestamp() AND r.status IN ('queued', 'running')
             ORDER BY j.project_id
             LIMIT 1`,
          )
        ).rows[0];
        return row?.project_id;
      });
    }

    if (!projectId) {
      ctx.res.statusCode = 204;
      return null;
    }

    const scope: WorkerScope = {
      workerId: claimInput.workerId,
      projectId,
    };

    const lease = await ctx.api.coordinator.claim(scope, 45);
    if (!lease) {
      ctx.res.statusCode = 204;
      return null;
    }

    ctx.res.statusCode = 200;
    return parseContract('Lease', lease);
  });

  // POST /internal/v1/tasks/{taskId}/heartbeat
  router.post(
    '/internal/v1/tasks/{taskId}/heartbeat',
    async (ctx: RequestContext) => {
      checkInternal(ctx);
      const taskId = ctx.params.taskId!;
      const input = parseContract('HeartbeatInput', ctx.body);

      const { scope, proof } = await extractScopeAndProof(
        ctx,
        taskId,
        input.fencingToken,
        input.contextVersion,
      );

      const heartbeatResult = await ctx.api.coordinator.leases.heartbeat(
        scope,
        proof,
        45,
      );

      ctx.res.statusCode = 200;
      return parseContract('HeartbeatResult', heartbeatResult);
    },
  );

  // POST /internal/v1/tasks/{taskId}/complete
  router.post(
    '/internal/v1/tasks/{taskId}/complete',
    async (ctx: RequestContext) => {
      checkInternal(ctx);
      const taskId = ctx.params.taskId!;
      const input = parseContract('TaskComplete', ctx.body);

      const { scope, proof } = await extractScopeAndProof(
        ctx,
        taskId,
        input.fencingToken,
      );

      const completed = await ctx.api.coordinator.leases.complete(
        scope,
        proof,
        input,
      );

      ctx.res.statusCode = 200;
      return parseContract('Task', completed);
    },
  );

  // POST /internal/v1/actions/reserve
  router.post('/internal/v1/actions/reserve', async (ctx: RequestContext) => {
    checkInternal(ctx);
    const input = parseContract('ActionReservation', ctx.body);

    const { scope, proof } = await extractScopeAndProof(
      ctx,
      input.taskId,
      input.fencingToken,
      input.contextVersion,
    );

    try {
      const grant = await ctx.api.coordinator.grantAction(
        scope,
        proof,
        input.toolCall,
      );
      ctx.res.statusCode = 200;
      return parseContract('ActionPermit', {
        actionId: grant.id,
        permitted: true,
        reasonCode: null,
      });
    } catch (error) {
      const reasonCode =
        error instanceof StorageError
          ? error.code
          : error instanceof Error
            ? error.message
            : 'POLICY_DENIED';

      ctx.res.statusCode = 200;
      return parseContract('ActionPermit', {
        actionId: randomUUID(),
        permitted: false,
        reasonCode: reasonCode.slice(0, 80),
      });
    }
  });

  // POST /internal/v1/actions/{actionId}/result
  router.post(
    '/internal/v1/actions/{actionId}/result',
    async (ctx: RequestContext) => {
      checkInternal(ctx);
      const actionId = ctx.params.actionId!;
      const input = parseContract('ActionResult', ctx.body);

      // Look up action intent and step
      const stepInfo = await ctx.api.db.actor(
        ctx.api.adminActor,
        async (client) => {
          const row = (
            await client.query<{
              step_id: string | null;
              task_id: string;
              project_id: string;
              run_id: string;
              document: unknown;
            }>(
              `SELECT s.id AS step_id, a.task_id, a.project_id, a.run_id, s.document
               FROM action_intents a
               LEFT JOIN steps s ON s.action_id = a.id
               WHERE a.id = $1 OR s.id = $1
               LIMIT 1`,
              [actionId],
            )
          ).rows[0];
          return row;
        },
      );

      if (!stepInfo) {
        throw new StorageError('NOT_FOUND');
      }

      await extractScopeAndProof(ctx, stepInfo.task_id);

      // Record outcome
      await ctx.api.db.actor(ctx.api.adminActor, async (client) => {
        await client.query(
          'UPDATE action_intents SET outcome = $2 WHERE id = $1',
          [actionId, input.outcome],
        );

        if (stepInfo.step_id && stepInfo.document) {
          const step = {
            ...(stepInfo.document as Record<string, unknown>),
            status:
              input.outcome === 'succeeded'
                ? 'succeeded'
                : input.outcome === 'cancelled'
                  ? 'cancelled'
                  : 'failed',
            summary: input.summary,
            finishedAt: new Date().toISOString(),
          };

          await client.query('UPDATE steps SET document = $2 WHERE id = $1', [
            stepInfo.step_id,
            step,
          ]);
        }
      });

      ctx.res.statusCode = 200;
      return parseContract('ActionPermit', {
        actionId,
        permitted: true,
        reasonCode: null,
      });
    },
  );

  // POST /internal/v1/model/complete
  router.post('/internal/v1/model/complete', async (ctx: RequestContext) => {
    checkInternal(ctx);
    const input = parseContract('ModelRequest', ctx.body);

    await extractScopeAndProof(
      ctx,
      input.taskId,
      undefined,
      input.contextVersion,
    );

    // Call model gateway
    const record = await ctx.api.gateway.complete(input, {
      role: 'coordinator',
      promptVersion: '1.0',
      approvedImageIds: [],
      toolSchemas: [],
      timeoutMs: 30000,
    });

    if (record.errorCode || !record.data) {
      throw new ApiError('SERVICE_UNAVAILABLE', 'Model completion failed', 500);
    }

    ctx.res.statusCode = 200;
    return parseContract('ModelResult', record.data);
  });

  // POST /internal/v1/auth/resolve
  router.post('/internal/v1/auth/resolve', async (ctx: RequestContext) => {
    checkInternal(ctx);
    const input = parseContract('AuthResolve', ctx.body);

    const { scope, proof } = await extractScopeAndProof(ctx, input.taskId);

    const credentialMaterial = await ctx.api.coordinator.leases.resolveAuth(
      scope,
      proof,
      input.authProfileId,
      input.authProfileVersion,
      ctx.api.vault,
    );

    ctx.res.statusCode = 200;
    return parseContract('CredentialMaterial', credentialMaterial);
  });

  // POST /internal/v1/artifacts
  router.post('/internal/v1/artifacts', async (ctx: RequestContext) => {
    checkInternal(ctx);
    const leaseToken = ctx.headers['x-lease-token'];
    if (!leaseToken) {
      throw new ApiError('FORBIDDEN', 'X-Lease-Token header is required', 403);
    }

    // Support both multipart/form-data and JSON with base64 file
    let taskId = '';
    let kind: Artifact['kind'] = 'screenshot';
    let redaction: Artifact['redaction'] = 'applied';
    let fileBuffer: Buffer = Buffer.alloc(0);

    const contentType = ctx.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
      if (boundaryMatch) {
        const boundary = boundaryMatch[1]!;
        const parts = parseMultipart(ctx.rawBody, boundary);
        taskId = parts['taskId']?.toString('utf8').trim() || '';
        kind = (parts['kind']?.toString('utf8').trim() ||
          'screenshot') as Artifact['kind'];
        redaction = (parts['redaction']?.toString('utf8').trim() ||
          'applied') as Artifact['redaction'];
        fileBuffer = parts['file'] || Buffer.alloc(0);
      }
    } else if (typeof ctx.body === 'object' && ctx.body !== null) {
      const b = ctx.body as Record<string, unknown>;
      taskId = String(b['taskId'] || '');
      kind = (b['kind'] || 'screenshot') as Artifact['kind'];
      redaction = (b['redaction'] || 'applied') as Artifact['redaction'];
      if (typeof b['file'] === 'string') {
        fileBuffer = Buffer.from(b['file'], 'base64');
      }
    }

    if (!taskId) {
      throw new ApiError('VALIDATION_ERROR', 'taskId is required', 422);
    }

    const { scope, proof } = await extractScopeAndProof(ctx, taskId);

    const artifactId = randomUUID();
    const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
    const bytes = fileBuffer.length;

    const job = await ctx.api.db.actor(ctx.api.adminActor, async (client) => {
      const row = (
        await client.query<{ run_id: string }>(
          'SELECT run_id FROM jobs WHERE id = $1',
          [taskId],
        )
      ).rows[0];
      return row;
    });

    const runId = job?.run_id || randomUUID();
    const now = new Date().toISOString();

    const artifactDoc: Artifact = parseContract('Artifact', {
      id: artifactId,
      projectId: scope.projectId,
      runId,
      kind,
      status: 'available',
      bytes,
      sha256,
      contentUrl: `/api/v1/artifacts/${artifactId}/content`,
      redaction,
      error: null,
      createdAt: now,
      taskId,
      stepId: null,
      caseId: null,
      snapshotId: null,
    });

    // Save bytes and metadata to artifact store and coordinator
    const saved = await ctx.api.artifacts.upload(
      ctx.api.coordinator,
      scope,
      proof,
      artifactDoc,
      fileBuffer,
    );

    ctx.res.statusCode = 201;
    return parseContract('Artifact', saved);
  });
}

function parseMultipart(
  buffer: Buffer,
  boundary: string,
): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};
  const delimiter = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(delimiter);

  while (start !== -1) {
    const nextStart = buffer.indexOf(delimiter, start + delimiter.length);
    if (nextStart === -1) break;

    const part = buffer.subarray(start + delimiter.length, nextStart);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const body = part.subarray(headerEnd + 4, part.length - 2); // trim trailing \r\n

      const nameMatch = headers.match(/name="([^"]+)"/);
      if (nameMatch) {
        result[nameMatch[1]!] = body;
      }
    }

    start = nextStart;
  }

  return result;
}
