/**
 * The page a signed-out browser gets instead of an empty 401.
 *
 * An empty 401 on a page load is shown by the browser (and by the installed
 * app) as its own error page — "This site can't be reached" — with nothing
 * saying what to do. A *navigation* that the gate refuses gets this instead:
 * still a 401, still nothing about why beyond the one sentence a person
 * needs, and the way back in. API calls, event streams and anything a script
 * fetched keep the empty 401 (`http.ts`, `sendEmpty`): a caller that is not a
 * person learns exactly one bit, as before.
 *
 * Self-contained on purpose: inline styles carrying the dashboard's tokens
 * (`packages/web/src/tokens.css`), no script, no font, no image, and a
 * Content-Security-Policy that would refuse anything else. It holds no token,
 * no CSRF value and no path on this machine.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { baseHeaders, first } from './http.js';

/**
 * Is this request a person opening a page, rather than a script asking?
 *
 * `Sec-Fetch-Mode: navigate` is the browser's own word for it. A client that
 * sends no fetch metadata at all (an old browser, an embedded view) is taken
 * at its `Accept`: a page load asks for HTML first. Never under `/api/` or
 * `/stream`, never anything but a GET.
 */
export function wantsSignedOutPage(req: IncomingMessage, method: string, pathname: string): boolean {
  if (method !== 'GET') return false;
  if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/stream' || pathname.startsWith('/stream/')) return false;
  const mode = first(req.headers['sec-fetch-mode'])?.toLowerCase();
  if (mode !== undefined) return mode === 'navigate';
  return /\btext\/html\b/i.test(first(req.headers.accept) ?? '');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/**
 * Where "Try again" points: this same page, as a path on this origin. Never
 * `//host` (which a browser reads as another site), never anything but a path.
 */
export function retryHref(pathname: string, search: string): string {
  const path = `/${pathname.replace(/^[/\\]+/, '')}`;
  return `${path}${search}`;
}

export interface SignedOutOptions {
  /** Where "Try again" goes, from `retryHref`. */
  retry: string;
  /**
   * Set when the request came through Tailscale Serve, sign-in through
   * Tailscale is on, and this login is not the one it allows: the refusal's
   * own sentence (`tailscaleRefusalReason`), which never names a login.
   */
  tailscaleRefusal?: string | undefined;
}

/** The page itself. Exported for tests; the server calls `sendSignedOut`. */
export function signedOutPage(options: SignedOutOptions): string {
  const tailscale = options.tailscaleRefusal !== undefined;
  const title = tailscale ? 'This Tailscale login isn’t allowed here' : 'You’re signed out of this buddi';
  const body = tailscale
    ? `<p>Signing in through Tailscale is on for this buddi, but not for the login this browser is using: ${escapeHtml(options.tailscaleRefusal as string)}.</p>
      <p>On the computer buddi runs on, check the login allowed under Settings, or run <code>buddi dashboard</code> there for a sign-in link.</p>`
    : `<p>buddi restarted or your sign-in ran out.</p>
      <p>On the computer buddi runs on, run <code>buddi dashboard</code> for a sign-in link.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Signed out · buddi</title>
<style>
  :root {
    --bg: #eef4fd; --surface: #ffffff; --line: #dbe4f1; --text: #152642; --text-muted: #5a6477;
    --accent: #2b6fe6; --accent-hover: #245fc7; --accent-contrast: #ffffff; --code-bg: #f1f5fb;
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c1627; --surface: #131e31; --line: #22324c; --text: #ecf1f8; --text-muted: #a3adbe;
      --accent: #7db3ff; --accent-hover: #9ac4ff; --accent-contrast: #0b1426; --code-bg: #0a1322;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: var(--bg); color: var(--text); font: 14px/1.5 var(--font-sans); }
  main { width: 100%; max-width: 440px; background: var(--surface); border: 1px solid var(--line);
    border-radius: 16px; padding: 24px; }
  .kicker { margin: 0 0 8px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
  h1 { margin: 0 0 12px; font-size: 18px; line-height: 1.3; letter-spacing: -0.01em; }
  p { margin: 0 0 12px; color: var(--text-muted); }
  code { font-family: var(--font-mono); font-size: 13px; background: var(--code-bg); color: var(--text);
    border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
  .actions { display: flex; justify-content: flex-end; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line); }
  a.button { display: inline-block; background: var(--accent); color: var(--accent-contrast); text-decoration: none;
    font-weight: 600; border-radius: 10px; padding: 8px 16px; }
  a.button:hover { background: var(--accent-hover); }
</style>
</head>
<body>
<main>
  <p class="kicker">buddi</p>
  <h1>${title}</h1>
  ${body}
  <div class="actions"><a class="button" href="${escapeHtml(options.retry)}">Try again</a></div>
</main>
</body>
</html>
`;
}

/** Answer a refused page load with the signed-out page: 401, HTML, nothing loadable. */
export function sendSignedOut(res: ServerResponse, options: SignedOutOptions, headers: Record<string, string | string[]> = {}): void {
  const html = signedOutPage(options);
  res.writeHead(401, {
    ...baseHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(html);
}
