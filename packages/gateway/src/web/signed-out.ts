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
 * Self-contained on purpose: inline styles carrying the kit's tokens (its
 * source of truth is the design kit's `ui_kits/dashboard/SignedOut.jsx`), no
 * font, no image, one copy script allowed by hash, and a
 * Content-Security-Policy that would refuse anything else. It holds no token,
 * no CSRF value and no path on this machine.
 */
import { createHash } from 'node:crypto';
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

/**
 * `buddi://settings/browser`, with the pairing code when the popup sent a
 * valid one, for a page the Chrome extension opened (`?from=extension`, set by
 * `packages/extension/src/popup.ts`). Undefined for any other request. Built
 * from six digits and fixed text only, never from what the request said.
 */
export function appLinkFor(search: string): string | undefined {
  let params: URLSearchParams;
  try { params = new URLSearchParams(search); } catch { return undefined; }
  if (params.get('from') !== 'extension') return undefined;
  const code = (params.get('code') ?? '').replace(/[\s-]/g, '');
  return /^\d{6}$/.test(code) ? `buddi://settings/browser?code=${code}` : 'buddi://settings/browser';
}

export interface SignedOutOptions {
  /** Where "Try again" goes, from `retryHref`. */
  retry: string;
  /**
   * How the request arrived: on this computer (`local`), through the tailnet
   * (`tailnet`: Tailscale Serve, or the configured public origin), or from
   * anywhere else. Decides which way back in the page leads with.
   */
  arrived?: 'local' | 'tailnet' | 'remote' | undefined;
  /**
   * The request came through Tailscale Serve and signing in through Tailscale
   * is on: "Sign in with Tailscale" is the primary action.
   */
  tailscaleSignIn?: boolean | undefined;
  /**
   * Set when the request came through Tailscale Serve, sign-in through
   * Tailscale is on, and this login is not the one it allows: the refusal's
   * own sentence (`tailscaleRefusalReason`), which never names a login.
   */
  tailscaleRefusal?: string | undefined;
  /** Tailscale could not be asked just now; the session is still good. */
  tailscaleUnanswered?: boolean | undefined;
  /** A sign-in lockout is running for this address, and how long is left. */
  lockedForMs?: number | undefined;
  /**
   * The Chrome extension sent the owner here (`appLinkFor`): "Open buddi.app"
   * leads, and the Terminal line waits until the link did not answer.
   */
  appLink?: string | undefined;
  /**
   * The request came through a provider other than Tailscale (Cloudflare
   * Access, on the ingress listener) and earned no identity: its title and
   * the refusal's fixed name, never anything the request supplied.
   */
  provider?: { title: string; refusal: string; kind: 'unanswered' | 'login' | 'other' } | undefined;
}

/** The command the page offers, and copies. */
const COMMAND = 'buddi dashboard';

/**
 * The page's one script: show the Copy button and make it copy. Without it the
 * button stays hidden and the command is still there to select. Allowed by
 * hash in the CSP, so nothing else can run.
 */
const COPY_SCRIPT = "document.querySelectorAll('[data-copy]').forEach(function(b){b.hidden=false;b.addEventListener('click',function(){navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1600)},function(){})})})";
const COPY_SCRIPT_HASH = `sha256-${createHash('sha256').update(COPY_SCRIPT, 'utf8').digest('base64')}`;

/** How long "Open buddi.app" waits for the app to take over before the Terminal line shows. */
export const APP_LINK_WAIT_MS = 1500;
/**
 * "Open buddi.app": follow the link, and if this page still has the focus
 * after a second and a half, buddi.app did not answer (not installed, or the
 * owner said no), so the Terminal line shows. Without the script the line is
 * never hidden. Allowed by hash, like the copy script.
 */
const APP_SCRIPT = `document.querySelectorAll('[data-app-wait]').forEach(function(w){w.hidden=true});document.querySelectorAll('[data-app-link]').forEach(function(a){a.addEventListener('click',function(){var gone=false;function away(){gone=true}window.addEventListener('blur',away,{once:true});document.addEventListener('visibilitychange',away,{once:true});setTimeout(function(){if(gone&&!document.hasFocus())return;document.querySelectorAll('[data-app-wait]').forEach(function(w){w.hidden=false})},${APP_LINK_WAIT_MS})})})`;
const APP_SCRIPT_HASH = `sha256-${createHash('sha256').update(APP_SCRIPT, 'utf8').digest('base64')}`;

interface Copy {
  title: string;
  lines: string[];
  /** The sentence before the command row; no row when absent. */
  how?: string;
  primary: string;
}

