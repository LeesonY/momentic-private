import { parseContract } from '@localqa/contracts';
import type { RegressionDocument, Locator } from '@localqa/contracts';
import { StorageError, hashPayload } from '@localqa/storage';

const MAX_STATIC_STEPS = 100;
const MAX_MODULE_DEPTH = 8; // Max 8 layers of module invocations

const MODULE_NAME_REGEX =
  /^(?!\.{1,2}(?:\/|$))(?!.*?\/\.{1,2}(?:\/|$))[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;

export function validateModuleName(name: string): void {
  if (
    typeof name !== 'string' ||
    name.length < 1 ||
    name.length > 120 ||
    !MODULE_NAME_REGEX.test(name)
  ) {
    throw new StorageError('VALIDATION_ERROR');
  }
}

export function parseModuleVersion(raw: string): number {
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) {
    throw new StorageError('VALIDATION_ERROR');
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 1 || num > 2147483647) {
    throw new StorageError('VALIDATION_ERROR');
  }
  return num;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VARIABLE_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;
const TEMPLATE_VAR_REGEX = /^\{\{(env|vars)\.[A-Z][A-Z0-9_]*\}\}$/;

function inspectPlainJson(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new StorageError('VALIDATION_ERROR');
    }
    return;
  }
  if (!Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new StorageError('VALIDATION_ERROR');
    }
  }
  for (const [k, v] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(k)) {
      throw new StorageError('VALIDATION_ERROR');
    }
    inspectPlainJson(v);
  }
}

function checkTemplateString(input: string): void {
  let hasInvalid = false;
  const cleaned = input.replace(/\{\{([^{}]*)\}\}/g, (_match, expr) => {
    if (!TEMPLATE_VAR_REGEX.test(`{{${expr}}}`)) {
      hasInvalid = true;
    }
    return '';
  });
  if (hasInvalid || cleaned.includes('{{') || cleaned.includes('}}')) {
    throw new StorageError('VALIDATION_ERROR');
  }
}

function checkTemplateStringsRecursive(value: unknown): void {
  if (typeof value === 'string') {
    checkTemplateString(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      checkTemplateStringsRecursive(item);
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(k)) {
        throw new StorageError('VALIDATION_ERROR');
      }
      checkTemplateStringsRecursive(v);
    }
  }
}

function checkScalar(value: unknown): void {
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new StorageError('VALIDATION_ERROR');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new StorageError('VALIDATION_ERROR');
  }
  if (typeof value === 'string') {
    checkTemplateString(value);
  }
}

const STEP_KINDS = new Set([
  'navigate',
  'click',
  'type_text',
  'assert',
  'ai_action',
  'module',
]);

const LOCATOR_STRATEGIES = new Set(['css', 'role', 'text', 'test_id', 'label']);

function validateLocator(locator: Locator): void {
  parseContract('Locator', locator);
  if (!LOCATOR_STRATEGIES.has(locator.by)) {
    throw new StorageError('VALIDATION_ERROR');
  }
  if (
    !locator.value ||
    typeof locator.value !== 'string' ||
    !locator.value.trim()
  ) {
    throw new StorageError('VALIDATION_ERROR');
  }
  checkTemplateString(locator.value);
  if (locator.name !== undefined) {
    if (typeof locator.name !== 'string' || !locator.name.trim()) {
      throw new StorageError('VALIDATION_ERROR');
    }
    checkTemplateString(locator.name);
  }
}

export interface ApprovedModuleLookup {
  document: RegressionDocument;
  sha256: string;
  reviewStatus: string;
}

/**
 * Validates a module document statically at registration time:
 * - Contract schema and structure
 * - No fixtureRefs (fail closed)
 * - Unique criteria IDs
 * - References to assert/ai_action criteria exist in this doc
 * - Variable and argument syntax check without runtime evaluation
 * - Sub-module references exist and are approved in same project with matching canonical SHA
 * - Sub-module recursive structural validation
 * - Static topology recursion depth <= 8 (from caller root case invocation) and total steps <= 100
 */
