import { randomUUID } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
import type { Run, RunConfig, InputRequest } from '@localqa/contracts';
import { StorageError, appendEvent, runDTO } from '@localqa/storage';
import { DEFAULT_LIMITS, TERMINAL } from '@localqa/domain';
import { sanitizeUserText } from '../redact.js';
import { resolveRunAuth } from '../runAuth.js';
import { selectRunModelBinding } from '../runModelSelection.js';
import { ApiError } from '../errors.js';
import { requireAuth } from '../auth.js';
import { parsePagination, paginate, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

/** Trusted dispatch reuses exactly the ordinary API admission path. Caller must authenticate independently. */
export async function startTrustedSmokeRun(
  ctx: RequestContext,
): Promise<unknown> {
  const idempotencyKey = ctx.headers['idempotency-key'];
  if (
    !idempotencyKey ||
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 128
  ) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Idempotency-Key header is required (1-128 chars)',
      422,
    );
  }

  const input = parseContract('RunCreate', ctx.body);
  const projectId = input.projectId;

  // Reject viewer from starting runs and ensure project exists
  await ctx.api.db.actor(ctx.actor!, async (client) => {
    const exists = (
      await client.query('SELECT 1 FROM projects WHERE id = $1', [projectId])
    ).rowCount;
    if (!exists) throw new StorageError('NOT_FOUND');
    const roleRow = (
      await client.query<{ role: string }>(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [projectId, ctx.actor!.userId],
      )
    ).rows[0];
    if (roleRow?.role === 'viewer') {
      throw new StorageError('FORBIDDEN');
    }
  });

  // Resolve environment if provided
  let allowedOrigins = [new URL(input.targetUrl).origin];
  let environmentVersion: number | null = null;
  let defaultAuthProfileId: string | null = null;

  if (input.environmentId) {
    const env = await ctx.api.configRepo.get(
      ctx.actor!,
      'Environment',
      projectId,
      input.environmentId,
    );
    allowedOrigins = env.allowedOrigins;
    environmentVersion = env.version;
    defaultAuthProfileId = env.defaultAuthProfileId ?? null;
  }

  // Resolve auth profile if provided
  const authProfileId = input.authProfileId ?? defaultAuthProfileId;
  const authProfile = await ctx.api.db.actor(ctx.actor!, (client) =>
    resolveRunAuth(
      client,
      projectId,
      authProfileId,
      input.environmentId,
      allowedOrigins,
      false,
    ),
  );
  const authProfileVersion = authProfile?.version ?? null;

  // Resolve model profiles for all 5 roles
  const modelBindings = await ctx.api.db.actor(ctx.actor!, async (client) => {
    const binding = await selectRunModelBinding(
      client,
      projectId,
      input.modelProfileId,
    );
    return {
      coordinator: binding,
      explorer: binding,
      executor: binding,
      assertion: binding,
      reproducer: binding,
    };
  });

  // Resolve knowledge version IDs
  const knowledgeVersionIds = await ctx.api.db.actor(
    ctx.actor!,
    async (client) => {
      const rows = await client.query<{ id: string }>(
        `SELECT v.id
         FROM knowledge k
         JOIN knowledge_versions v
           ON v.project_id = k.project_id AND v.knowledge_id = k.id AND v.version = k.version
         WHERE k.project_id = $1 AND (v.document->>'approved')::boolean = true`,
        [projectId],
      );
      return rows.rows.map((r) => r.id);
    },
  );

  const budget = {
    ...DEFAULT_LIMITS,
    ...(input.budget ?? {}),
  };

  const runConfig: RunConfig = parseContract('RunConfig', {
    allowedOrigins,
    actionPolicy: 'non_submitting',
    environmentVersion,
    authProfileVersion,
    models: modelBindings,
    knowledgeVersionIds,
    budget,
  });

  const run = await ctx.api.coordinator.start(
    ctx.actor!,
    { ...input, ...(authProfile ? { authProfileId: authProfile.id } : {}) },
    runConfig,
    idempotencyKey,
  );

  ctx.res.statusCode = 202;
  return parseContract('Run', run);
}

