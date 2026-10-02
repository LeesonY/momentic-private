import { getRootValidator, type JsonValue, type ToolCall } from '@localqa/contracts';
import { toolsForRole, type AgentRole } from './prompts.js';

export interface DispatchRequest {
  role: AgentRole;
  call: unknown;
  knownEvidenceIds: readonly string[];
}

export interface DispatchResult {
  status: 'succeeded' | 'denied';
  reasonCode: string | null;
  executed: boolean;
  data: JsonValue;
}

export interface Dispatcher {
  dispatch(input: DispatchRequest): Promise<DispatchResult>;
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
      if (childKey === 'artifactId' && typeof child === 'string' && !known.has(child)) {
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
 */
export function createPolicyDispatcher(
  execute: (call: ToolCall) => Promise<JsonValue>,
): Dispatcher {
  let lastFingerprint: string | null = null;
  const validator = getRootValidator('tools');
  return {
    async dispatch(input) {
      if (!validator(input.call)) {
        return { status: 'denied', reasonCode: 'VALIDATION_ERROR', executed: false, data: null };
      }
      const call = input.call as ToolCall;
      const allowed = toolsForRole(input.role);
      if (!allowed.includes(call.name)) {
        return { status: 'denied', reasonCode: 'POLICY_DENIED', executed: false, data: null };
      }
      const known = new Set(input.knownEvidenceIds);
      if (unknownEvidence(call, known).length > 0) {
        return { status: 'denied', reasonCode: 'FAKE_EVIDENCE', executed: false, data: null };
      }
      const fingerprint = JSON.stringify(call);
      if (fingerprint === lastFingerprint) {
        return { status: 'denied', reasonCode: 'REPEAT_ACTION', executed: false, data: null };
      }
      lastFingerprint = fingerprint;
      const data = await execute(call);
      return { status: 'succeeded', reasonCode: null, executed: true, data };
    },
  };
}
