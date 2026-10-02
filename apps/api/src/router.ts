import type { RouteHandler, RouteMatch } from './types.js';

interface RouteDefinition {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: RouteDefinition[] = [];

  public add(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const regexPattern = path
      .replace(/{([a-zA-Z0-9_]+)}/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      })
      .replace(/\//g, '\\/');

    const pattern = new RegExp(`^${regexPattern}$`);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      paramNames,
      handler,
    });
  }

  public get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }

  public post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }

  public patch(path: string, handler: RouteHandler): void {
    this.add('PATCH', path, handler);
  }

  public put(path: string, handler: RouteHandler): void {
    this.add('PUT', path, handler);
  }

  public delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler);
  }

  public match(method: string, pathname: string): RouteMatch | null {
    const m = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== m) continue;
      const match = route.pattern.exec(pathname);
      if (match) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          params[route.paramNames[i]!] = decodeURIComponent(match[i + 1]!);
        }
        return {
          handler: route.handler,
          params,
        };
      }
    }
    return null;
  }
}

export function parsePagination(query: Record<string, string>): {
  limit: number;
  offset: number;
  cursor: string | null;
} {
  let limit = 20;
  if (query['limit']) {
    const parsed = parseInt(query['limit'], 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 100) {
      limit = parsed;
    }
  }

  let offset = 0;
  const cursor = query['cursor'] || null;
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const num = parseInt(decoded, 10);
      if (!Number.isNaN(num) && num >= 0) {
        offset = num;
      }
    } catch {
      // Invalid cursor defaults to 0
    }
  }

  return { limit, offset, cursor };
}

export function paginate<T>(
  items: T[],
  limit: number,
  offset: number,
): { items: T[]; nextCursor: string | null } {
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const nextCursor =
    nextOffset < items.length
      ? Buffer.from(String(nextOffset)).toString('base64url')
      : null;

  return { items: pageItems, nextCursor };
}
