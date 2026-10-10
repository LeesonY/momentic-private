import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { auditT35 } from './t35-g3-audit.mjs';

const directory = join(
  fileURLToPath(new URL('../', import.meta.url)),
  'docs/validation-results',
);
const rows = readFileSync(
  join(directory, 'T35-g3-moan2-business.ndjson'),
  'utf8',
)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const result = auditT35(rows);
writeFileSync(
  join(directory, 'T35-g3-independent-audit.json'),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(
  'T35_AUDIT',
  JSON.stringify({
    sampleCount: result.sampleCount,
    complete: result.complete,
    healthy: result.healthy,
    seededFault: result.seededFault,
    observedProviderRequestsLowerBound:
      result.usage.observedProviderRequestsLowerBound,
    formalG3Approved: false,
  }),
);
