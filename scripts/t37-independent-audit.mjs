// A strict, read-only independent audit. Never rewrite T36 or earlier samples.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { auditT36 } from './t36-audit-lib.mjs';

const directory = join(
  fileURLToPath(new URL('../', import.meta.url)),
  'docs/validation-results',
);
const rows = readFileSync(
  join(directory, 'T37-g3-moan2-business.ndjson'),
  'utf8',
)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const result = auditT36(rows, 'T37');
writeFileSync(
  join(directory, 'T37-g3-independent-audit.json'),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(
  'T37_AUDIT',
  JSON.stringify({
    samples: result.samples,
    complete: result.complete,
    healthy: result.healthy,
    seededFault: result.seededFault,
    providerRequestsObserved:
      result.knownUsage.observedProviderRequestsLowerBound,
    formalG3Approved: false,
  }),
);
