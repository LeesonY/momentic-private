import { lstat } from 'node:fs/promises';
import { SecretVault } from '../../packages/storage/dist/index.js';

export async function loadProtectedKek(
  path = process.env.MASTER_KEY_FILE || '/run/secrets/kek.json',
) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(
      'KEK mount unavailable or unreadable; verify protected mount and owner',
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('KEK mount must be a regular file, not a symlink');
  if ((stat.mode & 0o077) !== 0)
    throw new Error(
      'KEK permission invalid: remove group/other access (mode 0400 or 0600)',
    );
  if (stat.uid !== process.getuid())
    throw new Error('KEK owner invalid: owner must match application UID');
  if (stat.size > 65536) throw new Error('KEK file exceeds 64 KiB');
  try {
    return await SecretVault.fromProtectedFile(path);
  } catch {
    throw new Error(
      'KEK unavailable: check file readability and key-ring JSON format without logging key material',
    );
  }
}
