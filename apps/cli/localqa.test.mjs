import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gate } from './localqa.mjs';

test('T11 CI exit policy distinguishes pass, actual failure and incomplete evidence', () => {
  const report = {
    run: { status: 'completed', terminationReason: 'normal' },
    summary: { planned: 1, passed: 1 },
    cases: [
      {
        outcome: 'passed',
        verdict: {
          status: 'passed',
          gaps: [],
          criterionResults: [
            { result: 'passed', criterionId: 'page', evidenceRefs: ['owned'] },
          ],
        },
      },
    ],
    coverageGaps: [],
    warnings: [],
    artifacts: [{ status: 'available', redaction: 'applied' }],
  };
  assert.equal(gate(report), 0);
  assert.equal(
    gate({
      ...report,
      cases: [
        {
          ...report.cases[0],
          outcome: 'issue_found',
          verdict: { ...report.cases[0].verdict, status: 'issue_found' },
        },
      ],
    }),
    1,
  );
  assert.equal(gate({ ...report, coverageGaps: ['not assessed'] }), 2);
  assert.equal(
    gate({ ...report, run: { ...report.run, status: 'cancelled' } }),
    2,
  );
  assert.equal(gate({ ...report, cases: [] }), 2);
  assert.equal(gate({ ...report, artifacts: [{ status: 'degraded' }] }), 2);
});
