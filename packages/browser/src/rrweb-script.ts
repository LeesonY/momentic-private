import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

let cached: string | null = null;

/** Load the bundled rrweb UMD script from node_modules. */
export function getRrwebScript(): string {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const mainPath = require.resolve('rrweb');
  const pkgDir = dirname(dirname(mainPath));
  const umdPath = join(pkgDir, 'dist', 'rrweb.umd.cjs');
  cached = readFileSync(umdPath, 'utf8');
  return cached;
}