/** What the page says, by case. Kept in step with the kit's `SignedOut.jsx`. */
function copyFor(options: SignedOutOptions): Copy {
  if (options.provider !== undefined) return providerCopy(options.provider);
  if (options.tailscaleRefusal !== undefined) {
    return {
      title: 'This Tailscale login isn’t allowed here',
      lines: [`Signing in through Tailscale is on for this buddi, but not for the login this device uses: ${escapeHtml(options.tailscaleRefusal)}.`],
      how: 'On the computer buddi runs on, check the login under Settings → Dashboard, or run this there for a sign-in link:',
      primary: 'Try again',
    };
  }
  if (options.tailscaleUnanswered) {
    return {
      title: 'Tailscale didn’t answer',
      lines: ['buddi asks Tailscale who you are on every visit, and it didn’t answer just now. Your sign-in is still good.'],
      primary: 'Try again',
    };
  }
  if (options.arrived === 'tailnet' && options.tailscaleSignIn) {
    return {
      title: 'Sign in to buddi',
      lines: ['You’re reaching this buddi over your tailnet, and Tailscale can vouch for you.'],
      how: 'Or, on the computer buddi runs on, run this for a sign-in link:',
      primary: 'Sign in with Tailscale',
    };
  }
  if (options.arrived === 'local') {
    return {
      title: 'You’re signed out of this buddi',
      lines: ['Your sign-in on this computer ended or ran out.'],
      how: 'Run this in Terminal on this computer. It opens buddi signed in.',
      primary: 'Try again',
    };
  }
  return {
    title: 'You’re signed out of this buddi',
    lines: [
      'Your sign-in on this device ended or ran out.',
      ...(options.arrived === 'tailnet' ? ['Signing in through Tailscale can be turned on under Settings → Dashboard.'] : []),
    ],
    how: 'On the computer buddi runs on, run this, then open the link here within five minutes:',
    primary: 'Try again',
  };
}

/**
 * Through Cloudflare Access there is no "Sign in with" button to press: Access
 * is in front, and a person it let through is signed in on arrival. So the
 * page says why this visit was not, by case. Kept in step with the kit.
 */
function providerCopy(provider: NonNullable<SignedOutOptions['provider']>): Copy {
  const title = escapeHtml(provider.title);
  if (provider.kind === 'login') {
    return {
      title: 'This Cloudflare login isn’t allowed here',
      lines: ['Signing in through Cloudflare is on for this buddi, but for a different email than the one Cloudflare signed you in with.'],
      how: 'On the computer buddi runs on, check the email under Settings → System, or run this there for a sign-in link:',
      primary: 'Try again',
    };
  }
  if (provider.kind === 'unanswered') {
    return {
      title: 'Cloudflare’s keys didn’t answer',
      lines: ['buddi checks Cloudflare’s signature on every visit, and couldn’t fetch the keys to check it just now. Your sign-in is still good.'],
      primary: 'Try again',
    };
  }
  if (provider.refusal === 'setting-off') {
    return {
      title: 'Signing in through Cloudflare is off',
      lines: [`This buddi was reached through ${title}, but signing in that way is turned off.`],
      how: 'On the computer buddi runs on, turn it on under Settings → System, or run this there for a sign-in link:',
      primary: 'Try again',
    };
  }
  if (provider.refusal === 'no-assertion') {
    return {
      title: 'Cloudflare Access isn’t in front of this address',
      lines: ['This visit came through the tunnel without Cloudflare Access’s signature, so buddi can’t tell who you are. Add an Access application with a policy for this hostname.'],
      how: 'Or, on the computer buddi runs on, run this for a sign-in link:',
      primary: 'Try again',
    };
  }
  return {
    title: 'Cloudflare’s sign-in didn’t check out',
    lines: ['buddi checks Cloudflare’s signature on every visit, and this one didn’t match the team domain and application set up under Settings → System.'],
    how: 'On the computer buddi runs on, run this for a sign-in link:',
    primary: 'Try again',
  };
}

/** Only a `buddi://settings/browser` link with at most a six-digit code is ever drawn. */
function appLinkHref(link: string | undefined): string | undefined {
  return link && /^buddi:\/\/settings\/browser(\?code=\d{6})?$/.test(link) ? link : undefined;
}

