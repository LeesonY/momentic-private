import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { StorageError } from './database.js';

const COST = 131072,
  BLOCK = 8,
  PARALLEL = 1,
  LENGTH = 64;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      LENGTH,
      { N: COST, r: BLOCK, p: PARALLEL, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
export async function hashPassword(password: string): Promise<string> {
  if ([...password].length < 8 || [...password].length > 128)
    throw new StorageError('VALIDATION_ERROR');
  const salt = randomBytes(16),
    key = await derive(password, salt);
  const result = `scrypt$${COST}$${BLOCK}$${PARALLEL}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  key.fill(0);
  return result;
}
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  if ([...password].length > 128) return false;
  const parts = encoded.split('$');
  if (
    parts.length !== 6 ||
    parts.slice(0, 4).join('$') !== `scrypt$${COST}$${BLOCK}$${PARALLEL}`
  )
    return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64url'),
    expected = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length !== 16 || expected.length !== LENGTH) return false;
  const key = await derive(password, salt);
  try {
    return timingSafeEqual(key, expected);
  } finally {
    key.fill(0);
  }
}
export function hashPayload(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  }
  const serialized = JSON.stringify(canonical(value));
  if (serialized === undefined) throw new StorageError('VALIDATION_ERROR');
  return createHash('sha256').update(serialized).digest('hex');
}
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
export const newToken = (): string => randomBytes(32).toString('base64url');
export type CipherEnvelope = {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
};
export type SecretBinding = {
  projectId: string;
  secretId: string;
  purpose: string;
};
// Private key ring file: {activeVersion:1,keys:{"1":"base64-of-32-random-bytes"}}.
// AAD binds ciphertext to owner, secret, purpose and KEK version to prevent swaps.
export class SecretVault {
  readonly #keys = new Map<number, Buffer>();
  private constructor(
    readonly activeVersion: number,
    keys: Map<number, Buffer>,
  ) {
    this.#keys = keys;
  }
  static async fromProtectedFile(path: string): Promise<SecretVault> {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => {
      throw new StorageError('SERVICE_UNAVAILABLE');
    });
    let bytes: Buffer | undefined;
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.size > 65536
      )
        throw new StorageError('SERVICE_UNAVAILABLE');
      bytes = await handle.readFile();
      const data = JSON.parse(bytes.toString('utf8')) as {
        activeVersion: number;
        keys: Record<string, string>;
      };
      const keys = new Map<number, Buffer>();
      for (const [version, encoded] of Object.entries(data.keys)) {
        const numeric = Number(version),
          key = Buffer.from(encoded, 'base64');
        if (!Number.isSafeInteger(numeric) || numeric < 1 || key.length !== 32)
          throw new StorageError('SERVICE_UNAVAILABLE');
        keys.set(numeric, key);
      }
      if (
        !Number.isSafeInteger(data.activeVersion) ||
        !keys.has(data.activeVersion)
      )
        throw new StorageError('SERVICE_UNAVAILABLE');
      return new SecretVault(data.activeVersion, keys);
    } catch {
      throw new StorageError('SERVICE_UNAVAILABLE');
    } finally {
      bytes?.fill(0);
      await handle.close();
    }
  }
  #aad(binding: SecretBinding, version: number): Buffer {
    return Buffer.from(
      JSON.stringify([
        binding.projectId,
        binding.secretId,
        binding.purpose,
        version,
      ]),
    );
  }
  encrypt(plaintext: string, binding: SecretBinding): CipherEnvelope {
    const nonce = randomBytes(12),
      key = this.#keys.get(this.activeVersion);
    if (!key) throw new StorageError('SERVICE_UNAVAILABLE');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(this.#aad(binding, this.activeVersion));
    return {
      ciphertext: Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]),
      nonce,
      authTag: cipher.getAuthTag(),
      keyVersion: this.activeVersion,
    };
  }
  decrypt(envelope: CipherEnvelope, binding: SecretBinding): string {
    const key = this.#keys.get(envelope.keyVersion);
    if (!key) throw new StorageError('SERVICE_UNAVAILABLE');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce);
      decipher.setAAD(this.#aad(binding, envelope.keyVersion));
      decipher.setAuthTag(envelope.authTag);
      return Buffer.concat([
        decipher.update(envelope.ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new StorageError('SERVICE_UNAVAILABLE');
    }
  }
  rotate(envelope: CipherEnvelope, binding: SecretBinding): CipherEnvelope {
    return this.encrypt(this.decrypt(envelope, binding), binding);
  }
  dispose(): void {
    for (const key of this.#keys.values()) key.fill(0);
    this.#keys.clear();
  }
}
