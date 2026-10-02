import type { Summary } from '@localqa/contracts';
import { parseContract } from '@localqa/contracts';

export type CaseOutcome =
  'passed' | 'issue_found' | 'blocked' | 'inconclusive' | 'not_run';

export function calculateSummary(outcomes: readonly CaseOutcome[]): Summary {
  let passed = 0;
  let issueFound = 0;
  let blocked = 0;
  let inconclusive = 0;
  let notRun = 0;

  for (const outcome of outcomes) {
    switch (outcome) {
      case 'passed':
        passed++;
        break;
      case 'issue_found':
        issueFound++;
        break;
      case 'blocked':
        blocked++;
        break;
      case 'inconclusive':
        inconclusive++;
        break;
      case 'not_run':
        notRun++;
        break;
      default:
        inconclusive++;
        break;
    }
  }

  const planned = passed + issueFound + blocked + inconclusive + notRun;
  const attempted = passed + issueFound + blocked + inconclusive;
  const evaluated = passed + issueFound;

  const passRate =
    evaluated === 0
      ? null
      : Number(Math.min(1, Math.max(0, passed / evaluated)).toFixed(4));

  const attemptRate =
    planned === 0
      ? null
      : Number(Math.min(1, Math.max(0, attempted / planned)).toFixed(4));

  const summary: Summary = {
    planned,
    passed,
    issueFound,
    blocked,
    inconclusive,
    notRun,
    attempted,
    evaluated,
    passRate,
    attemptRate,
  };

  return parseContract('Summary', summary);
}
