import { randomUUID, createHash } from 'node:crypto';
import {
  ReportBuilder,
  LocalVolumeArtifactStore,
  ExportService,
  validateEvidenceReferences,
} from '@localqa/report';
import { parseContract, getApiValidator } from '@localqa/contracts';
import type {
  CaseRecord,
  Task,
  RunEvent,
  Finding,
  Export,
  Artifact,
  Reproduction,
  ModelUsage,
} from '@localqa/contracts';
import {
  StorageError,
  hashToken,
  hashPayload,
  newToken,
  appendEvent,
  audit,
  runDTO,
} from '@localqa/storage';
import { requireAuth } from '../auth.js';
import { ApiError } from '../errors.js';
import { parsePagination, paginate, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

export function registerExecutionRoutes(router: Router): void {
  // GET /api/v1/runs/{runId}/cases
  router.get('/api/v1/runs/{runId}/cases', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const runId = ctx.params.runId!;

    const cases = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const runRow = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM runs WHERE id = $1',
          [runId],
        )
      ).rows[0];
      if (!runRow) throw new StorageError('NOT_FOUND');
      const projectId = runRow.project_id;

      const rows = await client.query<{
        definition: unknown;
        verdict: unknown | null;
        outcome: CaseRecord['outcome'];
      }>(
        `SELECT c.document AS definition,
                v.document AS verdict,
                COALESCE(v.document->>'status',
                  CASE WHEN EXISTS (
                    SELECT 1 FROM case_attempts ca
                    WHERE ca.project_id = c.project_id AND ca.case_id = c.id
                      AND ca.status IN ('running', 'completed', 'interrupted', 'cancelled')
                  ) THEN 'inconclusive'
                  ELSE 'not_run'
                  END
                ) AS outcome
         FROM run_cases c
         LEFT JOIN final_valid_verdicts v
           ON v.project_id = c.project_id AND v.case_id = c.id
         WHERE c.project_id = $1 AND c.run_id = $2
         ORDER BY c.id`,
        [projectId, runId],
      );

      return rows.rows.map((r) =>
        parseContract('CaseRecord', {
          definition: r.definition,
          outcome: r.outcome,
          verdict: r.verdict ?? null,
        }),
      );
    });

    const { limit, offset } = parsePagination(ctx.query);
    const page = paginate(cases, limit, offset);

    ctx.res.statusCode = 200;
    return parseContract('CaseRecordPage', page);
  });

  // GET /api/v1/cases/{caseId}
  router.get('/api/v1/cases/{caseId}', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const caseId = ctx.params.caseId!;

    const caseRecord = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{
          definition: unknown;
          verdict: unknown | null;
          outcome: CaseRecord['outcome'];
        }>(
          `SELECT c.document AS definition,
                  v.document AS verdict,
                  COALESCE(v.document->>'status',
                    CASE WHEN EXISTS (
                      SELECT 1 FROM case_attempts ca
                      WHERE ca.project_id = c.project_id AND ca.case_id = c.id
                        AND ca.status IN ('running', 'completed', 'interrupted', 'cancelled')
                    ) THEN 'inconclusive'
                    ELSE 'not_run'
                    END
                  ) AS outcome
           FROM run_cases c
           LEFT JOIN final_valid_verdicts v
             ON v.project_id = c.project_id AND v.case_id = c.id
           WHERE c.id = $1`,
          [caseId],
        )
      ).rows[0];

      if (!row) throw new StorageError('NOT_FOUND');
      return parseContract('CaseRecord', {
        definition: row.definition,
        outcome: row.outcome,
        verdict: row.verdict ?? null,
      });
    });

    ctx.res.statusCode = 200;
    return caseRecord;
  });

  // GET /api/v1/cases/{caseId}/attempts
  router.get('/api/v1/cases/{caseId}/attempts', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const caseId = ctx.params.caseId!;

    const attempts = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const rows = await client.query<{ dto: unknown }>(
        `SELECT jsonb_build_object(
                  'id', a.id,
                  'caseId', a.case_id,
                  'taskId', a.task_id,
                  'attemptNumber', a.attempt_number,
                  'status', a.status,
                  'verdict', v.document,
                  'startedAt', to_char(a.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  'finishedAt', to_char(a.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                ) AS dto
         FROM case_attempts a
         LEFT JOIN verdicts v ON v.project_id = a.project_id AND v.attempt_id = a.id
         WHERE a.case_id = $1
         ORDER BY a.attempt_number ASC`,
        [caseId],
      );

      return rows.rows.map((r) => parseContract('CaseAttempt', r.dto));
    });

    const { limit, offset } = parsePagination(ctx.query);
    const page = paginate(attempts, limit, offset);

    ctx.res.statusCode = 200;
    return parseContract('CaseAttemptPage', page);
  });

  // GET /api/v1/runs/{runId}/tasks
  router.get('/api/v1/runs/{runId}/tasks', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const runId = ctx.params.runId!;

    const tasks = await ctx.api.db.actor(ctx.actor!, async (client) => {
      if (
        !(await client.query('SELECT 1 FROM runs WHERE id=$1', [runId]))
          .rowCount
      )
        throw new StorageError('NOT_FOUND');
      const rows = await client.query<{
        document: unknown;
        status: Task['status'];
      }>(
        `SELECT document, status
         FROM jobs
         WHERE run_id = $1
         ORDER BY available_at, id`,
        [runId],
      );

      return rows.rows.map((r) =>
        parseContract('Task', {
          ...(r.document as Record<string, unknown>),
          status: r.status,
        }),
      );
    });

    const { limit, offset } = parsePagination(ctx.query);
    const page = paginate(tasks, limit, offset);

    ctx.res.statusCode = 200;
    return parseContract('TaskPage', page);
  });

  // GET /api/v1/tasks/{taskId}/steps
  router.get('/api/v1/tasks/{taskId}/steps', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const taskId = ctx.params.taskId!;

    const steps = await ctx.api.db.actor(ctx.actor!, async (client) => {
      if (
        !(await client.query('SELECT 1 FROM jobs WHERE id=$1', [taskId]))
          .rowCount
      )
        throw new StorageError('NOT_FOUND');
      const rows = await client.query<{ document: unknown }>(
        `SELECT document
         FROM steps
         WHERE task_id = $1
         ORDER BY seq, id`,
        [taskId],
      );
      return rows.rows.map((r) => parseContract('Step', r.document));
    });

    const { limit, offset } = parsePagination(ctx.query);
    const page = paginate(steps, limit, offset);

    ctx.res.statusCode = 200;
    return parseContract('StepPage', page);
  });

  // GET /api/v1/steps/{stepId}
  router.get('/api/v1/steps/{stepId}', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const stepId = ctx.params.stepId!;

    const step = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ document: unknown }>(
          'SELECT document FROM steps WHERE id = $1',
          [stepId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      return parseContract('Step', row.document);
    });

    ctx.res.statusCode = 200;
    return step;
  });

  // GET /api/v1/runs/{runId}/event-history
  router.get(
    '/api/v1/runs/{runId}/event-history',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const runId = ctx.params.runId!;

      const afterRaw = ctx.query['afterSeq'];
      const limitRaw = ctx.query['limit'];
      if (
        (afterRaw !== undefined && !/^(0|[1-9]\d*)$/.test(afterRaw)) ||
        (limitRaw !== undefined && !/^[1-9]\d*$/.test(limitRaw))
      ) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'Invalid event-history pagination',
          422,
        );
      }
      const afterSeq = afterRaw === undefined ? 0 : Number(afterRaw);
      const limit = limitRaw === undefined ? 20 : Number(limitRaw);
      const validateQuery = getApiValidator('listEventHistory', {
        kind: 'parameters',
        location: 'query',
      });
      if (
        !Number.isSafeInteger(afterSeq) ||
        !validateQuery({ afterSeq, limit })
      ) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'Invalid event-history pagination',
          422,
        );
      }

      const { items, nextCursor } = await ctx.api.db.actor(
        ctx.actor!,
        async (client) => {
          if (
            !(await client.query('SELECT 1 FROM runs WHERE id=$1', [runId]))
              .rowCount
          )
            throw new StorageError('NOT_FOUND');
          const rows = await client.query<{
            seq: string;
            type: RunEvent['type'];
            payload: unknown;
            created_at: Date;
          }>(
            `SELECT seq, type, payload, created_at
         FROM run_events
         WHERE run_id = $1 AND seq > $2
         ORDER BY seq ASC
         LIMIT $3`,
            [runId, afterSeq, limit + 1],
          );

          const hasMore = rows.rows.length > limit;
          const slice = hasMore ? rows.rows.slice(0, limit) : rows.rows;
          const eventItems = slice.map((r) =>
            parseContract('RunEvent', {
              schemaVersion: 1,
              id: String(r.seq),
              runId,
              seq: Number(r.seq),
              type: r.type,
              at: r.created_at.toISOString(),
              payload: r.payload,
            }),
          );

          const next =
            hasMore && slice.length > 0
              ? String(slice[slice.length - 1]!.seq)
              : null;
          return { items: eventItems, nextCursor: next };
        },
      );

      ctx.res.statusCode = 200;
      return parseContract('RunEventPage', { items, nextCursor });
    },
  );

  // GET /api/v1/runs/{runId}/findings
  router.get('/api/v1/runs/{runId}/findings', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const runId = ctx.params.runId!;

    const findings = await ctx.api.db.actor(ctx.actor!, async (client) => {
      if (
        !(await client.query('SELECT 1 FROM runs WHERE id=$1', [runId]))
          .rowCount
      )
        throw new StorageError('NOT_FOUND');
      const rows = await client.query<{ document: unknown }>(
        `SELECT document
         FROM findings
         WHERE run_id = $1
         ORDER BY id`,
        [runId],
      );
      return rows.rows.map((r) => parseContract('Finding', r.document));
    });

    const { limit, offset } = parsePagination(ctx.query);
    const page = paginate(findings, limit, offset);

    ctx.res.statusCode = 200;
    return parseContract('FindingPage', page);
  });

  // GET /api/v1/findings/{findingId}
  router.get('/api/v1/findings/{findingId}', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const findingId = ctx.params.findingId!;

    const finding = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ document: unknown }>(
          'SELECT document FROM findings WHERE id = $1',
          [findingId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      return parseContract('Finding', row.document);
    });

    ctx.res.statusCode = 200;
    return finding;
  });

  // POST /api/v1/findings/{findingId}/triage-preview
  router.post(
    '/api/v1/findings/{findingId}/triage-preview',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const findingId = ctx.params.findingId!;
      const input = parseContract('TriageInput', ctx.body);

      const preview = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const findingRow = (
          await client.query<{ project_id: string; version: number }>(
            'SELECT project_id, version FROM findings WHERE id = $1',
            [findingId],
          )
        ).rows[0];
        if (!findingRow) throw new StorageError('NOT_FOUND');

        if (findingRow.version !== input.expectedVersion) {
          throw new StorageError('VERSION_CONFLICT');
        }

        const previewId = randomUUID();
        const token = newToken();
        const tokenH = hashToken(token);
        const approvedBody = {
          expectedVersion: input.expectedVersion,
          disposition: input.disposition,
          reason: input.reason,
        };
        const bodyHash = hashPayload(approvedBody);
        const expiresAt = new Date(Date.now() + 300000).toISOString();

        await client.query(
          `INSERT INTO confirmation_previews(id, project_id, finding_id, actor_id, expected_version, body_hash, token_hash, expires_at, approved_body)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            previewId,
            findingRow.project_id,
            findingId,
            ctx.actor!.userId,
            input.expectedVersion,
            bodyHash,
            tokenH,
            expiresAt,
            approvedBody,
          ],
        );

        return parseContract('TriagePreview', {
          findingId,
          expectedVersion: input.expectedVersion,
          disposition: input.disposition,
          reason: input.reason,
          confirmationToken: token,
          expiresAt,
        });
      });

      ctx.res.statusCode = 200;
      return preview;
    },
  );

  // POST /api/v1/findings/{findingId}/triage
  router.post(
    '/api/v1/findings/{findingId}/triage',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const findingId = ctx.params.findingId!;
      const input = parseContract('TriageCommit', ctx.body);

      const updatedFinding = await ctx.api.db.actor(
        ctx.actor!,
        async (client) => {
          const tokenH = hashToken(input.confirmationToken);

          const previewRow = (
            await client.query<{
              id: string;
              project_id: string;
              finding_id: string;
              actor_id: string;
              expected_version: number;
              body_hash: string;
              expires_at: Date;
              consumed_at: Date | null;
            }>(
              'SELECT * FROM confirmation_previews WHERE token_hash = $1 FOR UPDATE',
              [tokenH],
            )
          ).rows[0];

          if (!previewRow) {
            throw new StorageError('VALIDATION_ERROR');
          }

          if (previewRow.consumed_at !== null) {
            throw new StorageError('VERSION_CONFLICT');
          }

          if (previewRow.expires_at.getTime() <= Date.now()) {
            throw new StorageError('VERSION_CONFLICT');
          }

          if (
            previewRow.finding_id !== findingId ||
            previewRow.actor_id !== ctx.actor!.userId
          ) {
            throw new StorageError('FORBIDDEN');
          }

          if (previewRow.expected_version !== input.expectedVersion) {
            throw new StorageError('VERSION_CONFLICT');
          }

          const expectedBodyHash = hashPayload({
            expectedVersion: input.expectedVersion,
            disposition: input.disposition,
            reason: input.reason,
          });

          if (previewRow.body_hash !== expectedBodyHash) {
            throw new StorageError('VALIDATION_ERROR');
          }

          // Mark preview as consumed (single-use)
          await client.query(
            'UPDATE confirmation_previews SET consumed_at = clock_timestamp() WHERE id = $1',
            [previewRow.id],
          );

          // Fetch current finding
          const findingRow = (
            await client.query<{
              project_id: string;
              run_id: string;
              version: number;
              document: unknown;
            }>(
              'SELECT project_id, run_id, version, document FROM findings WHERE id = $1 FOR UPDATE',
              [findingId],
            )
          ).rows[0];

          if (!findingRow) throw new StorageError('NOT_FOUND');
          if (findingRow.version !== input.expectedVersion) {
            throw new StorageError('VERSION_CONFLICT');
          }

          const currentDoc = findingRow.document as Record<string, unknown>;
          const nextVersion = findingRow.version + 1;
          const triageDoc = {
            expectedVersion: input.expectedVersion,
            disposition: input.disposition,
            reason: input.reason,
          };

          const updatedDoc: Finding = parseContract('Finding', {
            ...currentDoc,
            version: nextVersion,
            triageDisposition: input.disposition,
          });

          await client.query(
            'UPDATE findings SET version = version + 1, document = $2 WHERE id = $1',
            [findingId, updatedDoc],
          );

          // Record in triage table
          await client.query(
            'INSERT INTO triage(id, project_id, finding_id, actor_id, preview_id, document) VALUES($1, $2, $3, $4, $5, $6)',
            [
              randomUUID(),
              previewRow.project_id,
              findingId,
              ctx.actor!.userId,
              previewRow.id,
              triageDoc,
            ],
          );

          await appendEvent(
            client,
            previewRow.project_id,
            findingRow.run_id,
            'finding.updated',
            updatedDoc,
          );
          await audit(
            client,
            'finding.triaged',
            findingId,
            previewRow.project_id,
            nextVersion,
          );

          return updatedDoc;
        },
      );

      ctx.res.statusCode = 200;
      return parseContract('Finding', updatedFinding);
    },
  );

  // GET /api/v1/runs/{runId}/report
  router.get('/api/v1/runs/{runId}/report', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const runId = ctx.params.runId!;

    const report = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const runRow = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM runs WHERE id = $1',
          [runId],
        )
      ).rows[0];
      if (!runRow) throw new StorageError('NOT_FOUND');
      const projectId = runRow.project_id;

      const run = await runDTO(client, projectId, runId);
      const summary = await ctx.api.runRepo.summary(
        ctx.actor!,
        projectId,
        runId,
      );

      // Cases
      const caseRows = await client.query<{
        definition: unknown;
        verdict: unknown | null;
        outcome: CaseRecord['outcome'];
      }>(
        `SELECT c.document AS definition,
                v.document AS verdict,
                COALESCE(v.document->>'status',
                  CASE WHEN EXISTS (
                    SELECT 1 FROM case_attempts ca
                    WHERE ca.project_id = c.project_id AND ca.case_id = c.id
                      AND ca.status IN ('running', 'completed', 'interrupted', 'cancelled')
                  ) THEN 'inconclusive'
                  ELSE 'not_run'
                  END
                ) AS outcome
         FROM run_cases c
         LEFT JOIN final_valid_verdicts v
           ON v.project_id = c.project_id AND v.case_id = c.id
         WHERE c.project_id = $1 AND c.run_id = $2
         ORDER BY c.id`,
        [projectId, runId],
      );
      const cases: CaseRecord[] = caseRows.rows.map((r) =>
        parseContract('CaseRecord', {
          definition: r.definition,
          outcome: r.outcome,
          verdict: r.verdict ?? null,
        }),
      );

      // Findings
      const findingRows = await client.query<{ document: unknown }>(
        'SELECT document FROM findings WHERE project_id = $1 AND run_id = $2 ORDER BY id',
        [projectId, runId],
      );
      const findings: Finding[] = findingRows.rows.map((r) =>
        parseContract('Finding', r.document),
      );

      // Reproductions
      const reproRows = await client.query<{ document: unknown }>(
        'SELECT document FROM reproductions WHERE project_id = $1 AND run_id = $2 ORDER BY id',
        [projectId, runId],
      );
      const reproductions: Reproduction[] = reproRows.rows.map((r) =>
        parseContract('Reproduction', r.document),
      );

      // Artifacts
      const artifactRows = await client.query<{ document: unknown }>(
        'SELECT document FROM artifacts WHERE project_id = $1 AND run_id = $2 ORDER BY id',
        [projectId, runId],
      );
      const artifacts: Artifact[] = artifactRows.rows.map((r) =>
        parseContract('Artifact', r.document),
      );

      // Model requests contain actual provider diagnostics; reservation counters
      // are BudgetUsed, not ModelUsage DTOs.
      const usageRows = await client.query<{
        diagnostic: Record<string, unknown>;
        configured_model_id: string;
      }>(
        `SELECT m.redacted_diagnostic AS diagnostic,
                COALESCE(m.redacted_diagnostic->>'configuredModelId',v.document->>'configuredModelId','unknown') AS configured_model_id
         FROM model_requests m
         LEFT JOIN model_profile_versions v ON v.profile_id::text=m.redacted_diagnostic->>'profileId'
           AND v.version::text=m.redacted_diagnostic->>'profileVersion'
         WHERE m.project_id=$1 AND m.run_id=$2 ORDER BY m.request_id`,
        [projectId, runId],
      );
      const grouped = new Map<
        string,
        { usage: ModelUsage; sources: Set<string> }
      >();
      for (const row of usageRows.rows) {
        const d = row.diagnostic;
        if (typeof d['profileId'] !== 'string') continue;
        const reportedModelId =
          typeof d['reportedModelId'] === 'string'
            ? d['reportedModelId']
            : null;
        const key = JSON.stringify([
          d['profileId'],
          row.configured_model_id,
          reportedModelId,
        ]);
        let group = grouped.get(key);
        if (!group) {
          group = {
            usage: {
              profileId: d['profileId'],
              configuredModelId: row.configured_model_id,
              reportedModelId,
              requests: 0,
              inputTokens: 0,
              outputTokens: 0,
              usageSource: 'unknown',
            },
            sources: new Set(),
          };
          grouped.set(key, group);
        }
        group.usage.requests++;
        group.sources.add(
          typeof d['usageSource'] === 'string' ? d['usageSource'] : 'unknown',
        );
        for (const field of ['inputTokens', 'outputTokens'] as const) {
          const value = d[field];
          group.usage[field] =
            group.usage[field] !== null &&
            typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= 0
              ? group.usage[field] + value
              : null;
        }
      }
      const modelUsage = [...grouped.values()].map(({ usage, sources }) =>
        parseContract('ModelUsage', {
          ...usage,
          usageSource:
            sources.size > 1
              ? 'mixed'
              : ['reported', 'estimated'].includes([...sources][0] ?? '')
                ? [...sources][0]
                : 'unknown',
        }),
      );

      const sessionRow = (
        await client.query<{ document: unknown }>(
          'SELECT document FROM run_sessions WHERE project_id=$1 AND run_id=$2',
          [projectId, runId],
        )
      ).rows[0];
      const session = sessionRow
        ? parseContract('SessionReport', sessionRow.document)
        : null;
      return parseContract('Report', {
        schemaVersion: 1,
        example: false,
        generatedAt: new Date().toISOString(),
        run,
        summary,
        cases,
        findings,
        reproductions,
        artifacts,
        modelUsage,
        ...(session ? { session } : {}),
        coverageGaps: session?.coverageGaps ?? [],
        cleanupStatus: 'succeeded',
        warnings:
          run.status === 'failed'
            ? [
                ...new Set(
                  usageRows.rows.flatMap(({ diagnostic }) => {
                    const code = diagnostic['errorCode'];
                    if (code === 'RATE_LIMITED')
                      return [
                        'RATE_LIMITED：模型服务商返回 HTTP 429，渠道繁忙或请求受到限流，请稍后重试或检查服务商并发额度。',
                      ];
                    if (code === 'MODEL_NOT_CONFIGURED')
                      return [
                        'MODEL_NOT_CONFIGURED：模型服务商拒绝认证，请检查 API Key 和模型权限。',
                      ];
                    if (code === 'MODEL_BILLING_REQUIRED')
                      return [
                        'MODEL_BILLING_REQUIRED：模型服务商提示余额或计费异常。',
                      ];
                    return [];
                  }),
                ),
              ]
            : [],
      });
    });

    ctx.res.statusCode = 200;
    return report;
  });

  // POST /api/v1/runs/{runId}/exports
  router.post('/api/v1/runs/{runId}/exports', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const runId = ctx.params.runId!;
    const input = parseContract('ExportInput', ctx.body);

    const store = new LocalVolumeArtifactStore(ctx.api.artifacts.root);
    const service = new ExportService({ artifactStore: store });
    const exportRecord = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const runRow = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM runs WHERE id = $1',
          [runId],
        )
      ).rows[0];
      if (!runRow) throw new StorageError('NOT_FOUND');
      const projectId = runRow.project_id;
      const report = await new ReportBuilder().build(client, projectId, runId, {
        artifactStore: store,
      });
      const refs = await validateEvidenceReferences(
        projectId,
        runId,
        report.artifacts,
        report.cases.flatMap((c) => (c.verdict ? [c.verdict] : [])),
        report.findings,
        report.reproductions,
        store,
      );
      if (input.format === 'zip') {
        return (await service.exportZip(client, report, refs.manifest))
          .exportRecord;
      }
      const content =
        input.format === 'json'
          ? service.exportJson(report).content
          : service.exportMarkdown(report, refs.manifest).content;
      const bytes = Buffer.from(content, 'utf8');
      const artifactId = randomUUID();
      const artifact = await store.put(
        {
          id: artifactId,
          projectId,
          runId,
          kind: 'export',
          redaction: 'not_needed',
          bytes: bytes.length,
          sha256: store.checksum(bytes),
        },
        bytes,
      );
      await client.query(
        `INSERT INTO artifacts(id, project_id, run_id, document, retain_until, held)
         VALUES($1,$2,$3,$4,clock_timestamp()+interval '30 days',false)`,
        [artifactId, projectId, runId, artifact],
      );
      const doc: Export = parseContract('Export', {
        id: randomUUID(),
        runId,
        status: 'ready',
        format: input.format,
        artifactId,
        snapshotAt: new Date().toISOString(),
        error: null,
      });
      await client.query(
        `INSERT INTO exports(id, project_id, run_id, status, document, report_snapshot, artifact_id, retain_until, held)
         VALUES($1,$2,$3,'ready',$4,$5,$6,clock_timestamp()+interval '30 days',false)`,
        [doc.id, projectId, runId, doc, report, artifactId],
      );
      return doc;
    });

    ctx.res.statusCode = 202;
    return exportRecord;
  });

  // GET /api/v1/exports/{exportId}
  router.get('/api/v1/exports/{exportId}', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const exportId = ctx.params.exportId!;

    const exportRecord = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ document: unknown }>(
          'SELECT document FROM exports WHERE id = $1',
          [exportId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      return parseContract('Export', row.document);
    });

    ctx.res.statusCode = 200;
    return exportRecord;
  });

  // GET /api/v1/artifacts/{artifactId}
  router.get('/api/v1/artifacts/{artifactId}', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const artifactId = ctx.params.artifactId!;

    const artifact = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ document: unknown }>(
          'SELECT document FROM artifacts WHERE id = $1',
          [artifactId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      return parseContract('Artifact', row.document);
    });

    ctx.res.statusCode = 200;
    return artifact;
  });

  // GET /api/v1/artifacts/{artifactId}/content
  router.get(
    '/api/v1/artifacts/{artifactId}/content',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const artifactId = ctx.params.artifactId!;

      const artifact = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const row = (
          await client.query<{ document: unknown }>(
            'SELECT document FROM artifacts WHERE id = $1',
            [artifactId],
          )
        ).rows[0];
        if (!row) throw new StorageError('NOT_FOUND');
        return parseContract('Artifact', row.document);
      });
      if (artifact.status === 'missing' || artifact.status === 'failed') {
        throw new ApiError('NOT_FOUND', 'Artifact content unavailable', 404);
      }
      let bytes: Buffer;
      try {
        bytes = await ctx.api.artifacts.get(
          artifact.projectId,
          artifact.runId,
          artifact.id,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code !== 'ENOENT'
        )
          throw error;
        throw new ApiError('NOT_FOUND', 'Artifact content unavailable', 404);
      }
      if (
        createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
      ) {
        throw new ApiError(
          'SERVICE_UNAVAILABLE',
          'Artifact checksum mismatch',
          503,
        );
      }

      const exportFormat =
        artifact.kind === 'export'
          ? await ctx.api.db.actor(
              ctx.actor!,
              async (client) =>
                (
                  await client.query<{ format: string }>(
                    "SELECT document->>'format' AS format FROM exports WHERE artifact_id=$1",
                    [artifactId],
                  )
                ).rows[0]?.format,
            )
          : null;
      const contentType =
        artifact.kind === 'screenshot'
          ? 'image/png'
          : artifact.kind === 'network' || artifact.kind === 'console'
            ? 'application/json'
            : artifact.kind === 'export'
              ? exportFormat === 'json'
                ? 'application/json'
                : exportFormat === 'markdown'
                  ? 'text/markdown; charset=utf-8'
                  : 'application/zip'
              : 'application/octet-stream';

      const range = ctx.headers['range'];
      let start = 0;
      let end = bytes.length - 1;
      if (range !== undefined) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
          if (match[1]) {
            start = Number(match[1]);
            end = match[2] ? Number(match[2]) : end;
          } else {
            const suffix = Number(match[2]);
            start =
              suffix > 0 ? Math.max(0, bytes.length - suffix) : bytes.length;
          }
        } else start = bytes.length;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start >= bytes.length ||
          end < start
        ) {
          ctx.res.writeHead(416, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Range': `bytes */${bytes.length}`,
          });
          ctx.res.end(
            JSON.stringify(
              parseContract('Error', {
                code: 'VALIDATION_ERROR',
                message: 'Unsatisfiable byte range',
                requestId: ctx.requestId,
              }),
            ),
          );
          return undefined;
        }
        end = Math.min(end, bytes.length - 1);
      }
      const chunk = bytes.subarray(start, end + 1);
      ctx.res.writeHead(range === undefined ? 200 : 206, {
        'Content-Type': contentType,
        'Content-Length': chunk.length,
        'Accept-Ranges': 'bytes',
        ...(range === undefined
          ? {}
          : { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }),
        'Content-Disposition': `inline; filename="${artifactId}.${artifact.kind === 'screenshot' ? 'png' : exportFormat === 'json' ? 'json' : exportFormat === 'markdown' ? 'md' : exportFormat === 'zip' ? 'zip' : 'bin'}"`,
      });
      ctx.res.end(chunk);
      return undefined;
    },
  );
}
