/**
 * The route table against the router, and docs/api.md against the table.
 *
 * The router is hand-rolled, so a route can be added to `server.ts` without
 * anyone touching `api-routes.ts`. These fail when that happens — and when a
 * row describes a route the source no longer dispatches.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_AREAS, API_ROUTES, API_SINCE, matchApiRoute, renderApiReference, TOKEN_REFUSALS } from './api-routes.js';
import { expandRegex, normaliseTemplate, scanRoutes } from './api-scan.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE = path.resolve(SRC, '..', '..', '..', 'docs', 'api.md');

describe('the scanner', () => {
  it('turns a route regex into its templates', () => {
    expect(expandRegex('^\\/api\\/jobs\\/([^/]+)\\/(retry|cancel)$')).toEqual(['/api/jobs/:_/retry', '/api/jobs/:_/cancel']);
    expect(expandRegex('^\\/api\\/memory\\/notes\\/([0-9a-f-]{36})(\\/forget)?$')).toEqual(['/api/memory/notes/:_/forget', '/api/memory/notes/:_']);
    expect(expandRegex('^\\/api\\/connections\\/remembered(?:\\/([a-z0-9][a-z0-9_-]{0,63}))?$')).toEqual(['/api/connections/remembered/:_', '/api/connections/remembered']);
    expect(expandRegex('^\\/api\\/groups\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')).toEqual(['/api/groups/:_']);
  });

  it('finds the routes it should (a sample from each file kind)', () => {
    const found = new Set(scanRoutes(SRC).map((r) => `${r.method} ${r.path}`));
    for (const route of ['GET /api/session', 'POST /api/chat/:_/messages', 'PATCH /api/groups/:_', 'ANY /api/tips/:_/dismiss', 'ANY /api/connections/:_/grant', 'ANY /api/pages/:_/:_']) {
      expect(found, route).toContain(route);
    }
  });
});

describe('the route table', () => {
  const scanned = scanRoutes(SRC);
  const rows = API_ROUTES.map((r) => ({ method: r.method as string, path: normaliseTemplate(r.path) }));

  it('describes every route the source dispatches (add a row to api-routes.ts)', () => {
    const missing = scanned
      .filter((s) => !rows.some((r) => r.path === s.path && (s.method === 'ANY' || r.method === s.method)))
      .map((s) => `${s.method} ${s.path}  (${s.file}:${s.line})`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('describes nothing the source does not dispatch', () => {
    const stale = API_ROUTES
      .filter((r) => !scanned.some((s) => s.path === normaliseTemplate(r.path) && (s.method === 'ANY' || s.method === r.method)))
      .map((r) => `${r.method} ${r.path}`);
    expect(stale).toEqual([]);
  });

  it('has one row per method and path, each with a summary in a known area', () => {
    const keys = API_ROUTES.map((r) => `${r.method} ${normaliseTemplate(r.path)}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    for (const r of API_ROUTES) {
      expect(r.summary.trim(), `${r.method} ${r.path}`).not.toBe('');
      expect(Object.keys(API_AREAS), `${r.method} ${r.path}`).toContain(r.area);
      expect(r.path.startsWith('/api/'), r.path).toBe(true);
      if (r.token) expect(Object.keys(TOKEN_REFUSALS)).toContain(r.token);
    }
  });

  it('says since when for every route but those added since the last release', () => {
    for (const key of Object.keys(API_SINCE)) {
      expect(API_ROUTES.some((r) => `${r.method} ${r.path}` === key), `API_SINCE names ${key}, which is not a row`).toBe(true);
    }
  });

  it('refuses a token the routes that decide, grant, install, open access or touch secrets', () => {
    const refused = (method: string, p: string): string | undefined => matchApiRoute(method, p)?.token;
    expect(refused('POST', '/api/approvals/abc/approve')).toBe('decides');
    expect(refused('POST', '/api/approvals/abc/reject')).toBeUndefined();
    expect(refused('POST', '/api/agents/postie/file')).toBe('grants');
    expect(refused('POST', '/api/connections/remembered')).toBe('grants');
    expect(refused('POST', '/api/plugins/stage')).toBe('code');
    expect(refused('POST', '/api/api-tokens')).toBe('access');
    expect(refused('PUT', '/api/lock/pin')).toBe('access');
    expect(refused('POST', '/api/secrets/act')).toBe('secret');
    expect(refused('POST', '/api/chat/postie/messages')).toBeUndefined();
    expect(refused('POST', '/api/mcp/request')).toBeUndefined();
  });

  it('matches a request to its row, the literal path before a template, HEAD as GET', () => {
    expect(matchApiRoute('POST', '/api/agents/default')?.path).toBe('/api/agents/default');
    expect(matchApiRoute('POST', '/api/offers/dismiss-all')?.path).toBe('/api/offers/dismiss-all');
    expect(matchApiRoute('HEAD', '/api/session/')?.path).toBe('/api/session');
    expect(matchApiRoute('GET', '/api/agents/postie/profile')?.path).toBe('/api/agents/:id/profile');
    expect(matchApiRoute('DELETE', '/api/session')).toBeUndefined();
    expect(matchApiRoute('GET', '/api/nothing')).toBeUndefined();
  });
});

describe('docs/api.md', () => {
  it('is what the route table renders (run pnpm docs:api)', () => {
    const page = readFileSync(REFERENCE, 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n\n?/.exec(page);
    expect(match, 'docs/api.md has no frontmatter: run pnpm docs:api').not.toBeNull();
    expect(match?.[1]).toMatch(/^status: reference$/m);
    expect(page.slice(match?.[0].length ?? 0), 'docs/api.md is behind the route table: run pnpm docs:api').toBe(renderApiReference());
  });
});
