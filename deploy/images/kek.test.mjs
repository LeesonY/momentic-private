import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadProtectedKek } from './kek.mjs';

test('KEK startup emits safe, actionable permission and format reasons without key material', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'localqa-t09b-kek-'));
  const path = join(dir, 'kek.json');
  const key = randomBytes(32).toString('base64');
  try {
    await assert.rejects(
      loadProtectedKek(path),
      /mount unavailable or unreadable/,
    );
    await writeFile(
      path,
      JSON.stringify({ activeVersion: 1, keys: { 1: key } }),
      { mode: 0o600 },
    );
    await chmod(path, 0o644);
    await assert.rejects(loadProtectedKek(path), (error) => {
      assert.match(error.message, /remove group\/other access/);
      assert.ok(!error.message.includes(key));
      return true;
    });
    await chmod(path, 0o600);
    const vault = await loadProtectedKek(path);
    assert.equal(vault.activeVersion, 1);
    vault.dispose();
    await writeFile(path, '{', { mode: 0o600 });
    await assert.rejects(loadProtectedKek(path), /key-ring JSON format/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
