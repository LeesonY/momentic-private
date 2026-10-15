import { parseContract } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import {
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
} from '../auth.js';
import { ApiError } from '../errors.js';
import { LoginThrottle, clientIdentity } from '../loginThrottle.js';
import { parsePagination, paginate, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

/** One throttle per API process: logins are cheap and the window is minutes. */
const loginThrottle = new LoginThrottle();

export function registerAuthRoutes(router: Router): void {
  // POST /api/v1/auth/login
  router.post('/api/v1/auth/login', async (ctx: RequestContext) => {
    const raw = (ctx.body ?? {}) as {
      email?: string;
      username?: string;
      password?: string;
    };
    const email = raw.email ?? raw.username ?? '';
    const loginInput = parseContract('LoginInput', {
      email,
      password: raw.password ?? '',
    });

    // Throttle before verifying, so a flood costs no password hashing and the
    // response time does not reveal whether the account exists.
    const clientId = clientIdentity(ctx.headers, ctx.req.socket.remoteAddress);
    const decision = loginThrottle.inspect(loginInput.email, clientId);
    if (decision.limited) {
      ctx.res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new ApiError(
        'RATE_LIMITED',
        'Too many failed sign-in attempts. Try again later.',
        429,
      );
    }

    const isSecure = ctx.req.headers['x-forwarded-proto'] === 'https';
    let login: Awaited<ReturnType<typeof ctx.api.accountsRepo.login>>;
    try {
      login = await ctx.api.accountsRepo.login(loginInput);
    } catch (error) {
      if (error instanceof StorageError && error.code === 'UNAUTHENTICATED') {
        loginThrottle.recordFailure(loginInput.email, clientId);
      }
      throw error;
    }
    loginThrottle.recordSuccess(loginInput.email, clientId);
    setSessionCookie(ctx.res, login.token, 86400, isSecure);

    ctx.res.statusCode = 200;
    return parseContract('LoginResult', login.result);
  });

  // POST /api/v1/auth/logout
  router.post('/api/v1/auth/logout', async (ctx: RequestContext) => {
    const cookies = parseCookies(ctx.headers['cookie']);
    const token = cookies['session'];
    if (token) {
      await ctx.api.accountsRepo.logout(token).catch(() => {});
    }
    const isSecure = ctx.req.headers['x-forwarded-proto'] === 'https';
    clearSessionCookie(ctx.res, isSecure);

    ctx.res.statusCode = 204;
    return null;
  });

  // GET /api/v1/auth/me
  router.get('/api/v1/auth/me', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    ctx.res.statusCode = 200;
    return parseContract('User', ctx.user);
  });

  // GET /api/v1/users
  router.get('/api/v1/users', async (ctx: RequestContext) => {
    await requireAdmin(ctx);
    const users = await ctx.api.accountsRepo.list(ctx.actor!);
    const { limit, offset } = parsePagination(ctx.query);
    const page = paginate(users, limit, offset);

    ctx.res.statusCode = 200;
    return parseContract('UserPage', page);
  });

  // POST /api/v1/users
  router.post('/api/v1/users', async (ctx: RequestContext) => {
    await requireAdmin(ctx);
    const input = parseContract('UserCreate', ctx.body);
    const created = await ctx.api.accountsRepo.create(ctx.actor!, input);

    ctx.res.statusCode = 201;
    return parseContract('User', created);
  });

  // PATCH /api/v1/users/{userId}
  router.patch('/api/v1/users/{userId}', async (ctx: RequestContext) => {
    await requireAdmin(ctx);
    const input = parseContract('UserPatch', ctx.body);
    const updated = await ctx.api.accountsRepo.update(
      ctx.actor!,
      ctx.params.userId!,
      input,
    );

    ctx.res.statusCode = 200;
    return parseContract('User', updated);
  });
}
