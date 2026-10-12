import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(
  new URL('../src/components/workbench/PhaseProgress.tsx', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    esModuleInterop: true,
  },
}).outputText;
const exports = {};
runInNewContext(compiled, { exports, require });

test('auth termination does not mark unexecuted testing phases as completed', () => {
  const props = {
    currentPhase: 'finalize',
    status: 'failed',
    terminationPhase: 'auth',
  };
  const timeline = exports.computePhaseTimeline(props);
  assert.equal(timeline.find((p) => p.key === 'auth').stateClass, 'failed');
  assert.ok(
    timeline
      .filter((p) =>
        ['explore', 'plan', 'execute', 'reproduce', 'finalize'].includes(p.key),
      )
      .every((p) => !p.isCompleted),
  );
  const html = require('react-dom/server').renderToStaticMarkup(
    require('react').createElement(exports.PhaseProgress, props),
  );
  assert.match(html, /终止阶段：/);
  assert.match(html, /<strong>认证<\/strong>/);
  assert.match(
    html,
    /data-testid="phase-step-execute" data-phase-completed="false" data-phase-state="pending"/,
  );
  assert.ok(
    exports
      .computePhaseTimeline({ currentPhase: 'finalize', status: 'failed' })
      .every((p) => !p.isCompleted),
    'Do not infer success before task history loads',
  );
});
