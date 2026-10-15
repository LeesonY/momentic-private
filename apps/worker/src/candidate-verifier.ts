import { createHash, randomUUID } from 'node:crypto';
import type { BrowserPort, BrowserSession } from '@localqa/browser';
import { parseContract } from '@localqa/contracts';
import { assertPublicOrApprovedTarget } from '@localqa/domain';
import type {
  BrowserSnapshot,
  Criterion,
  RegressionDocument,
  ToolCall,
  NodeTarget,
} from '@localqa/contracts';
import {
  authorize,
  hashPayload,
  type SecretVault,
  type Actor,
  type Database,
} from '@localqa/storage';
import {
  CandidateLocatorFailure,
  resolveCandidateLocator,
} from './candidate-locator-recovery.js';

interface QueuedCandidate {
  id: string;
  project_id: string;
  case_id: string;
  case_version_id: string;
  candidate_sha256: string;
  requested_by: string;
  document: unknown;
  fencing_token: string;
}

type CandidateStepEvidence = {
  id: string;
  index: number;
  kind: 'navigate' | 'click' | 'type_text' | 'assert';
  criterionId: string | null;
  passed: boolean | null;
  snapshot: BrowserSnapshot;
  screenshot: Buffer | null;
};

class VerificationBlocked extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const safeReason = (e: unknown): string =>
  e instanceof VerificationBlocked ? e.code : 'VERIFICATION_EXECUTION_ERROR';

/**
 * Dedicated credential-free, non-submitting verification lane for human
 * accepted repair suggestions. It NEVER runs as a normal approved regression
 * and never silently upgrades the draft or reuses old browser/auth state.
 */
export class CandidateVerifier {
  private activeAbort: AbortController | null = null;
  private stopping = false;
  constructor(
    private readonly db: Database,
    private readonly adminActor: Actor,
    private readonly browser: BrowserPort,
    private readonly workerId: string,
    private readonly vault: SecretVault,
  ) {}

  /** Graceful shutdown aborts active Chromium actions without replaying them. */
  cancelActive(): void {
    this.stopping = true;
    this.activeAbort?.abort('WORKER_SHUTDOWN');
  }

  /** Prune one bounded, project-scoped batch. Server-side SQL enforces
   * completion, a 90-day minimum age, worker identity and audit receipts. */
  async pruneExpiredEvidence(projectId: string): Promise<number> {
    return this.db.worker(
      { workerId: this.workerId, projectId },
      async (client) => {
        const row = (
          await client.query<{ count: number }>(
            'SELECT prune_candidate_evidence($1,100) AS count',
            [projectId],
          )
        ).rows[0];
        return row?.count ?? 0;
      },
    );
  }

