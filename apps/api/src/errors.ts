import { StorageError } from '@localqa/storage';
import { DomainError } from '@localqa/domain';
import type { Error as ContractError, ErrorCode } from '@localqa/contracts';
import { parseContract } from '@localqa/contracts';

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string = code,
    public readonly status?: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const STATUS_MAP: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  TARGET_NOT_ALLOWED: 422,
  MODEL_NOT_CONFIGURED: 409,
  CONFIG_IN_USE: 409,
  PROJECT_ARCHIVED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  EVENTS_EXPIRED: 410,
  RATE_LIMITED: 429,
  BROWSER_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  ARTIFACT_TOO_LARGE: 413,
  LEASE_EXPIRED: 409,
  ACTION_OUTCOME_UNKNOWN: 409,
};

export function toApiErrorResponse(
  error: unknown,
  requestId: string,
): { status: number; body: ContractError } {
  let code: ErrorCode = 'SERVICE_UNAVAILABLE';
  let message = 'An unexpected error occurred';
  let status = 500;
  let details: unknown = undefined;

  if (error instanceof ApiError) {
    code = error.code;
    message = error.message;
    status = error.status ?? STATUS_MAP[code] ?? 500;
    details = error.details;
  } else if (error instanceof StorageError) {
    // Service policy reasons use the existing HTTP permission error; they do
    // not become server failures or redefine the run/action reason vocabulary.
    code =
      error.code === 'SCOPE_CHANGED'
        ? 'LEASE_EXPIRED'
        : error.code === 'POLICY_DENIED'
          ? 'FORBIDDEN'
          : error.code;
    message =
      error.code === 'POLICY_DENIED'
        ? 'Operation is forbidden by policy'
        : code === 'LEASE_EXPIRED'
          ? 'Lease or scope is no longer current'
          : error.message;
    status = STATUS_MAP[code] ?? 500;
  } else if (error instanceof DomainError) {
    code = (
      STATUS_MAP[error.code] ? error.code : 'VALIDATION_ERROR'
    ) as ErrorCode;
    message = error.message;
    status = STATUS_MAP[code] ?? 422;
  } else if (error instanceof Error) {
    if (
      error.name === 'ContractValidationError' ||
      (error as { errors?: unknown }).errors
    ) {
      code = 'VALIDATION_ERROR';
      message = error.message || 'Request validation failed';
      status = 422;
    } else if (error.message in STATUS_MAP) {
      code = error.message as ErrorCode;
      message = error.message;
      status = STATUS_MAP[code]!;
    }
  }

  // Redact details to prevent leaking passwords, cookies, secrets, or raw prompt strings
  const sanitizedDetails = details ? sanitizeDetails(details) : undefined;

  const body = parseContract('Error', {
    code,
    message: message.slice(0, 4000),
    requestId,
    ...(sanitizedDetails !== undefined ? { details: sanitizedDetails } : {}),
  });

  return { status, body };
}

function sanitizeDetails(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeDetails);

  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lk = k.toLowerCase();
    if (
      lk.includes('password') ||
      lk.includes('secret') ||
      lk.includes('cookie') ||
      lk.includes('token') ||
      lk.includes('prompt') ||
      lk.includes('authorization') ||
      lk.includes('stack')
    ) {
      cleaned[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      cleaned[k] = sanitizeDetails(v);
    } else {
      cleaned[k] = v;
    }
  }
  return cleaned;
}
