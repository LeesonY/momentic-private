import { hashPayload } from '@localqa/storage';
import { parseContract } from '@localqa/contracts';
import type {
  RegressionDocument,
  ReplayStep,
  Locator,
  Criterion,
} from '@localqa/contracts';

// Internal compiler composition, not an HTTP protocol or a second DSL.
export interface RegisteredRegressionModule {
  projectId: string;
  name: string;
  version: number;
  sha256: string;
  document: RegressionDocument;
  reviewStatus: 'draft' | 'approved' | 'rejected';
}
type Scalar = string | number | boolean;
export interface CompilerOptions {
  projectId: string;
  allowedOrigins: readonly string[];
  env: Readonly<Record<string, Scalar | { value: Scalar; secret: boolean }>>;
  secretVars?: readonly string[];
  maxExpandedSteps: number;
  resolveModule: (
    name: string,
    version: number,
  ) => RegisteredRegressionModule | undefined;
}
export interface CompiledRegressionStep {
  step: ReplayStep;
  criteria: readonly Criterion[];
  /** Approved source semantics, with the same scoped ids, when a run plan binds them. */
  originCriteria?: readonly Criterion[];
  source: {
    documentId: string;
    stepIndex: number;
    modulePath: readonly {
      ref: string;
      sha256: string;
      invocationStepIndex: number;
    }[];
  };
}
export class RegressionCompileError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'RegressionCompileError';
  }
}
function fail(code: string): never {
  throw new RegressionCompileError(code);
}
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const variableName = /^[A-Z][A-Z0-9_]*$/;
function inspect(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    fail('UNSAFE_OBJECT');
  for (const [key, child] of Object.entries(value)) {
    if (dangerous.has(key)) fail('DANGEROUS_KEY');
    inspect(child);
  }
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function regressionDocumentSha256(document: RegressionDocument): string {
  return hashPayload(document);
}
function scalar(value: unknown): value is Scalar {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Pure synchronous compilation; caller supplies the only environment and registry access.
 * Static expansion count is not actions/tokens/time runtime authorization.
 */
export function compileRegression(
  document: RegressionDocument,
  options: CompilerOptions,
): readonly CompiledRegressionStep[] {
  inspect(document);
  inspect(options.env);
  if (
    !Number.isSafeInteger(options.maxExpandedSteps) ||
    options.maxExpandedSteps < 1
  )
    fail('INVALID_STATIC_LIMIT');
  const origins = new Set(
    options.allowedOrigins.map((origin) => {
      const url = new URL(origin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.origin !== origin
      )
        fail('INVALID_ORIGIN');
      return url.origin;
    }),
  );
  const secrets = new Set(options.secretVars ?? []);
  const output: CompiledRegressionStep[] = [];
  const active = new Set<string>();
  const snapshots = new Map<string, RegisteredRegressionModule>();

  function expand(
    doc: RegressionDocument,
    args: Record<string, Scalar>,
    path: CompiledRegressionStep['source']['modulePath'],
  ): void {
    inspect(doc);
    parseContract('RegressionDocument', doc);
    if (doc.fixtureRefs?.length) fail('UNRESOLVED_FIXTURE');
    const vars: Record<string, Scalar> = Object.create(null);
    for (const [key, value] of Object.entries({ ...doc.variables, ...args })) {
      if (!variableName.test(key) || dangerous.has(key) || !scalar(value))
        fail('INVALID_VARIABLE');
      vars[key] = value;
    }
    function text(input: string): string {
      const resolved = input.replace(
        /\{\{([^{}]*)\}\}/g,
        (_match, expression: string) => {
          const match = /^(env|vars)\.([A-Z][A-Z0-9_]*)$/.exec(expression);
          if (!match) fail('INVALID_EXPRESSION');
          const [, scope, key] = match;
          if (scope === 'vars') {
            if (secrets.has(key!)) fail('SECRET_INTERPOLATION');
            if (!Object.hasOwn(vars, key!)) fail('MISSING_VARIABLE');
            return String(vars[key!]);
          }
          if (!Object.hasOwn(options.env, key!)) fail('MISSING_VARIABLE');
          const entry = options.env[key!]!;
          if (typeof entry === 'object') {
            if (entry.secret) fail('SECRET_INTERPOLATION');
            if (!scalar(entry.value)) fail('INVALID_VARIABLE');
            return String(entry.value);
          }
          if (!scalar(entry)) fail('INVALID_VARIABLE');
          return String(entry);
        },
      );
      if (resolved.includes('{{') || resolved.includes('}}'))
        fail('INVALID_EXPRESSION');
      return resolved;
    }
    function resolve(value: unknown): unknown {
      if (typeof value === 'string') return text(value);
      if (Array.isArray(value)) return value.map(resolve);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, resolve(v)]),
        );
      return value;
    }
    function locator(value: Locator): void {
      parseContract('Locator', value);
      if (
        !value.value.trim() ||
        (value.name !== undefined && !value.name.trim()) ||
        [...value.value].some((character) => character.charCodeAt(0) < 32)
      )
        fail('INVALID_LOCATOR');
    }
    const criteria = new Map<string, Criterion>();
    for (const original of doc.criteria) {
      const criterion = parseContract('Criterion', resolve(original));
      if (criterion.id !== original.id || criteria.has(criterion.id))
        fail('INVALID_CRITERION_ID');
      if ('locator' in criterion && criterion.locator)
        locator(criterion.locator);
      criteria.set(criterion.id, criterion);
    }
    for (const [stepIndex, original] of doc.steps.entries()) {
      const step = parseContract('ReplayStep', resolve(original));
      if (step.kind === 'module') {
        if (path.length >= 8) fail('MODULE_DEPTH');
        const match = /^([a-zA-Z0-9_./-]+)@([1-9][0-9]*)$/.exec(step.ref);
        if (!match || !Number.isSafeInteger(Number(match[2])))
          fail('INVALID_MODULE_REF');
        if (active.has(step.ref)) fail('MODULE_CYCLE');
        let registered = snapshots.get(step.ref);
        if (!registered) {
          const found = options.resolveModule(match[1]!, Number(match[2]));
          if (!found) fail('UNKNOWN_MODULE');
          inspect(found);
          registered = clone(found);
          if (
            registered.projectId !== options.projectId ||
            registered.name !== match[1] ||
            registered.version !== Number(match[2])
          )
            fail('MODULE_IDENTITY');
          if (registered.reviewStatus !== 'approved')
            fail('MODULE_NOT_APPROVED');
          if (
            registered.sha256 !== regressionDocumentSha256(registered.document)
          )
            fail('MODULE_SHA');
          snapshots.set(step.ref, registered);
        }
        const bindings: Record<string, Scalar> = Object.create(null);
        for (const [key, value] of Object.entries(step.arguments ?? {})) {
          if (!variableName.test(key) || !scalar(value))
            fail('INVALID_ARGUMENT');
          bindings[key] = value;
        }
        active.add(step.ref);
        expand(registered.document, bindings, [
          ...path,
          {
            ref: step.ref,
            sha256: registered.sha256,
            invocationStepIndex: stepIndex,
          },
        ]);
        active.delete(step.ref);
        continue;
      }
      if (step.kind === 'navigate') {
        let url: URL;
        try {
          url = new URL(step.url);
        } catch {
          fail('INVALID_URL');
        }
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          !origins.has(url.origin)
        )
          fail('TARGET_NOT_ALLOWED');
      }
      if ('locator' in step) locator(step.locator);
      const ids =
        step.kind === 'assert'
          ? [step.criterionId]
          : step.kind === 'ai_action'
            ? step.criteriaIds
            : [];
      const associated = ids.map(
        (id) => criteria.get(id) ?? fail('UNKNOWN_CRITERION'),
      );
      if (output.length >= options.maxExpandedSteps) fail('STATIC_STEP_LIMIT');
      output.push(
        freeze({
          step,
          criteria: associated,
          source: { documentId: doc.id, stepIndex, modulePath: clone(path) },
        }),
      );
    }
  }
  // Snapshot input so the compiler never rewrites the approved document.
  expand(clone(document), {}, []);
  return freeze(output);
}
