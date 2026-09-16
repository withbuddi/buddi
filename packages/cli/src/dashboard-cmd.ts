/**
 * `buddi dashboard` — the link that opens the local dashboard.
 *
 * The installation's token never leaves the vault (or its `0600` file). What
 * this prints is a *ticket*: an HMAC over a nonce and a five-minute expiry,
 * keyed by that token, which the server verifies and then spends. So a URL in
 * shell history is worth nothing once it has been opened, and nothing at all a
 * few minutes later.
 *
 * The token itself is never printed, never logged and never passed as an
 * argument to anything.
 */
import { spawn } from 'node:child_process';
import { ensureWebToken, mintTicket, webConfig, webUrl, WEB_ENABLED_VAR } from '@buddi/gateway';
import type { DashboardAction } from './args.js';
import { installDashboardApp, uninstallDashboardApp } from './dashboard-app.js';

/** How the dashboard is turned off, said once, in the place people look. */
export const OFF_HELP = [
  'The dashboard is on by default and bound to loopback.',
  '',
  `To turn it off, set ${WEB_ENABLED_VAR}=0 in .env and restart the service:`,
  '',
  '  echo "BUDDI_WEB=0" >> .env',
  '  buddi service restart',
  '',
  'To move it instead of turning it off, set BUDDI_WEB_HOST / BUDDI_WEB_PORT.',
  'Binding it to anything but 127.0.0.1 exposes an approval button to your',
  'network: put it behind an authenticated transport if you do.',
].join('\n');

export interface DashboardOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injected in tests; the real one shells out to `open`. */
  launch?: (url: string) => void;
  /** Injected in tests. Where `--install-app` writes its `Applications` folder. */
  home?: string;
  out?: (line: string) => void;
}

function defaultLaunch(platform: NodeJS.Platform, url: string): void {
  // Only macOS gets an opener. Everywhere else the printed URL is the answer —
  // guessing at `xdg-open` and failing silently is worse than saying nothing.
  if (platform !== 'darwin') return;
  const child = spawn('open', [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

export async function runDashboard(
  action: DashboardAction,
  opts: DashboardOptions = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((line: string) => console.log(line));

  if (action === 'off') {
    out(OFF_HELP);
    return 0;
  }

  /*
   * The icon. It is a shortcut to this very command and holds no secret, so it
   * changes what the owner has to type and nothing about what the server
   * enforces: every open still mints a fresh single-use ticket here.
   */
  if (action === 'install-app' || action === 'uninstall-app') {
    const platform = opts.platform ?? process.platform;
    if (platform !== 'darwin') {
      out('the dashboard app bundle is macOS-only; elsewhere, bookmark nothing and run');
      out('`buddi dashboard` — the link is one-time, so a bookmark would not work anyway');
      return 1;
    }
    const result =
      action === 'install-app'
        ? installDashboardApp(opts.home !== undefined ? { home: opts.home } : {})
        : uninstallDashboardApp(opts.home !== undefined ? { home: opts.home } : {});
    for (const note of result.notes) out(note);
    return 0;
  }

  const config = webConfig(env);
  const { token, source, created } = await ensureWebToken({ env });
  const ticket = mintTicket(token);

  if (action === 'token') {
    // Just the ticket, on its own line, so it can be piped.
    out(ticket);
    return 0;
  }

  const url = webUrl(config, ticket);
  out(`buddi dashboard — ${url}`);
  out(
    `  token: in the ${source}${created ? ' (created just now)' : ''}; this link is one-time and expires in 5 minutes`,
  );
  if (!config.enabled) {
    out(`  NOTE: ${WEB_ENABLED_VAR} is off, so \`buddi serve\` is not serving it right now`);
  }

  const launch = opts.launch ?? ((u: string) => defaultLaunch(opts.platform ?? process.platform, u));
  launch(url);
  return 0;
}
