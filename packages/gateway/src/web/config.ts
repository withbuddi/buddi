/**
 * Where the dashboard listens, and whether it listens at all.
 *
 * ARCHITECTURE.md, "Owner and surface authentication": *«Web UI: session auth,
 * CSRF protection, Origin checks, bound to localhost by default (remote access
 * = explicit authenticated transport).»* The binding is the first half of that
 * sentence and it lives here: the default host is `127.0.0.1`, and moving it is
 * a deliberate edit to `BUDDI_WEB_HOST`, never a side effect of anything else.
 */
import path from 'node:path';
import { REPO_ROOT } from '../agents/catalog.js';

export const WEB_ENABLED_VAR = 'BUDDI_WEB';
export const WEB_HOST_VAR = 'BUDDI_WEB_HOST';
export const WEB_PORT_VAR = 'BUDDI_WEB_PORT';

/** Loopback, deliberately. A dashboard over the event log is not a public page. */
export const DEFAULT_WEB_HOST = '127.0.0.1';
export const DEFAULT_WEB_PORT = 4317;

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

/** `BUDDI_WEB=0` (or `off`/`false`/`no`) turns the dashboard off; default on. */
export function webEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[WEB_ENABLED_VAR] ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no');
}

export function webConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const host = (env[WEB_HOST_VAR] ?? '').trim() || DEFAULT_WEB_HOST;
  const rawPort = (env[WEB_PORT_VAR] ?? '').trim();
  const parsed = rawPort === '' ? NaN : Number(rawPort);
  const port =
    Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : DEFAULT_WEB_PORT;
  return { enabled: webEnabled(env), host, port };
}

/** Is this a loopback binding? Only then do `localhost` aliases count as us. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/**
 * The origins a request may legitimately claim to come from.
 *
 * Exactly the bound address — plus the two other spellings of loopback, because
 * the owner types `localhost` and the browser sends `127.0.0.1` (or the other
 * way round) and both are the same machine. Nothing else is ever allowed, and
 * there is no CORS: a cross-origin page gets no header saying it may read this.
 */
export function allowedOrigins(config: Pick<WebConfig, 'host' | 'port'>): string[] {
  const origins = new Set<string>();
  const add = (host: string): void => {
    origins.add(`http://${host}:${config.port}`);
  };
  add(config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host);
  if (isLoopback(config.host) || config.host === '0.0.0.0' || config.host === '::') {
    add('127.0.0.1');
    add('localhost');
    add('[::1]');
  }
  return [...origins];
}

/** The URL to hand a human. `0.0.0.0` is not an address you can open. */
export function webUrl(config: Pick<WebConfig, 'host' | 'port'>, ticket?: string): string {
  const host =
    config.host === '0.0.0.0' || config.host === '::' || config.host === ''
      ? '127.0.0.1'
      : config.host;
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${config.port}/${ticket ? `?t=${encodeURIComponent(ticket)}` : ''}`;
}

/** Everything the installation writes. Same rule as the CLI's `paths.ts`. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.BUDDI_DATA_DIR ?? '').trim();
  return explicit !== '' ? explicit : path.join(REPO_ROOT, 'data');
}

/** Where the built dashboard lives once `pnpm -r build` has run. */
export function webAssetsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.BUDDI_WEB_ASSETS ?? '').trim();
  return explicit !== '' ? explicit : path.join(REPO_ROOT, 'packages', 'web', 'dist');
}