  async once(projectId: string): Promise<boolean> {
    if (this.stopping) return false;
    const scope = { workerId: this.workerId, projectId };
    const item = await this.db.worker(scope, async (client) => {
      // A crashed verifier cannot safely replay possibly mutating actions.
      await client.query(
        `UPDATE repair_candidate_verifications SET
           status='completed',outcome='inconclusive',
           worker_id=$1,fencing_token=fencing_token+1,lease_until=NULL,
           finished_at=clock_timestamp(),
           result='{"reasonCode":"VERIFIER_INTERRUPTED","fullyVerified":false,"observations":[]}'::jsonb
         WHERE project_id=$2 AND status='running'
           AND lease_until<=clock_timestamp()`,
        [this.workerId, projectId],
      );
      const selected = (
        await client.query<QueuedCandidate>(
          `SELECT v.id,v.project_id,v.case_id,v.case_version_id,
                  v.candidate_sha256,v.requested_by,s.document,v.fencing_token
           FROM repair_candidate_verifications v
           JOIN saved_case_versions s ON s.project_id=v.project_id
             AND s.case_id=v.case_id AND s.id=v.case_version_id
           WHERE v.project_id=$1 AND v.status='queued'
           ORDER BY v.created_at,v.id FOR UPDATE OF v SKIP LOCKED LIMIT 1`,
          [projectId],
        )
      ).rows[0];
      if (!selected) return null;
      const claim = (
        await client.query<{ fencing_token: string }>(
          `UPDATE repair_candidate_verifications SET
         status='running',started_at=clock_timestamp(),
         worker_id=$2,fencing_token=fencing_token+1,
         lease_until=clock_timestamp()+interval '90 seconds'
         WHERE project_id=$3 AND id=$1 AND status='queued'
         RETURNING fencing_token`,
          [selected.id, this.workerId, projectId],
        )
      ).rows[0];
      if (!claim) throw new VerificationBlocked('VERIFICATION_CLAIM_CONFLICT');
      return { ...selected, fencing_token: claim.fencing_token };
    });
    if (!item) return false;

    const evidence: CandidateStepEvidence[] = [];
    let result: {
      fullyVerified: boolean;
      reasonCode: string | null;
      observedSteps: number;
      verifiedCriteria: number;
      observations: unknown[];
    } = {
      fullyVerified: false,
      reasonCode: 'VERIFICATION_INCOMPLETE',
      observedSteps: 0,
      verifiedCriteria: 0,
      observations: [],
    };
    try {
      const permitted = await this.db.actor(
        { userId: item.requested_by },
        async (client) => {
          await authorize(client, item.project_id, 'run');
          const row = (
            await client.query<{
              status: string;
              project_status: string;
              user_disabled: boolean;
              hash: string;
              proposal_status: string | null;
              maintenance_id: string | null;
              maintenance_source_id: string | null;
              maintenance_source_sha256: string | null;
              source_id: string | null;
              source_status: string | null;
              source_sha256: string | null;
            }>(
              `SELECT s.review_status AS status,p.status AS project_status,
                      u.disabled AS user_disabled,s.sha256 AS hash,
                      q.status AS proposal_status,
                      lm.id AS maintenance_id,
                      lm.source_version_id AS maintenance_source_id,
                      lm.source_sha256 AS maintenance_source_sha256,
                      c.current_approved_version_id AS source_id,
                      src.review_status AS source_status,
                      src.sha256 AS source_sha256
               FROM repair_candidate_verifications v
               JOIN saved_case_versions s ON s.project_id=v.project_id
                 AND s.id=v.case_version_id
               JOIN projects p ON p.id=v.project_id
               JOIN users u ON u.id=v.requested_by
               LEFT JOIN repair_proposals q ON q.project_id=v.project_id
                 AND q.id=v.proposal_id
               LEFT JOIN locator_maintenance_drafts lm
                 ON lm.project_id=v.project_id AND lm.id=v.maintenance_id
                 AND lm.case_id=v.case_id AND lm.case_version_id=v.case_version_id
                 AND lm.candidate_sha256=v.candidate_sha256
               LEFT JOIN saved_cases c
                 ON c.project_id=lm.project_id AND c.id=lm.case_id
               LEFT JOIN saved_case_versions src
                 ON src.project_id=lm.project_id AND src.id=lm.source_version_id
               WHERE v.id=$1`,
              [item.id],
            )
          ).rows[0];
          return (
            row?.status === 'draft' &&
            row.project_status === 'active' &&
            !row.user_disabled &&
            (row.proposal_status === 'approved' ||
              (row.maintenance_id !== null &&
                row.maintenance_source_id !== null &&
                row.source_id === row.maintenance_source_id &&
                row.source_status === 'approved' &&
                row.source_sha256 === row.maintenance_source_sha256)) &&
            row.hash === item.candidate_sha256
          );
        },
      );
      if (!permitted)
        throw new VerificationBlocked('VERIFICATION_AUTHORITY_REVOKED');
      if (this.stopping) throw new VerificationBlocked('WORKER_SHUTDOWN');
      const document = parseContract('RegressionDocument', item.document);
      if (hashPayload(document) !== item.candidate_sha256)
        throw new VerificationBlocked('CANDIDATE_HASH_MISMATCH');
      result = await this.verify(item, document, evidence);
    } catch (e) {
      result = { ...result, reasonCode: safeReason(e) };
    }
    await this.db.worker(scope, async (client) => {
      // Insert the entire evidence bundle and publish its verdict atomically.
      for (const entry of evidence) {
        const screenshotDigest = entry.screenshot
          ? createHash('sha256').update(entry.screenshot).digest('hex')
          : null;
        const encrypted = entry.screenshot
          ? this.vault.encrypt(entry.screenshot.toString('base64'), {
              projectId,
              secretId: entry.id,
              purpose: 'candidate_screenshot',
            })
          : null;
        await client.query(
          `INSERT INTO repair_candidate_evidence(
             id,project_id,verification_id,case_version_id,fencing_token,
             step_index,step_kind,criterion_id,criterion_passed,
             snapshot_id,snapshot_document,snapshot_sha256,
             screenshot_sha256,screenshot_bytes,screenshot_ciphertext,
             screenshot_nonce,screenshot_tag,screenshot_key_version
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            entry.id,
            projectId,
            item.id,
            item.case_version_id,
            item.fencing_token,
            entry.index,
            entry.kind,
            entry.criterionId,
            entry.passed,
            entry.snapshot.snapshotId,
            entry.snapshot,
            hashPayload(entry.snapshot),
            screenshotDigest,
            entry.screenshot?.length ?? null,
            encrypted?.ciphertext ?? null,
            encrypted?.nonce ?? null,
            encrypted?.authTag ?? null,
            encrypted?.keyVersion ?? null,
          ],
        );
      }
      const written = await client.query(
        `UPDATE repair_candidate_verifications SET
         status='completed',outcome=$2,finished_at=clock_timestamp(),
         lease_until=NULL,result=$3
         WHERE id=$1 AND project_id=$5 AND status='running'
           AND candidate_sha256=$4 AND worker_id=$6
           AND fencing_token=$7 AND lease_until>clock_timestamp()`,
        [
          item.id,
          result.fullyVerified
            ? 'passed'
            : result.reasonCode === 'CRITERION_FAILED'
              ? 'failed'
              : 'inconclusive',
          result,
          item.candidate_sha256,
          projectId,
          this.workerId,
          item.fencing_token,
        ],
      );
      if (written.rowCount !== 1)
        throw new VerificationBlocked('VERIFICATION_LEASE_EXPIRED');
    });
    return true;
  }

  private async verify(
    item: QueuedCandidate,
    document: RegressionDocument,
    evidence: CandidateStepEvidence[],
  ): Promise<{
    fullyVerified: boolean;
    reasonCode: string | null;
    observedSteps: number;
    verifiedCriteria: number;
    observations: unknown[];
  }> {
    const steps = document.steps;
    for (const step of steps) {
      if (step.kind !== 'navigate') continue;
      try {
        const url = new URL(step.url);
        // The verification lane has no frozen Environment, so a candidate that
        // resolves to loopback/private/link-local/metadata is denied.
        await assertPublicOrApprovedTarget(url.href, [url.origin]);
      } catch {
        throw new VerificationBlocked('VERIFICATION_TARGET_DENIED');
      }
    }
    const origins = steps
      .filter((step) => step.kind === 'navigate')
      .map((step) => new URL((step as { url: string }).url).origin);
    if (
      steps.length > 30 ||
      steps.length === 0 ||
      origins.length === 0 ||
      new Set(origins).size !== 1 ||
      steps.some(
        (step) =>
          !['navigate', 'click', 'type_text', 'assert'].includes(step.kind),
      ) ||
      (document.fixtureRefs?.length ?? 0) > 0
    )
      throw new VerificationBlocked('UNSUPPORTED_CANDIDATE_STEP');
    const shutdown = new AbortController();
    this.activeAbort = shutdown;
    if (this.stopping) shutdown.abort('WORKER_SHUTDOWN');
    const deadline = AbortSignal.any([
      AbortSignal.timeout(45_000),
      shutdown.signal,
    ]);
    const outcome = {
      fullyVerified: false,
      reasonCode: null as string | null,
      observedSteps: 0,
      verifiedCriteria: 0,
      observations: [] as unknown[],
    };
    let session: BrowserSession | null = null;
    let httpStatus: number | null = null;
    try {
      session = await this.browser.createSession({
        taskId: item.id,
        runId: item.id,
        projectId: item.project_id,
        sessionId: randomUUID(),
        mode: 'non_submitting',
        allowedOrigins: [origins[0]!],
        navigationTimeoutMs: 8000,
        defaultActionTimeoutMs: 5000,
        enableTrace: false,
      });
      const tools = async (call: ToolCall): Promise<BrowserSnapshot> => {
        if (deadline.aborted)
          throw new VerificationBlocked(
            shutdown.signal.aborted
              ? 'WORKER_SHUTDOWN'
              : 'VERIFICATION_TIMEOUT',
          );
        const receipt = await session!.executeTool(call, { signal: deadline });
        if (receipt.status !== 'succeeded')
          throw new VerificationBlocked(
            receipt.reasonCode === 'POLICY_DENIED'
              ? 'VERIFICATION_POLICY_DENIED'
              : receipt.reasonCode === 'TARGET_NOT_ALLOWED'
                ? 'VERIFICATION_TARGET_DENIED'
                : 'VERIFICATION_TOOL_FAILED',
          );
        return parseContract('BrowserSnapshot', receipt.data);
      };
      const observe = async () =>
        tools({
          name: 'observe',
          args: { pageId: session!.activePageId },
        });
      const criteria = new Map<string, Criterion>(
        document.criteria.map((c) => [c.id, c]),
      );
      const seen = new Set<string>();
      for (const step of steps) {
        if (deadline.aborted)
          throw new VerificationBlocked(
            shutdown.signal.aborted
              ? 'WORKER_SHUTDOWN'
              : 'VERIFICATION_TIMEOUT',
          );
        let snapshot: BrowserSnapshot;
        let criterionId: string | null = null;
        let criterionPassed: boolean | null = null;
        if (step.kind === 'navigate') {
          const target = new URL(step.url);
          if (
            target.origin !== origins[0] ||
            target.search ||
            target.hash ||
            target.username ||
            target.password
          )
            throw new VerificationBlocked('VERIFICATION_TARGET_DENIED');
          snapshot = await tools({
            name: 'navigate',
            args: { url: target.href },
          });
          httpStatus = snapshot.responseStatus;
        } else if (step.kind === 'click' || step.kind === 'type_text') {
          // The frozen locator is resolved only *before* the action. A DOM
          // snapshot that pre-dates a uniquely added control can be refreshed
          // at most twice. Never retry a dispatched browser click or typing.
          let target: NodeTarget;
          try {
            target = await resolveCandidateLocator(
              session,
              step.locator,
              deadline,
            );
          } catch (error) {
            throw new VerificationBlocked(
              error instanceof CandidateLocatorFailure
                ? error.code
                : 'VERIFICATION_LOCATOR_FAILED',
            );
          }
          snapshot = await tools(
            step.kind === 'click'
              ? { name: 'click', args: { target } }
              : { name: 'type_text', args: { target, text: step.text } },
          );
        } else if (step.kind === 'assert') {
          const criterion = criteria.get(step.criterionId);
          if (!criterion || seen.has(step.criterionId))
            throw new VerificationBlocked('VERIFICATION_CRITERION_MISMATCH');
          seen.add(criterion.id);
          criterionId = criterion.id;
          snapshot = await observe();
          if (!snapshot.redacted || snapshot.truncated)
            throw new VerificationBlocked('OBSERVATION_INCOMPLETE');
          let passed = false;
          if (
            criterion.kind === 'http_status' &&
            typeof criterion.expectedValue === 'number' &&
            httpStatus !== null
          )
            passed = httpStatus === criterion.expectedValue;
          else if (
            criterion.kind === 'url_matches' &&
            typeof criterion.expectedValue === 'string'
          )
            passed = snapshot.displayUrl === criterion.expectedValue;
          else if (
            (criterion.kind === 'element_visible' ||
              criterion.kind === 'text_equals') &&
            criterion.locator &&
            session.resolveRegressionLocator
          ) {
            let target: NodeTarget;
            try {
              target = await session.resolveRegressionLocator(
                criterion.locator,
                deadline,
              );
            } catch {
              throw new VerificationBlocked('OBSERVATION_INCOMPLETE');
            }
            const node = snapshot.nodes.find(
              (n) =>
                n.nodeId === target.nodeId &&
                n.frameId === (target.frameId ?? 'main'),
            );
            if (!node || target.snapshotId !== snapshot.snapshotId)
              throw new VerificationBlocked('OBSERVATION_INCOMPLETE');
            passed =
              criterion.kind === 'element_visible'
                ? node.visible
                : node.visible &&
                  typeof criterion.expectedValue === 'string' &&
                  node.text === criterion.expectedValue;
          } else {
            throw new VerificationBlocked('UNSUPPORTED_CRITERION');
          }
          outcome.verifiedCriteria++;
          criterionPassed = passed;
          outcome.observations.push({
            kind: step.kind,
            stepIndex: outcome.observedSteps,
            snapshotId: snapshot.snapshotId,
            snapshotDigest: hashPayload(snapshot),
            criterionId: criterion.id,
            passed,
            observedStatus: httpStatus,
          });
        } else {
          throw new VerificationBlocked('UNSUPPORTED_CANDIDATE_STEP');
        }
        if (!snapshot.redacted || snapshot.truncated)
          throw new VerificationBlocked('OBSERVATION_INCOMPLETE');
        if (Buffer.byteLength(JSON.stringify(snapshot)) > 240_000)
          throw new VerificationBlocked('EVIDENCE_TOO_LARGE');
        let screenshot: Buffer | null = null;
        if (step.kind === 'assert') {
          const page = session.getPageById?.(session.activePageId);
          if (!page) throw new VerificationBlocked('SCREENSHOT_UNAVAILABLE');
          try {
            screenshot = await page.screenshot({
              fullPage: false,
              animations: 'disabled',
              timeout: 4000,
              mask: [
                page.locator(
                  'input, textarea, select, [contenteditable], [data-sensitive], ' +
                    '[data-private], [data-pii], [data-secret], [data-mask], ' +
                    '[data-testid*="password" i], [data-testid*="secret" i], ' +
                    '[data-testid*="token" i], [data-testid*="account" i], ' +
                    '[data-testid*="email" i], [autocomplete]',
                ),
              ],
            });
          } catch {
            throw new VerificationBlocked('SCREENSHOT_UNAVAILABLE');
          }
          if (screenshot.length > 1_048_576)
            throw new VerificationBlocked('SCREENSHOT_TOO_LARGE');
        }
        evidence.push({
          id: randomUUID(),
          index: outcome.observedSteps,
          kind: step.kind,
          criterionId,
          passed: criterionPassed,
          snapshot,
          screenshot,
        });
        outcome.observedSteps++;
        if (criterionPassed === false)
          throw new VerificationBlocked('CRITERION_FAILED');
      }
      if (outcome.verifiedCriteria !== criteria.size || criteria.size === 0)
        throw new VerificationBlocked('UNVERIFIED_CRITERIA');
      outcome.fullyVerified = true;
      return outcome;
    } catch (error) {
      outcome.reasonCode = shutdown.signal.aborted
        ? 'WORKER_SHUTDOWN'
        : safeReason(error);
      return outcome;
    } finally {
      await session?.close().catch(() => {});
      if (this.activeAbort === shutdown) this.activeAbort = null;
    }
  }
}
