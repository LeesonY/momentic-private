import type { NodeTarget, BrowserSnapshot } from '@localqa/contracts';
import type { APIResponse, Route } from 'playwright';
import type { TrustedAuthPrimitives } from './private-auth.js';
import { STABLE_REASON_CODES, type ApprovedAuthState } from './types.js';
import { AuthStateError, validateApprovedAuthState } from './auth-state.js';
import { resolveTarget } from './resolver.js';
import type { BrowserSessionImpl } from './session.js';

const AUTH_URL_BLOCKED = STABLE_REASON_CODES.POLICY_DENIED;
const AUTH_HOST_UNREACHABLE = STABLE_REASON_CODES.BROWSER_UNAVAILABLE;
const REQUEST_LABEL_LIMIT = 200;
const REQUEST_METHOD_PATTERN = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/;

/**
 * A refused or unanswered request during a private sign-in.
 *
 * `safeDetail` is a bounded, secret-free label of the request (method, origin
 * and path only). The query string, fragment and userinfo never enter it, so a
 * blocked sign-in can name *what* was refused without leaking a code or token
 * that the login page happened to carry.
 */
export class AuthRequestBlockedError extends AuthStateError {
  readonly safeDetail: string;
  constructor(
    code:
      | typeof AUTH_URL_BLOCKED
      | typeof AUTH_HOST_UNREACHABLE
      | typeof STABLE_REASON_CODES.TARGET_NOT_ALLOWED,
    safeDetail: string,
  ) {
    super(code);
    this.name = 'AuthRequestBlockedError';
    this.safeDetail = safeDetail;
  }
}

/** `GET http://host/path`: method + origin + path, never query or fragment. */
export function authRequestLabel(method: string, input: string): string {
  const verb = REQUEST_METHOD_PATTERN.test(method.toUpperCase())
    ? method.toUpperCase()
    : 'REQUEST';
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return `${verb} ${url.protocol}`;
    const path = url.pathname
      .replace(/\p{Cc}/gu, '')
      .replace(/\s+/g, '')
      .slice(0, REQUEST_LABEL_LIMIT);
    const label = `${verb} ${url.origin}${path}`;
    return label.length > REQUEST_LABEL_LIMIT
      ? `${label.slice(0, REQUEST_LABEL_LIMIT)}…`
      : label;
  } catch {
    return verb;
  }
}

function errorPageUrl(page: { url(): string }): boolean {
  return page.url().startsWith('chrome-error:');
}

/**
 * Real Chromium operations for the private, server-granted auth flow.
 * This capability is deliberately NOT on BrowserSession or the model ToolCall
 * surface. Only trusted Worker code may construct it from an owned session.
 *
 * The route is installed before navigation. Playwright's route.continue()
 * follows redirects without reentering handlers; to guarantee scope we fetch
 * exactly one hop. A redirect is fulfilled back to Chromium so its NEXT
 * request is intercepted as a fresh route and checked against approved
 * origins before the network sees it. This also allows same-origin login
 * redirects without handing cross-origin redirects to route.fetch.
 */
