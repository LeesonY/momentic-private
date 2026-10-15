import { randomUUID } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
import type { Run, RunConfig, InputRequest } from '@localqa/contracts';
import {
  StorageError,
  appendEvent,
  runDTO,
  authorize,
  audit,
} from '@localqa/storage';
import {
  DEFAULT_LIMITS,
  TERMINAL,
  assertPublicOrApprovedTarget,
} from '@localqa/domain';
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
  previousRunId?: string,
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
  const actionPolicy = input.actionPolicy ?? 'non_submitting';
  if (
    ['spec', 'changes', 'reproduce'].includes(input.taskIntent ?? '') &&
    !input.brief?.trim()
  )
    throw new StorageError('VALIDATION_ERROR', '请提供需求、变更或问题描述');
  if (actionPolicy === 'approved_workflows') {
    if (!input.environmentId || input.taskIntent === 'plan')
      throw new StorageError('VALIDATION_ERROR', '业务操作需要选择测试环境');
    await ctx.api.db.actor(ctx.actor!, (client) =>
      authorize(client, projectId, 'config.write'),
    );
  } else if (input.writeScope) throw new StorageError('VALIDATION_ERROR');

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

  // A URL a user submitted on its own must resolve to a public address. Only a
  // frozen Environment whose allowedOrigins already contains the target may
  // point the run at a restricted (loopback/private/link-local/metadata) host.
  try {
    await assertPublicOrApprovedTarget(input.targetUrl, allowedOrigins, [], {
      allowRestricted: input.environmentId !== undefined,
    });
  } catch {
    throw new StorageError('TARGET_NOT_ALLOWED');
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
    actionPolicy,
    taskIntent: input.taskIntent ?? 'flow',
    ...(previousRunId ? { previousRunId } : {}),
    ...(actionPolicy === 'approved_workflows'
      ? {
          writeScope: (
            input.writeScope ??
            allowedOrigins.map((origin) => new URL(origin).origin + '/')
          ).map((url) => {
            const parsed = new URL(url);
            if (
              !allowedOrigins.some(
                (origin) => new URL(origin).origin === parsed.origin,
              ) ||
              parsed.username ||
              parsed.password ||
              parsed.search ||
              parsed.hash
            )
              throw new StorageError('TARGET_NOT_ALLOWED');
            return parsed.href;
          }),
        }
      : {}),
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
  router.post('/api/v1/runs/{runId}/follow-up', async (ctx) => {
    await requireAuth(ctx);
    const input = parseContract('FollowUpInput', ctx.body);
    const parent = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{
          project_id: string;
          environment_id: string | null;
          auth_profile_id: string | null;
        }>(
          'SELECT project_id,environment_id,auth_profile_id FROM runs WHERE id=$1',
          [ctx.params.runId!],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      const run = await runDTO(client, row.project_id, ctx.params.runId!);
      if (!TERMINAL.has(run.status) || run.version !== input.expectedVersion)
        throw new StorageError('VERSION_CONFLICT');
      const session = (
        await client.query<{ document: { summary?: string } }>(
          'SELECT document FROM run_sessions WHERE run_id=$1',
          [run.id],
        )
      ).rows[0];
      return { run, row, summary: session?.document.summary ?? '' };
    });
    ctx.body = {
      projectId: parent.run.projectId,
      targetUrl: parent.run.targetUrl,
      brief: sanitizeUserText(
        `上轮总结：${parent.summary.slice(0, 1500)}\n用户继续要求：${input.text}`,
      ).slice(0, 4000),
      ...(parent.row.environment_id
        ? { environmentId: parent.row.environment_id }
        : {}),
      ...(parent.row.auth_profile_id
        ? { authProfileId: parent.row.auth_profile_id }
        : {}),
      modelProfileId: parent.run.effectiveConfig.models.coordinator.profileId,
      taskIntent: parent.run.effectiveConfig.taskIntent ?? 'flow',
      actionPolicy: parent.run.effectiveConfig.actionPolicy,
      ...(parent.run.effectiveConfig.writeScope
        ? { writeScope: parent.run.effectiveConfig.writeScope }
        : {}),
      budget: parent.run.effectiveConfig.budget,
    };
    return startTrustedSmokeRun(ctx, parent.run.id);
  });
  router.get('/api/v1/runs/{runId}/inputs', async (ctx) => {
    await requireAuth(ctx);
    return ctx.api.db.actor(ctx.actor!, async (client) => {
      const parent = await client.query('SELECT 1 FROM runs WHERE id=$1', [
        ctx.params.runId!,
      ]);
      if (!parent.rowCount) throw new StorageError('NOT_FOUND');
      const rows = await client.query<{ document: unknown }>(
        "SELECT document FROM input_requests WHERE run_id=$1 AND document->>'status'='pending' AND (document->>'expiresAt')::timestamptz>clock_timestamp() ORDER BY id",
        [ctx.params.runId!],
      );
      return parseContract('InputRequestPage', {
        items: rows.rows.map((r) => r.document),
      });
    });
  });
  router.delete('/api/v1/runs/{runId}', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const input = parseContract('RunDeleteConfirm', ctx.body);
    await ctx.api.runRepo.delete(ctx.actor!, ctx.params.runId!, input);
    ctx.res.statusCode = 204;
    ctx.res.end();
  });
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
        try {
          items.push(await runDTO(client, projectId, id));
        } catch (error) {
          if (!(error instanceof StorageError && error.code === 'NOT_FOUND'))
            throw error;
          // A concurrent deletion must not fail the whole history list.
        }
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

      const nextVersion = current.version + 1;

      // Conversation text cannot invalidate an in-flight lease or authenticated state.
      // Only actual permission/configuration changes advance authority context.
      await client.query(
        'UPDATE runs SET version = $3, updated_at = clock_timestamp() WHERE project_id = $1 AND id = $2 AND version = $4',
        [projectId, runId, nextVersion, current.version],
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
          current.contextVersion,
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
          if (
            currentInput.kind === 'auth_profile' &&
            response.decision === 'provide'
          ) {
            if (
              !response.authProfileId ||
              response.text ||
              response.oneTimeCode ||
              response.allowedOrigins
            )
              throw new StorageError('VALIDATION_ERROR');
            await authorize(client, projectId, 'run');
            const run = await runDTO(client, projectId, runId!);
            if (
              run.phase !== 'preflight' ||
              TERMINAL.has(run.status) ||
              run.status === 'cancelling'
            )
              throw new StorageError(
                'VALIDATION_ERROR',
                '认证只能在执行前补充，请重新发起任务',
              );
            const metadata = (
              await client.query<{ environment_id: string | null }>(
                'SELECT environment_id FROM runs WHERE id=$1',
                [runId!],
              )
            ).rows[0]!;
            const head = await client.query(
              'SELECT id FROM auth_profiles WHERE project_id=$1 AND id=$2 AND NOT revoked AND deleted_at IS NULL FOR SHARE',
              [projectId, response.authProfileId],
            );
            if (!head.rowCount) throw new StorageError('NOT_FOUND');
            const profile = await resolveRunAuth(
              client,
              projectId,
              response.authProfileId,
              metadata.environment_id ?? undefined,
              run.effectiveConfig.allowedOrigins,
              false,
            );
            if (!profile || profile.mode === 'none')
              throw new StorageError('VALIDATION_ERROR');
            const config = parseContract('RunConfig', {
              ...run.effectiveConfig,
              authProfileVersion: profile.version,
            });
            await client.query(
              "UPDATE runs SET auth_profile_id=$2,auth_profile_version=$3,effective_config=$4,context_version=context_version+1,version=version+1,status='running',updated_at=clock_timestamp() WHERE id=$1",
              [run.id, profile.id, profile.version, config],
            );
            await client.query(
              "UPDATE jobs SET status='queued',result=result||'{\"inputId\":null}'::jsonb WHERE project_id=$1 AND run_id=$2 AND status='waiting' AND result->>'inputId'=$3 AND result->>'stage'='preflight'",
              [projectId, run.id, inputId!],
            );
            const updated = parseContract('InputRequest', {
              ...currentInput,
              status: 'resolved',
              version: currentInput.version + 1,
            });
            await client.query(
              'UPDATE input_requests SET document=$2,version=version+1,actor_id=actor_id() WHERE id=$1',
              [inputId!, updated],
            );
            await audit(
              client,
              'input.auth_profile_provided',
              inputId!,
              projectId,
              updated.version,
            );
            await appendEvent(
              client,
              projectId,
              run.id,
              'run.updated',
              await runDTO(client, projectId, run.id),
            );
            await appendEvent(
              client,
              projectId,
              run.id,
              'input.resolved',
              updated,
            );
            return updated;
          }
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

          if (currentInput.kind === 'clarification') {
            // The coordinator owns its transaction and rechecks the input.
            // Do not hold this transaction's run/input locks while calling it.
            return { clarificationProjectId: projectId };
          }
          if (response.decision !== 'reject')
            throw new StorageError(
              'VALIDATION_ERROR',
              '该请求需要重新配置后发起任务',
            );

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

          await client.query(
            "UPDATE jobs SET status='cancelled' WHERE project_id=$1 AND run_id=$2 AND status='waiting' AND result->>'inputId'=$3",
            [projectId, runId!, inputId!],
          );
          await client.query(
            "UPDATE runs SET status='running',termination_reason='setup_failure',version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND status IN ('running','awaiting_input')",
            [runId!],
          );
          await appendEvent(
            client,
            projectId,
            runId!,
            'run.updated',
            await runDTO(client, projectId, runId!),
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
                response.text === undefined
                  ? undefined
                  : sanitizeUserText(response.text),
                response.decision,
              )
            : updatedInput;
      ctx.res.statusCode = 200;
      return parseContract('InputRequest', result);
    },
  );
}
