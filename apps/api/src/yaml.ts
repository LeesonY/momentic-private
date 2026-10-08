import YAML, { isAlias, isCollection, visit } from 'yaml';
import { parseContract } from '@localqa/contracts';
import type { RegressionDocument, ReplayStep } from '@localqa/contracts';
import { StorageError, hashPayload } from '@localqa/storage';

const MAX_BYTES = 262144; // 256 KiB
const MAX_DEPTH = 32;

const STEP_KINDS = new Set([
  'navigate',
  'click',
  'type_text',
  'assert',
  'ai_action',
  'module',
]);

const SAFE_TAGS = new Set([
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:binary',
  '!!str',
  '!!int',
  '!!seq',
  '!!map',
  '!!bool',
  '!!null',
  '!!float',
  '!!binary',
]);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validateVariables(text: string): void {
  const matches = text.match(/\{\{[^}]*\}\}/g) || [];
  for (const m of matches) {
    if (!/^\{\{(env|vars)\.[A-Z][A-Z0-9_]*\}\}$/.test(m)) {
      throw new StorageError('VALIDATION_ERROR');
    }
  }
}

function validateStep(step: ReplayStep, depth: number): void {
  if (depth > 8) throw new StorageError('VALIDATION_ERROR');
  if (!STEP_KINDS.has(step.kind)) throw new StorageError('VALIDATION_ERROR');
  for (const value of Object.values(step)) {
    if (typeof value === 'string') validateVariables(value);
  }
  if (step.kind === 'module') {
    const ref = (step as { ref?: string }).ref;
    if (!ref || !/^[a-zA-Z0-9_./-]+@[1-9][0-9]*$/.test(ref)) {
      throw new StorageError('VALIDATION_ERROR');
    }
  }
}

export function validateRegressionDocument(doc: RegressionDocument): void {
  try {
    parseContract('RegressionDocument', doc);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (
      error &&
      typeof error === 'object' &&
      ((error as { name?: string }).name === 'ContractValidationError' ||
        'issues' in error ||
        'contract' in error)
    ) {
      const err = new StorageError('VALIDATION_ERROR');
      err.message = (error as Error).message || 'Invalid RegressionDocument';
      throw err;
    }
    throw error;
  }
  const knownTop = new Set([
    'schemaVersion',
    'kind',
    'id',
    'name',
    'variables',
    'criteria',
    'steps',
    'fixtureRefs',
  ]);
  for (const key of Object.keys(doc)) {
    if (!knownTop.has(key)) throw new StorageError('VALIDATION_ERROR');
  }
  if (doc.kind !== 'localqa/test') throw new StorageError('VALIDATION_ERROR');
  for (const step of doc.steps) validateStep(step, 1);
}

function checkDangerousKeys(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new StorageError('VALIDATION_ERROR');
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) checkDangerousKeys(item);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(k)) {
      throw new StorageError('VALIDATION_ERROR');
    }
    checkDangerousKeys(v);
  }
}

export function parseRegressionYaml(yamlText: string): RegressionDocument {
  if (typeof yamlText !== 'string') {
    throw new StorageError('VALIDATION_ERROR');
  }
  const bytes = Buffer.byteLength(yamlText, 'utf8');
  if (bytes === 0 || bytes > MAX_BYTES) {
    throw new StorageError('VALIDATION_ERROR');
  }

  let docs: YAML.Document.Parsed[];
  try {
    docs = YAML.parseAllDocuments(yamlText, {
      uniqueKeys: true,
    });
  } catch {
    throw new StorageError('VALIDATION_ERROR');
  }

  if (docs.length !== 1) {
    throw new StorageError('VALIDATION_ERROR');
  }

  const doc = docs[0]!;
  if (doc.errors && doc.errors.length > 0) {
    throw new StorageError('VALIDATION_ERROR');
  }
  if (doc.warnings && doc.warnings.length > 0) {
    throw new StorageError('VALIDATION_ERROR');
  }
  if (!doc.contents) {
    throw new StorageError('VALIDATION_ERROR');
  }

  try {
    visit(doc, {
      Node(_key, node, path) {
        if (node.anchor !== undefined || isAlias(node)) {
          throw new StorageError('VALIDATION_ERROR');
        }
        if (
          node.tag !== undefined &&
          node.tag !== null &&
          !SAFE_TAGS.has(node.tag)
        ) {
          throw new StorageError('VALIDATION_ERROR');
        }
        const depth = path ? path.filter(isCollection).length : 0;
        if (depth > MAX_DEPTH) {
          throw new StorageError('VALIDATION_ERROR');
        }
      },
      Pair(_key, pair) {
        const rawKey = pair.key;
        const k =
          typeof rawKey === 'object' && rawKey !== null && 'value' in rawKey
            ? String((rawKey as { value: unknown }).value)
            : String(rawKey);
        if (DANGEROUS_KEYS.has(k)) {
          throw new StorageError('VALIDATION_ERROR');
        }
      },
    });
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('VALIDATION_ERROR');
  }

  let parsed: unknown;
  try {
    parsed = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new StorageError('VALIDATION_ERROR');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StorageError('VALIDATION_ERROR');
  }

  checkDangerousKeys(parsed);

  try {
    const regressionDoc = parseContract('RegressionDocument', parsed);
    validateRegressionDocument(regressionDoc);
    return regressionDoc;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (
      error &&
      typeof error === 'object' &&
      ((error as { name?: string }).name === 'ContractValidationError' ||
        'issues' in error ||
        'contract' in error)
    ) {
      const err = new StorageError('VALIDATION_ERROR');
      err.message = (error as Error).message || 'Invalid RegressionDocument';
      throw err;
    }
    throw error;
  }
}

export function stringifyRegressionYaml(doc: RegressionDocument): string {
  const yamlText = YAML.stringify(doc);
  const bytes = Buffer.byteLength(yamlText, 'utf8');
  if (bytes > MAX_BYTES) {
    throw new StorageError('VALIDATION_ERROR');
  }
  // Validate that exported YAML strictly satisfies the exact same parser,
  // contract, depth (<= 32), alias, and tag limits. Documents exceeding YAML
  // limits (e.g. historical JSON with depth > 32) explicitly fail with 422
  // rather than producing an un-reimportable export or truncating the output.
  const reimported = parseRegressionYaml(yamlText);
  if (hashPayload(reimported) !== hashPayload(doc)) {
    throw new StorageError('VALIDATION_ERROR');
  }
  return yamlText;
}
