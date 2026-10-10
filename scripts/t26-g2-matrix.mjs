import { spawnSync } from 'node:child_process';
import { T26_FIXTURES } from '../apps/worker/test/t26-business-fixtures.mjs';
let passed = 0,
  failed = 0;
for (const flow of T26_FIXTURES) {
  for (const mode of ['healthy', 'faulty']) {
    const r = spawnSync(
      process.execPath,
      ['scripts/t26-wire-flow.mjs', flow.id, mode],
      { encoding: 'utf8', timeout: 105000, maxBuffer: 2 * 1024 * 1024 },
    );
    const result = (r.stdout ?? '')
      .split(/\r?\n/)
      .flatMap((line) => {
        if (!line.startsWith('{"fixtureId":')) return [];
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .find((x) => x.fixtureId === flow.id);
    const ok =
      r.status === 0 &&
      result?.oracleKind === 'text_equals' &&
      result?.reportedModelIds?.length === 1 &&
      result?.reportedModelIds[0] === 'wire-fixture-model' &&
      JSON.stringify(result?.caseVerdicts) ===
        (mode === 'healthy' ? '["passed"]' : '["issue_found","issue_found"]') &&
      (mode === 'healthy' ||
        (result?.findingStatus === 'confirmed' &&
          result?.distinctEvidence === true &&
          result?.distinctContexts === 2));
    if (ok) passed++;
    else failed++;
    console.log(
      'T26_G2',
      JSON.stringify({
        id: flow.id,
        variant: mode,
        passed: ok,
        status: r.status,
        verdicts: result?.caseVerdicts ?? null,
      }),
    );
  }
}
console.log(
  'T26_G2_SUMMARY',
  JSON.stringify({
    total: passed + failed,
    passed,
    failed,
    model: 'synthetic G2 only, never real G3',
  }),
);
if (failed) process.exitCode = 1;
