import type { ToolName } from '@localqa/contracts';
import documents from '../../contracts/src/generated/schemas.json' with { type: 'json' };
import { toolsForRole, type AgentRole } from './prompts.js';

type Json = Record<string, unknown>;

const defs = documents['tools.schema.json'].$defs as Record<string, Json>;
const toolBranches = (defs['ToolCall'] as { oneOf: Json[] }).oneOf;

function refName(ref: string): string | null {
  const prefix = '#/$defs/';
  if (!ref.startsWith(prefix)) return null;
  return ref.slice(prefix.length);
}

/**
 * Copy a schema and expand local $refs from this same ToolCall document.
 * Acyclic refs are inlined so fields such as NodeTarget stay visible.
 * A cycle stays as a ref to $defs on the same parameters object.
 */
function inlineSchema(
  schema: unknown,
  stack: readonly string[],
  cycles: Set<string>,
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => inlineSchema(item, stack, cycles));
  }
  if (!schema || typeof schema !== 'object') return schema;
  const record = schema as Json;
  if (typeof record['$ref'] === 'string') {
    const name = refName(record['$ref']);
    const target = name ? defs[name] : undefined;
    if (!name || !target) {
      throw Object.assign(new Error('unresolved tool schema'), {
        code: 'VALIDATION_ERROR',
      });
    }
    if (stack.includes(name)) {
      cycles.add(name);
      return { $ref: `#/$defs/${name}` };
    }
    const resolved = inlineSchema(
      structuredClone(target),
      [...stack, name],
      cycles,
    ) as Json;
    const rest: Json = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === '$ref' || key.startsWith('x-')) continue;
      rest[key] = inlineSchema(value, stack, cycles);
    }
    return Object.keys(rest).length === 0 ? resolved : { ...resolved, ...rest };
  }
  const next: Json = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('x-')) continue;
    next[key] = inlineSchema(value, stack, cycles);
  }
  return next;
}

function assertSelfContained(schema: unknown, defsInRoot: Json): void {
  if (Array.isArray(schema)) {
    for (const item of schema) assertSelfContained(item, defsInRoot);
    return;
  }
  if (!schema || typeof schema !== 'object') return;
  const record = schema as Json;
  if (typeof record['$ref'] === 'string') {
    const name = refName(record['$ref']);
    if (!name || !Object.hasOwn(defsInRoot, name)) {
      throw Object.assign(new Error('tool schema ref is not self-contained'), {
        code: 'VALIDATION_ERROR',
      });
    }
  }
  for (const value of Object.values(record))
    assertSelfContained(value, defsInRoot);
}

function branchNamed(name: string): Json | undefined {
  return toolBranches.find((branch) => {
    const properties = branch['properties'] as Json | undefined;
    const nameSchema = properties?.['name'] as Json | undefined;
    return nameSchema?.['const'] === name;
  });
}

/** Parameters are the ToolCall args of the same name, with $refs expanded. */
export function parametersForTool(name: ToolName): Record<string, unknown> {
  const branch = branchNamed(name);
  const properties = branch?.['properties'] as Json | undefined;
  const args = properties?.['args'];
  if (!args) {
    throw Object.assign(new Error('unknown tool'), {
      code: 'VALIDATION_ERROR',
    });
  }
  const cycles = new Set<string>();
  const parameters = inlineSchema(structuredClone(args), [], cycles) as Json;
  if (cycles.size > 0) {
    const local: Json = {};
    for (const defName of cycles) {
      const nested = new Set<string>();
      local[defName] = inlineSchema(
        structuredClone(defs[defName]),
        [defName],
        nested,
      );
      for (const extra of nested) cycles.add(extra);
    }
    for (const defName of cycles) {
      if (Object.hasOwn(local, defName)) continue;
      const nested = new Set<string>();
      local[defName] = inlineSchema(
        structuredClone(defs[defName]),
        [defName],
        nested,
      );
    }
    parameters['$defs'] = local;
  }
  assertSelfContained(
    parameters,
    (parameters['$defs'] as Json | undefined) ?? {},
  );
  return parameters;
}

export function toolSchemasForRole(role: AgentRole): {
  name: ToolName;
  parameters: Record<string, unknown>;
}[] {
  return toolsForRole(role).map((name) => ({
    name,
    parameters: parametersForTool(name),
  }));
}
