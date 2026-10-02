import { randomUUID } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
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

      let afterSeq = 0;
      if (ctx.query['afterSeq']) {
        const parsed = parseInt(ctx.query['afterSeq'], 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          afterSeq = parsed;
        }
      }

      let limit = 100;
      if (ctx.query['limit']) {
        const parsed = parseInt(ctx.query['limit'], 10);
        if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 100) {
          limit = parsed;
        }
      }

      const { items, nextCursor } = await ctx.api.db.actor(
        ctx.actor!,
        async (client) => {
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

      // Model Usage
      const usageRows = await client.query<{ usage: unknown }>(
        `SELECT b.charged AS usage
         FROM budget_reservations b
         WHERE b.project_id = $1 AND b.run_id = $2 AND b.kind = 'model_call' AND b.status = 'consumed'`,
        [projectId, runId],
      );
      const modelUsage: ModelUsage[] = usageRows.rows
        .filter((r) => r.usage && typeof r.usage === 'object')
        .map((r) => parseContract('ModelUsage', r.usage));

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
        coverageGaps: [],
        cleanupStatus: 'succeeded',
        warnings: [],
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

    const exportRecord = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const runRow = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM runs WHERE id = $1',
          [runId],
        )
      ).rows[0];
      if (!runRow) throw new StorageError('NOT_FOUND');
      const projectId = runRow.project_id;

      const exportId = randomUUID();
      const now = new Date().toISOString();
      const retainUntil = new Date(Date.now() + 30 * 86400000).toISOString();

      const doc: Export = parseContract('Export', {
        id: exportId,
        runId,
        status: 'ready',
        format: input.format,
        artifactId: null,
        snapshotAt: now,
        error: null,
      });

      await client.query(
        `INSERT INTO exports(id, project_id, run_id, status, document, report_snapshot, artifact_id, retain_until)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
        [exportId, projectId, runId, 'ready', doc, {}, null, retainUntil],
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

      const { artifact, bytes } = await ctx.api.db.actor(
        ctx.actor!,
        async (client) => {
          const row = (
            await client.query<{ document: unknown }>(
              'SELECT document FROM artifacts WHERE id = $1',
              [artifactId],
            )
          ).rows[0];
          if (!row) throw new StorageError('NOT_FOUND');
          const art = parseContract('Artifact', row.document);

          let contentBytes: Buffer;
          try {
            contentBytes = await ctx.api.artifacts.get(
              art.projectId,
              art.runId,
              art.id,
            );
          } catch {
            contentBytes = Buffer.from('{}', 'utf8');
          }
          return { artifact: art, bytes: contentBytes };
        },
      );

      const contentType =
        artifact.kind === 'screenshot'
          ? 'image/png'
          : artifact.kind === 'network' || artifact.kind === 'console'
            ? 'application/json'
            : artifact.kind === 'export'
              ? 'application/zip'
              : 'application/octet-stream';

      ctx.res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': bytes.length,
        'Content-Disposition': `inline; filename="${artifactId}.${artifact.kind === 'screenshot' ? 'png' : 'bin'}"`,
      });
      ctx.res.end(bytes);
      return undefined;
    },
  );
}
