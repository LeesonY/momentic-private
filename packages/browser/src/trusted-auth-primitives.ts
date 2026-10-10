import type { NodeTarget, BrowserSnapshot } from '@localqa/contracts';
import type { TrustedAuthPrimitives } from './private-auth.js';
import type { ApprovedAuthState } from './types.js';
import { AuthStateError, validateApprovedAuthState } from './auth-state.js';
import { resolveTarget } from './resolver.js';
import type { BrowserSessionImpl } from './session.js';

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

  function checkActive(): void {
    if (session.isClosed || page.isClosed()) {
      throw new AuthStateError('VALIDATION_ERROR');
    }
  }

  function checkPage(): void {
    checkActive();
    checkUrl(page.url());
  }

  const routeReady = context.route('**/*', async (route) => {
    try {
      checkUrl(route.request().url());
      // Never follow a Location in the request client: that would bypass this
      // handler. Chromium follows fulfilled redirects as a new intercepted
      // request, including the POST -> GET transition for 303 responses.
      const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
      if (response.status() >= 300 && response.status() < 400) {
        const location = response.headers()['location'];
        if (!location) {
          await route.abort('blockedbyclient');
          return;
        }
        const next = new URL(location, response.url());
        checkUrl(next.href);
        await route.fulfill({ response });
        return;
      }
      await route.fulfill({ response });
    } catch {
      await route.abort('blockedbyclient').catch(() => {});
    }
  });

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
    async navigate(url) {
      checkActive();
      checkUrl(url);
      await routeReady;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
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
