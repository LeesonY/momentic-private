import { parseContract } from '@localqa/contracts';
import type {
  ToolCall,
  NodeTarget,
  Locator,
  Criterion,
  CriterionResult,
  JsonValue,
} from '@localqa/contracts';
import type { CompiledRegressionStep } from '@localqa/orchestrator';

type Source = CompiledRegressionStep['source'];
type Status =
  'completed' | 'failed' | 'inconclusive' | 'cancelled' | 'unsupported';
// Local port receipt, not a wire protocol. Root must adapt the existing execute
// closure: resolve only after grant + browser execution + record have succeeded.
export interface ReplayToolReceipt {
  status: 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  reasonCode?: string;
  data?: JsonValue;
}
export interface ReplayPorts {
  resolveTarget: (
    locator: Locator,
    source: Source,
    signal: AbortSignal,
  ) => Promise<NodeTarget>;
  executeTool: (
    call: ToolCall,
    source: Source,
    signal: AbortSignal,
  ) => Promise<ReplayToolReceipt>;
  evaluateCriterion: (
    criterion: Criterion,
    source: Source,
    signal: AbortSignal,
  ) => Promise<CriterionResult>;
  aiAction?: (input: {
    goal: string;
    maxToolCalls?: number;
    minToolCalls?: number;
    requiredToolSequence?: readonly ToolCall['name'][];
    criteria: readonly Criterion[];
    source: Source;
    signal: AbortSignal;
    executeTool: (call: ToolCall) => Promise<ReplayToolReceipt>;
  }) => Promise<void>;
}
export interface ReplayStepRecord {
  compiled: CompiledRegressionStep;
  status: Status;
  reasonCode: string | null;
  tools: { call: ToolCall; receipt: ReplayToolReceipt | null }[];
  criterionResults: CriterionResult[];
}
export interface RegressionReplayResult {
  status: Status;
  reasonCode: string | null;
  steps: readonly ReplayStepRecord[];
}
class Stop extends Error {
  constructor(
    readonly status: Status,
    readonly code: string,
  ) {
    super(code);
  }
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
// Preserve machine codes, never arbitrary exception text (may contain secrets).
function failure(error: unknown): Stop {
  if (error instanceof Stop) return error;
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  return new Stop(
    'failed',
    typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
      ? code
      : 'REPLAY_PORT_ERROR',
  );
}

/** Deterministic replay over injected ports only. No browser/model/DB access.
 * Local adapter success is NOT proof of runtime budget or fencing authorization.
 */
export async function replayRegression(
  compiled: readonly CompiledRegressionStep[],
  ports: ReplayPorts,
  signal: AbortSignal,
): Promise<RegressionReplayResult> {
  const plan = freeze(copy(compiled));
  const records: ReplayStepRecord[] = [];
  let stopped: Stop | undefined;
  function check(): void {
    if (signal.aborted) throw new Stop('cancelled', 'CANCELLED');
    if (stopped) throw stopped;
  }
  function result(
    status: Status,
    reasonCode: string | null,
  ): RegressionReplayResult {
    return freeze({ status, reasonCode, steps: records });
  }
  for (const item of plan) {
    try {
      check();
    } catch (error) {
      const stop = signal.aborted
        ? new Stop('cancelled', 'CANCELLED')
        : failure(error);
      return result(stop.status, stop.code);
    }
    const record: ReplayStepRecord = {
      compiled: item,
      status: 'completed',
      reasonCode: null,
      tools: [],
      criterionResults: [],
    };
    records.push(record);
    // All AI and fixed actions use this exact guarded port. A swallowed AI
    // exception remains sticky and cannot permit later calls/steps.
    let pending = false;
    let activeStep = true;
    const calls: Promise<ReplayToolReceipt>[] = [];
    const invoke = async (call: ToolCall): Promise<ReplayToolReceipt> => {
      let ownsPending = false;
      try {
        check();
        if (!activeStep) throw new Stop('failed', 'AI_STEP_CLOSED');
        if (pending) throw new Stop('failed', 'CONCURRENT_AI_TOOL');
        const actual = freeze(copy(parseContract('ToolCall', call)));
        const entry = {
          call: actual,
          receipt: null as ReplayToolReceipt | null,
        };
        record.tools.push(entry);
        pending = true;
        ownsPending = true;
        const receipt = await ports.executeTool(actual, item.source, signal);
        entry.receipt = copy(receipt);
        check();
        if (!receipt || receipt.status !== 'succeeded') {
          const status =
            receipt?.status === 'cancelled'
              ? 'cancelled'
              : receipt?.status === 'failed'
                ? 'failed'
                : 'inconclusive';
          throw new Stop(
            status,
            receipt?.reasonCode &&
              /^[A-Z][A-Z0-9_]{0,63}$/.test(receipt.reasonCode)
              ? receipt.reasonCode
              : 'TOOL_NOT_SUCCEEDED',
          );
        }
        return freeze(copy(receipt));
      } catch (error) {
        stopped = signal.aborted
          ? new Stop('cancelled', 'CANCELLED')
          : failure(error);
        throw stopped;
      } finally {
        if (ownsPending) pending = false;
      }
    };
    const execute = (call: ToolCall): Promise<ReplayToolReceipt> => {
      const promise = invoke(call);
      calls.push(promise);
      // Observe adapter-forgotten promises; their failure is also sticky.
      void promise.catch(() => undefined);
      return promise;
    };
    async function evaluate(): Promise<void> {
      const ids =
        item.step.kind === 'assert'
          ? [item.step.criterionId]
          : item.step.kind === 'ai_action'
            ? item.step.criteriaIds
            : [];
      for (const id of ids) {
        check();
        const criterion = item.criteria.find(
          (candidate) => candidate.id === id,
        );
        if (!criterion) throw new Stop('failed', 'MISSING_FROZEN_CRITERION');
        const evaluated = copy(
          parseContract(
            'CriterionResult',
            await ports.evaluateCriterion(criterion, item.source, signal),
          ),
        );
        if (evaluated.criterionId !== id)
          throw new Stop('failed', 'CRITERION_ID_MISMATCH');
        record.criterionResults.push(evaluated);
        check();
        if (evaluated.result !== 'passed')
          throw new Stop(
            evaluated.result === 'failed' ? 'failed' : 'inconclusive',
            'CRITERION_NOT_PASSED',
          );
      }
    }
    try {
      const step = parseContract('ReplayStep', item.step);
      if (step.kind === 'navigate')
        await execute({ name: 'navigate', args: { url: step.url } });
      else if (step.kind === 'click' || step.kind === 'type_text') {
        const target = parseContract(
          'NodeTarget',
          await ports.resolveTarget(step.locator, item.source, signal),
        );
        check();
        await execute(
          step.kind === 'click'
            ? { name: 'click', args: { target } }
            : { name: 'type_text', args: { target, text: step.text } },
        );
      } else if (step.kind === 'assert') await evaluate();
      else if (step.kind === 'ai_action') {
        if (!ports.aiAction)
          throw new Stop('unsupported', 'AI_ADAPTER_REQUIRED');
        await ports.aiAction({
          goal: step.goal,
          ...(step.maxToolCalls ? { maxToolCalls: step.maxToolCalls } : {}),
          ...(step.minToolCalls ? { minToolCalls: step.minToolCalls } : {}),
          ...(step.requiredToolSequence
            ? { requiredToolSequence: step.requiredToolSequence }
            : {}),
          criteria: item.criteria,
          source: item.source,
          signal,
          executeTool: execute,
        });
        // Revoke the capability before post-action evaluation. Escaped adapter
        // callbacks may not race assertions or a subsequent DSL step.
        activeStep = false;
        check();
        if (pending) {
          stopped = new Stop('failed', 'AI_TOOL_NOT_AWAITED');
          await Promise.allSettled(calls);
          throw stopped;
        }
        await evaluate();
      } else throw new Stop('unsupported', 'UNEXPANDED_MODULE');
      check();
      activeStep = false;
    } catch (error) {
      activeStep = false;
      stopped ??= failure(error);
      await Promise.allSettled(calls);
      const stop = signal.aborted
        ? new Stop('cancelled', 'CANCELLED')
        : (stopped ?? failure(error));
      record.status = stop.status;
      record.reasonCode = stop.code;
      return result(stop.status, stop.code);
    }
  }
  return result('completed', null);
}
