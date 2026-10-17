import { Ajv2020 } from 'ajv/dist/2020.js';
import formatsPlugin from 'ajv-formats';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import documents from './generated/schemas.json' with { type: 'json' };
import type { ContractTypes } from './generated/types.js';

export type * from './generated/types.js';
export * from './action-denial.js';
export * from './errors.js';
export * from './config.js';
export * from './model-limits.js';
export * from './locator-maintenance.js';

// Validate JSON without coercion, defaults, stripping, or user-data logging.
const ajv = new Ajv2020({
  strictSchema: true,
  strictTypes: false, // Partial if/then constraints inherit their enclosing types.
  strictTuples: false,
  strictRequired: false,
  strictNumbers: true,
  allowUnionTypes: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateFormats: true,
  verbose: false,
});
formatsPlugin.default(ajv, { mode: 'full' });
// OpenAPI binary is a transport annotation, not a string-format predicate.
ajv.addFormat('binary', true);
for (const keyword of ['x-roles', 'x-result-schema', 'x-sensitive'])
  ajv.addKeyword(keyword);
ajv.addSchema(documents['domain.schema.json'] as AnySchema, 'domain');

export type ContractName = keyof ContractTypes;
export const contractNames = Object.freeze(
  Object.keys(documents['domain.schema.json'].$defs) as ContractName[],
);
export function getValidator<N extends ContractName>(
  name: N,
): ValidateFunction<ContractTypes[N]> {
  const validator = ajv.getSchema<ContractTypes[N]>(`domain#/$defs/${name}`);
  if (!validator) throw new globalThis.Error(`Unknown contract: ${name}`);
  return validator;
}

export type ValidationResult<T> =
  { success: true; data: T } | { success: false; errors: ErrorObject[] };
export function validateContract<N extends ContractName>(
  name: N,
  data: unknown,
): ValidationResult<ContractTypes[N]> {
  const validator = getValidator(name);
  return validator(data)
    ? { success: true, data }
    : { success: false, errors: structuredClone(validator.errors ?? []) };
}
export class ContractValidationError extends globalThis.Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(
    readonly contract: ContractName,
    readonly issues: ErrorObject[],
  ) {
    super(`Invalid ${contract}`);
    this.name = 'ContractValidationError';
  }
}
export function parseContract<N extends ContractName>(
  name: N,
  data: unknown,
): ContractTypes[N] {
  const result = validateContract(name, data);
  if (!result.success) throw new ContractValidationError(name, result.errors);
  return result.data;
}

const roots = {
  events: 'RunEvent',
  tools: 'ToolCall',
  report: 'Report',
  regression: 'RegressionDocument',
} as const;
export type RootContract = keyof typeof roots;
export function getRootValidator<N extends RootContract>(
  name: N,
): ValidateFunction<ContractTypes[(typeof roots)[N]]> {
  if (!Object.hasOwn(roots, name))
    throw new globalThis.Error(`Unknown root: ${name}`);
  if (!ajv.getSchema(name))
    ajv.addSchema(documents[`${name}.schema.json`] as AnySchema, name);
  const validator = ajv.getSchema<ContractTypes[(typeof roots)[N]]>(name);
  if (!validator) throw new globalThis.Error(`Unknown root: ${name}`);
  return validator;
}

export type ToolName = ContractTypes['ToolCall']['name'];
export const toolMetadata = Object.freeze(
  Object.fromEntries(
    documents['tools.schema.json'].$defs.ToolCall.oneOf.map((tool) => [
      tool.properties.name.const,
      Object.freeze({
        roles: Object.freeze([...tool['x-roles']]),
        resultContract: tool['x-result-schema'].$ref
          .split('/')
          .at(-1) as ContractName,
      }),
    ]),
  ) as Record<
    ToolName,
    { readonly roles: readonly string[]; readonly resultContract: ContractName }
  >,
);
export function getToolResultValidator(name: ToolName): ValidateFunction {
  return getValidator(toolMetadata[name].resultContract);
}

// HTTP schemas are extracted from OpenAPI, not hand-maintained DTOs. Internal operations
// are excluded by default; a worker integration must opt in deliberately.
type Schema = Record<string, unknown>;
type Operation = {
  operationId: string;
  tags: string[];
  parameters: { name: string; in: string; required: boolean; schema: Schema }[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
};
const operations = new Map<string, Operation>();
for (const methods of Object.values(documents['openapi.json'].paths)) {
  for (const operation of Object.values(methods)) {
    const op = operation as unknown as Operation;
    operations.set(op.operationId, op);
  }
}
export const publicOperationIds = Object.freeze(
  [...operations.values()]
    .filter((op) => !op.tags.includes('Internal'))
    .map((op) => op.operationId),
);
export const internalOperationIds = Object.freeze(
  [...operations.values()]
    .filter((op) => op.tags.includes('Internal'))
    .map((op) => op.operationId),
);
function mapRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mapRefs);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === '$ref' && typeof child === 'string'
          ? child.replace('#/components/schemas/', 'domain#/$defs/')
          : mapRefs(child),
      ]),
    );
  return value;
}
export type ApiSchemaSelector =
  | { kind: 'request'; mediaType?: string }
  | { kind: 'response'; status: string; mediaType?: string }
  | { kind: 'parameters'; location: 'path' | 'query' | 'header' };
const apiCache = new Map<string, ValidateFunction>();
export function getApiValidator(
  operationId: string,
  selector: ApiSchemaSelector,
  options: { internal?: boolean } = {},
): ValidateFunction {
  const op = operations.get(operationId);
  if (!op || (op.tags.includes('Internal') && !options.internal))
    throw new globalThis.Error(`Operation unavailable: ${operationId}`);
  const key = JSON.stringify([operationId, selector]);
  const cached = apiCache.get(key);
  if (cached) return cached;
  let schema: Schema | undefined;
  if (selector.kind === 'parameters') {
    const parameters = op.parameters.filter(
      (parameter) => parameter.in === selector.location,
    );
    schema = {
      type: 'object',
      properties: Object.fromEntries(
        parameters.map((parameter) => [parameter.name, parameter.schema]),
      ),
      required: parameters
        .filter((parameter) => parameter.required)
        .map((parameter) => parameter.name),
    };
  } else {
    const content =
      selector.kind === 'request'
        ? op.requestBody?.content
        : op.responses[selector.status]?.content;
    schema = content?.[selector.mediaType ?? 'application/json']?.schema;
  }
  if (!schema) throw new globalThis.Error(`No content schema: ${key}`);
  const validator = ajv.compile(mapRefs(schema) as AnySchema);
  apiCache.set(key, validator);
  return validator;
}
