/**
 * Pairing a Telegram device, from the owner's side.
 *
 * The asymmetry is the point. Minting a code happens where the owner already
 * has authority — a shell on the machine that runs buddi — and presenting one
 * happens in a chat with a stranger's user id attached. So this file mints and
 * lists and unpairs; the *consuming* half lives in the surface, is rate
 * limited, and answers nothing when it fails.
 *
 * The deep link is a convenience, not a secret channel: `t.me/<bot>?start=CODE`
 * is exactly the `/start CODE` the owner could type by hand.
 */
import {
  createPairingCode as mintPairingCode,
  listSurfaceIdentitiesDetailed,
  unpairSurfaceIdentity,
  PAIRING_TTL_MINUTES,
  type Queryable,
} from '@buddi/core';
import { TelegramApi, type FetchLike } from './api.js';
import { SURFACE } from './surface.js';

/** A minted code, ready to show the owner. */
export interface PairingInvite {
  code: string;
  /** `https://t.me/<botUsername>?start=<code>` — tapping it sends `/start <code>`. */
  deepLink: string;
  expiresAt: Date;
}

/** One paired device, as `buddi devices` prints it. */
export interface PairedDevice {
  id: string;
  surface: string;
  externalUserId: string;
  externalChatId: string | null;
  label: string | null;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
}

export interface CreatePairingCodeOptions {
  ttlMinutes?: number;
  /** Where `TELEGRAM_BOT_TOKEN` is read from. Defaults to the process env. */
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  /** Injected in tests, or by a caller that already has one. */
  api?: Pick<TelegramApi, 'getMe'>;
}

/** The deep link for a code. Pure — the one place the URL shape is written. */
export function pairingDeepLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername.trim().replace(/^@/, '')}?start=${code}`;
}

/**
 * Mint a code for a bot whose @username is already known.
 *
 * The variant that does no I/O beyond the database: `createPairingCode` is this
 * plus one `getMe`.
 */
export async function createPairingCodeFor(
  pool: Queryable,
  botUsername: string,
  opts: { ttlMinutes?: number } = {},
): Promise<PairingInvite> {
  const { code, expiresAt } = await mintPairingCode(pool, {
    surface: SURFACE,
    ttlMinutes: opts.ttlMinutes ?? PAIRING_TTL_MINUTES,
  });
  return { code, deepLink: pairingDeepLink(botUsername, code), expiresAt };
}

/**
 * Mint a code and build its deep link, asking Telegram who the bot is.
 *
 * `getMe` is the only way to learn the bot's @username, and the username is
 * only ever used to build a link — never to decide anything.
 */
export async function createPairingCode(
  pool: Queryable,
  opts: CreatePairingCodeOptions = {},
): Promise<PairingInvite> {
  const env = opts.env ?? process.env;
  let api = opts.api;
  if (!api) {
    const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
    if (token === '') throw new Error('TELEGRAM_BOT_TOKEN is not set');
    api = new TelegramApi({ token, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }
  const me = await api.getMe();
  const username = me.username ?? '';
  if (username === '') throw new Error('Telegram did not report a bot username');
  return createPairingCodeFor(pool, username, opts);
}

/** Every paired device, oldest first. */
export async function listDevices(pool: Queryable): Promise<PairedDevice[]> {
  const rows = await listSurfaceIdentitiesDetailed(pool);
  return rows.map((r) => ({
    id: r.id,
    surface: r.surface,
    externalUserId: r.externalUserId,
    externalChatId: r.externalChatId,
    label: r.label,
    pairedAt: r.pairedAt,
    lastSeenAt: r.lastSeenAt,
  }));
}

/**
 * Unpair a device. `false` is "no device with that id" — the caller says so in
 * words rather than throwing at someone who mistyped a uuid.
 *
 * Revocation is immediate and needs no restart: authorization is read from this
 * table on every single message.
 */
export async function unpairDevice(pool: Queryable, id: string): Promise<boolean> {
  return unpairSurfaceIdentity(pool, id);
}
