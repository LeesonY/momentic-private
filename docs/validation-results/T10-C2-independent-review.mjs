// Root counterexamples and actual component server rendering. No browser.
import ts from 'typescript';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { validateContract } from '../../packages/contracts/dist/index.js';
import {
  validateRegressionRunProvenance,
  validateCaseVerdictState,
} from '../../apps/web/scripts/t10VerificationHelpers.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const run = { id: randomUUID(), executionMode: 'regression' };
const caseId = randomUUID();
const document = {
  schemaVersion: 1, kind: 'localqa/test', id: 'root-c2-review', name: 'Root review',
  variables: {},
  criteria: [{ id: 'loaded', kind: 'http_status', description: 'HTTP response equals 200', sourceKind: 'user_spec', sourceRef: 'root-review', expectedValue: 200 }],
  steps: [{ kind: 'navigate', url: 'http://localhost:8080/' }, { kind: 'assert', criterionId: 'loaded' }],
};
const binding = {
  sourceVersionId: randomUUID(), sourceDocumentSha256: 'a'.repeat(64),
  snapshotDocumentSha256: 'b'.repeat(64), document, moduleSnapshots: [],
};
if (!validateContract('RegressionBinding', binding).success)
  throw new Error('Root positive fixture must satisfy the canonical binding schema');
const input = {
  run,
  cases: [{ definition: { id: caseId, runId: run.id, regression: binding } }],
  steps: [{ id: randomUUID(), runId: run.id, caseId, seq: 1, regressionSource: { documentId: document.id, stepIndex: 0, modulePath: [] } }],
};
const scenarios = [
  ['Complete binding and source', true, () => {}],
  ['16 non-hex SHA characters', false, x => { x.cases[0].definition.regression.sourceDocumentSha256 = 'z'.repeat(16); }],
  ['Missing frozen document', false, x => { delete x.cases[0].definition.regression.document; }],
  ['Invalid supplied snapshot SHA', false, x => { x.cases[0].definition.regression.snapshotDocumentSha256 = 'bad'; }],
  ['Invalid module version record', false, x => { x.cases[0].definition.regression.moduleSnapshots = [{ name: 'module', version: -1 }]; }],
  ['Missing step modulePath', false, x => { delete x.steps[0].regressionSource.modulePath; }],
  ['Step index exceeds canonical maximum', false, x => { x.steps[0].regressionSource.stepIndex = 100; }],
];
const results = scenarios.map(([name, expectedValid, mutate]) => {
  const actual = structuredClone(input);
  mutate(actual);
  try {
    const result = validateRegressionRunProvenance(actual);
    return { case: name, valid: result.valid, expectedValid, passed: result.valid === expectedValid };
  } catch (error) {
    return { case: name, error: error.name, passed: false };
  }
});
try {
  const result = validateCaseVerdictState({ caseRecord: { outcome: 'passed' }, claimedPassed: true });
  results.push({ case: 'Missing verdict cannot claim completed/pass', valid: result.valid, passed: result.valid === false && result.isCompletedReplay !== true && result.verdictStatus !== 'passed' });
} catch (error) {
  results.push({ case: 'Missing verdict cannot claim completed/pass', error: error.name, passed: false });
}

const phasePath = join(repo, 'apps/web/src/components/workbench/PhaseProgress.tsx');
const compiled = join(dirname(phasePath), `.root-c2-review-${randomUUID()}.mjs`);
try {
  const source = await readFile(phasePath, 'utf8');
  await writeFile(compiled, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React },
  }).outputText);
  const { PhaseProgress } = await import(pathToFileURL(compiled).href);
  const require = createRequire(pathToFileURL(join(repo, 'apps/web/package.json')));
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  for (const status of ['queued', 'cancelled', 'failed']) {
    const html = renderToStaticMarkup(React.createElement(PhaseProgress, { status, currentPhase: 'execute' }));
    const completed = (html.match(/class="phase-item completed"/g) ?? []).length;
    const active = (html.match(/class="phase-item active"/g) ?? []).length;
    results.push({
      case: `Actual PhaseProgress SSR: ${status} at execute`, completed, active,
      passed: status === 'queued' ? completed === 0 && active === 0 : completed < 7,
    });
  }
  console.log(JSON.stringify({
    sourceHashes: {
      phase: createHash('sha256').update(source).digest('hex'),
      helper: createHash('sha256').update(await readFile(join(repo, 'apps/web/scripts/t10VerificationHelpers.mjs'))).digest('hex'),
    },
    results, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length,
    scope: 'Focused guards and actual PhaseProgress SSR; browser UI and real Worker replay remain unverified',
  }, null, 2));
  if (results.some(x => !x.passed)) process.exitCode = 1;
} finally {
  await rm(compiled, { force: true });
}