export function validateModuleTemplateStatic(
  doc: RegressionDocument,
  resolveApprovedModule: (
    name: string,
    version: number,
  ) => ApprovedModuleLookup | undefined,
  initialModuleDepth: 0 | 1 = 1,
): void {
  let totalSteps = 0;
  const activeStack = new Set<string>();

  function validateDocNode(
    currentDoc: RegressionDocument,
    currentDepth: number,
  ): void {
    if (currentDepth > MAX_MODULE_DEPTH) {
      throw new StorageError('VALIDATION_ERROR'); // MODULE_DEPTH
    }

    inspectPlainJson(currentDoc);

    try {
      parseContract('RegressionDocument', currentDoc);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const err = new StorageError('VALIDATION_ERROR');
      err.message = (error as Error).message || 'Invalid RegressionDocument';
      throw err;
    }

    if (currentDoc.kind !== 'localqa/test' || currentDoc.schemaVersion !== 1) {
      throw new StorageError('VALIDATION_ERROR');
    }

    if (currentDoc.fixtureRefs?.length) {
      throw new StorageError('VALIDATION_ERROR');
    }

    // Validate variables
    if (currentDoc.variables && typeof currentDoc.variables === 'object') {
      for (const [k, v] of Object.entries(currentDoc.variables)) {
        if (!VARIABLE_NAME_REGEX.test(k)) {
          throw new StorageError('VALIDATION_ERROR');
        }
        checkScalar(v);
      }
    }

    // Validate criteria
    if (
      !Array.isArray(currentDoc.criteria) ||
      currentDoc.criteria.length < 1 ||
      currentDoc.criteria.length > 20
    ) {
      throw new StorageError('VALIDATION_ERROR');
    }
    const criteriaIds = new Set<string>();
    for (const criterion of currentDoc.criteria) {
      if (!criterion.id || criteriaIds.has(criterion.id)) {
        throw new StorageError('VALIDATION_ERROR');
      }
      criteriaIds.add(criterion.id);
      if (typeof criterion.description === 'string') {
        checkTemplateString(criterion.description);
      }
      if ('locator' in criterion && criterion.locator) {
        validateLocator(criterion.locator);
      }
      if ('expectedValue' in criterion) {
        checkTemplateStringsRecursive(criterion.expectedValue);
      }
    }

    // Validate steps
    if (
      !Array.isArray(currentDoc.steps) ||
      currentDoc.steps.length < 1 ||
      currentDoc.steps.length > 100
    ) {
      throw new StorageError('VALIDATION_ERROR');
    }

    for (const step of currentDoc.steps) {
      if (!STEP_KINDS.has(step.kind)) {
        throw new StorageError('VALIDATION_ERROR');
      }
      if (step.kind === 'navigate') {
        if (typeof step.url !== 'string' || !step.url.trim()) {
          throw new StorageError('VALIDATION_ERROR');
        }
        checkTemplateString(step.url);
      } else if (step.kind === 'click') {
        validateLocator(step.locator);
      } else if (step.kind === 'type_text') {
        validateLocator(step.locator);
        if (typeof step.text !== 'string') {
          throw new StorageError('VALIDATION_ERROR');
        }
        checkTemplateString(step.text);
      } else if (step.kind === 'assert') {
        if (!criteriaIds.has(step.criterionId)) {
          throw new StorageError('VALIDATION_ERROR');
        }
      } else if (step.kind === 'ai_action') {
        if (!Array.isArray(step.criteriaIds) || step.criteriaIds.length === 0) {
          throw new StorageError('VALIDATION_ERROR');
        }
        for (const cid of step.criteriaIds) {
          if (!criteriaIds.has(cid)) {
            throw new StorageError('VALIDATION_ERROR');
          }
        }
        if (typeof step.goal === 'string') {
          checkTemplateString(step.goal);
        }
      } else if (step.kind === 'module') {
        const match = /^([a-zA-Z0-9_./-]+)@([1-9][0-9]*)$/.exec(step.ref);
        if (!match) {
          throw new StorageError('VALIDATION_ERROR');
        }
        validateModuleName(match[1]!);
        const verNum = parseModuleVersion(match[2]!);

        if (step.arguments && typeof step.arguments === 'object') {
          for (const [argK, argV] of Object.entries(step.arguments)) {
            if (!VARIABLE_NAME_REGEX.test(argK)) {
              throw new StorageError('VALIDATION_ERROR');
            }
            checkScalar(argV);
          }
        }

        if (activeStack.has(step.ref)) {
          throw new StorageError('VALIDATION_ERROR'); // MODULE_CYCLE
        }

        const child = resolveApprovedModule(match[1]!, verNum);
        if (!child || child.reviewStatus !== 'approved') {
          throw new StorageError('VALIDATION_ERROR');
        }

        if (child.sha256 !== hashPayload(child.document)) {
          throw new StorageError('VALIDATION_ERROR');
        }

        activeStack.add(step.ref);
        validateDocNode(child.document, currentDepth + 1);
        activeStack.delete(step.ref);
      }

      if (step.kind !== 'module') {
        totalSteps++;
        if (totalSteps > MAX_STATIC_STEPS) {
          throw new StorageError('VALIDATION_ERROR');
        }
      }
    }
  }

  // Registration includes the template's future invocation. A saved-case root
  // is outside that stack and starts at zero, matching compileRegression.
  validateDocNode(doc, initialModuleDepth);
}
