import type {
  Artifact,
  CriterionResult,
  HeartbeatResult,
  InputRequest,
  Lease,
  ToolCall,
  BrowserSnapshot,
} from '@localqa/contracts';
import {
  StorageError,
  type LeaseProof,
  type WorkerScope,
} from '@localqa/storage';
import type { CallRecord } from '@localqa/model-gateway';
import type { Coordinator, Work, ActionGrant } from './core.js';
import {
  BoundModel,
  type DecisionPayload,
  type ModelOptions,
  type AgentRoleName,
} from './model.js';
import { ArtifactStore } from './artifacts.js';

/** In-process internal service client. T06 must replace/bind it at verified service
 * identity boundary, never from an HTTP body/user cookie/model. Worker sees no DB/KEK. */
export class RuntimeClient {
  readonly #model: BoundModel;
  readonly #coordinator: Coordinator;
  readonly #scope: WorkerScope;
  readonly #artifacts: ArtifactStore;
  constructor(
    coordinator: Coordinator,
    scope: WorkerScope,
    artifacts: ArtifactStore,
    options: ModelOptions,
  ) {
    if (!scope.projectId || !scope.workerId || scope.workerId.length > 200)
      throw new StorageError('VALIDATION_ERROR');
    this.#coordinator = coordinator;
    this.#scope = Object.freeze({ ...scope });
    this.#artifacts = artifacts;
    this.#model = new BoundModel(coordinator, this.#scope, options);
  }
  claim(seconds = 45): Promise<Lease | null> {
    return this.#coordinator.claim(this.#scope, seconds);
  }
  work(proof: LeaseProof): Promise<Work> {
    return this.#coordinator.work(this.#scope, proof);
  }
  async heartbeat(proof: LeaseProof, seconds = 45): Promise<HeartbeatResult> {
    const heartbeat = await this.#coordinator.leases.heartbeat(
      this.#scope,
      proof,
      seconds,
    );
    return this.#coordinator.tx(async (client) => {
      const { run } = await this.#coordinator.validateLease(
        client,
        this.#scope,
        proof,
        true,
      );
      await this.#coordinator.pulse(client, this.#scope.projectId, run.id);
      return {
        ...heartbeat,
        cancelRequested:
          heartbeat.cancelRequested ||
          ['budget_limit', 'model_failure', 'setup_failure'].includes(
            run.terminationReason ?? '',
          ),
      };
    });
  }
  async requireAnonymousOrInput(proof: LeaseProof): Promise<boolean> {
    const configured = await this.#coordinator.tx(async (client) => {
      const { run } = await this.#coordinator.validateLease(
        client,
        this.#scope,
        proof,
      );
      return run.effectiveConfig.authProfileVersion !== null;
    });
    if (configured) {
      await this.#coordinator.waitForInput(
        this.#scope,
        proof,
        'auth_profile',
        'Configured authentication requires an approved adapter integration; refusing anonymous fallback',
      );
      return false;
    }
    return true;
  }
  model(
    proof: LeaseProof,
    role: AgentRoleName,
    payload: DecisionPayload,
    criterionId?: string,
    signal?: AbortSignal,
  ): Promise<CallRecord> {
    return this.#model.call(proof, role, payload, criterionId, signal);
  }
  grant(proof: LeaseProof, call: ToolCall): Promise<ActionGrant> {
    return this.#coordinator.grantAction(this.#scope, proof, call);
  }
  record(
    proof: LeaseProof,
    grant: ActionGrant,
    status: 'succeeded' | 'failed' | 'cancelled',
    snapshot: BrowserSnapshot | null,
    evidence: string[] = [],
  ): Promise<void> {
    return this.#coordinator.recordAction(
      this.#scope,
      proof,
      grant,
      status,
      snapshot,
      evidence,
    );
  }
  upload(
    proof: LeaseProof,
    artifact: Artifact,
    bytes: Uint8Array,
  ): Promise<Artifact> {
    return this.#artifacts.upload(
      this.#coordinator,
      this.#scope,
      proof,
      artifact,
      bytes,
    );
  }
  finish(
    proof: LeaseProof,
    result: Record<string, unknown>,
    results?: CriterionResult[],
    reason?: string,
  ): Promise<void> {
    return this.#coordinator.finish(
      this.#scope,
      proof,
      result,
      results,
      reason,
    );
  }
  stop(
    proof: LeaseProof,
    reason:
      'budget_limit' | 'worker_failure' | 'model_failure' | 'setup_failure',
  ): Promise<void> {
    return this.#coordinator.stopTask(this.#scope, proof, reason);
  }
  input(
    proof: LeaseProof,
    kind: InputRequest['kind'],
    prompt: string,
    expiresMs = 60000,
  ): Promise<InputRequest> {
    return this.#coordinator.waitForInput(
      this.#scope,
      proof,
      kind,
      prompt,
      expiresMs,
    );
  }
  poll(): Promise<void> {
    return this.#coordinator.tick(this.#scope.projectId);
  }
}
