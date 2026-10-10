import type { ServerResponse } from 'node:http';
import { StorageError } from '@localqa/storage';
import { ApiError } from './errors.js';
import type { RequestContext } from './types.js';
import { authenticateApiKey } from './apiKeys.js';

export function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      cookies[key] = decodeURIComponent(val);
    }
  }
  return cookies;
}

export function validateOriginAndCsrf(ctx: RequestContext): void {
  const method = ctx.method.toUpperCase();
  // Safe methods do not mutate state
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return;

  // Check Sec-Fetch-Site
  const secFetchSite = ctx.headers['sec-fetch-site'];
  if (secFetchSite === 'cross-site') {
    throw new ApiError('FORBIDDEN', 'Cross-site request blocked', 403);
  }

  // Check Origin if present
  const origin = ctx.headers['origin'];
  if (origin) {
    try {
      const originUrl = new URL(origin);
      // Compare the full scheme+host+port origin to prevent a POST from a
      // downgraded HTTP origin with the same hostname as the HTTPS frontend.
      // A reverse proxy can use an internal Host, so the configured public
      // frontend origin is the authority when one is available.
      if (ctx.api.publicOrigin) {
        if (originUrl.origin !== new URL(ctx.api.publicOrigin).origin) {
          throw new ApiError('FORBIDDEN', 'Origin mismatch', 403);
        }
      } else if (originUrl.host !== (ctx.headers['host'] || '')) {
        // Development-only same-host fallback when PUBLIC_ORIGIN is absent.
        throw new ApiError('FORBIDDEN', 'Origin mismatch', 403);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('FORBIDDEN', 'Invalid Origin header', 403);
    }
  }
}

export async function requireAuth(ctx: RequestContext): Promise<void> {
  validateOriginAndCsrf(ctx);
  const authorization = ctx.headers['authorization'];
  if (authorization !== undefined) {
    // API keys are not browser sessions. The dedicated route allowlist,
    // project binding and live creator membership checks are mandatory.
    await authenticateApiKey(ctx, authorization);
    return;
  }
  const cookies = parseCookies(ctx.headers['cookie']);
  const token = cookies['session'];
  if (!token) {
    throw new StorageError('UNAUTHENTICATED');
  }

  const user = await ctx.api.accountsRepo.authenticate(token);
  ctx.user = user;
  ctx.actor = { userId: user.id };
}

export async function requireAdmin(ctx: RequestContext): Promise<void> {
  await requireAuth(ctx);
  if (!ctx.user || ctx.user.globalRole !== 'admin') {
    throw new StorageError('FORBIDDEN');
  }
}

export function rejectUserCookieForInternal(ctx: RequestContext): void {
  const cookie = ctx.headers['cookie'];
  if (cookie && cookie.includes('session=')) {
    throw new ApiError(
      'FORBIDDEN',
      'Internal endpoints reject user cookie sessions',
      403,
    );
  }
}

export function setSessionCookie(
  res: ServerResponse,
  token: string,
  maxAgeSeconds = 3600,
  isSecure = false,
): void {
  const secureFlag = isSecure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureFlag}`,
  );
}

export function clearSessionCookie(
  res: ServerResponse,
  isSecure = false,
): void {
  const secureFlag = isSecure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`,
  );
}
