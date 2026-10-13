import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';

// Exercise the gate in isolated project-local scratch. The old test temporarily
// corrupted shared generated files, racing with concurrent CI and builds.
test('generation gate rejects stale TS, schema snapshots and source hash manifest', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const scratchRoot = fileURLToPath(
    new URL('../../../.localqa-t01/', import.meta.url),
  );
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, 'drift-'));
  const run = () =>
    spawnSync(
      process.execPath,
      ['scripts/generate.mjs', '--check', `--check-dir=${scratch}`],
      {
        cwd,
        encoding: 'utf8',
      },
    );
  try {
    for (const filename of ['types.ts', 'schemas.json', 'manifest.json']) {
      copyFileSync(
        new URL(`../src/generated/${filename}`, import.meta.url),
        join(scratch, filename),
      );
    }
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    for (const filename of ['types.ts', 'schemas.json', 'manifest.json']) {
      const path = join(scratch, filename);
      const original = readFileSync(path);
      writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
      const result = run();
      assert.equal(result.status, 1, filename);
      assert(
        result.stderr.includes(`Generated file drift: ${filename}`),
        result.stderr,
      );
      writeFileSync(path, original);
    }
    const restored = run();
    assert.equal(restored.status, 0, restored.stderr);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
