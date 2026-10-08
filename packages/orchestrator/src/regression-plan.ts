import { parseContract } from '@localqa/contracts';
import type { Criterion, RegressionBinding } from '@localqa/contracts';
import { hashPayload } from '@localqa/storage';
import {
  compileRegression,
  type CompiledRegressionStep,
  type CompilerOptions,
} from './regression-compiler.js';

/** Shared by admission and worker: deterministic scoped IDs, not an alternate DSL. */
export function createRegressionPlan(
  binding: RegressionBinding,
  options: Omit<CompilerOptions, 'resolveModule'>,
): {
  steps: readonly CompiledRegressionStep[];
  criteria: Criterion[];
  unevaluatedCriterionIds: string[];
} {
  parseContract('RegressionBinding', binding);
  if (
    hashPayload(binding.document) !==
    (binding.snapshotDocumentSha256 ?? binding.sourceDocumentSha256)
  )
    throw new Error('SOURCE_SHA_MISMATCH');
  const modules = new Map(
    binding.moduleSnapshots.map((module) => [
      `${module.name}@${module.version}`,
      module,
    ]),
  );
  if (modules.size !== binding.moduleSnapshots.length)
    throw new Error('DUPLICATE_MODULE');
  const compiled = compileRegression(binding.document, {
    ...options,
    resolveModule: (name, version) => modules.get(`${name}@${version}`),
  });
  const criteria = new Map<string, Criterion>();
  function scoped(
    original: Criterion,
    path: CompiledRegressionStep['source']['modulePath'],
  ): Criterion {
    const id = `r-${hashPayload({ path, originalId: original.id }).slice(0, 62)}`;
    const value = parseContract('Criterion', {
      ...original,
      id,
      sourceKind: 'saved_case',
      sourceRef: binding.sourceVersionId,
    });
    criteria.set(id, value);
    return value;
  }
  // Keep unused declarations too: absence of execution is not proof of passing.
  for (const criterion of binding.document.criteria) scoped(criterion, []);
  const scopes = new Set<string>();
  const steps = compiled.map((entry) => {
    const path = entry.source.modulePath;
    for (let depth = 1; depth <= path.length; depth++) {
      const scope = path.slice(0, depth);
      const key = hashPayload(scope);
      if (!scopes.has(key)) {
        scopes.add(key);
        const module = modules.get(scope[scope.length - 1]!.ref)!;
        for (const criterion of module.document.criteria)
          scoped(criterion, scope);
      }
    }
    const frozen = entry.criteria.map((criterion) => scoped(criterion, path));
    const step =
      entry.step.kind === 'assert'
        ? { ...entry.step, criterionId: frozen[0]!.id }
        : entry.step.kind === 'ai_action'
          ? {
              ...entry.step,
              criteriaIds: frozen.map((criterion) => criterion.id),
            }
          : entry.step;
    return {
      ...entry,
      step: parseContract('ReplayStep', step),
      criteria: frozen,
      // Retain the approved source classification for deterministic smoke
      // oracles; saved-case provenance remains on the frozen case criteria.
      originCriteria: entry.criteria.map((original, index) => ({
        ...original,
        id: frozen[index]!.id,
      })),
    };
  });
  const referenced = new Set(
    steps.flatMap((entry) => entry.criteria.map((criterion) => criterion.id)),
  );
  return {
    steps,
    criteria: [...criteria.values()],
    unevaluatedCriterionIds: [...criteria.keys()].filter(
      (id) => !referenced.has(id),
    ),
  };
}
