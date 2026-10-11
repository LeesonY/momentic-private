import { readFile, realpath, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BrowserManager,
  type BrowserPort,
  type BrowserSession,
} from '@localqa/browser';
import {
  parseContract,
  type BrowserSnapshot,
  type ToolCall,
  type ModelMessage,
  type JsonValue,
  type Artifact,
} from '@localqa/contracts';
import { evaluateTechnical, PageGraph, DomainError } from '@localqa/domain';
import {
  RuntimeClient,
  DECISION_SCHEMA,
  type ActionGrant,
} from '@localqa/orchestrator';
import {
  createPolicyDispatcher,
  renderPrompt,
  renderAssertionPrompt,
  type AgentRole,
} from '@localqa/agents';
import type { AgentRoleName } from '@localqa/orchestrator';
import { StorageError, hashPayload, type LeaseProof } from '@localqa/storage';
import { replayRegression, type ReplayPorts } from './regression-replay.js';
import { createRegressionAiAction } from './regression-ai.js';
import { initializeBrowserAuthentication } from './auth-initialize-task.js';
import { withApprovedBrowserAuth } from './auth-import-task.js';
export { CandidateVerifier } from './candidate-verifier.js';

export interface WorkerOptions {
  runtime: RuntimeClient;
  browser: BrowserPort;
  scratch: string;
  pollMs?: number;
  heartbeatMs?: number;
  leaseSeconds?: number;
  onActionIntent?: (grant: ActionGrant) => Promise<void>;
  regressionAiAction?: ReplayPorts['aiAction'];
}
/** A Worker gets only an internal client and task-isolated BrowserPort, never DB/KEK. */
export class Worker {
  readonly runtime: RuntimeClient;
  readonly browser: BrowserPort;
  readonly scratch: string;
  readonly pollMs: number;
  readonly heartbeatMs: number;
  readonly leaseSeconds: number;
  constructor(private options: WorkerOptions) {
    this.runtime = options.runtime;
    this.browser = options.browser;
    this.scratch = resolve(options.scratch);
    this.pollMs = options.pollMs ?? 500;
    this.heartbeatMs = options.heartbeatMs ?? 1000;
    this.leaseSeconds = options.leaseSeconds ?? 45;
    if (
      this.pollMs < 1 ||
      this.pollMs > 1000 ||
      this.heartbeatMs < 1 ||
      this.heartbeatMs > 10000
    )
      throw new DomainError('VALIDATION_ERROR');
  }
  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        await this.runtime.poll();
        const executed = await this.once(signal);
        if (!executed)
          await delay(this.pollMs, undefined, { signal }).catch(() => {});
      }
    } finally {
      await this.browser.close();
    }
  }
  async once(parent?: AbortSignal): Promise<boolean> {
    if (parent?.aborted) return false;
    const lease = await this.runtime.claim(this.leaseSeconds);
    if (!lease) return false;
    const proof: LeaseProof = {
      taskId: lease.task.id,
      fencingToken: lease.fencingToken,
      leaseToken: lease.leaseToken,
      contextVersion: lease.contextVersion,
    };
    const controller = new AbortController();
    const signal = parent
      ? AbortSignal.any([parent, controller.signal])
      : controller.signal;
    let session: BrowserSession | null = null;
    let beating = false;
    let heartbeatFlight: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (beating) return;
      beating = true;
      heartbeatFlight = this.runtime
        .heartbeat(proof, this.leaseSeconds)
        .then((result) => {
          if (
            result.cancelRequested ||
            result.contextVersion !== proof.contextVersion
          )
            controller.abort('CANCEL_OR_CONTEXT_CHANGED');
        })
        .catch(() => controller.abort('LEASE_OR_BUDGET_STOP'))
        .finally(() => {
          beating = false;
        });
    }, this.heartbeatMs);
    try {
      const work = await this.runtime.work(proof);
      if (signal.aborted) throw new DomainError('CANCELLED');
      if (work.stage === 'preflight') {
        // Runs with a frozen non-anonymous auth profile enter a
        // dedicated server-authorized auth job after preflight. Do not
        // downgrade them to anonymous execution.
        const profile =
          work.run.effectiveConfig.authProfileVersion !== null
            ? await this.runtime.authProfile(proof)
            : null;
        const supportedAuth =
          profile !== null &&
          (profile.mode === 'form' ||
            (profile.mode === 'agent' && !!profile.agentConfig) ||
            (profile.mode === 'storage_state' && !!profile.storageCriterion));
        if (
          supportedAuth ||
          (await this.runtime.requireAnonymousOrInput(proof))
        ) {
          if (work.run.executionMode !== 'regression')
            await this.decide(
              proof,
              'coordinator',
              [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: 'Approved preflight config. DISPATCHED',
                    },
                  ],
                },
              ],
              signal,
            );
          await this.runtime.finish(proof, {
            stage: 'preflight',
            checked: true,
          });
        }
        return true;
      }
      if (work.stage === 'auth') {
        const profile = await this.runtime.authProfile(proof);
        if (
          !profile ||
          profile.mode === 'none' ||
          (work.run.executionMode !== 'smoke' &&
            work.run.executionMode !== 'regression') ||
          !(this.browser instanceof BrowserManager)
        )
          throw new DomainError('AUTH_FAILED');
        const outcome = await initializeBrowserAuthentication(
          {
            runtime: this.runtime,
            browser: this.browser,
            proof,
            profile,
            projectId: work.run.projectId,
            runId: work.run.id,
          },
          signal,
        );
        // finishAuth settles successful auth jobs itself. Ordinary finish()
        // explicitly refuses the auth stage and must never forge success.
        if (outcome.status !== 'succeeded')
          throw new DomainError('AUTH_FAILED');
        return true;
      }
      if (work.stage === 'plan') {
        await this.decide(
          proof,
          'planner',
          [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Keep the fixed sourced generic smoke baseline. DISPATCHED',
                },
              ],
            },
          ],
          signal,
        );
        await this.runtime.finish(proof, {
          stage: 'plan',
          baseline: 'generic_smoke',
          plannerAuthority: 'no tools, no binding IDs',
        });
        return true;
      }
      if (work.stage === 'finalize') {
        await this.runtime.finish(proof, {
          stage: 'finalize',
          cleanupStatus: 'unknown',
          warnings: ['rrweb/trace/report HTTP are not integrated by T05'],
        });
        return true;
      }
      if (work.stage === 'recover') {
        if (!work.definition) throw new DomainError('MISSING_CASE');
        const knownBlock =
          work.run.terminationReason === 'input_timeout'
            ? 'INPUT_TIMEOUT'
            : work.run.terminationReason === 'budget_limit'
              ? 'BUDGET_EXCEEDED'
              : work.run.terminationReason === 'model_failure'
                ? 'MODEL_FAILURE'
                : work.run.terminationReason === 'setup_failure'
                  ? 'SETUP_FAILURE'
                  : null;
        await this.runtime.finish(
          proof,
          { stage: 'recover', replayed: false },
          work.definition.criteria.map((c) => ({
            criterionId: c.id,
            result: knownBlock ? 'not_evaluated' : 'unknown',
            reason:
              knownBlock ??
              'Prior Worker interrupted; original action outcome is unknown',
            evidenceRefs: [],
          })),
          knownBlock ?? 'WORKER_INTERRUPTED',
        );
        return true;
      }
      // Server-frozen current state is imported under a private lease.
      // Without a state the old fail-closed anonymous gate still applies.
      if (
        !work.authStateId &&
        !(await this.runtime.requireAnonymousOrInput(proof))
      )
        return true;
      const directory = resolve(this.scratch, work.task.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // The login URL is part of the approved frozen auth profile, never
      // derived from model text or from the target's untrusted HTML.
      let approvedLoginPage: URL | null = null;
      let approvedLoginTestIds: readonly string[] | null = null;
      let intentionalLoginPage = false;
      const executeBrowserWork = async (): Promise<boolean> => {
        const cancel = () => {
          void session?.cancel('Runtime cancellation').catch(() => {});
          void session?.close().catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        let snapshot: BrowserSnapshot | null = null;
        let navigationStatus: number | null = null;
        // An imported auth state may expire at the target independently of
        // its encrypted storage lifetime. Do not treat 401/403 as a product
        // finding, a successful exploration or permission for AI decisions.
        let authResponseDenied = false;
        const graph = new PageGraph(work.run.effectiveConfig.budget);
        let depth = 0;
        const knownEvidenceIds = new Set<string>();
        const execute = async (
          call: ToolCall,
          regressionSource?: import('@localqa/orchestrator').CompiledRegressionStep['source'],
        ) => {
          if (signal.aborted) throw new DomainError('CANCELLED');
          if (authResponseDenied) throw new DomainError('AUTH_FAILED');
          let actual = call;
          if (call.name === 'observe')
            actual = {
              name: 'observe',
              args: { pageId: session!.activePageId },
            };
          if (call.name === 'capture')
            actual = {
              name: 'capture',
              args: {
                pageId: session!.activePageId,
                reason: 'Required owned evidence',
              },
            };
          if (
            work.stage === 'explore' &&
            call.name === 'navigate' &&
            graph.pages.length &&
            !graph.canNavigate(call.args.url, depth + 1)
          )
            throw new StorageError('BUDGET_EXCEEDED');
          const grant = await this.runtime.grant(
            proof,
            actual,
            regressionSource
              ? parseContract('RegressionStepSource', regressionSource)
              : undefined,
          );
          if (this.options.onActionIntent)
            await this.options.onActionIntent(grant);
          if (signal.aborted) {
            await this.runtime
              .record(proof, grant, 'cancelled', null)
              .catch(() => {});
            throw new DomainError('CANCELLED');
          }
          let result;
          try {
            result = await session!.executeTool(actual, { signal });
          } catch (error) {
            await this.runtime
              .record(proof, grant, 'failed', null)
              .catch(() => {});
            throw error;
          }
          if (result.status !== 'succeeded') {
            await this.runtime.record(
              proof,
              grant,
              result.status === 'cancelled' ? 'cancelled' : 'failed',
              null,
            );
            throw new DomainError(result.reasonCode ?? 'BROWSER_FAILED');
          }
          try {
            if (signal.aborted) throw new DomainError('CANCELLED');
            if (actual.name === 'capture') {
              const input = parseContract('Artifact', result.data);
              if (!input.contentUrl?.startsWith('file:'))
                throw new DomainError('ARTIFACT_BYTES_MISSING');
              const path = await realpath(fileURLToPath(input.contentUrl));
              const base = await realpath(directory);
              if (!path.startsWith(`${base}${sep}`))
                throw new DomainError('ARTIFACT_PATH_DENIED');
              const bytes = await readFile(path);
              const artifact = await this.runtime.upload(
                proof,
                {
                  ...input,
                  stepId: grant.step.id,
                  caseId: work.definition?.id ?? null,
                  snapshotId: regressionSource
                    ? (snapshot?.snapshotId ?? null)
                    : null,
                },
                bytes,
              );
              await this.runtime.record(proof, grant, 'succeeded', null, [
                artifact.id,
              ]);
              knownEvidenceIds.add(artifact.id);
              return artifact;
            }
            snapshot = parseContract('BrowserSnapshot', result.data);
            if (snapshot.snapshotId) knownEvidenceIds.add(snapshot.snapshotId);
            if (work.authStateId && approvedLoginPage) {
              // Many applications redirect to a 200 login page when a
              // session expires. Match only the frozen login origin + path
              // (not a generic title/text heuristic). Intentional visits
              // to that exact URL are not treated as session expiry.
              try {
                const arrived = new URL(snapshot.displayUrl);
                const requested =
                  actual.name === 'navigate' ? new URL(actual.args.url) : null;
                const matches = (value: URL) =>
                  value.origin === approvedLoginPage!.origin &&
                  value.pathname === approvedLoginPage!.pathname;
                if (requested) intentionalLoginPage = matches(requested);
                if (matches(arrived) && !intentionalLoginPage)
                  authResponseDenied = true;
              } catch {
                // A malformed/blank display URL cannot prove this redirect.
                // Standard origin, action and response checks still apply.
              }
              if (
                !intentionalLoginPage &&
                approvedLoginTestIds &&
                snapshot.redacted &&
                !snapshot.truncated &&
                approvedLoginTestIds.every((testId) =>
                  snapshot!.nodes.some(
                    (node) =>
                      node.frameId === 'main' &&
                      node.nodeId === `testid_${testId}` &&
                      node.visible,
                  ),
                )
              )
                authResponseDenied = true;
            }
            if (actual.name === 'navigate') {
              navigationStatus = snapshot.responseStatus;
              // Explicitly approved RBAC regression cases may deliberately
              // assert a 401/403. Never turn that sourced HTTP oracle into
              // an auth-infrastructure failure.
              const expectedDeny =
                work.run.executionMode === 'regression' &&
                work.definition?.criteria.some(
                  (criterion) =>
                    criterion.kind === 'http_status' &&
                    criterion.sourceKind === 'user_spec' &&
                    criterion.expectedValue === navigationStatus,
                );
              if (
                work.authStateId &&
                (navigationStatus === 401 || navigationStatus === 403) &&
                !expectedDeny
              )
                authResponseDenied = true;
              if (work.stage === 'explore') {
                if (graph.pages.length) depth++;
                graph.visit(actual.args.url, depth, snapshot);
              }
            }
            await this.runtime.record(proof, grant, 'succeeded', snapshot);
            return snapshot;
          } catch (error) {
            // A completed browser call with unusable evidence has an uncertain
            // outcome; charge it conservatively and close its pending Step.
            await this.runtime
              .record(proof, grant, 'unknown', null)
              .catch(() => {});
            throw error;
          }
        };
        if (work.run.executionMode === 'regression') {
          if (!work.definition || !work.regressionPlan)
            throw new DomainError('MISSING_CASE');
          const replay = await replayRegression(
            work.regressionPlan.steps,
            {
              executeTool: async (call, source) => {
                const data = await execute(call, source);
                if (authResponseDenied) throw new DomainError('AUTH_FAILED');
                return {
                  status: 'succeeded',
                  data: data as unknown as JsonValue,
                };
              },
              resolveTarget: async (locator, source) => {
                await execute({ name: 'observe', args: {} }, source);
                if (!session!.resolveRegressionLocator)
                  throw new DomainError('LOCATOR_UNSUPPORTED');
                const cacheable =
                  locator.by === 'role' &&
                  typeof locator.name === 'string' &&
                  locator.name.length > 0 &&
                  locator.name.length <= 120 &&
                  locator.value.length <= 80;
                if (!cacheable)
                  return session!.resolveRegressionLocator(locator, signal);
                const cacheSource = parseContract('RegressionStepSource', {
                  ...source,
                  modulePath: [...source.modulePath],
                });
                // A cached hint NEVER reuses an old node target. It only
                // identifies a semantic role/name to locate again in the
                // newly recorded and policy-authorized browser snapshot.
                const fresh = snapshot!;
                const hint = await this.runtime.lookupRegressionLocator(
                  proof,
                  cacheSource,
                  locator,
                  fresh.displayUrl,
                );
                const outcome: 'miss' | 'hit' | 'invalidated' = hint
                  ? 'invalidated'
                  : 'miss';
                if (
                  hint &&
                  fresh?.redacted &&
                  session!.resolveCachedRegressionLocator
                ) {
                  const candidates = fresh.nodes.filter(
                    (node) =>
                      node.visible &&
                      node.enabled &&
                      node.frameId === 'main' &&
                      node.role === locator.value &&
                      node.name === locator.name,
                  );
                  if (candidates.length === 1) {
                    const node = candidates[0]!;
                    const target = parseContract('NodeTarget', {
                      pageId: fresh.pageId,
                      snapshotId: fresh.snapshotId,
                      nodeId: node.nodeId,
                      frameId: node.frameId,
                    });
                    const verified =
                      await session!.resolveCachedRegressionLocator(
                        locator,
                        target,
                        signal,
                      );
                    if (verified) {
                      await this.runtime.recordRegressionLocator(
                        proof,
                        cacheSource,
                        locator,
                        fresh.displayUrl,
                        'hit',
                        false,
                      );
                      return verified;
                    }
                  }
                }
                // Live ambiguity, redaction gaps or a moved element invalidate
                // the hint before falling back to the frozen original locator.
                let target: import('@localqa/contracts').NodeTarget;
                try {
                  target = await session!.resolveRegressionLocator(
                    locator,
                    signal,
                  );
                } catch (error) {
                  await this.runtime.recordRegressionLocator(
                    proof,
                    cacheSource,
                    locator,
                    fresh.displayUrl,
                    outcome,
                    false,
                  );
                  throw error;
                }
                const node = fresh.nodes.find(
                  (item) =>
                    item.nodeId === target.nodeId &&
                    item.frameId === (target.frameId ?? 'main'),
                );
                await this.runtime.recordRegressionLocator(
                  proof,
                  cacheSource,
                  locator,
                  fresh.displayUrl,
                  outcome,
                  !!node &&
                    node.visible &&
                    node.enabled &&
                    node.role === locator.value &&
                    node.name === locator.name &&
                    target.snapshotId === fresh.snapshotId,
                );
                return target;
              },
              evaluateCriterion: async (criterion, source) => {
                await execute({ name: 'observe', args: {} }, source);
                const current = snapshot!;
                let ownedNode:
                  import('@localqa/contracts').SnapshotNode | undefined;
                if (criterion.locator && session!.resolveRegressionLocator) {
                  try {
                    const target = await session!.resolveRegressionLocator(
                      criterion.locator,
                      signal,
                    );
                    const fresh = await session!.getSnapshot();
                    if (
                      fresh.snapshotId === current.snapshotId &&
                      target.snapshotId === current.snapshotId &&
                      target.pageId === current.pageId
                    )
                      ownedNode = current.nodes.find(
                        (node) =>
                          node.nodeId === target.nodeId &&
                          node.frameId === (target.frameId ?? 'main'),
                      );
                  } catch {
                    /* Missing/ambiguous/unowned observation is never a pass. */
                  }
                }
                const captured = (await execute(
                  {
                    name: 'capture',
                    args: {
                      pageId: session!.activePageId,
                      reason: 'Frozen criterion evidence',
                    },
                  },
                  source,
                )) as Artifact;
                const evidence = [captured.id];
                let evaluated: import('@localqa/contracts').CriterionResult = {
                  criterionId: criterion.id,
                  result: 'unknown',
                  reason: 'Unsupported oracle',
                  evidenceRefs: evidence,
                };
                const origin =
                  work
                    .regressionPlan!.steps.find(
                      (entry) =>
                        hashPayload(entry.source) === hashPayload(source),
                    )
                    ?.originCriteria?.find(
                      (item) => item.id === criterion.id,
                    ) ?? criterion;
                const expected = origin.expectedValue;
                const baselineHttp =
                  origin.sourceKind === 'generic_smoke' &&
                  criterion.kind === 'http_status' &&
                  expected !== null &&
                  typeof expected === 'object' &&
                  !Array.isArray(expected) &&
                  Object.keys(expected).length === 2 &&
                  expected['min'] === 200 &&
                  expected['max'] === 399;
                const baselineVisible =
                  origin.sourceKind === 'generic_smoke' &&
                  criterion.kind === 'element_visible' &&
                  criterion.locator?.by === 'css' &&
                  criterion.locator.value === 'body' &&
                  expected === undefined;
                if (baselineHttp || baselineVisible) {
                  evaluated = evaluateTechnical(
                    { ...work.definition!, criteria: [origin] },
                    current,
                    current.responseStatus,
                    evidence,
                  )[0]!;
                } else if (
                  criterion.kind === 'semantic' ||
                  criterion.kind === 'visual'
                ) {
                  if (
                    !current.redacted ||
                    (criterion.kind === 'semantic' &&
                      !current.nodes.some(
                        (node) => node.visible && node.text.trim().length > 0,
                      ))
                  )
                    return parseContract('CriterionResult', {
                      ...evaluated,
                      reason:
                        'Approved observation text missing; no model pass',
                    });
                  const assertion = await this.runtime.model(
                    proof,
                    'assertion',
                    {
                      purpose: 'assert',
                      messages: [
                        {
                          role: 'system',
                          content: [
                            {
                              type: 'text',
                              text: renderAssertionPrompt().text,
                            },
                          ],
                        },
                        {
                          role: 'user',
                          content: [
                            {
                              type: 'text',
                              text: JSON.stringify({
                                criterion,
                                observation: current,
                                ownedEvidence: evidence,
                              }),
                            },
                            ...(criterion.kind === 'visual'
                              ? [
                                  {
                                    type: 'image' as const,
                                    artifactId: captured.id,
                                  },
                                ]
                              : []),
                          ],
                        },
                      ],
                      outputSchema: { type: 'object' },
                      maxOutputTokens: 200,
                    },
                    criterion.id,
                    signal,
                  );
                  const assessment = assertion.assessment;
                  if (
                    assertion.errorCode === null &&
                    assessment?.criterionId === criterion.id &&
                    assessment.criterionResult &&
                    assessment.acceptedEvidenceRefs.length > 0 &&
                    assessment.acceptedEvidenceRefs.every(
                      (id) => knownEvidenceIds.has(id) && evidence.includes(id),
                    )
                  )
                    evaluated = {
                      criterionId: criterion.id,
                      result: assessment.criterionResult,
                      reason: assessment.reasonCode,
                      evidenceRefs: assessment.acceptedEvidenceRefs,
                    };
                } else if (
                  criterion.kind === 'http_status' &&
                  typeof criterion.expectedValue === 'number' &&
                  current.responseStatus !== null
                )
                  evaluated = {
                    ...evaluated,
                    result:
                      current.responseStatus === criterion.expectedValue
                        ? 'passed'
                        : 'failed',
                    reason: 'Observed HTTP status',
                  };
                else if (
                  criterion.kind === 'url_matches' &&
                  typeof criterion.expectedValue === 'string'
                )
                  evaluated = {
                    ...evaluated,
                    result:
                      current.displayUrl === criterion.expectedValue
                        ? 'passed'
                        : 'failed',
                    reason: 'Observed exact URL',
                  };
                else if (ownedNode) {
                  if (criterion.kind === 'element_visible')
                    evaluated = {
                      ...evaluated,
                      result: ownedNode.visible ? 'passed' : 'failed',
                      reason: 'Unique owned visible DOM target',
                    };
                  else if (
                    criterion.kind === 'text_equals' &&
                    typeof criterion.expectedValue === 'string'
                  )
                    evaluated = {
                      ...evaluated,
                      result:
                        ownedNode.text === criterion.expectedValue
                          ? 'passed'
                          : 'failed',
                      reason: 'Owned DOM text compared exactly',
                    };
                } else if (
                  criterion.kind === 'element_visible' &&
                  criterion.locator?.by === 'test_id' &&
                  current.redacted &&
                  !current.truncated &&
                  (current.responseStatus ?? navigationStatus) !== null &&
                  (current.responseStatus ?? navigationStatus)! >= 200 &&
                  (current.responseStatus ?? navigationStatus)! < 400 &&
                  !current.nodes.some(
                    (node) =>
                      node.nodeId === `testid_${criterion.locator!.value}` &&
                      node.visible,
                  )
                ) {
                  // A complete, healthy DOM snapshot can prove that a frozen
                  // expected test-id is absent. Do not downgrade this to an
                  // unknown oracle, nor interpret 5xx/error pages as evidence.
                  evaluated = {
                    ...evaluated,
                    result: 'failed',
                    reason:
                      'Frozen expected test-id absent from complete healthy DOM',
                  };
                }
                return parseContract('CriterionResult', evaluated);
              },
              aiAction:
                this.options.regressionAiAction ??
                createRegressionAiAction({
                  role: work.task.role as AgentRole,
                  decide: (messages, actionSignal) =>
                    this.decide(
                      proof,
                      work.task.role as AgentRoleName,
                      messages,
                      actionSignal,
                      true,
                    ),
                  observation: () => snapshot,
                  evidence: () => Array.from(knownEvidenceIds),
                }),
            },
            signal,
          );
          // replayRegression reports ordinary frozen-criterion failures.
          // Authentication rejection is an infrastructure/setup failure,
          // never an independently reproducible application Finding.
          if (authResponseDenied) throw new DomainError('AUTH_FAILED');
          const observed = new Map(
            replay.steps
              .flatMap((step) => step.criterionResults)
              .map((result) => [result.criterionId, result]),
          );
          const results = work.definition.criteria.map(
            (criterion) =>
              observed.get(criterion.id) ?? {
                criterionId: criterion.id,
                result: 'not_evaluated' as const,
                reason:
                  replay.reasonCode ??
                  'DSL did not evaluate this frozen criterion',
                evidenceRefs: [],
              },
          );
          if (signal.aborted || replay.reasonCode === 'LEASE_EXPIRED')
            throw new DomainError('CANCELLED');
          await this.runtime.finish(
            proof,
            {
              stage: work.stage,
              regressionReplay: replay,
              sourceVersionId: work.definition.regression!.sourceVersionId,
              sourceDocumentSha256:
                work.definition.regression!.sourceDocumentSha256,
            },
            results,
            replay.reasonCode ?? undefined,
          );
          return true;
        }
        await execute({ name: 'navigate', args: { url: work.targetUrl } });
        if (authResponseDenied) throw new DomainError('AUTH_FAILED');
        // A target outage is an infrastructure observation, not a model
        // exploration opportunity. In executor/reproducer phases, an
        // HTTP 5xx/401/403 response must be evaluated by the fixed
        // technical oracle without asking an LLM to act on its error page.
        // This also avoids converting a safe blocked reproduction into a
        // Worker interruption when the LLM response fails on a 503 page.
        const unavailableTarget =
          work.stage !== 'explore' &&
          navigationStatus !== null &&
          (navigationStatus >= 500 ||
            navigationStatus === 401 ||
            navigationStatus === 403);
        const role = work.task.role as AgentRole;
        const dispatcher = createPolicyDispatcher(
          async (call) => execute(call) as unknown as JsonValue,
        );
        let messages: ModelMessage[] = [
          {
            role: 'user',
            content: [
              { type: 'text', text: JSON.stringify({ observation: snapshot }) },
            ],
          },
        ];
        let modelActionDenials = 0;
        for (let round = 0; round < (unavailableTarget ? 0 : 4); round++) {
          const decision = await this.decide(proof, role, messages, signal);
          if (
            decision.requestResult !== 'ok' &&
            decision.requestResult !== 'repaired'
          )
            throw new DomainError('MODEL_FAILURE');
          const data = decision.data as { done: boolean; toolCalls: unknown[] };
          if (data.done || !data.toolCalls.length) break;
          for (const call of data.toolCalls) {
            const dispatch = await dispatcher.dispatch({
              role,
              call,
              knownEvidenceIds: Array.from(knownEvidenceIds),
            });
            if (authResponseDenied) throw new DomainError('AUTH_FAILED');
            if (work.authStateId && dispatch.reasonCode === 'AUTH_FAILED')
              throw new DomainError('AUTH_FAILED');
            const executed = dispatch.status === 'succeeded';
            if (!executed) {
              modelActionDenials++;
              messages = [
                ...messages,
                {
                  role: 'tool',
                  content: [
                    {
                      type: 'text',
                      text: `DISPATCHED ${JSON.stringify({ executed: false, reasonCode: dispatch.reasonCode ?? 'POLICY_DENIED' })}`,
                    },
                  ],
                },
              ];
              break;
            }
            messages = [
              ...messages,
              {
                role: 'tool',
                content: [
                  {
                    type: 'text',
                    text: `DISPATCHED ${JSON.stringify({ executed: true, action: (call as ToolCall).name })}`,
                  },
                ],
              },
            ];
          }
        }
        if (!snapshot) throw new DomainError('NO_OBSERVATION');
        if (work.stage === 'explore') {
          await this.runtime.finish(proof, {
            stage: 'explore',
            pages: graph.pages,
            coverage: 'Only observed in-scope pages, not the whole site',
            modelActionDenials,
            ...(modelActionDenials
              ? {
                  warnings: [
                    'Proposed model actions were denied by active run policy',
                  ],
                }
              : {}),
          });
          return true;
        }
        if (!work.definition) throw new DomainError('MISSING_CASE');
        const captured = (await execute({
          name: 'capture',
          args: { pageId: session!.activePageId, reason: 'Case evidence' },
        })) as Artifact;
        const results = evaluateTechnical(
          work.definition,
          snapshot,
          navigationStatus,
          [captured.id],
        );
        // An unavailable/unauthorized target response is not an observation
        // of the application's expected DOM. In particular, a reproducer
        // must never reconfirm a "missing success marker" based only on a
        // transient 503 error page. Explicit HTTP status checks remain valid.
        if (
          navigationStatus !== null &&
          (navigationStatus >= 500 ||
            navigationStatus === 401 ||
            navigationStatus === 403)
        ) {
          for (const criterion of work.definition.criteria) {
            if (criterion.kind === 'http_status') continue;
            const index = results.findIndex(
              (r) => r.criterionId === criterion.id,
            );
            if (index !== -1)
              results[index] = parseContract('CriterionResult', {
                criterionId: criterion.id,
                result: 'not_evaluated',
                reason:
                  'Target response unavailable; DOM oracle cannot establish feature behavior',
                evidenceRefs: [captured.id],
              });
          }
        }
        // T04's fixed assertion stub has static evidence IDs. Its references are assessed,
        // never rebound/forged. A deterministic technical oracle supplies supported criteria.
        const criterion =
          work.definition.criteria.find((c) => c.id === 'smoke.visible') ??
          work.definition.criteria[0]!;
        const assertion = unavailableTarget
          ? null
          : await this.runtime.model(
              proof,
              'assertion',
              {
                purpose: 'assert',
                messages: [
                  {
                    role: 'system',
                    content: [
                      { type: 'text', text: renderAssertionPrompt().text },
                    ],
                  },
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify({
                          criterion,
                          ownedEvidence: [captured.id],
                        }),
                      },
                    ],
                  },
                ],
                outputSchema: { type: 'object' },
                maxOutputTokens: 200,
              },
              criterion.id,
              signal,
            );
        await this.runtime.finish(
          proof,
          {
            stage: work.stage,
            assertionAssessment: assertion?.assessment ?? null,
            oracle: 'fixed_technical',
            ...(unavailableTarget
              ? { modelSkippedReason: 'TARGET_RESPONSE_UNAVAILABLE' }
              : {}),
            contextId: session!.id,
          },
          results,
        );
        return true;
      };
      if (work.authStateId) {
        const profile = await this.runtime.authProfile(proof);
        if (!profile || !(this.browser instanceof BrowserManager))
          throw new DomainError('AUTH_FAILED');
        if (profile.mode === 'form' && profile.formConfig) {
          approvedLoginPage = new URL(profile.formConfig.loginUrl);
          const { usernameTarget, passwordTarget } = profile.formConfig;
          if (
            usernameTarget?.by === 'test_id' &&
            passwordTarget?.by === 'test_id' &&
            usernameTarget.value !== passwordTarget.value
          )
            approvedLoginTestIds = [usernameTarget.value, passwordTarget.value];
        } else if (profile.mode === 'agent' && profile.agentConfig?.loginUrl) {
          approvedLoginPage = new URL(profile.agentConfig.loginUrl);
        }
        const outcome = await withApprovedBrowserAuth(
          {
            client: this.runtime,
            browser: this.browser,
            proof,
            profile,
            authStateId: work.authStateId,
            allowedOrigins: work.run.effectiveConfig.allowedOrigins,
            artifactsDir: directory,
            navigationTimeoutMs: 5000,
            onAuthenticated: async (authorized) => {
              session = authorized;
              await executeBrowserWork();
            },
          },
          signal,
        );
        if (outcome.status !== 'imported') throw new DomainError('AUTH_FAILED');
        return true;
      }
      session = await this.browser.createSession({
        sessionId: work.contextId,
        taskId: work.task.id,
        projectId: work.run.projectId,
        runId: work.run.id,
        allowedOrigins: work.run.effectiveConfig.allowedOrigins,
        mode: 'non_submitting',
        artifactsDir: directory,
        enableTrace: false,
        navigationTimeoutMs: 5000,
      });
      // Await work before entering finally. Returning the unresolved promise
      // closes the Chromium Session while replayRegression is still acting,
      // turning a legitimate navigation into "BrowserSession is closed".
      return await executeBrowserWork();
    } catch (error) {
      const code =
        error instanceof StorageError || error instanceof DomainError
          ? error.code
          : 'WORKER_FAILURE';
      const reason =
        code === 'BUDGET_EXCEEDED'
          ? 'budget_limit'
          : [
                'MODEL_FAILURE',
                'MODEL_VALIDATION_FAILED',
                'MODEL_INVALID_JSON',
                'MODEL_SCHEMA_MISMATCH',
                'MODEL_TOOL_CONTRACT_INVALID',
                'MODEL_OUTPUT_TRUNCATED',
                'MODEL_TIMEOUT',
                'MODEL_BILLING_REQUIRED',
                'MODEL_NOT_CONFIGURED',
                'MODEL_CAPABILITY_MISSING',
                'SERVICE_UNAVAILABLE',
                'RATE_LIMITED',
              ].includes(code)
            ? 'model_failure'
            : code === 'LEASE_EXPIRED' || code === 'CANCELLED'
              ? 'worker_failure'
              : 'setup_failure';
      await this.runtime.stop(proof, reason).catch(() => {});
      return true;
    } finally {
      clearInterval(timer);
      if (heartbeatFlight) await heartbeatFlight;
      await session?.close().catch(() => {});
    }
  }
  async decide(
    proof: LeaseProof,
    role: AgentRoleName,
    messages: ModelMessage[],
    signal: AbortSignal,
    returnFailureRecord = false,
  ) {
    if (signal.aborted) throw new DomainError('CANCELLED');
    if (returnFailureRecord && role !== 'executor' && role !== 'reproducer')
      throw new DomainError('VALIDATION_ERROR');
    const prompt =
      role === 'assertion' ? renderAssertionPrompt() : renderPrompt(role);
    const record = await this.runtime.model(
      proof,
      role,
      {
        purpose: role === 'planner' ? 'plan' : 'decide',
        messages: [
          { role: 'system', content: [{ type: 'text', text: prompt.text }] },
          ...messages,
        ],
        outputSchema: DECISION_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 400,
      },
      undefined,
      signal,
    );
    if (signal.aborted) throw new DomainError('CANCELLED');
    // Regression ai_action needs the structured, redacted requestResult and
    // errorCode for a truthful frozen replay reason. All other paths retain
    // their original fail-closed behavior.
    if (
      !returnFailureRecord &&
      !['ok', 'repaired'].includes(record.requestResult)
    )
      throw new DomainError('MODEL_FAILURE');
    return record;
  }
}
