import { readFile } from 'node:fs/promises';
import {
  InternalServiceVerifier,
  ServiceIdentityError,
  parseServiceIdentityDocument,
} from '@localqa/service-identity';
import { ApiError } from './errors.js';

export const DEFAULT_SERVICE_IDENTITY_FILE = '/run/secrets/service_identity.json';

/**
 * Loads the internal service key ring. Fail closed: a missing or malformed file
 * must stop the API from serving `/internal/v1/*` rather than degrading to an
 * unauthenticated internal surface.
 */
export async function loadServiceIdentity(
  file = process.env.SERVICE_IDENTITY_FILE || DEFAULT_SERVICE_IDENTITY_FILE,
): Promise<InternalServiceVerifier> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new ServiceIdentityError(
      'NOT_CONFIGURED',
      'service identity file is not readable',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceIdentityError(
      'MALFORMED_CREDENTIAL',
      'service identity file is not valid JSON',
    );
  }
  return new InternalServiceVerifier(parseServiceIdentityDocument(parsed));
}

/**
 * Uniform rejection for every internal-authentication failure. The reason code
 * is safe to log (it never contains key material); the client response is
 * deliberately generic so a caller cannot enumerate service ids or key versions.
 */
export function toInternalAuthError(error: ServiceIdentityError): ApiError {
  if (error.code === 'NOT_CONFIGURED')
    return new ApiError(
      'SERVICE_UNAVAILABLE',
      'Internal API service identity is not configured',
      503,
    );
  return new ApiError(
    'FORBIDDEN',
    'Internal service authentication failed',
    403,
  );
}
