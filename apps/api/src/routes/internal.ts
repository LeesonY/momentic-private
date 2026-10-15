import { randomUUID, createHash } from 'node:crypto';
import {
  isErrorCode,
  parseContract,
  getApiValidator,
} from '@localqa/contracts';
import type { Artifact } from '@localqa/contracts';
import {
  StorageError,
  type LeaseProof,
  type WorkerScope,
} from '@localqa/storage';
import { BoundModel, createWorkerModelOptions } from '@localqa/orchestrator';
import { ApiError } from '../errors.js';
import { requireServiceIdentity } from '../auth.js';
import type { Router } from '../router.js';
import type { RequestContext } from '../types.js';

const validateActionResultPath = getApiValidator(
  'completeAction',
  { kind: 'parameters', location: 'path' },
  { internal: true },
);

export function registerInternalRoutes(router: Router): void {
  // Every internal route must pass the service-identity gate before it reads
  // any caller-supplied proof. Business fields (X-Worker-Id, project ids, lease
  // tokens) are never accepted as identity.

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

  const withLeaseErrors = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof StorageError &&
        (error.code === 'LEASE_EXPIRED' || error.code === 'SCOPE_CHANGED')
      ) {
        throw new ApiError(
          'LEASE_EXPIRED',
          'Lease or scope is no longer current',
          409,
        );
      }
      throw error;
    }
  };

  // POST /internal/v1/leases/claim
  router.post('/internal/v1/leases/claim', async (ctx: RequestContext) => {
    await requireServiceIdentity(ctx);
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
      await requireServiceIdentity(ctx);
      const taskId = ctx.params.taskId!;
      const input = parseContract('HeartbeatInput', ctx.body);

      const heartbeatResult = await withLeaseErrors(async () => {
        const { scope, proof } = await extractScopeAndProof(
          ctx,
          taskId,
          input.fencingToken,
          input.contextVersion,
        );
        return ctx.api.coordinator.leases.heartbeat(scope, proof, 45);
      });

      ctx.res.statusCode = 200;
      return parseContract('HeartbeatResult', heartbeatResult);
    },
  );

  // POST /internal/v1/tasks/{taskId}/complete
  router.post(
    '/internal/v1/tasks/{taskId}/complete',
    async (ctx: RequestContext) => {
      await requireServiceIdentity(ctx);
      const taskId = ctx.params.taskId!;
      const input = parseContract('TaskComplete', ctx.body);

      const completed = await withLeaseErrors(async () => {
        const { scope, proof } = await extractScopeAndProof(
          ctx,
          taskId,
          input.fencingToken,
        );
        return ctx.api.coordinator.leases.complete(scope, proof, input);
      });

      ctx.res.statusCode = 200;
      return parseContract('Task', completed);
    },
  );

  // POST /internal/v1/actions/reserve
  router.post('/internal/v1/actions/reserve', async (ctx: RequestContext) => {
    await requireServiceIdentity(ctx);
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
      await requireServiceIdentity(ctx);
      const pathId = ctx.params.actionId!;
      if (!validateActionResultPath({ actionId: pathId }))
        throw new ApiError('VALIDATION_ERROR', 'Invalid action ID', 422);
      const input = parseContract('ActionResult', ctx.body);
      const leaseToken = ctx.headers['x-lease-token'];
      const workerId = ctx.headers['x-worker-id'];
      if (
        typeof leaseToken !== 'string' ||
        !leaseToken ||
        typeof workerId !== 'string' ||
        !workerId ||
        workerId.length > 200
      )
        throw new ApiError(
          'FORBIDDEN',
          'Caller lease and worker headers are required',
          403,
        );
      const integerHeader = (name: string): number => {
        const raw = ctx.headers[name];
        if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw))
          throw new ApiError(
            'VALIDATION_ERROR',
            'Caller proof integer header is required',
            422,
          );
        const value = Number(raw);
        if (!Number.isSafeInteger(value))
          throw new ApiError(
            'VALIDATION_ERROR',
            'Invalid caller proof integer',
            422,
          );
        return value;
      };
      // Never infer or upgrade caller fencing/context/worker from current DB.
      const fencingToken = integerHeader('x-fencing-token');
      const contextVersion = integerHeader('x-context-version');
      const owner = await ctx.api.db.actor(
        ctx.api.adminActor,
        async (client) =>
          (
            await client.query<{
              action_id: string;
              task_id: string;
              project_id: string;
            }>(
              `SELECT a.id AS action_id,a.task_id,a.project_id
           FROM action_intents a LEFT JOIN steps s ON s.action_id=a.id
           WHERE a.id=$1 OR s.id=$1 ORDER BY (a.id=$1) DESC LIMIT 1`,
              [pathId.toLowerCase()],
            )
          ).rows[0],
      );
      if (!owner) throw new StorageError('NOT_FOUND');
      const scope: WorkerScope = { projectId: owner.project_id, workerId };
      const proof: LeaseProof = {
        taskId: owner.task_id,
        leaseToken,
        fencingToken,
        contextVersion,
      };
      const actionId = await withLeaseErrors(() =>
        ctx.api.coordinator.recordHttpAction(
          scope,
          proof,
          owner.action_id,
          input,
        ),
      );
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
    await requireServiceIdentity(ctx);
    const input = parseContract('ModelRequest', ctx.body);
    if (!ctx.api.modelTransport) {
      throw new ApiError(
        'MODEL_NOT_CONFIGURED',
        'Model transport is not configured',
        409,
      );
    }
    const { scope, proof } = await extractScopeAndProof(
      ctx,
      input.taskId,
      undefined,
      input.contextVersion,
    );
    const record = await withLeaseErrors(async () => {
      const artifacts = ctx.api.artifacts;
      const options = createWorkerModelOptions({
        transport: ctx.api.modelTransport,
        load: (id, version) =>
          ctx.api.modelRepo.readVersion(
            ctx.api.adminActor,
            id,
            version,
            scope.projectId,
          ),
        ...(typeof artifacts?.readApprovedImage === 'function'
          ? {
              readApprovedImage: (image) => artifacts.readApprovedImage(image),
            }
          : {}),
      });
      return new BoundModel(ctx.api.coordinator, scope, options).complete(
        proof,
        input,
      );
    });

    if (record.errorCode || !record.data) {
      const code =
        record.errorCode && isErrorCode(record.errorCode)
          ? record.errorCode
          : 'SERVICE_UNAVAILABLE';
      throw new ApiError(code, 'Model completion failed');
    }

    ctx.res.statusCode = 200;
    return parseContract('ModelResult', record.data);
  });

  // POST /internal/v1/auth/resolve
  router.post('/internal/v1/auth/resolve', async (ctx: RequestContext) => {
    await requireServiceIdentity(ctx);
    const input = parseContract('AuthResolve', ctx.body);
    // These values must come from the caller's proof. Reading the current DB
    // context/fencing value would renew a stale worker's authorization.
    const workerId = ctx.headers['x-worker-id'];
    const integerHeader = (name: string): number => {
      const value = ctx.headers[name];
      if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
        throw new ApiError('VALIDATION_ERROR', `${name} is required`, 422);
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed))
        throw new ApiError('VALIDATION_ERROR', `${name} is invalid`, 422);
      return parsed;
    };
    if (typeof workerId !== 'string' || !workerId || workerId.length > 200)
      throw new ApiError('FORBIDDEN', 'X-Worker-Id is required', 403);
    const { scope, proof } = await extractScopeAndProof(
      ctx,
      input.taskId,
      integerHeader('x-fencing-token'),
      integerHeader('x-context-version'),
    );
    if (scope.workerId !== workerId) throw new StorageError('LEASE_EXPIRED');
    const frozen = await ctx.api.coordinator.authProfile(scope, proof);
    if (
      !frozen ||
      frozen.id !== input.authProfileId ||
      frozen.version !== input.authProfileVersion
    )
      throw new StorageError('NOT_FOUND');

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
    await requireServiceIdentity(ctx);
    const leaseToken = ctx.headers['x-lease-token'];
    if (!leaseToken) {
      throw new ApiError('FORBIDDEN', 'X-Lease-Token header is required', 403);
    }

    // The internal transport contract permits multipart only; never accept base64 JSON.
    let taskId = '';

    const contentType = ctx.headers['content-type'] || '';
    if (!/^multipart\/form-data\s*;/i.test(contentType)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'multipart/form-data is required',
        422,
      );
    }
    const boundaryMatch = contentType.match(
      /(?:^|;)\s*boundary=(?:"([^"]+)"|([^\s;]+))/i,
    );
    if (!boundaryMatch)
      throw new ApiError(
        'VALIDATION_ERROR',
        'Multipart boundary is required',
        422,
      );
    const parts = parseMultipart(
      ctx.rawBody,
      boundaryMatch[1] || boundaryMatch[2]!,
    );
    taskId = parts['taskId']?.toString('utf8').trim() || '';
    const kind = (parts['kind']?.toString('utf8').trim() ||
      'screenshot') as Artifact['kind'];
    const redaction = (parts['redaction']?.toString('utf8').trim() ||
      'applied') as Artifact['redaction'];
    if (!parts['file'])
      throw new ApiError('VALIDATION_ERROR', 'Multipart file is required', 422);
    const fileBuffer = parts['file'];

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
          'SELECT run_id FROM jobs WHERE id = $1 AND project_id = $2',
          [taskId, scope.projectId],
        )
      ).rows[0];
      return row;
    });

    if (!job) throw new StorageError('NOT_FOUND');
    const runId = job.run_id;
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
