import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Exercise the gate itself, changing only T01-owned generated files and restoring
// them even after failures. Child process scratch/logging stays in the project.
test('generation gate rejects stale TS, schema snapshots and source hash manifest', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const run = () =>
    spawnSync(process.execPath, ['scripts/generate.mjs', '--check'], {
      cwd,
      encoding: 'utf8',
    });
  for (const filename of ['types.ts', 'schemas.json', 'manifest.json']) {
    const path = new URL(`../src/generated/${filename}`, import.meta.url);
    const original = readFileSync(path);
    try {
      writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
      const result = run();
      assert.equal(result.status, 1, filename);
      assert(
        result.stderr.includes(`Generated file drift: ${filename}`),
        result.stderr,
      );
    } finally {
      writeFileSync(path, original);
    }
  }
  const restored = run();
  assert.equal(restored.status, 0, restored.stderr);
});
