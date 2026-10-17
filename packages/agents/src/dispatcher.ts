import { randomUUID } from 'node:crypto';
import {
  getRootValidator,
  getToolResultValidator,
  isActionDenialCode,
  parseContract,
  type JsonValue,
  type ToolCall,
  type ToolResult,
} from '@localqa/contracts';
import { toolsForRole, type AgentRole } from './prompts.js';

export interface DispatchRequest {
  role: AgentRole;
  call: unknown;
  knownEvidenceIds: readonly string[];
}

export interface Dispatcher {
  dispatch(input: DispatchRequest): Promise<ToolResult>;
}

function denied(reasonCode: string): ToolResult {
  return parseContract('ToolResult', {
    requestId: randomUUID(),
    actionId: null,
    status: 'denied',
    data: null,
    reasonCode,
    evidenceRefs: [],
  });
}

function unknownEvidence(call: unknown, known: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const walk = (value: unknown, key: string | null): void => {
    if (key === 'evidenceRefs' && Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && !known.has(item)) found.push(item);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      if (
        childKey === 'artifactId' &&
        typeof child === 'string' &&
        !known.has(child)
      ) {
        found.push(child);
      } else {
        walk(child, childKey);
      }
    }
  };
  walk(call, null);
  return found;
}

/**
 * Policy dispatcher. Browser execution is injected.
 * This module does not import Playwright.
 * A denied result is a ToolResult: the action is not treated as success.
 */
export function createPolicyDispatcher(
  execute: (call: ToolCall) => Promise<JsonValue>,
): Dispatcher {
  const validator = getRootValidator('tools');
  return {
    async dispatch(input) {
      if (!validator(input.call)) return denied('VALIDATION_ERROR');
      const call = input.call;
      const allowed = toolsForRole(input.role);
      if (!allowed.includes(call.name)) return denied('POLICY_DENIED');
      const known = new Set(input.knownEvidenceIds);
      // Cited evidence that is not already known is not one of the §7.1 codes.
      // The action is not executed; §7 classifies that as POLICY_DENIED.
      if (unknownEvidence(call, known).length > 0)
        return denied('POLICY_DENIED');
      // 重复动作限制由浏览器执行层负责（docs/02 §5.3：相同动作与页面指纹重复三次
      // 停止该用例，见 packages/browser/src/waiter.ts）。Dispatcher 不重复实现，
      // 否则两次参数相同的正常观察会被误判为越权。
      let data: JsonValue;
      try {
        data = await execute(call);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        // A model may ask for a role-permitted tool that the *current run's*
        // stricter action policy (or its action ledger) refuses. Every
        // grant-stage refusal carries its own code so the model can tell a
        // stale snapshot (retry with the newest observation) from a forbidden
        // action (stop). Do not misclassify these safe denials as a
        // Worker/setup outage or mark the action as executed.
        if (isActionDenialCode(code)) return denied(code);
        throw error;
      }
      const resultValidator = getToolResultValidator(call.name);
      if (!resultValidator(data)) return denied('VALIDATION_ERROR');
      return parseContract('ToolResult', {
        requestId: randomUUID(),
        actionId: null,
        status: 'succeeded',
        data,
        reasonCode: null,
        evidenceRefs: [],
      });
    },
  };
}
