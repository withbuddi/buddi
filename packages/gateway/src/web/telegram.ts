/**
 * Telegram, set up from the dashboard instead of from a terminal.
 *
 * Two writes and one read. The owner pastes the token BotFather gave them; it
 * goes into the vault under the name every other surface already reads
 * (`TELEGRAM_BOT_TOKEN`), into this process's environment so the surface can
 * be started without a restart, and then the surface is started — if this
 * process knows how. A process that does not (a test, a dashboard-only
 * deployment) says `restartNeeded` and the page says it in words.
 *
 * Then a pairing code, which is the existing one: `createPairingCode` mints a
 * row and asks Telegram for the bot's @username so the link can be built. The
 * page draws that link as a QR code; the code itself is what the phone sends
 * back as `/start <code>`.
 */
import { createVault, type Queryable, type Vault } from '@buddi/core';
import { createPairingCode, createPairingCodeFor, listDevices } from '../telegram/pairing.js';

/** What a running process can do to its own Telegram surface. */
export interface TelegramControl {
  /** Is the surface up in this process right now? */
  running: () => boolean;
  /**
   * Start it, now, with whatever `TELEGRAM_BOT_TOKEN` currently holds.
   *
   * Absent when the process cannot: then the token is stored and the owner is
   * told it will be there the next time buddi starts. `refused` is the other
   * way of saying no — this process could start the surface and is choosing
   * not to, in words the card shows as they are (recovery mode does this).
   */
  start?: (() => Promise<{ botUsername: string | null; refused?: string | undefined }>) | undefined;
  /** The @username of the running bot, when one is running. */
  botUsername?: (() => string | null) | undefined;
}

export interface TelegramWebDeps {
  pool: Queryable;
  env: NodeJS.ProcessEnv;
  telegram?: TelegramControl | undefined;
  /** Injected by tests; the machine's own vault otherwise. */
  vault?: Vault | undefined;
}

export class TelegramWebError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TelegramWebError';
  }
}

/** What a bot token looks like: `<digits>:<secret>`. Shape only, never a check. */
const TOKEN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

export interface TelegramStatus {
  /** A token is known to this installation. */
  configured: boolean;
  /** The surface is up in this process. */
  running: boolean;
  /** A phone has said hello. */
  paired: boolean;
}

export async function telegramStatus(deps: TelegramWebDeps): Promise<TelegramStatus> {
  const devices = await listDevices(deps.pool).catch(() => []);
  return {
    configured: (deps.env.TELEGRAM_BOT_TOKEN ?? '').trim() !== '',
    running: deps.telegram?.running() ?? false,
    paired: devices.some((device) => device.surface === 'telegram'),
  };
}

export interface SavedToken extends TelegramStatus {
  /** True when the token is kept but this process could not start the surface. */
  restartNeeded: boolean;
  botUsername: string | null;
  /** Why the surface is not up, when the process had a reason worth saying. */
  note?: string | undefined;
}

/**
 * Keep the token and, if this process can, start talking.
 *
 * The vault first: a token that starts a surface but survives no restart is a
 * setup the owner would have to do twice.
 */
export async function saveTelegramToken(deps: TelegramWebDeps, value: unknown): Promise<SavedToken> {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token === '') throw new TelegramWebError(400, 'Paste the token BotFather sent you.');
  if (!TOKEN.test(token)) {
    throw new TelegramWebError(400, 'That does not look like the token BotFather sends. It is a number, a colon, then a long jumble of letters.');
  }
  const vault = deps.vault ?? createVault({ env: deps.env });
  if (!vault) throw new TelegramWebError(409, 'This installation has nowhere safe to keep the token.');
  try {
    await vault.set('TELEGRAM_BOT_TOKEN', token);
  } catch {
    throw new TelegramWebError(409, 'The token could not be kept safely. Unlock this machine and try again.');
  }
  deps.env.TELEGRAM_BOT_TOKEN = token;

  let botUsername: string | null = null;
  let restartNeeded = false;
  let note: string | undefined;
  if (deps.telegram?.start && !deps.telegram.running()) {
    try {
      const started = await deps.telegram.start();
      botUsername = started.botUsername;
      if (started.refused !== undefined) {
        restartNeeded = true;
        note = started.refused;
      }
    } catch (error) {
      // The token is kept either way: a bot that refuses us now may be a
      // network that is down, and asking for it again would be rude.
      restartNeeded = true;
      if (/token|unauthor/i.test(error instanceof Error ? error.message : '')) {
        throw new TelegramWebError(400, 'Telegram did not accept that token. Check you copied all of it, and paste it again.');
      }
    }
  } else if (!deps.telegram?.running()) {
    restartNeeded = true;
  }
  return { ...(await telegramStatus(deps)), restartNeeded, botUsername, ...(note === undefined ? {} : { note }) };
}

export interface PairingOffer {
  code: string;
  link: string;
  expiresAt: string;
}

/** A fresh pairing code and the link that carries it. */
export async function telegramPairing(deps: TelegramWebDeps): Promise<PairingOffer> {
  if ((deps.env.TELEGRAM_BOT_TOKEN ?? '').trim() === '') {
    throw new TelegramWebError(409, 'Paste the token from BotFather first.');
  }
  // A surface that is already up knows its own @username; asking Telegram
  // again for a name this process is holding would be a network call for
  // nothing.
  const known = deps.telegram?.botUsername?.() ?? null;
  try {
    const invite = known
      ? await createPairingCodeFor(deps.pool, known)
      : await createPairingCode(deps.pool, { env: deps.env });
    return { code: invite.code, link: invite.deepLink, expiresAt: invite.expiresAt.toISOString() };
  } catch (error) {
    throw new TelegramWebError(502, `Telegram did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}