export function registerRunRoutes(router: Router): void {
  // POST /api/v1/runs
  router.post('/api/v1/runs', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    return startTrustedSmokeRun(ctx);
  });

  // GET /api/v1/runs
  router.get('/api/v1/runs', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const projectId = ctx.query['projectId'];
    if (!projectId) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'projectId query parameter is required',
        422,
      );
    }

    const statusFilter = ctx.query['status'];
    const envFilter = ctx.query['environmentId'];

    const runs = await ctx.api.db.actor(ctx.actor!, async (client) => {
      await ctx.api.projectRepo.get(ctx.actor!, projectId);

      let query = 'SELECT id FROM runs WHERE project_id = $1';
      const args: unknown[] = [projectId];
      let argIdx = 2;

      if (statusFilter) {
        query += ` AND status = $${argIdx++}`;
        args.push(statusFilter);
      }
      if (envFilter) {
        query += ` AND environment_id = $${argIdx}`;
        args.push(envFilter);
      }

      query += ' ORDER BY created_at DESC, id DESC';
      const rows = await client.query<{ id: string }>(query, args);

      const items: Run[] = [];
      for (const { id } of rows.rows) {
        items.push(await runDTO(client, projectId, id));
      }
      return items;
    });

    const { limit, offset } = parsePagination(ctx.query);
    const page = paginate(runs, limit, offset);

    ctx.res.statusCode = 200;
    return parseContract('RunPage', page);
  });

  // GET /api/v1/runs/{runId}
  router.get('/api/v1/runs/{runId}', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const runId = ctx.params.runId!;

    const run = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM runs WHERE id = $1',
          [runId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      return runDTO(client, row.project_id, runId);
    });

    ctx.res.statusCode = 200;
    return parseContract('Run', run);
  });

  // POST /api/v1/runs/{runId}/cancel
  router.post('/api/v1/runs/{runId}/cancel', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const runId = ctx.params.runId!;

    const run = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM runs WHERE id = $1',
          [runId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      return ctx.api.coordinator.cancel(ctx.actor!, row.project_id, runId);
    });

    ctx.res.statusCode = 202;
    return parseContract('Run', run);
  });

  // GET /api/v1/runs/{runId}/messages
  router.get('/api/v1/runs/{runId}/messages', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const runId = ctx.params.runId!;
    try {
      const projectId = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const runRow = (
          await client.query<{ project_id: string }>(
            'SELECT project_id FROM runs WHERE id = $1',
            [runId],
          )
        ).rows[0];
        if (!runRow) throw new StorageError('NOT_FOUND');
        return runRow.project_id;
      });
      const rows = await ctx.api.db.actor(ctx.actor!, async (client) =>
        client.query<{
          id: string;
          run_id: string;
          actor_id: string;
          context_version: number;
          redacted_text: string;
          created_at: Date;
        }>(
          'SELECT id, run_id, actor_id, context_version, redacted_text, created_at FROM run_messages WHERE run_id = $1 AND project_id = $2 ORDER BY created_at ASC, id ASC',
          [runId, projectId],
        ),
      );
      const messages = rows.rows.map((r) =>
        parseContract('RunMessage', {
          id: r.id,
          runId: r.run_id,
          actorId: r.actor_id,
          contextVersion: r.context_version,
          redactedText: r.redacted_text,
          createdAt: r.created_at.toISOString(),
        }),
      );
      const { limit, offset } = parsePagination(ctx.query);
      const page = paginate(messages, limit, offset);
      ctx.res.statusCode = 200;
      return parseContract('RunMessagePage', page);
    } catch (e) {
      const err = e as { code?: string; message?: string; stack?: string };
      console.error(
        'GET_MESSAGES_ERROR',
        runId,
        err?.code,
        err?.message,
        err?.stack?.slice(0, 300),
      );
      throw e;
    }
  });

  // POST /api/v1/runs/{runId}/messages
  router.post('/api/v1/runs/{runId}/messages', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const runId = ctx.params.runId!;
    const input = parseContract('MessageInput', ctx.body);

    const updatedRun = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM runs WHERE id = $1 FOR UPDATE',
          [runId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      const projectId = row.project_id;

      const current = await runDTO(client, projectId, runId);
      if (TERMINAL.has(current.status) || current.status === 'cancelling') {
        throw new StorageError('VALIDATION_ERROR');
      }
      if (current.contextVersion !== input.expectedContextVersion) {
        throw new StorageError('VERSION_CONFLICT');
      }

      const nextContextVersion = current.contextVersion + 1;
      const nextVersion = current.version + 1;

      // Update runs context_version and version (trigger save_run_context auto-records run_context_versions)
      await client.query(
        'UPDATE runs SET context_version = $3, version = $4, updated_at = clock_timestamp() WHERE project_id = $1 AND id = $2 AND version = $5',
        [projectId, runId, nextContextVersion, nextVersion, current.version],
      );

      // Record message
      const messageId = randomUUID();
      // Record message after redaction: user-supplied text can contain
      // passwords/tokens and flows into model context; never persist raw.
      const redactedText = sanitizeUserText(input.text);
      await client.query(
        'INSERT INTO run_messages(id, project_id, run_id, actor_id, context_version, redacted_text) VALUES($1, $2, $3, $4, $5, $6)',
        [
          messageId,
          projectId,
          runId,
          ctx.actor!.userId,
          nextContextVersion,
          redactedText,
        ],
      );

      const refreshed = await runDTO(client, projectId, runId);
      await appendEvent(client, projectId, runId, 'run.updated', refreshed);

      return refreshed;
    });

    ctx.res.statusCode = 202;
    return parseContract('Run', updatedRun);
  });

  // POST /api/v1/runs/{runId}/inputs/{inputId}/respond
  router.post(
    '/api/v1/runs/{runId}/inputs/{inputId}/respond',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const { runId, inputId } = ctx.params;
      const response = parseContract('InputResponse', ctx.body);

      const updatedInput = await ctx.api.db.actor(
        ctx.actor!,
        async (client) => {
          const row = (
            await client.query<{ project_id: string }>(
              'SELECT project_id FROM runs WHERE id = $1 FOR UPDATE',
              [runId!],
            )
          ).rows[0];
          if (!row) throw new StorageError('NOT_FOUND');
          const projectId = row.project_id;

          const inputRow = (
            await client.query<{ document: unknown }>(
              'SELECT document FROM input_requests WHERE project_id = $1 AND run_id = $2 AND id = $3 FOR UPDATE',
              [projectId, runId!, inputId!],
            )
          ).rows[0];
          if (!inputRow) throw new StorageError('NOT_FOUND');

          const currentInput = parseContract('InputRequest', inputRow.document);
          if (
            currentInput.version !== response.expectedVersion ||
            currentInput.status !== 'pending' ||
            Date.parse(currentInput.expiresAt) <= Date.now()
          ) {
            throw new StorageError('VERSION_CONFLICT');
          }

          const authenticationInput =
            currentInput.kind === 'auth_profile' ||
            currentInput.kind === 'one_time_code';
          if (currentInput.kind === 'one_time_code') {
            if (
              response.authProfileId !== undefined ||
              response.text !== undefined ||
              response.allowedOrigins !== undefined ||
              (response.decision !== 'provide' &&
                response.decision !== 'reject') ||
              (response.decision === 'provide' &&
                response.oneTimeCode === undefined) ||
              (response.decision === 'reject' &&
                response.oneTimeCode !== undefined)
            )
              throw new StorageError('VALIDATION_ERROR');
            // Delegate to the private Coordinator transaction after releasing
            // this route's run lock; ciphertext never enters InputRequest,
            // events, logs, snapshots or ordinary input replies.
            return {
              otpProjectId: projectId,
              otpRunId: runId!,
              otpDecision: response.decision,
              otpCode: response.oneTimeCode,
            };
          }
          if (
            response.authProfileId !== undefined ||
            response.oneTimeCode !== undefined ||
            (authenticationInput &&
              (response.decision !== 'reject' ||
                response.text !== undefined ||
                response.allowedOrigins !== undefined))
          ) {
            throw new StorageError('VALIDATION_ERROR');
          }

          if (
            currentInput.kind === 'clarification' &&
            response.decision === 'provide'
          ) {
            // The coordinator owns its transaction and rechecks the input.
            // Do not hold this transaction's run/input locks while calling it.
            return { clarificationProjectId: projectId };
          }

          const nextStatus =
            response.decision === 'reject' ? 'rejected' : 'resolved';
          const updated: InputRequest = parseContract('InputRequest', {
            ...currentInput,
            status: nextStatus,
            version: currentInput.version + 1,
          });

          await client.query(
            'UPDATE input_requests SET document = $2, version = version + 1 WHERE id = $1',
            [inputId!, updated],
          );

          await appendEvent(
            client,
            projectId,
            runId!,
            'input.resolved',
            updated,
          );
          return updated;
        },
      );

      const result =
        'otpProjectId' in updatedInput
          ? await ctx.api.coordinator.authOtp.submit(
              ctx.actor!,
              updatedInput.otpProjectId,
              updatedInput.otpRunId!,
              inputId!,
              response.expectedVersion,
              updatedInput.otpDecision as 'provide' | 'reject',
              updatedInput.otpCode,
            )
          : 'clarificationProjectId' in updatedInput
            ? await ctx.api.coordinator.resolveClarification(
                ctx.actor!,
                updatedInput.clarificationProjectId,
                inputId!,
                response.expectedVersion,
              )
            : updatedInput;
      ctx.res.statusCode = 200;
      return parseContract('InputRequest', result);
    },
  );
}
