/**
 * Internal service identity for the `/internal/v1/*` boundary.
 *
 * The internal HTTP surface is reachable from every container on the compose
 * network, so peer identity cannot come from a self-declared header such as
 * `X-Worker-Id`. This module implements request-level HMAC authentication with
 * a versioned key ring loaded from a protected file, which gives us:
 *
 *  - per-service keys (a leaked worker key cannot impersonate the orchestrator),
 *  - rotation and revocation by editing the key ring (no code change),
 *  - replay resistance (short timestamp window + one-shot nonce),
 *  - body integrity (the request body hash is part of the signed string).
 *
 * The signing key never appears in a request, so it cannot leak through logs.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const SERVICE_IDENTITY_HEADERS = Object.freeze({
  service: 'x-localqa-service',
  keyVersion: 'x-localqa-key-version',
  timestamp: 'x-localqa-timestamp',
  nonce: 'x-localqa-nonce',
  signature: 'x-localqa-signature',
});

/** Timestamp tolerance. Bounded so a captured request cannot stay valid. */
export const SERVICE_IDENTITY_MAX_SKEW_MS = 120_000;
/** Nonce retention: twice the skew window keeps replayed requests rejected. */
export const SERVICE_IDENTITY_NONCE_TTL_MS = 300_000;
const MAX_TRACKED_NONCES = 20_000;

export type ServiceIdentityFailure =
  | 'MISSING_CREDENTIAL'
  | 'MALFORMED_CREDENTIAL'
  | 'UNKNOWN_SERVICE'
  | 'UNKNOWN_KEY'
  | 'STALE_TIMESTAMP'
  | 'REPLAYED_NONCE'
  | 'BAD_SIGNATURE'
  | 'NOT_CONFIGURED';

export class ServiceIdentityError extends Error {
  constructor(
    public readonly code: ServiceIdentityFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceIdentityError';
  }
}

export interface ServiceKeyRing {
  activeVersion: number;
  keys: Record<string, string>;
}

export interface ServiceIdentityDocument {
  activeVersion: number;
  services: Record<string, ServiceKeyRing>;
}

interface LoadedService {
  activeVersion: number;
  keys: Map<number, Buffer>;
}

export interface ServiceClientCredential {
  serviceId: string;
  keyVersion: number;
  secret: Buffer;
}

export interface InternalRequestSignatureInput {
  method: string;
  /** Pathname plus query string, exactly as sent on the wire. */
  path: string;
  rawBody: Uint8Array | undefined;
}

export interface InternalRequestCredential extends InternalRequestSignatureInput {
  serviceId: string;
  keyVersion: number;
  timestampMs: number;
  nonce: string;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function decodeKey(value: unknown, label: string): Buffer {
  if (typeof value !== 'string') {
    throw new ServiceIdentityError(
      'MALFORMED_CREDENTIAL',
      `${label} must be a base64 or hex string`,
    );
  }
  // Accept base64 (>=32 bytes) or 64-char hex for operational convenience.
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (key.length < 32) {
    throw new ServiceIdentityError(
      'MALFORMED_CREDENTIAL',
      `${label} must decode to at least 32 bytes`,
    );
  }
  return key;
}

export function parseServiceIdentityDocument(
  raw: unknown,
): Map<string, LoadedService> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ServiceIdentityError(
      'MALFORMED_CREDENTIAL',
      'service identity document must be an object',
    );
  }
  const services = (raw as Partial<ServiceIdentityDocument>).services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new ServiceIdentityError(
      'MALFORMED_CREDENTIAL',
      'service identity document requires a services map',
    );
  }
  const loaded = new Map<string, LoadedService>();
  for (const [serviceId, entry] of Object.entries(services)) {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(serviceId)) {
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        `service id '${serviceId}' is not a safe identifier`,
      );
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        `service '${serviceId}' entry must be an object`,
      );
    }
    const ring = entry as Partial<ServiceKeyRing>;
    if (!isPositiveInt(ring.activeVersion)) {
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        `service '${serviceId}' requires a positive activeVersion`,
      );
    }
    if (!ring.keys || typeof ring.keys !== 'object' || Array.isArray(ring.keys))
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        `service '${serviceId}' requires a keys map`,
      );
    const keys = new Map<number, Buffer>();
    for (const [versionText, value] of Object.entries(ring.keys)) {
      if (!/^[1-9][0-9]*$/.test(versionText)) {
        throw new ServiceIdentityError(
          'MALFORMED_CREDENTIAL',
          `service '${serviceId}' key version '${versionText}' is invalid`,
        );
      }
      keys.set(
        Number(versionText),
        decodeKey(value, `service '${serviceId}' key ${versionText}`),
      );
    }
    if (keys.size === 0)
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        `service '${serviceId}' has no usable keys`,
      );
    if (!keys.has(ring.activeVersion))
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        `service '${serviceId}' activeVersion ${ring.activeVersion} has no key material`,
      );
    loaded.set(serviceId, { activeVersion: ring.activeVersion, keys });
  }
  if (loaded.size === 0)
    throw new ServiceIdentityError(
      'MALFORMED_CREDENTIAL',
      'service identity document defines no services',
    );
  return loaded;
}