export function createTrustedBrowserAuthPrimitives(
  session: BrowserSessionImpl,
  origins: readonly string[],
): TrustedAuthPrimitives {
  const page = session.getPage();
  const context = session.getContext();
  const allowed = new Set<string>();
  for (const input of origins) {
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      throw new AuthStateError('TARGET_NOT_ALLOWED');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new AuthStateError('TARGET_NOT_ALLOWED');
    }
    allowed.add(parsed.origin);
  }
  if (!allowed.size || session.isClosed) {
    throw new AuthStateError('TARGET_NOT_ALLOWED');
  }

  function checkUrl(input: string): void {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new AuthStateError('TARGET_NOT_ALLOWED');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      !allowed.has(url.origin)
    ) {
      throw new AuthStateError('TARGET_NOT_ALLOWED');
    }
  }

  let closed = false;
  // The last request this gate refused or could not reach, so an aborted
  // navigation can be reported with its real cause instead of a bare stall.
  let refusal:
    | {
        code: typeof AUTH_URL_BLOCKED | typeof AUTH_HOST_UNREACHABLE;
        safeDetail: string;
      }
    | undefined;
  let lastNavigation = '';

  function rememberRefusal(
    code: typeof AUTH_URL_BLOCKED | typeof AUTH_HOST_UNREACHABLE,
    method: string,
    url: string,
  ): void {
    refusal = { code, safeDetail: authRequestLabel(method, url) };
  }

  /** The recorded refusal, or a bounded fallback when nothing was attributed. */
  function blockedError(): AuthRequestBlockedError {
    if (refusal)
      return new AuthRequestBlockedError(refusal.code, refusal.safeDetail);
    return new AuthRequestBlockedError(
      AUTH_HOST_UNREACHABLE,
      lastNavigation ? authRequestLabel('GET', lastNavigation) : 'REQUEST',
    );
  }

  function checkActive(): void {
    if (closed || session.isClosed || page.isClosed()) {
      throw new AuthStateError(STABLE_REASON_CODES.VALIDATION_ERROR);
    }
  }

  function checkPage(): void {
    checkActive();
    // An aborted navigation leaves Chromium on its own error page; report the
    // request that failed rather than an opaque target-scope denial.
    if (errorPageUrl(page)) throw blockedError();
    checkUrl(page.url());
  }

  const authRoute = async (route: Route) => {
    const request = route.request();
    try {
      checkActive();
      try {
        checkUrl(request.url());
      } catch {
        rememberRefusal(AUTH_URL_BLOCKED, request.method(), request.url());
        await route.abort('blockedbyclient').catch(() => {});
        return;
      }
      // Never follow a Location in the request client: that would bypass this
      // handler. Chromium follows fulfilled redirects as a new intercepted
      // request, including the POST -> GET transition for 303 responses.
      let response: APIResponse;
      try {
        response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
      } catch {
        rememberRefusal(AUTH_HOST_UNREACHABLE, request.method(), request.url());
        await route.abort('blockedbyclient').catch(() => {});
        return;
      }
      if (response.status() >= 300 && response.status() < 400) {
        const location = response.headers()['location'];
        if (!location) {
          rememberRefusal(AUTH_URL_BLOCKED, request.method(), request.url());
          await route.abort('blockedbyclient').catch(() => {});
          return;
        }
        let next: URL;
        try {
          next = new URL(location, response.url());
          checkUrl(next.href);
        } catch {
          rememberRefusal(AUTH_URL_BLOCKED, 'GET', String(location));
          await route.abort('blockedbyclient').catch(() => {});
          return;
        }
        await route.fulfill({ response });
        return;
      }
      await route.fulfill({ response });
    } catch {
      await route.abort('blockedbyclient').catch(() => {});
    }
  };
  const routeReady = context.route('**/*', authRoute);

  async function fresh(): Promise<BrowserSnapshot> {
    checkPage();
    return session.getSnapshot({ forceFresh: true });
  }

  async function targetLocator(target: NodeTarget) {
    checkPage();
    const current = await session.getSnapshot();
    if (
      target.snapshotId !== current.snapshotId ||
      target.pageId !== current.pageId
    ) {
      throw new AuthStateError('VALIDATION_ERROR');
    }
    const resolved = await resolveTarget(page, target, current);
    if (resolved.status !== 'resolved') {
      throw new AuthStateError('VALIDATION_ERROR');
    }
    return resolved.locator;
  }

  let prepared = false;
  return {
    async close() {
      closed = true;
      await routeReady;
      // Remove only this private guard, not the task's other network policies.
      await context.unroute('**/*', authRoute);
    },
    async navigate(url) {
      checkActive();
      checkUrl(url);
      refusal = undefined;
      lastNavigation = url;
      await routeReady;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        throw blockedError();
      }
      if (errorPageUrl(page)) throw blockedError();
      return fresh();
    },
    async fill(target, secret) {
      await routeReady;
      const locator = await targetLocator(target);
      await locator.fill(secret, { timeout: 10000 });
      return fresh();
    },
    async submit(target) {
      await routeReady;
      const locator = await targetLocator(target);
      await locator.click({ timeout: 10000 });
      return fresh();
    },
    async prepareState(raw) {
      checkActive();
      await routeReady;
      if (prepared) throw new AuthStateError('VALIDATION_ERROR');
      const state = validateApprovedAuthState(raw, origins);
      // A failed import must not be replayed as a new authority attempt.
      prepared = true;
      if (state.cookies?.length) await context.addCookies(state.cookies);
      if (state.origins?.length) {
        await context.addInitScript((entries) => {
          const entry = entries.find((item) => item.origin === location.origin);
          if (!entry) return;
          for (const item of entry.localStorage) {
            localStorage.setItem(item.name, item.value);
          }
        }, state.origins);
      }
    },
    async exportState(): Promise<ApprovedAuthState> {
      await routeReady;
      checkPage();
      const state = await context.storageState();
      return validateApprovedAuthState(
        {
          cookies: state.cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite,
          })),
          origins: state.origins.map((entry) => ({
            origin: entry.origin,
            localStorage: entry.localStorage.map((item) => ({
              name: item.name,
              value: item.value,
            })),
          })),
        },
        origins,
      );
    },
  };
}