/** The page itself. Exported for tests; the server calls `sendSignedOut`. */
export function signedOutPage(options: SignedOutOptions): string {
  const copy = copyFor(options);
  const minutes = options.lockedForMs !== undefined && options.lockedForMs > 0 ? Math.max(1, Math.ceil(options.lockedForMs / 60_000)) : 0;
  const lockout = minutes > 0
    ? `<div class="notice" role="status"><div class="notice-title">Too many tries — wait ${minutes} min</div>Too many sign-in tries came from here in the last minute; a forgotten tab can do that. A fresh link from <code>${COMMAND}</code> works right away.</div>`
    : '';
  const app = appLinkHref(options.appLink);
  const how = copy.how !== undefined
    ? `<div${app ? ' data-app-wait' : ''}><p>${app ? 'buddi.app didn’t open. ' : ''}${copy.how}</p>
      <div class="cmd"><code class="cmd-text">${COMMAND}</code><button type="button" class="button small" data-copy="${COMMAND}" hidden>Copy</button></div></div>`
    : '';
  const open = app
    ? `<p>The buddi extension sent you here. buddi.app opens on Settings → Browser &amp; apps, where you finish pairing.</p>
    <p class="app"><a class="button accent" href="${escapeHtml(app)}" data-app-link>Open buddi.app</a></p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Signed out · buddi</title>
<style>
  :root {
    --surface: #ffffff; --surface-sunken: #e6eef9; --line: #dbe4f1; --text: #152642; --text-muted: #5a6477;
    --accent: #2b6fe6; --accent-hover: #245fc7; --accent-contrast: #ffffff; --brand: #2b6fe6;
    --warning-soft: #fbf0d9; --focus-ring: #2b6fe6;
    --field-a: #8fbcfb; --field-b: #f3d6a9; --field-c: #b9d4fb; --field-base: #eef4fd; --field-opacity: 0.95;
    --shadow-float: 0 30px 70px -24px rgb(21 38 66 / 32%), 0 2px 8px rgb(21 38 66 / 6%);
    --font-sans: 'DM Sans Variable', 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --font-mono: 'DM Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #131e31; --surface-sunken: #0a1322; --line: #22324c; --text: #ecf1f8; --text-muted: #a3adbe;
      --accent: #7db3ff; --accent-hover: #9ac4ff; --accent-contrast: #0b1426; --brand: #1f4fa3;
      --warning-soft: #33280f; --focus-ring: #7db3ff;
      --field-a: #1d4f9c; --field-b: #6b4a2a; --field-c: #173a70; --field-base: #0c1627; --field-opacity: 0.75;
      --shadow-float: 0 30px 70px -20px rgb(0 0 0 / 70%), 0 2px 8px rgb(0 0 0 / 30%);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 40px 16px;
    background: var(--field-base); color: var(--text); font: 450 14px/1.5 var(--font-sans);
    position: relative; isolation: isolate; overflow-x: hidden; }
  body::before { content: ''; position: fixed; inset: -20%; z-index: -1; pointer-events: none; filter: blur(48px); opacity: var(--field-opacity);
    background: radial-gradient(60% 70% at 62% 18%, var(--field-a), transparent 70%),
      radial-gradient(50% 60% at 92% 82%, var(--field-b), transparent 70%),
      radial-gradient(45% 55% at 8% 96%, var(--field-c), transparent 72%), var(--field-base); }
  main { width: 100%; max-width: 480px; background: var(--surface); border: 1px solid color-mix(in oklab, var(--line) 70%, transparent);
    border-radius: 20px; box-shadow: var(--shadow-float); overflow: hidden; }
  .body { padding: 32px 32px 24px; }
  .dock { display: flex; justify-content: flex-end; gap: 12px; padding: 16px 32px; border-top: 1px solid var(--line); }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; }
  .mark { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 6px;
    background: var(--brand); color: #fff; font-weight: 750; font-size: 13px; line-height: 1; }
  .name { font-weight: 750; font-size: 13px; letter-spacing: -0.01em; }
  h1 { margin: 0 0 12px; font-weight: 650; font-size: 18px; line-height: 1.3; letter-spacing: -0.02em; }
  p { margin: 0 0 12px; color: var(--text-muted); }
  code { font-family: var(--font-mono); font-size: 0.95em; }
  .notice { margin: 16px 0; padding: 12px 16px; border-radius: 12px; background: var(--warning-soft); font-size: 13px; }
  .notice-title { font-weight: 650; }
  .cmd { display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-sunken); }
  .cmd-text { flex: 1; min-width: 0; font-size: 13px; color: var(--text); overflow-wrap: anywhere; }
  .button { display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 12px; border: 1px solid var(--line);
    border-radius: 7px; background: var(--surface); color: var(--text); font: 550 13px/1 var(--font-sans); text-decoration: none; cursor: pointer; }
  .button:hover { background: var(--surface-sunken); }
  .button.small { height: 26px; padding: 0 8px; font-size: 12px; }
  .button.accent { background: var(--accent); border-color: var(--accent); color: var(--accent-contrast);
    box-shadow: 0 1px 0 rgb(255 255 255 / 18%) inset, 0 2px 6px -2px color-mix(in oklab, var(--accent) 60%, transparent); }
  .button.accent:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .app { margin: 16px 0; }
  .button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  @media (max-width: 720px) { .body { padding: 20px; } .dock { padding: 12px 20px; } }
</style>
</head>
<body>
<main>
  <div class="body">
    <div class="head"><span class="mark" aria-hidden="true">b</span><span class="name">buddi</span></div>
    <h1>${copy.title}</h1>
    ${copy.lines.map((line) => `<p>${line}</p>`).join('\n    ')}
    ${lockout}
    ${open}
    ${how}
  </div>
  <div class="dock"><a class="button accent" href="${escapeHtml(options.retry)}">${copy.primary}</a></div>
</main>
${copy.how !== undefined ? `<script>${COPY_SCRIPT}</script>` : ''}
${app ? `<script>${APP_SCRIPT}</script>` : ''}
</body>
</html>
`;
}

/** Answer a refused page load with the signed-out page: HTML, nothing loadable but its own copy script. */
export function sendSignedOut(
  res: ServerResponse,
  options: SignedOutOptions,
  headers: Record<string, string | string[]> = {},
  status = 401,
): void {
  const html = signedOutPage(options);
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src '${COPY_SCRIPT_HASH}'${appLinkHref(options.appLink) ? ` '${APP_SCRIPT_HASH}'` : ''}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    ...headers,
  });
  res.end(html);
}