/**
 * Canonical string binding every security-relevant part of the request.
 * Field order is fixed; every field is newline-terminated and the final field
 * is a fixed-width digest, so no field boundary is ambiguous.
 */
export function canonicalInternalRequest(
  input: InternalRequestCredential,
): string {
  const bodyHash = createHash('sha256')
    .update(input.rawBody ?? new Uint8Array())
    .digest('hex');
  return [
    'localqa-internal-v1',
    input.serviceId.toLowerCase(),
    String(input.keyVersion),
    String(input.timestampMs),
    input.nonce.toLowerCase(),
    input.method.toUpperCase(),
    input.path,
    bodyHash,
  ].join('\n');
}

export function computeInternalSignature(
  secret: Uint8Array,
  input: InternalRequestCredential,
): string {
  return createHmac('sha256', secret)
    .update(canonicalInternalRequest(input))
    .digest('hex');
}

export type SignedInternalRequestHeaders = Record<string, string>;

export interface SignedInternalRequest {
  headers: SignedInternalRequestHeaders;
  timestampMs: number;
  nonce: string;
}

/** Signing side: used by internal HTTP clients. Never logs the secret. */
export class InternalServiceSigner {
  constructor(
    private readonly config: {
      serviceId: string;
      keyVersion: number;
      secret: Uint8Array;
      now?: () => number;
    },
  ) {
    if (!config.serviceId) throw new Error('serviceId is required');
    if (!Number.isSafeInteger(config.keyVersion) || config.keyVersion <= 0)
      throw new Error('keyVersion must be a positive integer');
    if (config.secret.length < 32)
      throw new Error('service secret must be at least 32 bytes');
  }

  sign(input: InternalRequestSignatureInput): SignedInternalRequest {
    const timestampMs = (this.config.now ?? Date.now)();
    const nonce = randomBytes(16).toString('hex');
    const signature = computeInternalSignature(this.config.secret, {
      ...input,
      serviceId: this.config.serviceId,
      keyVersion: this.config.keyVersion,
      timestampMs,
      nonce,
    });
    return {
      headers: {
        [SERVICE_IDENTITY_HEADERS.service]: this.config.serviceId,
        [SERVICE_IDENTITY_HEADERS.keyVersion]: String(this.config.keyVersion),
        [SERVICE_IDENTITY_HEADERS.timestamp]: String(timestampMs),
        [SERVICE_IDENTITY_HEADERS.nonce]: nonce,
        [SERVICE_IDENTITY_HEADERS.signature]: signature,
      },
      timestampMs,
      nonce,
    };
  }
}

export interface VerifyInternalRequestInput {
  headers: Record<string, string | undefined>;
  method: string;
  path: string;
  rawBody: Uint8Array | undefined;
}

/** Verification side: used by the API. */
export class InternalServiceVerifier {
  private readonly seen = new Map<string, number>();
  private readonly services: Map<string, LoadedService>;
  private readonly now: () => number;

  constructor(
    document: Map<string, LoadedService> | ServiceIdentityDocument,
    options: { now?: () => number } = {},
  ) {
    this.services =
      document instanceof Map
        ? document
        : parseServiceIdentityDocument(document);
    this.now = options.now ?? Date.now;
  }

  get serviceIds(): string[] {
    return [...this.services.keys()];
  }

  activeKeyVersion(serviceId: string): number {
    return this.#service(serviceId).activeVersion;
  }

  /** Exposes the active key for a service to trusted in-process callers only. */
  activeSecret(serviceId: string): Buffer {
    const service = this.#service(serviceId);
    const key = service.keys.get(service.activeVersion);
    if (!key)
      throw new ServiceIdentityError(
        'UNKNOWN_KEY',
        `service '${serviceId}' active key is missing`,
      );
    return key;
  }

