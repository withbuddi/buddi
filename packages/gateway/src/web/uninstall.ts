/**
 * Settings → System's "Remove buddi from this Mac", as the dashboard asks for it.
 *
 * The supervisor does the work (packages/install/src/product-uninstall.ts):
 * this module forwards, and adds the two guards a page needs on top of the
 * session, Origin and CSRF gate every write already has:
 *
 *  - **this computer only**: a session signed in from the tailnet or a public
 *    hostname is refused (server.ts checks `session.via === 'local'`);
 *  - **a confirmation token**: `GET /api/system/uninstall` mints one with the
 *    plan, and the backup and the removal must bring it back. A stray POST, a
 *    replayed one or one from a tab that never showed the plan removes nothing.
 *
 * A checkout has no supervisor and nothing here to offer: it uninstalls with
 * `buddi uninstall` in a terminal.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { supervisorSocket, type RouteReply } from './backups.js';
import { supervisorCall } from './service.js';

export const CHECKOUT_UNINSTALL = 'A source checkout removes buddi with buddi uninstall in a terminal.';
const NO_SUPERVISOR = 'The supervisor is not answering on its control socket. Run buddi in a terminal.';

/** How long a plan's token is good for: long enough to read it and take a backup. */
export const UNINSTALL_TOKEN_MS = 30 * 60_000;

export interface UninstallDeps {
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** One token at a time: a fresh plan replaces the last one. */
export interface TokenStore {
  mint(now: number): string;
  check(given: unknown, now: number): boolean;
  spend(): void;
}

export function createTokenStore(ttl = UNINSTALL_TOKEN_MS): TokenStore {
  let current: { value: string; until: number } | undefined;
  return {
    mint(now) {
      current = { value: randomBytes(24).toString('base64url'), until: now + ttl };
      return current.value;
    },
    check(given, now) {
      if (!current || typeof given !== 'string' || now > current.until) return false;
      const a = Buffer.from(given), b = Buffer.from(current.value);
      return a.length === b.length && timingSafeEqual(a, b);
    },
    spend() { current = undefined; },
  };
}

async function forward(socket: string, route: string, method: 'GET' | 'POST', body?: unknown): Promise<RouteReply> {
  try {
    const reply = await supervisorCall(socket, route, method, body, 30_000);
    return { status: reply.status, body: reply.body };
  } catch {
    return { status: 503, body: { error: NO_SUPERVISOR } };
  }
}

const REFUSED = { status: 403, body: { error: 'That confirmation has expired. Open Remove buddi again.' } };

/** What goes, and the token that lets the next two calls through. */
export async function uninstallPlanRoute(deps: UninstallDeps, tokens: TokenStore): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (!socket) return { status: 200, body: { available: false, reason: CHECKOUT_UNINSTALL } };
  const plan = await forward(socket, '/uninstall', 'GET');
  if (plan.status !== 200) return plan;
  return { status: 200, body: { available: true, ...(plan.body as object), token: tokens.mint((deps.now ?? (() => new Date()))().getTime()) } };
}

/** The last backup, moved out with its passphrase file: a job to follow. */
export async function uninstallBackupRoute(deps: UninstallDeps, tokens: TokenStore, body: Record<string, unknown>): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (!socket) return { status: 409, body: { error: CHECKOUT_UNINSTALL } };
  if (!tokens.check(body.token, (deps.now ?? (() => new Date()))().getTime())) return REFUSED;
  return forward(socket, '/uninstall/backup', 'POST', {});
}

/** Where that job is; its report carries the words (only here, never on the backups job route). */
export async function uninstallJobRoute(deps: UninstallDeps, id: string): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (!socket) return { status: 409, body: { error: CHECKOUT_UNINSTALL } };
  const reply = await forward(socket, `/jobs/${encodeURIComponent(id)}`, 'GET');
  if (reply.status !== 200 || (reply.body as { kind?: unknown } | null)?.kind !== 'uninstall-backup') {
    return reply.status === 200 ? { status: 404, body: { error: 'no such job' } } : reply;
  }
  return reply;
}

/** The removal, once the owner said they wrote the words down. The token is spent either way. */
export async function uninstallRoute(deps: UninstallDeps, tokens: TokenStore, body: Record<string, unknown>): Promise<RouteReply> {
  const socket = supervisorSocket(deps.env);
  if (!socket) return { status: 409, body: { error: CHECKOUT_UNINSTALL } };
  if (!tokens.check(body.token, (deps.now ?? (() => new Date()))().getTime())) return REFUSED;
  if (body.wroteItDown !== true) return { status: 400, body: { error: 'Tick "I wrote it down" first: the passphrase is the only thing that opens your backups.' } };
  if (body.keepData !== undefined && typeof body.keepData !== 'boolean') return { status: 400, body: { error: '"keepData" must be true or false.' } };
  tokens.spend();
  return forward(socket, '/uninstall', 'POST', { keepData: body.keepData === true });
}

/** A backups job as the backups page sees it: an uninstall's words are not for that route. */
export function withoutPassphrase(reply: RouteReply): RouteReply {
  const body = reply.body as { report?: { passphrase?: unknown } } | null;
  if (reply.status !== 200 || !body?.report || body.report.passphrase === undefined) return reply;
  const { passphrase: _gone, ...report } = body.report;
  return { status: 200, body: { ...body, report } };
}