  #service(serviceId: string): LoadedService {
    const service = this.services.get(serviceId.trim().toLowerCase());
    if (!service)
      throw new ServiceIdentityError(
        'UNKNOWN_SERVICE',
        'internal service credential is not recognized',
      );
    return service;
  }

  verify(input: VerifyInternalRequestInput): { serviceId: string } {
    const header = (name: string) => input.headers[name];
    const rawServiceId = header(SERVICE_IDENTITY_HEADERS.service);
    const keyVersionText = header(SERVICE_IDENTITY_HEADERS.keyVersion);
    const timestamp = header(SERVICE_IDENTITY_HEADERS.timestamp);
    const nonce = header(SERVICE_IDENTITY_HEADERS.nonce);
    const signature = header(SERVICE_IDENTITY_HEADERS.signature);
    if (
      !rawServiceId ||
      !keyVersionText ||
      !timestamp ||
      !nonce ||
      !signature
    ) {
      throw new ServiceIdentityError(
        'MISSING_CREDENTIAL',
        'internal service credential is required',
      );
    }

    const serviceId = rawServiceId.trim().toLowerCase();
    const service = this.services.get(serviceId);
    if (!service)
      throw new ServiceIdentityError(
        'UNKNOWN_SERVICE',
        'internal service credential is not recognized',
      );

    if (!/^[1-9][0-9]*$/.test(keyVersionText))
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        'internal key version is malformed',
      );
    const keyVersion = Number(keyVersionText);
    const secret = service.keys.get(keyVersion);
    // Revoking a key version simply removes it from the ring.
    if (!secret)
      throw new ServiceIdentityError(
        'UNKNOWN_KEY',
        'internal key version is not accepted',
      );

    if (!/^[0-9]{1,19}$/.test(timestamp))
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        'internal timestamp is malformed',
      );
    const timestampMs = Number(timestamp);
    if (!Number.isSafeInteger(timestampMs))
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        'internal timestamp is malformed',
      );
    if (!/^[0-9a-f]{16,64}$/i.test(nonce))
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        'internal nonce is malformed',
      );
    if (!/^[0-9a-f]{64}$/i.test(signature))
      throw new ServiceIdentityError(
        'MALFORMED_CREDENTIAL',
        'internal signature is malformed',
      );

    const now = this.now();
    if (Math.abs(now - timestampMs) > SERVICE_IDENTITY_MAX_SKEW_MS)
      throw new ServiceIdentityError(
        'STALE_TIMESTAMP',
        'internal credential timestamp is outside the accepted window',
      );

    const credential: InternalRequestCredential = {
      serviceId,
      keyVersion,
      timestampMs,
      nonce: nonce.toLowerCase(),
      method: input.method,
      path: input.path,
      rawBody: input.rawBody,
    };
    const expected = Buffer.from(
      computeInternalSignature(secret, credential),
      'hex',
    );
    const provided = Buffer.from(signature, 'hex');
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      throw new ServiceIdentityError(
        'BAD_SIGNATURE',
        'internal signature does not match the request',
      );

    this.#rememberNonce(serviceId, credential.nonce, now);
    return { serviceId };
  }

  #rememberNonce(serviceId: string, nonce: string, now: number): void {
    for (const [key, seenAt] of this.seen) {
      if (now - seenAt > SERVICE_IDENTITY_NONCE_TTL_MS) this.seen.delete(key);
      else break;
    }
    const key = `${serviceId}:${nonce}`;
    if (this.seen.has(key))
      throw new ServiceIdentityError(
        'REPLAYED_NONCE',
        'internal credential was already used',
      );
    if (this.seen.size >= MAX_TRACKED_NONCES) {
      // Bounded memory: drop the oldest half rather than growing without limit.
      const victims = [...this.seen.keys()].slice(0, MAX_TRACKED_NONCES / 2);
      for (const victim of victims) this.seen.delete(victim);
    }
    this.seen.set(key, now);
  }
}

/**
 * Reads a caller's active key from a key-ring file. Rotation only requires
 * replacing the file; nothing here pins a key version.
 */
export async function loadServiceClientCredential(
  file: string,
  serviceId: string,
): Promise<ServiceClientCredential> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    throw new ServiceIdentityError(
      'NOT_CONFIGURED',
      'service identity file is not readable JSON',
    );
  }
  const entry = parseServiceIdentityDocument(parsed).get(serviceId);
  if (!entry)
    throw new ServiceIdentityError(
      'UNKNOWN_SERVICE',
      `service identity document has no '${serviceId}' entry`,
    );
  const secret = entry.keys.get(entry.activeVersion);
  if (!secret)
    throw new ServiceIdentityError(
      'UNKNOWN_KEY',
      `service '${serviceId}' active key is missing`,
    );
  return { serviceId, keyVersion: entry.activeVersion, secret };
}
